-- ============================================================================
-- VALIDAÇÃO: Posição Fiscal de Importação (mapa NF mãe/filhote) — Fix 1/2/3/4
-- ============================================================================
-- Card: ACXEGDP-183 (subtarefa de ACXEGDP-114)
--
-- Correções no cálculo da "Pendência de Importação" (cockpit.service.ts):
--   Fix 1 — "filhote recebida" = n_id_receb>0 (OMIE) OU movimentacao(importacao) OU
--           movimentacao_legado. (NFs antigas recebidas no legado nunca tiveram n_id_receb.)
--   Fix 2 — fallback (Parte B) exclui mãe E filhote de mapa (anti dupla contagem A+B).
--   Fix 3 — Parte A conta o SALDO: pc.nqtde − Σ q_com das filhotes já recebidas (por produto),
--           com piso 0 — não o pedido inteiro (evita dupla contagem com o físico).
--   Fix 4 — fallback exclui mãe/filhote de QUALQUER mapa (ativo OU inativo). Mapa inativo =
--           pedido recebido; sua NF mãe (nunca recebe) vazaria como falsa pendência.
--
-- Referência de "recebida no legado": stockbridge.movimentacao_legado (one-shot do cutover,
--   866 linhas). NÃO usar public.tb_movimentacao_q2p_legado (espelho vivo) enquanto vazio.
--
-- Execução: psql "$DATABASE_URL" -f validacao-posicao-fiscal-mae-filhote.sql
-- Cutoff fiscal: usar o STOCKBRIDGE_FISCAL_CUTOFF_DATE do ambiente (\set abaixo).
--
-- Baseline UAT (2026-06-16, PÓS-sync PROD→UAT — 249 mapas, 9 ativos, filtro de métricas):
--   Parte A pedido inteiro (antes do Fix 3) .. 1.094.000 kg
--   Parte A saldo (Fix 3) .................... 939.250 kg
--   Parte B (Fix 4, sem-mapa real) ........... 51.000 kg
--   Parte B SEM Fix 4 (com vazamento de mãe) . 349.000 kg  (298.000 = mães de mapa inativo)
--   TOTAL Importação (Fix 3 + Fix 4) ......... 990.250 kg
-- (Baseline anterior, 29 mapas pré-sync, era Parte A 939.250 / Parte B 51.000 / total 990.250
--  por coincidência — os 9 pedidos pendentes são os mesmos; o sync só desativou os recebidos.)
-- ============================================================================

\set cutoff '2026-06-01'

\echo '== 1. Filhotes ativas e sua fonte de recebimento (Fix 1) =='

SELECT
  count(*) AS filhotes_ativas,
  count(*) FILTER (WHERE recebida) AS recebidas,
  count(*) FILTER (WHERE NOT recebida) AS pendentes,
  count(*) FILTER (WHERE fonte='omie')               AS via_omie,
  count(*) FILTER (WHERE fonte='movimentacao')        AS via_movimentacao,
  count(*) FILTER (WHERE fonte='movimentacao_legado') AS via_legado
FROM (
  SELECT
    (h.n_id_receb > 0
     OR EXISTS (SELECT 1 FROM stockbridge.movimentacao m WHERE m.ativo AND m.subtipo='importacao' AND m.nota_fiscal=LPAD(f.nf_filhote,8,'0'))
     OR EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml WHERE ml.ativo AND ml.nota_fiscal=LPAD(f.nf_filhote,8,'0'))) AS recebida,
    CASE
      WHEN h.n_id_receb > 0 THEN 'omie'
      WHEN EXISTS (SELECT 1 FROM stockbridge.movimentacao m WHERE m.ativo AND m.subtipo='importacao' AND m.nota_fiscal=LPAD(f.nf_filhote,8,'0')) THEN 'movimentacao'
      WHEN EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml WHERE ml.ativo AND ml.nota_fiscal=LPAD(f.nf_filhote,8,'0')) THEN 'movimentacao_legado'
      ELSE 'nenhuma'
    END AS fonte
  FROM stockbridge.nf_pedido_mapa mapa
  JOIN stockbridge.nf_pedido_filhote f ON f.mapa_id=mapa.id AND f.ativo
  LEFT JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote,8,'0')
  WHERE mapa.ativo
) x;

