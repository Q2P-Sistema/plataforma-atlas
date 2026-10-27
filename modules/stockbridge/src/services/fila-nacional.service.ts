import { getPool, getConfig, createLogger } from '@atlas/core';
import {
  nfValidaSql,
  colunaCanceladaExiste,
  itemNacionalRecebidoSql,
  movimentacaoDoItemNacionalSql,
  normalizarDescricaoSql,
} from './fiscal-recebida-sql.js';
import { converterItemNfParaKg, FATOR_UNIDADE_NF, isUnidadeNfConhecida, normalizarGrafiaUnidadeNf, type ConversaoNf } from './unidade-nf.js';
import { sugerirProdutosEmLote } from './correlacao-produto.service.js';
import {
  carregarContextoPc,
  exigePcHabilitado,
  montarPcDoItem,
  montarPcsDaNf,
  opcoesPc,
  pcSituacaoDaNf,
  tabelaPcs,
  toleranciasPc,
  sugerirPcPorItens,
  sugerirPcPorItensComContexto,
  type ContextoPc,
  type ItemParaPcsDaNf,
  type ItemParaSugestao,
  type PcDoItem,
  type PcsDaNf,
  type PcSituacaoItem,
  type PcSituacaoNf,
  type ResultadoPcItem,
  type VinculoLinhaOmie,
} from './pc-sugestao.service.js';
import {
  tabelasNacional,
  empresasNacionalAtivas,
  recebimentoNacionalAcxeHabilitado,
  dataCorteAcxe,
  type EmpresaNacional,
} from './empresa-nacional.js';
import { resolverGemeosQ2p } from './produto-gemeo-q2p.js';
import {
  fiscalRevertidoHabilitado,
  fiscalRevertidoSql,
  conclusaoFiscalEmSql,
  pendenciaEspelhoEmSql,
  reversaoOmieDoLedgerEmSql,
  MARGEM_REVERSAO_ESPELHO_MIN,
  ledgerFiscalVigente,
  marcarLedgerRevertido,
} from './fiscal-revertido.js';

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
 *      Com a flag desligada a query e a da 015 (FR-020), salvo a via 2 da
 *      checagem "ja recebida", que passou a exigir lancamento a partir da emissao.
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
 *  - ACXEGDP-412: a movimentacao do item tambem casa pela SEQUENCIA do item no
 *    recebimento de NF-e (`n_seq`), porque a descricao da fonte (b) muda depois
 *    do fiscal quando o OMIE pre-associa o item a um produto (NF 36624).
 *  - D3: o espelho nao guarda total de cabecalho — valor da NF = soma dos itens.
 *  - D26 (ACXEGDP-328, 24/09/2026): o valor do item e `i.v_prod`, NAO `i.v_tot_item`.
 *    O espelho grava `v_prod` = valor do item COM tributos (o `<vItem>` do XML) e
 *    `v_tot_item` = `v_prod` + IPI OUTRA VEZ. Provado na NF 59697 da Zaraplast:
 *    XML `<vItem>` 118.800,07 = `v_prod`; `v_tot_item` 124.457,22 = + 5.657,15 de IPI;
 *    Σ`v_prod` = 267.300,15 = `<vNF>` exato, Σ`v_tot_item` = 280.028,73 (IPI em dobro).
 *    Na fonte (b) o equivalente e `v_total_item` (= `vTotalItem` do recebimento, que
 *    na Zaraplast 59869 bateu com `v_prod` — research D7 da 016).
 *
 * Feature 017 (ACXEGDP-437) — pedido de compra (PC):
 *  - as duas fontes levam o vinculo do item com o PC no OMIE (colunas da 0056 no
 *    espelho de recebimentos; na fonte (a) por chave + sequencia) e o preco
 *    COMERCIAL do item (`n_preco_unit` / `v_un_com`, nunca `v_prod`) — base da
 *    sugestao de PC (pc-sugestao.service.ts, research D3);
 *  - a fonte (a) passa a ler o espelho de recebimentos SEMPRE (antes so com a
 *    chave da 016 ligada): o PC vinculado a vista (FR-021) e o bloqueio de estoque
 *    ja lancado pelo OMIE (FR-021a, D7) valem com a chave desligada. A 0056 exige
 *    o espelho (0053), entao ele existe em todo ambiente com a 017;
 *  - so a fonte (b) traz o codigo do fornecedor (`n_id_fornecedor`): a sugestao so
 *    existe com fiscal pendente, que vem de la; na (a) ele e NULL.
 *
 * Feature 017, Historia 5 (ACXEGDP-437) — compra nacional da ACXE na MESMA fila:
 *  - cada empresa le o proprio espelho (`tabelasNacional`: NF, itens e recebimentos da Q2P
 *    ou da ACXE, mesma DDL) e as duas fontes se repetem por empresa num UNION ALL; a linha
 *    carrega `empresa` e a fila/o detalhe devolvem `empresa` por NF. A identidade segue
 *    sendo a chave de acesso (unica entre os espelhos), mas o NUMERO da NF colide entre eles
 *    (NF 5832: FDMA na ACXE, ACXE na Q2P) — por isso a exclusao de fornecedor e a via 2 do
 *    "ja recebida" casam tambem pela empresa;
 *  - a ACXE so entra com `recebimentoNacionalAcxeHabilitado()` (chave propria + fiscal pelo
 *    Atlas + corte PROPRIO, parametro separado do da Q2P). Sem ela — ou com as tabelas
 *    espelho da ACXE ausentes — o SQL e o resultado da Q2P sao os de sempre, byte a byte:
 *    nada da ACXE derruba a Q2P (a falta e logada e vai para o health);
 *  - o produto e o local da NF da ACXE nao vem da memoria fornecedor x descricao (so Q2P):
 *    o detalhe sugere o produto que o OMIE ja associou ao item (n_cod_prod / n_id_produto) e o
 *    do item do PC; o local de entrada vem do item do PC (resolvido no servidor).
 *
 * Feature 017, D21 (ACXEGDP-437) — recebimento fiscal REVERTIDO no portal do OMIE (NF 19252, 25/10/2026):
 *  - o Atlas concluiu o fiscal e o usuario o desfez no portal (etapa 40, cRecebido N). O espelho de NF
 *    NUNCA marca a nota de entrada como excluida e o ledger seguia 'concluido': a fila mostrava "fiscal
 *    ja feito" e o clique faria so o fisico. O sinal (fiscalRevertidoSql, fiscal-revertido.ts) compara
 *    horas de EVENTO do OMIE e e avaliado DENTRO das duas fontes de cada empresa:
 *      (a) a NF revertida SAI inteira (a nota de entrada tem 1 linha das 4 do recebimento e nao traz o
 *          fornecedor); (b) a assume — ignora a precedencia de (a), entra mesmo sem espelho de recebimentos
 *          'N'/etapa 40 (o marcador da leitura ao vivo pode chegar com a linha ainda 'S'/60) e sai com
 *          fiscal_pendente = true; a coluna `fiscal_revertido`, ULTIMA das duas fontes, vai a fila e ao detalhe.
 *  - `SituacaoFiscal` continua binaria: NF revertida = fiscal 'pendente' + `fiscalRevertido`. Nenhum
 *    consumidor novo de valor (CHECK de nf_dispensa, a tela compara === 'pendente').
 *  - So vale com `comRevertido` (chave da 016 + kill switch + migration 0060). Sem isso o SQL e o de antes,
 *    byte a byte (goldens `*-desligado` e `*-ligado`): todo trecho novo e um sufixo que vale '' quando desligado.
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

/** NF com dispensa ATIVA pelo gestor (feature 016, FR-021): some da fila; o detalhe explica (contrato §2). */
export class NfNacionalDispensadaError extends Error {
  constructor(public readonly notaFiscal: string, public readonly dispensadoEm: string) {
    super(`A NF ${notaFiscal} foi dispensada da fila pelo gestor em ${dispensadoEm}. Para recebê-la, peça ao gestor para desfazer a dispensa em Aprovações.`);
    this.name = 'NfNacionalDispensadaError';
  }
}

/**
 * Tabela que a fila le nao existe (42P01) — ex.: flag ligada antes de aplicar a
 * migration 0053. E erro de AMBIENTE, como a data de corte ausente: precisa ser
 * visivel (503), nunca uma fila vazia em silencio (revisao pre-UAT, MIG-3).
 */
export class FilaNacionalIncompletaError extends Error {
  constructor() {
    super('A fila de recebimento nacional está com a configuração incompleta neste ambiente (falta uma atualização do banco de dados). Avise o administrador.');
    this.name = 'FilaNacionalIncompletaError';
  }
}

/**
 * Erro do Postgres por objeto de schema ausente, percorrendo `cause`: tabela
 * (42P01) ou coluna (42703 — ex.: imagem nova antes da migration 0055, ACXEGDP-412).
 * E erro de AMBIENTE e precisa ser visivel, nunca fila vazia (MIG-3).
 */
export function ehTabelaAusente(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const o = e as { code?: unknown; cause?: unknown };
    if (o.code === '42P01' || o.code === '42703') return true;
    e = o.cause;
  }
  return false;
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

/** Default da idade maxima do espelho de recebimentos (n8n, 2x/hora) — gate 3 do Principio II. */
export const ESPELHO_RECEBIMENTOS_IDADE_MAX_MIN = 120;

/** Limite configuravel (STOCKBRIDGE_ESPELHO_RECEBIMENTOS_MAX_MIN): no UAT o espelho chega pela copia PROD->UAT e envelhece mais. */
export function limiteIdadeEspelhoMin(): number {
  const cfg = getConfig() as { STOCKBRIDGE_ESPELHO_RECEBIMENTOS_MAX_MIN?: number };
  const v = Number(cfg.STOCKBRIDGE_ESPELHO_RECEBIMENTOS_MAX_MIN);
  return Number.isFinite(v) && v > 0 ? v : ESPELHO_RECEBIMENTOS_IDADE_MAX_MIN;
}

/**
 * A fila nacional atende a empresa agora? Q2P: chave da 016 (fonte "fiscal pendente").
 * ACXE: chave da Historia 5, que por sua vez exige a da 016 e o corte proprio — sem tudo
 * isso a ACXE nao tem espelho a vigiar ('desligado' no health, nenhum alerta).
 */
function filaDaEmpresaHabilitada(empresa: EmpresaNacional): boolean {
  return empresa === 'acxe' ? recebimentoNacionalAcxeHabilitado() : recebimentoFiscalHabilitado();
}

export interface IdadeEspelhoRecebimentos {
  /** minutos desde a ultima atualizacao (`synced_at` / `data_atualizacao`); null quando nao ha dado ou o banco falhou */
  idadeMin: number | null;
  status: 'ok' | 'degraded' | 'sem_dados' | 'indisponivel' | 'desligado';
  /** limite usado (min) */
  limiteMin?: number;
}

/** Mesmo formato para a copia de PCs (feature 017, research D13). */
export type IdadeCopiaPcs = IdadeEspelhoRecebimentos;

/**
 * Status do health do modulo: com a flag ligada, espelho de recebimentos ou copia
 * de PCs velhos, vazios ou inacessiveis sao degradacao (ROT-6; D13 da 017).
 */
export function statusHealthModulo(...idades: IdadeEspelhoRecebimentos[]): 'ok' | 'degraded' {
  return idades.some((e) => e.status === 'degraded' || e.status === 'sem_dados' || e.status === 'indisponivel')
    ? 'degraded'
    : 'ok';
}

/**
 * Feature 016 (T051): defasagem do espelho `tbl_recebimentoNFe_<empresa>`. Com a flag
 * desligada a fonte (b) nao e usada e o dado e irrelevante ('desligado'). Usado
 * pelo health do modulo e pela fila (warn), porque a fila degrada em silencio:
 * sync parado = NF "fiscal pendente" sumindo sem erro.
 * Historia 5: por empresa (default 'q2p'). A ACXE e 'desligado' enquanto a fila nao a
 * atende (`recebimentoNacionalAcxeHabilitado`) — senao o espelho vazio de antes do go-live
 * viraria 'sem_dados', health degradado e alerta ao ops por um workflow que ainda nao roda.
 */
/**
 * Batimento do n8n por empresa em `public.tbl_sync_debounce` (chave -> ultima_execucao_inicio), gravado a cada
 * rodada mesmo sem linha nova (contracts/espelhos-n8n.md §2). Na ACXE, com poucas NFs, MAX(synced_at) para de
 * andar sem falha nenhuma do n8n (ele so regrava as linhas que a rodada trouxe; a Q2P tem sempre NF parada na
 * etapa 40): sem o batimento o health degradaria e o ops seria avisado a cada 6 h em periodo calmo. A Q2P segue
 * so com MAX(synced_at), como antes.
 */
const CHAVE_BATIMENTO_ESPELHO_RECEBIMENTOS: Partial<Record<EmpresaNacional, string>> = { acxe: 'receb_acxe' };

/** Idade (min) do batimento do n8n, ou null (sem tabela, sem chave, sem execucao). Nunca lanca. */
async function idadeBatimentoN8nMin(chave: string): Promise<number | null> {
  try {
    const existe = await getPool().query<{ existe: boolean }>(`SELECT to_regclass('public.tbl_sync_debounce') IS NOT NULL AS existe`);
    if (existe.rows[0]?.existe !== true) return null;
    const r = await getPool().query<{ idade_min: string | number | null }>(
      `SELECT (EXTRACT(EPOCH FROM (now() - ultima_execucao_inicio)) / 60)::numeric(12,1) AS idade_min FROM public.tbl_sync_debounce WHERE chave = $1`,
      [chave],
    );
    const v = r.rows[0]?.idade_min;
    const idade = v == null ? NaN : Number(v);
    return Number.isFinite(idade) ? idade : null;
  } catch (err) {
    logger.warn({ err: (err as Error).message, chave }, 'Batimento do n8n indisponível');
    return null;
  }
}

