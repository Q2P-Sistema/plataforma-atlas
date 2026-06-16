-- ============================================================================
-- VALIDAÇÃO: Posição Fiscal — recebimento de filhote via movimentacao/legado
-- ============================================================================
-- Card: ACXEGDP-183 (subtarefa de ACXEGDP-114)
--
-- Contexto: a Parte A da Pendência de Importação (mapa NF mãe/filhote) decidia
-- "filhote recebida" SÓ por n_id_receb de tbl_nf_header_ACXE. Filhotes que são
-- NFs antigas (recebidas no legado MySQL, n_id_receb nunca preenchido no OMIE)
-- contavam como pendentes para sempre, inflando a posição fiscal. O fix estende
-- o critério para também aceitar movimentacao / movimentacao_legado — espelhando
-- as exclusões que a Parte B (fallback CFOP 3.xxx) já fazia.
--
-- Fontes do fix:
--   modules/stockbridge/src/services/cockpit.service.ts        (Parte A)
--   modules/stockbridge/src/services/nf-pedido-mapa.service.ts (auto-desativação)
--
-- Execução:
--   psql "postgresql://user:pass@host:5432/acxe_q2p" -f validacao-posicao-fiscal-mae-filhote.sql
--
-- Cutoff fiscal: usar o mesmo STOCKBRIDGE_FISCAL_CUTOFF_DATE do ambiente.
--   Em UAT (2026-06-15) o cutoff era 2026-06-01 — ajuste o \set abaixo conforme o ambiente.
--
-- Baseline UAT (2026-06-15), filtro de métricas aplicado, cnpj=ambos:
--   Parte A atual ....... 2.632.875 kg (29 pedidos)
--   Parte A corrigida ... 1.094.000 kg (9 pedidos)   -> -1.538.875 kg
--   Parte B (CFOP 3) ....   721.750 kg
--   Importação atual .... 3.354.625 kg  (= tela)
--   Importação corrigida  1.815.750 kg  (-45,9%)
-- ============================================================================

\set cutoff '2026-06-01'

\echo '================================================================'
\echo '1. DIAGNÓSTICO — filhotes ativas "pendentes" (n_id_receb) já recebidas no Atlas/legado'
\echo '================================================================'

WITH filhote_pend AS (
  SELECT f.nf_filhote, LPAD(f.nf_filhote, 8, '0') AS nf_pad
  FROM stockbridge.nf_pedido_mapa mapa
  JOIN stockbridge.nf_pedido_filhote f ON f.mapa_id = mapa.id AND f.ativo = true
  LEFT JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote, 8, '0')
  WHERE mapa.ativo = true
    AND (h.n_id_nf IS NULL OR h.n_id_receb = 0 OR h.n_id_receb IS NULL)
)
SELECT
  count(*) AS filhotes_pendentes,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM stockbridge.movimentacao m
                                 WHERE m.ativo = true AND m.subtipo = 'importacao'
                                   AND m.nota_fiscal = fp.nf_pad))            AS tambem_em_movimentacao,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml
                                 WHERE ml.ativo = true AND ml.nota_fiscal = fp.nf_pad)) AS tambem_em_legado,
  count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public."tbl_nf_header_ACXE" h
                                     WHERE h.n_nf = fp.nf_pad))               AS nf_inexistente_omie
FROM filhote_pend fp;

\echo '================================================================'
\echo '2. RECONCILIAÇÃO — Pendência de Importação: critério ATUAL vs CORRIGIDO'
\echo '   (filtro incluir_em_metricas aplicado; deve bater com a tela do cockpit)'
\echo '================================================================'

