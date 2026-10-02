import { getPool, getConfig, createLogger } from '@atlas/core';
import {
  nfValidaSql,
  colunaCanceladaExiste,
  itemNacionalRecebidoSql,
  normalizarDescricaoSql,
} from './fiscal-recebida-sql.js';
import { converterItemNfParaKg, type ConversaoNf } from './unidade-nf.js';
import { sugerirProdutosEmLote } from './correlacao-produto.service.js';

const logger = createLogger('stockbridge:fila-nacional');

/**
 * Fila e detalhe de NF nacional (feature 015, ACXEGDP-328; feature 016, ACXEGDP-395).
 *
 * Fonte: ESPELHO Postgres, sincronizado pelo n8n. Zero chamada OMIE ao vivo —
 * mais estrito que a fila de importacao, que consulta a NF no OMIE ao buscar
 * (Principio II, FR-016 da 015).
 *
 * Feature 016 — DUAS FONTES unidas pela chave de acesso (research D8):
 *  (a) public."tbl_nf_header_Q2P" ⋈ "tbl_nf_itens_Q2P" — NF cujo recebimento
 *      FISCAL ja foi concluido no OMIE (so entao ela entra no ListarNF). E a
 *      fonte da 015 e tem PRECEDENCIA.
 *  (b) public."tbl_recebimentoNFe_Q2P" ⋈ "tbl_recebimentoNFe_itens_Q2P" —
 *      caixa "Recebimento de NF-e" do OMIE com c_recebido = 'N': a NF chegou da
 *      SEFAZ e ninguem concluiu o fiscal. So entra com a flag
 *      STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED ligada, e so para chaves que NAO
 *      existem em (a) nem tem ledger `recebimento_fiscal` concluido — entre a
 *      conclusao pelo Atlas e o proximo sync a mesma chave pode estar nas duas.
 *      Com a flag desligada a query e a da 015 (FR-020).
 *  Cada NF sai com `fiscal: 'pendente' | 'concluido'`. NF com dispensa ativa
 *  (stockbridge.nf_dispensa) e excluida das duas fontes (FR-021, D9).
 *
 * Decisoes que moldam a query (research da 015):
 *  - D6: CFOP armazenado COM ponto ('1.102'); comparar contra '1102' nao casa nada.
 *    Na fonte (b) o CFOP do recorte e `c_cfop_entrada` (o `c_cfop` e o do fornecedor).
 *  - D1: `n_id_receb` esta preenchido em 5.540 de 5.541 NFs de entrada — e o
 *    recebimento FISCAL do OMIE, nao a entrada fisica. NAO entra na pendencia.
 *  - D21: "ja recebida" so pelo lado Atlas, em duas vias + baixa externa
 *    (itemNacionalRecebidoSql). Cobre ~90% do historico do formulario manual.
 *  - D23: corte FIXO (config), nao janela movel — NF emitida antes nunca entra;
 *    depois, fica ate ser recebida, baixada ou dispensada. Sem config, a fila NAO sobe.
 *  - D4: exclusao de fornecedor e DADO (stockbridge.fornecedor_exclusao), nao
 *    constante — PLASTFIX e a contraparte ACXE sao seed da migration 0052.
 *  - D18/D20: linhas de mesma descricao na mesma NF sao AGREGADAS (somadas, nunca
 *    descartadas — sao lotes distintos); a pendencia e por descricao normalizada.
 *  - D3: o espelho nao guarda total de cabecalho — valor da NF = soma dos itens.
 *  - D26 (ACXEGDP-328, 24/09/2026): o valor do item e `i.v_prod`, NAO `i.v_tot_item`.
 *    O espelho grava `v_prod` = valor do item COM tributos (o `<vItem>` do XML) e
 *    `v_tot_item` = `v_prod` + IPI OUTRA VEZ. Provado na NF 59697 da Zaraplast:
 *    XML `<vItem>` 118.800,07 = `v_prod`; `v_tot_item` 124.457,22 = + 5.657,15 de IPI;
 *    Σ`v_prod` = 267.300,15 = `<vNF>` exato, Σ`v_tot_item` = 280.028,73 (IPI em dobro).
 *    Na fonte (b) o equivalente e `v_total_item` (= `vTotalItem` do recebimento, que
 *    na Zaraplast 59869 bateu com `v_prod` — research D7 da 016).
 */

export const CFOPS_RECEBIMENTO_NACIONAL: readonly string[] = Object.freeze(['1.101', '1.102', '2.101', '2.102']);

/** Situacao do recebimento FISCAL da NF no OMIE, como a fila a enxerga (feature 016). */
export type SituacaoFiscal = 'pendente' | 'concluido';

/** Flag da feature 016 — gate da fonte (b), da escrita OMIE no POST por-nf e da dispensa. Default desligada (research D12). */
export function recebimentoFiscalHabilitado(): boolean {
  const cfg = getConfig() as { STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED?: boolean };
  return cfg.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED === true;
}

