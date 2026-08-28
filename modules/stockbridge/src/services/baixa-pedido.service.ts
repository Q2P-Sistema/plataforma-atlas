import { eq, and } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { getDb, getPool, getConfig, createLogger } from '@atlas/core';
import { movimentacao, lote, baixaPedidoQ2p } from '@atlas/db';
import {
  consultarPedidoCompra,
  alterarPedidoCompra,
  type PedidoCompraConsultado,
  type ItemPedidoCompra,
  type AlterarPedidoCompraInput,
} from '@atlas/integration-omie';
import { QTD_SENTINELA_PEDIDO_ZERADO_KG, type StatusBaixaPedidoQ2p } from '../types.js';
import { enviarAlertaBaixaPedidoQ2p } from './notificacao.service.js';
import { formatarDataOmie } from './omie-shared.js';

/**
 * Baixa do pedido de compra Q2P após recebimento de importação (ACXEGDP-344).
 *
 * O que o legado PHP fazia (NotaFiscalController::ajustarEstoquePedidoQ2P) e o
 * Atlas não fazia: depois que a NF entra (ajuste dual ACXE→Q2P concluído), a
 * quantidade recebida é DESCONTADA dos pedidos de compra da Q2P no OMIE via
 * `AlteraPedCompra`, FIFO por produto, até zerar a quantidade recebida.
 *
 * Diferenças deliberadas em relação ao legado:
 *  - Saldo ATUAL vem de `ConsultarPedCompra` ao vivo (o espelho
 *    `tbl_pedidosCompras_Q2P` sincroniza 1×/dia; o AlteraPedCompra manda
 *    quantidade ABSOLUTA, então ler saldo velho corrompe o pedido). O espelho
 *    só ENUMERA os candidatos (quais pedidos abertos existem para o produto).
 *  - Preferência pelo pedido Q2P que espelha o pedido ACXE da NF (mapa
 *    NF→pedido da feature 011 + "Pedido original ACXE: N" no cObs do pedido
 *    Q2P); os demais entram em FIFO por dDtPrevisao — cobertura do mapa ainda é
 *    parcial, então a FIFO continua sendo o caminho principal.
 *  - Ledger `stockbridge.baixa_pedido_q2p` por (movimentação, pedido): grava
 *    'pendente' ANTES da chamada OMIE e 'concluida' depois. Um retry compara o
 *    saldo ao vivo com o alvo gravado — se a chamada persistiu apesar de erro
 *    de resposta, NÃO desconta de novo (idempotência do valor absoluto).
 *  - Lock consultivo por produto: dois recebimentos do mesmo produto não
 *    interleiam consulta/alteração.
 *  - Sentinela 0,1 kg para "pedido zerado" (OMIE rejeita 0) — paridade.
 *
 * Desfechos por movimentação (`movimentacao.baixa_pedido_q2p`):
 *  concluida | sem_saldo (sobrou quantidade sem pedido aberto — alerta) |
 *  falha (OMIE falhou — alerta + retry pelo painel).
 */

const logger = createLogger('stockbridge:baixa-pedido');

/** Etapa do pedido de compra Q2P que representa "em aberto" (ver research da 344). */
export const ETAPA_PEDIDO_Q2P_ABERTO = '15';
const TOLERANCIA_KG = 0.0005;

export type OrigemBaixa = 'fluxo' | 'retry' | 'backfill';

/**
 * Cache de pedidos consultados AO VIVO, com escopo de UMA execução (o backfill
 * passa o mesmo mapa para todas as movimentações). Motivo: a OMIE rejeita
 * consultar o mesmo pedido em sequência curta com "Consumo redundante — aguarde
 * N segundos"; o client trata como transiente e espera, mas 60s × dezenas de
 * NFs do mesmo pedido tornaria o backfill inviável. Como é o próprio Atlas quem
 * altera o pedido, a entrada é ATUALIZADA após cada AlteraPedCompra — o saldo
 * em cache segue sendo o valor real, sem re-consultar.
 * Fora do backfill (fluxo/retry) o mapa não é passado, então o saldo é sempre
 * lido ao vivo — a garantia de saldo fresco não muda.
 */
export type CachePedidos = Map<number, PedidoCompraConsultado>;

// ── Erros tipados ──────────────────────────────────────────────────────────────

export class BaixaPedidoMovimentacaoNaoEncontradaError extends Error {
  constructor(public readonly movimentacaoId: string) {
    super(`Movimentação ${movimentacaoId} não encontrada`);
    this.name = 'BaixaPedidoMovimentacaoNaoEncontradaError';
  }
}

export class BaixaPedidoNaoAplicavelError extends Error {
  constructor(
    public readonly movimentacaoId: string,
    public readonly motivo: string,
  ) {
    super(`Baixa de pedido Q2P não se aplica à movimentação ${movimentacaoId}: ${motivo}`);
    this.name = 'BaixaPedidoNaoAplicavelError';
  }
}

// ── Alocador FIFO (puro) ───────────────────────────────────────────────────────

export interface PedidoCandidato {
  ncodped: number;
  cnumero: string | null;
  ncoditem: number | null;
  /** Saldo atual do item (kg). */
  saldoKg: number;
  /** true = pedido Q2P que espelha o pedido ACXE desta NF (entra primeiro). */
  preferido: boolean;
}