export async function idadeEspelhoRecebimentos(empresa: EmpresaNacional = 'q2p'): Promise<IdadeEspelhoRecebimentos> {
  if (!filaDaEmpresaHabilitada(empresa)) return { idadeMin: null, status: 'desligado' };
  const limiteMin = limiteIdadeEspelhoMin();
  const chaveBatimento = CHAVE_BATIMENTO_ESPELHO_RECEBIMENTOS[empresa];
  const batimento = chaveBatimento ? await idadeBatimentoN8nMin(chaveBatimento) : null;
  try {
    const r = await getPool().query<{ idade_min: string | number | null }>(
      `SELECT (EXTRACT(EPOCH FROM (now() - MAX(synced_at))) / 60)::numeric(12,1) AS idade_min FROM public.${tabelasNacional(empresa).recebimento}`,
    );
    const v = r.rows[0]?.idade_min;
    const pelasLinhas = v == null ? NaN : Number(v);
    // vale o sinal mais recente: a ultima linha regravada ou a ultima rodada do n8n
    const candidatos = [pelasLinhas, batimento ?? NaN].filter((x) => Number.isFinite(x));
    if (candidatos.length === 0) return { idadeMin: null, status: 'sem_dados', limiteMin };
    const idade = Math.min(...candidatos);
    return { idadeMin: idade, status: idade > limiteMin ? 'degraded' : 'ok', limiteMin };
  } catch (err) {
    logger.warn({ err: (err as Error).message, empresa }, 'Idade do espelho de recebimentos indisponível');
    return { idadeMin: null, status: 'indisponivel', limiteMin };
  }
}

/** Default da idade maxima da copia de PCs (n8n Rev 1.5: agenda de 10 min + aviso por evento) — research D13 da 017. */
export const COPIA_PCS_IDADE_MAX_MIN = 120;

/** Limite configuravel (STOCKBRIDGE_COPIA_PCS_MAX_MIN): no UAT a copia chega pela copia PROD->UAT e envelhece mais. */
export function limiteIdadeCopiaPcsMin(): number {
  const cfg = getConfig() as { STOCKBRIDGE_COPIA_PCS_MAX_MIN?: number };
  const v = Number(cfg.STOCKBRIDGE_COPIA_PCS_MAX_MIN);
  return Number.isFinite(v) && v > 0 ? v : COPIA_PCS_IDADE_MAX_MIN;
}

/**
 * Feature 017 (ACXEGDP-437, research D13, FR-030): defasagem da copia de PCs
 * `tbl_pedidosCompras_<empresa>`. Com a 017 ela decide a sugestao de PC, o bloqueio de
 * NF sem PC e o aviso a compras — tabela critica do Principio II ("monitoramento
 * DEVE alertar se a tabela critica ficar defasada"). A Rev 1.5 do n8n grava o
 * inicio do sync em `data_atualizacao` de todas as linhas (troca atomica), entao
 * a idade e now() − MAX(data_atualizacao). Mesmo padrao do espelho de
 * recebimentos: 'desligado' com a chave da 016 desligada, porque so com o fiscal
 * pelo Atlas a copia decide alguma coisa. Historia 5: por empresa (default 'q2p'); o
 * mesmo workflow do n8n grava a copia das duas.
 */
export async function idadeCopiaPcs(empresa: EmpresaNacional = 'q2p'): Promise<IdadeCopiaPcs> {
  if (!filaDaEmpresaHabilitada(empresa)) return { idadeMin: null, status: 'desligado' };
  const limiteMin = limiteIdadeCopiaPcsMin();
  try {
    const r = await getPool().query<{ idade_min: string | number | null }>(
      `SELECT (EXTRACT(EPOCH FROM (now() - MAX(data_atualizacao))) / 60)::numeric(12,1) AS idade_min FROM public.${tabelasNacional(empresa).pedidosCompras}`,
    );
    const v = r.rows[0]?.idade_min;
    if (v == null) return { idadeMin: null, status: 'sem_dados', limiteMin };
    const idade = Number(v);
    if (!Number.isFinite(idade)) return { idadeMin: null, status: 'sem_dados', limiteMin };
    return { idadeMin: idade, status: idade > limiteMin ? 'degraded' : 'ok', limiteMin };
  } catch (err) {
    logger.warn({ err: (err as Error).message, empresa }, 'Idade da cópia de pedidos de compra indisponível');
    return { idadeMin: null, status: 'indisponivel', limiteMin };
  }
}

/**
 * Modo seguro da 017 (D13): copia de PCs velha, vazia ou inacessivel nao decide
 * nada — sem sugestao, sem NF_SEM_PC e sem aviso a compras; o POST com fiscal
 * pendente responde 503 COPIA_PCS_DEFASADA. False com a chave da 016 desligada.
 */
export async function copiaPcsDefasada(empresa: EmpresaNacional = 'q2p'): Promise<boolean> {
  return statusHealthModulo(await idadeCopiaPcs(empresa)) === 'degraded';
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
  /** quando o Atlas concluiu o fiscal (ledger) — null se foi no OMIE/portal, flag desligada ou fiscal revertido no OMIE (D21) */
  fiscalConcluidoPeloAtlasEm: string | null;
  /** feature 017: empresa da NF — a ACXE so aparece com a Historia 5 habilitada */
  empresa: EmpresaNacional;
  /** feature 017: selo do PC — pior caso entre os itens a receber; 'nao_aplicavel' com fiscal ja feito ou chave da 016 desligada */
  pcSituacao: PcSituacaoNf;
  /** feature 017 (D7, FR-021a): o fiscal foi concluido fora do Atlas com movimento de estoque — recebimento bloqueado */
  estoqueLancadoPeloOmie: boolean;
  /**
   * feature 017 (D21): o recebimento fiscal foi concluido e depois DESFEITO no portal do OMIE. Implica
   * fiscal === 'pendente' (o clique conclui o fiscal de novo); sempre false com a D21 desligada
   * (chave da 016, kill switch STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED ou migration 0060 ausente).
   */
  fiscalRevertido: boolean;
}

/**
 * 409 ESTOQUE_JA_LANCADO_PELO_OMIE (feature 017, research D7, FR-021a): o recebimento
 * fiscal foi concluido fora do Atlas COM movimento de estoque no OMIE (item recebido,
 * nao ignorado e sem "nao movimentar estoque"). Receber pelo Atlas lancaria o estoque
 * em dobro. Vale com a chave da 016 desligada (contencao).
 */
export class EstoqueJaLancadoPeloOmieError extends Error {
  constructor(public readonly notaFiscal: string, public readonly fornecedorNome: string | null) {
    const f = fornecedorNome && fornecedorNome.trim() ? ` (${fornecedorNome.trim()})` : '';
    super(
      `O estoque da NF ${notaFiscal}${f} já entrou pelo OMIE no recebimento fiscal. ` +
        'Para não lançar em dobro, o recebimento físico foi bloqueado. Fale com o fiscal.',
    );
    this.name = 'EstoqueJaLancadoPeloOmieError';
  }
}

// ── Fonte unificada (feature 016) ──────────────────────────────────────────────
// Ambas as fontes saem com o MESMO shape de linha, para que agregacao por
// descricao, conversao de unidade, checagem "ja recebida", sugestao de
// correlacao e UI continuem iguais (plan.md, Structure Decision):
//   c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi, n_id_receb,
//   fiscal_pendente, cancelada, deletada, n_cod_item, x_prod, cfop, q_com, u_com, valor_item,
//   n_seq (sequencia do item no recebimento de NF-e — identidade estavel, ACXEGDP-412),
//   e, desde a 017: preco_comercial, fornecedor_codigo, n_id_pedido, n_id_it_pedido,
//   n_num_ped_compra, c_associar_existente, c_ignorar_item, c_nao_gerar_mov_estoque,
//   receb_recebido (c_recebido do recebimento — deteccao de estoque ja lancado, D7)
//   e q_com_xml/u_com_xml: quantidade e unidade do XML (espelho de recebimentos). Na fonte (a)
//   a nota de entrada do OMIE traz a quantidade RECEBIDA, que o fiscal pode editar no portal
//   (NF 67988, 23/10/2026: 13.382 kg no XML, 13.500 kg na nota de entrada); a pendencia por
//   restante olha as duas: e a menor distancia, para cima, ate uma que o atribuido pelo Atlas
//   ainda nao atingiu (tolerancia de 1 kg; RESTANTE_PENDENCIA_SQL, D19 da 017). Na fonte (b)
//   as duas sao a do XML.

const LEDGER_FISCAL_CONCLUIDO_SQL = (chaveExpr: string): string =>
  `EXISTS (SELECT 1 FROM stockbridge.recebimento_fiscal rf
            WHERE rf.nf_chave_acesso = ${chaveExpr} AND rf.status IN ('concluido', 'ja_concluido'))`;

/**
 * D21: o ledger tem o fiscal concluido E ele ainda vale (o sinal de reversao `revertidoSql` e falso). Fragmento
 * IRMAO de LEDGER_FISCAL_CONCLUIDO_SQL, usado so com a D21 ligada — o texto da constante esta nos goldens `*-desligado`
 * e nao pode mudar. Antes de o ledger ser marcado 'revertido' (leitura ao vivo do clique, varredura do cron) a linha
 * ainda diz 'concluido': e o sinal que a desconsidera.
 */
const ledgerFiscalVigenteSql = (chaveExpr: string, revertidoSql: string): string =>
  `(${LEDGER_FISCAL_CONCLUIDO_SQL(chaveExpr)} AND NOT ${revertidoSql})`;

/**
 * Sequencia, no recebimento de NF-e, do item `i` da NF `h` (fonte a) — ACXEGDP-412.
 *
 * A fonte (b) traz `n_sequencia` direto. Na (a), o item so se liga ao recebimento
 * depois que o fiscal e concluido: e ai que o OMIE cria a NF, e o `n_id_item` do
 * recebimento passa a ser o `n_cod_item` da NF (5.072 de 5.072 itens em PROD,
 * 07/10/2026; antes da conclusao ele e 0). Ligacao exata por esse id.
 *
 * Janela: o espelho de NF (:08/:38) pode trazer a NF antes de o de recebimentos
 * (:23/:53) refletir a conclusao — o recebimento ainda esta la, mas sem nenhum
 * `n_id_item`. So nesse caso vale a ORDEM do item na NF (posicao por
 * `n_cod_item`), que bateu com a sequencia em todos os itens desde o go-live (as
 * 9 excecoes medidas sao devolucoes de 2023). Recebimento ausente do espelho =
 * NULL (casa so por descricao, como na 015).
 * Historia 5: as tabelas sao as da empresa (a Q2P por padrao — o texto de antes).
 */
function sequenciaItemNfSql(h: string, i: string, empresa: EmpresaNacional = 'q2p'): string {
  const t = tabelasNacional(empresa);
  return `(SELECT COALESCE(
                  MAX(ri.n_sequencia) FILTER (WHERE ri.n_id_item = ${i}.n_cod_item),
                  CASE WHEN COUNT(*) > 0 AND COUNT(*) FILTER (WHERE COALESCE(ri.n_id_item, 0) <> 0) = 0
                       THEN (SELECT COUNT(*)::int FROM public.${t.nfItens} i2
                              WHERE i2.n_id_nf = ${i}.n_id_nf AND i2.n_cod_item <= ${i}.n_cod_item)
                  END)
             FROM public.${t.recebimento} r
             JOIN public.${t.recebimentoItens} ri ON ri.n_id_receb = r.n_id_receb
            WHERE r.c_chave_nfe = ${h}.c_chave_nfe)`;
}

/** Uma empresa na consulta da fila: o espelho dela e o placeholder do corte de emissao. */
interface FonteEmpresa {
  empresa: EmpresaNacional;
  /** a coluna `cancelada` existe no espelho de NF dessa empresa (some depois de um sync PROD->UAT) */
  canceladaExiste: boolean;
  /** placeholder do corte de emissao dessa empresa (`$2`, `$5`…): o da Q2P e o da ACXE sao parametros separados */
  corteParam: string;
}

/**
 * A query leva as colunas `empresa`, `produto_omie` e `local_omie` nas linhas? So deixa de levar no caso
 * "Q2P sozinha" — o SQL de antes da Historia 5, byte a byte (varias suites comparam o texto).
 * Qualquer consulta que inclua a ACXE as leva, tambem a que filtra so a ACXE.
 */
const comEmpresaNasLinhas = (fontes: FonteEmpresa[]): boolean => !(fontes.length === 1 && fontes[0]!.empresa === 'q2p');

