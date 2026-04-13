import { getPool, createLogger } from '@atlas/core';

const logger = createLogger('forecast:insights');

export interface FornecedorInfo {
  fornecedor: string;
  pais_origem: string;
  familias: string[];
  lt_efetivo_dias: number;
  total_importacoes: number;
  ultimo_embarque: string;
}

export interface ScoreCOMEX {
  mes: string;
  score: number;
  classificacao: 'COMPRAR' | 'BOM' | 'NEUTRO' | 'CAUTELA' | 'EVITAR';
  preco_ton_usd: number;
  volume_kg: number;
  taxa_dolar: number;
}

export interface HistoricoImportacao {
  mes: string;
  volume_kg: number;
  valor_usd: number;
  preco_ton_usd: number;
  taxa_dolar: number;
}

export interface InsightsResult {
  fornecedores: FornecedorInfo[];
  score_comex: ScoreCOMEX[];
  historico_importacao: HistoricoImportacao[];
}

function classificarScore(score: number): ScoreCOMEX['classificacao'] {
  if (score >= 70) return 'COMPRAR';
  if (score >= 55) return 'BOM';
  if (score >= 40) return 'NEUTRO';
  if (score >= 25) return 'CAUTELA';
  return 'EVITAR';
}

export async function getFornecedores(): Promise<FornecedorInfo[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    fornecedor: string;
    pais_origem: string;
    familias: string[];
    lt_dias: string;
    total: string;
    ultimo: string;
  }>(`
    SELECT
      fornecedor,
      COALESCE(pais_origem, 'Desconhecido') AS pais_origem,
      ARRAY_AGG(DISTINCT familia_produto) AS familias,
      ROUND(AVG(
        CASE WHEN data_desembarque IS NOT NULL AND data_proforma IS NOT NULL
        THEN data_desembarque - data_proforma ELSE NULL END
      ))::text AS lt_dias,
      COUNT(*)::text AS total,
      MAX(data_proforma)::text AS ultimo
    FROM "tbl_dadosPlanilhaFUPComex"
    WHERE fornecedor IS NOT NULL
    GROUP BY fornecedor, pais_origem
    ORDER BY total DESC
  `);

  return rows.map((r) => ({
    fornecedor: r.fornecedor,
    pais_origem: r.pais_origem,
    familias: r.familias.filter(Boolean),
    lt_efetivo_dias: Number(r.lt_dias) || 60,
    total_importacoes: Number(r.total),
    ultimo_embarque: r.ultimo,
  }));
}

export async function getScoreCOMEX(): Promise<ScoreCOMEX[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    mes: string;
    preco_ton_usd: string;
    volume_kg: string;
    taxa_dolar: string;
  }>(`
    SELECT
      TO_CHAR(data_proforma, 'YYYY-MM') AS mes,
      AVG(valor_total_tonelada_usd)::numeric AS preco_ton_usd,
      SUM(volume_total_kg)::numeric AS volume_kg,
      AVG(taxa_dolar)::numeric AS taxa_dolar
    FROM "tbl_dadosPlanilhaFUPComex"
    WHERE data_proforma >= CURRENT_DATE - INTERVAL '12 months'
      AND valor_total_tonelada_usd > 0
    GROUP BY TO_CHAR(data_proforma, 'YYYY-MM')
    ORDER BY mes
  `);

  if (rows.length === 0) return [];

  // Normalize scores
  const precos = rows.map((r) => Number(r.preco_ton_usd));
  const volumes = rows.map((r) => Number(r.volume_kg));
  const taxas = rows.map((r) => Number(r.taxa_dolar));

  const maxPreco = Math.max(...precos);
  const maxVolume = Math.max(...volumes);
  const maxTaxa = Math.max(...taxas);

  return rows.map((r, i) => {
    const preco = precos[i]!;
    const volume = volumes[i]!;
    const taxa = taxas[i]!;

    // Lower price = better, higher volume = better, lower cambio = better
    const precoScore = maxPreco > 0 ? (1 - preco / maxPreco) * 100 : 50;
    const volumeScore = maxVolume > 0 ? (volume / maxVolume) * 100 : 50;
    const cambioScore = maxTaxa > 0 ? (1 - taxa / maxTaxa) * 100 : 50;

    const score = Math.round(precoScore * 0.4 + volumeScore * 0.3 + cambioScore * 0.3);
    const clampedScore = Math.max(0, Math.min(100, score));

    return {
      mes: r.mes,
      score: clampedScore,
      classificacao: classificarScore(clampedScore),
      preco_ton_usd: parseFloat(preco.toFixed(2)),
      volume_kg: Math.round(volume),
      taxa_dolar: parseFloat(taxa.toFixed(2)),
    };
  });
}

export async function getHistoricoImportacao(): Promise<HistoricoImportacao[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    mes: string;
    volume_kg: string;
    valor_usd: string;
    preco_ton_usd: string;
    taxa_dolar: string;
  }>(`
    SELECT
      TO_CHAR(data_proforma, 'YYYY-MM') AS mes,
      SUM(volume_total_kg)::numeric AS volume_kg,
      SUM(valor_total_usd)::numeric AS valor_usd,
      AVG(valor_total_tonelada_usd)::numeric AS preco_ton_usd,
      AVG(taxa_dolar)::numeric AS taxa_dolar
    FROM "tbl_dadosPlanilhaFUPComex"
    WHERE data_proforma >= CURRENT_DATE - INTERVAL '12 months'
    GROUP BY TO_CHAR(data_proforma, 'YYYY-MM')
    ORDER BY mes
  `);

  return rows.map((r) => ({
    mes: r.mes,
    volume_kg: Math.round(Number(r.volume_kg)),
    valor_usd: Math.round(Number(r.valor_usd)),
    preco_ton_usd: parseFloat(Number(r.preco_ton_usd).toFixed(2)),
    taxa_dolar: parseFloat(Number(r.taxa_dolar).toFixed(2)),
  }));
}

export async function getInsights(): Promise<InsightsResult> {
  const [fornecedores, score_comex, historico_importacao] = await Promise.all([
    getFornecedores(),
    getScoreCOMEX(),
    getHistoricoImportacao(),
  ]);

  logger.info({ fornecedores: fornecedores.length, meses_score: score_comex.length }, 'Insights carregados');
  return { fornecedores, score_comex, historico_importacao };
}
