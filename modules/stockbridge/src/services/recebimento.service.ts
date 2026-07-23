import { createHash } from 'node:crypto';
import { eq, and, sql, inArray } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { getDb, getPool, createLogger } from '@atlas/core';
import { lote, movimentacao, movimentacaoLegado, aprovacao, localidade, localidadeCorrelacao } from '@atlas/db';
import {
  consultarNF,
  type ConsultarNFResponse,
  type ItemNF,
} from '@atlas/integration-omie';
import { getCorrelacao, CorrelacaoNaoEncontradaError, type Correlacao } from './correlacao.service.js';
import { converterParaKg, normalizarNumeroNf } from './motor.service.js';
import { nfValidaSql, colunaCanceladaExiste, produtoPendenteSql } from './fiscal-recebida-sql.js';
import { validarNfRecebivel } from './nf-validacao.service.js';
import { formatarDataOmie } from './omie-shared.js';
import {
  enviarAlertaProdutoSemCorrelato,
  enviarAlertaAprovacaoPendente,
  enviarAlertaAprovacaoPendenteImportacaoLote,
  enviarAlertaPendenciaOmie,
  enviarNotificacaoRecebimentoConcluido,
  enviarNotificacaoRecebimentoConcluidoLote,
  enviarAlertaNfIndeterminada,
  fmtKg,
} from './notificacao.service.js';
import { incluirAjusteIdempotente } from './omie-idempotente.js';
import { COD_INT_AJUSTE_SUFIXO, buildCodIntAjuste, CNPJ_ACXE, CNPJ_Q2P_MATRIZ } from '../types.js';
import type { SubtipoMovimento, UnidadeMedida } from '../types.js';

const logger = createLogger('stockbridge:recebimento');

export class NotaFiscalJaProcessadaError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`NF ${notaFiscal} já foi processada — idempotência impede reprocessamento.`);
    this.name = 'NotaFiscalJaProcessadaError';
  }
}

/** Feature 012 (ACXEGDP-204): NF cancelada/inutilizada/denegada não pode ser recebida. */
export class NotaFiscalCanceladaError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`A NF ${notaFiscal} está cancelada no OMIE e não pode ser recebida.`);
    this.name = 'NotaFiscalCanceladaError';
  }
}

/** Feature 012 (ACXEGDP-205): no contexto ACXE, só NF emitida pela ACXE é recebível. */
export class NotaFiscalNaoEmitidaPelaAcxeError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(
      `A NF ${notaFiscal} não foi emitida pela ACXE (consta como nota de entrada de outro fornecedor). Verifique o número.`,
    );
    this.name = 'NotaFiscalNaoEmitidaPelaAcxeError';
  }
}

/**
 * STK-12 (ACXEGDP-288): o recebimento de importação só suporta NF emitida pela
 * ACXE. Para cnpj='q2p', getCorrelacao buscava o código de produto Q2P em
 * tbl_produtos_ACXE — falso-bloqueio (409 + spam de e-mail admin) ou, em
 * coincidência numérica, produto ACXE errado. O modelo dual do recebimento
 * (ACXE TRF do trânsito + Q2P ENT) pressupõe NF ACXE, e a UI sempre envia
 * cnpj='acxe'. Entradas Q2P diretas têm fluxo próprio (Recebimento Nacional).
 */
export class ImportacaoApenasAcxeError extends Error {
  constructor() {
    super(
      'Recebimento de importação é suportado apenas para NF emitida pela ACXE. ' +
        'Para entradas diretas da Q2P, use o fluxo de Recebimento Nacional.',
    );
    this.name = 'ImportacaoApenasAcxeError';
  }
}

/**
 * Feature 013 (ACXEGDP-115): erro de validação do Portão 1 do recebimento
 * multi-item — o pedido é inválido (item fora da NF, motivo de divergência
 * ausente, cobertura incompleta). Nada foi escrito. Rota mapeia para 422.
 * ACXEGDP-313: as mensagens identificam produtos pela DESCRIÇÃO, nunca por
 * código OMIE.
 */
export class ValidacaoRecebimentoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidacaoRecebimentoError';
  }
}

/**
 * Feature 013 — política tudo-ou-nada: um ou mais produtos da NF não têm
 * correlato na Q2P; a NF INTEIRA é bloqueada sem nenhuma escrita. Carrega a
 * lista para a mensagem nomear todos de uma vez (FR-009/FR-010).
 */
export class ProdutosSemCorrelatoError extends Error {
  constructor(
    public readonly notaFiscal: string,
    public readonly produtos: Array<{ codigoProdutoAcxe: number; descricao: string }>,
  ) {
    const nomes = produtos.map((p) => `"${p.descricao}"`).join(', ');
    super(
      `A NF ${notaFiscal} não pode ser recebida: ${produtos.length === 1 ? 'o produto' : 'os produtos'} ${nomes} ` +
        `não ${produtos.length === 1 ? 'tem' : 'têm'} correlato na Q2P (match por descrição). ` +
        'Cadastre na Q2P com a descrição exata e tente novamente — nenhum item da NF foi recebido.',
    );
    this.name = 'ProdutosSemCorrelatoError';
  }
}

/** Feature 013 — quantidade recebida maior que a da NF em um item (regra do item único, por item). */
export class QuantidadeExcedeNfError extends Error {
  constructor(public readonly produtoDescricao: string) {
    super(
      `Quantidade recebida não pode ser maior que a quantidade da NF (produto "${produtoDescricao}"). ` +
        'Registre o recebimento normal e depois lance uma entrada manual do excedente.',
    );
    this.name = 'QuantidadeExcedeNfError';
  }
}

/**
 * Feature 012 — aplica a validação de NF (cancelamento + emitente) no recebimento.
 * Lê da tabela sincronizada `tbl_nf_header_*` (Princípio II — Atlas lê do Postgres),
 * NÃO da resposta ao vivo de `consultarNF` (que dava falso-positivo de cancelamento e
 * usava `tpNF` errado para importação). Chamada nos DOIS pontos (busca e confirmação)
 * para não deixar janela (FR-008).
 *
 *  - bloqueada   → lança erro tipado (rota mapeia para HTTP 422)
 *  - indeterminada → fail-open: segue o recebimento, alerta o admin + log (FR-010)
 *  - ok          → não faz nada (segue o fluxo)
 */
async function aplicarValidacaoNf(numero: number, cnpj: 'acxe' | 'q2p'): Promise<void> {
  const resultado = await validarNfRecebivel(numero, { cnpj });
  if (resultado.status === 'bloqueada') {
    if (resultado.motivo === 'cancelada') {
      throw new NotaFiscalCanceladaError(String(numero));
    }
    throw new NotaFiscalNaoEmitidaPelaAcxeError(String(numero));
  }
  if (resultado.status === 'indeterminada') {
    logger.warn(
      { nf: numero, cnpj, motivo: resultado.motivo },
      'NF indeterminada no recebimento — fail-open + alerta admin',
    );
    // Fail-open: não bloqueia o recebimento; dispara o alerta sem aguardar.
    void enviarAlertaNfIndeterminada({ nf: String(numero), cnpj, motivo: resultado.motivo });
  }
}

/**
 * Historico legado PHP (migration 0038): checagem por NF inteira — o legado era
 * single-item, entao qualquer registro da NF significa que ela ja entrou no
 * estoque pela plataforma antiga. Bloqueia a NF toda (lado conservador).
 */