/** Nome da tabela sem aspas (para o information_schema): `"tbl_nf_header_ACXE"` -> `tbl_nf_header_ACXE`. */
const nomeSemAspas = (tabela: string): string => tabela.replace(/"/g, '');

/** Vinculo com o PC (0056): `n_id_pedido` 0/nulo = sem vinculo; `n_id_it_pedido` so vale com pedido (NF 7736). */
const VINCULO_PC_COLUNAS = (ri: string): string => `
               CASE WHEN COALESCE(${ri}.n_id_pedido, 0) > 0 THEN ${ri}.n_id_pedido END    AS n_id_pedido,
               CASE WHEN COALESCE(${ri}.n_id_pedido, 0) > 0 THEN ${ri}.n_id_it_pedido END AS n_id_it_pedido,
               NULLIF(btrim(${ri}.n_num_ped_compra), '')                                  AS n_num_ped_compra,
               ${ri}.c_associar_existente, ${ri}.c_ignorar_item, ${ri}.c_nao_gerar_mov_estoque`;

/**
 * Fonte (a): espelho de NF — fiscal ja concluido no OMIE. `nfValida` so se aplica a fila (o detalhe le as flags).
 * Feature 017: le SEMPRE o espelho de recebimentos (sequencia + vinculo com o PC +
 * flags de estoque do item), inclusive com a chave da 016 desligada (FR-021/021a).
 * Recebimento ausente do espelho = colunas NULL (casa so por descricao, sem vinculo).
 * Historia 5: o espelho e o da empresa; `comEmpresa` acrescenta `empresa`, `produto_omie` (o
 * produto que o OMIE associou ao item da NF) e `local_omie` (o local de estoque do item) — na
 * MESMA posicao nas duas fontes, para o UNION ALL. O local do item e o padrao do cadastro do
 * produto no OMIE, nao a intencao da compra: a pre-selecao do local vem do item do PC, e esta
 * coluna so fica exposta na CTE (o detalhe nao a usa).
 * D21: com `comRevertido` a NF cujo fiscal foi desfeito no OMIE SAI desta fonte (a nota de entrada nunca e
 * apagada do espelho, tem so parte das linhas do recebimento e nao traz o fornecedor): a fonte (b) a assume. A
 * coluna `fiscal_revertido` e a ULTIMA, sempre false aqui. Sem `comRevertido` o texto e o de antes, byte a byte.
 */
function fonteNfSql(f: FonteEmpresa, nfValida: string, comEmpresa = false, comRevertido = false): string {
  const t = tabelasNacional(f.empresa);
  const extras = comEmpresa
    ? `,
                 '${f.empresa}'::text                                  AS empresa,
                 NULLIF(i.n_cod_prod, 0)::bigint                      AS produto_omie,
                 NULLIF(i.codigo_local_estoque, 0)::bigint            AS local_omie`
    : '';
  // sufixos que valem '' sem a D21: colados em ${nfValida} / u_com_xml, nunca em linha propria (uma linha em branco quebra o golden)
  const revertidaFora = comRevertido ? `${nfValida ? ' ' : ''}AND NOT ${fiscalRevertidoSql('h.c_chave_nfe', f.empresa)}` : '';
  const colunaRevertido = comRevertido
    ? `,
               false                                                AS fiscal_revertido`
    : '';
  return `
        SELECT a.*,${VINCULO_PC_COLUNAS('rv')},
               rv.c_recebido                                        AS receb_recebido,
               rv.n_qtde_nfe                                        AS q_com_xml,  -- a nota de entrada traz a quantidade RECEBIDA
               rv.c_unidade_nfe                                     AS u_com_xml${colunaRevertido}
        FROM (
          SELECT h.c_chave_nfe, h.n_nf, h.dest_razao, h.dest_cnpj_cpf, h.d_emi::date AS d_emi,
                 h.n_id_receb::bigint                                 AS n_id_receb,
                 false                                                AS fiscal_pendente,
                 ${f.canceladaExiste ? 'COALESCE(h.cancelada, false)' : 'false'} AS cancelada,
                 COALESCE(h.deletada, false)                          AS deletada,
                 i.n_cod_item::bigint                                 AS n_cod_item,  -- ordem NUMERICA dos itens (FILA-6)
                 i.x_prod, i.cfop, i.q_com, i.u_com,
                 i.v_prod                                             AS valor_item,  -- D26: NAO v_tot_item (IPI em dobro)
                 ${sequenciaItemNfSql('h', 'i', f.empresa)}                      AS n_seq,
                 i.v_un_com                                           AS preco_comercial,  -- 017: preco SEM tributos (D3)
                 NULL::bigint                                         AS fornecedor_codigo${extras}
          FROM public.${t.nfHeader} h
          JOIN public.${t.nfItens} i ON i.n_id_nf = h.n_id_nf
          WHERE h.tp_nf = 0
            AND h.d_emi >= ${f.corteParam}::date
            ${nfValida}${revertidaFora}
        ) a
        LEFT JOIN LATERAL (
          SELECT ri.*, r.c_recebido
            FROM public.${t.recebimento} r
            JOIN public.${t.recebimentoItens} ri ON ri.n_id_receb = r.n_id_receb
           WHERE r.c_chave_nfe = a.c_chave_nfe AND ri.n_sequencia = a.n_seq
           LIMIT 1
        ) rv ON true`;
}

/**
 * Fonte (b): espelho de recebimentos — fiscal PENDENTE.
 * Precedencia da fonte (a): chave que ja existe no espelho de NF nao entra por
 * aqui (D8, FR-005). Entram:
 *  - recebimentos com fiscal pendente ELEGIVEL: `c_recebido = 'N'`, `c_cancelada = 'N'`
 *    e `c_etapa = '40'` explicitos (contrato §4; nulo nao conta — FILA-7; e a receita
 *    so foi validada a partir da etapa 40 — FISC-5);
 *  - recebimentos que o ATLAS concluiu (ledger `concluido`/`ja_concluido`) e que o
 *    espelho de NF ainda nao trouxe: sem isso a NF sumia da fila e do detalhe na
 *    janela entre o sync de recebimentos (:23/:53) e o de NF (:08/:38) — FR-013,
 *    revisao pre-UAT (FILA-1). Saem como "fiscal ja feito" pelo ledger.
 * Historia 5: os espelhos sao os da empresa; `comEmpresa` acrescenta `empresa`, `produto_omie`
 * (o produto do item no recebimento, `n_id_produto`) e `local_omie` depois de `fornecedor_codigo`.
 * D21: com `comRevertido` a NF cujo fiscal foi desfeito no OMIE (sinal `rev`) (1) passa por cima da precedencia da
 * fonte (a), (2) e elegivel mesmo que a linha do espelho ainda diga 'S'/etapa 60 (o marcador da leitura ao vivo pode chegar
 * antes do sync de recebimentos), (3) sai com fiscal_pendente = true mesmo com o ledger 'concluido' (a linha so vira
 * 'revertido' na leitura ao vivo do clique ou na varredura do cron) e (4) leva `fiscal_revertido` como ULTIMA coluna.
 * Sem `comRevertido` o texto e o de antes, byte a byte.
 */
function fonteRecebSql(f: FonteEmpresa, comEmpresa = false, comRevertido = false): string {
  const t = tabelasNacional(f.empresa);
  const extras = comEmpresa
    ? `,
               '${f.empresa}'::text                                 AS empresa,
               NULLIF(ri.n_id_produto, 0)::bigint                   AS produto_omie,
               NULLIF(ri.codigo_local_estoque, 0)::bigint           AS local_omie`
    : '';
  const rev = comRevertido ? fiscalRevertidoSql('r.c_chave_nfe', f.empresa) : null;
  const fiscalPendente = rev ? `NOT ${ledgerFiscalVigenteSql('r.c_chave_nfe', rev)}` : `NOT ${LEDGER_FISCAL_CONCLUIDO_SQL('r.c_chave_nfe')}`;
  const semHeader = `NOT EXISTS (SELECT 1 FROM public.${t.nfHeader} h2 WHERE h2.c_chave_nfe = r.c_chave_nfe)`;
  const precedencia = rev ? `(${semHeader} OR ${rev})` : semHeader;
  const elegivelPorRevertido = rev ? `\n             OR (${rev})` : '';
  const colunaRevertido = rev
    ? `,
               ${rev}  AS fiscal_revertido`
    : '';
  return `
        SELECT r.c_chave_nfe, r.c_numero_nfe AS n_nf, r.c_razao_social AS dest_razao, r.c_cnpj_cpf AS dest_cnpj_cpf,
               r.d_emissao                                          AS d_emi,
               r.n_id_receb::bigint                                 AS n_id_receb,
               ${fiscalPendente}  AS fiscal_pendente,
               COALESCE(r.c_cancelada = 'S', false)                 AS cancelada,  -- nulo no ramo do ledger nao pode sumir com a NF
               false                                                AS deletada,
               ri.n_sequencia::bigint                               AS n_cod_item,
               ri.c_descricao_produto                               AS x_prod,
               ri.c_cfop_entrada                                    AS cfop,       -- CFOP de ENTRADA (o c_cfop e o do fornecedor)
               ri.n_qtde_nfe                                        AS q_com,
               ri.c_unidade_nfe                                     AS u_com,
               ri.v_total_item                                      AS valor_item,  -- = v_prod (research D7 da 016)
               ri.n_sequencia::int                                  AS n_seq,
               ri.n_preco_unit                                      AS preco_comercial,  -- 017: preco SEM tributos (D3)
               NULLIF(r.n_id_fornecedor, 0)                         AS fornecedor_codigo${extras},${VINCULO_PC_COLUNAS('ri')},
               r.c_recebido                                         AS receb_recebido,
               ri.n_qtde_nfe                                        AS q_com_xml,
               ri.c_unidade_nfe                                     AS u_com_xml${colunaRevertido}
        FROM public.${t.recebimento} r
        JOIN public.${t.recebimentoItens} ri ON ri.n_id_receb = r.n_id_receb
        WHERE r.d_emissao >= ${f.corteParam}::date
          AND ${precedencia}
          AND (
                (r.c_recebido = 'N' AND r.c_cancelada = 'N' AND r.c_etapa = '40'
                 AND COALESCE(r.c_bloqueado, 'N') <> 'S' AND COALESCE(r.c_devolvido, 'N') <> 'S')
             OR ${LEDGER_FISCAL_CONCLUIDO_SQL('r.c_chave_nfe')}${elegivelPorRevertido}
          )`;
}

/**
 * CTE `nf_unificada`: fonte (a) sozinha com a flag desligada; (a) UNION ALL (b)
 * com a flag ligada. Com a flag desligada a query e a da 015, com UMA diferenca
 * deliberada: a via 2 da checagem "ja recebida" exige lancamento manual a partir
 * da emissao (colisao de numero entre fornecedores) — so faz NF reaparecer, nunca
 * sumir; paridade conferida no UAT na revisao pre-UAT.
 * Historia 5: o bloco (a) [+ (b)] se repete por empresa, num UNION ALL. `aplicarNfValida`
 * liga o filtro cancelada/deletada (a fila; o detalhe le as flags).
 * D21: `comRevertido` (so existe com `flag`) acrescenta o sinal de fiscal revertido nos dois blocos de cada empresa
 * e a coluna `fiscal_revertido`; o sinal le o espelho da PROPRIA empresa do bloco e nao contem UNION ALL.
 */
function nfUnificadaSql(fontes: FonteEmpresa[], flag: boolean, aplicarNfValida: boolean, comRevertido = false): string {
  const comEmpresa = comEmpresaNasLinhas(fontes);
  const rev = flag && comRevertido;
  const blocos = fontes.flatMap((f) => {
    const a = fonteNfSql(f, aplicarNfValida ? nfValidaSql(f.canceladaExiste, 'h') : '', comEmpresa, rev);
    return flag ? [a, fonteRecebSql(f, comEmpresa, rev)] : [a];
  });
  return blocos.join(`
        UNION ALL
        `);
}

/** Movimentacao `m` (caminho novo) do item da linha `u` — por descricao ou pela sequencia (ACXEGDP-412). */
function movimentacaoDoItemSql(m: string, alias = 'u'): string {
  return movimentacaoDoItemNacionalSql({
    alias: m,
    chaveExpr: `${alias}.c_chave_nfe`,
    descricaoNormalizadaExpr: normalizarDescricaoSql(`${alias}.x_prod`),
    sequenciaExpr: `${alias}.n_seq`,
  });
}

/**
 * Fragmento SQL "item ja recebido" para a linha `u` da fonte unificada. `comEmpresa`: a linha
 * carrega a empresa e a via 2 (historico manual, so pelo numero da NF) casa a mesma empresa.
 */
function recebidoSql(alias = 'u', comEmpresa = false): string {
  return itemNacionalRecebidoSql({
    chaveExpr: `${alias}.c_chave_nfe`,
    descricaoNormalizadaExpr: normalizarDescricaoSql(`${alias}.x_prod`),
    nfNumeroExpr: `${alias}.n_nf`,
    dataEmissaoExpr: `${alias}.d_emi`,
    sequenciaExpr: `${alias}.n_seq`,
    ...(comEmpresa ? { empresaExpr: `${alias}.empresa` } : {}),
  });
}

/**
 * Fornecedor sem exclusao ativa. Historia 5: a exclusao vale so para a fila da empresa dela
 * (a Q2P e contraparte intercompany da ACXE e a ACXE da Q2P — a mesma exclusao nao pode
 * esconder a NF da outra empresa; o CNPJ do fornecedor se repete nas duas). Sem a empresa
 * na linha a consulta e so da Q2P (comEmpresaNasLinhas), entao a exclusao filtrada e a da
 * Q2P: sem isso, um CNPJ excluido so na ACXE sumiria tambem da fila da Q2P (exige a 0058).
 */
function fornecedorNaoExcluidoSql(alias = 'u', comEmpresa = false): string {
  return `NOT EXISTS (
        SELECT 1 FROM stockbridge.fornecedor_exclusao fe
         WHERE fe.reincluido_em IS NULL AND fe.fornecedor_cnpj = ${alias}.dest_cnpj_cpf AND fe.empresa = ${comEmpresa ? `${alias}.empresa` : `'q2p'`})`;
}

/**
 * Dispensa ATIVA pelo gestor (feature 016, FR-021): a NF some das duas fontes ate a
 * reversao — com a chave da 016 em QUALQUER posicao (revisao de 22/10/2026, achado
 * fila-v01: com a chave desligada, a contencao da 017, as NFs dispensadas voltavam a
 * fila e podiam ser recebidas em dobro). Criar/reverter dispensa continua exigindo a chave.
 */
function naoDispensadaSql(alias = 'u'): string {
  return `NOT EXISTS (
        SELECT 1 FROM stockbridge.nf_dispensa d
         WHERE d.nf_chave_acesso = ${alias}.c_chave_nfe AND d.revertido_em IS NULL)`;
}

// Espelho SQL da tabela FATOR_UNIDADE_NF (unidade-nf.ts) — SO para a pendencia por
// restante na query da fila (FR-030). Unidade fora da tabela -> NULL -> o item
// segue a regra simples (recebido/nao recebido); a conferencia de coerencia e
// o bloqueio continuam sendo feitos em TS, no detalhe.
const fatorKgSql = (alias = 'u', coluna = 'u_com'): string =>
  `CASE upper(btrim(${alias}.${coluna})) WHEN 'KG' THEN 1 WHEN 'TON' THEN 1000 WHEN 'TL' THEN 1000 END`;

/**
 * Faixa em que o XML e comparavel com a nota de entrada (razao XML / nota de entrada): edicao da
 * quantidade recebida no portal muda alguns por cento; fora da faixa e leitura de unidade trocada (XML em
 * toneladas rotulado KG, research D24 da 015) e o XML nao entra (D19, revisao de 23/10/2026).
 */
export const RAZAO_XML_MIN = 0.5;
export const RAZAO_XML_MAX = 2;

/**
 * kg da linha pela via do XML (D19 da 017): o XML quando esta na faixa comparavel (RAZAO_XML_MIN..MAX da
 * nota de entrada); senao a propria nota de entrada. Sem o XML no espelho, a nota de entrada. Nota de
 * entrada fora da tabela de unidades: NULL, como antes. Mesma regra de kgXmlComparavel, no detalhe.
 */
function nfKgXmlSql(alias = 'u'): string {
  const entrada = `(${alias}.q_com * ${fatorKgSql(alias)})`;
  const xml = `(${alias}.q_com_xml * ${fatorKgSql(alias, 'u_com_xml')})`;
  return `CASE WHEN ${xml} BETWEEN ${entrada} * ${RAZAO_XML_MIN} AND ${entrada} * ${RAZAO_XML_MAX} THEN ${xml} ELSE ${entrada} END`;
}

/**
 * Restante do item (FR-030 da 015, D19 da 017), sobre as colunas agregadas `nf_kg` (nota de entrada), `nf_kg_xml`
 * (via do XML) e `nf_atribuida`: a menor distancia, para cima, ate uma das duas quantidades oficiais que o
 * atribuido ainda nao atingiu (tolerancia de 1 kg); 0 quando ja atingiu alguma. O item recebido pela NF do XML
 * nao reabre quando a nota de entrada e editada para mais (NF 67988), e a gravacao parcial ancorada na nota de
 * entrada continua visivel quando ela e maior que o XML (revisao de 23/10/2026). Sem XML as duas sao iguais e a
 * regra e a de antes. Mesma regra de restantePendenciaKg, no detalhe.
 */
const RESTANTE_PENDENCIA_SQL = `GREATEST(0, LEAST(
                  CASE WHEN nf_kg >= nf_atribuida - 1 THEN nf_kg - nf_atribuida END,
                  CASE WHEN nf_kg_xml >= nf_atribuida - 1 THEN nf_kg_xml - nf_atribuida END))`;

/** Σ quantidade_nf_kg ja gravada (caminho novo) para a linha `u` — lado da NF. */
function nfJaAtribuidaSql(alias = 'u'): string {
  return `(SELECT COALESCE(SUM(m.quantidade_nf_kg), 0) FROM stockbridge.movimentacao m
            WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
              AND ${movimentacaoDoItemSql('m', alias)})`;
}

/** Existe solicitacao de baixa externa PENDENTE para a linha `u`. */
function baixaSolicitadaSql(alias = 'u'): string {
  return `EXISTS (SELECT 1 FROM stockbridge.aprovacao a
            WHERE a.tipo_aprovacao = 'recebimento_externo' AND a.status = 'pendente'
              AND a.nf_chave_acesso = ${alias}.c_chave_nfe
              AND ${normalizarDescricaoSql('a.nf_item_descricao')} = ${normalizarDescricaoSql(`${alias}.x_prod`)})`;
}

/** Intervalo minimo entre dois avisos de "ACXE fora da fila por tabela ausente" no log. */
const AVISO_ACXE_AUSENTE_MIN_MS = 10 * 60 * 1000;
let ultimoAvisoAcxeAusenteMs = 0;

/**
 * Historia 5: a consulta que inclui a ACXE falhou por tabela (42P01) ou coluna (42703) ausente
 * — espelho da ACXE ainda nao criado pelo n8n ou migration 0058 pendente — e a repeticao so com
 * a Q2P deu certo: as NFs da ACXE ficam fora da fila e a Q2P segue normal. O `err` diz o que
 * falta; o health da ACXE mostra 'indisponivel' (espelho/copia sem tabela) e o cron alerta o ops.
 */
function avisarAcxeForaDaFila(err: unknown, onde: string): void {
  const agora = Date.now();
  if (agora - ultimoAvisoAcxeAusenteMs < AVISO_ACXE_AUSENTE_MIN_MS) return;
  ultimoAvisoAcxeAusenteMs = agora;
  logger.error(
    { err: (err as Error).message, onde },
    'Consulta da ACXE falhou (espelho da ACXE ou migration 0058 ausente, corte da ACXE invalido ou outro erro) — NFs da ACXE fora da fila nacional; a fila da Q2P segue normal',
  );
}

/**
 * Quando o Atlas concluiu o fiscal da NF (ledger), para a coluna `fiscal_concluido_em` da fila. So 'concluido':
 * 'ja_concluido' e fiscal feito no portal. D21: NF com o fiscal revertido no OMIE nao tem "conclusao do Atlas" a
 * mostrar, mesmo com a linha do ledger ainda 'concluido' (ela so vira 'revertido' no clique ou na varredura do cron).
 */
const ultimaConclusaoDoAtlasSql = (comRevertido: boolean): string => {
  const ultima = `(SELECT MAX(rf.finalizado_em) FROM stockbridge.recebimento_fiscal rf
            WHERE rf.nf_chave_acesso = c_chave_nfe AND rf.status = 'concluido')::text`;
  return comRevertido ? `CASE WHEN bool_or(fiscal_revertido) THEN NULL::text ELSE ${ultima} END` : ultima;
};

/**
 * Fila de NFs nacionais pendentes. Degrada para lista vazia em falha de BANCO
 * (a fila e informativa, o manual continua) — mas NAO em falta de configuracao,
 * que e erro de ambiente e precisa ser visivel.
 * Historia 5 (ACXEGDP-437): a fila traz as empresas ativas (a Q2P sempre; a ACXE so com
 * `recebimentoNacionalAcxeHabilitado()`), ordenadas por emissao e numero; `empresa` restringe a
 * uma delas — `q2p` gera exatamente a query da Q2P de sempre. Tabela espelho da ACXE ausente
 * tira so a ACXE da consulta (log + health), nunca derruba a Q2P.
 */
export async function getFilaNacional(
  params: { q?: string | null; fornecedor?: string | null; empresa?: EmpresaNacional | null } = {},
): Promise<FilaNacionalItem[]> {
  const dataCorte = getDataCorteFilaNacional();
  const flag = recebimentoFiscalHabilitado();
  const pool = getPool();
  const descNorm = normalizarDescricaoSql('u.x_prod');

  const ativas = empresasNacionalAtivas();
  const alvo = params.empresa ? ativas.filter((e) => e === params.empresa) : ativas;
  if (alvo.length === 0) return [];

  // D21: fiscal revertido no OMIE (chave da 016 + kill switch + migration 0060). Depois da data de corte e do
  // atalho da empresa desligada: nada disto consulta o banco quando a fila nem sobe.
  const comRevertido = flag && (await fiscalRevertidoHabilitado());

  // Com a flag ligada, a NF concluida pelo Atlas sai como "fiscal ja feito" com a
  // data do ledger; desligada, a coluna e constante (comportamento da 015).
  const fiscalConcluidoEmSql = flag
    ? // so 'concluido': 'ja_concluido' significa fiscal feito no portal, nao pelo Atlas (SPEC016-8)
      ultimaConclusaoDoAtlasSql(comRevertido)
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
    estoque_lancado: boolean | null;
    /** so com a D21 ligada: o fiscal desta NF foi desfeito no OMIE depois de concluido */
    fiscal_revertido?: boolean | null;
    /** so quando a consulta inclui a ACXE; ausente = Q2P */
    empresa?: EmpresaNacional;
  }

  // `cancelada` existe no espelho de NF da empresa? (consulta barata ao information_schema; uma vez por chamada)
  const canceladaPorEmpresa = new Map<EmpresaNacional, boolean>();
  const canceladaExiste = async (e: EmpresaNacional): Promise<boolean> => {
    if (!canceladaPorEmpresa.has(e)) {
      canceladaPorEmpresa.set(e, await colunaCanceladaExiste(pool, nomeSemAspas(tabelasNacional(e).nfHeader)));
    }
    return canceladaPorEmpresa.get(e)!;
  };

  const consultar = async (empresas: EmpresaNacional[]) => {
    // $1 CFOPs; $2 corte da Q2P; filtros; corte da ACXE por ultimo — a numeracao da Q2P sozinha e a de sempre
    const args: unknown[] = [Array.from(CFOPS_RECEBIMENTO_NACIONAL)];
    const param = (v: unknown): string => {
      args.push(v);
      return `$${args.length}`;
    };
    const corteQ2p = empresas.includes('q2p') ? param(dataCorte) : '';
    let filtros = '';
    if (params.fornecedor && params.fornecedor.trim()) {
      const p = param(`%${params.fornecedor.trim()}%`);
      filtros += `\n        AND (u.dest_cnpj_cpf ILIKE ${p} OR u.dest_razao ILIKE ${p})`;
    }
    if (params.q && params.q.trim()) {
      const p = param(`%${params.q.trim()}%`);
      filtros += `\n        AND (ltrim(u.n_nf, '0') ILIKE ${p} OR u.dest_razao ILIKE ${p})`;
    }
    const corteAcxe = empresas.includes('acxe') ? param(dataCorteAcxe()) : '';
    const fontes: FonteEmpresa[] = [];
    for (const e of empresas) {
      fontes.push({ empresa: e, canceladaExiste: await canceladaExiste(e), corteParam: e === 'q2p' ? corteQ2p : corteAcxe });
    }
    const emp = comEmpresaNasLinhas(fontes);

    const res = await pool.query<Row>(
      `
      WITH nf_unificada AS (${nfUnificadaSql(fontes, flag, true, comRevertido)}
      ),
      linhas AS (
        SELECT
          u.c_chave_nfe, u.n_nf, u.dest_razao, u.dest_cnpj_cpf, u.d_emi, u.fiscal_pendente${comRevertido ? ', u.fiscal_revertido' : ''}${emp ? ', u.empresa' : ''},
          ${descNorm}                    AS desc_norm,
          u.valor_item                   AS valor_item,
          ${recebidoSql('u', emp)}            AS recebido,
          -- FR-030 (research D25): pendencia por RESTANTE do lado da NF. Item com
          -- 1 de N produtos gravado (falha/retomada) continua na fila; legado
          -- (match por numero, sem parcela) NAO cai aqui — nf_atribuida = 0.
          -- Duas quantidades oficiais (D19): a nota de entrada (quantidade RECEBIDA, editavel no portal) e
          -- o XML (so na faixa comparavel; fora dela e unidade trocada e vale a nota de entrada).
          (u.q_com * ${fatorKgSql('u')}) AS nf_kg,
          ${nfKgXmlSql('u')} AS nf_kg_xml,
          ${nfJaAtribuidaSql('u')}       AS nf_atribuida,
          -- 017 (D7): recebimento concluido fora do Atlas COM movimento de estoque no OMIE${comRevertido ? `
          -- D21: fiscal revertido no OMIE nao tem estoque lancado (a linha do espelho pode estar defasada com 'S')` : ''}
          (${comRevertido ? 'NOT u.fiscal_revertido AND ' : ''}u.receb_recebido = 'S' AND u.c_ignorar_item = 'N' AND u.c_nao_gerar_mov_estoque = 'N') AS estoque_lancado
        FROM nf_unificada u
        WHERE u.cfop = ANY($1::text[])
          AND NOT u.cancelada AND NOT u.deletada
          AND ${fornecedorNaoExcluidoSql('u', emp)}
          AND ${naoDispensadaSql('u')}${filtros}
      ),
      itens AS (
        SELECT c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi, desc_norm${emp ? ', empresa' : ''},
               bool_or(fiscal_pendente)                                 AS fiscal_pendente,
               SUM(valor_item)                                          AS valor_item,
               bool_and(recebido)                                       AS recebido,
               SUM(nf_kg)                                               AS nf_kg,
               SUM(nf_kg_xml)                                           AS nf_kg_xml,
               MAX(nf_atribuida)                                        AS nf_atribuida,
               bool_or(estoque_lancado)                                 AS estoque_lancado${comRevertido ? `,
               bool_or(fiscal_revertido)                                AS fiscal_revertido` : ''}
        FROM linhas
        GROUP BY c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi, desc_norm${emp ? ', empresa' : ''}
      ),
      itens_flag AS (
        SELECT *,
               (NOT recebido
                OR (nf_kg IS NOT NULL AND nf_atribuida > 0 AND ${RESTANTE_PENDENCIA_SQL} > 1)) AS pendente
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
        ${fiscalConcluidoEmSql}                                       AS fiscal_concluido_em,
        COALESCE(bool_or(estoque_lancado) FILTER (WHERE pendente), false) AS estoque_lancado${comRevertido ? ',\n        COALESCE(bool_or(fiscal_revertido), false)                    AS fiscal_revertido' : ''}${emp ? ',\n        empresa' : ''}
      FROM itens_flag
      GROUP BY c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi${emp ? ', empresa' : ''}
      HAVING COUNT(*) FILTER (WHERE pendente) > 0
      ORDER BY d_emi ASC, n_nf ASC${emp ? ', empresa ASC' : ''}
      `,
      args,
    );
    return res;
  };

  try {
    let usadas: EmpresaNacional[] = alvo;
    let res: Awaited<ReturnType<typeof consultar>>;
    try {
      res = await consultar(usadas);
    } catch (err) {
      // Historia 5: QUALQUER falha da consulta com a ACXE (espelho ausente, corte invalido, dado inesperado)
      // tira so a ACXE da consulta; a Q2P segue (o proprio erro da Q2P cai no tratamento de baixo, como
      // sempre). Pedido so da ACXE (`empresa=acxe`) nao tem Q2P para confirmar de quem e o defeito: o erro
      // sobe, como o da Q2P sozinha.
      if (usadas.length > 1 && usadas.includes('acxe')) {
        usadas = usadas.filter((e) => e !== 'acxe');
        res = await consultar(usadas);
        avisarAcxeForaDaFila(err, 'fila'); // so depois de a Q2P responder: o defeito era mesmo da ACXE
      } else {
        throw err;
      }
    }
    if (flag) {
      // Sync parado deixa a fonte "fiscal pendente" incompleta sem nenhum erro —
      // o warn e o unico sinal alem do health (T051).
      for (const e of usadas) {
        const idade = await idadeEspelhoRecebimentos(e);
        if (statusHealthModulo(idade) === 'degraded') {
          logger.warn(
            { empresa: e, idadeMin: idade.idadeMin, status: idade.status, limiteMin: idade.limiteMin },
            // D21: o sinal de reversao tambem vem desse espelho — sem ele fresco, so a leitura ao vivo do clique protege
            comRevertido
              ? 'Espelho de recebimentos de NF-e defasado — NFs com fiscal pendente podem estar faltando na fila e reversões do fiscal no OMIE podem não ser percebidas'
              : 'Espelho de recebimentos de NF-e defasado — NFs com fiscal pendente podem estar faltando na fila',
          );
        }
      }
    }
    // 017: selo do PC so para NF com fiscal pendente (e chave ligada) — best-effort.
    const pendentes = flag
      ? res.rows.filter((r) => r.fiscal === 'pendente').map((r) => ({ chave: r.nf_chave_acesso, empresa: r.empresa ?? ('q2p' as const) }))
      : [];
    // D21: a NF revertida com a tentativa antiga ainda 'concluido' e marcada ANTES do selo do PC, como no detalhe — senao o
    // selo sairia "Escolher PC" (o saldo do PC descontaria os vinculos dessa tentativa). Raro e melhor esforco.
    for (const r of res.rows) {
      if (comRevertido && r.fiscal_revertido === true) await marcarTentativaRevertidaSeVigente(r.nf_chave_acesso, r.empresa ?? 'q2p');
    }
    const pcSituacoes = pendentes.length > 0 ? await pcSituacaoPorNf(pendentes, dataCorte, canceladaExiste, comRevertido) : new Map<string, PcSituacaoNf>();
    return res.rows.map((r) => {
      const fiscalRevertido = r.fiscal_revertido === true;
      return {
        nfChaveAcesso: r.nf_chave_acesso,
        notaFiscal: r.nota_fiscal,
        fornecedorNome: r.fornecedor_nome ?? FORNECEDOR_NAO_IDENTIFICADO,
        fornecedorCnpj: r.fornecedor_cnpj ?? '',
        dtEmissao: r.dt_emissao,
        diasDesdeEmissao: Number(r.dias_desde_emissao),
        itensTotal: Number(r.itens_total),
        itensPendentes: Number(r.itens_pendentes),
        valorTotalBrl: r.valor_total_brl != null ? Number(r.valor_total_brl) : 0,
        fiscal: r.fiscal === 'pendente' ? ('pendente' as const) : ('concluido' as const),
        // D21: conclusao revertida no OMIE nao e mais "fiscal ja feito pelo Atlas" (o SQL ja anula; aqui e a garantia)
        fiscalConcluidoPeloAtlasEm: !fiscalRevertido && r.fiscal_concluido_em ? new Date(r.fiscal_concluido_em).toISOString() : null,
        empresa: r.empresa ?? ('q2p' as const),
        pcSituacao: pcSituacoes.get(r.nf_chave_acesso) ?? ('nao_aplicavel' as const),
        estoqueLancadoPeloOmie: r.estoque_lancado === true,
        fiscalRevertido,
      };
    });
  } catch (err) {
    // Tabela ausente (42P01) e erro de AMBIENTE: precisa ser visivel (503), nao
    // uma fila vazia (MIG-3) — ex.: flag ligada antes da migration 0053.
    if (ehTabelaAusente(err)) {
      logger.error({ err: (err as Error).message, flag }, 'Fila nacional referencia tabela inexistente — migration pendente?');
      throw new FilaNacionalIncompletaError();
    }
    // Fila e informativa — falha de banco nao pode derrubar a tela de recebimento
    // (o formulario manual continua). Loga e devolve vazio. Sync parado fica
    // indistinguivel de "nada pendente" so no dado; o log e o sinal.
    logger.warn({ err: (err as Error).message }, 'getFilaNacional falhou — retornando vazio');
    return [];
  }
}

