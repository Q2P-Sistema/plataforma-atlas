-- ============================================================================
-- VALIDAÇÃO: Posição Fiscal no Cockpit StockBridge
-- ============================================================================
-- Objetivo: Quebrar linha por linha cada componente de posição fiscal
--           para validar o cálculo contra o código em cockpit.service.ts
--
-- Componentes:
--   1. Saldo Físico (OMIE) — tbl_posicaoEstoque_* / galpões 11.1...31.1
--   2. Pendência Nacional — tbl_nf_header_* / CFOP 1.xxx,2.xxx / n_id_receb=0 / últimos 180 dias
--   3. Pendência Importação — tbl_nf_header_ACXE / CFOP 3.xxx / NÃO em stockbridge.movimentacao
--
-- Execução:
--   psql "postgresql://user:pass@host:5432/acxe_q2p" -f validacao-posicao-fiscal.sql
--
-- Data de execução: 2026-06-09
-- ============================================================================

\echo '================================================================'
\echo '1. SALDO FÍSICO (OMIE) — whitelist galpões 11.1/11.2/12.1/12.2/21.1/21.2/31.1'
\echo '================================================================'

WITH posicao_unificada AS (
  SELECT
    'ACXE'::text AS empresa,
    e.codigo AS codigo_estoque,
    p.cdescricao AS descricao_produto,
    p.nsaldo AS saldo,
    p.ddataposicao
  FROM public."tbl_posicaoEstoque_ACXE" p
  INNER JOIN public."tbl_locaisEstoques_ACXE" e
    ON p.codigo_local_estoque = e.codigo_local_estoque
  WHERE p.fisico >= 0
  UNION ALL
  SELECT
    'Q2P'::text,
    e.codigo,
    p.cdescricao,
    p.nsaldo,
    p.ddataposicao
  FROM public."tbl_posicaoEstoque_Q2P" p
  INNER JOIN public."tbl_locaisEstoques_Q2P" e
    ON p.codigo_local_estoque = e.codigo_local_estoque
  WHERE p.fisico >= 0
),
fisico_por_empresa AS (
  SELECT
    empresa,
    MAX(ddataposicao) AS data_mais_recente
  FROM posicao_unificada
  GROUP BY empresa
),
posicao_bruta AS (
  SELECT
    pu.empresa,
    pu.codigo_estoque,
    pu.ddataposicao,
    pa.codigo_produto AS produto_codigo_acxe,
    pu.saldo
  FROM posicao_unificada pu
  INNER JOIN fisico_por_empresa fpe ON fpe.empresa = pu.empresa AND fpe.data_mais_recente = pu.ddataposicao
  INNER JOIN public."tbl_produtos_ACXE" pa ON pa.descricao = pu.descricao_produto
  WHERE pu.saldo > 0
    AND pu.codigo_estoque = ANY('{11.1,11.2,12.1,12.2,21.1,21.2,31.1}'::text[])
),
posicao_consolidada AS (
  SELECT
    produto_codigo_acxe,
    codigo_estoque,
    COALESCE(
      MAX(saldo) FILTER (WHERE empresa = 'Q2P'),
      MAX(saldo) FILTER (WHERE empresa = 'ACXE')
    ) AS saldo_local
  FROM posicao_bruta
  GROUP BY produto_codigo_acxe, codigo_estoque
)
SELECT
  'TOTAL SALDO FÍSICO' AS categoria,
  SUM(saldo_local)::numeric(15,2) AS kg_total,
  COUNT(DISTINCT produto_codigo_acxe) AS produtos_com_saldo
FROM posicao_consolidada;

-- Breakdown por galpão
\echo ''
\echo 'Breakdown por galpão:'
\echo ''

WITH posicao_unificada AS (
  SELECT
    'ACXE'::text AS empresa,
    e.codigo AS codigo_estoque,
    p.cdescricao AS descricao_produto,
    p.nsaldo AS saldo,
    p.ddataposicao
  FROM public."tbl_posicaoEstoque_ACXE" p
  INNER JOIN public."tbl_locaisEstoques_ACXE" e
    ON p.codigo_local_estoque = e.codigo_local_estoque
  WHERE p.fisico >= 0
  UNION ALL
  SELECT
    'Q2P'::text,
    e.codigo,
    p.cdescricao,
    p.nsaldo,
    p.ddataposicao
  FROM public."tbl_posicaoEstoque_Q2P" p
  INNER JOIN public."tbl_locaisEstoques_Q2P" e
    ON p.codigo_local_estoque = e.codigo_local_estoque
  WHERE p.fisico >= 0
),
fisico_por_empresa AS (
  SELECT
    empresa,
    MAX(ddataposicao) AS data_mais_recente
  FROM posicao_unificada
  GROUP BY empresa
),
posicao_bruta AS (
  SELECT
    pu.empresa,
    pu.codigo_estoque,
    pu.ddataposicao,
    pa.codigo_produto AS produto_codigo_acxe,
    pu.saldo
  FROM posicao_unificada pu
  INNER JOIN fisico_por_empresa fpe ON fpe.empresa = pu.empresa AND fpe.data_mais_recente = pu.ddataposicao
  INNER JOIN public."tbl_produtos_ACXE" pa ON pa.descricao = pu.descricao_produto
  WHERE pu.saldo > 0
    AND pu.codigo_estoque = ANY('{11.1,11.2,12.1,12.2,21.1,21.2,31.1}'::text[])
),
posicao_consolidada AS (
  SELECT
    codigo_estoque,
    SUM(COALESCE(
      MAX(saldo) FILTER (WHERE empresa = 'Q2P'),
      MAX(saldo) FILTER (WHERE empresa = 'ACXE')
    ) OVER (PARTITION BY produto_codigo_acxe, codigo_estoque)
    ) AS saldo_local
  FROM posicao_bruta
  GROUP BY codigo_estoque, produto_codigo_acxe
)
SELECT
  codigo_estoque,
  SUM(saldo_local)::numeric(15,2) AS kg_por_galpao
