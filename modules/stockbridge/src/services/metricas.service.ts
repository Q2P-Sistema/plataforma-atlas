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
  cmpBrlKg: number;
  valorBrl: number;
  coberturaDias: number | null;
  divergencias: number;
}

/**
 * Calcula CMP (custo medio ponderado) em BRL/kg para uma lista de lotes.
 * Pura — testavel sem DB.
 *
 * Antes (fix 2026-04-29): retornava "USD/tonelada" mas usava custoBrlKg, gerando
 * unidade quebrada — agora honestamente retorna BRL/kg.
 */
export function calcularCMP(lotes: Array<{ quantidadeFisicaKg: number; custoBrlKg: number | null }>): number {
  let totalBrl = 0;
  let totalKg = 0;
  for (const l of lotes) {
    if (l.custoBrlKg != null && l.custoBrlKg > 0 && l.quantidadeFisicaKg > 0) {
      totalBrl += l.quantidadeFisicaKg * l.custoBrlKg;
      totalKg += l.quantidadeFisicaKg;
    }
  }
  return totalKg > 0 ? totalBrl / totalKg : 0;
}

/**
 * Soma exposicao em BRL considerando apenas lotes em transito_intl (estagio
 * em que o preco ainda nao foi liquidado pela ACXE no destino).
 *
 * Retorna BRL: kg * (BRL/kg) = BRL. (No legado o calculo dividia kg por 1000
 * sem ajustar o custo, gerando valor 1000x menor — fix em 2026-04-29.)
 */
export function calcularExposicaoCambial(
  lotes: Array<{ estagioTransito: string | null; quantidadeFisicaKg: number; custoBrlKg: number | null; ativo: boolean }>,
): number {
  let exposicao = 0;
  for (const l of lotes) {
    if (l.ativo && l.estagioTransito === 'transito_intl' && l.custoBrlKg != null && l.custoBrlKg > 0) {
      exposicao += l.quantidadeFisicaKg * l.custoBrlKg;
    }
  }
  return exposicao;
}

/**
 * Cache em memoria da PTAX. PTAX BCB e divulgada 1x ao dia (~13h), entao 30min
 * de TTL e suficiente pra evitar N requests por refresh do cockpit/metricas
 * sem ficar desatualizado. Cache zera no restart do processo (aceitavel).
 */
const PTAX_CACHE_TTL_MS = 30 * 60 * 1000;
let ptaxCache: { venda: number; fetchedAt: number } | null = null;

/**
 * Retorna PTAX corrente (venda) consumindo o cliente BCB diretamente.
 * StockBridge nao depende do modulo @atlas/hedge — usa @atlas/integration-bcb
 * direto e cacheia em memoria. Fallback heuristico 5.0 se BCB falhar e cache vazio.
 */
async function getPtaxCorrente(): Promise<number> {
  if (ptaxCache && Date.now() - ptaxCache.fetchedAt < PTAX_CACHE_TTL_MS) {
    return ptaxCache.venda;
  }

  try {
    const { fetchPtaxAtual } = await import('@atlas/integration-bcb');
    const quote = await fetchPtaxAtual();
    if (quote.venda > 0) {
      ptaxCache = { venda: quote.venda, fetchedAt: Date.now() };
      return quote.venda;
    }
    logger.warn({ quote }, 'PTAX BCB retornou venda <= 0 — usando fallback 5.0');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'fetchPtaxAtual (BCB) falhou — usando fallback 5.0');
  }

  // Em ultimo caso, devolve cache stale se existir; senao fallback heuristico.
  return ptaxCache?.venda ?? 5.0;
}

/**
 * KPIs consolidados do StockBridge para o Diretor (arquitetura hibrida).
 *
 * Valor de estoque vem de OMIE (vw_posicaoEstoqueUnificadaFamilia) — fonte de
 * verdade do saldo fisico + custo unitario por SKU. Exposicao cambial vem de
 * stockbridge.lote em transito_intl (Atlas-only — FUP de Comex; OMIE nao tem).
 *
 * Filtros aplicados pra evitar dupla contagem (espelhado .1 ACXE↔Q2P → Q2P) e
 * pra excluir familias desativadas (familia_omie_atlas.incluir_em_metricas=false).
 */
