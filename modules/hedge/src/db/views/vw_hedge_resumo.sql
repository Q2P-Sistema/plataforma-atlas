-- =============================================================================
-- View: public.vw_hedge_resumo
-- Descrição: View mestre do módulo hedge. Agrega as 4 sub-views em 1 linha
--            única com todos os componentes de posição cambial e a fórmula
--            de exposição USD total.
--
-- Dependências de view (aplicar DEPOIS das sub-views):
--   vw_hedge_pagar_usd
--   vw_hedge_estoque
--   vw_hedge_receber_usd
--   vw_hedge_importacoes
--
-- Dependências de tabela:
--   tbl_cotacaoDolar   (PTAX direto — as sub-views já têm a própria CTE ptax_atual,
--                       mas esta view busca a PTAX independentemente para expor no resultado)
--
-- Usado em: posicao.service.ts → GET /api/v1/hedge/posicao → frontend KPI cards
-- Validado em: 2026-04-14  |  Doc: docs/validacao/06-vw_hedge_resumo.md
--
-- FÓRMULA CENTRAL:
--   exposicao_usd_total = total_pagar_usd
--                       + est_importado_usd × LEAST(total_pagar_brl / est_importado_brl, 1.0)
--
--   onde o fator LEAST(..., 1.0) representa a fração do estoque importado
--   ainda não paga, capped em 100% para evitar sobre-contagem.
--
-- CAMPOS INFORMACIONAIS (não entram na fórmula de exposição):
--   total_receber_usd      — processado no motor MV (posicao.service.ts)
--   importacoes_pendentes  — visibilidade do pipeline FUP; sem título OMIE ainda
--   est_transito_usd       — já incluso em total_pagar_usd (título existe antes da entrega)
--   est_nacional_usd       — sem exposição cambial
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_hedge_resumo AS

WITH ptax_atual AS (
  SELECT "cotacaoVenda" AS ptax
  FROM "tbl_cotacaoDolar"
  ORDER BY "dataCotacao" DESC
  LIMIT 1
),

pagar AS (
  SELECT
    SUM(valor_usd)                                                        AS total_pagar_usd,
    SUM(valor_brl)                                                        AS total_pagar_brl,
    SUM(CASE WHEN tipo = 'mercadoria'         THEN valor_usd ELSE 0 END) AS pagar_mercadoria_usd,
    SUM(CASE WHEN tipo = 'despesa_importacao' THEN valor_usd ELSE 0 END) AS pagar_despesa_usd,
    COUNT(*)                                                              AS pagar_qtd
  FROM vw_hedge_pagar_usd
),

estoque AS (
  SELECT
    SUM(valor_total_brl)                                                                  AS total_est_brl,
    SUM(valor_total_usd)                                                                  AS total_est_usd,
    SUM(CASE WHEN origem = 'importado_no_chao' THEN valor_total_brl ELSE 0 END)          AS est_importado_brl,
    SUM(CASE WHEN origem = 'importado_no_chao' THEN valor_total_usd ELSE 0 END)          AS est_importado_usd,
    SUM(CASE WHEN origem = 'em_transito'        THEN valor_total_brl ELSE 0 END)         AS est_transito_brl,
    SUM(CASE WHEN origem = 'em_transito'        THEN valor_total_usd ELSE 0 END)         AS est_transito_usd,
    SUM(CASE WHEN origem = 'nacional'           THEN valor_total_brl ELSE 0 END)         AS est_nacional_brl,
    SUM(CASE WHEN origem = 'nacional'           THEN valor_total_usd ELSE 0 END)         AS est_nacional_usd
  FROM vw_hedge_estoque
),

receber AS (
  SELECT
    SUM(valor_usd) AS total_receber_usd,
    SUM(valor_brl) AS total_receber_brl
  FROM vw_hedge_receber_usd
),

importacoes AS (
  SELECT
    SUM(valor_total_usd) FILTER (WHERE status_hedge <> 'nacionalizado') AS pendente_usd,
    COUNT(*)             FILTER (WHERE status_hedge <> 'nacionalizado') AS pendente_qtd
  FROM vw_hedge_importacoes
)

SELECT
  pa.ptax,

  -- Contas a pagar
  p.total_pagar_usd,
  p.total_pagar_brl,
  p.pagar_mercadoria_usd,
  p.pagar_despesa_usd,
  p.pagar_qtd,

  -- Estoque (todos os tipos)
  e.total_est_brl,
  e.total_est_usd,
  e.est_importado_brl,
  e.est_importado_usd,
  e.est_transito_brl,
  e.est_transito_usd,
  e.est_nacional_brl,
  e.est_nacional_usd,

  -- % do estoque importado ainda não pago (cap 100%)
  LEAST(
    ROUND(COALESCE(p.total_pagar_brl / NULLIF(e.est_importado_brl, 0) * 100, 0)),
    100
  ) AS pct_nao_pago,

  -- Valor USD do estoque importado sem pagamento correspondente
  ROUND(
    e.est_importado_usd * LEAST(COALESCE(p.total_pagar_brl / NULLIF(e.est_importado_brl, 0), 0), 1),
    2
  ) AS est_nao_pago_usd,

  -- Contas a receber (informacional — não entra na exposição)
  r.total_receber_usd,
  r.total_receber_brl,

  -- Pipeline FUP (informacional — não entra na exposição)
  i.pendente_usd AS importacoes_pendentes_usd,
  i.pendente_qtd AS importacoes_pendentes_qtd,

  -- EXPOSIÇÃO USD TOTAL = pagar + estoque_nao_pago
  ROUND(
    p.total_pagar_usd + e.est_importado_usd * LEAST(COALESCE(p.total_pagar_brl / NULLIF(e.est_importado_brl, 0), 0), 1),
    2
  ) AS exposicao_usd_total,

  CURRENT_TIMESTAMP AS calculado_em

FROM ptax_atual pa, pagar p, estoque e, receber r, importacoes i;
