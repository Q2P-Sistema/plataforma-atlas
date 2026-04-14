-- =============================================================================
-- View: public.vw_hedge_importacoes
-- Descrição: Pipeline de importações em andamento da ACXE, a partir da
--            planilha FUP Comex (tbl_dadosPlanilhaFUPComex).
--            Exclui processos já recebidos no galpão (recebido_na_acxe='true').
--            Deriva status_hedge por prioridade de datas: data_desembaraco
--            → eta → etd → aguardando_embarque.
--            Usa taxa_dolar da planilha (câmbio contratado), NÃO a PTAX.
--
-- Dependências de tabela:
--   tbl_dadosPlanilhaFUPComex   (planilha FUP manual — não é sync OMIE)
--
-- Usado em: vw_hedge_resumo (importacoes_pendentes_usd, importacoes_pendentes_qtd)
--           resumo filtra: status_hedge <> 'nacionalizado'
-- Validado em: 2026-04-14  |  Doc: docs/validacao/05-vw_hedge_importacoes.md
--
-- GAP CONHECIDO: processos com etapa='00 - CANCELADO' sem datas preenchidas
--   caem no ELSE como 'aguardando_embarque' e entram nos pendentes do resumo.
--   Correção sugerida: adicionar ao WHERE:
--     AND (etapa_global <> '00 - CANCELADO' OR etapa_global IS NULL)
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_hedge_importacoes AS

SELECT
  id,
  pedido_acxe_omie,
  etapa,
  etapa_global,
  numero_bl,
  numero_di,
  eta,
  etd,
  taxa_dolar,
  valor_total_usd,
  valor_total_reais,
  fornecedor,
  data_desembaraco,
  despachante,
  recebido_na_acxe,
  CASE
    WHEN data_desembaraco IS NOT NULL            THEN 'nacionalizado'
    WHEN eta IS NOT NULL AND eta <= CURRENT_DATE THEN 'em_porto'
    WHEN etd IS NOT NULL                         THEN 'em_transito'
    ELSE                                              'aguardando_embarque'
  END AS status_hedge

FROM "tbl_dadosPlanilhaFUPComex" fup

WHERE recebido_na_acxe <> 'true' OR recebido_na_acxe IS NULL;
