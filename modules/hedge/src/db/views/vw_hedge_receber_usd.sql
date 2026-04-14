-- =============================================================================
-- View: public.vw_hedge_receber_usd
-- Descrição: Contas a receber em aberto da Q2P (matriz + filial), convertidas
--            para USD pela PTAX atual. Janela de 90 dias para trás (horizonte
--            máximo de decisão de hedge). Inclui apenas títulos ativos
--            (A VENCER, ATRASADO, VENCE HOJE).
--
-- Dependências de tabela:
--   tbl_contasReceber_Q2P
--   tbl_contasReceber_Q2P_Filial
--   tbl_cotacaoDolar
--
-- Tabelas existentes NÃO usadas (intencionalmente):
--   tbl_contasReceber_ACXE  — recebíveis ACXE são intercompany (Q2P deve à ACXE);
--                              incluir geraria dupla contagem
--
-- Usado em: vw_hedge_resumo (campo total_receber_usd)
-- Validado em: 2026-04-14  |  Doc: docs/validacao/04-vw_hedge_receber_usd.md
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_hedge_receber_usd AS

WITH ptax_atual AS (
  SELECT "cotacaoVenda" AS ptax
  FROM "tbl_cotacaoDolar"
  ORDER BY "dataCotacao" DESC
  LIMIT 1
)

-- Q2P Matriz
SELECT
  cr.codigo_lancamento_omie::text            AS omie_id,
  cr.data_vencimento,
  cr.valor_documento                         AS valor_brl,
  ROUND(cr.valor_documento / pa.ptax, 2)    AS valor_usd,
  cr.status_titulo,
  pa.ptax                                    AS ptax_ref,
  TO_CHAR(cr.data_vencimento, 'Mon/YY')     AS bucket_mes

FROM "tbl_contasReceber_Q2P" cr
CROSS JOIN ptax_atual pa

WHERE cr.status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE')
  AND cr.data_vencimento >= CURRENT_DATE - INTERVAL '90 days'

UNION ALL

-- Q2P Filial
SELECT
  cr.codigo_lancamento_omie::text            AS omie_id,
  cr.data_vencimento,
  cr.valor_documento                         AS valor_brl,
  ROUND(cr.valor_documento / pa.ptax, 2)    AS valor_usd,
  cr.status_titulo,
  pa.ptax                                    AS ptax_ref,
  TO_CHAR(cr.data_vencimento, 'Mon/YY')     AS bucket_mes

FROM "tbl_contasReceber_Q2P_Filial" cr
CROSS JOIN ptax_atual pa

WHERE cr.status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE')
  AND cr.data_vencimento >= CURRENT_DATE - INTERVAL '90 days';
