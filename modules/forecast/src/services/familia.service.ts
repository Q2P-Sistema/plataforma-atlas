import { getPool, createLogger } from '@atlas/core';

const logger = createLogger('forecast:familia');

export interface SkuEstoque {
  codigo: string;
  descricao: string;
  local: string;
  disponivel: number;
  bloqueado: number;
  transito: number;
  total: number;
  cmc: number;
  lead_time: number;
  marca: string;
}

export interface FamiliaEstoque {
  familia_id: string;
  familia_nome: string;
  is_internacional: boolean;
  pool_disponivel: number;
  pool_bloqueado: number;
  pool_transito: number;
  pool_total: number;
  cmc_medio: number;
  lt_efetivo: number;
  skus: SkuEstoque[];
}

/**
 * Reads all product families with 3-layer stock from BD OMIE.
 * Groups by descricao_familia, calculates aggregates.
 */
export async function getFamilias(): Promise<FamiliaEstoque[]> {
  const pool = getPool();

  const { rows } = await pool.query<{
    codigo: string;
    descricao: string;
    descricao_familia: string;
    local_descricao: string;
    nsaldo: number;
    reservado: number;
    npendente: number;
    ncmc: number;
    lead_time: number | null;
    marca: string | null;
  }>(`
    SELECT
      p.codigo,
      p.descricao,
      COALESCE(p.descricao_familia, 'Outros') AS descricao_familia,
      COALESCE(le.descricao, 'Desconhecido') AS local_descricao,
      COALESCE(e.nsaldo, 0) AS nsaldo,
      COALESCE(e.reservado, 0) AS reservado,
      COALESCE(e.npendente, 0) AS npendente,
      COALESCE(e.ncmc, 0) AS ncmc,
      p.lead_time,
      p.marca
    FROM "tbl_produtos_Q2P" p
    LEFT JOIN "tbl_posicaoEstoque_Q2P" e ON e.ccodigo = p.codigo
    LEFT JOIN "tbl_locaisEstoques_Q2P" le ON le.codigo_local_estoque = e.codigo_local_estoque
    WHERE e.nsaldo > 0 OR e.npendente > 0
    ORDER BY p.descricao_familia, p.descricao
  `);

  // Group by familia
  const familiaMap = new Map<string, { skus: SkuEstoque[]; hasImpacxe: boolean }>();

  for (const r of rows) {
    const famId = r.descricao_familia;
    if (!familiaMap.has(famId)) {
      familiaMap.set(famId, { skus: [], hasImpacxe: false });
    }
    const fam = familiaMap.get(famId)!;

    const disponivel = Math.max(0, r.nsaldo - r.reservado);
    fam.skus.push({
      codigo: r.codigo,
      descricao: r.descricao,
      local: r.local_descricao,
      disponivel,
      bloqueado: r.reservado,
      transito: r.npendente,
      total: disponivel + r.reservado + r.npendente,
      cmc: Number(r.ncmc),
      lead_time: r.lead_time ?? 60,
      marca: r.marca ?? '',
    });

    if (r.marca === 'IMPACXE') fam.hasImpacxe = true;
  }

  const familias: FamiliaEstoque[] = [];
  for (const [famId, data] of familiaMap) {
    const poolDisp = data.skus.reduce((s, sk) => s + sk.disponivel, 0);
    const poolBloq = data.skus.reduce((s, sk) => s + sk.bloqueado, 0);
    const poolTrans = data.skus.reduce((s, sk) => s + sk.transito, 0);
    const poolTotal = poolDisp + poolBloq + poolTrans;

    // CMC medio ponderado pelo total
    const cmcSum = data.skus.reduce((s, sk) => s + sk.cmc * sk.total, 0);
    const cmcMedio = poolTotal > 0 ? cmcSum / poolTotal : 0;

    // LT efetivo = menor LT entre os SKUs da familia
    const ltEfetivo = Math.min(...data.skus.map((sk) => sk.lead_time));

    familias.push({
      familia_id: famId,
      familia_nome: famId,
      is_internacional: data.hasImpacxe,
      pool_disponivel: poolDisp,
      pool_bloqueado: poolBloq,
      pool_transito: poolTrans,
      pool_total: poolTotal,
      cmc_medio: parseFloat(cmcMedio.toFixed(2)),
      lt_efetivo: ltEfetivo,
      skus: data.skus,
    });
  }

  logger.info({ familias: familias.length, skus: rows.length }, 'Familias carregadas');
  return familias.sort((a, b) => b.pool_total - a.pool_total);
}