export class DataCorteNaoConfiguradaError extends Error {
  constructor() {
    // Sem nome de variavel de ambiente: este texto vira userMessage na rota.
    // O detalhe tecnico (STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE) fica no log.
    super('A fila de recebimento nacional ainda não está configurada neste ambiente: falta a data de corte. O recebimento manual continua disponível.');
    this.name = 'DataCorteNaoConfiguradaError';
  }
}

export class NfNacionalNaoEncontradaError extends Error {
  /**
   * @param motivo    complemento curto da moldura "NF não encontrada — …"
   * @param mensagem  texto COMPLETO alternativo, para quando a NF foi localizada
   *                  mas nao cabe na fila (ex.: nenhum item no recorte de CFOP)
   */
  constructor(public readonly chaveAcesso: string, motivo?: string, mensagem?: string) {
    super(
      mensagem ??
        `NF não encontrada na fila de recebimento nacional${motivo ? ` — ${motivo}` : ''}. ` +
          'Se a nota existe e já chegou, receba pelo formulário manual.',
    );
    this.name = 'NfNacionalNaoEncontradaError';
  }
}

export class NfNacionalCanceladaError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`A NF ${notaFiscal} está cancelada ou foi excluída no OMIE e não pode ser recebida.`);
    this.name = 'NfNacionalCanceladaError';
  }
}

export class FornecedorExcluidoError extends Error {
  constructor(public readonly fornecedorNome: string) {
    super(`O fornecedor ${fornecedorNome} está fora do escopo da fila de recebimento nacional.`);
    this.name = 'FornecedorExcluidoError';
  }
}

/**
 * Data de corte FIXA (D23, FR-023). Lanca se ausente — sem default silencioso.
 * A chave e optional no schema Zod global so para nao derrubar o boot da API
 * inteira; a recusa acontece aqui, onde e usada.
 */
export function getDataCorteFilaNacional(): string {
  const cfg = getConfig() as { STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE?: string };
  const v = cfg.STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE;
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    logger.error('STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE ausente ou invalida (esperado YYYY-MM-DD, 7 dias antes da entrada em operacao) — fila nacional recusada');
    throw new DataCorteNaoConfiguradaError();
  }
  return v;
}

/** Acima disto o espelho de recebimentos (n8n, 2x/hora) e considerado defasado (gate 3 do Principio II). */
export const ESPELHO_RECEBIMENTOS_IDADE_MAX_MIN = 120;

export interface IdadeEspelhoRecebimentos {
  /** minutos desde o ultimo `synced_at`; null quando nao ha dado ou o banco falhou */
  idadeMin: number | null;
  status: 'ok' | 'degraded' | 'sem_dados' | 'indisponivel' | 'desligado';
}

/**
 * Feature 016 (T051): defasagem do espelho `tbl_recebimentoNFe_Q2P`. Com a flag
 * desligada a fonte (b) nao e usada e o dado e irrelevante ('desligado'). Usado
 * pelo health do modulo e pela fila (warn), porque a fila degrada em silencio:
 * sync parado = NF "fiscal pendente" sumindo sem erro.
 */
export async function idadeEspelhoRecebimentos(): Promise<IdadeEspelhoRecebimentos> {
  if (!recebimentoFiscalHabilitado()) return { idadeMin: null, status: 'desligado' };
  try {
    const r = await getPool().query<{ idade_min: string | number | null }>(
      `SELECT (EXTRACT(EPOCH FROM (now() - MAX(synced_at))) / 60)::numeric(12,1) AS idade_min FROM public."tbl_recebimentoNFe_Q2P"`,
    );
    const v = r.rows[0]?.idade_min;
    if (v == null) return { idadeMin: null, status: 'sem_dados' };
    const idade = Number(v);
    if (!Number.isFinite(idade)) return { idadeMin: null, status: 'sem_dados' };
    return { idadeMin: idade, status: idade > ESPELHO_RECEBIMENTOS_IDADE_MAX_MIN ? 'degraded' : 'ok' };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Idade do espelho de recebimentos indisponível');
    return { idadeMin: null, status: 'indisponivel' };
  }
}

/** Rotulo da fila quando o recebimento chegou da SEFAZ sem contraparte cadastrada no OMIE (research D8 da 016). */
export const FORNECEDOR_NAO_IDENTIFICADO = 'Fornecedor não identificado no OMIE';

/** Uma linha da fila: uma NF nacional elegivel com pelo menos um item pendente. */
export interface FilaNacionalItem {
  nfChaveAcesso: string;
  notaFiscal: string;
  fornecedorNome: string;
  /** '' quando a fonte (b) nao traz CNPJ (fornecedor nao cadastrado no OMIE) */
  fornecedorCnpj: string;
  dtEmissao: string;
  diasDesdeEmissao: number;
  itensTotal: number;
  itensPendentes: number;
  valorTotalBrl: number;
  /** feature 016: 'pendente' = so na fonte (b) e sem ledger concluido */
  fiscal: SituacaoFiscal;
  /** quando o Atlas concluiu o fiscal (ledger) — null se foi no OMIE/portal ou flag desligada */
  fiscalConcluidoPeloAtlasEm: string | null;
}

