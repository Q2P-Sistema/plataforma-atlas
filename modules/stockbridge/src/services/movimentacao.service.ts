import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@atlas/core';

export interface ListarFiltros {
  page?: number;
  pageSize?: number;
  nf?: string;
  tipoMovimento?: string;
  subtipo?: string;
  cnpj?: 'acxe' | 'q2p' | 'ambos';
  dtInicio?: string; // YYYY-MM-DD
  dtFim?: string;    // YYYY-MM-DD
  /** Filtra por usuario que criou a movimentacao (criado_por OU id_user_acxe/q2p). */
  criadoPor?: string;
}

export interface MovimentacaoListItem {
  id: string;
  notaFiscal: string;
  tipoMovimento: string;
  subtipo: string | null;
  quantidadeKg: number;
  loteCodigo: string | null;
  observacoes: string | null;
  /** Saidas manuais sem lote: SKU + galpao + empresa. */
  produtoCodigoAcxe: number | null;
  produtoDescricao: string | null;
  galpao: string | null;
  empresa: string | null;
  criadoPor: { id: string | null; nome: string | null };
  aprovadoPor: { id: string | null; nome: string | null; em: string | null };
  statusOmie: string | null;
  /** ACXEGDP-344: baixa do pedido de compra Q2P (só entradas de importação). */
  baixaPedidoQ2p: string | null;
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

  // Constroi condicoes em SQL puro com alias `m.` (compativel com query nova).
  const conditions: SQL[] = [sql`m.ativo = true`];
  if (filtros.nf) conditions.push(sql`m.nota_fiscal = ${filtros.nf}`);
  if (filtros.tipoMovimento) conditions.push(sql`m.tipo_movimento = ${filtros.tipoMovimento}`);
  if (filtros.subtipo) conditions.push(sql`m.subtipo = ${filtros.subtipo}`);
  if (filtros.dtInicio) conditions.push(sql`m.created_at >= ${filtros.dtInicio + 'T00:00:00Z'}`);
  if (filtros.dtFim) conditions.push(sql`m.created_at <= ${filtros.dtFim + 'T23:59:59Z'}`);

  // Filtro por CNPJ: acxe/q2p = lados OMIE OU empresa do registro novo; ambos = dual classico
  if (filtros.cnpj === 'acxe') conditions.push(sql`(m.mv_acxe IS NOT NULL OR m.empresa = 'acxe')`);
  if (filtros.cnpj === 'q2p') conditions.push(sql`(m.mv_q2p IS NOT NULL OR m.empresa = 'q2p')`);
  if (filtros.cnpj === 'ambos') conditions.push(sql`m.mv_acxe IS NOT NULL AND m.mv_q2p IS NOT NULL`);

  // Filtro "minhas" — match em criado_por OU nos campos legados id_user_acxe/q2p
  if (filtros.criadoPor) {
    conditions.push(sql`(
      m.criado_por = ${filtros.criadoPor}::uuid
      OR m.id_user_acxe = ${filtros.criadoPor}::uuid
      OR m.id_user_q2p = ${filtros.criadoPor}::uuid
    )`);
  }

  const whereClause = sql.join(conditions, sql` AND `);

