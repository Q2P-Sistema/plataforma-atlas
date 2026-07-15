import Decimal from 'decimal.js';
import { eq, and, desc, notInArray, sql, type SQL } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { alerta, configMotor, type BucketMensal } from '@atlas/db';

const logger = createLogger('hedge:alerta');

/**
 * MOD-05 (ACXEGDP-276): antes era INSERT incondicional a cada cache-miss de
 * GET /posicao (TTL 300s) — gap persistente acumulava dezenas de linhas
 * identicas (UAT: 16 alertas abertos para 4 pares bucket+tipo). Agora:
 * - alertas abertos cujo bucket saiu de gap sao AUTO-RESOLVIDOS;
 * - bucket em gap faz upsert no indice unico parcial
 *   alerta_uq_bucket_tipo_aberto (migration 0045): atualiza severidade e
 *   mensagem do alerta aberto em vez de duplicar (o `lido` e preservado —
 *   reaparecer na caixa so quando o alerta e realmente novo).
 */
export async function gerarAlertas(buckets: BucketMensal[]): Promise<void> {
  const db = getDb();

  // Load thresholds from config
  const [critRow] = await db.select().from(configMotor).where(eq(configMotor.chave, 'threshold_critico')).limit(1);
  const [altaRow] = await db.select().from(configMotor).where(eq(configMotor.chave, 'threshold_alta')).limit(1);

  const thresholdCritico = new Decimal(String(critRow?.valor ?? 1000000));
  const thresholdAlta = new Decimal(String(altaRow?.valor ?? 500000));

  const comGap: Array<{ bucketId: string; severidade: 'critico' | 'alta' | 'media'; mensagem: string }> = [];
  for (const bucket of buckets) {
    const gap = new Decimal(bucket.pagarUsd ?? '0').minus(bucket.ndfUsd ?? '0');
    if (gap.lte(0)) continue;

    let severidade: 'critico' | 'alta' | 'media';
    if (gap.gte(thresholdCritico)) severidade = 'critico';
    else if (gap.gte(thresholdAlta)) severidade = 'alta';
    else severidade = 'media';

    comGap.push({
      bucketId: bucket.id,
      severidade,
      mensagem: `Bucket ${bucket.mesRef} (${bucket.empresa}): gap USD ${gap.toFixed(2)} — ${severidade}`,
    });
  }

  // Auto-resolve: gap fechou (ou bucket zerado) → alerta aberto e resolvido.
  const resolverConds: SQL[] = [eq(alerta.tipo, 'gap_cobertura'), eq(alerta.resolvido, false)];
  if (comGap.length > 0) {
    resolverConds.push(notInArray(alerta.bucketId, comGap.map((c) => c.bucketId)));
  }
  await db
    .update(alerta)
    .set({ resolvido: true, resolvidoAt: new Date() })
    .where(and(...resolverConds));

  // Upsert por bucket em gap: no maximo 1 alerta aberto por (bucket, tipo).
  for (const c of comGap) {
    await db
      .insert(alerta)
      .values({
        tipo: 'gap_cobertura',
        severidade: c.severidade,
        mensagem: c.mensagem,
        bucketId: c.bucketId,
      })
      .onConflictDoUpdate({
        target: [alerta.bucketId, alerta.tipo],
        targetWhere: sql`resolvido = false`,
        set: { severidade: c.severidade, mensagem: c.mensagem },
      });
  }

  logger.info({ buckets: buckets.length, comGap: comGap.length }, 'Alertas gerados');
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
