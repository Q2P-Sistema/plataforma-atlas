import { getPool, createLogger } from '@atlas/core';

const logger = createLogger('forecast:vendas');

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
