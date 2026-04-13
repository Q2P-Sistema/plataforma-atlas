import { sql, desc } from 'drizzle-orm';
import { getDb } from '@atlas/core';
import { ptaxHistorico, alerta } from '@atlas/db';
import { fetchPtaxAtual, fetchPtaxHistorico, type PtaxQuote } from '@atlas/integration-bcb';

export interface PtaxAtualComVariacao extends PtaxQuote {
  ptax_anterior: number;
  variacao_pct: number;
}

export async function getAtual(): Promise<PtaxAtualComVariacao> {
  const db = getDb();
  const quote = await fetchPtaxAtual();

  // Persist to local history
  if (quote.venda > 0) {
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

  // Generate alert if PTAX is zero (rejected by sanity check in integration-bcb)
  if (quote.venda === 0 && !quote.atualizada) {
    await db.insert(alerta).values({
      tipo: 'ptax_indisponivel',
      severidade: 'critico',
      mensagem: 'PTAX indisponivel — BCB API falhou ou valor fora do range [3.00, 10.00]',
    }).catch(() => {});
  }

  // Get previous day for variacao
  const [anterior] = await db
    .select()
    .from(ptaxHistorico)
    .where(sql`${ptaxHistorico.dataRef} < ${quote.dataRef}`)
    .orderBy(desc(ptaxHistorico.dataRef))
    .limit(1);

  const ptax_anterior = anterior ? Number(anterior.venda) : quote.venda;
  const variacao_pct = ptax_anterior > 0
    ? parseFloat(((quote.venda - ptax_anterior) / ptax_anterior * 100).toFixed(4))
    : 0;

  return { ...quote, ptax_anterior, variacao_pct };
}

export async function getVariacao30d(): Promise<number> {
  const db = getDb();
  const desde = new Date();
  desde.setDate(desde.getDate() - 35); // buffer for weekends
  const desdeStr = desde.toISOString().split('T')[0]!;

  const rows = await db
    .select()
    .from(ptaxHistorico)
    .where(sql`${ptaxHistorico.dataRef} >= ${desdeStr}`)
    .orderBy(ptaxHistorico.dataRef);

  if (rows.length < 2) return 0;
  const ini = Number(rows[0]!.venda);
  const fim = Number(rows[rows.length - 1]!.venda);
  return parseFloat(((fim - ini) / ini * 100).toFixed(2));
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
    const last = local[local.length - 1]!;
    const prev = local.length > 1 ? local[local.length - 2]! : last;
    const venda = Number(last.venda);
    const vendaPrev = Number(prev.venda);

    return {
      atual: {
        dataRef: last.dataRef,
        venda,
        compra: Number(last.compra),
        atualizada: true,
        ptax_anterior: vendaPrev,
        variacao_pct: vendaPrev > 0 ? parseFloat(((venda - vendaPrev) / vendaPrev * 100).toFixed(4)) : 0,
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

  const atual = await getAtual();

  return {
    atual,
    historico: bcbData.map((q) => ({
      data_ref: q.dataRef,
      venda: q.venda,
      compra: q.compra,
    })),
  };
}