export interface AlocacaoPedido {
  ncodped: number;
  cnumero: string | null;
  ncoditem: number | null;
  kgAlocado: number;
  saldoAnteriorKg: number;
  /** Quantidade absoluta enviada ao OMIE (>= sentinela). */
  saldoNovoKg: number;
  /** true quando o pedido foi consumido por inteiro (fica com a sentinela). */
  zerado: boolean;
  preferido: boolean;
}

export interface PlanoAlocacao {
  alocacoes: AlocacaoPedido[];
  restanteKg: number;
}

function d3(n: Decimal | number): number {
  return new Decimal(n).toDecimalPlaces(3).toNumber();
}

/**
 * Distribui `kgADescontar` sobre os candidatos: preferidos primeiro (ordem
 * relativa preservada), depois os demais na ordem recebida (FIFO). Pedidos com
 * saldo <= sentinela são considerados zerados e pulados. Espelha a aritmética
 * do legado: se o saldo cobre o restante, novo = saldo − restante; senão o
 * pedido zera (sentinela) e o restante segue para o próximo.
 */
export function planejarAlocacao(kgADescontar: number, candidatos: PedidoCandidato[]): PlanoAlocacao {
  const ordenados = [...candidatos.filter((c) => c.preferido), ...candidatos.filter((c) => !c.preferido)];
  const alocacoes: AlocacaoPedido[] = [];
  let restante = new Decimal(kgADescontar);
  for (const cand of ordenados) {
    if (restante.lte(TOLERANCIA_KG)) break;
    const saldo = new Decimal(cand.saldoKg);
    if (saldo.lte(QTD_SENTINELA_PEDIDO_ZERADO_KG)) continue;
    const kg = Decimal.min(restante, saldo);
    const novoBruto = saldo.minus(kg);
    const zerado = novoBruto.lte(QTD_SENTINELA_PEDIDO_ZERADO_KG);
    alocacoes.push({
      ncodped: cand.ncodped,
      cnumero: cand.cnumero,
      ncoditem: cand.ncoditem,
      kgAlocado: d3(kg),
      saldoAnteriorKg: d3(saldo),
      saldoNovoKg: zerado ? QTD_SENTINELA_PEDIDO_ZERADO_KG : d3(novoBruto),
      zerado,
      preferido: cand.preferido,
    });
    restante = restante.minus(kg);
  }
  return {
    alocacoes,
    restanteKg: restante.lte(TOLERANCIA_KG) ? 0 : d3(restante),
  };
}

// ── Leitura do espelho / mapa ──────────────────────────────────────────────────

interface CandidatoEspelhoRow {
  ncodped: string;
  cnumero: string | null;
  ncoditem: string | null;
  nqtde: string;
  pedido_acxe: string | null;
}

/**
 * Enumera os pedidos Q2P ABERTOS do produto no espelho (etapa 15, saldo acima
 * da sentinela), ordenados por previsão de entrega (FIFO). O saldo aqui é só
 * indicativo — o serviço re-consulta cada pedido ao vivo antes de alterar.
 */
export async function listarPedidosAbertosQ2p(
  ncodprod: number,
  pedidosAcxePreferidos: ReadonlySet<string>,
): Promise<PedidoCandidato[]> {
  const pool = getPool();
  const res = await pool.query<CandidatoEspelhoRow>(
    `SELECT p.ncodped::text AS ncodped, p.cnumero, p.ncoditem::text AS ncoditem, p.nqtde::text AS nqtde,
            substring(p.cobs FROM 'Pedido original ACXE:\\s*(\\d+)') AS pedido_acxe
       FROM public."tbl_pedidosCompras_Q2P" p
      WHERE p.ncodprod = $1::bigint
        AND p.cetapa = $2
        AND p.nqtde > $3
      ORDER BY p.ddtprevisao NULLS LAST, p.dincdata NULLS LAST, p.ncodped`,
    [ncodprod, ETAPA_PEDIDO_Q2P_ABERTO, QTD_SENTINELA_PEDIDO_ZERADO_KG],
  );
  return res.rows.map((r) => ({
    ncodped: Number(r.ncodped),
    cnumero: r.cnumero ?? null,
    ncoditem: r.ncoditem != null ? Number(r.ncoditem) : null,
    saldoKg: Number(r.nqtde),
    preferido: r.pedido_acxe != null && pedidosAcxePreferidos.has(r.pedido_acxe),
  }));
}

/**
 * Pedido(s) ACXE de origem da NF: mapa NF mãe→filhotes (feature 011) e, como
 * reforço, `lote.pedido_compra_acxe`. Cobertura parcial — retorna vazio sem
 * erro quando não há mapeamento.
 */
export async function resolverPedidosAcxeDaNf(
  notaFiscal: string,
  pedidoCompraAcxeDoLote: string | null | undefined,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (pedidoCompraAcxeDoLote) out.add(String(pedidoCompraAcxeDoLote).replace(/^0+/, ''));
  try {
    const pool = getPool();
    const res = await pool.query<{ pedido_acxe_omie: string }>(
      `SELECT DISTINCT mp.pedido_acxe_omie
         FROM stockbridge.nf_pedido_filhote f
         JOIN stockbridge.nf_pedido_mapa mp ON mp.id = f.mapa_id
        WHERE f.ativo = true AND mp.ativo = true
          AND ltrim(f.nf_filhote, '0') = ltrim($1, '0')`,
      [notaFiscal],
    );
    for (const r of res.rows) out.add(String(r.pedido_acxe_omie).replace(/^0+/, ''));
  } catch (err) {
    logger.warn({ err, notaFiscal }, 'Falha ao resolver pedido ACXE da NF (mapa) — seguindo só com FIFO');
  }
  return out;
}

