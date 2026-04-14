-- 0006_hedge_views_fix.sql
-- Corrige duas views do módulo hedge identificadas na validação (2026-04-14):
--
-- 1. vw_hedge_receber_usd — adiciona UNION ALL tbl_contasReceber_Q2P_Filial
--    Motivo: filial Q2P tinha recebíveis ausentes do cálculo de posição cambial
--
-- 2. vw_hedge_pagar_usd — substitui CTE categorias hardcoded por LEFT JOIN tbl_categorias_ACXE
--    Motivo: CTE tinha 25 linhas fixas; tabela OMIE tem 28 categorias relevantes.
--    Faltavam: 2.01.98, 2.01.99 e a descrição de 2.01.02 estava errada.
--    Com JOIN, a view fica auto-atualizada quando o OMIE criar novas categorias.
--
-- Impacto financeiro: nenhum (no dev, tbl_contasReceber_Q2P_Filial não tem títulos
-- pendentes; as categorias ausentes eram só labels, sem efeito nos valores USD).
-- Impacto em prod: adiciona recebíveis da filial ao total_receber_usd — aumenta o valor.
--
-- Dependências: tbl_contasReceber_Q2P_Filial e tbl_categorias_ACXE já existem no BD.
-- Seguro para re-executar (CREATE OR REPLACE VIEW).

-- ── 1. vw_hedge_receber_usd — inclui filial Q2P ───────────────────────────────

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


-- ── 2. vw_hedge_pagar_usd — categorias via JOIN (não hardcoded) ───────────────

CREATE OR REPLACE VIEW public.vw_hedge_pagar_usd AS

WITH ptax_atual AS (
  SELECT "cotacaoVenda" AS ptax
  FROM "tbl_cotacaoDolar"
  ORDER BY "dataCotacao" DESC
  LIMIT 1
),

parcelas_comex AS (
  SELECT cnumero, ncodfor, parcelas1_dvencto AS dvencto, parcelas1_nvalor AS nvalor, 1 AS nparcela
  FROM "tbl_pedidosComex" WHERE parcelas1_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas2_dvencto, parcelas2_nvalor, 2
  FROM "tbl_pedidosComex" WHERE parcelas2_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas3_dvencto, parcelas3_nvalor, 3
  FROM "tbl_pedidosComex" WHERE parcelas3_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas4_dvencto, parcelas4_nvalor, 4
  FROM "tbl_pedidosComex" WHERE parcelas4_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas5_dvencto, parcelas5_nvalor, 5
  FROM "tbl_pedidosComex" WHERE parcelas5_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas6_dvencto, parcelas6_nvalor, 6
  FROM "tbl_pedidosComex" WHERE parcelas6_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas7_dvencto, parcelas7_nvalor, 7
  FROM "tbl_pedidosComex" WHERE parcelas7_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas8_dvencto, parcelas8_nvalor, 8
  FROM "tbl_pedidosComex" WHERE parcelas8_nvalor IS NOT NULL
  UNION ALL
  SELECT cnumero, ncodfor, parcelas9_dvencto, parcelas9_nvalor, 9
  FROM "tbl_pedidosComex" WHERE parcelas9_nvalor IS NOT NULL
),

match_pedido AS (
  SELECT
    cp.codigo_lancamento_omie,
    pc.cnumero AS pedido_comex,
    ROW_NUMBER() OVER (PARTITION BY cp.codigo_lancamento_omie ORDER BY pc.nparcela) AS rn
  FROM "tbl_contasPagar_ACXE" cp
  JOIN parcelas_comex pc
    ON  pc.ncodfor  = cp.codigo_cliente_fornecedor
    AND pc.dvencto  = cp.data_vencimento
    AND pc.nvalor   = cp.valor_documento
)

SELECT
  cp.codigo_lancamento_omie::text                          AS omie_id,
  cp.data_vencimento,
  cp.valor_documento                                       AS valor_brl,
  ROUND(cp.valor_documento / pa.ptax, 2)                  AS valor_usd,
  pa.ptax                                                  AS ptax_ref,
  fc.razao_social                                          AS fornecedor,
  cp.status_titulo,
  cp.codigo_categoria,
  COALESCE(cat.descricao::text, cp.codigo_categoria::text) AS descricao_categoria,
  CASE
    WHEN cp.codigo_categoria LIKE '2.01.%' THEN 'mercadoria'
    WHEN cp.codigo_categoria LIKE '2.10.%' THEN 'despesa_importacao'
    ELSE NULL
  END                                                      AS tipo,
  TO_CHAR(cp.data_vencimento, 'Mon/YY')                   AS bucket_mes,
  mp.pedido_comex,
  cp.codigo_cliente_fornecedor

FROM "tbl_contasPagar_ACXE" cp
JOIN "tbl_cadastroFornecedoresClientes_ACXE" fc
  ON fc.codigo_cliente_omie = cp.codigo_cliente_fornecedor
CROSS JOIN ptax_atual pa
LEFT JOIN match_pedido mp
  ON mp.codigo_lancamento_omie = cp.codigo_lancamento_omie AND mp.rn = 1
LEFT JOIN public."tbl_categorias_ACXE" cat
  ON cat.codigo = cp.codigo_categoria

WHERE cp.status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE')
  AND fc.exterior = 'S'
  AND (cp.codigo_categoria LIKE '2.01.%' OR cp.codigo_categoria LIKE '2.10.%');
