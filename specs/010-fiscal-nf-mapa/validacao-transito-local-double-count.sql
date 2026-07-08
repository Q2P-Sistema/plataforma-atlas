-- ============================================================================
-- VALIDAÇÃO: "Trânsito p/ Galpão" (transito_local) × recebimento parcial
-- ============================================================================
-- Card: ACXEGDP-183 (subtarefa de ACXEGDP-114) — item de "Fase 2" registrado só
-- em comentário do Jira (2026-06-18/19), sem card formal, até esta correção.
--
-- Problema: o lote FUP em estagio_transito='transito_local' guarda
-- quantidade_fisica_kg = pc.nqtde (o PEDIDO INTEIRO). Quando uma filhote de
-- importação é recebida no Atlas, o material sobe pro OMIE (entra em
-- "Disponível"), mas o lote de trânsito só é soft-deletado quando o pedido
-- fecha por INTEIRO (etapa FUP 23) — recebimento parcial não desconta nada.
-- Resultado: o volume já recebido contava 2× (Disponível + Trânsito p/ Galpão).
--
-- Fix (cockpit.service.ts, CTE transito_atlas): para lotes em transito_local,
-- descontar o kg das filhotes já recebidas do mesmo pedido/produto — mesmo
-- critério de "recebida" (n_id_receb>0 OU movimentacao OU movimentacao_legado)
-- já usado na Parte A de fiscal_pend_importacao (Fix 3, ACXEGDP-183).
--
-- Baseline UAT esperado (ver comentários Jira ACXEGDP-183, 2026-06-18/19):
--   double-count identificado ~104.500-186.500 kg (pedidos 499/515, recebimento parcial)
--
-- Execução: psql "$DATABASE_URL" -f validacao-transito-local-double-count.sql
-- ============================================================================

\echo '== 1. Lotes em transito_local com pedido/mapa ativo, antes do fix =='

SELECT
  l.pedido_compra_acxe,
  l.produto_codigo_acxe,
  l.quantidade_fisica_kg AS lote_kg_bruto
FROM stockbridge.lote l
WHERE l.ativo = true AND l.status = 'transito' AND l.estagio_transito = 'transito_local'
  AND l.pedido_compra_acxe IS NOT NULL
ORDER BY l.pedido_compra_acxe, l.produto_codigo_acxe;

\echo '== 2. Kg já recebido (filhotes) por pedido/produto =='

WITH recebido AS (
  SELECT mapa.pedido_acxe_omie, i.n_cod_prod AS produto_codigo_acxe,
         SUM(i.q_com)::numeric AS recebido_kg
  FROM stockbridge.nf_pedido_mapa mapa
  JOIN stockbridge.nf_pedido_filhote f ON f.mapa_id = mapa.id AND f.ativo = true
  JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote, 8, '0')
  JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
  WHERE mapa.ativo = true
    AND (
      h.n_id_receb > 0
      OR EXISTS (SELECT 1 FROM stockbridge.movimentacao m WHERE m.ativo AND m.subtipo='importacao' AND m.nota_fiscal=LPAD(f.nf_filhote,8,'0'))
      OR EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml WHERE ml.ativo AND ml.nota_fiscal=LPAD(f.nf_filhote,8,'0'))
    )
  GROUP BY mapa.pedido_acxe_omie, i.n_cod_prod
)
SELECT * FROM recebido ORDER BY pedido_acxe_omie, produto_codigo_acxe;

\echo '== 3. Trânsito p/ Galpão: bruto (antes) × líquido (depois do fix) — por produto =='

WITH recebido AS (
  SELECT mapa.pedido_acxe_omie, i.n_cod_prod AS produto_codigo_acxe,
         SUM(i.q_com)::numeric AS recebido_kg
  FROM stockbridge.nf_pedido_mapa mapa
  JOIN stockbridge.nf_pedido_filhote f ON f.mapa_id = mapa.id AND f.ativo = true
  JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote, 8, '0')
  JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
  WHERE mapa.ativo = true
    AND (
      h.n_id_receb > 0
      OR EXISTS (SELECT 1 FROM stockbridge.movimentacao m WHERE m.ativo AND m.subtipo='importacao' AND m.nota_fiscal=LPAD(f.nf_filhote,8,'0'))
      OR EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml WHERE ml.ativo AND ml.nota_fiscal=LPAD(f.nf_filhote,8,'0'))
    )
  GROUP BY mapa.pedido_acxe_omie, i.n_cod_prod
)
SELECT
  l.produto_codigo_acxe,
  SUM(l.quantidade_fisica_kg)::numeric AS transito_bruto_kg,
  SUM(GREATEST(l.quantidade_fisica_kg - COALESCE(r.recebido_kg, 0), 0))::numeric AS transito_liquido_kg,
  SUM(l.quantidade_fisica_kg)::numeric - SUM(GREATEST(l.quantidade_fisica_kg - COALESCE(r.recebido_kg, 0), 0))::numeric AS double_count_descontado_kg
FROM stockbridge.lote l
LEFT JOIN recebido r ON r.pedido_acxe_omie = l.pedido_compra_acxe AND r.produto_codigo_acxe = l.produto_codigo_acxe
WHERE l.ativo = true AND l.status = 'transito' AND l.estagio_transito = 'transito_local'
GROUP BY l.produto_codigo_acxe
ORDER BY double_count_descontado_kg DESC;

\echo '== 4. Totais: Trânsito p/ Galpão bruto × líquido (deve bater com o cockpit após o fix) =='

WITH recebido AS (
  SELECT mapa.pedido_acxe_omie, i.n_cod_prod AS produto_codigo_acxe,
         SUM(i.q_com)::numeric AS recebido_kg
  FROM stockbridge.nf_pedido_mapa mapa
  JOIN stockbridge.nf_pedido_filhote f ON f.mapa_id = mapa.id AND f.ativo = true
  JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote, 8, '0')
  JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
  WHERE mapa.ativo = true
    AND (
      h.n_id_receb > 0
      OR EXISTS (SELECT 1 FROM stockbridge.movimentacao m WHERE m.ativo AND m.subtipo='importacao' AND m.nota_fiscal=LPAD(f.nf_filhote,8,'0'))
      OR EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml WHERE ml.ativo AND ml.nota_fiscal=LPAD(f.nf_filhote,8,'0'))
    )
  GROUP BY mapa.pedido_acxe_omie, i.n_cod_prod
)
SELECT
  round(SUM(l.quantidade_fisica_kg)::numeric, 0) AS total_transito_bruto_kg,
  round(SUM(GREATEST(l.quantidade_fisica_kg - COALESCE(r.recebido_kg, 0), 0))::numeric, 0) AS total_transito_liquido_kg
FROM stockbridge.lote l
LEFT JOIN recebido r ON r.pedido_acxe_omie = l.pedido_compra_acxe AND r.produto_codigo_acxe = l.produto_codigo_acxe
WHERE l.ativo = true AND l.status = 'transito' AND l.estagio_transito = 'transito_local';