// ── Pedido de compra (feature 017) — linhas -> entrada da sugestao ─────────────

/** Colunas de uma linha da fonte unificada que a sugestao de PC usa. */
interface LinhaPc {
  q_com: number | string;
  /** valor do item COM tributos (v_prod / v_total_item) — segunda base de preco (D3) */
  valor_item: number | string;
  preco_comercial: number | string | null;
  n_seq: number | string | null;
  n_id_pedido: number | string | null;
  n_id_it_pedido: number | string | null;
  n_num_ped_compra: string | null;
}

const numOuNull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Entrada da sugestao para um item agregado. O preco da NF vai em duas bases por
 * kg (research D3, revisto em 22/10/2026): o COMERCIAL (sem tributos), Σ(preco ×
 * qtd) ÷ kg, e o VALOR DO ITEM (com tributos), Σ valor ÷ kg — ha PC lancado com o
 * preco com IPI (PC 306, Zaraplast). A quantidade em kg vem da conversao do
 * proprio item (mesma leitura de unidade do detalhe). Linha sem preco deixa aquela
 * base desconhecida. Vinculo do OMIE = linha com `n_id_pedido` (> 0 ja garantido no SQL).
 */
function entradaSugestaoPc(
  indice: number,
  descricao: string,
  quantidadeKg: number | null,
  linhas: LinhaPc[],
  /** unidade da NF normalizada e seu fator para kg (null sem conversao) — trava de unidade da 017 */
  unidadeNf: string = '',
  fatorUnidadeNf: number | null = null,
): ItemParaSugestao {
  let somaPreco = 0;
  let precoConhecido = true;
  let somaValor = 0;
  let valorConhecido = true;
  for (const l of linhas) {
    const preco = numOuNull(l.preco_comercial);
    if (preco == null) precoConhecido = false;
    else somaPreco += preco * Number(l.q_com);
    const valor = numOuNull(l.valor_item);
    if (valor == null) valorConhecido = false;
    else somaValor += valor;
  }
  const vinculos: VinculoLinhaOmie[] = [];
  const sequencias: number[] = [];
  const kgPorSequencia: Record<number, number> = {};
  // Unidade unica no item (unidades misturadas ja bloqueiam): kg da linha = q_com × (kg do item ÷ Σ q_com).
  const somaQtd = linhas.reduce((acc, l) => acc + Number(l.q_com), 0);
  const kgPorUnidade = quantidadeKg != null && somaQtd > 0 ? quantidadeKg / somaQtd : 0;
  let numeroPedidoNf: string | null = null;
  for (const l of linhas) {
    const seq = numOuNull(l.n_seq);
    if (seq != null && Number.isInteger(seq) && seq > 0) {
      sequencias.push(seq);
      kgPorSequencia[seq] = (kgPorSequencia[seq] ?? 0) + Number(l.q_com) * kgPorUnidade;
    }
    const ped = numOuNull(l.n_id_pedido);
    if (ped != null && ped > 0 && seq != null) vinculos.push({ nSequencia: seq, nIdPedido: ped, nIdItPedido: numOuNull(l.n_id_it_pedido) });
    if (!numeroPedidoNf && l.n_num_ped_compra && l.n_num_ped_compra.trim()) numeroPedidoNf = l.n_num_ped_compra.trim();
  }
  return {
    indice,
    descricao,
    quantidadeKg,
    unidadeNf,
    fatorUnidadeNf,
    precoNfKg: precoConhecido && quantidadeKg != null && quantidadeKg > 0 ? somaPreco / quantidadeKg : null,
    precoItemKg: valorConhecido && quantidadeKg != null && quantidadeKg > 0 ? somaValor / quantidadeKg : null,
    numeroPedidoNf,
    vinculos,
    sequencias: Array.from(new Set(sequencias)).sort((x, y) => x - y),
    kgPorSequencia,
  };
}

