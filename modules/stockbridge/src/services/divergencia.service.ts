import { getPool, createLogger } from '@atlas/core';

const logger = createLogger('stockbridge:divergencia');

export type StatusDivergencia = 'aberta' | 'regularizada' | 'descartada';
export type TipoDivergencia = 'faltando' | 'varredura' | 'cruzada' | 'fiscal_pendente';

export interface ListarDivergenciasFiltros {
  status?: StatusDivergencia;
  tipo?: TipoDivergencia;
  cnpj?: 'acxe' | 'q2p';
  produtoCodigoAcxe?: number;
}

export interface DivergenciaItem {
  id: string;
  tipo: TipoDivergencia;
  status: StatusDivergencia;
  quantidadeDeltaKg: number;
  valorUsd: number | null;
  observacoes: string | null;
  createdAt: string;
  regularizadaEm: string | null;
  // Produto (resolvido via lote.produto_codigo_acxe → tbl_produtos_ACXE)
  produtoCodigoAcxe: number | null;
  produtoNome: string | null;
  produtoFamilia: string | null;
  produtoNcm: string | null;
  // Lote
  loteId: string | null;
  loteCodigo: string | null;
  loteCnpj: string | null;
  loteLocalidadeCodigo: string | null;
  loteLocalidadeNome: string | null;
  // Movimentacao que originou
  movimentacaoId: string;
  notaFiscal: string | null;
  subtipo: string | null;
  movimentacaoCreatedAt: string;
}

/**
 * Lista divergências (Faltando, Varredura, Cruzada, Fiscal Pendente) com
 * contexto completo: produto, lote, movimentação de origem e localidade.
 * Default: status='aberta', ordenado pela mais recente.
 */
export async function listarDivergencias(
  filtros: ListarDivergenciasFiltros = {},
): Promise<DivergenciaItem[]> {
  const pool = getPool();

  const status = filtros.status ?? 'aberta';
  const tipo = filtros.tipo ?? null;
  const cnpj = filtros.cnpj ?? null;
  const produtoCodigo = filtros.produtoCodigoAcxe ?? null;

  const sql = `
    SELECT
      d.id,
      d.tipo,
      d.status,
      d.quantidade_delta_kg,
      d.valor_usd,
      d.observacoes,
      d.created_at,
      d.regularizada_em,
      l.id            AS lote_id,
      l.codigo        AS lote_codigo,
      l.cnpj          AS lote_cnpj,
      l.produto_codigo_acxe AS produto_codigo_acxe,
      loc.codigo      AS lote_localidade_codigo,
      loc.nome        AS lote_localidade_nome,
      pa.descricao    AS produto_nome,
      pa.descricao_familia AS produto_familia,
      pa.ncm          AS produto_ncm,
      m.id            AS movimentacao_id,
      m.nota_fiscal   AS nota_fiscal,
      m.subtipo       AS subtipo,
      m.created_at    AS movimentacao_created_at
    FROM stockbridge.divergencia d
    INNER JOIN stockbridge.movimentacao m ON m.id = d.movimentacao_id
    LEFT JOIN stockbridge.lote l ON l.id = d.lote_id
    LEFT JOIN stockbridge.localidade loc ON loc.id = l.localidade_id
    LEFT JOIN public."tbl_produtos_ACXE" pa ON pa.codigo_produto = l.produto_codigo_acxe
    WHERE d.status = $1
      AND ($2::text IS NULL OR d.tipo = $2)
      AND ($3::text IS NULL OR l.cnpj = $3)
      AND ($4::bigint IS NULL OR l.produto_codigo_acxe = $4)
    ORDER BY d.created_at DESC
    LIMIT 500
  `;

  let rows: Record<string, unknown>[] = [];
  try {
    const result = await pool.query(sql, [status, tipo, cnpj, produtoCodigo]);
    rows = result.rows as Record<string, unknown>[];
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'Listagem de divergencias falhou — retornando vazio',
    );
    return [];
  }

  return rows.map((r) => ({
    id: String(r.id),
    tipo: r.tipo as TipoDivergencia,
    status: r.status as StatusDivergencia,
    quantidadeDeltaKg: Number(r.quantidade_delta_kg),
    valorUsd: r.valor_usd != null ? Number(r.valor_usd) : null,
    observacoes: (r.observacoes as string | null) ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    regularizadaEm:
      r.regularizada_em instanceof Date
        ? r.regularizada_em.toISOString()
        : (r.regularizada_em as string | null) ?? null,
    produtoCodigoAcxe: r.produto_codigo_acxe != null ? Number(r.produto_codigo_acxe) : null,
    produtoNome: (r.produto_nome as string | null) ?? null,
    produtoFamilia: (r.produto_familia as string | null) ?? null,
    produtoNcm: (r.produto_ncm as string | null) ?? null,
    loteId: (r.lote_id as string | null) ?? null,
    loteCodigo: (r.lote_codigo as string | null) ?? null,
    loteCnpj: (r.lote_cnpj as string | null) ?? null,
    loteLocalidadeCodigo: (r.lote_localidade_codigo as string | null) ?? null,
    loteLocalidadeNome: (r.lote_localidade_nome as string | null) ?? null,
    movimentacaoId: String(r.movimentacao_id),
    notaFiscal: (r.nota_fiscal as string | null) ?? null,
    subtipo: (r.subtipo as string | null) ?? null,
    movimentacaoCreatedAt:
      r.movimentacao_created_at instanceof Date
        ? r.movimentacao_created_at.toISOString()
        : String(r.movimentacao_created_at),
  }));
}