// ── Fonte unificada (feature 016) ──────────────────────────────────────────────
// Ambas as fontes saem com o MESMO shape de linha, para que agregacao por
// descricao, conversao de unidade, checagem "ja recebida", sugestao de
// correlacao e UI continuem iguais (plan.md, Structure Decision):
//   c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi, n_id_receb,
//   fiscal_pendente, cancelada, deletada, n_cod_item, x_prod, cfop, q_com, u_com, valor_item

const LEDGER_FISCAL_CONCLUIDO_SQL = (chaveExpr: string): string =>
  `EXISTS (SELECT 1 FROM stockbridge.recebimento_fiscal rf
            WHERE rf.nf_chave_acesso = ${chaveExpr} AND rf.status IN ('concluido', 'ja_concluido'))`;

/** Fonte (a): espelho de NF — fiscal ja concluido no OMIE. `nfValida` so se aplica a fila (o detalhe le as flags). */
function fonteNfSql(canceladaExiste: boolean, nfValida: string): string {
  return `
        SELECT h.c_chave_nfe, h.n_nf, h.dest_razao, h.dest_cnpj_cpf, h.d_emi::date AS d_emi,
               h.n_id_receb::bigint                                 AS n_id_receb,
               false                                                AS fiscal_pendente,
               ${canceladaExiste ? 'COALESCE(h.cancelada, false)' : 'false'} AS cancelada,
               COALESCE(h.deletada, false)                          AS deletada,
               i.n_cod_item::text                                   AS n_cod_item,
               i.x_prod, i.cfop, i.q_com, i.u_com,
               i.v_prod                                             AS valor_item  -- D26: NAO v_tot_item (IPI em dobro)
        FROM public."tbl_nf_header_Q2P" h
        JOIN public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf
        WHERE h.tp_nf = 0
          AND h.d_emi >= $2::date
          ${nfValida}`;
}

/**
 * Fonte (b): espelho de recebimentos — fiscal PENDENTE (c_recebido = 'N').
 * Precedencia da fonte (a): chave que ja existe no espelho de NF nao entra por
 * aqui (D8, FR-005). `fiscal_pendente` consulta o ledger para a NF que o Atlas
 * acabou de concluir ja sair como "fiscal ja feito" antes do proximo sync.
 */
function fonteRecebSql(): string {
  return `
        SELECT r.c_chave_nfe, r.c_numero_nfe AS n_nf, r.c_razao_social AS dest_razao, r.c_cnpj_cpf AS dest_cnpj_cpf,
               r.d_emissao                                          AS d_emi,
               r.n_id_receb::bigint                                 AS n_id_receb,
               NOT ${LEDGER_FISCAL_CONCLUIDO_SQL('r.c_chave_nfe')}  AS fiscal_pendente,
               (COALESCE(r.c_cancelada, 'N') = 'S')                 AS cancelada,
               false                                                AS deletada,
               ri.n_sequencia::text                                 AS n_cod_item,
               ri.c_descricao_produto                               AS x_prod,
               ri.c_cfop_entrada                                    AS cfop,       -- CFOP de ENTRADA (o c_cfop e o do fornecedor)
               ri.n_qtde_nfe                                        AS q_com,
               ri.c_unidade_nfe                                     AS u_com,
               ri.v_total_item                                      AS valor_item  -- = v_prod (research D7 da 016)
        FROM public."tbl_recebimentoNFe_Q2P" r
        JOIN public."tbl_recebimentoNFe_itens_Q2P" ri ON ri.n_id_receb = r.n_id_receb
        WHERE COALESCE(r.c_recebido, 'N') = 'N'
          AND r.d_emissao >= $2::date
          AND NOT EXISTS (SELECT 1 FROM public."tbl_nf_header_Q2P" h2 WHERE h2.c_chave_nfe = r.c_chave_nfe)`;
}

/** CTE `nf_unificada`: fonte (a) sozinha com a flag desligada (query da 015); (a) UNION ALL (b) com a flag ligada. */
function nfUnificadaSql(flag: boolean, canceladaExiste: boolean, nfValida: string): string {
  const a = fonteNfSql(canceladaExiste, nfValida);
  return flag ? `${a}
        UNION ALL
        ${fonteRecebSql()}` : a;
}

/** Fragmento SQL "item ja recebido" para a linha `u` da fonte unificada. */
function recebidoSql(alias = 'u'): string {
  return itemNacionalRecebidoSql({
    chaveExpr: `${alias}.c_chave_nfe`,
    descricaoNormalizadaExpr: normalizarDescricaoSql(`${alias}.x_prod`),
    nfNumeroExpr: `${alias}.n_nf`,
  });
}

function fornecedorNaoExcluidoSql(alias = 'u'): string {
  return `NOT EXISTS (
        SELECT 1 FROM stockbridge.fornecedor_exclusao fe
         WHERE fe.reincluido_em IS NULL AND fe.fornecedor_cnpj = ${alias}.dest_cnpj_cpf)`;
}

