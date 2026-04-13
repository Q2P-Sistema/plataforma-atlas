import { getPool, createLogger } from '@atlas/core';

const logger = createLogger('forecast:demanda');

export interface SkuContribuicao {
  codigo: string;
  descricao: string;
  volume_24m: number;
  contribuicao_pct: number;
  cobertura_dias: number;
}

export interface VendaMensal {
  mes: string;
  volume_kg: number;
  valor_brl: number;
}

export interface YoYResult {
  trimestre_atual: number;
  trimestre_anterior: number;
  variacao_pct: number;
  tendencia: 'subindo' | 'descendo' | 'estavel';
}

export interface FamiliaDemanda {
  familia: string;
  meses: VendaMensal[];
  ultimos_3m: VendaMensal[];
  yoy: YoYResult;
  sparkline: number[];
  skus: SkuContribuicao[];
}

/**
 * Returns monthly sales by family for the last 24 months,
 * with YoY comparison, sparkline data, and per-SKU breakdown.
 */
export async function getVendasMensais(): Promise<FamiliaDemanda[]> {
  const pool = getPool();

  // Monthly sales by family (24 months)
  const { rows: vendasRows } = await pool.query<{
    familia: string;
    mes: string;
    volume_kg: string;
    valor_brl: string;
  }>(`
    SELECT
      COALESCE(p.descricao_familia, 'Outros') AS familia,
      TO_CHAR(m.dt_mov, 'YYYY-MM') AS mes,
      SUM(ABS(m.qtde))::numeric AS volume_kg,
      SUM(ABS(m.valor))::numeric AS valor_brl
    FROM "tbl_movimentacaoEstoqueHistorico_Q2P" m
    JOIN "tbl_produtos_Q2P" p ON p.codigo_produto = m.id_prod
    WHERE m.des_origem = 'Venda de Produto'
      AND (m.cancelamento IS NULL OR m.cancelamento != 'S')
      AND m.dt_mov >= CURRENT_DATE - INTERVAL '24 months'
    GROUP BY p.descricao_familia, TO_CHAR(m.dt_mov, 'YYYY-MM')
    ORDER BY p.descricao_familia, mes
  `);

  // SKU breakdown (24 months total)
  const { rows: skuRows } = await pool.query<{
    familia: string;
    codigo: string;
    descricao: string;
    volume_24m: string;
    estoque_total: string;
    venda_dia: string;
  }>(`
    SELECT
      COALESCE(p.descricao_familia, 'Outros') AS familia,
      p.codigo,
      p.descricao,
      SUM(ABS(m.qtde))::numeric AS volume_24m,
      COALESCE(e.nsaldo, 0) + COALESCE(e.npendente, 0) AS estoque_total,
      CASE WHEN SUM(ABS(m.qtde)) > 0 THEN ROUND(SUM(ABS(m.qtde)) / 730) ELSE 0 END AS venda_dia
    FROM "tbl_movimentacaoEstoqueHistorico_Q2P" m
    JOIN "tbl_produtos_Q2P" p ON p.codigo_produto = m.id_prod
    LEFT JOIN "tbl_posicaoEstoque_Q2P" e ON e.ccodigo = p.codigo
    WHERE m.des_origem = 'Venda de Produto'
      AND (m.cancelamento IS NULL OR m.cancelamento != 'S')
      AND m.dt_mov >= CURRENT_DATE - INTERVAL '24 months'
    GROUP BY p.descricao_familia, p.codigo, p.descricao, e.nsaldo, e.npendente
    ORDER BY p.descricao_familia, volume_24m DESC
  `);

  // Group vendas by familia
  const familiaMap = new Map<string, VendaMensal[]>();
  for (const r of vendasRows) {
    if (!familiaMap.has(r.familia)) familiaMap.set(r.familia, []);
    familiaMap.get(r.familia)!.push({
      mes: r.mes,
      volume_kg: Number(r.volume_kg),
      valor_brl: Number(r.valor_brl),
    });
  }

  // Group SKUs by familia
  const skuMap = new Map<string, typeof skuRows>();
  for (const r of skuRows) {
    if (!skuMap.has(r.familia)) skuMap.set(r.familia, []);
    skuMap.get(r.familia)!.push(r);
  }

  // Build result
  const hoje = new Date();
  const mesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;

  const result: FamiliaDemanda[] = [];

  for (const [familia, meses] of familiaMap) {
    // Sort chronologically
    meses.sort((a, b) => a.mes.localeCompare(b.mes));

    // Sparkline (24 months of volume)
    const sparkline = meses.map((m) => Math.round(m.volume_kg));

    // Last 3 closed months (exclude current month)
    const mesesFechados = meses.filter((m) => m.mes < mesAtual);
    const ultimos3m = mesesFechados.slice(-3);

    // YoY: last 3 closed months vs same 3 months last year
    const trimAtual = ultimos3m.reduce((s, m) => s + m.volume_kg, 0);
    const mesesAnoAnterior = ultimos3m.map((m) => {
      const [y, mo] = m.mes.split('-');
      return `${Number(y) - 1}-${mo}`;
    });
    const trimAnterior = mesesAnoAnterior.reduce((s, mesRef) => {
      const found = meses.find((m) => m.mes === mesRef);
      return s + (found?.volume_kg ?? 0);
    }, 0);

    const variacaoPct = trimAnterior > 0
      ? parseFloat(((trimAtual - trimAnterior) / trimAnterior * 100).toFixed(2))
      : 0;
    const tendencia: 'subindo' | 'descendo' | 'estavel' =
      variacaoPct > 10 ? 'subindo' : variacaoPct < -10 ? 'descendo' : 'estavel';

    // SKU breakdown
    const familiaSkus = skuMap.get(familia) ?? [];
    const totalVolume = familiaSkus.reduce((s, sk) => s + Number(sk.volume_24m), 0);
    const skus: SkuContribuicao[] = familiaSkus.map((sk) => {
      const vol = Number(sk.volume_24m);
      const vendaDia = Number(sk.venda_dia);
      const estoqueTotal = Number(sk.estoque_total);
      return {
        codigo: sk.codigo,
        descricao: sk.descricao,
        volume_24m: Math.round(vol),
        contribuicao_pct: totalVolume > 0 ? parseFloat((vol / totalVolume * 100).toFixed(1)) : 0,
        cobertura_dias: vendaDia > 0 ? Math.round(estoqueTotal / vendaDia) : 999,
      };
    });

    result.push({
      familia,
      meses,
      ultimos_3m: ultimos3m,
      yoy: { trimestre_atual: Math.round(trimAtual), trimestre_anterior: Math.round(trimAnterior), variacao_pct: variacaoPct, tendencia },
      sparkline,
      skus,
    });
  }

  // Sort by total volume descending
  result.sort((a, b) => {
    const va = a.meses.reduce((s, m) => s + m.volume_kg, 0);
    const vb = b.meses.reduce((s, m) => s + m.volume_kg, 0);
    return vb - va;
  });

  logger.info({ familias: result.length }, 'Vendas mensais carregadas');
  return result;
}