  // Query paginada com LEFT JOINs:
  //   - lote (codigo)
  //   - tbl_produtos_ACXE (descricao do produto via produto_codigo_acxe ou lote.produto_codigo_acxe)
  //   - aprovacao mais recente da movimentacao (movimentacao_id ou via lote)
  //   - users (lancador + aprovador)
  const rows = await db.execute<{
    id: string;
    nota_fiscal: string;
    tipo_movimento: string;
    subtipo: string | null;
    quantidade_kg: string;
    observacoes: string | null;
    created_at: string;
    mv_acxe: number | null;
    dt_acxe: string | null;
    id_movest_acxe: string | null;
    id_user_acxe: string | null;
    user_acxe_nome: string | null;
    mv_q2p: number | null;
    dt_q2p: string | null;
    id_movest_q2p: string | null;
    id_user_q2p: string | null;
    user_q2p_nome: string | null;
    lote_codigo: string | null;
    produto_codigo_acxe: number | null;
    produto_descricao: string | null;
    galpao: string | null;
    empresa: string | null;
    criado_por: string | null;
    criado_por_nome: string | null;
    status_omie: string | null;
    baixa_pedido_q2p: string | null;
    aprovado_por: string | null;
    aprovado_por_nome: string | null;
    aprovado_em: string | null;
  }>(sql`
    SELECT
      m.id,
      m.nota_fiscal,
      m.tipo_movimento,
      m.subtipo,
      m.quantidade_kg::text,
      m.observacoes,
      m.created_at::text,
      m.mv_acxe,
      m.dt_acxe::text,
      m.id_movest_acxe,
      m.id_user_acxe,
      ua.name AS user_acxe_nome,
      m.mv_q2p,
      m.dt_q2p::text,
      m.id_movest_q2p,
      m.id_user_q2p,
      uq.name AS user_q2p_nome,
      l.codigo AS lote_codigo,
      COALESCE(m.produto_codigo_acxe, l.produto_codigo_acxe) AS produto_codigo_acxe,
      COALESCE(pa.descricao, pq.descricao) AS produto_descricao,
      m.galpao,
      m.empresa,
      m.criado_por,
      uc.name AS criado_por_nome,
      m.status_omie,
      m.baixa_pedido_q2p,
      ap.aprovado_por,
      uap.name AS aprovado_por_nome,
      ap.aprovado_em::text
    FROM stockbridge.movimentacao m
    LEFT JOIN stockbridge.lote l ON l.id = m.lote_id
    LEFT JOIN public."tbl_produtos_ACXE" pa
      ON pa.codigo_produto = COALESCE(m.produto_codigo_acxe, l.produto_codigo_acxe)
    LEFT JOIN public."tbl_produtos_Q2P" pq
      ON pq.codigo_produto = m.produto_codigo_q2p AND m.produto_codigo_acxe IS NULL
    LEFT JOIN atlas.users ua ON ua.id = m.id_user_acxe
    LEFT JOIN atlas.users uq ON uq.id = m.id_user_q2p
    LEFT JOIN atlas.users uc ON uc.id = m.criado_por
    LEFT JOIN LATERAL (
      SELECT a.aprovado_por, a.aprovado_em
      FROM stockbridge.aprovacao a
      WHERE (a.movimentacao_id = m.id OR (m.lote_id IS NOT NULL AND a.lote_id = m.lote_id))
        AND a.status = 'aprovada'
      ORDER BY a.aprovado_em DESC NULLS LAST
      LIMIT 1
    ) ap ON true
    LEFT JOIN atlas.users uap ON uap.id = ap.aprovado_por
    WHERE ${whereClause}
    ORDER BY m.created_at DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `);

  // Count separado
  const countRes = await db.execute<{ total: string }>(sql`
    SELECT COUNT(*)::text AS total FROM stockbridge.movimentacao m WHERE ${whereClause}
  `);
  const total = Number(countRes.rows[0]?.total ?? 0);

  const items: MovimentacaoListItem[] = rows.rows.map((r) => ({
    id: r.id,
    notaFiscal: r.nota_fiscal,
    tipoMovimento: r.tipo_movimento,
    subtipo: r.subtipo ?? null,
    quantidadeKg: Number(r.quantidade_kg),
    loteCodigo: r.lote_codigo ?? null,
    observacoes: r.observacoes ?? null,
    produtoCodigoAcxe: r.produto_codigo_acxe != null ? Number(r.produto_codigo_acxe) : null,
    produtoDescricao: r.produto_descricao ?? null,
    galpao: r.galpao ?? null,
    empresa: r.empresa ?? null,
    criadoPor: {
      id: r.criado_por ?? r.id_user_acxe ?? r.id_user_q2p ?? null,
      nome: r.criado_por_nome ?? r.user_acxe_nome ?? r.user_q2p_nome ?? null,
    },
    aprovadoPor: {
      id: r.aprovado_por ?? null,
      nome: r.aprovado_por_nome ?? null,
      em: r.aprovado_em ? new Date(r.aprovado_em).toISOString() : null,
    },
    statusOmie: r.status_omie ?? null,
    baixaPedidoQ2p: r.baixa_pedido_q2p ?? null,
    ladoAcxe: {
      status: r.mv_acxe === 1 ? 'Sucesso' : r.mv_acxe === -1 ? 'Saída' : r.mv_acxe != null ? `Status ${r.mv_acxe}` : null,
      dt: r.dt_acxe ? new Date(r.dt_acxe).toISOString() : null,
      idMovest: r.id_movest_acxe ?? null,
      usuario: r.user_acxe_nome ?? null,
    },
    ladoQ2p: {
      status: r.mv_q2p === 1 ? 'Sucesso' : r.mv_q2p === -1 ? 'Saída' : r.mv_q2p != null ? `Status ${r.mv_q2p}` : null,
      dt: r.dt_q2p ? new Date(r.dt_q2p).toISOString() : null,
      idMovest: r.id_movest_q2p ?? null,
      usuario: r.user_q2p_nome ?? null,
    },
    createdAt: new Date(r.created_at).toISOString(),
  }));

  return { items, total, page, pageSize };
}