export async function getKPIs(): Promise<MetricasKPIs> {
  const pool = getPool();
  const ptax = await getPtaxCorrente();

  // Valor de estoque a partir do OMIE
  const valorEstoqueRes = await pool.query(`
    SELECT
      SUM(o.saldo * COALESCE(o.valor_unitario, 0))::numeric AS valor_brl,
      SUM(o.saldo)::numeric                                AS total_kg
    FROM public."vw_posicaoEstoqueUnificadaFamilia" o
    INNER JOIN public."tbl_produtos_ACXE" pa ON pa.descricao = o.descricao_produto
    LEFT JOIN stockbridge.familia_omie_atlas f ON f.familia_omie = pa.descricao_familia
    LEFT JOIN stockbridge.config_produto c ON c.produto_codigo_acxe = pa.codigo_produto
    WHERE o.saldo > 0
      AND (
        (o.codigo_estoque LIKE '%.1' AND o.empresa = 'Q2P')
        OR
        (o.codigo_estoque LIKE '%.2' AND o.empresa = 'Q2P')
      )
      AND COALESCE(f.incluir_em_metricas, true) = true
      AND COALESCE(c.incluir_em_metricas, true) = true
  `).catch((err) => {
    logger.warn({ err: err.message }, 'Query de valor de estoque OMIE falhou');
    return { rows: [{ valor_brl: '0', total_kg: '0' }] };
  });

  const { valor_brl, total_kg } = valorEstoqueRes.rows[0] as { valor_brl: string | null; total_kg: string | null };
  const valorEstoqueBrl = Number(valor_brl ?? 0);
  const totalKgEstoque = Number(total_kg ?? 0);
  const valorEstoqueUsd = ptax > 0 ? valorEstoqueBrl / ptax : 0;

  // Exposicao cambial: lotes em transito_intl × custo_brl_kg (Atlas-only — vem do FUP)
  const lotesRes = await pool.query(`
    SELECT
      quantidade_fisica_kg::numeric AS qtd,
      custo_brl_kg::numeric AS custo_brl_kg,
      estagio_transito,
      ativo
    FROM stockbridge.lote
    WHERE ativo = true
  `).catch(() => ({ rows: [] }));

  const lotes = (lotesRes.rows as Array<{ qtd: string; custo_brl_kg: string | null; estagio_transito: string | null; ativo: boolean }>).map((r) => ({
    quantidadeFisicaKg: Number(r.qtd),
    custoBrlKg: r.custo_brl_kg != null ? Number(r.custo_brl_kg) : null,
    estagioTransito: r.estagio_transito,
    ativo: r.ativo,
  }));

  void calcularCMP; // exportado pra testes; uso direto via SQL acima
  void totalKgEstoque; // disponivel se UI quiser exibir kg total separado

  const exposicaoBrl = calcularExposicaoCambial(lotes);
  const exposicaoUsd = ptax > 0 ? exposicaoBrl / ptax : 0;

  // Giro medio por familia: media (entre os SKUs da familia) de cobertura_dias.
  // cobertura_dias = saldo_fisico_OMIE / consumo_medio_diario_kg.
  // Saldo OMIE pra ser coerente com Cockpit/Valor de Estoque (arquitetura hibrida).
  const giroRes = await pool.query(`
    WITH saldo_omie_por_sku AS (
      SELECT pa.codigo_produto AS produto_codigo_acxe,
             SUM(o.saldo)::numeric AS qtd_kg
      FROM public."vw_posicaoEstoqueUnificadaFamilia" o
      INNER JOIN public."tbl_produtos_ACXE" pa ON pa.descricao = o.descricao_produto
      WHERE o.saldo > 0
        AND ((o.codigo_estoque LIKE '%.1' AND o.empresa = 'Q2P')
             OR (o.codigo_estoque LIKE '%.2' AND o.empresa = 'Q2P'))
      GROUP BY pa.codigo_produto
    )
    SELECT
      f.familia_atlas AS fam,
      AVG(CASE
        WHEN c.consumo_medio_diario_kg > 0
        THEN COALESCE(s.qtd_kg, 0) / c.consumo_medio_diario_kg
        ELSE NULL END)::numeric AS dias_medio
    FROM stockbridge.config_produto c
    INNER JOIN public."tbl_produtos_ACXE" p ON p.codigo_produto = c.produto_codigo_acxe
    INNER JOIN stockbridge.familia_omie_atlas f ON f.familia_omie = p.descricao_familia
    LEFT JOIN saldo_omie_por_sku s ON s.produto_codigo_acxe = c.produto_codigo_acxe
    WHERE c.incluir_em_metricas = true
      AND f.incluir_em_metricas = true
    GROUP BY f.familia_atlas
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
      f.familia_atlas AS familia,
      SUM(ABS(m.quantidade_kg))::numeric AS qtd,
      SUM(ABS(m.quantidade_kg) / 1000.0 * COALESCE(l.custo_brl_kg, 0) * 5.0)::numeric AS valor_brl
    FROM stockbridge.movimentacao m
    LEFT JOIN stockbridge.lote l ON l.id = m.lote_id
    LEFT JOIN public."tbl_produtos_ACXE" p ON p.codigo_produto = l.produto_codigo_acxe
    LEFT JOIN stockbridge.familia_omie_atlas f ON f.familia_omie = p.descricao_familia
    WHERE m.ativo = true
      AND m.created_at >= NOW() - ($1 || ' months')::interval
    GROUP BY mes, f.familia_atlas
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

  // Tabela analitica = saldo OMIE × custo medio OMIE por SKU (arquitetura hibrida).
  // Match cross-empresa por descricao (vw retorna codigo_produto text, nao numerico).
  const res = await pool.query(`
    WITH saldo_omie AS (
      SELECT
        pa.codigo_produto                                                AS produto_codigo_acxe,
        SUM(o.saldo)::numeric                                            AS qtd_kg,
        CASE WHEN SUM(o.saldo) > 0
             THEN SUM(o.saldo * COALESCE(o.valor_unitario, 0)) / SUM(o.saldo)
             ELSE 0 END::numeric                                         AS cmp_brl_kg
      FROM public."vw_posicaoEstoqueUnificadaFamilia" o
      INNER JOIN public."tbl_produtos_ACXE" pa ON pa.descricao = o.descricao_produto
      WHERE o.saldo > 0
        AND (
          (o.codigo_estoque LIKE '%.1' AND o.empresa = 'Q2P')
          OR
          (o.codigo_estoque LIKE '%.2' AND o.empresa = 'Q2P')
        )
      GROUP BY pa.codigo_produto
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
      COALESCE(f.familia_atlas, p.descricao_familia) AS familia,
      p.ncm,
      s.qtd_kg,
      s.cmp_brl_kg,
      c.consumo_medio_diario_kg,
      COALESCE(d.c, 0) AS divs
    FROM saldo_omie s
    LEFT JOIN public."tbl_produtos_ACXE" p ON p.codigo_produto = s.produto_codigo_acxe
    LEFT JOIN stockbridge.familia_omie_atlas f ON f.familia_omie = p.descricao_familia
    LEFT JOIN stockbridge.config_produto c ON c.produto_codigo_acxe = s.produto_codigo_acxe
    LEFT JOIN divs d ON d.produto_codigo_acxe = s.produto_codigo_acxe
    WHERE COALESCE(f.incluir_em_metricas, true) = true
      AND COALESCE(c.incluir_em_metricas, true) = true
    ORDER BY (s.qtd_kg * s.cmp_brl_kg) DESC
  `).catch((err) => {
    logger.warn({ err: err.message }, 'Query tabela analitica falhou');
    return { rows: [] };
  });

  return (res.rows as Array<{ produto_codigo_acxe: number; nome: string; familia: string | null; ncm: string | null; qtd_kg: string; cmp_brl_kg: string; consumo_medio_diario_kg: string | null; divs: number }>).map((r) => {
    const qtdKg = Number(r.qtd_kg);
    const cmpBrlKg = Number(r.cmp_brl_kg);
    const consumoKg = r.consumo_medio_diario_kg != null ? Number(r.consumo_medio_diario_kg) : null;
    const cobertura = consumoKg && consumoKg > 0 ? Math.round(qtdKg / consumoKg) : null;
    return {
      codigoAcxe: Number(r.produto_codigo_acxe),
      nome: String(r.nome),
      familia: r.familia,
      ncm: r.ncm,
      quantidadeKg: qtdKg,
      cmpBrlKg,
      valorBrl: Math.round(qtdKg * cmpBrlKg),
      coberturaDias: cobertura,
      divergencias: Number(r.divs),
    };
  });
}
