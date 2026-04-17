import { getPool, createLogger } from '@atlas/core';
import {
  calcularCobertura,
  classificarCriticidade,
  type Criticidade,
} from './motor.service.js';

const logger = createLogger('stockbridge:cockpit');

export type FiltroCnpj = 'acxe' | 'q2p' | 'ambos';
export type FiltroCriticidade = Criticidade | 'todas';

export interface CockpitFiltros {
  familia?: string;
  cnpj?: FiltroCnpj;
  criticidade?: FiltroCriticidade;
}

export interface CockpitSku {
  codigoAcxe: number;
  nome: string;
  familia: string | null;
  ncm: string | null;
  fisicaT: number;
  fiscalT: number;
  transitoIntlT: number;
  portoDtaT: number;
  transitoInternoT: number;
  provisorioT: number;
  consumoMedioDiarioT: number | null;
  leadTimeDias: number | null;
  coberturaDias: number | null;
  criticidade: Criticidade;
  divergencias: number;
  aprovacoesPendentes: number;
}

export interface CockpitResumo {
  totalFisicoT: number;
  totalFiscalT: number;
  transitoIntlT: number;
  portoDtaT: number;
  transitoInternoT: number;
  provisorioT: number;
  divergenciasCount: number;
  aprovacoesPendentes: number;
  skusCriticos: number;
  skusAlerta: number;
}

export interface CockpitData {
  resumo: CockpitResumo;
  skus: CockpitSku[];
}

/**
 * Retorna dados consolidados para o cockpit de estoque (US2).
 *
 * Estrategia:
 * 1. Agrega saldo por produto usando `shared.vw_sb_saldo_por_produto`
 *    (criada na migration 0009). Filtra por CNPJ se especificado.
 * 2. Enriquece com metadados do produto vindos de `public.tb_produtos_ACXE`
 *    (sync n8n). Filtra por `stockbridge.config_produto.incluir_em_metricas`
 *    quando a familia foi flagada como excluida.
 * 3. Junta config de consumo medio + lead time para calcular cobertura/
 *    criticidade em TypeScript (Principio III — calculos financeiros em TS).
 * 4. Calcula totalizadores para o painel superior.
 *
 * Em ambientes sem as tabelas OMIE sincronizadas (dev local sem sync),
 * retorna apenas lotes que existem em stockbridge.* — a lista pode ficar vazia.
 */
