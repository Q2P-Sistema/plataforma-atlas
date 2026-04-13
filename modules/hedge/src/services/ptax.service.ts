import { eq, sql, desc } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { ptaxHistorico } from '@atlas/db';
import { fetchPtaxAtual, fetchPtaxHistorico, type PtaxQuote } from '@atlas/integration-bcb';

const logger = createLogger('hedge:ptax');

export async function getAtual(): Promise<PtaxQuote> {
  const quote = await fetchPtaxAtual();

  // Persist to local history
  if (quote.venda > 0) {
    const db = getDb();
    await db
      .insert(ptaxHistorico)
      .values({
        dataRef: quote.dataRef,
        venda: quote.venda.toFixed(4),
        compra: quote.compra.toFixed(4),
      })
      .onConflictDoUpdate({
        target: ptaxHistorico.dataRef,
        set: {
          venda: quote.venda.toFixed(4),
          compra: quote.compra.toFixed(4),
        },
      });
  }

  return quote;
}

export async function getHistoricoPtax(dias: number = 30) {
  const db = getDb();

  // First try local DB
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const desdeStr = desde.toISOString().split('T')[0]!;

  const local = await db
    .select()
    .from(ptaxHistorico)
    .where(sql`${ptaxHistorico.dataRef} >= ${desdeStr}`)
    .orderBy(ptaxHistorico.dataRef);

  if (local.length > 0) {
    return {
      atual: {
        dataRef: local[local.length - 1]!.dataRef,
        venda: Number(local[local.length - 1]!.venda),
        compra: Number(local[local.length - 1]!.compra),
        atualizada: true,
      },
      historico: local.map((r) => ({
        data_ref: r.dataRef,
        venda: Number(r.venda),
        compra: Number(r.compra),
      })),
    };
  }

  // Fallback: fetch from BCB and persist
  const bcbData = await fetchPtaxHistorico(dias);
  for (const q of bcbData) {
    await db
      .insert(ptaxHistorico)
      .values({
        dataRef: q.dataRef,
        venda: q.venda.toFixed(4),
        compra: q.compra.toFixed(4),
      })
      .onConflictDoNothing();
  }

  const atual = await fetchPtaxAtual();

  return {
    atual,
    historico: bcbData.map((q) => ({
      data_ref: q.dataRef,
      venda: q.venda,
      compra: q.compra,
    })),
  };
}
