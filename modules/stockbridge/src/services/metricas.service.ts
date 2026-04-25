import { getPool, createLogger } from '@atlas/core';

const logger = createLogger('stockbridge:metricas');

export interface MetricasKPIs {
  valorEstoqueBrl: number;
  valorEstoqueUsd: number;
  exposicaoCambialUsd: number;
  exposicaoCambialBrl: number;
  giroMedioDias: Record<string, number>;
  taxaDivergenciaPct: number;
  ptaxBrl: number;
}

export interface EvolucaoMensal {
  mes: string;
  familia: string | null;
  quantidadeKg: number;
  valorBrl: number;
}

export interface TabelaAnaliticaSku {
  codigoAcxe: number;
  nome: string;
  familia: string | null;
  ncm: string | null;
  quantidadeKg: number;
  cmpUsdTon: number;
  valorBrl: number;
  coberturaDias: number | null;
  divergencias: number;
}

/**
 * Calcula CMP (custo medio ponderado) em USD/tonelada para uma lista de lotes.
 * Pura — testavel sem DB.
 * Quantidade em kg e custo em USD/tonelada sao convertidos para ton antes da media.
 */
export function calcularCMP(lotes: Array<{ quantidadeFisicaKg: number; custoBrlKg: number | null }>): number {
  let totalUsd = 0;
  let totalTon = 0;
  for (const l of lotes) {
    if (l.custoBrlKg != null && l.custoBrlKg > 0 && l.quantidadeFisicaKg > 0) {
      const qtyTon = l.quantidadeFisicaKg / 1000;
      totalUsd += qtyTon * l.custoBrlKg;
      totalTon += qtyTon;
    }
  }
  return totalTon > 0 ? totalUsd / totalTon : 0;
}

/**
 * Soma exposicao cambial (USD) considerando apenas lotes em transito_intl
 * (unico estagio com preco USD nao liquidado em BRL).
 */
export function calcularExposicaoCambial(
  lotes: Array<{ estagioTransito: string | null; quantidadeFisicaKg: number; custoBrlKg: number | null; ativo: boolean }>,
): number {
  let exposicao = 0;
  for (const l of lotes) {
    if (l.ativo && l.estagioTransito === 'transito_intl' && l.custoBrlKg != null && l.custoBrlKg > 0) {
      exposicao += (l.quantidadeFisicaKg / 1000) * l.custoBrlKg;
    }
  }
  return exposicao;
}

/**
 * Retorna PTAX corrente (venda) via servico do hedge. Com fallback para 1.0 se
 * hedge nao disponivel (dev sem dependencia cruzada).
 */
async function getPtaxCorrente(): Promise<number> {
  try {
    // Dynamic import para evitar dependencia dura entre modulos
    const hedge = await import('@atlas/hedge' as string).catch(() => null);
    if (hedge && typeof (hedge as { ptaxService?: unknown }).ptaxService === 'object') {
      const svc = (hedge as { ptaxService: { getAtual?: () => Promise<{ venda: number }> } }).ptaxService;
      const atual = await svc.getAtual?.();
      if (atual && atual.venda > 0) return atual.venda;
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'PTAX via hedge indisponivel, usando fallback 5.0');
  }
  return 5.0; // Fallback heuristico (dev)
}

/**
 * KPIs consolidados do StockBridge para o Diretor.
 * Le saldo por lote, calcula CMP + exposicao cambial, aplica PTAX.
 */
