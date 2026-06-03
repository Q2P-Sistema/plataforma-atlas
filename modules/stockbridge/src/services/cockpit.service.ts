import { getPool, createLogger, getConfig } from '@atlas/core';
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
  fisicaKg: number;                    // saldo OMIE (fonte de verdade)
  fiscalKg: number;                    // fisicaKg + pendentes (representa total fiscal)
  fiscalPendenteNacionalKg: number;    // NFs nacionais entrada com n_id_receb=0 (pos cutoff)
  fiscalPendenteImportacaoKg: number;  // NFs ACXE 3.xxx sem movimentacao subtipo=importacao
  transitoIntlKg: number;              // Atlas: lote status='transito' estagio='transito_intl'
  portoDtaKg: number;                  // idem 'porto_dta'
  transitoInternoKg: number;           // idem 'transito_interno'
  provisorioKg: number;                // Atlas: lote provisorio AINDA NAO consolidado pelo OMIE
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
  totalFiscalPendenteNacionalKg: number;
  totalFiscalPendenteImportacaoKg: number;
  transitoIntlKg: number;
  portoDtaKg: number;
  transitoInternoKg: number;
  provisorioKg: number;
  divergenciasCount: number;
  aprovacoesPendentes: number;
  skusCriticos: number;
  skusAlerta: number;
  skusExcesso: number;
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
 *                           pra espelhados.
 *   - SALDO TRANSITO      ← Atlas (stockbridge.lote status='transito') por estagio.
 *   - SALDO PROVISORIO    ← Atlas (lote status='provisorio') APENAS quando OMIE
 *                           ainda NAO consolidou.
 *   - FISCAL PENDENTE     ← public.tbl_nf_header_* + tbl_nf_itens_*:
 *                           - Nacional (CFOPs 1.xxx/2.xxx): NF de entrada
 *                             com n_id_receb=0 (OMIE indica nao recebida fisica)
 *                           - Importacao (CFOPs 3.xxx, so ACXE): NF de entrada
 *                             cuja n_nf NAO esta em stockbridge.movimentacao
 *                             com subtipo='importacao'.
 *                           Cutoff temporal via STOCKBRIDGE_FISCAL_CUTOFF_DATE
 *                           (default 180 dias atras) para ignorar NFs antigas
 *                           que foram tratadas pelo legado pre-Atlas.
 *   - DIVERGENCIAS/APRS   ← Atlas (workflow puro).
 */
