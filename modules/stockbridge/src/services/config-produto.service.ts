import { eq, asc } from 'drizzle-orm';
import { getDb, getPool, createLogger } from '@atlas/core';
import { configProduto } from '@atlas/db';

const logger = createLogger('stockbridge:config-produto');

export interface ConfigProdutoItem {
  produtoCodigoAcxe: number;
  nomeProduto: string;
  familiaOmie: string | null;
  consumoMedioDiarioT: number | null;
  leadTimeDias: number | null;
  familiaCategoria: string | null;
  incluirEmMetricas: boolean;
}

/**
 * Lista config por SKU juntando com metadata do produto OMIE.
 * Retorna todos os SKUs do catalogo ACXE (LEFT JOIN), incluindo aqueles
 * sem config (valores nulos).
 */
export async function listarConfigProdutos(): Promise<ConfigProdutoItem[]> {
  const pool = getPool();
  const res = await pool.query(`
    SELECT
      p.codigo_produto AS codigo,
      p.descricao AS nome,
      p.descricao_familia AS familia_omie,
      c.consumo_medio_diario_t,
      c.lead_time_dias,
      c.familia_categoria,
      COALESCE(c.incluir_em_metricas, true) AS incluir
    FROM public.tb_produtos_ACXE p
    LEFT JOIN stockbridge.config_produto c ON c.produto_codigo_acxe = p.codigo_produto
    WHERE (p.inativo IS NULL OR p.inativo <> 'S')
    ORDER BY p.descricao
    LIMIT 1000
  `).catch((err) => {
    logger.warn({ err: err.message }, 'Query config produtos falhou — provavelmente tabela OMIE ausente em dev');
    return { rows: [] };
  });

  return (res.rows as Array<{ codigo: number; nome: string | null; familia_omie: string | null; consumo_medio_diario_t: string | null; lead_time_dias: number | null; familia_categoria: string | null; incluir: boolean }>).map((r) => ({
    produtoCodigoAcxe: Number(r.codigo),
    nomeProduto: r.nome ?? 'sem nome',
    familiaOmie: r.familia_omie,
    consumoMedioDiarioT: r.consumo_medio_diario_t != null ? Number(r.consumo_medio_diario_t) : null,
    leadTimeDias: r.lead_time_dias,
    familiaCategoria: r.familia_categoria,
    incluirEmMetricas: r.incluir,
  }));
}

export interface UpsertConfigInput {
  produtoCodigoAcxe: number;
  consumoMedioDiarioT?: number | null;
  leadTimeDias?: number | null;
  familiaCategoria?: string | null;
  incluirEmMetricas?: boolean;
  userId: string;
}

export async function upsertConfigProduto(input: UpsertConfigInput): Promise<typeof configProduto.$inferSelect> {
  const db = getDb();
  const [existente] = await db
    .select()
    .from(configProduto)
    .where(eq(configProduto.produtoCodigoAcxe, input.produtoCodigoAcxe))
    .limit(1);

  if (existente) {
    const [atualizada] = await db
      .update(configProduto)
      .set({
        ...(input.consumoMedioDiarioT !== undefined ? { consumoMedioDiarioT: input.consumoMedioDiarioT != null ? String(input.consumoMedioDiarioT) : null } : {}),
        ...(input.leadTimeDias !== undefined ? { leadTimeDias: input.leadTimeDias } : {}),
        ...(input.familiaCategoria !== undefined ? { familiaCategoria: input.familiaCategoria } : {}),
        ...(input.incluirEmMetricas !== undefined ? { incluirEmMetricas: input.incluirEmMetricas } : {}),
        updatedBy: input.userId,
        updatedAt: new Date(),
      })
      .where(eq(configProduto.id, existente.id))
      .returning();
    logger.info({ codigo: input.produtoCodigoAcxe }, 'Config produto atualizada');
    return atualizada!;
  }

  const [criada] = await db
    .insert(configProduto)
    .values({
      produtoCodigoAcxe: input.produtoCodigoAcxe,
      consumoMedioDiarioT: input.consumoMedioDiarioT != null ? String(input.consumoMedioDiarioT) : null,
      leadTimeDias: input.leadTimeDias ?? null,
      familiaCategoria: input.familiaCategoria ?? null,
      incluirEmMetricas: input.incluirEmMetricas ?? true,
      updatedBy: input.userId,
    })
    .returning();
  logger.info({ codigo: input.produtoCodigoAcxe }, 'Config produto criada');
  return criada!;
}

// Helper silenciando asc import nao usado em build
void asc;