async function nfProcessadaNoLegado(
  db: ReturnType<typeof getDb>,
  nfNormalizada: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: movimentacaoLegado.id })
    .from(movimentacaoLegado)
    .where(and(eq(movimentacaoLegado.notaFiscal, nfNormalizada), eq(movimentacaoLegado.ativo, true)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Idempotencia POR PRODUTO (feature 013, migration 0046): este produto desta NF
 * ja foi recebido — ou esta com recebimento em andamento?
 *
 * Consulta duas fontes:
 *  - `stockbridge.movimentacao` (entrada_nf ativa do produto) — recebimentos Atlas.
 *  - `stockbridge.lote` aberto do produto (STK-02, ACXEGDP-282) — o fluxo
 *    divergente cria apenas lote+aprovacao; sem esta checagem o mesmo produto
 *    continuava "livre" ate o gestor decidir. Lote rejeitado/em transito NAO
 *    bloqueia (re-receber e legitimo).
 *
 * A checagem do legado PHP fica em nfProcessadaNoLegado (por NF — dado antigo
 * nao tem granularidade de produto).
 *
 * STK-09 (ACXEGDP-288): numeracao de NF e por emissor — a chave inclui a empresa.
 */
async function produtoDaNfJaRecebido(
  db: ReturnType<typeof getDb>,
  nfNormalizada: string,
  cnpj: 'acxe' | 'q2p',
  produtoCodigoAcxe: number,
): Promise<boolean> {
  const cnpjLote = cnpj === 'acxe' ? CNPJ_ACXE : CNPJ_Q2P_MATRIZ;
  const [atlas, loteAberto] = await Promise.all([
    db
      .select({ id: movimentacao.id })
      .from(movimentacao)
      .where(
        and(
          eq(movimentacao.notaFiscal, nfNormalizada),
          eq(movimentacao.tipoMovimento, 'entrada_nf'),
          eq(movimentacao.empresa, cnpj),
          eq(movimentacao.produtoCodigoAcxe, produtoCodigoAcxe),
          eq(movimentacao.ativo, true),
        ),
      )
      .limit(1),
    db
      .select({ id: lote.id })
      .from(lote)
      .where(
        and(
          eq(lote.notaFiscal, nfNormalizada),
          eq(lote.cnpj, cnpjLote),
          eq(lote.produtoCodigoAcxe, produtoCodigoAcxe),
          inArray(lote.status, ['aguardando_aprovacao', 'provisorio']),
          eq(lote.ativo, true),
        ),
      )
      .limit(1),
  ]);
  return atlas.length > 0 || loteAberto.length > 0;
}

/**
 * STK-01b (ACXEGDP-311): opId deterministico para o caminho feliz do recebimento.
 *
 * Duas submissoes concorrentes da mesma NF precisam gerar o MESMO cod_int_ajuste
 * para que a recuperacao de 1035 do cliente OMIE deduplique a 2a chamada (mesma
 * tecnica do STK-01 na aprovacao, PR #65). Diferente da aprovacao (que ancora em
 * apPre.id), aqui nao existe entidade persistida antes do OMIE — o opId e derivado
 * da chave estavel da operacao (NF normalizada + empresa + produto).
 *
 * A chave ja inclui o PRODUTO — por isso a feature 013 (multi-item) nao mudou
 * nada aqui: cada produto da NF gera seu proprio opId naturalmente.
 *
 * `tentativa` = quantas movimentacoes INATIVAS (soft-deleted) o PRODUTO ja teve
 * nesta NF: um reprocessamento legitimo apos estorno ganha opId NOVO (senao
 * herdaria os IDs do ajuste OMIE antigo via 1035), enquanto concorrentes da mesma
 * tentativa leem o mesmo contador e colidem no mesmo cod_int_ajuste — que e o
 * objetivo.
 *
 * movimentacao.op_id e uuid: o sha256 e reformatado como UUID (hex valido).
 */
export function opIdDeterministicoRecebimento(args: {
  nfNormalizada: string;
  cnpj: 'acxe' | 'q2p';
  codigoProdutoAcxe: number;
  tentativa: number;
}): string {
  const h = createHash('sha256')
    .update(`recebimento:${args.nfNormalizada}:${args.cnpj}:${args.codigoProdutoAcxe}:${args.tentativa}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Conta movimentacoes entrada_nf INATIVAS do PRODUTO nesta NF — o `tentativa` do
 * opId deterministico. Feature 013: por produto (antes era por NF inteira).
 */
async function contarTentativasAnteriores(
  db: ReturnType<typeof getDb>,
  nfNormalizada: string,
  cnpj: 'acxe' | 'q2p',
  produtoCodigoAcxe: number,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(movimentacao)
    .where(
      and(
        eq(movimentacao.notaFiscal, nfNormalizada),
        eq(movimentacao.tipoMovimento, 'entrada_nf'),
        eq(movimentacao.empresa, cnpj),
        eq(movimentacao.produtoCodigoAcxe, produtoCodigoAcxe),
        eq(movimentacao.ativo, false),
      ),
    )
    .limit(1);
  return Number(rows[0]?.n ?? 0);
}

/**
 * STK-01b: traducao do backstop 23505 do indice de idempotencia de entrada.
 * Se duas submissoes concorrentes passam pela checagem de idempotencia, o OMIE ja
 * deduplicou via cod_int_ajuste identico; a 2a transacao cai aqui.
 *
 * Distingue o indice NOVO (0046, por NF+empresa+produto) do ANTIGO (0044, por
 * NF+empresa): violacao do antigo numa NF multi-item significa que a migration
 * 0046 nao foi aplicada — o caller converte em erro operacional claro em vez de
 * marcar o produto como ja_recebido (o que deixaria o ajuste OMIE orfao).
 */
function constraintIdempotenciaViolada(err: unknown): 'nova' | 'antiga' | null {
  const candidatos = [err, (err as { cause?: unknown })?.cause];
  for (const c of candidatos) {
    const e = c as { code?: string; constraint?: string } | undefined;
    if (e?.code !== '23505') continue;
    if (e.constraint === 'movimentacao_nf_entrada_idempotencia_idx') return 'nova';
    if (e.constraint === 'movimentacao_nf_idempotencia_idx') return 'antiga';
  }
  return null;
}

export interface OmieAjusteErrorContext {
  /** IDs OMIE do ajuste ACXE quando ACXE sucedeu mas Q2P falhou. */
  idACXE?: { idMovest: string; idAjuste: string };
  /** UUID da operacao (movimentacao.opId) — derivado em cod_int_ajuste. */
  opId?: string;
  /** ID da movimentacao parcial gravada (apenas em pendente_q2p / pendente_acxe_faltando). */
  movimentacaoId?: string;
  /** True quando o estado e recuperavel via retry (Q2P falhou apos ACXE ok). */
  recoverable?: boolean;
  /**
   * Quantas retentativas o ATOR atual ainda pode fazer (operador maximo 1 alem da
   * inicial; admin sem limite). Calculado pelo caller que conhece o role.
   */
  tentativasRestantes?: number;
}

export class OmieAjusteError extends Error {
  public readonly idACXE?: { idMovest: string; idAjuste: string };
  public readonly opId?: string;
  public readonly movimentacaoId?: string;
  public readonly recoverable?: boolean;
  public readonly tentativasRestantes?: number;

  constructor(
    public readonly lado: 'acxe' | 'q2p',
    public readonly originalError: unknown,
    context?: OmieAjusteErrorContext,
  ) {
    super(`Falha ao incluir ajuste de estoque no OMIE ${lado.toUpperCase()}: ${(originalError as Error).message ?? 'erro desconhecido'}`);
    this.name = 'OmieAjusteError';
    this.idACXE = context?.idACXE;
    this.opId = context?.opId;
    this.movimentacaoId = context?.movimentacaoId;
    this.recoverable = context?.recoverable;
    this.tentativasRestantes = context?.tentativasRestantes;
  }
}

// ── Agregação e rateio (feature 013) ───────────────────────

/**
 * Uma linha "agregada" da NF: os det[] do OMIE colapsados por produto. Duas
 * linhas do MESMO produto na mesma NF (raro — 0 casos em 12 meses de PROD) são
 * somadas: a idempotência é por (NF, empresa, produto), então cada produto gera
 * exatamente uma entrada — a massa e o valor totais são preservados (FR-013).
 */
export interface ItemNfAgregado {
  nCodProd: number;
  xProd: string;
  codigoLocalEstoque: string;
  /** Quantidade fiscal total do produto, em kg (soma das linhas convertidas). */
  qtdNfKg: number;
  /** Valor comercial total das linhas (Σ vUnCom×qCom) — peso do rateio. */
  pesoValorComercial: number;
  /** Unidade da primeira linha (para exibição na fila). */
  unidadeOriginal: UnidadeMedida;
  /** Quantidade na unidade original da primeira linha (só exibição; se agregado, soma em kg). */
  qtdOriginal: number;
  /** vUnCom da primeira linha (custo unitário comercial — gravado em lote.custo_brl_kg como hoje). */
  vUnCom: number;
}

/** Colapsa os det[] da NF por produto (ver ItemNfAgregado). */
export function agruparItensNf(itens: ItemNF[]): ItemNfAgregado[] {
  const porProduto = new Map<number, ItemNfAgregado>();
  for (const it of itens) {
    const unidade = normalizarUnidade(it.uCom);
    const qtdKg = Number(new Decimal(converterParaKg(it.qCom, unidade)).toFixed(3));
    const peso = new Decimal(it.vUnCom).times(it.qCom);
    const atual = porProduto.get(it.nCodProd);
    if (!atual) {
      porProduto.set(it.nCodProd, {
        nCodProd: it.nCodProd,
        xProd: it.xProd,
        codigoLocalEstoque: it.codigoLocalEstoque,
        qtdNfKg: qtdKg,
        pesoValorComercial: peso.toNumber(),
        unidadeOriginal: unidade,
        qtdOriginal: it.qCom,
        vUnCom: it.vUnCom,
      });
    } else {
      atual.qtdNfKg = Number(new Decimal(atual.qtdNfKg).plus(qtdKg).toFixed(3));
      atual.pesoValorComercial = new Decimal(atual.pesoValorComercial).plus(peso).toNumber();
      // Linhas agregadas perdem a unidade original — exibe a soma em kg.
      atual.unidadeOriginal = 'kg';
      atual.qtdOriginal = atual.qtdNfKg;
    }
  }
  return [...porProduto.values()];
}

/**
 * Rateio do valor total da NF (com tributos — base de custo confirmada em 15/07)
 * entre os produtos, proporcional ao valor comercial de cada um (D2 do research).
 * O RESÍDUO de arredondamento vai para o último item, garantindo Σ = vNF exato
 * (SC-003). Para N=1 devolve [vNF] — reduz exatamente à fórmula single-item.
 * Pesos todos zero (NF sem valores comerciais) → rateio igualitário.
 */
export function ratearValorNf(vNF: number, pesos: number[]): number[] {
  if (pesos.length === 0) return [];
  const total = new Decimal(vNF);
  const somaPesos = pesos.reduce((acc, p) => acc.plus(p), new Decimal(0));
  const efetivos = somaPesos.gt(0) ? pesos.map((p) => new Decimal(p)) : pesos.map(() => new Decimal(1));
  const somaEfetiva = somaPesos.gt(0) ? somaPesos : new Decimal(pesos.length);

  const valores: number[] = [];
  let acumulado = new Decimal(0);
  for (let i = 0; i < efetivos.length; i += 1) {
    if (i === efetivos.length - 1) {
      valores.push(total.minus(acumulado).toDecimalPlaces(2).toNumber());
    } else {
      const fatia = total.times(efetivos[i]!).div(somaEfetiva).toDecimalPlaces(2);
      valores.push(fatia.toNumber());
      acumulado = acumulado.plus(fatia);
    }
  }
  return valores;
}

// ── Fila ───────────────────────────────────────────────────

export interface FilaItemOmie {
  nf: string;
  tipo: SubtipoMovimento;
  cnpj: 'acxe' | 'q2p';
  produto: { codigo: number; nome: string };
  qtdOriginal: number;
  unidade: UnidadeMedida;
  qtdKg: number;
  localidadeCodigo: string;
  dtEmissao: string;
  /** Valor TOTAL do produto na NF em BRL (fatia rateada do vNF, com tributos) — feature 013. */
  custoBrl: number;
}

/**
 * Consulta a fila de NFs pendentes para recebimento.
 * No MVP, suporta dois modos:
 *  - Busca por NF especifica (parametro `nf`): consulta OMIE diretamente (padrao legado).
 *    Feature 013: devolve UM item por PRODUTO da NF (multi-item destravado); produtos
 *    ja recebidos ficam de fora (recebimento resumivel).
 *  - Lista completa (sem `nf`): retorna dados sinteticos em mock; em producao vai
 *    depender de sync de NFe pelo n8n (a ser wireado em fase futura).
 */
export async function getFilaOmie(params: {
  nf?: string;
  cnpj?: 'acxe' | 'q2p';
}): Promise<FilaItemOmie[]> {
  const db = getDb();

  // Caso 1: busca direta por NF + CNPJ (fluxo principal, herdado do legado)
  if (params.nf && params.cnpj) {
    // STK-12: importação é ACXE-only (ver ImportacaoApenasAcxeError).
    if (params.cnpj === 'q2p') {
      throw new ImportacaoApenasAcxeError();
    }
    const numero = Number(params.nf);
    if (!Number.isFinite(numero) || numero <= 0) {
      return [];
    }
    const nfNormalizada = normalizarNumeroNf(params.nf);

    // Historico legado PHP: NF inteira ja processada → nada a receber.
    if (await nfProcessadaNoLegado(db, nfNormalizada)) {
      return [];
    }

    const omieData = await consultarNF(params.cnpj, numero);
    // Feature 012: bloqueia NF cancelada / não-emitida-pela-ACXE (fail-open se indeterminado).
    // Lê da tbl_nf_header sincronizada (flag cancelada + CNPJ do emitente), não do retorno ao vivo.
    await aplicarValidacaoNf(numero, params.cnpj);

    const agregados = agruparItensNf(omieData.itens);
    const valores = ratearValorNf(omieData.vNF, agregados.map((a) => a.pesoValorComercial));
    const tipo = inferirSubtipoEntrada(omieData);

    // Recebimento resumivel: produto ja recebido sai da fila; os demais aparecem.
    const pendencias = await Promise.all(
      agregados.map((a) => produtoDaNfJaRecebido(db, nfNormalizada, params.cnpj!, a.nCodProd)),
    );

    return agregados
      .map((a, i) => ({ agregado: a, valorRateado: valores[i]!, jaRecebido: pendencias[i]! }))
      .filter((x) => !x.jaRecebido)
      .map(({ agregado, valorRateado }) => ({
        nf: String(omieData.nNF),
        tipo,
        cnpj: params.cnpj!,
        produto: { codigo: agregado.nCodProd, nome: agregado.xProd },
        qtdOriginal: agregado.qtdOriginal,
        unidade: agregado.unidadeOriginal,
        qtdKg: agregado.qtdNfKg,
        localidadeCodigo: agregado.codigoLocalEstoque,
        dtEmissao: omieData.dEmi,
        custoBrl: valorRateado,
      }));
  }

  // Sem NF: o caminho da fila real e getFilaPendente() — a rota decide.
  return [];
}

// ── Fila de recebimento em modo real (feature 014, ACXEGDP-299) ─────────────

/**
 * Um item da fila real: uma NF filhote mapeada, emitida e com produto pendente.
 * Resumo por NF — o detalhe por produto (FilaItemOmie) so existe apos a consulta
 * OMIE ao vivo, disparada quando o operador seleciona o item (busca por NF).
 */
export interface FilaQueueItem {
  nfFilhote: string;
  pedidoAcxeOmie: string;
  produtosTotal: number;
  produtosPendentes: number;
  quantidadePendenteKg: number;
  dtEmissao: string;
  diasDesdeEmissao: number;
}

/**
 * Lista as NFs filhote pendentes de recebimento — o "Caso 2" que era um stub
 * (`return []`) desde a phase 3.5. Fonte: stockbridge.nf_pedido_mapa/filhote
 * (feature 011, mantidas pelo n8n a partir da FUP do Comex), cruzadas AO VIVO
 * com o espelho OMIE — nunca confiar em mapa.ativo isolado (mapa "zumbi" e
 * inofensivo aqui: sem produto pendente, nao gera item).
 *
 * Exclusoes estruturais (US3): NF mae nunca aparece (so itera filhotes);
 * cancelada/deletada fora (nfValidaSql); nao sincronizada fora (JOIN em
 * tbl_nf_header exige n_id_nf). Granularidade POR PRODUTO (produtoPendenteSql):
 * NF parcialmente recebida (feature 013, resumivel) permanece na fila com a
 * contagem do que falta. Ordenacao: emissao mais antiga primeiro.
 *
 * Principio II: leitura 100% do espelho Postgres — zero chamada OMIE ao vivo.
 */
export async function getFilaPendente(): Promise<FilaQueueItem[]> {
  const pool = getPool();
  const nfValida = nfValidaSql(await colunaCanceladaExiste(pool), 'h');
  const pendente = produtoPendenteSql({
    nfExpr: "LPAD(f.nf_filhote, 8, '0')",
    produtoExpr: 'i.n_cod_prod',
    nIdRecebExpr: 'h.n_id_receb',
  });

  interface FilaPendenteRow {
    nf_filhote: string;
    pedido_acxe_omie: string;
    produtos_total: number;
    produtos_pendentes: number;
    quantidade_pendente_kg: number | null;
    dt_emissao: string;
    dias_desde_emissao: number;
  }

  try {
    const res = await pool.query<FilaPendenteRow>(`
      SELECT
        f.nf_filhote                                                   AS nf_filhote,
        mapa.pedido_acxe_omie                                          AS pedido_acxe_omie,
        COUNT(*)::int                                                  AS produtos_total,
        COUNT(*) FILTER (WHERE ${pendente})::int                       AS produtos_pendentes,
        SUM(i.q_com) FILTER (WHERE ${pendente})::float8                AS quantidade_pendente_kg,
        h.d_emi::text                                                  AS dt_emissao,
        (CURRENT_DATE - h.d_emi::date)::int                            AS dias_desde_emissao
      FROM stockbridge.nf_pedido_mapa mapa
      JOIN stockbridge.nf_pedido_filhote f ON f.mapa_id = mapa.id AND f.ativo = true
      JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote, 8, '0')
      JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
      WHERE mapa.ativo = true
        ${nfValida}
      GROUP BY f.nf_filhote, mapa.pedido_acxe_omie, h.d_emi
      HAVING COUNT(*) FILTER (WHERE ${pendente}) > 0
      ORDER BY h.d_emi ASC, f.nf_filhote ASC
    `);

    return res.rows.map((r) => ({
      nfFilhote: r.nf_filhote,
      pedidoAcxeOmie: r.pedido_acxe_omie,
      produtosTotal: Number(r.produtos_total),
      produtosPendentes: Number(r.produtos_pendentes),
      quantidadePendenteKg: r.quantidade_pendente_kg != null ? Number(r.quantidade_pendente_kg) : 0,
      dtEmissao: r.dt_emissao,
      diasDesdeEmissao: Number(r.dias_desde_emissao),
    }));
  } catch (err) {
    // Fila e informativa — falha de banco nao pode derrubar a tela de recebimento
    // (a busca por NF continua funcionando). Loga e devolve vazio.
    logger.warn({ err: (err as Error).message }, 'getFilaPendente falhou — retornando vazio');
    return [];
  }
}

// ── Recebimento (multi-item, feature 013) ──────────────────

/** Um produto da NF conferido pelo operador (linha do formulario). */
export interface ItemRecebimentoImportacaoInput {
  /** Identifica a linha da NF (veio da fila). */
  produtoCodigoAcxe: number;
  quantidadeInput: number;
  unidadeInput: UnidadeMedida;
  localidadeId: string;
  observacoes?: string;
  /** Operador escolhe (Faltando|Varredura) quando ha divergencia. Obrigatorio se houver delta. */
  tipoDivergencia?: 'faltando' | 'varredura';
}

export interface ProcessarRecebimentoInput {
  nf: string;
  cnpj: 'acxe' | 'q2p';
  itens: ItemRecebimentoImportacaoInput[];
  userId: string;
}

export type StatusItemRecebimento =
  | 'provisorio'
  | 'aguardando_aprovacao'
  | 'pendente_q2p'
  | 'falha_acxe'
  | 'ja_recebido';

export interface ItemRecebimentoResult {
  produtoCodigoAcxe: number;
  /** Descrição do produto (para a UI — ACXEGDP-313: nunca só o código). */
  produto: string;
  status: StatusItemRecebimento;
  loteId?: string;
  loteCodigo?: string;
  movimentacaoId?: string;
  aprovacaoId?: string;
  deltaKg?: number;
  tipoDivergencia?: 'faltando' | 'varredura';
  omie?: {
    acxe?: { idMovest: string; idAjuste: string };
    q2p?: { idMovest: string; idAjuste: string };
  };
  mensagemErro?: string;
}

export interface ProcessarRecebimentoResult {
  nf: string;
  itens: ItemRecebimentoResult[];
  resumo: {
    recebidos: number;
    aguardandoAprovacao: number;
    pendentesOmie: number;
    falhas: number;
    jaRecebidos: number;
  };
}

/** Item pronto para o Portão 2: input do operador + linha da NF + correlação resolvida. */
interface ItemPreparado {
  input: ItemRecebimentoImportacaoInput;
  agregado: ItemNfAgregado;
  valorItemBrl: number;
  qtdFisicaKg: number;
  deltaKg: number;
  temDivergencia: boolean;
  correlacao: Correlacao;
  localidadeNome: string;
  fornecedorNome: string;
  correlacaoLocal: { codigoLocalEstoqueAcxe: number; codigoLocalEstoqueQ2p: number };
}

/**
 * Processa o recebimento de uma NF de importação com 1..N produtos (feature 013).
 *
 * Dois portões (D5 do research):
 *  - PORTÃO 1 — validação tudo-ou-nada: NF fiscal (cancelada/emitente), cobertura
 *    dos itens, quantidades, localidades e correlação ACXE↔Q2P de TODOS os
 *    produtos, ANTES de qualquer escrita no OMIE. Qualquer falha → erro tipado,
 *    zero efeito colateral (FR-009).
 *  - PORTÃO 2 — escrita best-effort por item: cada produto conferido entra pelo
 *    caminho do single-item (dual OMIE → lote provisório + movimentação; ou
 *    divergência → lote + aprovação). Falha de OMIE em um item vira pendência
 *    DAQUELE item (recuperável), sem derrubar os demais (FR-012).
 *
 * Idempotência por (NF, empresa, produto) — migration 0046: re-submeter uma NF
 * parcialmente recebida completa só os produtos faltantes (resumível).
 */
export async function processarRecebimento(
  input: ProcessarRecebimentoInput,
): Promise<ProcessarRecebimentoResult> {
  const db = getDb();
  // STK-12: importação é ACXE-only (ver ImportacaoApenasAcxeError).
  if (input.cnpj === 'q2p') {
    throw new ImportacaoApenasAcxeError();
  }
  // Normaliza para o formato OMIE (zero-padded 8 digitos para NFs numericas).
  // Reescreve input.nf para que toda a logica downstream use a forma canonica.
  input = { ...input, nf: normalizarNumeroNf(input.nf) };

  if (!input.itens || input.itens.length === 0) {
    throw new ValidacaoRecebimentoError('Informe pelo menos um item para o recebimento.');
  }
  const codigosInput = input.itens.map((i) => i.produtoCodigoAcxe);
  if (new Set(codigosInput).size !== codigosInput.length) {
    throw new ValidacaoRecebimentoError('Há produto repetido nos itens do recebimento — cada produto da NF entra uma única vez.');
  }

  // Historico legado PHP: NF inteira ja processada (dado antigo e por NF).
  if (await nfProcessadaNoLegado(db, input.nf)) {
    throw new NotaFiscalJaProcessadaError(input.nf);
  }

  // Consulta NF no OMIE (lado do CNPJ emissor) + validação fiscal (feature 012)
  // ANTES de qualquer escrita — bloqueio aqui garante zero efeito colateral.
  const omieData = await consultarNF(input.cnpj, Number(input.nf) || 0);
  await aplicarValidacaoNf(Number(input.nf) || 0, input.cnpj);

  const agregados = agruparItensNf(omieData.itens);
  const valores = ratearValorNf(omieData.vNF, agregados.map((a) => a.pesoValorComercial));
  const agregadoPorProduto = new Map(agregados.map((a, i) => [a.nCodProd, { agregado: a, valorItemBrl: valores[i]! }]));

  // ── PORTÃO 1 — validação tudo-ou-nada ──────────────────────────────────────

  // 1a. Todo item do request pertence à NF?
  for (const item of input.itens) {
    if (!agregadoPorProduto.has(item.produtoCodigoAcxe)) {
      throw new ValidacaoRecebimentoError(
        `O item informado (código de produto ${item.produtoCodigoAcxe}) não pertence à NF ${input.nf}. Recarregue a busca da NF.`,
      );
    }
  }

  // 1b. Idempotência por produto (resumível): separa o que já entrou.
  const statusJaRecebido = await Promise.all(
    input.itens.map((i) => produtoDaNfJaRecebido(db, input.nf, input.cnpj, i.produtoCodigoAcxe)),
  );
  const jaRecebidos = input.itens.filter((_, i) => statusJaRecebido[i]);
  const pendentesInput = input.itens.filter((_, i) => !statusJaRecebido[i]);
  if (pendentesInput.length === 0) {
    throw new NotaFiscalJaProcessadaError(input.nf);
  }

  // 1c. Cobertura: todo produto da NF ainda não recebido precisa estar no request
  // (recebimento parcial por escolha está fora de escopo — spec/Out of Scope).
  const codigosPendentesReq = new Set(pendentesInput.map((i) => i.produtoCodigoAcxe));
  const faltantes: string[] = [];
  for (const a of agregados) {
    if (codigosPendentesReq.has(a.nCodProd)) continue;
    const jaEntrou = await produtoDaNfJaRecebido(db, input.nf, input.cnpj, a.nCodProd);
    if (!jaEntrou) faltantes.push(a.xProd);
  }
  if (faltantes.length > 0) {
    throw new ValidacaoRecebimentoError(
      `A NF ${input.nf} tem ${faltantes.length === 1 ? 'um produto que não foi informado' : 'produtos que não foram informados'} no recebimento: ` +
        `${faltantes.map((f) => `"${f}"`).join(', ')}. Confira todos os produtos da NF — o recebimento é da nota inteira.`,
    );
  }

  // 1d. Localidades (batch, únicas) — existência + correlação ACXE↔Q2P completa.
  const localidadeIds = [...new Set(pendentesInput.map((i) => i.localidadeId))];
  const [locs, corrs] = await Promise.all([
    db
      .select()
      .from(localidade)
      .where(and(inArray(localidade.id, localidadeIds), eq(localidade.ativo, true))),
    db.select().from(localidadeCorrelacao).where(inArray(localidadeCorrelacao.localidadeId, localidadeIds)),
  ]);
  const locPorId = new Map(locs.map((l) => [l.id, l]));
  const corrPorLocalidade = new Map(corrs.map((c) => [c.localidadeId, c]));
  for (const item of pendentesInput) {
    const loc = locPorId.get(item.localidadeId);
    if (!loc) {
      // ACXEGDP-313: sem UUID na mensagem — não identifica nada para o operador.
      logger.warn({ localidadeId: item.localidadeId, nf: input.nf }, 'Localidade não encontrada ou inativa');
      throw new ValidacaoRecebimentoError(
        'Local de estoque selecionado não encontrado ou inativo — atualize a página e tente novamente',
      );
    }
    const corr = corrPorLocalidade.get(item.localidadeId);
    if (!corr || !corr.codigoLocalEstoqueAcxe || !corr.codigoLocalEstoqueQ2p) {
      throw new ValidacaoRecebimentoError(
        `Localidade ${loc.codigo} não tem correlação ACXE↔Q2P completa. Configure em stockbridge.localidade_correlacao.`,
      );
    }
  }

  // 1e. Quantidades: divergência por item (tolerância de 1 kg, como o single-item)
  // + regras de excedente e motivo obrigatório — TUDO validado antes de escrever.
  const preparados: ItemPreparado[] = [];
  for (const item of pendentesInput) {
    const { agregado, valorItemBrl } = agregadoPorProduto.get(item.produtoCodigoAcxe)!;
    const qtdFisicaKg = Number(new Decimal(converterParaKg(item.quantidadeInput, item.unidadeInput)).toFixed(3));
    const deltaKg = Number(new Decimal(qtdFisicaKg).minus(agregado.qtdNfKg).toFixed(3));
    const temDivergencia = Math.abs(deltaKg) > 1;
    if (temDivergencia) {
      // Fiel ao legado (NotaFiscalController.php:307): so aceita "recebido < NF".
      if (deltaKg > 0) {
        throw new QuantidadeExcedeNfError(agregado.xProd);
      }
      if (!item.observacoes || item.observacoes.trim().length === 0) {
        throw new ValidacaoRecebimentoError(`Motivo da divergência é obrigatório (produto "${agregado.xProd}").`);
      }
      if (!item.tipoDivergencia) {
        throw new ValidacaoRecebimentoError(
          `Tipo de divergência (faltando/varredura) é obrigatório quando há delta (produto "${agregado.xProd}").`,
        );
      }
    }
    const corr = corrPorLocalidade.get(item.localidadeId)!;
    preparados.push({
      input: item,
      agregado,
      valorItemBrl,
      qtdFisicaKg,
      deltaKg,
      temDivergencia,
      correlacao: null as unknown as Correlacao, // preenchida em 1f
      localidadeNome: locPorId.get(item.localidadeId)!.nome,
      fornecedorNome: omieData.cRazao,
      correlacaoLocal: {
        codigoLocalEstoqueAcxe: corr.codigoLocalEstoqueAcxe!,
        codigoLocalEstoqueQ2p: corr.codigoLocalEstoqueQ2p!,
      },
    });
  }

  // 1f. Correlação de produto ACXE↔Q2P de TODOS os itens (tudo-ou-nada, FR-009):
  // um produto sem correlato bloqueia a NF inteira, com alerta ops por produto.
  const semCorrelato: Array<{ codigoProdutoAcxe: number; descricao: string }> = [];
  for (const prep of preparados) {
    try {
      prep.correlacao = await getCorrelacao(prep.agregado.nCodProd, prep.correlacaoLocal.codigoLocalEstoqueAcxe);
    } catch (err) {
      if (err instanceof CorrelacaoNaoEncontradaError) {
        semCorrelato.push({ codigoProdutoAcxe: prep.agregado.nCodProd, descricao: prep.agregado.xProd });
        void enviarAlertaProdutoSemCorrelato({
          codigoProdutoAcxe: prep.agregado.nCodProd,
          notaFiscal: input.nf,
          descricaoProduto: prep.agregado.xProd,
        });
      } else {
        throw err;
      }
    }
  }
  if (semCorrelato.length > 0) {
    throw new ProdutosSemCorrelatoError(input.nf, semCorrelato);
  }

  // ── PORTÃO 2 — escrita best-effort por item ────────────────────────────────

  const resultados: ItemRecebimentoResult[] = jaRecebidos.map((i) => ({
    produtoCodigoAcxe: i.produtoCodigoAcxe,
    produto: agregadoPorProduto.get(i.produtoCodigoAcxe)!.agregado.xProd,
    status: 'ja_recebido' as const,
  }));

  const divergentesOk: Array<{ prep: ItemPreparado; aprovacaoId: string; loteCodigo: string }> = [];
  const concluidosOk: Array<{ prep: ItemPreparado; loteCodigo: string }> = [];

  for (const prep of preparados) {
    if (prep.temDivergencia) {
      const r = await processarItemComDivergencia(db, input, prep);
      resultados.push(r);
      if (r.status === 'aguardando_aprovacao') {
        divergentesOk.push({ prep, aprovacaoId: r.aprovacaoId!, loteCodigo: r.loteCodigo! });
      }
    } else {
      const r = await processarItemLimpo(db, input, prep, { multiItem: preparados.length > 1 });
      resultados.push(r);
      if (r.status === 'provisorio') {
        concluidosOk.push({ prep, loteCodigo: r.loteCodigo! });
      }
    }
  }

  // ── Notificações consolidadas (fora do caminho crítico) ────────────────────

  if (divergentesOk.length === 1) {
    // Paridade com o single-item: 1 divergência = alerta individual com link.
    const { prep, aprovacaoId, loteCodigo } = divergentesOk[0]!;
    const observacoes = prep.input.observacoes?.trim();
    void enviarAlertaAprovacaoPendente({
      aprovacaoId,
      tipoAprovacao: 'recebimento_divergencia',
      nivel: 'gestor',
      loteCodigo,
      produto: prep.correlacao.descricao,
      quantidadeKg: prep.qtdFisicaKg,
      // ACXEGDP-176: delta formatado em pt-BR via fmtKg — o toFixed(3) antigo
      // gerava "25.000 kg" no e-mail, lido como vinte e cinco mil quilos.
      detalhes: `Divergência ${prep.input.tipoDivergencia} de ${fmtKg(Math.abs(prep.deltaKg))}${observacoes ? ` — ${observacoes}` : ''}`,
    });
  } else if (divergentesOk.length > 1) {
    // Feature 013 (FR-015): digest — um e-mail por gestor com todos os itens da NF.
    void enviarAlertaAprovacaoPendenteImportacaoLote({
      notaFiscal: input.nf,
      nivel: 'gestor',
      itens: divergentesOk.map(({ prep }) => ({
        produto: prep.correlacao.descricao,
        quantidadeKg: prep.qtdFisicaKg,
        deltaKg: prep.deltaKg,
        tipoDivergencia: prep.input.tipoDivergencia!,
      })),
    });
  }

  if (concluidosOk.length === 1 && preparados.length === 1) {
    // Paridade com o single-item: NF de um produto mantém a confirmação atual.
    const { prep, loteCodigo } = concluidosOk[0]!;
    void enviarNotificacaoRecebimentoConcluido({
      operadorUserId: input.userId,
      loteCodigo,
      notaFiscal: input.nf,
      produto: prep.correlacao.descricao,
      quantidadeKg: prep.qtdFisicaKg,
      fornecedor: omieData.cRazao ?? null,
      localidade: prep.localidadeNome,
    });
  } else if (concluidosOk.length > 0) {
    void enviarNotificacaoRecebimentoConcluidoLote({
      operadorUserId: input.userId,
      notaFiscal: input.nf,
      fornecedor: omieData.cRazao ?? null,
      itens: concluidosOk.map(({ prep, loteCodigo }) => ({
        loteCodigo,
        produto: prep.correlacao.descricao,
        quantidadeKg: prep.qtdFisicaKg,
        localidade: prep.localidadeNome,
      })),
    });
  }

  const resumo = {
    recebidos: resultados.filter((r) => r.status === 'provisorio').length,
    aguardandoAprovacao: resultados.filter((r) => r.status === 'aguardando_aprovacao').length,
    pendentesOmie: resultados.filter((r) => r.status === 'pendente_q2p').length,
    falhas: resultados.filter((r) => r.status === 'falha_acxe').length,
    jaRecebidos: resultados.filter((r) => r.status === 'ja_recebido').length,
  };

  return { nf: input.nf, itens: resultados, resumo };
}

/**
 * Caminho limpo de UM produto (T009): dual OMIE → lote provisório + movimentação.
 * É a lógica single-item de sempre, parametrizada por item — preserva opId
 * determinístico, recuperação de pendência Q2P e o backstop 23505.
 * Nunca lança para falha de OMIE: devolve o desfecho no resultado (Portão 2).
 */
async function processarItemLimpo(
  db: ReturnType<typeof getDb>,
  input: ProcessarRecebimentoInput,
  prep: ItemPreparado,
  opts: { multiItem: boolean },
): Promise<ItemRecebimentoResult> {
  const { agregado, correlacao, valorItemBrl, qtdFisicaKg } = prep;
  const base: Pick<ItemRecebimentoResult, 'produtoCodigoAcxe' | 'produto'> = {
    produtoCodigoAcxe: agregado.nCodProd,
    produto: agregado.xProd,
  };

  // STK-01b: deterministico por (NF, empresa, PRODUTO, tentativa) — concorrentes
  // colidem no mesmo cod_int_ajuste e a recuperacao 1035 deduplica no OMIE.
  const tentativa = await contarTentativasAnteriores(db, input.nf, input.cnpj, agregado.nCodProd);
  const opId = opIdDeterministicoRecebimento({
    nfNormalizada: input.nf,
    cnpj: input.cnpj,
    codigoProdutoAcxe: correlacao.codigoProdutoAcxe,
    tentativa,
  });

  let idACXE: { idMovest: string; idAjuste: string };
  let idQ2P: { idMovest: string; idAjuste: string } | null = null;
  let pendenciaQ2P: { erro: OmieAjusteError } | null = null;
  try {
    const dualRes = await executarAjusteOmieDual({
      opId,
      codigoLocalEstoqueAcxeOrigem: agregado.codigoLocalEstoque,
      codigoLocalEstoqueAcxeDestino: prep.correlacaoLocal.codigoLocalEstoqueAcxe,
      codigoLocalEstoqueQ2p: prep.correlacaoLocal.codigoLocalEstoqueQ2p,
      codigoProdutoAcxe: correlacao.codigoProdutoAcxe,
      codigoProdutoQ2p: correlacao.codigoProdutoQ2p,
      quantidadeKg: qtdFisicaKg,
      valorUnitarioAcxe: calcularValorUnitarioAcxe(valorItemBrl, agregado.qtdNfKg),
      valorUnitarioQ2p: calcularValorUnitarioQ2p(valorItemBrl, agregado.qtdNfKg),
      notaFiscal: input.nf,
      observacaoSufixo: 'sem divergências',
    });
    idACXE = dualRes.idACXE;
    idQ2P = dualRes.idQ2P;
  } catch (err) {
    // ACXE falha: nada foi escrito para este item — desfecho falha_acxe, os
    // demais itens da NF seguem (re-submeter completa só os faltantes).
    if (err instanceof OmieAjusteError && err.lado === 'acxe') {
      logger.error({ nf: input.nf, produto: agregado.nCodProd, err: err.message }, 'Item falhou no ajuste ACXE');
      return { ...base, status: 'falha_acxe', mensagemErro: err.message };
    }
    // Q2P falha apos ACXE ok: temos idACXE no erro, persistiremos movimentacao parcial.
    if (err instanceof OmieAjusteError && err.lado === 'q2p' && err.idACXE) {
      idACXE = err.idACXE;
      pendenciaQ2P = { erro: err };
    } else {
      throw err;
    }
  }

  // Persistir lote + movimentacao em uma transacao (pode ser completa ou parcial)
  let resultado: { loteId: string; loteCodigo: string; movimentacaoId: string };
  try {
    resultado = await db.transaction(async (tx) => {
      const codigo = await proximoCodigoLote(tx, 'L');
      const [loteCriado] = await tx
        .insert(lote)
        .values({
          codigo,
          produtoCodigoAcxe: correlacao.codigoProdutoAcxe,
          produtoCodigoQ2p: correlacao.codigoProdutoQ2p,
          fornecedorNome: prep.fornecedorNome,
          quantidadeFisicaKg: String(qtdFisicaKg),
          quantidadeFiscalKg: String(agregado.qtdNfKg),
          custoBrlKg: agregado.vUnCom > 0 ? String(agregado.vUnCom) : null,
          // Feature 013 (D3): valor rateado DESTE produto (com tributos) — para NF
          // de item unico continua igual ao vNF (rateio de 1 = total).
          valorTotalNfBrl: valorItemBrl > 0 ? String(valorItemBrl) : null,
          codigoLocalEstoqueOrigemAcxe: agregado.codigoLocalEstoque,
          status: 'provisorio',
          estagioTransito: null,
          localidadeId: prep.input.localidadeId,
          cnpj: input.cnpj === 'acxe' ? 'Acxe Matriz' : 'Q2P Matriz',
          notaFiscal: input.nf,
          manual: false,
          dtEntrada: new Date().toISOString().slice(0, 10),
        })
        .returning();

      const [movCriada] = await tx
        .insert(movimentacao)
        .values({
          notaFiscal: input.nf,
          tipoMovimento: 'entrada_nf',
          subtipo: inferirSubtipoPorNumeroNf(input.nf),
          loteId: loteCriado!.id,
          // STK-09 + feature 013: empresa E produto participam da chave de
          // idempotencia (migrations 0044 + 0046).
          empresa: input.cnpj,
          produtoCodigoAcxe: correlacao.codigoProdutoAcxe,
          produtoCodigoQ2p: correlacao.codigoProdutoQ2p,
          quantidadeKg: String(qtdFisicaKg),
          mvAcxe: 1,
          dtAcxe: new Date(),
          idMovestAcxe: idACXE.idMovest,
          idAjusteAcxe: idACXE.idAjuste,
          idUserAcxe: input.userId,
          mvQ2p: pendenciaQ2P ? null : 1,
          dtQ2p: pendenciaQ2P ? null : new Date(),
          idMovestQ2p: idQ2P?.idMovest ?? null,
          idAjusteQ2p: idQ2P?.idAjuste ?? null,
          idUserQ2p: pendenciaQ2P ? null : input.userId,
          observacoes: prep.input.observacoes ?? null,
          opId,
          statusOmie: pendenciaQ2P ? 'pendente_q2p' : 'concluida',
          tentativasQ2p: pendenciaQ2P ? 1 : 0,
          ultimoErroOmie: pendenciaQ2P
            ? {
                lado: 'q2p',
                mensagem: (pendenciaQ2P.erro.originalError as Error)?.message ?? 'erro desconhecido',
                timestamp: new Date().toISOString(),
              }
            : null,
        })
        .returning();

      return { loteId: loteCriado!.id, loteCodigo: loteCriado!.codigo, movimentacaoId: movCriada!.id };
    });
  } catch (err: unknown) {
    const viol = constraintIdempotenciaViolada(err);
    // STK-01b: concorrente perdeu a corrida no indice de idempotencia — o OMIE ja
    // foi deduplicado via cod_int_ajuste identico; o produto ja esta recebido.
    if (viol === 'nova' || (viol === 'antiga' && !opts.multiItem)) {
      return { ...base, status: 'ja_recebido' };
    }
    if (viol === 'antiga') {
      // Indice antigo (por NF+empresa) numa NF multi-item: a migration 0046 nao
      // foi aplicada neste banco. NAO pode virar ja_recebido — o ajuste OMIE
      // deste produto acabou de ser feito e ficaria orfao e invisivel. Erro
      // explicito (500) para acionar o admin; os itens ja concluidos estao
      // persistidos e idempotentes (re-buscar a NF mostra o que falta).
      logger.error(
        { nf: input.nf, produto: agregado.nCodProd },
        'Migration 0046 ausente: indice de idempotencia por produto nao existe — NF multi-item interrompida apos ajuste OMIE',
      );
      throw new Error(
        `O banco ainda não suporta NF com múltiplos produtos (migration 0046 pendente). ` +
          `O ajuste do produto "${agregado.xProd}" foi feito no OMIE mas não pôde ser registrado na plataforma — ` +
          'acione o administrador antes de tentar novamente.',
      );
    }
    throw err;
  }

  if (pendenciaQ2P) {
    // Notifica ops fora do caminho critico; o item fica recuperavel no painel de
    // movimentacoes pendentes (retry por movimentacao). Os DEMAIS itens seguem.
    void enviarAlertaPendenciaOmie({
      movimentacaoId: resultado.movimentacaoId,
      opId,
      notaFiscal: input.nf,
      ladoPendente: 'q2p',
      mensagemErro: (pendenciaQ2P.erro.originalError as Error)?.message ?? 'erro desconhecido',
      tentativas: 1,
    });
    return {
      ...base,
      status: 'pendente_q2p',
      loteId: resultado.loteId,
      loteCodigo: resultado.loteCodigo,
      movimentacaoId: resultado.movimentacaoId,
      omie: { acxe: idACXE },
      mensagemErro: (pendenciaQ2P.erro.originalError as Error)?.message ?? 'erro desconhecido',
    };
  }

  return {
    ...base,
    status: 'provisorio',
    loteId: resultado.loteId,
    loteCodigo: resultado.loteCodigo,
    movimentacaoId: resultado.movimentacaoId,
    omie: { acxe: idACXE, q2p: idQ2P! },
  };
}

/**
 * Caminho divergente de UM produto: lote aguardando_aprovacao + aprovacao
 * (recebimento_divergencia) — NÃO toca OMIE (o dual acontece na aprovação do
 * gestor, por item). A notificação é consolidada pelo caller (FR-015).
 */
async function processarItemComDivergencia(
  db: ReturnType<typeof getDb>,
  input: ProcessarRecebimentoInput,
  prep: ItemPreparado,
): Promise<ItemRecebimentoResult> {
  const { agregado, correlacao, valorItemBrl, qtdFisicaKg, deltaKg } = prep;

  const resultado = await db.transaction(async (tx) => {
    const codigo = await proximoCodigoLote(tx, 'L');
    const [loteCriado] = await tx
      .insert(lote)
      .values({
        codigo,
        produtoCodigoAcxe: correlacao.codigoProdutoAcxe,
        produtoCodigoQ2p: correlacao.codigoProdutoQ2p,
        fornecedorNome: prep.fornecedorNome,
        quantidadeFisicaKg: String(qtdFisicaKg),
        quantidadeFiscalKg: String(agregado.qtdNfKg),
        custoBrlKg: agregado.vUnCom > 0 ? String(agregado.vUnCom) : null,
        // Feature 013 (D3): valor rateado do produto — a aprovação recomputa o
        // valor/kg a partir de valor_total_nf_brl / quantidade_fiscal_kg.
        valorTotalNfBrl: valorItemBrl > 0 ? String(valorItemBrl) : null,
        codigoLocalEstoqueOrigemAcxe: agregado.codigoLocalEstoque,
        status: 'aguardando_aprovacao',
        localidadeId: prep.input.localidadeId,
        cnpj: input.cnpj === 'acxe' ? 'Acxe Matriz' : 'Q2P Matriz',
        notaFiscal: input.nf,
        manual: false,
        dtEntrada: new Date().toISOString().slice(0, 10),
      })
      .returning();

    const [aprovCriada] = await tx
      .insert(aprovacao)
      .values({
        loteId: loteCriado!.id,
        precisaNivel: 'gestor',
        tipoAprovacao: 'recebimento_divergencia',
        quantidadePrevistaKg: String(agregado.qtdNfKg),
        quantidadeRecebidaKg: String(qtdFisicaKg),
        tipoDivergencia: prep.input.tipoDivergencia!,
        observacoes: prep.input.observacoes ?? null,
        lancadoPor: input.userId,
      })
      .returning();

    return { loteId: loteCriado!.id, loteCodigo: loteCriado!.codigo, aprovacaoId: aprovCriada!.id };
  });

  return {
    produtoCodigoAcxe: agregado.nCodProd,
    produto: agregado.xProd,
    status: 'aguardando_aprovacao',
    loteId: resultado.loteId,
    loteCodigo: resultado.loteCodigo,
    aprovacaoId: resultado.aprovacaoId,
    deltaKg,
    tipoDivergencia: prep.input.tipoDivergencia,
  };
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Executa o par de ajustes OMIE (ACXE transferencia + Q2P entrada) usado tanto em
 * recebimento sem divergencia quanto em aprovacao de divergencia. Se ACXE sucesso
 * mas Q2P falhar, dispara ALERTA no log (ajuste ACXE ficou "no ar" no ERP — requer
 * intervencao manual). Nao toca no BD — o caller decide como persistir.
 *
 * Fiel ao legado PHP (NotaFiscalService::transfereEstoqueSemDivergenciaService +
 * Q2PRecebimentoIncluirAjusteEstoqueSemDivergenciaService):
 *  - ACXE: transferencia (TRF/TRF) do estoque em transito (origem) para o destino
 *    escolhido pelo usuario, com valor unitario = vUnCom da NF.
 *  - Q2P: entrada inicial (ENT/INI) no local correlato, com valor unitario "total"
 *    = ceil((vNF / qtdNfKg) * 1.145 * 100) / 100 (markup interno de 14.5%).
 */
export async function executarAjusteOmieDual(args: {
  opId: string;
  codigoLocalEstoqueAcxeOrigem: string;
  codigoLocalEstoqueAcxeDestino: number;
  codigoLocalEstoqueQ2p: number;
  codigoProdutoAcxe: number;
  codigoProdutoQ2p: number;
  quantidadeKg: number;
  valorUnitarioAcxe: number;
  valorUnitarioQ2p: number;
  notaFiscal: string;
  observacaoSufixo: string;
  /** Em retry de operacao pendente, true para evitar duplicacao via ListarAjusteEstoque. */
  verificarAntes?: boolean;
}): Promise<{ idACXE: { idMovest: string; idAjuste: string }; idQ2P: { idMovest: string; idAjuste: string } }> {
  const verificarAntes = args.verificarAntes ?? false;
  let idACXE: { idMovest: string; idAjuste: string };
  try {
    const acxeRes = await incluirAjusteIdempotente(
      'acxe',
      buildCodIntAjuste(args.opId, COD_INT_AJUSTE_SUFIXO.acxeTrf),
      {
        codigoLocalEstoque: args.codigoLocalEstoqueAcxeOrigem,
        codigoLocalEstoqueDestino: String(args.codigoLocalEstoqueAcxeDestino),
        idProduto: args.codigoProdutoAcxe,
        dataAtual: formatarDataOmie(),
        quantidade: args.quantidadeKg,
        observacao: `Recebimento NF ${args.notaFiscal} ${args.observacaoSufixo}`,
        origem: 'AJU',
        tipo: 'TRF',
        motivo: 'TRF',
        valor: args.valorUnitarioAcxe,
      },
      { verificarAntes },
    );
    idACXE = { idMovest: acxeRes.idMovest, idAjuste: acxeRes.idAjuste };
  } catch (err) {
    throw new OmieAjusteError('acxe', err);
  }

  try {
    const q2pRes = await incluirAjusteIdempotente(
      'q2p',
      buildCodIntAjuste(args.opId, COD_INT_AJUSTE_SUFIXO.q2pEnt),
      {
        codigoLocalEstoque: String(args.codigoLocalEstoqueQ2p),
        idProduto: args.codigoProdutoQ2p,
        dataAtual: formatarDataOmie(),
        quantidade: args.quantidadeKg,
        observacao: `Recebimento NF ${args.notaFiscal} ${args.observacaoSufixo}`,
        origem: 'AJU',
        tipo: 'ENT',
        motivo: 'INI',
        valor: args.valorUnitarioQ2p,
      },
      { verificarAntes },
    );
    return { idACXE, idQ2P: { idMovest: q2pRes.idMovest, idAjuste: q2pRes.idAjuste } };
  } catch (err) {
    logger.error(
      { nf: args.notaFiscal, opId: args.opId, idACXE, err },
      'ALERTA: ajuste ACXE sucesso mas Q2P falhou. Persistirá movimentação parcial.',
    );
    throw new OmieAjusteError('q2p', err, {
      idACXE,
      opId: args.opId,
      recoverable: true,
    });
  }
}

/**
 * Transfere a quantidade DIVERGENTE (qtd_NF - qtd_recebida) do estoque de origem
 * (Extrema, normalmente) para um estoque especial ACXE de retencao — Faltando
 * (material sumiu) ou Varredura (material para inspecao).
 *
 * Fiel ao legado (NotaFiscalService linhas 198-272 e 383-460): segunda chamada ACXE
 * apos a transferencia principal para o galpao destino. Usa o mesmo valor unitario
 * com tributos embutidos (vNF/qtdNfKg). OMIE em TRF/TRF descarta o valor e usa
 * custo medio do origem — campo e informativo no log.
 */
export async function transferirDiferencaAcxe(args: {
  opId: string;
  codigoLocalEstoqueOrigem: string;
  codigoLocalEstoqueDiferenca: string; // resolvido por resolverEstoqueDiferencaAcxe()
  codigoProdutoAcxe: number;
  quantidadeKg: number; // diferenca positiva (qtd faltante)
  valorUnitarioAcxe: number;
  notaFiscal: string;
  observacaoSufixo: string;
  verificarAntes?: boolean;
}): Promise<{ idMovest: string; idAjuste: string }> {
  try {
    const res = await incluirAjusteIdempotente(
      'acxe',
      buildCodIntAjuste(args.opId, COD_INT_AJUSTE_SUFIXO.acxeFaltando),
      {
        codigoLocalEstoque: args.codigoLocalEstoqueOrigem,
        codigoLocalEstoqueDestino: args.codigoLocalEstoqueDiferenca,
        idProduto: args.codigoProdutoAcxe,
        dataAtual: formatarDataOmie(),
        quantidade: args.quantidadeKg,
        observacao: `Recebimento NF ${args.notaFiscal} ${args.observacaoSufixo}`,
        origem: 'AJU',
        tipo: 'TRF',
        motivo: 'TRF',
        valor: args.valorUnitarioAcxe,
      },
      { verificarAntes: args.verificarAntes ?? false },
    );
    return { idMovest: res.idMovest, idAjuste: res.idAjuste };
  } catch (err) {
    throw new OmieAjusteError('acxe', err);
  }
}

/**
 * Calcula o valor unitario "total" usado nos ajustes Q2P (legado:
 * `$vUnCom_Total = ceil(($vNF / $qtd_recebida_api * 1.145) * 100) / 100`).
 * Equivale ao unitario BRL/kg da NF acrescido de markup interno de 14,5%
 * (impostos/serviços) arredondado para cima a 2 casas.
 * Feature 013: em NF multi-item, `vNF` aqui é o valor RATEADO do produto — a
 * fórmula por item é idêntica à do single-item (para N=1, rateio = vNF total).
 */
export function calcularValorUnitarioQ2p(vNF: number, qtdNfKg: number): number {
  if (!Number.isFinite(vNF) || !Number.isFinite(qtdNfKg) || qtdNfKg <= 0) return 0;
  return Math.ceil((vNF / qtdNfKg) * 1.145 * 100) / 100;
}

/**
 * Calcula o valor unitario com tributos embutidos (vNF/qCom) usado no ajuste ACXE.
 * Correção sobre o legado: legado enviava `vUnCom` (valor base, sem tributos).
 * Agora enviamos `vNF/qtdNfKg` arredondado a 2 casas — auditoria mais fiel,
 * mesmo que OMIE em TRF/TRF acabe usando custo médio do estoque de origem.
 * Feature 013: em NF multi-item, `vNF` é o valor rateado do produto.
 */
export function calcularValorUnitarioAcxe(vNF: number, qtdNfKg: number): number {
  if (!Number.isFinite(vNF) || !Number.isFinite(qtdNfKg) || qtdNfKg <= 0) return 0;
  return Math.round((vNF / qtdNfKg) * 100) / 100;
}

export function normalizarUnidade(raw: string): UnidadeMedida {
  const u = raw.trim().toLowerCase();
  if (u === 't' || u === 'ton' || u === 'tonelada') return 't';
  if (u === 'kg' || u === 'quilo') return 'kg';
  if (u.includes('saco')) return 'saco';
  if (u.includes('big')) return 'bigbag';
  // STK-20: unidade não reconhecida cai em kg (default seguro p/ granel importado),
  // mas agora LOGA — antes sumia silenciosamente e um 't' abreviado esquisito viraria
  // kg sem rastro (risco de erro de 1000×). Decisão: manter kg + warn p/ revisão.
  logger.warn({ unidadeOriginal: raw }, 'Unidade OMIE desconhecida — assumindo kg');
  return 'kg';
}

/**
 * Heurística de subtipo de entrada pelo NÚMERO da NF (a OMIE não devolve tipo
 * estruturado). Exportada porque é usada em DOIS caminhos: o recebimento (via
 * inferirSubtipoEntrada) e a aprovação de divergência (STK-21) — que antes
 * hardcodava 'importacao', divergindo desta regra. Como só depende do número da
 * NF (persistido em lote.notaFiscal), o resultado é idêntico ao que uma coluna
 * subtipo no lote guardaria — daí o fix não precisar de migration.
 */
export function inferirSubtipoPorNumeroNf(nf: string): SubtipoMovimento {
  if (/^IMP[-/]/.test(nf)) return 'importacao';
  if (/^DEV[-/]/.test(nf)) return 'devolucao_cliente';
  if (/^CN[-/]/.test(nf)) return 'compra_nacional';
  return 'importacao';
}

function inferirSubtipoEntrada(omie: ConsultarNFResponse): SubtipoMovimento {
  return inferirSubtipoPorNumeroNf(String(omie.nNF));
}

async function proximoCodigoLote(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  prefixo: 'L' | 'T',
): Promise<string> {
  // Usa sequence Postgres dedicada (migration 0015). nextval() e atomico, sem race,
  // sem depender de MAX+1 — o anterior tinha bug (row.max retornando 0 mesmo com L001
  // existente) e ainda era vulneravel a colisao em concorrencia.
  // Numeros "pulam" em caso de rollback de tx — aceitavel para codigo de auditoria.
  const result = await tx.execute<{ next_val: string }>(
    sql`SELECT nextval('stockbridge.lote_codigo_seq')::text AS next_val`,
  );
  const proximo = Number(result.rows[0]?.next_val ?? '1');
  return `${prefixo}${String(proximo).padStart(3, '0')}`;
}