/** Dispensa ATIVA pelo gestor (feature 016, FR-021): a NF some das duas fontes ate a reversao. */
function naoDispensadaSql(alias = 'u'): string {
  return `NOT EXISTS (
        SELECT 1 FROM stockbridge.nf_dispensa d
         WHERE d.nf_chave_acesso = ${alias}.c_chave_nfe AND d.revertido_em IS NULL)`;
}

// Espelho SQL da tabela FATOR_UNIDADE_NF (unidade-nf.ts) — SO para a pendencia por
// restante na query da fila (FR-030). Unidade fora da tabela -> NULL -> o item
// segue a regra simples (recebido/nao recebido); a conferencia de coerencia e
// o bloqueio continuam sendo feitos em TS, no detalhe.
const fatorKgSql = (alias = 'u'): string =>
  `CASE upper(btrim(${alias}.u_com)) WHEN 'KG' THEN 1 WHEN 'TON' THEN 1000 WHEN 'TL' THEN 1000 END`;

/** Σ quantidade_nf_kg ja gravada (caminho novo) para a linha `u` — lado da NF. */
function nfJaAtribuidaSql(alias = 'u'): string {
  return `(SELECT COALESCE(SUM(m.quantidade_nf_kg), 0) FROM stockbridge.movimentacao m
            WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
              AND m.nf_chave_acesso = ${alias}.c_chave_nfe
              AND m.nf_item_descricao_normalizada = ${normalizarDescricaoSql(`${alias}.x_prod`)})`;
}

/** Existe solicitacao de baixa externa PENDENTE para a linha `u`. */
function baixaSolicitadaSql(alias = 'u'): string {
  return `EXISTS (SELECT 1 FROM stockbridge.aprovacao a
            WHERE a.tipo_aprovacao = 'recebimento_externo' AND a.status = 'pendente'
              AND a.nf_chave_acesso = ${alias}.c_chave_nfe
              AND ${normalizarDescricaoSql('a.nf_item_descricao')} = ${normalizarDescricaoSql(`${alias}.x_prod`)})`;
}

/**
 * Fila de NFs nacionais pendentes. Degrada para lista vazia em falha de BANCO
 * (a fila e informativa, o manual continua) — mas NAO em falta de configuracao,
 * que e erro de ambiente e precisa ser visivel.
 */