/** Conversao do item agregado — a MESMA regra do detalhe (unidades misturadas bloqueiam). */
function conversaoDoGrupo(linhas: Array<{ q_com: number | string; u_com: string | null; valor_item: number | string; x_prod: string }>): ConversaoNf {
  const primeira = linhas[0]!;
  const quantidadeNf = linhas.reduce((acc, l) => acc + Number(l.q_com), 0);
  const valorTotal = linhas.reduce((acc, l) => acc + Number(l.valor_item), 0);
  const unidades = new Set(linhas.map((l) => (l.u_com ?? '').trim().toUpperCase()));
  if (unidades.size > 1) {
    return {
      ok: false,
      motivo: 'unidade_nao_conversivel',
      unidadeOriginal: Array.from(unidades).join('/'),
      mensagem: `Linhas de "${primeira.x_prod.trim()}" vêm em unidades diferentes (${Array.from(unidades).join(', ')}) e não podem ser somadas. Receba pelo formulário manual.`,
    };
  }
  return converterItemNfParaKg(quantidadeNf, (primeira.u_com ?? '').trim().toUpperCase(), valorTotal);
}

/**
 * 017 (T020): `pcSituacao` das NFs com fiscal pendente na fila — pior caso entre
 * os itens a receber, calculado em TS com UMA leitura da copia para todas as NFs.
 * "A receber" = pendente e com unidade convertida (o mesmo recorte da tela e do
 * POST: item bloqueado por unidade nao tem bloco de PC). NF sem fornecedor
 * cadastrado no OMIE: 'nao_aplicavel' (o fiscal pelo Atlas e recusado antes do PC).
 * Copia defasada (D13) ou falha de banco: 'nao_aplicavel' (a fila e informativa;
 * o detalhe mostra o motivo e o POST decide).
 * Historia 5: as NFs se agrupam por empresa — uma leitura da copia de PCs por empresa — e a
 * falha de uma nao tira o selo da outra.
 * D21: `comRevertido` repete na leitura dos itens o MESMO recorte da fila (a NF revertida e servida pela fonte (b),
 * com o fornecedor e o vinculo do OMIE preservados pela reversao).
 */
async function pcSituacaoPorNf(
  nfs: Array<{ chave: string; empresa: EmpresaNacional }>,
  dataCorte: string,
  canceladaExiste: (empresa: EmpresaNacional) => Promise<boolean>,
  comRevertido = false,
): Promise<Map<string, PcSituacaoNf>> {
  const out = new Map<string, PcSituacaoNf>();
  const porEmpresa = new Map<EmpresaNacional, string[]>();
  for (const nf of nfs) {
    const lista = porEmpresa.get(nf.empresa);
    if (lista) lista.push(nf.chave);
    else porEmpresa.set(nf.empresa, [nf.chave]);
  }
  for (const [empresa, chaves] of porEmpresa) {
    try {
      const situacoes = await pcSituacaoPorNfDaEmpresa(empresa, chaves, dataCorte, await canceladaExiste(empresa), comRevertido);
      for (const [chave, situacao] of situacoes) out.set(chave, situacao);
    } catch (err) {
      logger.warn({ err: (err as Error).message, empresa }, 'Situação de PC da fila indisponível — selo omitido');
    }
  }
  return out;
}

