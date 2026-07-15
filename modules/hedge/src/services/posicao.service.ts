import Decimal from 'decimal.js';
import { eq, and, sql, type SQL } from 'drizzle-orm';
import { getDb, getPool, createLogger } from '@atlas/core';
import {
  bucketMensal,
  ndfRegistro,
  type BucketMensal,
} from '@atlas/db';
import { fetchPtaxAtual, type PtaxQuote } from '@atlas/integration-bcb';

const logger = createLogger('hedge:posicao');

export interface ResumoVPS {
  total_pagar_usd: number;
  total_pagar_brl: number;
  pagar_mercadoria_usd: number;
  pagar_despesa_usd: number;
  total_est_brl: number;
  est_importado_brl: number;
  est_transito_brl: number;
  est_nacional_brl: number;
  pct_nao_pago: number;
  est_nao_pago_usd: number;
  recebiveis_brl: number;
  recebiveis_usd: number;
  importacoes_pendentes_usd: number;
  exposicao_usd_total: number;
}

export interface PosicaoKpis {
  exposure_usd: number;
  cobertura_pct: number;
  ndf_ativo_usd: number;
  gap_usd: number;
  ptax_atual: PtaxQuote;
  resumo: ResumoVPS;
}

export interface BucketEnriquecido extends BucketMensal {
  est_nao_pago_usd: number;
  exposicao_usd: number;
}

export interface PosicaoResult {
  kpis: PosicaoKpis;
  buckets: BucketEnriquecido[];
}

interface PosicaoFiltros {
  empresa?: 'acxe' | 'q2p';
}

async function getResumoVPS(): Promise<ResumoVPS> {
  const pool = getPool();
  const { rows } = await pool.query('SELECT * FROM public.vw_hedge_resumo LIMIT 1');
  const r = rows[0];
  if (!r) {
    return {
      total_pagar_usd: 0, total_pagar_brl: 0, pagar_mercadoria_usd: 0,
      pagar_despesa_usd: 0, total_est_brl: 0, est_importado_brl: 0,
      est_transito_brl: 0, est_nacional_brl: 0, pct_nao_pago: 0,
      est_nao_pago_usd: 0, recebiveis_brl: 0, recebiveis_usd: 0,
      importacoes_pendentes_usd: 0, exposicao_usd_total: 0,
    };
  }
  return {
    total_pagar_usd: Number(r.total_pagar_usd ?? 0),
    total_pagar_brl: Number(r.total_pagar_brl ?? 0),
    pagar_mercadoria_usd: Number(r.pagar_mercadoria_usd ?? 0),
    pagar_despesa_usd: Number(r.pagar_despesa_usd ?? 0),
    total_est_brl: Number(r.total_est_brl ?? 0),
    est_importado_brl: Number(r.est_importado_brl ?? 0),
    est_transito_brl: Number(r.est_transito_brl ?? 0),
    est_nacional_brl: Number(r.est_nacional_brl ?? 0),
    pct_nao_pago: Number(r.pct_nao_pago ?? 0),
    est_nao_pago_usd: Number(r.est_nao_pago_usd ?? 0),
    recebiveis_brl: Number(r.total_receber_brl ?? 0),
    recebiveis_usd: Number(r.total_receber_usd ?? 0),
    importacoes_pendentes_usd: Number(r.importacoes_pendentes_usd ?? 0),
    exposicao_usd_total: Number(r.exposicao_usd_total ?? 0),
  };
}