export async function getCockpit(filtros: CockpitFiltros = {}): Promise<CockpitData> {
  const pool = getPool();
  const cnpjFilter = filtros.cnpj && filtros.cnpj !== 'ambos' ? filtros.cnpj : null;

  // 1. Saldo agregado por produto (soma cross-CNPJ ou filtrado)
  //    Join de `vw_sb_saldo_por_produto` com metadados de produto e config.
  //    LEFT JOIN na view de produtos porque pode nao existir (dev sem sync).
  const sql = `
    WITH saldo AS (
      SELECT
        v.produto_codigo_acxe,
        SUM(v.fisica_disponivel_t)  AS fisica_t,
        SUM(v.fiscal_t)             AS fiscal_t,
        SUM(v.provisorio_t)         AS provisorio_t,
        SUM(v.transito_intl_t)      AS transito_intl_t,
        SUM(v.porto_dta_t)          AS porto_dta_t,
        SUM(v.transito_interno_t)   AS transito_interno_t
      FROM shared.vw_sb_saldo_por_produto v
      WHERE ($1::text IS NULL OR v.cnpj ILIKE '%' || $1 || '%')
      GROUP BY v.produto_codigo_acxe
    ),
    divs AS (
      SELECT l.produto_codigo_acxe, COUNT(*)::int AS c
      FROM stockbridge.divergencia d
      INNER JOIN stockbridge.lote l ON l.id = d.lote_id
      WHERE d.status = 'aberta' AND l.ativo = true
      GROUP BY l.produto_codigo_acxe
    ),
    apr AS (
      SELECT l.produto_codigo_acxe, COUNT(*)::int AS c
      FROM stockbridge.aprovacao a
      INNER JOIN stockbridge.lote l ON l.id = a.lote_id
      WHERE a.status = 'pendente' AND l.ativo = true
      GROUP BY l.produto_codigo_acxe
    )
    SELECT
      s.produto_codigo_acxe,
      COALESCE(p.descricao, 'Produto ' || s.produto_codigo_acxe::text) AS nome,
      p.descricao_familia AS familia,
      p.ncm,
      COALESCE(s.fisica_t, 0)          AS fisica_t,
      COALESCE(s.fiscal_t, 0)          AS fiscal_t,
      COALESCE(s.transito_intl_t, 0)   AS transito_intl_t,
      COALESCE(s.porto_dta_t, 0)       AS porto_dta_t,
      COALESCE(s.transito_interno_t,0) AS transito_interno_t,
      COALESCE(s.provisorio_t, 0)      AS provisorio_t,
      c.consumo_medio_diario_t,
      c.lead_time_dias,
      c.familia_categoria,
      COALESCE(c.incluir_em_metricas, true) AS incluir,
      COALESCE(d.c, 0) AS divs,
      COALESCE(a.c, 0) AS aprs
    FROM saldo s
    LEFT JOIN public.tb_produtos_ACXE p ON p.codigo_produto = s.produto_codigo_acxe
    LEFT JOIN stockbridge.config_produto c ON c.produto_codigo_acxe = s.produto_codigo_acxe
    LEFT JOIN divs d ON d.produto_codigo_acxe = s.produto_codigo_acxe
    LEFT JOIN apr  a ON a.produto_codigo_acxe = s.produto_codigo_acxe
    WHERE COALESCE(c.incluir_em_metricas, true) = true
      AND ($2::text IS NULL OR c.familia_categoria = $2 OR p.descricao_familia ILIKE $2 || '%')
    ORDER BY COALESCE(p.descricao, s.produto_codigo_acxe::text)
  `;

  let rows: Record<string, unknown>[] = [];
  try {
    const result = await pool.query(sql, [cnpjFilter, filtros.familia ?? null]);
    rows = result.rows as Record<string, unknown>[];
  } catch (err) {
    // View pode nao existir (dev sem sync OMIE) — retorna vazio com log
    logger.warn(
      { err: (err as Error).message },
      'Cockpit query falhou (view ou tabelas OMIE ausentes?). Retornando vazio.',
    );
    rows = [];
  }

  const skus: CockpitSku[] = rows.map((r) => {
    const fisicaT = Number(r.fisica_t);
    const consumo = r.consumo_medio_diario_t != null ? Number(r.consumo_medio_diario_t) : null;
    const leadTime = r.lead_time_dias != null ? Number(r.lead_time_dias) : null;
    const cobertura = calcularCobertura(fisicaT, consumo);
    const criticidade = classificarCriticidade(cobertura, leadTime, fisicaT, consumo);

    return {
      codigoAcxe: Number(r.produto_codigo_acxe),
      nome: String(r.nome),
      familia: (r.familia as string | null) ?? (r.familia_categoria as string | null) ?? null,
      ncm: (r.ncm as string | null) ?? null,
      fisicaT,
      fiscalT: Number(r.fiscal_t),
      transitoIntlT: Number(r.transito_intl_t),
      portoDtaT: Number(r.porto_dta_t),
      transitoInternoT: Number(r.transito_interno_t),
      provisorioT: Number(r.provisorio_t),
      consumoMedioDiarioT: consumo,
      leadTimeDias: leadTime,
      coberturaDias: cobertura,
      criticidade,
      divergencias: Number(r.divs),
      aprovacoesPendentes: Number(r.aprs),
    };
  });

  // Filtro por criticidade acontece no TS (calculado acima)
  const skusFiltrados =
    filtros.criticidade && filtros.criticidade !== 'todas'
      ? skus.filter((s) => s.criticidade === filtros.criticidade)
      : skus;

  const resumo = getResumoFromSkus(skusFiltrados);

  return { resumo, skus: skusFiltrados };
}

export function getResumoFromSkus(skus: CockpitSku[]): CockpitResumo {
  let totalFisicoT = 0;
  let totalFiscalT = 0;
  let transitoIntlT = 0;
  let portoDtaT = 0;
  let transitoInternoT = 0;
  let provisorioT = 0;
  let divergenciasCount = 0;
  let aprovacoesPendentes = 0;
  let skusCriticos = 0;
  let skusAlerta = 0;

  for (const s of skus) {
    totalFisicoT += s.fisicaT;
    totalFiscalT += s.fiscalT;
    transitoIntlT += s.transitoIntlT;
    portoDtaT += s.portoDtaT;
    transitoInternoT += s.transitoInternoT;
    provisorioT += s.provisorioT;
    divergenciasCount += s.divergencias;
    aprovacoesPendentes += s.aprovacoesPendentes;
    if (s.criticidade === 'critico') skusCriticos += 1;
    if (s.criticidade === 'alerta') skusAlerta += 1;
  }

  return {
    totalFisicoT,
    totalFiscalT,
    transitoIntlT,
    portoDtaT,
    transitoInternoT,
    provisorioT,
    divergenciasCount,
    aprovacoesPendentes,
    skusCriticos,
    skusAlerta,
  };
}
