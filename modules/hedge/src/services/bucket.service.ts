import { eq, and, type SQL } from 'drizzle-orm';
import { getDb } from '@atlas/core';
import { bucketMensal, type BucketMensal } from '@atlas/db';

interface BucketFiltros {
  empresa?: 'acxe' | 'q2p';
  status?: 'ok' | 'sub_hedged' | 'over_hedged';
}

export async function getBuckets(filtros: BucketFiltros = {}): Promise<BucketMensal[]> {
  const db = getDb();

  const conditions: SQL[] = [];
  if (filtros.empresa) {
    conditions.push(eq(bucketMensal.empresa, filtros.empresa));
  }
  if (filtros.status) {
    conditions.push(eq(bucketMensal.status, filtros.status));
  }

  return db
    .select()
    .from(bucketMensal)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(bucketMensal.mesRef);
}

export async function getBucketById(id: string): Promise<BucketMensal | null> {
  const db = getDb();
  const [bucket] = await db
    .select()
    .from(bucketMensal)
    .where(eq(bucketMensal.id, id))
    .limit(1);
  return bucket ?? null;
}

export function determinarStatus(
  coberturaPct: number,
): 'ok' | 'sub_hedged' | 'over_hedged' {
  if (coberturaPct < 60) return 'sub_hedged';
  if (coberturaPct > 100) return 'over_hedged';
  return 'ok';
}