WITH produtos_validos AS (
  SELECT p.codigo_produto AS produto
  FROM public."tbl_produtos_ACXE" p
  LEFT JOIN stockbridge.familia_omie_atlas f ON f.familia_omie = p.descricao_familia
  LEFT JOIN stockbridge.config_produto c ON c.produto_codigo_acxe = p.codigo_produto
  WHERE COALESCE(f.incluir_em_metricas, true) = true
    AND COALESCE(c.incluir_em_metricas, true) = true
),
-- Parte A: critério ATUAL (só n_id_receb)
parte_a_atual AS (
  SELECT pc.ncodprod AS produto, SUM(pc.nqtde)::numeric AS kg
  FROM stockbridge.nf_pedido_mapa mapa
  JOIN public."tbl_pedidosCompras_ACXE" pc ON pc.cnumero = mapa.pedido_acxe_omie
  WHERE mapa.ativo = true AND pc.nqtde > 0
    AND ( NOT EXISTS (SELECT 1 FROM stockbridge.nf_pedido_filhote f
                      WHERE f.mapa_id = mapa.id AND f.ativo = true)
       OR EXISTS (SELECT 1 FROM stockbridge.nf_pedido_filhote f
                  LEFT JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote, 8, '0')
                  WHERE f.mapa_id = mapa.id AND f.ativo = true
                    AND (h.n_id_nf IS NULL OR h.n_id_receb = 0 OR h.n_id_receb IS NULL)) )
  GROUP BY pc.ncodprod
),
-- Parte A: critério CORRIGIDO (n_id_receb OU movimentacao OU movimentacao_legado)
parte_a_corrig AS (
  SELECT pc.ncodprod AS produto, SUM(pc.nqtde)::numeric AS kg
  FROM stockbridge.nf_pedido_mapa mapa
  JOIN public."tbl_pedidosCompras_ACXE" pc ON pc.cnumero = mapa.pedido_acxe_omie
  WHERE mapa.ativo = true AND pc.nqtde > 0
    AND ( NOT EXISTS (SELECT 1 FROM stockbridge.nf_pedido_filhote f
                      WHERE f.mapa_id = mapa.id AND f.ativo = true)
       OR EXISTS (SELECT 1 FROM stockbridge.nf_pedido_filhote f
                  LEFT JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote, 8, '0')
                  WHERE f.mapa_id = mapa.id AND f.ativo = true
                    AND (h.n_id_nf IS NULL OR h.n_id_receb = 0 OR h.n_id_receb IS NULL)
                    AND NOT EXISTS (SELECT 1 FROM stockbridge.movimentacao m
                                    WHERE m.ativo = true AND m.subtipo = 'importacao'
                                      AND m.nota_fiscal = LPAD(f.nf_filhote, 8, '0'))
                    AND NOT EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml
                                    WHERE ml.ativo = true AND ml.nota_fiscal = LPAD(f.nf_filhote, 8, '0'))) )
  GROUP BY pc.ncodprod
),
-- Parte B: fallback CFOP 3.xxx (idêntica nas duas versões)
parte_b AS (
  SELECT i.n_cod_prod AS produto, SUM(i.q_com)::numeric AS kg
  FROM public."tbl_nf_header_ACXE" h
  JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
  WHERE h.tp_nf = 0 AND LEFT(i.cfop, 1) = '3' AND h.d_emi >= :'cutoff'::date
    AND NOT EXISTS (SELECT 1 FROM stockbridge.movimentacao m
                    WHERE m.ativo = true AND m.subtipo = 'importacao' AND m.nota_fiscal = h.n_nf)
    AND NOT EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml
                    WHERE ml.ativo = true AND ml.nota_fiscal = h.n_nf)
    AND NOT EXISTS (SELECT 1 FROM stockbridge.nf_pedido_mapa mapa
                    WHERE LPAD(mapa.nf_mae, 8, '0') = h.n_nf AND mapa.ativo = true)
  GROUP BY i.n_cod_prod
),
imp_atual  AS (SELECT produto, SUM(kg) AS kg FROM (SELECT * FROM parte_a_atual  UNION ALL SELECT * FROM parte_b) x GROUP BY produto),
imp_corrig AS (SELECT produto, SUM(kg) AS kg FROM (SELECT * FROM parte_a_corrig UNION ALL SELECT * FROM parte_b) x GROUP BY produto)
SELECT
  (SELECT round(SUM(kg)::numeric, 0) FROM parte_a_atual  WHERE produto IN (SELECT produto FROM produtos_validos)) AS parte_a_atual_kg,
  (SELECT round(SUM(kg)::numeric, 0) FROM parte_a_corrig WHERE produto IN (SELECT produto FROM produtos_validos)) AS parte_a_corrig_kg,
  (SELECT round(SUM(kg)::numeric, 0) FROM parte_b        WHERE produto IN (SELECT produto FROM produtos_validos)) AS parte_b_kg,
  (SELECT round(SUM(kg)::numeric, 0) FROM imp_atual      WHERE produto IN (SELECT produto FROM produtos_validos)) AS importacao_atual_kg,
  (SELECT round(SUM(kg)::numeric, 0) FROM imp_corrig     WHERE produto IN (SELECT produto FROM produtos_validos)) AS importacao_corrig_kg;