export async function getKPIs(): Promise<MetricasKPIs> {
  const pool = getPool();
  const ptax = await getPtaxCorrente();

  const saldoRes = await pool.query(`
    SELECT
      quantidade_fisica_kg::numeric AS qtd,
      custo_brl_kg::numeric AS custo_brl_kg,
      estagio_transito,
      ativo
    FROM stockbridge.lote
    WHERE ativo = true
  `).catch((err) => {
    logger.warn({ err: err.message }, 'Query de lotes falhou');
    return { rows: [] };
  });

  const lotes = (saldoRes.rows as Array<{ qtd: string; custo_brl_kg: string | null; estagio_transito: string | null; ativo: boolean }>).map((r) => ({
    quantidadeFisicaKg: Number(r.qtd),
    custoBrlKg: r.custo_brl_kg != null ? Number(r.custo_brl_kg) : null,
    estagioTransito: r.estagio_transito,
    ativo: r.ativo,
  }));

  // Valor de estoque = saldo reconciliado/provisorio (excluido transito)
  const estoqueFisico = lotes.filter((l) => l.estagioTransito == null);
  const cmpUsdTon = calcularCMP(estoqueFisico);
  const totalKg = estoqueFisico.reduce((acc, l) => acc + l.quantidadeFisicaKg, 0);
  const valorEstoqueUsd = (totalKg / 1000) * cmpUsdTon;
  const valorEstoqueBrl = valorEstoqueUsd * ptax;

  const exposicaoUsd = calcularExposicaoCambial(lotes);
  const exposicaoBrl = exposicaoUsd * ptax;

  // Giro medio por familia (consumo_medio_diario_kg da config_produto)
  const giroRes = await pool.query(`
    SELECT
      c.familia_categoria AS fam,
      AVG(CASE
        WHEN c.consumo_medio_diario_kg > 0
        THEN (SELECT COALESCE(SUM(quantidade_fisica_kg), 0)
              FROM stockbridge.lote l
              WHERE l.produto_codigo_acxe = c.produto_codigo_acxe
              AND l.ativo = true AND l.estagio_transito IS NULL) / c.consumo_medio_diario_kg
        ELSE NULL END)::numeric AS dias_medio
    FROM stockbridge.config_produto c
    WHERE c.incluir_em_metricas = true AND c.familia_categoria IS NOT NULL
    GROUP BY c.familia_categoria
  `).catch(() => ({ rows: [] }));

  const giro: Record<string, number> = {};
  for (const r of giroRes.rows as Array<{ fam: string; dias_medio: string | null }>) {
    if (r.dias_medio) giro[r.fam] = Math.round(Number(r.dias_medio));
  }

  // Taxa divergencia = divergencias abertas / total lotes ativos
  const divRes = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM stockbridge.divergencia WHERE status = 'aberta')::int AS abertas,
      (SELECT COUNT(*) FROM stockbridge.lote WHERE ativo = true)::int AS total
  `).catch(() => ({ rows: [{ abertas: 0, total: 1 }] }));

  const { abertas, total } = divRes.rows[0] as { abertas: number; total: number };
  const taxaDivergenciaPct = total > 0 ? Number(((abertas / total) * 100).toFixed(1)) : 0;

  return {
    valorEstoqueBrl: Math.round(valorEstoqueBrl),
    valorEstoqueUsd: Math.round(valorEstoqueUsd),
    exposicaoCambialUsd: Math.round(exposicaoUsd),
    exposicaoCambialBrl: Math.round(exposicaoBrl),
    giroMedioDias: giro,
    taxaDivergenciaPct,
    ptaxBrl: ptax,
  };
}

/**
 * Retorna serie mensal por familia (quantidade + valor BRL) dos ultimos N meses.
 * Derivada de stockbridge.movimentacao (entradas positivas, saidas negativas).
 */
export async function getEvolucao(meses: number = 6): Promise<EvolucaoMensal[]> {
  const pool = getPool();
  const res = await pool.query(`
    SELECT
      to_char(date_trunc('month', m.created_at), 'YYYY-MM') AS mes,
      c.familia_categoria AS familia,
      SUM(ABS(m.quantidade_kg))::numeric AS qtd,
      SUM(ABS(m.quantidade_kg) / 1000.0 * COALESCE(l.custo_brl_kg, 0) * 5.0)::numeric AS valor_brl
    FROM stockbridge.movimentacao m
    LEFT JOIN stockbridge.lote l ON l.id = m.lote_id
    LEFT JOIN stockbridge.config_produto c ON c.produto_codigo_acxe = l.produto_codigo_acxe
    WHERE m.ativo = true
      AND m.created_at >= NOW() - ($1 || ' months')::interval
    GROUP BY mes, c.familia_categoria
    ORDER BY mes ASC
  `, [meses]).catch((err) => {
    logger.warn({ err: err.message }, 'Query de evolucao falhou');
    return { rows: [] };
  });

  return (res.rows as Array<{ mes: string; familia: string | null; qtd: string; valor_brl: string }>).map((r) => ({
    mes: r.mes,
    familia: r.familia,
    quantidadeKg: Number(r.qtd),
    valorBrl: Number(r.valor_brl),
  }));
}

export async function getTabelaAnalitica(): Promise<TabelaAnaliticaSku[]> {
  const pool = getPool();
  const ptax = await getPtaxCorrente();

  const res = await pool.query(`
    WITH saldo AS (
      SELECT
        l.produto_codigo_acxe,
        SUM(l.quantidade_fisica_kg)::numeric AS qtd_kg,
        CASE WHEN SUM(l.quantidade_fisica_kg) > 0
             THEN SUM(l.quantidade_fisica_kg * COALESCE(l.custo_brl_kg, 0)) / SUM(l.quantidade_fisica_kg)
             ELSE 0 END::numeric AS cmp_usd_ton
      FROM stockbridge.lote l
      WHERE l.ativo = true AND l.estagio_transito IS NULL
      GROUP BY l.produto_codigo_acxe
    ),
    divs AS (
      SELECT l.produto_codigo_acxe, COUNT(*)::int AS c
      FROM stockbridge.divergencia d
      INNER JOIN stockbridge.lote l ON l.id = d.lote_id
      WHERE d.status = 'aberta' AND l.ativo = true
      GROUP BY l.produto_codigo_acxe
    )
    SELECT
      s.produto_codigo_acxe,
      COALESCE(p.descricao, 'Produto ' || s.produto_codigo_acxe::text) AS nome,
      COALESCE(c.familia_categoria, p.descricao_familia) AS familia,
      p.ncm,
      s.qtd_kg,
      s.cmp_usd_ton,
      c.consumo_medio_diario_kg,
      COALESCE(d.c, 0) AS divs
    FROM saldo s
    LEFT JOIN public."tbl_produtos_ACXE" p ON p.codigo_produto = s.produto_codigo_acxe
    LEFT JOIN stockbridge.config_produto c ON c.produto_codigo_acxe = s.produto_codigo_acxe
    LEFT JOIN divs d ON d.produto_codigo_acxe = s.produto_codigo_acxe
    WHERE COALESCE(c.incluir_em_metricas, true) = true
    ORDER BY (s.qtd_kg * s.cmp_usd_ton) DESC
  `).catch((err) => {
    logger.warn({ err: err.message }, 'Query tabela analitica falhou');
    return { rows: [] };
  });

  return (res.rows as Array<{ produto_codigo_acxe: number; nome: string; familia: string | null; ncm: string | null; qtd_kg: string; cmp_usd_ton: string; consumo_medio_diario_kg: string | null; divs: number }>).map((r) => {
    const qtdKg = Number(r.qtd_kg);
    const cmpUsdTon = Number(r.cmp_usd_ton);
    const consumoKg = r.consumo_medio_diario_kg != null ? Number(r.consumo_medio_diario_kg) : null;
    const cobertura = consumoKg && consumoKg > 0 ? Math.round(qtdKg / consumoKg) : null;
    return {
      codigoAcxe: Number(r.produto_codigo_acxe),
      nome: String(r.nome),
      familia: r.familia,
      ncm: r.ncm,
      quantidadeKg: qtdKg,
      cmpUsdTon,
      valorBrl: Math.round((qtdKg / 1000) * cmpUsdTon * ptax),
      coberturaDias: cobertura,
      divergencias: Number(r.divs),
    };
  });
}