export async function getCockpit(filtros: CockpitFiltros = {}): Promise<CockpitData> {
  const pool = getPool();
  const config = getConfig();

  const empresa: FiltroCnpj = filtros.cnpj ?? 'ambos';
  const galpao = filtros.galpao ?? null;
  const familia = filtros.familia ?? null;
  const incluirAcxe = empresa === 'acxe' || empresa === 'ambos';
  const incluirQ2p = empresa === 'q2p' || empresa === 'ambos';

  // Cutoff fiscal: ignora NFs anteriores a essa data.
  // Sem env: 180 dias atras.
  const cutoffDate =
    config.STOCKBRIDGE_FISCAL_CUTOFF_DATE ??
    (() => {
      const d = new Date();
      d.setDate(d.getDate() - 180);
      return d.toISOString().slice(0, 10);
    })();

  // Regra de empresa pra OMIE:
  //   acxe  → .1 ACXE
  //   q2p / ambos → .1 Q2P + .2 Q2P (Q2P como representante do espelhado)
  const condicaoEmpresaOmie =
    empresa === 'acxe'
      ? `(o.codigo_estoque LIKE '%.1' AND o.empresa = 'ACXE')`
      : `(
          (o.codigo_estoque LIKE '%.1' AND o.empresa = 'Q2P')
          OR
          (o.codigo_estoque LIKE '%.2' AND o.empresa = 'Q2P')
        )`;

  // Parametros (sempre na mesma ordem):
  //   $1 = familia (text|null)
  //   $2 = galpao (text|null)
  //   $3 = cutoff_date (date)
  //   $4 = incluir_acxe (bool)
  //   $5 = incluir_q2p (bool)
  const galpaoFilterOmie = `AND ($2::text IS NULL OR o.codigo_estoque LIKE $2 || '.%')`;

  const sql = `
    WITH fisico_omie AS (
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
    fiscal_pend_nacional AS (
      -- NFs de entrada nacional (CFOPs 1.xxx/2.xxx) sem recebimento OMIE,
      -- consolidadas por produto_codigo_acxe (3 empresas).
      SELECT produto_codigo_acxe, SUM(kg)::numeric AS pendente_nacional_kg
      FROM (
        -- ACXE nacional (link direto)
        SELECT i.n_cod_prod AS produto_codigo_acxe, i.q_com AS kg
        FROM public."tbl_nf_header_ACXE" h
        JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
        WHERE $4::bool = true
          AND h.tp_nf = 0
          AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
          AND LEFT(i.cfop, 1) IN ('1','2')
          AND h.d_emi >= $3::date

        UNION ALL

        -- Q2P nacional (correlaciona via descricao com ACXE)
        SELECT pa.codigo_produto AS produto_codigo_acxe, i.q_com AS kg
        FROM public."tbl_nf_header_Q2P" h
        JOIN public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf
        JOIN public."tbl_produtos_Q2P" pq ON pq.codigo_produto = i.n_cod_prod
        JOIN public."tbl_produtos_ACXE" pa ON pa.descricao = pq.descricao
        WHERE $5::bool = true
          AND h.tp_nf = 0
          AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
          AND LEFT(i.cfop, 1) IN ('1','2')
          AND h.d_emi >= $3::date

        UNION ALL

        -- Q2P_Filial nacional
        SELECT pa.codigo_produto AS produto_codigo_acxe, i.q_com AS kg
        FROM public."tbl_nf_header_Q2P_Filial" h
        JOIN public."tbl_nf_itens_Q2P_Filial" i ON i.n_id_nf = h.n_id_nf
        JOIN public."tbl_produtos_Q2P_Filial" pf ON pf.codigo_produto = i.n_cod_prod
        JOIN public."tbl_produtos_ACXE" pa ON pa.descricao = pf.descricao
        WHERE $5::bool = true
          AND h.tp_nf = 0
          AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
          AND LEFT(i.cfop, 1) IN ('1','2')
          AND h.d_emi >= $3::date
      ) src
      GROUP BY produto_codigo_acxe
    ),
    fiscal_pend_importacao AS (
      -- Importacao ACXE (CFOP 3.xxx): NFs cujo n_nf NAO esta em movimentacao
      -- Atlas com subtipo='importacao'. So existe se incluirAcxe.
      SELECT i.n_cod_prod AS produto_codigo_acxe, SUM(i.q_com)::numeric AS pendente_importacao_kg
      FROM public."tbl_nf_header_ACXE" h
      JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
      WHERE $4::bool = true
        AND h.tp_nf = 0
        AND LEFT(i.cfop, 1) = '3'
        AND h.d_emi >= $3::date
        AND NOT EXISTS (
          SELECT 1 FROM stockbridge.movimentacao m
          WHERE m.ativo = true
            AND m.subtipo = 'importacao'
            AND m.nota_fiscal = h.n_nf
        )
      GROUP BY i.n_cod_prod
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
    universo AS (
      SELECT produto_codigo_acxe FROM fisico_omie
      UNION
      SELECT produto_codigo_acxe FROM transito_atlas
      UNION
      SELECT produto_codigo_acxe FROM provisorio_atlas
      UNION
      SELECT produto_codigo_acxe FROM fiscal_pend_nacional
      UNION
      SELECT produto_codigo_acxe FROM fiscal_pend_importacao
    )
    SELECT
      u.produto_codigo_acxe,
      COALESCE(p.descricao, 'Produto ' || u.produto_codigo_acxe::text) AS nome,
      p.descricao_familia AS familia,
      p.ncm,
      COALESCE(fo.fisica_kg, 0)                AS fisica_kg,
      COALESCE(ta.transito_intl_kg, 0)         AS transito_intl_kg,
      COALESCE(ta.porto_dta_kg, 0)             AS porto_dta_kg,
      COALESCE(ta.transito_interno_kg, 0)      AS transito_interno_kg,
      COALESCE(pv.provisorio_kg, 0)            AS provisorio_kg,
      COALESCE(fpn.pendente_nacional_kg, 0)    AS pendente_nacional_kg,
      COALESCE(fpi.pendente_importacao_kg, 0)  AS pendente_importacao_kg,
      c.consumo_medio_diario_kg,
      c.lead_time_dias,
      COALESCE(d.c, 0) AS divs,
      COALESCE(a.c, 0) AS aprs
    FROM universo u
    LEFT JOIN fisico_omie fo             ON fo.produto_codigo_acxe  = u.produto_codigo_acxe
    LEFT JOIN transito_atlas ta          ON ta.produto_codigo_acxe  = u.produto_codigo_acxe
    LEFT JOIN provisorio_atlas pv        ON pv.produto_codigo_acxe  = u.produto_codigo_acxe
    LEFT JOIN fiscal_pend_nacional fpn   ON fpn.produto_codigo_acxe = u.produto_codigo_acxe
    LEFT JOIN fiscal_pend_importacao fpi ON fpi.produto_codigo_acxe = u.produto_codigo_acxe
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
      AND ($1::text IS NULL OR p.descricao_familia = $1)
    ORDER BY COALESCE(p.descricao, u.produto_codigo_acxe::text)
  `;

  const params: unknown[] = [familia, galpao, cutoffDate, incluirAcxe, incluirQ2p];

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
    const pendenteNacional = Number(r.pendente_nacional_kg);
    const pendenteImportacao = Number(r.pendente_importacao_kg);
    const consumoKg = r.consumo_medio_diario_kg != null ? Number(r.consumo_medio_diario_kg) : null;
    const leadTime = r.lead_time_dias != null ? Number(r.lead_time_dias) : null;
    const cobertura = calcularCobertura(fisicaKg, consumoKg);
    const criticidade = classificarCriticidade(cobertura, leadTime, fisicaKg, consumoKg);

    return {
      codigoAcxe: Number(r.produto_codigo_acxe),
      nome: String(r.nome),
      familia: (r.familia as string | null) ?? null,
      ncm: (r.ncm as string | null) ?? null,
      fisicaKg,
      fiscalKg: fisicaKg + pendenteNacional + pendenteImportacao,
      fiscalPendenteNacionalKg: pendenteNacional,
      fiscalPendenteImportacaoKg: pendenteImportacao,
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
  let totalFiscalPendenteNacionalKg = 0;
  let totalFiscalPendenteImportacaoKg = 0;
  let transitoIntlKg = 0;
  let portoDtaKg = 0;
  let transitoInternoKg = 0;
  let provisorioKg = 0;
  let divergenciasCount = 0;
  let aprovacoesPendentes = 0;
  let skusCriticos = 0;
  let skusAlerta = 0;
  let skusExcesso = 0;

  for (const s of skus) {
    totalFisicoKg += s.fisicaKg;
    totalFiscalKg += s.fiscalKg;
    totalFiscalPendenteNacionalKg += s.fiscalPendenteNacionalKg;
    totalFiscalPendenteImportacaoKg += s.fiscalPendenteImportacaoKg;
    transitoIntlKg += s.transitoIntlKg;
    portoDtaKg += s.portoDtaKg;
    transitoInternoKg += s.transitoInternoKg;
    provisorioKg += s.provisorioKg;
    divergenciasCount += s.divergencias;
    aprovacoesPendentes += s.aprovacoesPendentes;
    if (s.criticidade === 'critico') skusCriticos += 1;
    if (s.criticidade === 'alerta') skusAlerta += 1;
    if (s.criticidade === 'excesso') skusExcesso += 1;
  }

  return {
    totalFisicoKg,
    totalFiscalKg,
    totalFiscalPendenteNacionalKg,
    totalFiscalPendenteImportacaoKg,
    transitoIntlKg,
    portoDtaKg,
    transitoInternoKg,
    provisorioKg,
    divergenciasCount,
    aprovacoesPendentes,
    skusCriticos,
    skusAlerta,
    skusExcesso,
  };
}
