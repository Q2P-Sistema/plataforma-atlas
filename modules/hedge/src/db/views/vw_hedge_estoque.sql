-- =============================================================================
-- View: public.vw_hedge_estoque
-- Descrição: Posição de estoque físico de ACXE e Q2P, classificada por origem.
--            Locais são filtrados por whitelist hardcoded (CTEs acxe_locais e
--            q2p_locais) e classificados como importado_no_chao, em_transito
--            ou nacional.
--            Converte BRL → USD pelo custo médio (ncmc) / PTAX atual.
--
-- Dependências de tabela:
--   tbl_posicaoEstoque_ACXE
--   tbl_posicaoEstoque_Q2P
--   tbl_locaisEstoques_ACXE
--   tbl_locaisEstoques_Q2P
--   tbl_cotacaoDolar
--
-- Usado em: vw_hedge_resumo (est_importado_usd, est_importado_brl)
--           estoque.service.ts (tabela do dashboard, com filtro localidades_ativas)
-- Validado em: 2026-04-14  |  Doc: docs/validacao/03-vw_hedge_estoque.md
--
-- LOCAIS ACXE incluídos:
--   4498926061  SANTO ANDRÉ (IMPORTADO)   importado_no_chao
--   4498926337  SANTO ANDRÉ (IMPORTADO)   importado_no_chao  (posição física separada)
--   4776458297  ARMAZÉM EXTERNO           importado_no_chao
--   4004166399  EXTREMA                   importado_no_chao
--   4503767789  TRÂNSITO                  em_transito
--
-- LOCAIS Q2P incluídos:
--   8123584710  SANTO ANDRÉ (NACIONAL)    nacional
--   8123584481  SANTO ANDRÉ (NACIONAL)    nacional
--
-- LOCAIS Q2P excluídos intencionalmente (réplicas espelhadas do integrador OMIE):
--   8115873724, 8115873874  IMPORTADO — espelho de 4498926061/4498926337
--   8042180936              ARMAZÉM EXTERNO — espelho de 4776458297
--   7960459966              EXTREMA — espelho de 4004166399
--   8429029971              TRÂNSITO — espelho de 4503767789
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_hedge_estoque AS

WITH ptax_atual AS (
  SELECT "cotacaoVenda" AS ptax
  FROM "tbl_cotacaoDolar"
  ORDER BY "dataCotacao" DESC
  LIMIT 1
),

-- Whitelist de locais ACXE com classificação de origem
acxe_locais (codigo, origem) AS (
  VALUES
    ('4498926061', 'importado_no_chao'),
    ('4498926337', 'importado_no_chao'),
    ('4776458297', 'importado_no_chao'),
    ('4004166399', 'importado_no_chao'),
    ('4503767789', 'em_transito')
),

-- Whitelist de locais Q2P com classificação de origem
-- Locais Q2P "IMPORTADO" são réplicas espelhadas da ACXE — excluídos para evitar dupla contagem
q2p_locais (codigo, origem) AS (
  VALUES
    ('8123584710', 'nacional'),
    ('8123584481', 'nacional')
)

-- Estoque ACXE
SELECT
  'acxe'::text                               AS empresa,
  pe.ncodprod,
  pe.ccodigo                                 AS codigo_produto,
  pe.cdescricao                              AS descricao,
  pe.nsaldo                                  AS quantidade,
  pe.ncmc                                    AS custo_medio_brl,
  pe.nprecounitario                          AS preco_unitario,
  pe.codigo_local_estoque,
  le.descricao                               AS local_descricao,
  al.origem,
  pe.ddataposicao                            AS data_posicao,
  pe.ncmc * pe.nsaldo::numeric               AS valor_total_brl,
  ROUND(pe.ncmc * pe.nsaldo::numeric / pa.ptax, 2) AS valor_total_usd,
  pa.ptax                                    AS ptax_ref

FROM "tbl_posicaoEstoque_ACXE" pe
JOIN "tbl_locaisEstoques_ACXE" le ON le.codigo_local_estoque = pe.codigo_local_estoque
JOIN acxe_locais al              ON al.codigo = pe.codigo_local_estoque::text
CROSS JOIN ptax_atual pa
WHERE pe.nsaldo > 0

UNION ALL

-- Estoque Q2P (apenas locais nacionais; importados são réplicas da ACXE)
SELECT
  'q2p'::text                                AS empresa,
  pe.ncodprod,
  pe.ccodigo                                 AS codigo_produto,
  pe.cdescricao                              AS descricao,
  pe.nsaldo                                  AS quantidade,
  pe.ncmc                                    AS custo_medio_brl,
  pe.nprecounitario                          AS preco_unitario,
  pe.codigo_local_estoque,
  lq.descricao                               AS local_descricao,
  ql.origem,
  pe.ddataposicao                            AS data_posicao,
  pe.ncmc * pe.nsaldo::numeric               AS valor_total_brl,
  ROUND(pe.ncmc * pe.nsaldo::numeric / pa.ptax, 2) AS valor_total_usd,
  pa.ptax                                    AS ptax_ref

FROM "tbl_posicaoEstoque_Q2P" pe
JOIN "tbl_locaisEstoques_Q2P" lq ON lq.codigo_local_estoque = pe.codigo_local_estoque
JOIN q2p_locais ql               ON ql.codigo = pe.codigo_local_estoque::text
CROSS JOIN ptax_atual pa
WHERE pe.nsaldo > 0;