async function pcSituacaoPorNfDaEmpresa(
  empresa: EmpresaNacional,
  chaves: string[],
  dataCorte: string,
  canceladaExiste: boolean,
  comRevertido = false,
): Promise<Map<string, PcSituacaoNf>> {
  const out = new Map<string, PcSituacaoNf>();
  if (await copiaPcsDefasada(empresa)) return out;
  const pool = getPool();
  interface LinhaFilaPc extends LinhaPc {
    c_chave_nfe: string;
    x_prod: string;
    desc_norm: string;
    u_com: string | null;
    valor_item: number | string;
    fornecedor_codigo: number | string | null;
    recebido: boolean;
  }
  // $1 CFOPs; $2 corte DESTA empresa (Q2P ou ACXE); $3 as chaves das NFs
  const fonte: FonteEmpresa = { empresa, canceladaExiste, corteParam: '$2' };
  const emp = comEmpresaNasLinhas([fonte]);
  const r = await pool.query<LinhaFilaPc>(
    `WITH nf_unificada AS (${nfUnificadaSql([fonte], true, false, comRevertido)}
       )
       SELECT u.c_chave_nfe, u.x_prod, ${normalizarDescricaoSql('u.x_prod')} AS desc_norm, u.q_com::float8 AS q_com, u.u_com,
              u.valor_item::float8 AS valor_item, u.preco_comercial::float8 AS preco_comercial, u.n_seq,
              u.n_id_pedido::text AS n_id_pedido, u.n_id_it_pedido::text AS n_id_it_pedido, u.n_num_ped_compra,
              u.fornecedor_codigo::text AS fornecedor_codigo, ${recebidoSql('u', emp)} AS recebido
         FROM nf_unificada u
        WHERE u.c_chave_nfe = ANY($3::text[]) AND u.fiscal_pendente AND u.cfop = ANY($1::text[])
          AND NOT u.cancelada AND NOT u.deletada
        ORDER BY u.c_chave_nfe, u.n_cod_item`,
    [Array.from(CFOPS_RECEBIMENTO_NACIONAL), empresa === 'q2p' ? dataCorte : dataCorteAcxe(), chaves],
  );
  const porNf = new Map<string, { fornecedor: number | null; grupos: Map<string, LinhaFilaPc[]> }>();
  for (const l of r.rows) {
    let nf = porNf.get(l.c_chave_nfe);
    if (!nf) porNf.set(l.c_chave_nfe, (nf = { fornecedor: null, grupos: new Map() }));
    if (nf.fornecedor == null) nf.fornecedor = numOuNull(l.fornecedor_codigo);
    const g = nf.grupos.get(l.desc_norm);
    if (g) g.push(l);
    else nf.grupos.set(l.desc_norm, [l]);
  }
  const entradas = new Map<string, ItemParaSugestao[]>();
  for (const [chave, nf] of porNf) {
    const lista: ItemParaSugestao[] = [];
    let indice = 0;
    for (const linhas of nf.grupos.values()) {
      if (linhas.every((l) => l.recebido)) {
        indice++;
        continue;
      }
      const conv = conversaoDoGrupo(linhas);
      if (!conv.ok) {
        indice++;
        continue;
      }
      lista.push(entradaSugestaoPc(indice++, linhas[0]!.x_prod, conv.quantidadeKg, linhas, conv.unidade, conv.fator));
    }
    entradas.set(chave, lista);
  }
  const ctx = await carregarContextoPc(empresa, {
    fornecedores: Array.from(porNf.values()).map((n) => n.fornecedor).filter((n): n is number => n != null),
    nCodPedsVinculo: Array.from(entradas.values()).flatMap((l) => l.flatMap((e) => e.vinculos.map((v) => v.nIdPedido))),
  });
  const tol = toleranciasPc();
  const opcoes = opcoesPc();
  for (const [chave, lista] of entradas) {
    const fornecedor = porNf.get(chave)?.fornecedor ?? null;
    if (fornecedor == null) {
      out.set(chave, 'nao_aplicavel');
      continue;
    }
    const situacoes: PcSituacaoItem[] = lista.map((e) => montarPcDoItem(e, ctx, fornecedor, chave, tol, opcoes).situacao);
    out.set(chave, pcSituacaoDaNf(situacoes));
  }
  return out;
}

// ── Detalhe ────────────────────────────────────────────────────────────────

export type BloqueioItemNf = 'unidade_nao_conversivel' | 'unidade_incoerente' | 'sem_correlacao' | null;

export interface ProdutoSugerido {
  codigo: number;
  descricao: string;
  vezesUsada: number;
  /**
   * So na NF da ACXE (Historia 5): o produto NAO tem correspondente ativo na Q2P (mesma
   * descricao), entao so pode entrar em estoque que e so da ACXE (20.0.5, 20.0.7, 21.2) — a
   * tela desabilita os locais que tambem sao da Q2P para ele. Ausente na NF da Q2P.
   */
  semCorrelatoQ2p?: boolean;
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
  /** o que falta do lado da NF: restantePendenciaKg (D19 da 017; null quando bloqueado). A retomada reparte este valor */
  quantidadeRestanteKg: number | null;
  baixadoComoExterno: boolean;
  /** ha solicitacao de baixa externa PENDENTE de aprovacao — o item continua na fila, marcado */
  baixaSolicitada: boolean;
  /** detalhe da conversao (para quem precisa dos dois R$/kg) */
  conversao: ConversaoNf;
  /**
   * Sequencias, no recebimento de NF-e do OMIE, das linhas agregadas neste item
   * (ACXEGDP-412). Gravadas na movimentacao para o item continuar reconhecido como
   * recebido quando a descricao muda depois do fiscal. Vazio sem recebimento no espelho.
   */
  sequenciasRecebimento: number[];
  /**
   * Feature 017: pedido de compra do item (data-model §8). Fiscal pendente (chave
   * ligada): vinculo do OMIE, candidatos, outros e aguardando; fiscal ja feito: so
   * `vinculadoNoOmie` (FR-021). null = nada a mostrar.
   */
  pc: PcDoItem | null;
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
  /** soma dos itens do RECORTE (compra de mercadoria) — o que o Atlas recebe */
  valorTotalBrl: number;
  /** soma de TODAS as linhas da NF, inclusive fora do recorte — base da conta a pagar no OMIE (e-mail de dispensa, SPEC016-7) */
  valorNotaBrl: number;
  itens: ItemNfNacional[];
  /** linhas da NF fora do recorte de CFOP (ex.: item de consumo numa NF mista) — nao recebiveis por aqui */
  linhasForaDoRecorte: number;
  /** feature 016: situacao do recebimento fiscal no OMIE */
  fiscal: SituacaoFiscal;
  /**
   * feature 017 (D21): o recebimento fiscal foi concluido e depois DESFEITO no portal do OMIE. Implica
   * fiscal === 'pendente' (o clique conclui o fiscal de novo, com o PC confirmado). Responde tambem para a NF
   * revertida sem item a receber (entrada fisica ja lancada), para a tela avisar que o fiscal precisa ser refeito.
   * Sempre false com a D21 desligada.
   */
  fiscalRevertido: boolean;
  /**
   * feature 017 (D21): quando o fiscal foi desfeito no OMIE (ISO) — a hora da alteracao no OMIE que mostrou a reversao
   * (a do espelho, quando posterior a conclusao) ou, sem ela, o revertido_omie_em da reversao mais recente no ledger; null
   * quando so a leitura ao vivo do clique percebeu a reversao (a hora do clique nao e a da reversao) ou a NF nao esta revertida
   */
  fiscalRevertidoEm: string | null;
  /** id do recebimento na caixa do OMIE (fonte b, ou n_id_receb do espelho de NF) — para a conclusao fiscal */
  nIdReceb: number | null;
  /** feature 016: gestor pode dispensar (flag ligada, sem dispensa ativa, ao menos um item pendente) */
  dispensavel: boolean;
  /** feature 017: empresa da NF — a ACXE so aparece com a Historia 5 habilitada */
  empresa: EmpresaNacional;
  /** feature 017 (D6): STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC — so pesa com fiscal pendente */
  exigePc: boolean;
  /** feature 017 (D7, FR-021a): estoque ja lancado pelo OMIE num item a receber — o POST e recusado */
  estoqueLancadoPeloOmie: boolean;
  /** feature 017 (D13): copia de PCs defasada — sem sugestao; POST com fiscal pendente da 503 */
  copiaPcsDefasada: boolean;
  /**
   * feature 017 (FR-011a/FR-020): itens PENDENTES que o Atlas nao recebe (unidade nao
   * convertida para kg) e sem PC vinculado no OMIE — o fiscal os concluiria sem PC. Modo
   * bloquear: o POST da NF e recusado (NF_SEM_PC); modo receber sem vinculo: seguem sem
   * vinculo e compras e avisado. So com o fluxo de PC (chave da 016 + fiscal pendente).
   */
  itensSemAvaliacaoPc: Array<{ indice: number; descricao: string }>;
  /**
   * NF 19252 (26/10/2026): itens a receber com alguma linha marcada como "Ignorar" no recebimento
   * do OMIE (espelho de recebimentos). Com PC escolhido o POST e recusado (409
   * ITEM_IGNORADO_NO_OMIE): o IGNORAR desfaz o vinculo e so o fiscal desmarca. A tela avisa antes
   * do clique nos itens com PC a confirmar; item ignorado sem PC segue sem vinculo, como antes. So
   * com o fluxo de PC (chave da 016 + fiscal pendente).
   */
  itensIgnoradosNoOmie: Array<{ indice: number; descricao: string }>;
  /**
   * PC por NF (22/10/2026): os PCs que atendem a nota, com a atribuicao item da NF ->
   * item do PC, para o operador escolher o pedido UMA vez. Derivado das listas de cada
   * item (o POST continua por item). Vazio fora do fluxo de PC ou com a copia defasada.
   */
  pcsDaNf: PcsDaNf;
}

/**
 * Feature 017: o que o POST por-nf precisa alem do detalhe publico — NUNCA vai ao
 * cliente (vinculos por sequencia com ids do OMIE, "PC possivel", motivo).
 */
export interface DetalheNfNacionalInterno {
  /** nIdFornecedor do recebimento (fonte b); null na fonte (a) */
  fornecedorCodigo: number | null;
  /**
   * D7/FR-021a: a conclusao do fiscal esta CONFIRMADA localmente — pelo ledger do Atlas
   * (concluido/ja_concluido, ja conferido contra estoque lancado) ou pelo espelho de
   * recebimentos com c_recebido='S' em todas as linhas dos itens a receber. Senao (linha
   * ausente, defasada ou nao casada) o POST de "fiscal ja feito" le o recebimento ao vivo.
   * D21: o ledger so confirma enquanto o sinal de reversao for falso (`ledger_concluido` do detalhe) — e a regra
   * da D7 continua a mesma; a leitura ao vivo que descobre a reversao e decidida no POST (ledgerFiscalVigente).
   */
  espelhoConfirmaConclusao: boolean;
  /** por indice do item: entrada da sugestao e resultado (null fora do fiscal pendente ou com a copia defasada) */
  pcPorIndice: Map<number, { entrada: ItemParaSugestao; resultado: ResultadoPcItem | null }>;
}

/** PcDoItem sem nada a escolher (copia defasada) — a tela mostra o aviso da NF. */
const pcVazio = (): PcDoItem => ({
  vinculoOmie: null,
  vinculoOmieElegivel: false,
  alertaVinculoOmie: null,
  vinculosDivergentes: false,
  candidatos: [],
  outrosDoFornecedor: [],
  aguardandoAprovacao: [],
  unidadeIncompativel: [],
  preSelecionado: null,
  semPcMotivo: null,
  vinculadoNoOmie: null,
});

/**
 * Numero legivel dos PCs vinculados (FR-021), por nCodPed: a copia local (PC ainda
 * aberto), o ledger do Atlas e, por ultimo, o cache de PCs vistos (0057 — o PC que
 * saiu da lista de pendentes ou foi recebido por inteiro). Best-effort: sem numero,
 * o chamador mostra "PC vinculado no OMIE" sem numero.
 * Historia 5: a copia e o cache sao os da empresa da NF (o ledger tambem, para a ACXE — o
 * texto da Q2P segue o de sempre).
 */
async function numerosDosPcs(peds: number[], empresa: EmpresaNacional = 'q2p'): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (peds.length === 0) return out;
  try {
    const r = await getPool().query<{ ncodped: string; numero: string | null; prio: number }>(
      `SELECT ncodped::text AS ncodped, MIN(btrim(cnumero)) AS numero, 1 AS prio
         FROM public.${tabelaPcs(empresa)} WHERE ncodped = ANY($1::bigint[]) GROUP BY ncodped
       UNION ALL
       SELECT n_cod_ped::text, MIN(btrim(pc_numero)), 2
         FROM stockbridge.recebimento_fiscal_pc WHERE n_cod_ped = ANY($1::bigint[]) AND status = 'concluido'${empresa === 'q2p' ? '' : ` AND empresa = '${empresa}'`} GROUP BY n_cod_ped
       UNION ALL
       SELECT n_cod_ped::text, MIN(NULLIF(btrim(pc_numero), '')), 3
         FROM stockbridge.pedido_compra_visto WHERE empresa = '${empresa}' AND n_cod_ped = ANY($1::bigint[]) GROUP BY n_cod_ped
       ORDER BY 3`,
      [peds],
    );
    for (const x of r.rows) {
      const ped = Number(x.ncodped);
      if (!out.has(ped) && x.numero) out.set(ped, x.numero);
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Número dos PCs vinculados indisponível');
  }
  return out;
}

/**
 * PCs que o PROPRIO Atlas vinculou no fiscal desta NF (linhas `concluido` de
 * recebimento_fiscal_pc), por sequencia. Tem precedencia sobre o espelho de
 * recebimentos no "PC vinculado a vista" (FR-021): o espelho leva ate ~30 min (ou
 * mais, em linha travada) para refletir o ASSOCIAR-PEDIDO — e, numa troca, ainda
 * mostraria o PC antigo. Best-effort: sem o ledger, vale o espelho.
 */
async function pcsDoLedgerPorSequencia(chave: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  try {
    const r = await getPool().query<{ n_sequencia: number | string; pc_numero: string | null }>(
      `SELECT p.n_sequencia, p.pc_numero
         FROM stockbridge.recebimento_fiscal_pc p
         JOIN stockbridge.recebimento_fiscal rf ON rf.id = p.recebimento_fiscal_id
        WHERE rf.nf_chave_acesso = $1 AND rf.status IN ('concluido', 'ja_concluido') AND p.status = 'concluido'`,
      [chave],
    );
    for (const x of r.rows) out.set(Number(x.n_sequencia), (x.pc_numero ?? '').trim());
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'PCs vinculados pelo Atlas indisponíveis — detalhe usa só o espelho');
  }
  return out;
}

/**
 * kg do item pela via do XML (D19), linha a linha: o XML (`q_com_xml`, unidade da tabela explicita) quando
 * esta na faixa comparavel (RAZAO_XML_MIN..MAX da nota de entrada); senao a nota de entrada (`q_com` x fator
 * da conversao). O OMIE grava na nota de entrada a quantidade RECEBIDA, que o fiscal pode editar no portal
 * (NF 67988, 23/10/2026: XML 13.382 kg, nota de entrada 13.500 kg). Mesma regra de nfKgXmlSql, na fila.
 */
export function kgXmlComparavel(
  linhas: Array<{ q_com: number | string; q_com_xml?: number | string | null; u_com_xml?: string | null }>,
  fatorNf: number,
): number {
  return linhas.reduce((soma, l) => {
    const entrada = Number(l.q_com) * fatorNf;
    const u = normalizarGrafiaUnidadeNf(l.u_com_xml);
    const xml = l.q_com_xml != null && l.q_com_xml !== '' && isUnidadeNfConhecida(u) ? Number(l.q_com_xml) * FATOR_UNIDADE_NF[u] : NaN;
    // XML fora da faixa comparavel (unidade trocada): vale a nota de entrada
    const comparavel = Number.isFinite(xml) && xml >= entrada * RAZAO_XML_MIN && xml <= entrada * RAZAO_XML_MAX;
    return soma + (comparavel ? xml : entrada);
  }, 0);
}

