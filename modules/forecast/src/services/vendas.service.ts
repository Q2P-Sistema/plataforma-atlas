import { getPool, createLogger } from '@atlas/core';

const logger = createLogger('forecast:vendas');

export interface VendasSku {
  codigo_produto: number;
  vendas12m: number;
}

/**
 * Reads sales history from tbl_movimentacaoEstoqueHistorico_Q2P.
 * Returns sum of ABS(qtde) for Venda de Produto in last 365 days, grouped by id_prod.
 */
export async function getVendas12m(): Promise<Map<number, number>> {
  const pool = getPool();

  const { rows } = await pool.query<{ id_prod: string; vendas12m: string }>(`
    SELECT
      id_prod,
      SUM(ABS(qtde)) AS vendas12m
    FROM "tbl_movimentacaoEstoqueHistorico_Q2P"
    WHERE des_origem = 'Venda de Produto'
      AND (cancelamento IS NULL OR cancelamento != 'S')
      AND dt_mov >= CURRENT_DATE - INTERVAL '365 days'
    GROUP BY id_prod
  `);

  const map = new Map<number, number>();
  for (const r of rows) {
    map.set(Number(r.id_prod), Number(r.vendas12m));
  }

  logger.info({ skus: map.size }, 'Vendas 12m carregadas');
  return map;
}

/**
 * Maps vendas12m (by codigo_produto) to product codigo.
 * Uses tbl_produtos_Q2P to resolve codigo_produto → codigo.
 */
export async function getVendas12mByCodigo(): Promise<Map<string, number>> {
  const pool = getPool();

  const { rows } = await pool.query<{ codigo: string; vendas12m: string }>(`
    SELECT
      p.codigo,
      SUM(ABS(m.qtde)) AS vendas12m
    FROM "tbl_movimentacaoEstoqueHistorico_Q2P" m
    JOIN "tbl_produtos_Q2P" p ON p.codigo_produto = m.id_prod
    WHERE m.des_origem = 'Venda de Produto'
      AND (m.cancelamento IS NULL OR m.cancelamento != 'S')
      AND m.dt_mov >= CURRENT_DATE - INTERVAL '365 days'
    GROUP BY p.codigo
  `);

  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.codigo, Number(r.vendas12m));
  }

  logger.debug({ skus: map.size }, 'Vendas 12m by codigo loaded');
  return map;
}
