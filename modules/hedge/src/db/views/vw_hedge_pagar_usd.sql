-- =============================================================================
-- View: public.vw_hedge_pagar_usd
-- Descrição: Contas a pagar em USD da ACXE para fornecedores do exterior.
--            Filtra títulos em aberto (A VENCER / ATRASADO / VENCE HOJE),
--            apenas fornecedores com exterior='S' e categorias de importação
--            (2.01.* mercadoria, 2.10.* despesa de importação).
--            Converte BRL → USD pela PTAX mais recente (tbl_cotacaoDolar).
--            Descrição de categoria via JOIN em tbl_categorias_ACXE (sync OMIE).
--
-- Dependências de tabela:
--   tbl_contasPagar_ACXE
--   tbl_cadastroFornecedoresClientes_ACXE
--   tbl_pedidosComex
--   tbl_cotacaoDolar
--   tbl_categorias_ACXE
--
-- Usado em: vw_hedge_resumo (campos total_pagar_usd, total_pagar_brl)
-- Validado em: 2026-04-13  |  Doc: docs/validacao/02-vw_hedge_pagar_usd.md
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_hedge_pagar_usd AS

WITH ptax_atual AS (
  SELECT "cotacaoVenda" AS ptax
  FROM "tbl_cotacaoDolar"
  ORDER BY "dataCotacao" DESC
  LIMIT 1
),

-- Desdobra até 9 parcelas de cada pedido Comex para matching com títulos
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

-- Match título → pedido Comex por (fornecedor + data_vencimento + valor exato)
-- row_number garante 1 match por título quando há múltiplas parcelas compatíveis
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
