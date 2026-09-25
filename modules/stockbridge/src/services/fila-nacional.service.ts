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
 * Fila e detalhe de NF nacional (feature 015, ACXEGDP-328).
 *
 * Fonte: ESPELHO Postgres (public."tbl_nf_header_Q2P" ⋈ "tbl_nf_itens_Q2P"),
 * sincronizado pelo n8n. Zero chamada OMIE ao vivo — mais estrito que a fila de
 * importacao, que consulta a NF no OMIE ao buscar (Principio II, FR-016).
 *
 * Decisoes que moldam a query (research):
 *  - D6: CFOP armazenado COM ponto ('1.102'); comparar contra '1102' nao casa nada.
 *  - D1: `n_id_receb` esta preenchido em 5.540 de 5.541 NFs de entrada — e o
 *    recebimento FISCAL do OMIE, nao a entrada fisica. NAO entra na pendencia.
 *  - D21: "ja recebida" so pelo lado Atlas, em duas vias + baixa externa
 *    (itemNacionalRecebidoSql). Cobre ~90% do historico do formulario manual.
 *  - D23: corte FIXO (config), nao janela movel — NF emitida antes nunca entra;
 *    depois, fica ate ser recebida ou baixada. Sem config, a fila NAO sobe.
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
 *    Medido em PROD (2026, recorte da feature): 1.431 de 1.663 linhas com o IPI
 *    duplicado, 178 sem tributo (campos iguais) e nenhuma em que `v_tot_item` seja
 *    o valor certo. Usar `v_tot_item` inflava o valor exibido E o custo unitario
 *    gravado — que vai ao OMIE no ajuste de estoque.
 */

export const CFOPS_RECEBIMENTO_NACIONAL: readonly string[] = Object.freeze(['1.101', '1.102', '2.101', '2.102']);

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

/** Uma linha da fila: uma NF nacional elegivel com pelo menos um item pendente. */
export interface FilaNacionalItem {
  nfChaveAcesso: string;
  notaFiscal: string;
  fornecedorNome: string;
  fornecedorCnpj: string;
  dtEmissao: string;
  diasDesdeEmissao: number;
  itensTotal: number;
  itensPendentes: number;
  valorTotalBrl: number;
}

/** Fragmento SQL "item ja recebido" para o par (h, i) da query. */
function recebidoSql(): string {
  return itemNacionalRecebidoSql({
    chaveExpr: 'h.c_chave_nfe',
    descricaoNormalizadaExpr: normalizarDescricaoSql('i.x_prod'),
    nfNumeroExpr: 'h.n_nf',
  });
}

const FORNECEDOR_NAO_EXCLUIDO_SQL = `NOT EXISTS (
        SELECT 1 FROM stockbridge.fornecedor_exclusao fe
         WHERE fe.reincluido_em IS NULL AND fe.fornecedor_cnpj = h.dest_cnpj_cpf)`;

// Espelho SQL da tabela FATOR_UNIDADE_NF (unidade-nf.ts) — SO para a pendencia por
// restante na query da fila (FR-030). Unidade fora da tabela -> NULL -> o item
// segue a regra simples (recebido/nao recebido); a conferencia de coerencia e
// o bloqueio continuam sendo feitos em TS, no detalhe.
const FATOR_KG_SQL = `CASE upper(btrim(i.u_com)) WHEN 'KG' THEN 1 WHEN 'TON' THEN 1000 WHEN 'TL' THEN 1000 END`;

/** Σ quantidade_nf_kg ja gravada (caminho novo) para a linha (h, i) — lado da NF. */
function nfJaAtribuidaSql(): string {
  return `(SELECT COALESCE(SUM(m.quantidade_nf_kg), 0) FROM stockbridge.movimentacao m
            WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
              AND m.nf_chave_acesso = h.c_chave_nfe
              AND m.nf_item_descricao_normalizada = ${normalizarDescricaoSql('i.x_prod')})`;
}

/** Existe solicitacao de baixa externa PENDENTE para a linha (h, i). */
function baixaSolicitadaSql(): string {
  return `EXISTS (SELECT 1 FROM stockbridge.aprovacao a
            WHERE a.tipo_aprovacao = 'recebimento_externo' AND a.status = 'pendente'
              AND a.nf_chave_acesso = h.c_chave_nfe
              AND ${normalizarDescricaoSql('a.nf_item_descricao')} = ${normalizarDescricaoSql('i.x_prod')})`;
}

/**
 * Fila de NFs nacionais pendentes. Degrada para lista vazia em falha de BANCO
 * (a fila e informativa, o manual continua) — mas NAO em falta de configuracao,
 * que e erro de ambiente e precisa ser visivel.
 */