export async function getFilaNacional(params: { q?: string | null; fornecedor?: string | null } = {}): Promise<FilaNacionalItem[]> {
  const dataCorte = getDataCorteFilaNacional();
  const flag = recebimentoFiscalHabilitado();
  const pool = getPool();
  const canceladaExiste = await colunaCanceladaExiste(pool, 'tbl_nf_header_Q2P');
  const nfValida = nfValidaSql(canceladaExiste, 'h');
  const descNorm = normalizarDescricaoSql('u.x_prod');

  const args: unknown[] = [Array.from(CFOPS_RECEBIMENTO_NACIONAL), dataCorte];
  let filtros = '';
  if (params.fornecedor && params.fornecedor.trim()) {
    args.push(`%${params.fornecedor.trim()}%`);
    filtros += `\n        AND (u.dest_cnpj_cpf ILIKE $${args.length} OR u.dest_razao ILIKE $${args.length})`;
  }
  if (params.q && params.q.trim()) {
    args.push(`%${params.q.trim()}%`);
    filtros += `\n        AND (ltrim(u.n_nf, '0') ILIKE $${args.length} OR u.dest_razao ILIKE $${args.length})`;
  }

  // Com a flag ligada, a NF concluida pelo Atlas sai como "fiscal ja feito" com a
  // data do ledger; desligada, a coluna e constante (comportamento da 015).
  const fiscalConcluidoEmSql = flag
    ? `(SELECT MAX(rf.finalizado_em) FROM stockbridge.recebimento_fiscal rf
            WHERE rf.nf_chave_acesso = c_chave_nfe AND rf.status IN ('concluido', 'ja_concluido'))::text`
    : 'NULL::text';

  interface Row {
    nf_chave_acesso: string;
    nota_fiscal: string;
    fornecedor_nome: string | null;
    fornecedor_cnpj: string | null;
    dt_emissao: string;
    dias_desde_emissao: number;
    itens_total: number;
    itens_pendentes: number;
    valor_total_brl: number | null;
    fiscal: SituacaoFiscal;
    fiscal_concluido_em: string | null;
  }

  try {
    const res = await pool.query<Row>(
      `
      WITH nf_unificada AS (${nfUnificadaSql(flag, canceladaExiste, nfValida)}
      ),
      linhas AS (
        SELECT
          u.c_chave_nfe, u.n_nf, u.dest_razao, u.dest_cnpj_cpf, u.d_emi, u.fiscal_pendente,
          ${descNorm}                    AS desc_norm,
          u.valor_item                   AS valor_item,
          ${recebidoSql('u')}            AS recebido,
          -- FR-030 (research D25): pendencia por RESTANTE do lado da NF. Item com
          -- 1 de N produtos gravado (falha/retomada) continua na fila; legado
          -- (match por numero, sem parcela) NAO cai aqui — nf_atribuida = 0.
          (u.q_com * ${fatorKgSql('u')}) AS nf_kg,
          ${nfJaAtribuidaSql('u')}       AS nf_atribuida
        FROM nf_unificada u
        WHERE u.cfop = ANY($1::text[])
          AND NOT u.cancelada AND NOT u.deletada
          AND ${fornecedorNaoExcluidoSql('u')}${flag ? `\n          AND ${naoDispensadaSql('u')}` : ''}${filtros}
      ),
      itens AS (
        SELECT c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi, desc_norm,
               bool_or(fiscal_pendente)                                 AS fiscal_pendente,
               SUM(valor_item)                                          AS valor_item,
               bool_and(recebido)                                       AS recebido,
               SUM(nf_kg)                                               AS nf_kg,
               MAX(nf_atribuida)                                        AS nf_atribuida
        FROM linhas
        GROUP BY c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi, desc_norm
      ),
      itens_flag AS (
        SELECT *,
               (NOT recebido
                OR (nf_kg IS NOT NULL AND nf_atribuida > 0 AND nf_atribuida < nf_kg - 1)) AS pendente
        FROM itens
      )
      SELECT
        c_chave_nfe                                                   AS nf_chave_acesso,
        ltrim(n_nf, '0')                                              AS nota_fiscal,
        dest_razao                                                    AS fornecedor_nome,
        dest_cnpj_cpf                                                 AS fornecedor_cnpj,
        d_emi::text                                                   AS dt_emissao,
        (CURRENT_DATE - d_emi::date)::int                             AS dias_desde_emissao,
        COUNT(*)::int                                                 AS itens_total,
        COUNT(*) FILTER (WHERE pendente)::int                         AS itens_pendentes,
        SUM(valor_item)::float8                                       AS valor_total_brl,
        CASE WHEN bool_or(fiscal_pendente) THEN 'pendente' ELSE 'concluido' END AS fiscal,
        ${fiscalConcluidoEmSql}                                       AS fiscal_concluido_em
      FROM itens_flag
      GROUP BY c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi
      HAVING COUNT(*) FILTER (WHERE pendente) > 0
      ORDER BY d_emi ASC, n_nf ASC
      `,
      args,
    );
    if (flag) {
      // Sync parado deixa a fonte "fiscal pendente" incompleta sem nenhum erro —
      // o warn e o unico sinal alem do health (T051).
      const idade = await idadeEspelhoRecebimentos();
      if (idade.status === 'degraded' || idade.status === 'sem_dados') {
        logger.warn({ idadeMin: idade.idadeMin, status: idade.status, limiteMin: ESPELHO_RECEBIMENTOS_IDADE_MAX_MIN }, 'Espelho de recebimentos de NF-e defasado — NFs com fiscal pendente podem estar faltando na fila');
      }
    }
    return res.rows.map((r) => ({
      nfChaveAcesso: r.nf_chave_acesso,
      notaFiscal: r.nota_fiscal,
      fornecedorNome: r.fornecedor_nome ?? FORNECEDOR_NAO_IDENTIFICADO,
      fornecedorCnpj: r.fornecedor_cnpj ?? '',
      dtEmissao: r.dt_emissao,
      diasDesdeEmissao: Number(r.dias_desde_emissao),
      itensTotal: Number(r.itens_total),
      itensPendentes: Number(r.itens_pendentes),
      valorTotalBrl: r.valor_total_brl != null ? Number(r.valor_total_brl) : 0,
      fiscal: r.fiscal === 'pendente' ? 'pendente' : 'concluido',
      fiscalConcluidoPeloAtlasEm: r.fiscal_concluido_em ? new Date(r.fiscal_concluido_em).toISOString() : null,
    }));
  } catch (err) {
    // Fila e informativa — falha de banco nao pode derrubar a tela de recebimento
    // (o formulario manual continua). Loga e devolve vazio. Sync parado fica
    // indistinguivel de "nada pendente" so no dado; o log e o sinal.
    logger.warn({ err: (err as Error).message }, 'getFilaNacional falhou — retornando vazio');
    return [];
  }
}

// ── Detalhe ────────────────────────────────────────────────────────────────

export type BloqueioItemNf = 'unidade_nao_conversivel' | 'unidade_incoerente' | 'sem_correlacao' | null;

export interface ProdutoSugerido {
  codigo: number;
  descricao: string;
  vezesUsada: number;
}