/**
 * Restante do item (FR-030 da 015, D19 da 017): a menor distancia, para cima, ate uma das duas quantidades
 * oficiais (nota de entrada e via do XML) que o atribuido ainda nao atingiu, com tolerancia de 1 kg; 0 quando
 * ja atingiu alguma. Recebido pela NF do XML nao reabre com a nota de entrada editada para mais (NF 67988), e
 * a gravacao parcial ancorada na nota de entrada continua visivel quando ela e maior que o XML. Mesma regra de
 * RESTANTE_PENDENCIA_SQL, na fila.
 */
export function restantePendenciaKg(entradaKg: number, xmlKg: number, atribuidaKg: number): number {
  const distancias = [entradaKg, xmlKg].filter((c) => Number.isFinite(c) && c >= atribuidaKg - 1).map((c) => c - atribuidaKg);
  return distancias.length === 0 ? 0 : Math.max(0, Math.min(...distancias));
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

/**
 * Codigos de produto da ACXE sugeridos para um item da NF (Historia 5), na ordem de confianca:
 * primeiro o que o OMIE ja associou as linhas do item (n_cod_prod da NF / n_id_produto do
 * recebimento) e depois o produto do item do PC — o atribuido ao item no PC pre-selecionado da
 * nota, o pre-selecionado do proprio item e o vinculo do OMIE elegivel. Sem repeticao.
 */
function codigosProdutoAcxeDoItem(
  indice: number,
  linhas: Array<{ produto_omie?: string | number | null }>,
  ctx: ContextoPc | null,
  resultado: ResultadoPcItem | null,
  pcsDaNf: PcsDaNf,
): number[] {
  const codigos: number[] = [];
  const add = (n: number | null | undefined): void => {
    if (n != null && Number.isFinite(n) && n > 0 && !codigos.includes(n)) codigos.push(n);
  };
  for (const l of linhas) add(numOuNull(l.produto_omie));
  if (ctx) {
    const produtoDoItemDePc = (nCodItem: number | null | undefined): number | undefined =>
      nCodItem == null ? undefined : ctx.pcs.find((p) => p.nCodItem === nCodItem)?.nCodProd;
    const doPcDaNf =
      pcsDaNf.preSelecionado != null
        ? pcsDaNf.pcs.find((p) => p.nCodPed === pcsDaNf.preSelecionado)?.itens.find((i) => i.indice === indice)?.nCodItem
        : undefined;
    add(produtoDoItemDePc(doPcDaNf));
    add(produtoDoItemDePc(resultado?.pc.preSelecionado?.nCodItem));
    if (resultado?.pc.vinculoOmie && resultado.pc.vinculoOmieElegivel) add(produtoDoItemDePc(resultado.pc.vinculoOmie.nCodItem));
  }
  return codigos;
}

/**
 * Produtos sugeridos da NF da ACXE: os codigos viram produtos do catalogo da ACXE, cada um com
 * `semCorrelatoQ2p` (sem produto Q2P ativo de mesma descricao: so entra em local so da ACXE).
 * Produto fora do cadastro ou inativo nao e oferecido (o combobox nao o lista). Uma consulta para
 * a NF inteira; falha de banco = sem sugestao (o operador escolhe no combobox).
 */
async function produtosSugeridosAcxe(codigosPorIndice: Map<number, number[]>, chave: string): Promise<Map<number, ProdutoSugerido[]>> {
  const out = new Map<number, ProdutoSugerido[]>();
  const todos = Array.from(new Set(Array.from(codigosPorIndice.values()).flat()));
  if (todos.length === 0) return out;
  try {
    const catalogo = await resolverGemeosQ2p(todos);
    for (const [indice, codigos] of codigosPorIndice) {
      const lista: ProdutoSugerido[] = [];
      for (const c of codigos) {
        const p = catalogo.get(c);
        if (!p || !p.ativoAcxe || !p.emKgAcxe) continue; // so produto ativo e em kg (o POST recusa os outros)
        lista.push({ codigo: p.codigoAcxe, descricao: p.descricaoAcxe, vezesUsada: 0, semCorrelatoQ2p: p.gemeoQ2p == null });
      }
      out.set(indice, lista);
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, chave }, 'Produtos sugeridos da NF da ACXE indisponíveis — detalhe segue sem pré-seleção');
  }
  return out;
}

/**
 * D21: quando o fiscal da NF foi desfeito no OMIE, para o banner do detalhe: a hora da alteracao do recebimento no
 * espelho quando ela e posterior a conclusao (mesma margem do sinal) e, senao, a hora do OMIE que a marcacao da reversao
 * mais recente gravou no ledger (revertido_omie_em). Marcacao pela leitura ao vivo do clique nao tem a hora do OMIE: a hora
 * fica nula e o banner a omite (a hora do clique nao e a da reversao — revisao da tela), mesmo com uma reversao anterior
 * marcada pelo espelho (a hora dela e anterior a conclusao desfeita depois). Nao basta a hora do espelho:
 * na janela entre a conclusao pelo Atlas e o proximo sync de recebimentos o espelho ainda traz o 'N' de ANTES da
 * conclusao, e o banner diria que o fiscal foi desfeito antes de ser feito.
 */
function fiscalRevertidoEmSql(chaveExpr: string, empresa: EmpresaNacional): string {
  const pendencia = pendenciaEspelhoEmSql(chaveExpr, empresa);
  return `CASE WHEN ${pendencia} - interval '${MARGEM_REVERSAO_ESPELHO_MIN} minutes' > ${conclusaoFiscalEmSql(chaveExpr, empresa)}
                THEN ${pendencia}
                ELSE ${reversaoOmieDoLedgerEmSql(chaveExpr)} END`;
}

/**
 * D21: NF revertida cuja tentativa antiga do fiscal ainda esta 'concluido' no ledger (o sinal pelo espelho chegou antes
 * da varredura do cron e do clique): marca-la ao abrir a nota tira os vinculos dela do saldo do PC — saldoDisponivelCopiaKg
 * desconta as linhas 'concluido', inclusive as desta NF, e o PC do vinculo apareceria "sem saldo" na sugestao (achado do
 * teste de ponta a ponta). marcarLedgerRevertido re-confere o sinal no UPDATE. Melhor esforco: falhou, o detalhe segue
 * (o clique e a varredura marcam depois). Precedente de escrita na abertura da NF: registrarPcsVistosSeVencido.
 */
async function marcarTentativaRevertidaSeVigente(chave: string, empresa: EmpresaNacional): Promise<void> {
  try {
    if (!(await ledgerFiscalVigente(chave))) return;
    await marcarLedgerRevertido({ nfChaveAcesso: chave, empresa, origem: 'espelho' });
  } catch (err) {
    logger.warn({ err: (err as Error).message, chave }, 'Não foi possível marcar como revertida a tentativa antiga do fiscal ao abrir a NF — o detalhe segue');
  }
}

/** Quando o fiscal da NF foi desfeito no OMIE (ISO), ou null se desconhecido. Melhor esforco: a hora e so informativa. */
async function fiscalRevertidoEmDaNf(chave: string, empresa: EmpresaNacional): Promise<string | null> {
  try {
    const r = await getPool().query<{ em: Date | string | null }>(`SELECT ${fiscalRevertidoEmSql('$1::text', empresa)} AS em`, [chave]);
    const v = r.rows[0]?.em;
    if (v == null) return null;
    const quando = new Date(v);
    return Number.isNaN(quando.getTime()) ? null : quando.toISOString();
  } catch (err) {
    logger.warn({ err: (err as Error).message, chave }, 'Hora da reversão do fiscal indisponível — o detalhe segue sem ela');
    return null;
  }
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
  n_cod_item: string | number;
  x_prod: string;
  desc_norm: string;
  cfop: string;
  q_com: number;
  u_com: string | null;
  /** quantidade e unidade do XML (espelho de recebimentos); null sem o recebimento no espelho */
  q_com_xml?: number | string | null;
  u_com_xml?: string | null;
  /** valor do item COM tributos — `v_prod` (fonte a) ou `v_total_item` (fonte b); ver D26/D7 no topo */
  valor_item: number;
  recebido: boolean;
  baixado_externo: boolean;
  baixa_solicitada: boolean;
  nf_ja_atribuida_kg: number;
  conferida_ja_gravada_kg: number;
  /** sequencia do item no recebimento de NF-e (ACXEGDP-412); null sem recebimento no espelho */
  n_seq: number | string | null;
  // ── feature 017 ──
  preco_comercial: number | string | null;
  fornecedor_codigo: number | string | null;
  n_id_pedido: number | string | null;
  n_id_it_pedido: number | string | null;
  n_num_ped_compra: string | null;
  c_ignorar_item: string | null;
  c_nao_gerar_mov_estoque: string | null;
  receb_recebido: string | null;
  /** o ledger do Atlas tem o fiscal desta NF concluido (ou ja_concluido) — e, com a D21 ligada, ainda nao revertido no OMIE */
  ledger_concluido: boolean;
  /** so com a D21 ligada: o fiscal desta NF foi desfeito no OMIE depois de concluido */
  fiscal_revertido?: boolean | null;
  // ── Historia 5: so quando a consulta inclui a ACXE (ausente = Q2P) ──
  empresa?: EmpresaNacional;
  /** produto que o OMIE associou ao item (tbl_nf_itens.n_cod_prod / recebimento n_id_produto), codigo da empresa da NF */
  produto_omie?: string | number | null;
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
  return (await montarDetalheNfNacional(chaveAcesso)).detalhe;
}

