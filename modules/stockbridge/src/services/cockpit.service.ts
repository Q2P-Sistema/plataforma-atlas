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
  galpao?: string;            // ex: '11', '12', '21', '31'
  criticidade?: FiltroCriticidade;
}

export interface CockpitSku {
  codigoAcxe: number;
  nome: string;
  familia: string | null;
  ncm: string | null;
  fisicaKg: number;          // saldo OMIE (fonte de verdade)
  fiscalKg: number;          // = fisicaKg na arquitetura híbrida (OMIE consolida ambos)
  transitoIntlKg: number;    // Atlas: stockbridge.lote status='transito' estagio='transito_intl'
  portoDtaKg: number;        // idem 'porto_dta'
  transitoInternoKg: number; // idem 'transito_interno'
  provisorioKg: number;      // Atlas: lote provisorio AINDA NAO consolidado pelo OMIE (anti-dupla-contagem)
  consumoMedioDiarioKg: number | null;
  leadTimeDias: number | null;
  coberturaDias: number | null;
  criticidade: Criticidade;
  divergencias: number;
  aprovacoesPendentes: number;
}

export interface CockpitResumo {
  totalFisicoKg: number;
  totalFiscalKg: number;
  transitoIntlKg: number;
  portoDtaKg: number;
  transitoInternoKg: number;
  provisorioKg: number;
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
 * Cockpit hibrido (Atlas como camada sobre OMIE — ver
 * specs/007-stockbridge-module/arquitetura-atlas-camada-omie.md).
 *
 * Fontes:
 *   - SALDO FISICO        ← OMIE (vw_posicaoEstoqueUnificadaFamilia), filtrado
 *                           por galpao quando passado, com regra anti-dupla
 *                           pra espelhados (.1 = importado: conta SO Q2P
 *                           a nao ser que o filtro empresa peca ACXE
 *                           explicitamente; .2 = nacional Q2P-only).
 *   - SALDO TRANSITO      ← Atlas (stockbridge.lote status='transito') por estagio.
 *                           Vem do FUP de Comex via migration 0024.
 *   - SALDO PROVISORIO    ← Atlas (lote status='provisorio') APENAS quando o OMIE
 *                           ainda NAO consolidou (movimentacao.status_omie != 'concluida').
 *                           Apos consolidacao, esse mesmo volume aparece em OMIE
 *                           e o lote vira so historico — nao soma.
 *   - DIVERGENCIAS/APRS   ← Atlas (workflow puro).
 *
 * Filtros:
 *   - familia: familia_atlas ou prefixo de descricao_familia OMIE
 *   - cnpj: 'acxe' | 'q2p' | 'ambos' (default ambos)
 *   - galpao: agrupador fisico — '11', '12', '21', '31'
 *   - criticidade: filtro pos-calculo (TS)
 */
export async function getCockpit(filtros: CockpitFiltros = {}): Promise<CockpitData> {
  const pool = getPool();

  const empresa: FiltroCnpj = filtros.cnpj ?? 'ambos';
  const galpao = filtros.galpao ?? null;
  const familia = filtros.familia ?? null;

  // Regra de empresa pra OMIE:
  //   acxe  → .1 ACXE (importado fiscal ACXE)
  //   q2p   → .1 Q2P (espelhado importado lado Q2P) + .2 Q2P (nacional)
  //   ambos → .1 Q2P + .2 Q2P (Q2P como representante fisico do espelhado pra evitar 2x)
  const condicaoEmpresaOmie =
    empresa === 'acxe'
      ? `(o.codigo_estoque LIKE '%.1' AND o.empresa = 'ACXE')`
      : `(
          (o.codigo_estoque LIKE '%.1' AND o.empresa = 'Q2P')
          OR
          (o.codigo_estoque LIKE '%.2' AND o.empresa = 'Q2P')
        )`;

  // Filtro de galpao no OMIE (quando presente, exige codigo_estoque LIKE 'galpao.%')
  const galpaoFilterOmie = galpao ? `AND o.codigo_estoque LIKE $1 || '.%'` : '';

  const sql = `
    WITH fisico_omie AS (
      -- vw retorna codigo_produto text (ex 'PP-016'); precisa traduzir pra
      -- codigo numerico ACXE via JOIN por descricao (mesmo padrao do consumo).
      -- Aceita risco de ~4-7% sem match (idem cross-empresa correlacao).
      SELECT
        pa.codigo_produto AS produto_codigo_acxe,
        SUM(COALESCE(o.saldo, 0)) AS fisica_kg
      FROM public."vw_posicaoEstoqueUnificadaFamilia" o
      INNER JOIN public."tbl_produtos_ACXE" pa ON pa.descricao = o.descricao_produto
      WHERE o.saldo > 0
        AND ${condicaoEmpresaOmie}
        ${galpaoFilterOmie}
      GROUP BY pa.codigo_produto
    ),
    transito_atlas AS (
      SELECT
        l.produto_codigo_acxe,
        SUM(l.quantidade_fisica_kg) FILTER (WHERE l.estagio_transito = 'transito_intl')    AS transito_intl_kg,
        SUM(l.quantidade_fisica_kg) FILTER (WHERE l.estagio_transito = 'porto_dta')        AS porto_dta_kg,
        SUM(l.quantidade_fisica_kg) FILTER (WHERE l.estagio_transito = 'transito_interno') AS transito_interno_kg
      FROM stockbridge.lote l
      WHERE l.ativo = true AND l.status = 'transito'
      GROUP BY l.produto_codigo_acxe
    ),
    provisorio_atlas AS (
      -- Anti-dupla: so conta provisorios cuja movimentacao OMIE ainda NAO foi concluida
      SELECT
        l.produto_codigo_acxe,
        SUM(l.quantidade_fisica_kg) AS provisorio_kg
      FROM stockbridge.lote l
      WHERE l.ativo = true
        AND l.status = 'provisorio'
        AND EXISTS (
          SELECT 1 FROM stockbridge.movimentacao m
          WHERE m.lote_id = l.id
            AND m.ativo = true
            AND m.status_omie <> 'concluida'
        )
      GROUP BY l.produto_codigo_acxe
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
    ),
    -- Universo: produtos que tem QUALQUER coisa (fisico OMIE OU transito OU provisorio)
    universo AS (
      SELECT produto_codigo_acxe FROM fisico_omie
      UNION
      SELECT produto_codigo_acxe FROM transito_atlas
      UNION
      SELECT produto_codigo_acxe FROM provisorio_atlas
    )
    SELECT
      u.produto_codigo_acxe,
      COALESCE(p.descricao, 'Produto ' || u.produto_codigo_acxe::text) AS nome,
      p.descricao_familia AS familia,
      f.familia_atlas     AS familia_atlas,
      p.ncm,
      COALESCE(fo.fisica_kg, 0)                AS fisica_kg,
      COALESCE(ta.transito_intl_kg, 0)         AS transito_intl_kg,
      COALESCE(ta.porto_dta_kg, 0)             AS porto_dta_kg,
      COALESCE(ta.transito_interno_kg, 0)      AS transito_interno_kg,
      COALESCE(pa.provisorio_kg, 0)            AS provisorio_kg,
      c.consumo_medio_diario_kg,
      c.lead_time_dias,
      COALESCE(d.c, 0) AS divs,
      COALESCE(a.c, 0) AS aprs
    FROM universo u
    LEFT JOIN fisico_omie fo       ON fo.produto_codigo_acxe = u.produto_codigo_acxe
    LEFT JOIN transito_atlas ta    ON ta.produto_codigo_acxe = u.produto_codigo_acxe
    LEFT JOIN provisorio_atlas pa  ON pa.produto_codigo_acxe = u.produto_codigo_acxe
    LEFT JOIN public."tbl_produtos_ACXE" p
      ON p.codigo_produto = u.produto_codigo_acxe
    LEFT JOIN stockbridge.familia_omie_atlas f
      ON f.familia_omie = p.descricao_familia
    LEFT JOIN stockbridge.config_produto c
      ON c.produto_codigo_acxe = u.produto_codigo_acxe
    LEFT JOIN divs d ON d.produto_codigo_acxe = u.produto_codigo_acxe
    LEFT JOIN apr  a ON a.produto_codigo_acxe = u.produto_codigo_acxe
    WHERE COALESCE(f.incluir_em_metricas, true) = true
      AND COALESCE(c.incluir_em_metricas, true) = true
      AND ($${galpao ? 2 : 1}::text IS NULL
           OR f.familia_atlas = $${galpao ? 2 : 1}
           OR p.descricao_familia ILIKE $${galpao ? 2 : 1} || '%')
    ORDER BY COALESCE(p.descricao, u.produto_codigo_acxe::text)
  `;

  const params = galpao ? [galpao, familia] : [familia];

  let rows: Record<string, unknown>[] = [];
  try {
    const result = await pool.query(sql, params);
    rows = result.rows as Record<string, unknown>[];
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'Cockpit query falhou — retornando vazio',
    );
    rows = [];
  }