async function resolverDescricaoProdutoQ2p(ncodprod: number, fallback: string): Promise<string> {
  try {
    const res = await getPool().query<{ descricao: string | null }>(
      `SELECT descricao FROM public."tbl_produtos_Q2P" WHERE codigo_produto = $1::bigint LIMIT 1`,
      [ncodprod],
    );
    return res.rows[0]?.descricao?.trim() || fallback;
  } catch {
    return fallback;
  }
}

// ── Lock consultivo por produto ────────────────────────────────────────────────

const LOCK_PREFIXO = 'stockbridge:baixa_pedido_q2p:';

async function adquirirLockProduto(ncodprod: number): Promise<() => Promise<void>> {
  const pool = getPool();
  const client = await pool.connect();
  const chave = `${LOCK_PREFIXO}${ncodprod}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [chave]);
  } catch (err) {
    client.release();
    throw err;
  }
  return async () => {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [chave]);
    } finally {
      client.release();
    }
  };
}

// ── Montagem da chamada AlteraPedCompra ────────────────────────────────────────

function acharItemDoProduto(pedido: PedidoCompraConsultado, ncodprod: number): ItemPedidoCompra | null {
  return (
    pedido.produtos.find((p) => p.nCodProd === ncodprod) ??
    (pedido.produtos.length === 1 ? pedido.produtos[0]! : null)
  );
}

function fmtKgObs(kg: number): string {
  return new Decimal(kg).toDecimalPlaces(3).toString();
}

const LIMITE_OBS = 3000;

/** Anexa a marca da baixa às observações (como o legado), sem deixar o campo crescer sem limite. */
export function anexarObsBaixa(
  obsAtual: string | null,
  notaFiscal: string,
  anterior: number,
  novo: number,
  data: string,
): string {
  const linha = `Atlas — NF ${notaFiscal} recebida em ${data}: saldo ${fmtKgObs(anterior)} kg -> ${fmtKgObs(novo)} kg`;
  const base = (obsAtual ?? '').trim();
  const junto = base ? `${base}\n${linha}` : linha;
  return junto.length > LIMITE_OBS ? junto.slice(junto.length - LIMITE_OBS) : junto;
}

export function montarInputAlteracao(args: {
  pedido: PedidoCompraConsultado;
  item: ItemPedidoCompra;
  saldoAnteriorKg: number;
  saldoNovoKg: number;
  notaFiscal: string;
}): AlterarPedidoCompraInput {
  const { pedido, item } = args;
  const hoje = formatarDataOmie();
  const nn = <T>(v: T | null): T | undefined => (v == null ? undefined : v);
  return {
    nCodPed: pedido.nCodPed,
    cCodIntPed: nn(pedido.cCodIntPed),
    dDtPrevisao: pedido.dDtPrevisao ?? hoje,
    cCodParc: nn(pedido.cCodParc),
    nQtdeParc: nn(pedido.nQtdeParc),
    nCodFor: pedido.nCodFor,
    cCodIntFor: nn(pedido.cCodIntFor),
    cCodCateg: nn(pedido.cCodCateg),
    nCodCompr: nn(pedido.nCodCompr),
    cContato: nn(pedido.cContato),
    cContrato: nn(pedido.cContrato),
    nCodCC: nn(pedido.nCodCC),
    nCodIntCC: nn(pedido.nCodIntCC),
    nCodProj: nn(pedido.nCodProj),
    cObs: anexarObsBaixa(pedido.cObs, args.notaFiscal, args.saldoAnteriorKg, args.saldoNovoKg, hoje),
    cObsInt: anexarObsBaixa(pedido.cObsInt, args.notaFiscal, args.saldoAnteriorKg, args.saldoNovoKg, hoje),
    frete: pedido.frete,
    produto: {
      nCodItem: item.nCodItem,
      cCodIntItem: nn(item.cCodIntItem),
      cCodIntProd: nn(item.cCodIntProd),
      nCodProd: item.nCodProd,
      cProduto: item.cProduto,
      cDescricao: nn(item.cDescricao),
      cNCM: nn(item.cNCM),
      cUnidade: nn(item.cUnidade),
      cEAN: nn(item.cEAN),
      nPesoLiq: nn(item.nPesoLiq),
      nPesoBruto: nn(item.nPesoBruto),
      nQtde: args.saldoNovoKg,
      nValUnit: nn(item.nValUnit),
      nDesconto: nn(item.nDesconto),
      codigoLocalEstoque: nn(item.codigoLocalEstoque),
    },
  };
}

// ── Fluxo principal ────────────────────────────────────────────────────────────

export interface ProcessarBaixaInput {
  movimentacaoId: string;
  origem: OrigemBaixa;
  ator?: { userId: string; role: string };
  /** true = só planeja (consulta OMIE ao vivo, zero escrita no OMIE e no ledger). */
  dryRun?: boolean;
  /**
   * Dry-run em lote (backfill): saldos simulados por pedido, encadeados entre
   * movimentações — a NF anterior "gasta" o pedido para a próxima. Ignorado
   * fora do dry-run.
   */
  simulacaoSaldos?: Map<number, number>;
  /**
   * Cache de pedidos ao vivo compartilhado entre movimentações da MESMA
   * execução (backfill). Ver CachePedidos.
   */
  cachePedidos?: CachePedidos;
}

export type DesfechoBaixa = StatusBaixaPedidoQ2p | 'aguardando_omie' | 'simulado';

export interface ResultadoBaixa {
  movimentacaoId: string;
  notaFiscal: string;
  ncodprod: number | null;
  produtoDescricao: string;
  quantidadeKg: number;
  /** Já descontado em execuções anteriores (ledger concluído) — não repetido. */
  kgJaDescontadoAntes: number;
  /** Alocações desta execução (ou simuladas, em dry-run). */
  alocacoes: AlocacaoPedido[];
  restanteKg: number;
  status: DesfechoBaixa;
  /** Em dry-run: qual seria o desfecho se executado. */
  statusPrevisto?: StatusBaixaPedidoQ2p;
  pedidosAcxePreferidos: string[];
  erro?: string;
  dryRun: boolean;
}

type LedgerRow = typeof baixaPedidoQ2p.$inferSelect;

function aprox(a: number, b: number): boolean {
  return Math.abs(a - b) <= TOLERANCIA_KG;
}

export async function processarBaixaPedidoQ2p(input: ProcessarBaixaInput): Promise<ResultadoBaixa> {
  const db = getDb();
  const dryRun = input.dryRun === true;

  const [mov] = await db
    .select()
    .from(movimentacao)
    .where(eq(movimentacao.id, input.movimentacaoId))
    .limit(1);
  if (!mov) throw new BaixaPedidoMovimentacaoNaoEncontradaError(input.movimentacaoId);
  if (!mov.ativo) throw new BaixaPedidoNaoAplicavelError(mov.id, 'movimentação inativa');
  if (mov.tipoMovimento !== 'entrada_nf' || mov.subtipo !== 'importacao') {
    throw new BaixaPedidoNaoAplicavelError(
      mov.id,
      `tipo ${mov.tipoMovimento}/${mov.subtipo ?? '—'} não é entrada de importação`,
    );
  }

  const loteRow = mov.loteId
    ? (await db.select().from(lote).where(eq(lote.id, mov.loteId)).limit(1))[0]
    : undefined;
  const ncodprod = mov.produtoCodigoQ2p ?? loteRow?.produtoCodigoQ2p ?? null;
  const quantidadeKg = Number(mov.quantidadeKg);
  const produtoFallback = loteRow ? `lote ${loteRow.codigo}` : 'produto não identificado';
  const produtoDescricao = ncodprod
    ? await resolverDescricaoProdutoQ2p(ncodprod, produtoFallback)
    : produtoFallback;

  const base: Omit<ResultadoBaixa, 'status' | 'alocacoes' | 'restanteKg' | 'kgJaDescontadoAntes'> = {
    movimentacaoId: mov.id,
    notaFiscal: mov.notaFiscal,
    ncodprod,
    produtoDescricao,
    quantidadeKg,
    pedidosAcxePreferidos: [],
    dryRun,
  };

  if (mov.baixaPedidoQ2p === 'concluida') {
    return {
      ...base,
      status: 'concluida',
      alocacoes: [],
      restanteKg: 0,
      kgJaDescontadoAntes: quantidadeKg,
    };
  }
  if (mov.statusOmie !== 'concluida') {
    // O ajuste dual ainda não fechou (pendente_q2p etc.) — a baixa espera o retry
    // do ajuste concluir; quem conclui dispara de novo.
    return {
      ...base,
      status: 'aguardando_omie',
      alocacoes: [],
      restanteKg: quantidadeKg,
      kgJaDescontadoAntes: 0,
    };
  }
  if (!ncodprod) {
    const erro = 'Produto sem correlato Q2P — não há como localizar o pedido de compra';
    if (!dryRun) await registrarFalhaMovimentacao(mov.id, erro);
    return {
      ...base,
      status: 'falha',
      alocacoes: [],
      restanteKg: quantidadeKg,
      kgJaDescontadoAntes: 0,
      erro,
    };
  }

  const preferidos = await resolverPedidosAcxeDaNf(mov.notaFiscal, loteRow?.pedidoCompraAcxe);
  base.pedidosAcxePreferidos = [...preferidos];

  const soltar = dryRun ? null : await adquirirLockProduto(ncodprod);
  try {
    // 1. Ledger existente: o que já foi descontado não se repete; linhas
    //    pendente/falha podem ter persistido no OMIE apesar do erro.
    const ledger = await db
      .select()
      .from(baixaPedidoQ2p)
      .where(and(eq(baixaPedidoQ2p.movimentacaoId, mov.id), eq(baixaPedidoQ2p.ativo, true)));
    let jaDescontado = new Decimal(0);
    const pedidosFechados = new Set<number>();
    const reutilizaveis = new Map<number, LedgerRow>();
    let linhaSemPedido: LedgerRow | null = null;

    for (const row of ledger) {
      if (row.ncodped == null) {
        if (row.status === 'sem_pedido') linhaSemPedido = row;
        continue;
      }
      if (row.status === 'concluida') {
        jaDescontado = jaDescontado.plus(row.quantidadeKg);
        pedidosFechados.add(row.ncodped);
        continue;
      }
      // pendente/falha: confere ao vivo se a alteração anterior chegou a persistir.
      const persistiu = await alteracaoAnteriorPersistiu(row, ncodprod);
      if (persistiu) {
        logger.info(
          {
            movimentacaoId: mov.id,
            ncodped: row.ncodped,
            saldoNovoKg: row.saldoNovoKg,
          },
          'Baixa anterior já refletida no OMIE — marcando concluída sem nova chamada',
        );
        if (!dryRun) {
          await db
            .update(baixaPedidoQ2p)
            .set({
              status: 'concluida',
              ultimoErro: null,
              updatedAt: new Date(),
            })
            .where(eq(baixaPedidoQ2p.id, row.id));
        }
        jaDescontado = jaDescontado.plus(row.quantidadeKg);
        pedidosFechados.add(row.ncodped);
      } else {
        reutilizaveis.set(row.ncodped, row);
      }
    }

    let restante = new Decimal(quantidadeKg).minus(jaDescontado);
    const alocacoes: AlocacaoPedido[] = [];

    // 2. FIFO sobre os pedidos abertos, consultando cada um ao vivo.
    if (restante.gt(TOLERANCIA_KG)) {
      let candidatos: PedidoCandidato[];
      try {
        candidatos = (await listarPedidosAbertosQ2p(ncodprod, preferidos)).filter(
          (c) => !pedidosFechados.has(c.ncodped),
        );
      } catch (err) {
        // Espelho indisponível (ex.: banco sem tbl_pedidosCompras_Q2P) — falha
        // retentável, nunca exceção solta no fire-and-forget.
        const erro = `Não foi possível listar os pedidos Q2P abertos no espelho: ${(err as Error).message}`;
        return finalizarComFalha({
          mov,
          ncodprod,
          produtoDescricao,
          base,
          alocacoes,
          restante,
          jaDescontado,
          erro,
          dryRun,
          ledgerRow: null,
          cand: null,
        });
      }
      const ordenados = [...candidatos.filter((c) => c.preferido), ...candidatos.filter((c) => !c.preferido)];

      for (const cand of ordenados) {
        if (restante.lte(TOLERANCIA_KG)) break;

        let pedidoLive: PedidoCompraConsultado;
        try {
          const emCache = input.cachePedidos?.get(cand.ncodped);
          if (emCache) {
            pedidoLive = emCache;
          } else {
            pedidoLive = await consultarPedidoCompra('q2p', {
              nCodPed: cand.ncodped,
            });
            input.cachePedidos?.set(cand.ncodped, pedidoLive);
          }
        } catch (err) {
          const erro = `Consulta do pedido ${cand.cnumero ?? cand.ncodped} falhou: ${(err as Error).message}`;
          return finalizarComFalha({
            mov,
            ncodprod,
            produtoDescricao,
            base,
            alocacoes,
            restante,
            jaDescontado,
            erro,
            dryRun,
            ledgerRow: reutilizaveis.get(cand.ncodped) ?? null,
            cand,
          });
        }
        const item = acharItemDoProduto(pedidoLive, ncodprod);
        if (!item) {
          logger.warn({ ncodped: cand.ncodped, ncodprod }, 'Pedido Q2P sem item do produto — ignorado');
          continue;
        }
        if (pedidoLive.cEtapa && pedidoLive.cEtapa !== ETAPA_PEDIDO_Q2P_ABERTO) {
          logger.warn(
            { ncodped: cand.ncodped, etapa: pedidoLive.cEtapa },
            'Pedido Q2P não está mais em aberto (etapa mudou) — ignorado',
          );
          continue;
        }
        const saldoAtual = dryRun ? (input.simulacaoSaldos?.get(cand.ncodped) ?? item.nQtde) : item.nQtde;
        const plano = planejarAlocacao(restante.toNumber(), [
          {
            ...cand,
            cnumero: pedidoLive.cNumero ?? cand.cnumero,
            ncoditem: item.nCodItem,
            saldoKg: saldoAtual,
          },
        ]);
        const aloc = plano.alocacoes[0];
        if (!aloc) continue; // saldo ao vivo já zerado

        if (dryRun) {
          alocacoes.push(aloc);
          restante = restante.minus(aloc.kgAlocado);
          input.simulacaoSaldos?.set(cand.ncodped, aloc.saldoNovoKg);
          continue;
        }

        // Ledger 'pendente' ANTES do OMIE (crash-safe).
        const ledgerId = await gravarLedgerPendente(db, {
          existente: reutilizaveis.get(cand.ncodped) ?? null,
          movimentacaoId: mov.id,
          ncodprod,
          aloc,
          origem: input.origem,
          criadoPor: input.ator?.userId ?? null,
        });
        try {
          await alterarPedidoCompra(
            'q2p',
            montarInputAlteracao({
              pedido: pedidoLive,
              item,
              saldoAnteriorKg: aloc.saldoAnteriorKg,
              saldoNovoKg: aloc.saldoNovoKg,
              notaFiscal: mov.notaFiscal,
            }),
          );
        } catch (err) {
          const mensagem = (err as Error)?.message ?? 'erro desconhecido';
          await db
            .update(baixaPedidoQ2p)
            .set({
              status: 'falha',
              ultimoErro: { mensagem, timestamp: new Date().toISOString() },
              updatedAt: new Date(),
            })
            .where(eq(baixaPedidoQ2p.id, ledgerId));
          const erro = `AlteraPedCompra do pedido ${aloc.cnumero ?? aloc.ncodped} falhou: ${mensagem}`;
          return finalizarComFalha({
            mov,
            ncodprod,
            produtoDescricao,
            base,
            alocacoes,
            restante,
            jaDescontado,
            erro,
            dryRun,
            ledgerRow: null,
            cand,
          });
        }
        await db
          .update(baixaPedidoQ2p)
          .set({ status: 'concluida', ultimoErro: null, updatedAt: new Date() })
          .where(eq(baixaPedidoQ2p.id, ledgerId));
        // Alteração aplicada: o cache passa a refletir o novo saldo, para a
        // próxima movimentação deste pedido não re-consultar a OMIE.
        const cached = input.cachePedidos?.get(cand.ncodped);
        if (cached) {
          const itemCache = acharItemDoProduto(cached, ncodprod);
          if (itemCache) itemCache.nQtde = aloc.saldoNovoKg;
        }
        logger.info(
          {
            movimentacaoId: mov.id,
            nf: mov.notaFiscal,
            ncodped: aloc.ncodped,
            pedido: aloc.cnumero,
            kg: aloc.kgAlocado,
            de: aloc.saldoAnteriorKg,
            para: aloc.saldoNovoKg,
          },
          'Pedido de compra Q2P baixado',
        );
        alocacoes.push(aloc);
        restante = restante.minus(aloc.kgAlocado);
      }
    }

    // 3. Desfecho.
    const restanteKg = restante.lte(TOLERANCIA_KG) ? 0 : d3(restante);
    const statusFinal: StatusBaixaPedidoQ2p = restanteKg > 0 ? 'sem_saldo' : 'concluida';
    if (!dryRun) {
      if (statusFinal === 'sem_saldo') {
        await gravarLinhaSemPedido(db, {
          existente: linhaSemPedido,
          movimentacaoId: mov.id,
          ncodprod,
          restanteKg,
          origem: input.origem,
          criadoPor: input.ator?.userId ?? null,
        });
      } else if (linhaSemPedido) {
        await db
          .update(baixaPedidoQ2p)
          .set({ ativo: false, updatedAt: new Date() })
          .where(eq(baixaPedidoQ2p.id, linhaSemPedido.id));
      }
      await db
        .update(movimentacao)
        .set({ baixaPedidoQ2p: statusFinal, updatedAt: new Date() })
        .where(eq(movimentacao.id, mov.id));
      if (statusFinal === 'sem_saldo') {
        void enviarAlertaBaixaPedidoQ2p({
          movimentacaoId: mov.id,
          notaFiscal: mov.notaFiscal,
          produtoDescricao,
          quantidadeKg,
          motivo: 'sem_saldo',
          restanteKg,
          pedidos: alocacoes.map((a) => ({
            numero: a.cnumero ?? String(a.ncodped),
            saldoAnteriorKg: a.saldoAnteriorKg,
            saldoNovoKg: a.saldoNovoKg,
          })),
        });
      }
    }
    return {
      ...base,
      status: dryRun ? 'simulado' : statusFinal,
      statusPrevisto: statusFinal,
      alocacoes,
      restanteKg,
      kgJaDescontadoAntes: d3(jaDescontado),
    };
  } finally {
    if (soltar) await soltar();
  }
}

/**
 * Uma linha pendente/falha pode ter persistido no OMIE mesmo com erro na
 * resposta. Confere ao vivo: se o saldo atual do item == alvo gravado (e o alvo
 * difere do saldo anterior), a alteração chegou — não repetir.
 */
async function alteracaoAnteriorPersistiu(row: LedgerRow, ncodprod: number): Promise<boolean> {
  if (row.ncodped == null || row.saldoNovoKg == null || row.saldoAnteriorKg == null) return false;
  const anterior = Number(row.saldoAnteriorKg);
  const alvo = Number(row.saldoNovoKg);
  if (aprox(anterior, alvo)) return false;
  try {
    const pedido = await consultarPedidoCompra('q2p', { nCodPed: row.ncodped });
    const item = acharItemDoProduto(pedido, ncodprod);
    return item != null && aprox(item.nQtde, alvo);
  } catch (err) {
    logger.warn(
      { err, ncodped: row.ncodped },
      'Não foi possível conferir baixa anterior ao vivo — tratando como não aplicada',
    );
    return false;
  }
}

async function gravarLedgerPendente(
  db: ReturnType<typeof getDb>,
  args: {
    existente: LedgerRow | null;
    movimentacaoId: string;
    ncodprod: number;
    aloc: AlocacaoPedido;
    origem: OrigemBaixa;
    criadoPor: string | null;
  },
): Promise<string> {
  const { aloc } = args;
  if (args.existente) {
    await db
      .update(baixaPedidoQ2p)
      .set({
        status: 'pendente',
        cnumero: aloc.cnumero,
        ncoditem: aloc.ncoditem,
        quantidadeKg: String(aloc.kgAlocado),
        saldoAnteriorKg: String(aloc.saldoAnteriorKg),
        saldoNovoKg: String(aloc.saldoNovoKg),
        origem: args.origem,
        tentativas: (args.existente.tentativas ?? 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(baixaPedidoQ2p.id, args.existente.id));
    return args.existente.id;
  }
  const [criada] = await db
    .insert(baixaPedidoQ2p)
    .values({
      movimentacaoId: args.movimentacaoId,
      ncodped: aloc.ncodped,
      cnumero: aloc.cnumero,
      ncodprod: args.ncodprod,
      ncoditem: aloc.ncoditem,
      quantidadeKg: String(aloc.kgAlocado),
      saldoAnteriorKg: String(aloc.saldoAnteriorKg),
      saldoNovoKg: String(aloc.saldoNovoKg),
      status: 'pendente',
      origem: args.origem,
      tentativas: 1,
      criadoPor: args.criadoPor,
    })
    .returning({ id: baixaPedidoQ2p.id });
  return criada!.id;
}

async function gravarLinhaSemPedido(
  db: ReturnType<typeof getDb>,
  args: {
    existente: LedgerRow | null;
    movimentacaoId: string;
    ncodprod: number;
    restanteKg: number;
    origem: OrigemBaixa;
    criadoPor: string | null;
  },
): Promise<void> {
  if (args.existente) {
    await db
      .update(baixaPedidoQ2p)
      .set({
        quantidadeKg: String(args.restanteKg),
        origem: args.origem,
        tentativas: (args.existente.tentativas ?? 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(baixaPedidoQ2p.id, args.existente.id));
    return;
  }
  await db.insert(baixaPedidoQ2p).values({
    movimentacaoId: args.movimentacaoId,
    ncodped: null,
    ncodprod: args.ncodprod,
    quantidadeKg: String(args.restanteKg),
    status: 'sem_pedido',
    origem: args.origem,
    tentativas: 1,
    criadoPor: args.criadoPor,
  });
}

async function registrarFalhaMovimentacao(movimentacaoId: string, erro: string): Promise<void> {
  const db = getDb();
  await db
    .update(movimentacao)
    .set({ baixaPedidoQ2p: 'falha', updatedAt: new Date() })
    .where(eq(movimentacao.id, movimentacaoId));
  logger.error({ movimentacaoId, erro }, 'Baixa de pedido Q2P falhou');
}

async function finalizarComFalha(args: {
  mov: typeof movimentacao.$inferSelect;
  ncodprod: number;
  produtoDescricao: string;
  base: Omit<ResultadoBaixa, 'status' | 'alocacoes' | 'restanteKg' | 'kgJaDescontadoAntes'>;
  alocacoes: AlocacaoPedido[];
  restante: Decimal;
  jaDescontado: Decimal;
  erro: string;
  dryRun: boolean;
  ledgerRow: LedgerRow | null;
  cand: PedidoCandidato | null;
}): Promise<ResultadoBaixa> {
  if (!args.dryRun) {
    await registrarFalhaMovimentacao(args.mov.id, args.erro);
    void enviarAlertaBaixaPedidoQ2p({
      movimentacaoId: args.mov.id,
      notaFiscal: args.mov.notaFiscal,
      produtoDescricao: args.produtoDescricao,
      quantidadeKg: Number(args.mov.quantidadeKg),
      motivo: 'falha',
      mensagemErro: args.erro,
      restanteKg: d3(args.restante),
      pedidos: args.alocacoes.map((a) => ({
        numero: a.cnumero ?? String(a.ncodped),
        saldoAnteriorKg: a.saldoAnteriorKg,
        saldoNovoKg: a.saldoNovoKg,
      })),
    });
  }
  return {
    ...args.base,
    status: 'falha',
    statusPrevisto: 'falha',
    alocacoes: args.alocacoes,
    restanteKg: d3(args.restante),
    kgJaDescontadoAntes: d3(args.jaDescontado),
    erro: args.erro,
  };
}

// ── Disparo fire-and-forget (hooks do recebimento/aprovação/retry) ─────────────

/**
 * Dispara a baixa fora do caminho crítico: o recebimento já está persistido e
 * o ajuste dual concluído; falha aqui vira 'falha' na movimentação + alerta,
 * nunca erro para o operador. Respeita STOCKBRIDGE_BAIXA_PEDIDO_Q2P_ENABLED
 * (default ligado) — desligada, a movimentação fica 'pendente' para o painel.
 */
export function dispararBaixaPedidoQ2p(args: { movimentacaoId: string; origem?: OrigemBaixa }): void {
  let habilitada = true;
  try {
    habilitada =
      (getConfig() as { STOCKBRIDGE_BAIXA_PEDIDO_Q2P_ENABLED?: boolean })
        .STOCKBRIDGE_BAIXA_PEDIDO_Q2P_ENABLED !== false;
  } catch {
    habilitada = true;
  }
  if (!habilitada) {
    logger.info(
      { movimentacaoId: args.movimentacaoId },
      'Baixa de pedido Q2P desligada por configuração — fica pendente',
    );
    return;
  }
  void (async () => {
    try {
      const res = await processarBaixaPedidoQ2p({
        movimentacaoId: args.movimentacaoId,
        origem: args.origem ?? 'fluxo',
      });
      logger.info(
        {
          movimentacaoId: args.movimentacaoId,
          status: res.status,
          pedidos: res.alocacoes.length,
          restanteKg: res.restanteKg,
        },
        'Baixa de pedido Q2P processada',
      );
    } catch (err) {
      if (err instanceof BaixaPedidoNaoAplicavelError) {
        logger.warn(
          { movimentacaoId: args.movimentacaoId, motivo: err.motivo },
          'Baixa de pedido Q2P ignorada (não se aplica)',
        );
        return;
      }
      logger.error({ err, movimentacaoId: args.movimentacaoId }, 'Baixa de pedido Q2P: erro inesperado');
      try {
        await registrarFalhaMovimentacao(args.movimentacaoId, (err as Error)?.message ?? 'erro inesperado');
      } catch {
        /* best-effort */
      }
    }
  })();
}

// ── Painel / retry ─────────────────────────────────────────────────────────────

export interface BaixaPendenteItem {
  movimentacaoId: string;
  notaFiscal: string;
  produtoDescricao: string | null;
  ncodprod: number | null;
  loteCodigo: string | null;
  quantidadeKg: number;
  kgDescontado: number;
  status: StatusBaixaPedidoQ2p;
  ultimoErro: { mensagem: string; timestamp: string } | null;
  createdAt: string;
}

interface PendenteRow {
  id: string;
  nota_fiscal: string;
  produto_descricao: string | null;
  ncodprod: string | null;
  lote_codigo: string | null;
  quantidade_kg: string;
  kg_descontado: string;
  baixa_pedido_q2p: StatusBaixaPedidoQ2p;
  ultimo_erro: { mensagem?: string; timestamp?: string } | null;
  created_at: string;
}

/** Movimentações de importação cuja baixa ainda não fechou (pendente/falha/sem_saldo), mais antigas primeiro. */
export async function listarBaixasPendentes(): Promise<BaixaPendenteItem[]> {
  const res = await getPool().query<PendenteRow>(`
    SELECT m.id,
           m.nota_fiscal,
           COALESCE(pq.descricao, pa.descricao) AS produto_descricao,
           COALESCE(m.produto_codigo_q2p, l.produto_codigo_q2p)::text AS ncodprod,
           l.codigo AS lote_codigo,
           m.quantidade_kg::text AS quantidade_kg,
           COALESCE((SELECT SUM(b.quantidade_kg) FROM stockbridge.baixa_pedido_q2p b
                      WHERE b.movimentacao_id = m.id AND b.ativo = true AND b.status = 'concluida'), 0)::text AS kg_descontado,
           m.baixa_pedido_q2p,
           (SELECT b.ultimo_erro FROM stockbridge.baixa_pedido_q2p b
             WHERE b.movimentacao_id = m.id AND b.ativo = true AND b.status = 'falha'
             ORDER BY b.updated_at DESC LIMIT 1) AS ultimo_erro,
           m.created_at::text AS created_at
      FROM stockbridge.movimentacao m
      LEFT JOIN stockbridge.lote l ON l.id = m.lote_id
      LEFT JOIN public."tbl_produtos_Q2P" pq ON pq.codigo_produto = COALESCE(m.produto_codigo_q2p, l.produto_codigo_q2p)
      LEFT JOIN public."tbl_produtos_ACXE" pa ON pa.codigo_produto = COALESCE(m.produto_codigo_acxe, l.produto_codigo_acxe)
     WHERE m.ativo = true
       AND m.baixa_pedido_q2p IN ('pendente', 'falha', 'sem_saldo')
     ORDER BY m.created_at ASC
  `);
  return res.rows.map((r) => ({
    movimentacaoId: r.id,
    notaFiscal: r.nota_fiscal,
    produtoDescricao: r.produto_descricao ?? null,
    ncodprod: r.ncodprod != null ? Number(r.ncodprod) : null,
    loteCodigo: r.lote_codigo ?? null,
    quantidadeKg: Number(r.quantidade_kg),
    kgDescontado: Number(r.kg_descontado),
    status: r.baixa_pedido_q2p,
    ultimoErro: r.ultimo_erro
      ? {
          mensagem: r.ultimo_erro.mensagem ?? '',
          timestamp: r.ultimo_erro.timestamp ?? '',
        }
      : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export interface LedgerItem {
  id: string;
  ncodped: number | null;
  cnumero: string | null;
  quantidadeKg: number;
  saldoAnteriorKg: number | null;
  saldoNovoKg: number | null;
  status: 'pendente' | 'concluida' | 'falha' | 'sem_pedido';
  origem: OrigemBaixa;
  tentativas: number;
  ultimoErro: unknown;
  updatedAt: string;
}

export async function listarLedgerDaMovimentacao(movimentacaoId: string): Promise<LedgerItem[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(baixaPedidoQ2p)
    .where(and(eq(baixaPedidoQ2p.movimentacaoId, movimentacaoId), eq(baixaPedidoQ2p.ativo, true)));
  return rows.map((r) => ({
    id: r.id,
    ncodped: r.ncodped,
    cnumero: r.cnumero,
    quantidadeKg: Number(r.quantidadeKg),
    saldoAnteriorKg: r.saldoAnteriorKg != null ? Number(r.saldoAnteriorKg) : null,
    saldoNovoKg: r.saldoNovoKg != null ? Number(r.saldoNovoKg) : null,
    status: r.status,
    origem: r.origem,
    tentativas: r.tentativas,
    ultimoErro: r.ultimoErro,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Retry manual (gestor+) — reprocessa a movimentação com a idempotência do ledger. */
export async function retentarBaixaPedidoQ2p(args: {
  movimentacaoId: string;
  ator: { userId: string; role: string };
  dryRun?: boolean;
}): Promise<ResultadoBaixa> {
  return processarBaixaPedidoQ2p({
    movimentacaoId: args.movimentacaoId,
    origem: 'retry',
    ator: args.ator,
    dryRun: args.dryRun,
  });
}