FROM posicao_consolidada
GROUP BY codigo_estoque
ORDER BY codigo_estoque;

-- ============================================================================
\echo ''
\echo '================================================================'
\echo '2. PENDÊNCIA NACIONAL (CFOPs 1.xxx/2.xxx, n_id_receb=0, últimos 180 dias)'
\echo '================================================================'

WITH fiscal_pend_nacional AS (
  SELECT SUM(kg)::numeric(15,2) AS total_kg, COUNT(*) AS qtd_linhas
  FROM (
    -- ACXE nacional
    SELECT i.q_com AS kg
    FROM public."tbl_nf_header_ACXE" h
    JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
    WHERE h.tp_nf = 0
      AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
      AND LEFT(i.cfop, 1) IN ('1','2')
      AND h.d_emi >= CURRENT_DATE - 180
    UNION ALL
    -- Q2P nacional
    SELECT i.q_com AS kg
    FROM public."tbl_nf_header_Q2P" h
    JOIN public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf
    WHERE h.tp_nf = 0
      AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
      AND LEFT(i.cfop, 1) IN ('1','2')
      AND h.d_emi >= CURRENT_DATE - 180
    UNION ALL
    -- Q2P Filial nacional
    SELECT i.q_com AS kg
    FROM public."tbl_nf_header_Q2P_Filial" h
    JOIN public."tbl_nf_itens_Q2P_Filial" i ON i.n_id_nf = h.n_id_nf
    WHERE h.tp_nf = 0
      AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
      AND LEFT(i.cfop, 1) IN ('1','2')
      AND h.d_emi >= CURRENT_DATE - 180
  ) src
)
SELECT
  'TOTAL PENDÊNCIA NACIONAL' AS categoria,
  total_kg,
  qtd_linhas
FROM fiscal_pend_nacional;

-- Breakdown por empresa
\echo ''
\echo 'Breakdown por empresa (ACXE / Q2P / Q2P_Filial):'
\echo ''

SELECT 'ACXE' AS empresa, SUM(i.q_com)::numeric(15,2) AS kg
FROM public."tbl_nf_header_ACXE" h
JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
WHERE h.tp_nf = 0
  AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
  AND LEFT(i.cfop, 1) IN ('1','2')
  AND h.d_emi >= CURRENT_DATE - 180
UNION ALL
SELECT 'Q2P', SUM(i.q_com)::numeric(15,2)
FROM public."tbl_nf_header_Q2P" h
JOIN public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf
WHERE h.tp_nf = 0
  AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
  AND LEFT(i.cfop, 1) IN ('1','2')
  AND h.d_emi >= CURRENT_DATE - 180
UNION ALL
SELECT 'Q2P_Filial', SUM(i.q_com)::numeric(15,2)
FROM public."tbl_nf_header_Q2P_Filial" h
JOIN public."tbl_nf_itens_Q2P_Filial" i ON i.n_id_nf = h.n_id_nf
WHERE h.tp_nf = 0
  AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
  AND LEFT(i.cfop, 1) IN ('1','2')
  AND h.d_emi >= CURRENT_DATE - 180
ORDER BY empresa;

-- ============================================================================
\echo ''
\echo '================================================================'
\echo '3. PENDÊNCIA IMPORTAÇÃO (CFOP 3.xxx ACXE, não reconciliada em Atlas)'
\echo '================================================================'

WITH fiscal_pend_importacao AS (
  SELECT SUM(i.q_com)::numeric(15,2) AS total_kg, COUNT(*) AS qtd_linhas
  FROM public."tbl_nf_header_ACXE" h
  JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
  WHERE h.tp_nf = 0
    AND LEFT(i.cfop, 1) = '3'
    AND h.d_emi >= CURRENT_DATE - 180
    AND NOT EXISTS (
      SELECT 1 FROM stockbridge.movimentacao m
      WHERE m.ativo = true
        AND m.subtipo = 'importacao'
        AND m.nota_fiscal = h.n_nf
    )
)
SELECT
  'TOTAL PENDÊNCIA IMPORTAÇÃO' AS categoria,
  total_kg,
  qtd_linhas
