import { eq, and, desc, gte, lte, inArray, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@atlas/core';
import { movimentacao, lote, users } from '@atlas/db';

export interface ListarFiltros {
  page?: number;
  pageSize?: number;
  nf?: string;
  tipoMovimento?: string;
  cnpj?: 'acxe' | 'q2p' | 'ambos';
  dtInicio?: string; // YYYY-MM-DD
  dtFim?: string;    // YYYY-MM-DD
}

export interface MovimentacaoListItem {
  id: string;
  notaFiscal: string;
  tipoMovimento: string;
  subtipo: string | null;
  quantidadeKg: number;
  loteCodigo: string | null;
  observacoes: string | null;
  ladoAcxe: { status: string | null; dt: string | null; idMovest: string | null; usuario: string | null };
  ladoQ2p:  { status: string | null; dt: string | null; idMovest: string | null; usuario: string | null };
  createdAt: string;
}

export interface ListarResultado {
  items: MovimentacaoListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listar(filtros: ListarFiltros): Promise<ListarResultado> {
  const db = getDb();
  const page = Math.max(1, filtros.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, filtros.pageSize ?? 50));
  const offset = (page - 1) * pageSize;

  const conditions: SQL[] = [eq(movimentacao.ativo, true)];
  if (filtros.nf) conditions.push(eq(movimentacao.notaFiscal, filtros.nf));
  if (filtros.tipoMovimento) conditions.push(sql`${movimentacao.tipoMovimento} = ${filtros.tipoMovimento}`);
  if (filtros.dtInicio) conditions.push(gte(movimentacao.createdAt, new Date(filtros.dtInicio + 'T00:00:00Z')));
  if (filtros.dtFim) conditions.push(lte(movimentacao.createdAt, new Date(filtros.dtFim + 'T23:59:59Z')));

  // Filtro por CNPJ: acxe = tem mv_acxe; q2p = tem mv_q2p; ambos = tem ambos
  if (filtros.cnpj === 'acxe') conditions.push(sql`${movimentacao.mvAcxe} IS NOT NULL`);
  if (filtros.cnpj === 'q2p') conditions.push(sql`${movimentacao.mvQ2p} IS NOT NULL`);
  if (filtros.cnpj === 'ambos') conditions.push(
    sql`${movimentacao.mvAcxe} IS NOT NULL AND ${movimentacao.mvQ2p} IS NOT NULL`,
  );

  const whereClause = and(...conditions);

  // Query paginada com LEFT JOIN no lote (para codigo)
  const rows = await db
    .select({
      id: movimentacao.id,
      notaFiscal: movimentacao.notaFiscal,
      tipoMovimento: movimentacao.tipoMovimento,
      subtipo: movimentacao.subtipo,
      quantidadeKg: movimentacao.quantidadeKg,
      observacoes: movimentacao.observacoes,
      createdAt: movimentacao.createdAt,
      mvAcxe: movimentacao.mvAcxe,
      dtAcxe: movimentacao.dtAcxe,
      idMovestAcxe: movimentacao.idMovestAcxe,
      idUserAcxe: movimentacao.idUserAcxe,
      mvQ2p: movimentacao.mvQ2p,
      dtQ2p: movimentacao.dtQ2p,
      idMovestQ2p: movimentacao.idMovestQ2p,
      idUserQ2p: movimentacao.idUserQ2p,
      loteCodigo: lote.codigo,
    })
    .from(movimentacao)
    .leftJoin(lote, eq(lote.id, movimentacao.loteId))
    .where(whereClause)
    .orderBy(desc(movimentacao.createdAt))
    .limit(pageSize)
    .offset(offset);

  // Count (separado para evitar sobrecarregar a query principal)
  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(movimentacao)
    .where(whereClause);
  const total = Number(countRow?.total ?? 0);

  // Batch de users
  const userIds = [...new Set(rows.flatMap((r) => [r.idUserAcxe, r.idUserQ2p]).filter((x): x is string => !!x))];
  const userMap = new Map<string, string>();
  if (userIds.length > 0) {
    const userRows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const u of userRows) userMap.set(u.id, u.name);
  }

  const items: MovimentacaoListItem[] = rows.map((r) => ({
    id: r.id,
    notaFiscal: r.notaFiscal,
    tipoMovimento: r.tipoMovimento,
    subtipo: r.subtipo ?? null,
    quantidadeKg: Number(r.quantidadeKg),
    loteCodigo: r.loteCodigo ?? null,
    observacoes: r.observacoes ?? null,
    ladoAcxe: {
      status: r.mvAcxe === 1 ? 'Sucesso' : r.mvAcxe != null ? `Status ${r.mvAcxe}` : null,
      dt: r.dtAcxe ? r.dtAcxe.toISOString() : null,
      idMovest: r.idMovestAcxe ?? null,
      usuario: r.idUserAcxe ? userMap.get(r.idUserAcxe) ?? null : null,
    },
    ladoQ2p: {
      status: r.mvQ2p === 1 ? 'Sucesso' : r.mvQ2p != null ? `Status ${r.mvQ2p}` : null,
      dt: r.dtQ2p ? r.dtQ2p.toISOString() : null,
      idMovest: r.idMovestQ2p ?? null,
      usuario: r.idUserQ2p ? userMap.get(r.idUserQ2p) ?? null : null,
    },
    createdAt: r.createdAt.toISOString(),
  }));

  return { items, total, page, pageSize };
}
