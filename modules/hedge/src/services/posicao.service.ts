import Decimal from 'decimal.js';
import { eq, and, sql, type SQL } from 'drizzle-orm';
import { getDb, getPool, createLogger } from '@atlas/core';
import {
  bucketMensal,
  ndfRegistro,
  posicaoSnapshot,
  type BucketMensal,
} from '@atlas/db';
import { fetchPtaxAtual, type PtaxQuote } from '@atlas/integration-bcb';

const logger = createLogger('hedge:posicao');

export interface PosicaoKpis {
  exposure_usd: number;
  cobertura_pct: number;
  ndf_ativo_usd: number;
  gap_usd: number;
  ptax_atual: PtaxQuote;
}

export interface PosicaoResult {
  kpis: PosicaoKpis;
  buckets: BucketMensal[];
}

interface PosicaoFiltros {
  empresa?: 'acxe' | 'q2p';
}

export async function calcularPosicao(
  filtros: PosicaoFiltros = {},
): Promise<PosicaoResult> {
  const db = getDb();

  // Get current PTAX
  const ptax = await fetchPtaxAtual();

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

  // Calculate KPIs from buckets
  let totalExposure = new Decimal(0);
  let totalNdf = new Decimal(0);

  for (const bucket of buckets) {
    totalExposure = totalExposure.plus(bucket.pagarUsd ?? '0');
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
  };

  return { kpis, buckets };
}

/**
 * Recalcula buckets lendo da view OMIE vw_hedge_pagar_usd.
 * A view ja faz o join com cotacao e retorna valor_usd, bucket_mes, etc.
 */
export async function recalcularBuckets(): Promise<void> {
  const pool = getPool();
  const db = getDb();

  // Read from OMIE view — aggregated by bucket_mes
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
    WHERE status_titulo = 'A VENCER'
    GROUP BY TO_CHAR(data_vencimento, 'YYYY-MM')
    ORDER BY bucket_mes
  `);

  // Get active NDFs grouped by bucket
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

  // Upsert buckets (empresa = 'acxe' for now — view combines both)
  for (const titulo of tituloRows) {
    const pagarUsd = new Decimal(titulo.total_usd ?? '0');
    const mesRef = titulo.bucket_mes; // "2026-04-01"

    // Find or create bucket
    const [existing] = await db
      .select()
      .from(bucketMensal)
      .where(
        and(
          eq(bucketMensal.mesRef, mesRef),
          eq(bucketMensal.empresa, 'acxe'),
        ),
      )
      .limit(1);

    const ndfUsd = existing ? (ndfByBucket.get(existing.id) ?? new Decimal(0)) : new Decimal(0);
    const cobertura = pagarUsd.isZero()
      ? new Decimal(0)
      : ndfUsd.div(pagarUsd).times(100);

    let status: 'ok' | 'sub_hedged' | 'over_hedged' = 'ok';
    if (cobertura.lt(60)) status = 'sub_hedged';
    if (cobertura.gt(100)) status = 'over_hedged';

    if (existing) {
      await db
        .update(bucketMensal)
        .set({
          pagarUsd: pagarUsd.toFixed(2),
          ndfUsd: ndfUsd.toFixed(2),
          coberturaPct: cobertura.toDecimalPlaces(2).toFixed(2),
          status,
        })
        .where(eq(bucketMensal.id, existing.id));
    } else {
      await db.insert(bucketMensal).values({
        mesRef,
        empresa: 'acxe',
        pagarUsd: pagarUsd.toFixed(2),
        ndfUsd: ndfUsd.toFixed(2),
        coberturaPct: cobertura.toDecimalPlaces(2).toFixed(2),
        status,
      });
    }
  }

  logger.info({ buckets: tituloRows.length }, 'Buckets recalculados a partir da view OMIE');
}

export async function salvarSnapshot(kpis: PosicaoKpis): Promise<void> {
  const db = getDb();
  const hoje = new Date().toISOString().split('T')[0]!;

  await db
    .insert(posicaoSnapshot)
    .values({
      dataRef: hoje,
      exposureUsd: kpis.exposure_usd.toFixed(2),
      ndfAtivoUsd: kpis.ndf_ativo_usd.toFixed(2),
      gapUsd: kpis.gap_usd.toFixed(2),
      coberturaPct: kpis.cobertura_pct.toFixed(2),
      ptaxRef: kpis.ptax_atual.venda.toFixed(4),
    })
    .onConflictDoUpdate({
      target: posicaoSnapshot.dataRef,
      set: {
        exposureUsd: kpis.exposure_usd.toFixed(2),
        ndfAtivoUsd: kpis.ndf_ativo_usd.toFixed(2),
        gapUsd: kpis.gap_usd.toFixed(2),
        coberturaPct: kpis.cobertura_pct.toFixed(2),
        ptaxRef: kpis.ptax_atual.venda.toFixed(4),
      },
    });
}

export async function getHistorico(dias: number = 90) {
  const db = getDb();
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const desdeStr = desde.toISOString().split('T')[0]!;

  return db
    .select()
    .from(posicaoSnapshot)
    .where(sql`${posicaoSnapshot.dataRef} >= ${desdeStr}`)
    .orderBy(posicaoSnapshot.dataRef);
}