FROM fiscal_pend_importacao;

-- ============================================================================
\echo ''
\echo '================================================================'
\echo 'RESUMO FINAL: POSIÇÃO FISCAL'
\echo '================================================================'

WITH fisico_omie AS (
  SELECT SUM(saldo_local)::numeric(15,2) AS total
  FROM (
    WITH posicao_unificada AS (
      SELECT
        'ACXE'::text AS empresa,
        e.codigo AS codigo_estoque,
        p.cdescricao AS descricao_produto,
        p.nsaldo AS saldo,
        p.ddataposicao
      FROM public."tbl_posicaoEstoque_ACXE" p
      INNER JOIN public."tbl_locaisEstoques_ACXE" e
        ON p.codigo_local_estoque = e.codigo_local_estoque
      WHERE p.fisico >= 0
      UNION ALL
      SELECT
        'Q2P'::text,
        e.codigo,
        p.cdescricao,
        p.nsaldo,
        p.ddataposicao
      FROM public."tbl_posicaoEstoque_Q2P" p
      INNER JOIN public."tbl_locaisEstoques_Q2P" e
        ON p.codigo_local_estoque = e.codigo_local_estoque
      WHERE p.fisico >= 0
    ),
    fisico_por_empresa AS (
      SELECT empresa, MAX(ddataposicao) AS data_mais_recente
      FROM posicao_unificada
      GROUP BY empresa
    ),
    posicao_bruta AS (
      SELECT
        pa.codigo_produto AS produto_codigo_acxe,
        o.codigo_estoque,
        o.saldo
      FROM posicao_unificada o
      INNER JOIN fisico_por_empresa fpe ON fpe.empresa = o.empresa AND fpe.data_mais_recente = o.ddataposicao
      INNER JOIN public."tbl_produtos_ACXE" pa ON pa.descricao = o.descricao_produto
      WHERE o.saldo > 0 AND o.codigo_estoque = ANY('{11.1,11.2,12.1,12.2,21.1,21.2,31.1}'::text[])
    ),
    posicao_consolidada AS (
      SELECT
        COALESCE(MAX(saldo) FILTER (WHERE empresa = 'Q2P'), MAX(saldo) FILTER (WHERE empresa = 'ACXE')) AS saldo_local
      FROM posicao_bruta
      GROUP BY produto_codigo_acxe, codigo_estoque
    )
    SELECT SUM(saldo_local) AS saldo_local FROM posicao_consolidada
  ) x
),
pend_nac AS (
  SELECT SUM(kg)::numeric(15,2) AS total
  FROM (
    SELECT i.q_com AS kg
    FROM public."tbl_nf_header_ACXE" h
    JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
    WHERE h.tp_nf = 0 AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
      AND LEFT(i.cfop, 1) IN ('1','2') AND h.d_emi >= CURRENT_DATE - 180
    UNION ALL
    SELECT i.q_com
    FROM public."tbl_nf_header_Q2P" h
    JOIN public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf
    WHERE h.tp_nf = 0 AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
      AND LEFT(i.cfop, 1) IN ('1','2') AND h.d_emi >= CURRENT_DATE - 180
    UNION ALL
    SELECT i.q_com
    FROM public."tbl_nf_header_Q2P_Filial" h
    JOIN public."tbl_nf_itens_Q2P_Filial" i ON i.n_id_nf = h.n_id_nf
    WHERE h.tp_nf = 0 AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
      AND LEFT(i.cfop, 1) IN ('1','2') AND h.d_emi >= CURRENT_DATE - 180
  ) src
),
pend_imp AS (
  SELECT SUM(i.q_com)::numeric(15,2) AS total
  FROM public."tbl_nf_header_ACXE" h
  JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
  WHERE h.tp_nf = 0 AND LEFT(i.cfop, 1) = '3' AND h.d_emi >= CURRENT_DATE - 180
    AND NOT EXISTS (
      SELECT 1 FROM stockbridge.movimentacao m
      WHERE m.ativo = true AND m.subtipo = 'importacao' AND m.nota_fiscal = h.n_nf
    )
)
SELECT
  'Saldo Físico (OMIE)' AS componente,
  COALESCE(fo.total, 0)::numeric(15,2) AS kg
FROM fisico_omie fo
UNION ALL
SELECT 'Pendência Nacional', COALESCE(pn.total, 0)::numeric(15,2) FROM pend_nac pn
UNION ALL
SELECT 'Pendência Importação', COALESCE(pi.total, 0)::numeric(15,2) FROM pend_imp pi
UNION ALL
SELECT
  'TOTAL POSIÇÃO FISCAL',
  (COALESCE((SELECT total FROM fisico_omie), 0) +
   COALESCE((SELECT total FROM pend_nac), 0) +
   COALESCE((SELECT total FROM pend_imp), 0))::numeric(15,2)
ORDER BY componente DESC;

\echo ''
\echo 'Execução finalizada em: '
SELECT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS');
