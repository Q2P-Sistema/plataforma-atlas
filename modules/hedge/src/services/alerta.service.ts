import Decimal from 'decimal.js';
import { eq, and, desc, type SQL } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { alerta, bucketMensal, configMotor, type BucketMensal } from '@atlas/db';

const logger = createLogger('hedge:alerta');

export async function gerarAlertas(buckets: BucketMensal[]): Promise<void> {
  const db = getDb();

  // Load thresholds from config
  const [critRow] = await db.select().from(configMotor).where(eq(configMotor.chave, 'threshold_critico')).limit(1);
  const [altaRow] = await db.select().from(configMotor).where(eq(configMotor.chave, 'threshold_alta')).limit(1);

  const thresholdCritico = new Decimal(critRow?.valor as string ?? '1000000');
  const thresholdAlta = new Decimal(altaRow?.valor as string ?? '500000');

  for (const bucket of buckets) {
    const gap = new Decimal(bucket.pagarUsd ?? '0').minus(bucket.ndfUsd ?? '0');
    if (gap.lte(0)) continue;

    let severidade: 'critico' | 'alta' | 'media';
    if (gap.gte(thresholdCritico)) severidade = 'critico';
    else if (gap.gte(thresholdAlta)) severidade = 'alta';
    else severidade = 'media';

    await db.insert(alerta).values({
      tipo: 'gap_cobertura',
      severidade,
      mensagem: `Bucket ${bucket.mesRef} (${bucket.empresa}): gap USD ${gap.toFixed(2)} — ${severidade}`,
      bucketId: bucket.id,
    });
  }

  logger.info({ buckets: buckets.length }, 'Alertas gerados');
}

export async function marcarLido(id: string): Promise<void> {
  const db = getDb();
  await db.update(alerta).set({ lido: true }).where(eq(alerta.id, id));
}

export async function resolver(id: string): Promise<void> {
  const db = getDb();
  await db.update(alerta).set({ resolvido: true, resolvidoAt: new Date() }).where(eq(alerta.id, id));
}

interface AlertaFiltros {
  resolvido?: boolean;
  limit?: number;
}

export async function listarAlertas(filtros: AlertaFiltros = {}) {
  const db = getDb();
  const conditions: SQL[] = [];

  if (filtros.resolvido !== undefined) {
    conditions.push(eq(alerta.resolvido, filtros.resolvido));
  }

  return db
    .select()
    .from(alerta)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(alerta.createdAt))
    .limit(filtros.limit ?? 50);
}
