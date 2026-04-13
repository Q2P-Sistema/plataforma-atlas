import { getPool, createLogger } from '@atlas/core';

const logger = createLogger('forecast:pedidos');

export interface PedidoEmRota {
  codigo_produto_q2p: string;
  descricao: string;
  qtd_pendente: number;
  data_chegada: string;
  valor_brl: number;
  fornecedor_cod: number;
}

/**
 * Reads open/approved purchase orders from Acxe.
 * Maps to Q2P products via descricao match (ACXE and Q2P have different codigos but same descricao).
 * Returns pending arrivals with expected dates.
 */
export async function getPedidosEmRota(): Promise<PedidoEmRota[]> {
  const pool = getPool();

  const { rows } = await pool.query<{
    codigo_q2p: string;
    descricao: string;
    qtd_pendente: string;
    data_chegada: string;
    valor_brl: string;
    ncodfor: string;
  }>(`
    SELECT
      pq.codigo AS codigo_q2p,
      pa.descricao,
      (pc.nqtde - COALESCE(pc.nqtderec, 0))::numeric AS qtd_pendente,
      pc.ddtprevisao AS data_chegada,
      pc.nvaltot::numeric AS valor_brl,
      pc.ncodfor::text AS ncodfor
    FROM "tbl_pedidosCompras_ACXE" pc
    JOIN "tbl_produtos_ACXE" pa ON pa.codigo_produto = pc.ncodprod
    JOIN "tbl_produtos_Q2P" pq ON pq.descricao = pa.descricao
    WHERE pc.cetapa IN ('10', '20')
      AND (pc.nqtde - COALESCE(pc.nqtderec, 0)) > 0
      AND pc.ddtprevisao IS NOT NULL
    ORDER BY pc.ddtprevisao
  `);

  const pedidos = rows.map((r) => ({
    codigo_produto_q2p: r.codigo_q2p,
    descricao: r.descricao,
    qtd_pendente: Number(r.qtd_pendente),
    data_chegada: r.data_chegada,
    valor_brl: Number(r.valor_brl),
    fornecedor_cod: Number(r.ncodfor),
  }));

  logger.info({ pedidos: pedidos.length }, 'Pedidos em rota carregados');
  return pedidos;
}

/**
 * Groups pending arrivals by Q2P product codigo.
 * Returns Map<codigo, Array<{date, qty}>> for forecast injection.
 */
export async function getChegadasPorProduto(): Promise<Map<string, Array<{ data: string; qtd: number }>>> {
  const pedidos = await getPedidosEmRota();
  const map = new Map<string, Array<{ data: string; qtd: number }>>();

  for (const p of pedidos) {
    if (!map.has(p.codigo_produto_q2p)) {
      map.set(p.codigo_produto_q2p, []);
    }
    map.get(p.codigo_produto_q2p)!.push({
      data: p.data_chegada,
      qtd: p.qtd_pendente,
    });
  }

  return map;
}