  const skus: CockpitSku[] = rows.map((r) => {
    const fisicaKg = Number(r.fisica_kg);
    const consumoKg = r.consumo_medio_diario_kg != null ? Number(r.consumo_medio_diario_kg) : null;
    const leadTime = r.lead_time_dias != null ? Number(r.lead_time_dias) : null;
    const cobertura = calcularCobertura(fisicaKg, consumoKg);
    const criticidade = classificarCriticidade(cobertura, leadTime, fisicaKg, consumoKg);

    return {
      codigoAcxe: Number(r.produto_codigo_acxe),
      nome: String(r.nome),
      familia: (r.familia_atlas as string | null) ?? (r.familia as string | null) ?? null,
      ncm: (r.ncm as string | null) ?? null,
      fisicaKg,
      fiscalKg: fisicaKg, // arquitetura híbrida: fiscal = físico (OMIE consolida ambos)
      transitoIntlKg: Number(r.transito_intl_kg),
      portoDtaKg: Number(r.porto_dta_kg),
      transitoInternoKg: Number(r.transito_interno_kg),
      provisorioKg: Number(r.provisorio_kg),
      consumoMedioDiarioKg: consumoKg,
      leadTimeDias: leadTime,
      coberturaDias: cobertura,
      criticidade,
      divergencias: Number(r.divs),
      aprovacoesPendentes: Number(r.aprs),
    };
  });