export async function getFilaNacional(params: { q?: string | null; fornecedor?: string | null } = {}): Promise<FilaNacionalItem[]> {
  const dataCorte = getDataCorteFilaNacional();
  const pool = getPool();
  const nfValida = nfValidaSql(await colunaCanceladaExiste(pool, 'tbl_nf_header_Q2P'), 'h');
  const descNorm = normalizarDescricaoSql('i.x_prod');

  const args: unknown[] = [Array.from(CFOPS_RECEBIMENTO_NACIONAL), dataCorte];
  let filtros = '';
  if (params.fornecedor && params.fornecedor.trim()) {
    args.push(`%${params.fornecedor.trim()}%`);
    filtros += `\n        AND (h.dest_cnpj_cpf ILIKE $${args.length} OR h.dest_razao ILIKE $${args.length})`;
  }
  if (params.q && params.q.trim()) {
    args.push(`%${params.q.trim()}%`);
    filtros += `\n        AND (ltrim(h.n_nf, '0') ILIKE $${args.length} OR h.dest_razao ILIKE $${args.length})`;
  }

  interface Row {
    nf_chave_acesso: string;
    nota_fiscal: string;
    fornecedor_nome: string;
    fornecedor_cnpj: string;
    dt_emissao: string;
    dias_desde_emissao: number;
    itens_total: number;
    itens_pendentes: number;
    valor_total_brl: number | null;
  }

  try {
    const res = await pool.query<Row>(
      `
      WITH linhas AS (
        SELECT
          h.c_chave_nfe, h.n_nf, h.dest_razao, h.dest_cnpj_cpf, h.d_emi,
          ${descNorm}                    AS desc_norm,
          i.v_prod                       AS valor_item,  -- D26: NAO v_tot_item (IPI em dobro)
          ${recebidoSql()}               AS recebido,
          -- FR-030 (research D25): pendencia por RESTANTE do lado da NF. Item com
          -- 1 de N produtos gravado (falha/retomada) continua na fila; legado
          -- (match por numero, sem parcela) NAO cai aqui — nf_atribuida = 0.
          (i.q_com * ${FATOR_KG_SQL})    AS nf_kg,
          ${nfJaAtribuidaSql()}          AS nf_atribuida
        FROM public."tbl_nf_header_Q2P" h
        JOIN public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf
        WHERE h.tp_nf = 0
          AND i.cfop = ANY($1::text[])
          AND h.d_emi >= $2::date
          ${nfValida}
          AND ${FORNECEDOR_NAO_EXCLUIDO_SQL}${filtros}
      ),
      itens AS (
        SELECT c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi, desc_norm,
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
        SUM(valor_item)::float8                                       AS valor_total_brl
      FROM itens_flag
      GROUP BY c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi
      HAVING COUNT(*) FILTER (WHERE pendente) > 0
      ORDER BY d_emi ASC, n_nf ASC
      `,
      args,
    );
    return res.rows.map((r) => ({
      nfChaveAcesso: r.nf_chave_acesso,
      notaFiscal: r.nota_fiscal,
      fornecedorNome: r.fornecedor_nome,
      fornecedorCnpj: r.fornecedor_cnpj,
      dtEmissao: r.dt_emissao,
      diasDesdeEmissao: Number(r.dias_desde_emissao),
      itensTotal: Number(r.itens_total),
      itensPendentes: Number(r.itens_pendentes),
      valorTotalBrl: r.valor_total_brl != null ? Number(r.valor_total_brl) : 0,
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
  fornecedorCnpj: string;
  dtEmissao: string;
  diasDesdeEmissao: number;
  /** CFOPs presentes nas linhas elegiveis (o CFOP e do ITEM, nao do cabecalho) */
  cfop: string;
  valorTotalBrl: number;
  itens: ItemNfNacional[];
  /** linhas da NF fora do recorte de CFOP (ex.: item de consumo numa NF mista) — nao recebiveis por aqui */
  linhasForaDoRecorte: number;
}

interface LinhaRow {
  nf_chave_acesso: string;
  n_nf: string;
  nota_fiscal: string;
  fornecedor_nome: string;
  fornecedor_cnpj: string;
  dt_emissao: string;
  dias_desde_emissao: number;
  cancelada: boolean;
  deletada: boolean;
  fornecedor_excluido: boolean;
  n_cod_item: string;
  x_prod: string;
  desc_norm: string;
  cfop: string;
  q_com: number;
  u_com: string | null;
  /** valor do item COM tributos, lido de `i.v_prod` — ver D26 no topo do arquivo */
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
 * Repete os filtros da fila (CFOP, corte, cancelada, fornecedor) para que o
 * detalhe nunca mostre um item que a fila nao mostraria — NF mista tem as linhas
 * fora do recorte excluidas e contadas em `linhasForaDoRecorte`.
 */
export async function getDetalheNfNacional(chaveAcesso: string): Promise<DetalheNfNacional> {
  const chave = (chaveAcesso ?? '').trim();
  if (!/^\d{44}$/.test(chave)) throw new NfNacionalNaoEncontradaError(chave, 'chave de acesso inválida');

  const dataCorte = getDataCorteFilaNacional();
  const pool = getPool();
  const canceladaExiste = await colunaCanceladaExiste(pool, 'tbl_nf_header_Q2P');
  const descNorm = normalizarDescricaoSql('i.x_prod');

  const res = await pool.query<LinhaRow>(
    `
    SELECT
      h.c_chave_nfe                                    AS nf_chave_acesso,
      h.n_nf                                           AS n_nf,
      ltrim(h.n_nf, '0')                               AS nota_fiscal,
      h.dest_razao                                     AS fornecedor_nome,
      h.dest_cnpj_cpf                                  AS fornecedor_cnpj,
      h.d_emi::text                                    AS dt_emissao,
      (CURRENT_DATE - h.d_emi::date)::int              AS dias_desde_emissao,
      ${canceladaExiste ? 'COALESCE(h.cancelada, false)' : 'false'} AS cancelada,
      COALESCE(h.deletada, false)                      AS deletada,
      NOT ${FORNECEDOR_NAO_EXCLUIDO_SQL}               AS fornecedor_excluido,
      i.n_cod_item::text                               AS n_cod_item,
      i.x_prod                                         AS x_prod,
      ${descNorm}                                      AS desc_norm,
      i.cfop                                           AS cfop,
      i.q_com::float8                                  AS q_com,
      i.u_com                                          AS u_com,
      i.v_prod::float8                                 AS valor_item,  -- D26: NAO v_tot_item
      ${recebidoSql()}                                 AS recebido,
      EXISTS (SELECT 1 FROM stockbridge.aprovacao a
               WHERE a.tipo_aprovacao = 'recebimento_externo' AND a.status = 'aprovada'
                 AND a.nf_chave_acesso = h.c_chave_nfe
                 AND ${normalizarDescricaoSql('a.nf_item_descricao')} = ${descNorm}) AS baixado_externo,
      ${baixaSolicitadaSql()}                          AS baixa_solicitada,
      (SELECT COALESCE(SUM(m.quantidade_nf_kg), 0) FROM stockbridge.movimentacao m
        WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
          AND m.nf_chave_acesso = h.c_chave_nfe
          AND m.nf_item_descricao_normalizada = ${descNorm})::float8 AS nf_ja_atribuida_kg,
      (SELECT COALESCE(SUM(m.quantidade_kg), 0) FROM stockbridge.movimentacao m
        WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
          AND m.nf_chave_acesso = h.c_chave_nfe
          AND m.nf_item_descricao_normalizada = ${descNorm})::float8 AS conferida_ja_gravada_kg
    FROM public."tbl_nf_header_Q2P" h
    JOIN public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf
    WHERE h.tp_nf = 0
      AND h.c_chave_nfe = $1
      AND h.d_emi >= $2::date
    ORDER BY i.n_cod_item
    `,
    [chave, dataCorte],
  );

  if (res.rows.length === 0) {
    throw new NfNacionalNaoEncontradaError(chave, 'ainda não foi sincronizada ou é anterior à data de corte');
  }
  const cab = res.rows[0]!;
  if (cab.cancelada || cab.deletada) throw new NfNacionalCanceladaError(cab.nota_fiscal);
  if (cab.fornecedor_excluido) throw new FornecedorExcluidoError(cab.fornecedor_nome);

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

  // Historia 3 (FR-006): sugestao memorizada por (fornecedor, descricao normalizada).
  // Best-effort — falha aqui nao pode derrubar o detalhe da NF.
  let sugestoes = new Map<string, ProdutoSugerido[]>();
  try {
    sugestoes = await sugerirProdutosEmLote(cab.fornecedor_cnpj, Array.from(grupos.keys()));
  } catch (err) {
    logger.warn({ err: (err as Error).message, chave }, 'Sugestão de correlação indisponível — detalhe segue sem pré-seleção');
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

  return {
    nfChaveAcesso: cab.nf_chave_acesso,
    notaFiscal: cab.nota_fiscal,
    fornecedorNome: cab.fornecedor_nome,
    fornecedorCnpj: cab.fornecedor_cnpj,
    dtEmissao: cab.dt_emissao,
    diasDesdeEmissao: Number(cab.dias_desde_emissao),
    cfop: Array.from(new Set(elegiveis.map((r) => r.cfop))).join(', '),
    valorTotalBrl: elegiveis.reduce((s, l) => s + Number(l.valor_item), 0),
    itens,
    linhasForaDoRecorte: res.rows.length - elegiveis.length,
  };
}