\echo '== 2. Pendência de Importação final (Fix 3 + Fix 4) — deve bater com o cockpit =='

WITH produtos_validos AS (
  SELECT p.codigo_produto AS produto FROM public."tbl_produtos_ACXE" p
  LEFT JOIN stockbridge.familia_omie_atlas f ON f.familia_omie=p.descricao_familia
  LEFT JOIN stockbridge.config_produto c ON c.produto_codigo_acxe=p.codigo_produto
  WHERE COALESCE(f.incluir_em_metricas,true) AND COALESCE(c.incluir_em_metricas,true)
),
-- Parte A (Fix 3): saldo por (mapa, produto)
rec AS (
  SELECT f.mapa_id, i.n_cod_prod AS ncodprod, SUM(i.q_com)::numeric AS recebido_kg
  FROM stockbridge.nf_pedido_filhote f
  JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote,8,'0')
  JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
  WHERE f.ativo AND (h.n_id_receb>0
    OR EXISTS (SELECT 1 FROM stockbridge.movimentacao m WHERE m.ativo AND m.subtipo='importacao' AND m.nota_fiscal=LPAD(f.nf_filhote,8,'0'))
    OR EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml WHERE ml.ativo AND ml.nota_fiscal=LPAD(f.nf_filhote,8,'0')))
  GROUP BY f.mapa_id, i.n_cod_prod
),
ped AS (
  SELECT mapa.id AS mapa_id, pc.ncodprod AS produto, SUM(pc.nqtde)::numeric AS qtde_pedido
  FROM stockbridge.nf_pedido_mapa mapa
  JOIN public."tbl_pedidosCompras_ACXE" pc ON pc.cnumero = mapa.pedido_acxe_omie
  WHERE mapa.ativo AND pc.nqtde>0
  GROUP BY mapa.id, pc.ncodprod
),
parte_a AS (
  SELECT ped.produto, SUM(GREATEST(ped.qtde_pedido - COALESCE(rec.recebido_kg,0),0))::numeric AS kg
  FROM ped LEFT JOIN rec ON rec.mapa_id=ped.mapa_id AND rec.ncodprod=ped.produto
  GROUP BY ped.produto
),
-- Parte B (Fix 4): exclui mãe/filhote de QUALQUER mapa
parte_b AS (
  SELECT i.n_cod_prod AS produto, SUM(i.q_com)::numeric AS kg
  FROM public."tbl_nf_header_ACXE" h
  JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
  WHERE h.tp_nf=0 AND LEFT(i.cfop,1)='3' AND h.d_emi >= :'cutoff'::date
    AND NOT EXISTS (SELECT 1 FROM stockbridge.movimentacao m WHERE m.ativo AND m.subtipo='importacao' AND m.nota_fiscal=h.n_nf)
    AND NOT EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml WHERE ml.ativo AND ml.nota_fiscal=h.n_nf)
    AND NOT EXISTS (SELECT 1 FROM stockbridge.nf_pedido_mapa mapa WHERE LPAD(mapa.nf_mae,8,'0')=h.n_nf)
    AND NOT EXISTS (SELECT 1 FROM stockbridge.nf_pedido_mapa mapa JOIN stockbridge.nf_pedido_filhote f ON f.mapa_id=mapa.id AND f.ativo WHERE LPAD(f.nf_filhote,8,'0')=h.n_nf)
  GROUP BY i.n_cod_prod
)
SELECT
  (SELECT round(SUM(kg)::numeric,0) FROM parte_a WHERE produto IN (SELECT produto FROM produtos_validos)) AS parte_a_saldo_kg,
  (SELECT round(SUM(kg)::numeric,0) FROM parte_b WHERE produto IN (SELECT produto FROM produtos_validos)) AS parte_b_kg,
  (SELECT COALESCE(round(SUM(kg)::numeric,0),0) FROM parte_a WHERE produto IN (SELECT produto FROM produtos_validos))
    + (SELECT COALESCE(round(SUM(kg)::numeric,0),0) FROM parte_b WHERE produto IN (SELECT produto FROM produtos_validos)) AS total_importacao_kg;