  const skusFiltrados =
    filtros.criticidade && filtros.criticidade !== 'todas'
      ? skus.filter((s) => s.criticidade === filtros.criticidade)
      : skus;

  const resumo = getResumoFromSkus(skusFiltrados);
  return { resumo, skus: skusFiltrados };
}

export function getResumoFromSkus(skus: CockpitSku[]): CockpitResumo {
  let totalFisicoKg = 0;
  let totalFiscalKg = 0;
  let transitoIntlKg = 0;
  let portoDtaKg = 0;
  let transitoInternoKg = 0;
  let provisorioKg = 0;
  let divergenciasCount = 0;
  let aprovacoesPendentes = 0;
  let skusCriticos = 0;
  let skusAlerta = 0;

  for (const s of skus) {
    totalFisicoKg += s.fisicaKg;
    totalFiscalKg += s.fiscalKg;
    transitoIntlKg += s.transitoIntlKg;
    portoDtaKg += s.portoDtaKg;
    transitoInternoKg += s.transitoInternoKg;
    provisorioKg += s.provisorioKg;
    divergenciasCount += s.divergencias;
    aprovacoesPendentes += s.aprovacoesPendentes;
    if (s.criticidade === 'critico') skusCriticos += 1;
    if (s.criticidade === 'alerta') skusAlerta += 1;
  }

  return {
    totalFisicoKg,
    totalFiscalKg,
    transitoIntlKg,
    portoDtaKg,
    transitoInternoKg,
    provisorioKg,
    divergenciasCount,
    aprovacoesPendentes,
    skusCriticos,
    skusAlerta,
  };
}