/** Um item do detalhe = uma DESCRICAO da NF (linhas de mesma descricao agregadas). */
export interface ItemNfNacional {
  indice: number;
  descricaoFornecedor: string;
  descricaoNormalizada: string;
  cfop: string;
  quantidadeNf: number;
  unidadeOriginal: string;
  /** null quando bloqueado por unidade */
  quantidadeNfKg: number | null;
  /** media ponderada Σvalor_item / Σq_com — nao o v_un_com de uma das linhas */
  valorUnitarioBrl: number;
  valorTotalItemBrl: number;
  /** R$/kg pela leitura declarada (null quando bloqueado) */
  rsPorKg: number | null;
  linhasAgregadas: number;
  produtosSugeridos: ProdutoSugerido[];
  bloqueio: BloqueioItemNf;
  /** mensagem do bloqueio de unidade, quando houver — ja em pt-BR, sem codigo OMIE */
  bloqueioMensagem: string | null;
  jaRecebido: boolean;
  /** Σ quantidade_nf_kg das movimentacoes ativas do item (lado da NF) */
  quantidadeNfJaAtribuidaKg: number;
  /** Σ quantidade_kg (conferida) ja gravada — base do que falta distribuir na retomada */
  quantidadeConferidaJaGravadaKg: number;
  /** quantidadeNfKg − quantidadeNfJaAtribuidaKg (null quando bloqueado) */
  quantidadeRestanteKg: number | null;
  baixadoComoExterno: boolean;
  /** ha solicitacao de baixa externa PENDENTE de aprovacao — o item continua na fila, marcado */
  baixaSolicitada: boolean;
  /** detalhe da conversao (para quem precisa dos dois R$/kg) */
  conversao: ConversaoNf;
}

export interface DetalheNfNacional {
  nfChaveAcesso: string;
  notaFiscal: string;
  fornecedorNome: string;
  /** '' quando a fonte (b) nao traz CNPJ (fornecedor nao cadastrado no OMIE) */
  fornecedorCnpj: string;
  dtEmissao: string;
  diasDesdeEmissao: number;
  /** CFOPs presentes nas linhas elegiveis (o CFOP e do ITEM, nao do cabecalho) */
  cfop: string;
  valorTotalBrl: number;
  itens: ItemNfNacional[];
  /** linhas da NF fora do recorte de CFOP (ex.: item de consumo numa NF mista) — nao recebiveis por aqui */
  linhasForaDoRecorte: number;
  /** feature 016: situacao do recebimento fiscal no OMIE */
  fiscal: SituacaoFiscal;
  /** id do recebimento na caixa do OMIE (fonte b, ou n_id_receb do espelho de NF) — para a conclusao fiscal */
  nIdReceb: number | null;
  /** feature 016: gestor pode dispensar (flag ligada, sem dispensa ativa, ao menos um item pendente) */
  dispensavel: boolean;
}

/**
 * Item ainda pendente para fins de dispensa/baixa: nao recebido por inteiro
 * (restante acima da tolerancia) e nao baixado como externo. Mesma regra de
 * `recebimento-externo.service.ts`.
 */
export function itemNfPendente(it: ItemNfNacional): boolean {
  const recebidoIntegral = it.jaRecebido && (it.quantidadeNfJaAtribuidaKg === 0 || (it.quantidadeRestanteKg ?? 0) <= 1);
  return !recebidoIntegral && !it.baixadoComoExterno;
}

interface LinhaRow {
  nf_chave_acesso: string;
  n_nf: string;
  nota_fiscal: string;
  fornecedor_nome: string | null;
  fornecedor_cnpj: string | null;
  dt_emissao: string;
  dias_desde_emissao: number;
  cancelada: boolean;
  deletada: boolean;
  fornecedor_excluido: boolean;
  fiscal_pendente: boolean;
  n_id_receb: string | number | null;
  n_cod_item: string;
  x_prod: string;
  desc_norm: string;
  cfop: string;
  q_com: number;
  u_com: string | null;
  /** valor do item COM tributos — `v_prod` (fonte a) ou `v_total_item` (fonte b); ver D26/D7 no topo */
  valor_item: number;
  recebido: boolean;
  baixado_externo: boolean;
  baixa_solicitada: boolean;
  nf_ja_atribuida_kg: number;
  conferida_ja_gravada_kg: number;
}

/**
 * Detalhe de uma NF pela chave de acesso, com os itens agregados por descricao,
 * convertidos para Kg (tabela explicita + conferencia de coerencia) e marcados
 * como recebidos/pendentes pela checagem em duas vias.
 *
 * Repete os filtros da fila (CFOP, corte, cancelada, fornecedor, dispensa) para
 * que o detalhe nunca mostre um item que a fila nao mostraria — NF mista tem as
 * linhas fora do recorte excluidas e contadas em `linhasForaDoRecorte`.
 */