export async function calcularPosicao(
  filtros: PosicaoFiltros = {},
): Promise<PosicaoResult> {
  const db = getDb();

  // Fetch PTAX and VPS resumo in parallel
  const [ptax, resumo] = await Promise.all([
    fetchPtaxAtual(),
    getResumoVPS(),
  ]);

  // Build filter conditions for buckets
  const conditions: SQL[] = [];
  if (filtros.empresa) {
    conditions.push(eq(bucketMensal.empresa, filtros.empresa));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Get all buckets
  const buckets = await db
    .select()
    .from(bucketMensal)
    .where(whereClause)
    .orderBy(bucketMensal.mesRef);

  // Distribute est_nao_pago_usd proportionally across buckets (GAP-01)
  const estNaoPagoTotal = new Decimal(resumo.est_nao_pago_usd);
  let totalPagarUsd = new Decimal(0);
  for (const bucket of buckets) {
    totalPagarUsd = totalPagarUsd.plus(bucket.pagarUsd ?? '0');
  }

  const bucketsEnriquecidos: BucketEnriquecido[] = buckets.map((bucket) => {
    const pagarD = new Decimal(bucket.pagarUsd ?? '0');
    const parcela = totalPagarUsd.isZero()
      ? new Decimal(0)
      : estNaoPagoTotal.times(pagarD).div(totalPagarUsd);
    const exposicao = pagarD.plus(parcela);
    return {
      ...bucket,
      est_nao_pago_usd: parcela.toDecimalPlaces(2).toNumber(),
      exposicao_usd: exposicao.toDecimalPlaces(2).toNumber(),
    };
  });

  // Calculate KPIs from enriched buckets
  let totalExposure = new Decimal(0);
  let totalNdf = new Decimal(0);

  for (const bucket of bucketsEnriquecidos) {
    totalExposure = totalExposure.plus(bucket.exposicao_usd);
    totalNdf = totalNdf.plus(bucket.ndfUsd ?? '0');
  }

  const gap = totalExposure.minus(totalNdf);
  const cobertura = totalExposure.isZero()
    ? new Decimal(0)
    : totalNdf.div(totalExposure).times(100);

  const kpis: PosicaoKpis = {
    exposure_usd: totalExposure.toNumber(),
    ndf_ativo_usd: totalNdf.toNumber(),
    gap_usd: gap.toNumber(),
    cobertura_pct: cobertura.toDecimalPlaces(2).toNumber(),
    ptax_atual: ptax,
    resumo,
  };

  return { kpis, buckets: bucketsEnriquecidos };
}

/**
 * Classifica a cobertura de hedge de um bucket. Thresholds fixos 60/100 —
 * torná-los configuráveis (config_motor) é escopo do MOD-04 (ACXEGDP-275).
 *
 * Consolidada aqui a partir do bucket.service.ts aposentado (MOD-18,
 * ACXEGDP-269/298): a lógica vivia duplicada — inline neste arquivo e como
 * função órfã lá (consumida só pelo teste, dando falsa confiança).
 */
export function determinarStatus(
  coberturaPct: number,
): 'ok' | 'sub_hedged' | 'over_hedged' {
  if (coberturaPct < 60) return 'sub_hedged';
  if (coberturaPct > 100) return 'over_hedged';
  return 'ok';
}

/**
 * Recalcula buckets lendo da view OMIE vw_hedge_pagar_usd.
 * A view ja faz o join com cotacao e retorna valor_usd, bucket_mes, etc.
 *
 * MOD-04/MOD-07 (ACXEGDP-275/278):
 * - Considera TODOS os titulos em aberto que a view expoe (A VENCER + ATRASADO
 *   + VENCE HOJE) — decisao de negocio 2026-07-15: titulo vencido e nao pago
 *   segue sendo exposicao cambial ate quitar. O filtro antigo (so A VENCER)
 *   fazia exposure_usd divergir do resumo da vw_hedge_resumo, que agrega os 3
 *   status na mesma resposta JSON (MOD-07).
 * - Buckets cujo mes SUMIU da view (todos os titulos pagos) sao ZERADOS — antes
 *   mantinham o pagar_usd antigo para sempre, inflando exposure/gap. Nao ha
 *   DELETE: ndf_registro.bucket_id referencia o bucket.
 * - Upsert em lote via ON CONFLICT (mes_ref, empresa) — indice unico
 *   bucket_mes_empresa_idx da migration 0002 — no lugar do SELECT+UPDATE por
 *   mes (N+1).
 * - empresa segue 'acxe' por desenho: a vw_hedge_pagar_usd agrega o contas a
 *   pagar de importacao da ACXE; o hedge cambial e ACXE-only (recebiveis Q2P
 *   sao informacionais e nao geram bucket).
 */
export async function recalcularBuckets(): Promise<void> {
  const pool = getPool();
  const db = getDb();

  // Read from OMIE view — aggregated by bucket_mes (todos os status em aberto)
  const { rows: tituloRows } = await pool.query<{
    bucket_mes: string;
    total_usd: string;
    count: string;
  }>(`
    SELECT
      TO_CHAR(data_vencimento, 'YYYY-MM') || '-01' AS bucket_mes,
      SUM(valor_usd) AS total_usd,
      COUNT(*) AS count
    FROM public.vw_hedge_pagar_usd
    GROUP BY TO_CHAR(data_vencimento, 'YYYY-MM')
    ORDER BY bucket_mes
  `);

  // NDFs ativos por bucket + buckets ja persistidos (1 query cada, sem N+1)
  const ndfRows = await db
    .select({
      bucketId: ndfRegistro.bucketId,
      totalUsd: sql<string>`SUM(${ndfRegistro.notionalUsd})`,
    })
    .from(ndfRegistro)
    .where(eq(ndfRegistro.status, 'ativo'))
    .groupBy(ndfRegistro.bucketId);

  const ndfByBucket = new Map<string, Decimal>();
  for (const row of ndfRows) {
    if (row.bucketId) {
      ndfByBucket.set(row.bucketId, new Decimal(row.totalUsd ?? '0'));
    }
  }

  const existentes = await db
    .select()
    .from(bucketMensal)
    .where(eq(bucketMensal.empresa, 'acxe'));
  const existentePorMes = new Map(existentes.map((b) => [b.mesRef, b]));

  const valores = tituloRows.map((titulo) => {
    const pagarUsd = new Decimal(titulo.total_usd ?? '0');
    const existente = existentePorMes.get(titulo.bucket_mes);
    const ndfUsd = existente ? (ndfByBucket.get(existente.id) ?? new Decimal(0)) : new Decimal(0);
    const cobertura = pagarUsd.isZero()
      ? new Decimal(0)
      : ndfUsd.div(pagarUsd).times(100);
    return {
      mesRef: titulo.bucket_mes, // "2026-04-01"
      empresa: 'acxe' as const,
      pagarUsd: pagarUsd.toFixed(2),
      ndfUsd: ndfUsd.toFixed(2),
      coberturaPct: cobertura.toDecimalPlaces(2).toFixed(2),
      status: determinarStatus(cobertura.toNumber()),
    };
  });

  if (valores.length > 0) {
    await db
      .insert(bucketMensal)
      .values(valores)
      .onConflictDoUpdate({
        target: [bucketMensal.mesRef, bucketMensal.empresa],
        set: {
          pagarUsd: sql`excluded.pagar_usd`,
          ndfUsd: sql`excluded.ndf_usd`,
          coberturaPct: sql`excluded.cobertura_pct`,
          status: sql`excluded.status`,
          updatedAt: sql`now()`,
        },
      });
  }

  // Zera buckets obsoletos: mes quitado = exposicao zero (cobertura 100);
  // NDF remanescente vira over_hedged (hedge sem exposicao correspondente).
  const mesesComTitulo = new Set(tituloRows.map((t) => t.bucket_mes));
  const obsoletos = existentes.filter(
    (b) => !mesesComTitulo.has(b.mesRef) && !new Decimal(b.pagarUsd ?? '0').isZero(),
  );
  for (const b of obsoletos) {
    const ndfUsd = ndfByBucket.get(b.id) ?? new Decimal(0);
    await db
      .update(bucketMensal)
      .set({
        pagarUsd: '0.00',
        ndfUsd: ndfUsd.toFixed(2),
        coberturaPct: '100.00',
        status: ndfUsd.gt(0) ? 'over_hedged' : 'ok',
        updatedAt: new Date(),
      })
      .where(eq(bucketMensal.id, b.id));
  }

  logger.info(
    { meses: tituloRows.length, zerados: obsoletos.length },
    'Buckets recalculados a partir da view OMIE',
  );
}
