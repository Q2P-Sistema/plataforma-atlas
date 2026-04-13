import { eq, and, desc, type SQL } from 'drizzle-orm';
import { getDb } from '@atlas/core';
import { estoqueSnapshot } from '@atlas/db';

interface EstoqueFiltros {
  empresa?: 'acxe' | 'q2p';
}

export async function getEstoque(filtros: EstoqueFiltros = {}) {
  const db = getDb();
  const conditions: SQL[] = [];

  if (filtros.empresa) {
    conditions.push(eq(estoqueSnapshot.empresa, filtros.empresa));
  }

  // Get latest snapshot per localidade
  const rows = await db
    .select()
    .from(estoqueSnapshot)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(estoqueSnapshot.dataRef));

  return rows.map((r) => ({
    localidade: r.localidade,
    empresa: r.empresa,
    valor_brl: Number(r.valorBrl),
    custo_usd_estimado: Number(r.custoUsdEstimado),
    pago: r.pago,
    fase: r.fase,
    data_ref: r.dataRef,
  }));
}