/** Detalhe + dados internos do PC (feature 017) — usado pelo POST por-nf. */
export async function montarDetalheNfNacional(
  chaveAcesso: string,
): Promise<{ detalhe: DetalheNfNacional; interno: DetalheNfNacionalInterno }> {
  const chave = (chaveAcesso ?? '').trim();
  if (!/^\d{44}$/.test(chave)) throw new NfNacionalNaoEncontradaError(chave, 'chave de acesso inválida');

  const dataCorte = getDataCorteFilaNacional();
  const flag = recebimentoFiscalHabilitado();
  // D21: fiscal revertido no OMIE (chave da 016 + kill switch + migration 0060); depois da chave e do corte validos
  const comRevertido = flag && (await fiscalRevertidoHabilitado());
  const pool = getPool();
  const descNorm = normalizarDescricaoSql('u.x_prod');

  // Historia 5: a NF pode ser da Q2P ou da ACXE (habilitada). A chave de acesso e unica entre os
  // espelhos, entao a consulta olha as empresas ativas e a linha diz de qual veio. O corte da
  // ACXE e um parametro proprio, depois do da Q2P ($2) — com a Q2P sozinha, os de sempre.
  const consultar = async (empresas: EmpresaNacional[]) => {
    const args: unknown[] = [chave, dataCorte];
    const corteAcxe = empresas.includes('acxe') ? `$${args.push(dataCorteAcxe())}` : '';
    const fontes: FonteEmpresa[] = [];
    for (const e of empresas) {
      fontes.push({
        empresa: e,
        canceladaExiste: await colunaCanceladaExiste(pool, nomeSemAspas(tabelasNacional(e).nfHeader)),
        corteParam: e === 'q2p' ? '$2' : corteAcxe,
      });
    }
    const emp = comEmpresaNasLinhas(fontes);
    return pool.query<LinhaRow>(
    `
    WITH nf_unificada AS (${nfUnificadaSql(fontes, flag, false, comRevertido)}
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
      NOT ${fornecedorNaoExcluidoSql('u', emp)}             AS fornecedor_excluido,
      u.fiscal_pendente                                AS fiscal_pendente,
      u.n_id_receb                                     AS n_id_receb,
      u.n_cod_item                                     AS n_cod_item,
      u.x_prod                                         AS x_prod,
      ${descNorm}                                      AS desc_norm,
      u.cfop                                           AS cfop,
      u.q_com::float8                                  AS q_com,
      u.u_com                                          AS u_com,
      u.q_com_xml::float8                              AS q_com_xml,
      u.u_com_xml                                      AS u_com_xml,
      u.valor_item::float8                             AS valor_item,  -- D26: NAO v_tot_item
      ${recebidoSql('u', emp)}                              AS recebido,
      EXISTS (SELECT 1 FROM stockbridge.aprovacao a
               WHERE a.tipo_aprovacao = 'recebimento_externo' AND a.status = 'aprovada'
                 AND a.nf_chave_acesso = u.c_chave_nfe
                 AND ${normalizarDescricaoSql('a.nf_item_descricao')} = ${descNorm}) AS baixado_externo,
      ${baixaSolicitadaSql('u')}                       AS baixa_solicitada,
      (SELECT COALESCE(SUM(m.quantidade_nf_kg), 0) FROM stockbridge.movimentacao m
        WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
          AND ${movimentacaoDoItemSql('m', 'u')})::float8 AS nf_ja_atribuida_kg,
      (SELECT COALESCE(SUM(m.quantidade_kg), 0) FROM stockbridge.movimentacao m
        WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
          AND ${movimentacaoDoItemSql('m', 'u')})::float8 AS conferida_ja_gravada_kg,
      u.n_seq                                          AS n_seq,
      u.preco_comercial::float8                        AS preco_comercial,
      u.fornecedor_codigo::text                        AS fornecedor_codigo,
      u.n_id_pedido::text                              AS n_id_pedido,
      u.n_id_it_pedido::text                           AS n_id_it_pedido,
      u.n_num_ped_compra                               AS n_num_ped_compra,
      u.c_ignorar_item                                 AS c_ignorar_item,
      u.c_nao_gerar_mov_estoque                        AS c_nao_gerar_mov_estoque,
      u.receb_recebido                                 AS receb_recebido,
      ${comRevertido ? ledgerFiscalVigenteSql('u.c_chave_nfe', 'u.fiscal_revertido') : LEDGER_FISCAL_CONCLUIDO_SQL('u.c_chave_nfe')}  AS ledger_concluido${emp ? ',\n      u.empresa                                        AS empresa,\n      u.produto_omie::text                             AS produto_omie' : ''}${comRevertido ? ',\n      u.fiscal_revertido                               AS fiscal_revertido' : ''}
    FROM nf_unificada u
    WHERE u.c_chave_nfe = $1
    ORDER BY u.n_cod_item
    `,
    args,
    );
  };
  let res: Awaited<ReturnType<typeof consultar>>;
  try {
    let consultadas = empresasNacionalAtivas();
    try {
      res = await consultar(consultadas);
    } catch (err) {
      // Qualquer falha da consulta com a ACXE tira so a ACXE; a NF da Q2P continua abrindo (a da ACXE
      // passa a nao ser encontrada, como se a chave da ACXE estivesse desligada).
      if (consultadas.length > 1 && consultadas.includes('acxe')) {
        consultadas = consultadas.filter((e) => e !== 'acxe');
        res = await consultar(consultadas);
        avisarAcxeForaDaFila(err, 'detalhe'); // so depois de a Q2P responder: o defeito era mesmo da ACXE
      } else {
        throw err;
      }
    }
  } catch (err) {
    if (ehTabelaAusente(err)) {
      logger.error({ err: (err as Error).message, flag }, 'Detalhe da NF nacional referencia tabela inexistente — migration pendente?');
      throw new FilaNacionalIncompletaError();
    }
    throw err;
  }

  if (res.rows.length === 0) {
    throw new NfNacionalNaoEncontradaError(chave, 'ainda não foi sincronizada ou é anterior à data de corte');
  }
  const cab = res.rows[0]!;
  if (cab.cancelada || cab.deletada) throw new NfNacionalCanceladaError(cab.nota_fiscal);
  if (cab.fornecedor_excluido) throw new FornecedorExcluidoError(cab.fornecedor_nome ?? FORNECEDOR_NAO_IDENTIFICADO);

  // Feature 016 (FR-021, contrato §2): NF dispensada pelo gestor sai da fila e o
  // detalhe diz por que — com a chave em qualquer posicao (achado fila-v01).
  {
    const d = await pool.query<{ dispensado_em: string }>(
      `SELECT dispensado_em::text AS dispensado_em FROM stockbridge.nf_dispensa
        WHERE nf_chave_acesso = $1 AND revertido_em IS NULL LIMIT 1`,
      [chave],
    );
    if (d.rows.length > 0) {
      const quando = new Date(d.rows[0]!.dispensado_em);
      const data = Number.isNaN(quando.getTime()) ? d.rows[0]!.dispensado_em : quando.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      throw new NfNacionalDispensadaError(cab.nota_fiscal, data);
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
  const empresa: EmpresaNacional = cab.empresa ?? 'q2p';

  // Historia 3 (FR-006): sugestao memorizada por (fornecedor, descricao normalizada).
  // Best-effort — falha aqui nao pode derrubar o detalhe da NF.
  // Historia 5: a memoria e so da Q2P (o CNPJ do fornecedor se repete nas duas empresas e o
  // codigo memorizado e o da Q2P) — a NF da ACXE sugere pelo produto do item e do PC, mais abaixo.
  let sugestoes = new Map<string, ProdutoSugerido[]>();
  if (fornecedorCnpj && empresa === 'q2p') {
    try {
      sugestoes = await sugerirProdutosEmLote(fornecedorCnpj, Array.from(grupos.keys()));
    } catch (err) {
      logger.warn({ err: (err as Error).message, chave }, 'Sugestão de correlação indisponível — detalhe segue sem pré-seleção');
    }
  }

  const itens: ItemNfNacional[] = [];
  const linhasPorIndice = new Map<number, LinhaRow[]>();
  let indice = 0;
  for (const [descNormalizada, linhas] of grupos) {
    linhasPorIndice.set(indice, linhas);
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
      quantidadeRestanteKg: conversao.ok ? restantePendenciaKg(conversao.quantidadeKg, kgXmlComparavel(linhas, conversao.fator), nfJaAtribuida) : null,
      baixadoComoExterno: linhas.some((l) => l.baixado_externo),
      baixaSolicitada: linhas.some((l) => l.baixa_solicitada),
      conversao,
      sequenciasRecebimento: Array.from(
        new Set(linhas.map((l) => (l.n_seq == null || l.n_seq === '' ? NaN : Number(l.n_seq))).filter((n) => Number.isInteger(n) && n > 0)),
      ).sort((x, y) => x - y),
      pc: null,
    });
  }

  const fiscal: SituacaoFiscal = res.rows.some((r) => r.fiscal_pendente === true) ? 'pendente' : 'concluido';
  // D21: a NF revertida vem da fonte (b) com fiscal 'pendente'; aqui so se anota que foi o OMIE que desfez o fiscal
  const fiscalRevertido = comRevertido && res.rows.some((r) => r.fiscal_revertido === true);
  const fiscalRevertidoEm = fiscalRevertido ? await fiscalRevertidoEmDaNf(chave, empresa) : null;
  if (fiscalRevertido) await marcarTentativaRevertidaSeVigente(chave, empresa);
  const nIdReceb = cab.n_id_receb != null && cab.n_id_receb !== '' ? Number(cab.n_id_receb) : null;

  // ── Feature 017: pedido de compra por item e estoque ja lancado pelo OMIE ──
  const fornecedorCodigo = elegiveis.map((r) => numOuNull(r.fornecedor_codigo)).find((n) => n != null && n > 0) ?? null;
  const pcPorIndice: DetalheNfNacionalInterno['pcPorIndice'] = new Map();
  const entradas = itens.map((it) =>
    entradaSugestaoPc(
      it.indice,
      it.descricaoFornecedor,
      it.quantidadeNfKg,
      linhasPorIndice.get(it.indice) ?? [],
      it.unidadeOriginal,
      it.conversao.ok ? it.conversao.fator : null,
    ),
  );
  let copiaDefasada = false;
  let pcsDaNf: PcsDaNf = { pcs: [], preSelecionado: null };
  let ctxPcs: ContextoPc | null = null;
  if (fiscal === 'pendente' && flag) {
    copiaDefasada = await copiaPcsDefasada(empresa);
    let resultados: Map<number, ResultadoPcItem> | null = null;
    if (!copiaDefasada) {
      if (empresa === 'q2p') {
        resultados = await sugerirPcPorItens(empresa, fornecedorCodigo, chave, entradas);
      } else {
        // ACXE: o contexto traz tambem o produto dos itens de PC (sugestao de produto, mais abaixo)
        const lido = await sugerirPcPorItensComContexto(empresa, fornecedorCodigo, chave, entradas);
        resultados = lido.resultados;
        ctxPcs = lido.ctx;
      }
    }
    for (const it of itens) {
      const resultado = resultados?.get(it.indice) ?? null;
      it.pc = resultado ? resultado.pc : pcVazio();
      pcPorIndice.set(it.indice, { entrada: entradas[it.indice]!, resultado });
    }
    // PC por NF: so os itens a receber (pendentes, com unidade convertida, sem baixa pedida).
    if (resultados) {
      const paraNf: ItemParaPcsDaNf[] = itens
        .filter((it) => itemNfPendente(it) && it.conversao.ok && !it.baixaSolicitada && it.quantidadeNfKg != null)
        .flatMap((it) => {
          const r = resultados.get(it.indice);
          return r ? [{ indice: it.indice, quantidadeKg: it.quantidadeNfKg!, resultado: r }] : [];
        });
      pcsDaNf = montarPcsDaNf(paraNf, toleranciasPc());
    }
  } else {
    // Fiscal ja feito: so o PC vinculado a vista, com a chave em qualquer posicao (FR-021).
    // O vinculo gravado pelo Atlas (ledger) vale antes do espelho para a mesma sequencia.
    const ledgerPcs = cab.ledger_concluido === true ? await pcsDoLedgerPorSequencia(chave) : new Map<number, string>();
    const numeros = await numerosDosPcs(Array.from(new Set(entradas.flatMap((e) => e.vinculos.map((v) => v.nIdPedido)))), empresa);
    for (const it of itens) {
      const entrada = entradas[it.indice]!;
      pcPorIndice.set(it.indice, { entrada, resultado: null });
      const nums: string[] = [];
      let vinculado = false;
      const doLedger = new Set<number>();
      for (const seq of entrada.sequencias) {
        const n = ledgerPcs.get(seq);
        if (n === undefined) continue;
        vinculado = true;
        doLedger.add(seq);
        if (n.length > 0) nums.push(n);
      }
      for (const v of entrada.vinculos) {
        if (doLedger.has(v.nSequencia)) continue;
        vinculado = true;
        const n = numeros.get(v.nIdPedido);
        if (n) nums.push(n);
      }
      if (!vinculado) continue;
      // Sem numero na copia nem no ledger: vazio (a tela mostra "PC vinculado no OMIE"). O
      // n_num_ped_compra NAO serve: e o pedido que o fornecedor informou no XML (xPed).
      it.pc = { ...pcVazio(), vinculadoNoOmie: { pcNumero: Array.from(new Set(nums)).join(', ') } };
    }
  }
  // Historia 5: produto da NF da ACXE — o que o OMIE ja associou ao item e o produto do item do PC
  // (catalogo da ACXE, com a marca de quem nao tem gemeo na Q2P). Best-effort.
  if (empresa === 'acxe') {
    const codigosPorIndice = new Map<number, number[]>();
    for (const it of itens) {
      codigosPorIndice.set(
        it.indice,
        codigosProdutoAcxeDoItem(it.indice, linhasPorIndice.get(it.indice) ?? [], ctxPcs, pcPorIndice.get(it.indice)?.resultado ?? null, pcsDaNf),
      );
    }
    const sugeridos = await produtosSugeridosAcxe(codigosPorIndice, chave);
    for (const it of itens) {
      it.produtosSugeridos = sugeridos.get(it.indice) ?? [];
      // 'sem_correlacao' = nenhuma sugestao (informativo); o bloqueio de unidade continua valendo
      if (it.bloqueio === 'sem_correlacao' && it.produtosSugeridos.length > 0) it.bloqueio = null;
    }
  }
  // D7: item a receber cujo recebimento foi concluido fora do Atlas com movimento de estoque.
  // D21: a linha do espelho de uma NF revertida no OMIE pode estar defasada ('S'): nao e estoque lancado.
  const estoqueLancadoPeloOmie = itens.some(
    (it) =>
      itemNfPendente(it) &&
      (linhasPorIndice.get(it.indice) ?? []).some(
        (l) => l.fiscal_revertido !== true && l.receb_recebido === 'S' && l.c_ignorar_item === 'N' && l.c_nao_gerar_mov_estoque === 'N',
      ),
  );
  // FR-021a: o espelho so CONFIRMA a conclusao com c_recebido='S' em todas as linhas dos
  // itens a receber (linha ausente, defasada ou nao casada => leitura ao vivo no POST).
  const linhasAReceber = itens.filter(itemNfPendente).flatMap((it) => linhasPorIndice.get(it.indice) ?? []);
  const espelhoConfirmaConclusao = cab.ledger_concluido === true || linhasAReceber.every((l) => l.receb_recebido === 'S');
  // FR-011a/FR-020: item que o Atlas nao recebe (unidade) e sem PC no OMIE seria concluido sem PC.
  const itensSemAvaliacaoPc =
    fiscal === 'pendente' && flag
      ? itens
          .filter((it) => itemNfPendente(it) && !it.conversao.ok && (entradas[it.indice]?.vinculos.length ?? 0) === 0)
          .map((it) => ({ indice: it.indice, descricao: it.descricaoFornecedor }))
      : [];
  // NF 19252: linha marcada como "Ignorar" no portal num item a receber — a tela avisa antes do clique.
  const itensIgnoradosNoOmie =
    fiscal === 'pendente' && flag
      ? itens
          .filter((it) => itemNfPendente(it) && (linhasPorIndice.get(it.indice) ?? []).some((l) => l.c_ignorar_item === 'S'))
          .map((it) => ({ indice: it.indice, descricao: it.descricaoFornecedor }))
      : [];

  const detalhe: DetalheNfNacional = {
    nfChaveAcesso: cab.nf_chave_acesso,
    notaFiscal: cab.nota_fiscal,
    fornecedorNome,
    fornecedorCnpj,
    dtEmissao: cab.dt_emissao,
    diasDesdeEmissao: Number(cab.dias_desde_emissao),
    cfop: Array.from(new Set(elegiveis.map((r) => r.cfop))).join(', '),
    valorTotalBrl: elegiveis.reduce((s, l) => s + Number(l.valor_item), 0),
    valorNotaBrl: res.rows.reduce((s, l) => s + Number(l.valor_item), 0),
    itens,
    linhasForaDoRecorte: res.rows.length - elegiveis.length,
    fiscal,
    fiscalRevertido,
    fiscalRevertidoEm,
    nIdReceb: nIdReceb != null && Number.isFinite(nIdReceb) ? nIdReceb : null,
    dispensavel: flag && itens.some(itemNfPendente),
    empresa,
    exigePc: exigePcHabilitado(),
    estoqueLancadoPeloOmie,
    copiaPcsDefasada: copiaDefasada,
    itensSemAvaliacaoPc,
    itensIgnoradosNoOmie,
    pcsDaNf,
  };
  return {
    detalhe,
    interno: { fornecedorCodigo, espelhoConfirmaConclusao, pcPorIndice },
  };
}
