import { getPool, createLogger } from '@atlas/core';

const logger = createLogger('stockbridge:config-produto');

export interface ConfigProdutoItem {
  produtoCodigoAcxe: number;
  nomeProduto: string;
  familiaOmie: string | null;
  familiaAtlas: string | null;
  familiaAtlasNomeCompleto: string | null;
  consumoMedioDiarioKg: number | null;
  camadaConsumo: '70/30' | '90d' | '365d' | null;
  leadTimeDias: number | null;
  incluirEmMetricas: boolean;
}

/**
 * Lista config por SKU. Une 3 fontes:
 *  - public.tbl_produtos_ACXE (catalogo OMIE)
 *  - stockbridge.familia_omie_atlas (mapping macro: PE/PP/PS/...)
 *  - stockbridge.config_produto (consumo medio + lead time editaveis no Atlas)
 *
 * Antes de retornar, dispara refresh do consumo_medio_diario_kg via funcao
 * stockbridge.refresh_consumo_medio_se_stale(60). Se MAX(updated_at) for mais
 * antigo que 60 minutos, recalcula todos os produtos via vendas reais. Caso
 * contrario, no-op (zero overhead).
 *
 * Filtra produtos cuja familia OMIE esta marcada incluir_em_metricas=false em
 * familia_omie_atlas (USO E CONSUMO, ATIVO IMOBILIZADO, STRETCH, INDUSTRIALIZADO,
 * UNIFORMES, LOCAÇÃO). Familias nao mapeadas (sem linha em familia_omie_atlas)
 * ficam de fora — diretor cadastra a familia primeiro pra liberar.
 */
export async function listarConfigProdutos(): Promise<ConfigProdutoItem[]> {
  const pool = getPool();

  // Refresh com TTL de 60min. Se falhar (ex: tabela de vendas indisponivel),
  // continua com valores stale e loga warn. Nao bloqueia o GET.
  try {
    const refreshRes = await pool.query<{ refresh_consumo_medio_se_stale: number }>(
      'SELECT stockbridge.refresh_consumo_medio_se_stale(60) AS refresh_consumo_medio_se_stale',
    );
    const atualizados = refreshRes.rows[0]?.refresh_consumo_medio_se_stale ?? 0;
    if (atualizados > 0) {
      logger.info({ atualizados }, 'Consumo medio recalculado para todos os produtos');
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Refresh do consumo medio falhou — usando valores stale');
  }

  const res = await pool
    .query(
      `
    SELECT
      p.codigo_produto                              AS codigo,
      p.descricao                                   AS nome,
      p.descricao_familia                           AS familia_omie,
      f.familia_atlas                               AS familia_atlas,
      f.nome_completo                               AS familia_atlas_nome_completo,
      c.consumo_medio_diario_kg,
      c.camada_consumo,
      c.lead_time_dias,
      COALESCE(c.incluir_em_metricas, true)         AS incluir
    FROM public."tbl_produtos_ACXE" p
    INNER JOIN stockbridge.familia_omie_atlas f
      ON f.familia_omie = p.descricao_familia
      AND f.incluir_em_metricas = true
    LEFT JOIN stockbridge.config_produto c
      ON c.produto_codigo_acxe = p.codigo_produto
    WHERE (p.inativo IS NULL OR p.inativo <> 'S')
    ORDER BY c.consumo_medio_diario_kg DESC NULLS LAST, p.descricao
    LIMIT 1000
  `,
    )
    .catch((err) => {
      logger.warn(
        { err: err.message },
        'Query config produtos falhou — provavelmente tabelas OMIE/familia_omie_atlas ausentes em dev',
      );
      return { rows: [] };
    });

  return (
    res.rows as Array<{
      codigo: number;
      nome: string | null;
      familia_omie: string | null;
      familia_atlas: string | null;
      familia_atlas_nome_completo: string | null;
      consumo_medio_diario_kg: string | null;
      camada_consumo: '70/30' | '90d' | '365d' | null;
      lead_time_dias: number | null;
      incluir: boolean;
    }>
  ).map((r) => ({
    produtoCodigoAcxe: Number(r.codigo),
    nomeProduto: r.nome ?? 'sem nome',
    familiaOmie: r.familia_omie,
    familiaAtlas: r.familia_atlas,
    familiaAtlasNomeCompleto: r.familia_atlas_nome_completo,
    consumoMedioDiarioKg: r.consumo_medio_diario_kg != null ? Number(r.consumo_medio_diario_kg) : null,
    camadaConsumo: r.camada_consumo,
    leadTimeDias: r.lead_time_dias,
    incluirEmMetricas: r.incluir,
  }));
}