export async function getDetalheNfNacional(chaveAcesso: string): Promise<DetalheNfNacional> {
  const chave = (chaveAcesso ?? '').trim();
  if (!/^\d{44}$/.test(chave)) throw new NfNacionalNaoEncontradaError(chave, 'chave de acesso inválida');

  const dataCorte = getDataCorteFilaNacional();
  const flag = recebimentoFiscalHabilitado();
  const pool = getPool();
  const canceladaExiste = await colunaCanceladaExiste(pool, 'tbl_nf_header_Q2P');
  const descNorm = normalizarDescricaoSql('u.x_prod');

  const res = await pool.query<LinhaRow>(
    `
    WITH nf_unificada AS (${nfUnificadaSql(flag, canceladaExiste, '')}
    )
    SELECT
      u.c_chave_nfe                                    AS nf_chave_acesso,
      u.n_nf                                           AS n_nf,
      ltrim(u.n_nf, '0')                               AS nota_fiscal,
      u.dest_razao                                     AS fornecedor_nome,
      u.dest_cnpj_cpf                                  AS fornecedor_cnpj,
      u.d_emi::text                                    AS dt_emissao,
      (CURRENT_DATE - u.d_emi::date)::int              AS dias_desde_emissao,
      u.cancelada                                      AS cancelada,
      u.deletada                                       AS deletada,
      NOT ${fornecedorNaoExcluidoSql('u')}             AS fornecedor_excluido,
      u.fiscal_pendente                                AS fiscal_pendente,
      u.n_id_receb                                     AS n_id_receb,
      u.n_cod_item                                     AS n_cod_item,
      u.x_prod                                         AS x_prod,
      ${descNorm}                                      AS desc_norm,
      u.cfop                                           AS cfop,
      u.q_com::float8                                  AS q_com,
      u.u_com                                          AS u_com,
      u.valor_item::float8                             AS valor_item,  -- D26: NAO v_tot_item
      ${recebidoSql('u')}                              AS recebido,
      EXISTS (SELECT 1 FROM stockbridge.aprovacao a
               WHERE a.tipo_aprovacao = 'recebimento_externo' AND a.status = 'aprovada'
                 AND a.nf_chave_acesso = u.c_chave_nfe
                 AND ${normalizarDescricaoSql('a.nf_item_descricao')} = ${descNorm}) AS baixado_externo,
      ${baixaSolicitadaSql('u')}                       AS baixa_solicitada,
      (SELECT COALESCE(SUM(m.quantidade_nf_kg), 0) FROM stockbridge.movimentacao m
        WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
          AND m.nf_chave_acesso = u.c_chave_nfe
          AND m.nf_item_descricao_normalizada = ${descNorm})::float8 AS nf_ja_atribuida_kg,
      (SELECT COALESCE(SUM(m.quantidade_kg), 0) FROM stockbridge.movimentacao m
        WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
          AND m.nf_chave_acesso = u.c_chave_nfe
          AND m.nf_item_descricao_normalizada = ${descNorm})::float8 AS conferida_ja_gravada_kg
    FROM nf_unificada u
    WHERE u.c_chave_nfe = $1
    ORDER BY u.n_cod_item
    `,
    [chave, dataCorte],
  );

  if (res.rows.length === 0) {
    throw new NfNacionalNaoEncontradaError(chave, 'ainda não foi sincronizada ou é anterior à data de corte');
  }
  const cab = res.rows[0]!;
  if (cab.cancelada || cab.deletada) throw new NfNacionalCanceladaError(cab.nota_fiscal);
  if (cab.fornecedor_excluido) throw new FornecedorExcluidoError(cab.fornecedor_nome ?? FORNECEDOR_NAO_IDENTIFICADO);

  // Feature 016 (FR-021, contrato §2): NF dispensada pelo gestor sai da fila e o
  // detalhe diz por que — so com a flag ligada (desligada, a dispensa nao existe).
  let dispensaAtiva = false;
  if (flag) {
    const d = await pool.query<{ dispensado_em: string }>(
      `SELECT dispensado_em::text AS dispensado_em FROM stockbridge.nf_dispensa
        WHERE nf_chave_acesso = $1 AND revertido_em IS NULL LIMIT 1`,
      [chave],
    );
    if (d.rows.length > 0) {
      dispensaAtiva = true;
      const quando = new Date(d.rows[0]!.dispensado_em);
      const data = Number.isNaN(quando.getTime()) ? d.rows[0]!.dispensado_em : quando.toLocaleDateString('pt-BR');
      throw new NfNacionalNaoEncontradaError(
        chave,
        undefined,
        `A NF ${cab.nota_fiscal} foi dispensada da fila pelo gestor em ${data}. Para recebê-la, peça a reversão da dispensa.`,
      );
    }
  }

  const cfops = new Set(CFOPS_RECEBIMENTO_NACIONAL);
  const elegiveis = res.rows.filter((r) => cfops.has(r.cfop));
  if (elegiveis.length === 0) {
    throw new NfNacionalNaoEncontradaError(
      chave,
      undefined,
      `A NF ${cab.nota_fiscal} foi localizada, mas nenhum item dela é compra de mercadoria coberta por este recebimento. Se for o caso, receba pelo formulário manual.`,
    );
  }

  // Agrega por descricao normalizada — sao lotes distintos, somam (D18/D20).
  const grupos = new Map<string, LinhaRow[]>();
  for (const r of elegiveis) {
    const g = grupos.get(r.desc_norm);
    if (g) g.push(r);
    else grupos.set(r.desc_norm, [r]);
  }

  const fornecedorCnpj = cab.fornecedor_cnpj ?? '';
  const fornecedorNome = cab.fornecedor_nome ?? FORNECEDOR_NAO_IDENTIFICADO;

  // Historia 3 (FR-006): sugestao memorizada por (fornecedor, descricao normalizada).
  // Best-effort — falha aqui nao pode derrubar o detalhe da NF.
  let sugestoes = new Map<string, ProdutoSugerido[]>();
  if (fornecedorCnpj) {
    try {
      sugestoes = await sugerirProdutosEmLote(fornecedorCnpj, Array.from(grupos.keys()));
    } catch (err) {
      logger.warn({ err: (err as Error).message, chave }, 'Sugestão de correlação indisponível — detalhe segue sem pré-seleção');
    }
  }

  const itens: ItemNfNacional[] = [];
  let indice = 0;
  for (const [descNormalizada, linhas] of grupos) {
    const primeira = linhas[0]!;
    const quantidadeNf = linhas.reduce((s, l) => s + Number(l.q_com), 0);
    const valorTotalItemBrl = linhas.reduce((s, l) => s + Number(l.valor_item), 0);
    const unidades = new Set(linhas.map((l) => (l.u_com ?? '').trim().toUpperCase()));
    const unidadeOriginal = (primeira.u_com ?? '').trim().toUpperCase();

    // Linhas de mesma descricao com unidades diferentes: nao da para somar sem
    // adivinhar — bloqueia (raro; o manual recebe).
    const conversao: ConversaoNf =
      unidades.size > 1
        ? {
            ok: false,
            motivo: 'unidade_nao_conversivel',
            unidadeOriginal: Array.from(unidades).join('/'),
            mensagem: `Linhas de "${primeira.x_prod.trim()}" vêm em unidades diferentes (${Array.from(unidades).join(', ')}) e não podem ser somadas. Receba pelo formulário manual.`,
          }
        : converterItemNfParaKg(quantidadeNf, unidadeOriginal, valorTotalItemBrl);

    const bloqueioUnidade: BloqueioItemNf = conversao.ok
      ? null
      : conversao.motivo === 'unidade_incoerente'
        ? 'unidade_incoerente'
        : 'unidade_nao_conversivel';

    const jaRecebido = linhas.every((l) => l.recebido);
    const nfJaAtribuida = Number(primeira.nf_ja_atribuida_kg);
    const conferidaJaGravada = Number(primeira.conferida_ja_gravada_kg);
    const quantidadeNfKg = conversao.ok ? conversao.quantidadeKg : null;

    // Sem correlacao memorizada, o operador escolhe o produto no combobox (FR-005);
    // 'sem_correlacao' e informativo para a UI, nao um bloqueio de servidor.
    const produtosSugeridos: ProdutoSugerido[] = sugestoes.get(descNormalizada) ?? [];
    const bloqueio: BloqueioItemNf = bloqueioUnidade ?? (produtosSugeridos.length === 0 ? 'sem_correlacao' : null);

    itens.push({
      indice: indice++,
      descricaoFornecedor: primeira.x_prod,
      descricaoNormalizada: descNormalizada,
      cfop: primeira.cfop,
      quantidadeNf,
      unidadeOriginal,
      quantidadeNfKg,
      valorUnitarioBrl: quantidadeNf > 0 ? valorTotalItemBrl / quantidadeNf : 0,
      valorTotalItemBrl,
      rsPorKg: conversao.ok ? conversao.rsPorKg : null,
      linhasAgregadas: linhas.length,
      produtosSugeridos,
      bloqueio,
      bloqueioMensagem: conversao.ok ? null : conversao.mensagem,
      jaRecebido,
      quantidadeNfJaAtribuidaKg: nfJaAtribuida,
      quantidadeConferidaJaGravadaKg: conferidaJaGravada,
      quantidadeRestanteKg: quantidadeNfKg != null ? Math.max(0, quantidadeNfKg - nfJaAtribuida) : null,
      baixadoComoExterno: linhas.some((l) => l.baixado_externo),
      baixaSolicitada: linhas.some((l) => l.baixa_solicitada),
      conversao,
    });
  }

  const fiscal: SituacaoFiscal = res.rows.some((r) => r.fiscal_pendente === true) ? 'pendente' : 'concluido';
  const nIdReceb = cab.n_id_receb != null && cab.n_id_receb !== '' ? Number(cab.n_id_receb) : null;

  return {
    nfChaveAcesso: cab.nf_chave_acesso,
    notaFiscal: cab.nota_fiscal,
    fornecedorNome,
    fornecedorCnpj,
    dtEmissao: cab.dt_emissao,
    diasDesdeEmissao: Number(cab.dias_desde_emissao),
    cfop: Array.from(new Set(elegiveis.map((r) => r.cfop))).join(', '),
    valorTotalBrl: elegiveis.reduce((s, l) => s + Number(l.valor_item), 0),
    itens,
    linhasForaDoRecorte: res.rows.length - elegiveis.length,
    fiscal,
    nIdReceb: nIdReceb != null && Number.isFinite(nIdReceb) ? nIdReceb : null,
    dispensavel: flag && !dispensaAtiva && itens.some(itemNfPendente),
  };
}
