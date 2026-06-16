-- ============================================================================
-- VALIDAÇÃO: Posição Fiscal — Pendência de Importação (mapa NF mãe/filhote)
-- ============================================================================
-- Card: ACXEGDP-183 (subtarefa de ACXEGDP-114)
--
-- DOIS fixes aplicados ao cálculo de Pendência de Importação (cockpit.service.ts):
--
--   Fix 1 — Parte A (mapa) e auto-desativação (nf-pedido-mapa.service.ts):
--     "filhote recebida" passou a aceitar n_id_receb>0 (OMIE) OU presença em
--     stockbridge.movimentacao (subtipo='importacao') OU movimentacao_legado.
--     Antes só olhava n_id_receb → filhotes recebidas fora do OMIE (legado MySQL)
--     contavam como pendentes para sempre.
--
--   Fix 2 — Parte B (fallback CFOP 3.xxx):
--     passou a excluir NFs que são FILHOTE de mapa ativo (antes só excluía a NF mãe).
--     A filhote tem CFOP 3 e o pedido dela já é contado na Parte A → sem isso o mesmo
--     volume contava 2x (dupla contagem A+B).
--
-- Execução:
--   psql "postgresql://user:pass@host:5432/acxe_q2p" -f validacao-posicao-fiscal-mae-filhote.sql
--
-- Cutoff fiscal: usar o mesmo STOCKBRIDGE_FISCAL_CUTOFF_DATE do ambiente (\set abaixo).
--   Em UAT (2026-06-15) o cutoff era 2026-06-01.
--
-- Baseline UAT (2026-06-15), filtro de métricas, cnpj=ambos:
--   Pendência Importação na tela (antes)............. 3.354.625 kg
--   Após Fix 1 (filhote recebida via mov/legado)..... 1.815.750 kg
--   Após Fix 1 + Fix 2 (Parte B exclui filhote)...... 1.145.000 kg
--     = Parte A corrigida 1.094.000 + Parte B corrigida 51.000
--   Referência pipeline FUP: transito_local.......... 863.500 kg  (no_porto = 0)
--
-- ⚠️ DEBUG EM ABERTO (ACXEGDP-183): resíduo de ~281.500 kg entre a soma A+B
--    corrigida (1.145.000) e o transito_local do FUP (863.500). Hipóteses:
--      (a) Parte A conta o PEDIDO INTEIRO (pc.nqtde), não o saldo de filhotes ainda
--          não recebidas — o mapa não guarda quantidade por filhote (recebimento
--          parcial infla). Tirando o pedido sem filhote (168.000), A≈926.000 ≈ 863.500.
--      (b) 1 pedido com mapa ativo SEM filhote cadastrada conta inteiro (168.000 kg).
--      (c) divergência entre "mapa ativo" e o estágio FUP do lote.
--    Alvo de longo prazo: derivar a pendência do mesmo pipeline FUP (transito_local).
-- ============================================================================

\set cutoff '2026-06-01'

\echo '== 1. DIAGNÓSTICO: filhotes "pendentes" (n_id_receb) já recebidas no Atlas/legado =='

WITH filhote_pend AS (
  SELECT f.nf_filhote, LPAD(f.nf_filhote, 8, '0') AS nf_pad
  FROM stockbridge.nf_pedido_mapa mapa
  JOIN stockbridge.nf_pedido_filhote f ON f.mapa_id = mapa.id AND f.ativo = true
  LEFT JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote, 8, '0')
  WHERE mapa.ativo = true
    AND (h.n_id_nf IS NULL OR h.n_id_receb = 0 OR h.n_id_receb IS NULL)
)
SELECT
  count(*) AS filhotes_pendentes_omie,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM stockbridge.movimentacao m
                                 WHERE m.ativo AND m.subtipo='importacao' AND m.nota_fiscal = fp.nf_pad)) AS tambem_em_movimentacao,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml
                                 WHERE ml.ativo AND ml.nota_fiscal = fp.nf_pad)) AS tambem_em_legado
FROM filhote_pend fp;

\echo '== 2. RECONCILIAÇÃO: Pendência de Importação ANTES vs DEPOIS dos dois fixes + FUP =='

WITH produtos_validos AS (
  SELECT p.codigo_produto AS produto
  FROM public."tbl_produtos_ACXE" p
  LEFT JOIN stockbridge.familia_omie_atlas f ON f.familia_omie = p.descricao_familia
  LEFT JOIN stockbridge.config_produto c ON c.produto_codigo_acxe = p.codigo_produto
  WHERE COALESCE(f.incluir_em_metricas, true) = true
    AND COALESCE(c.incluir_em_metricas, true) = true
),
-- Pipeline FUP (referência operacional do material em trânsito)
trans AS (
  SELECT l.produto_codigo_acxe AS produto,
    SUM(l.quantidade_fisica_kg) FILTER (WHERE l.estagio_transito='no_porto')       AS np,
    SUM(l.quantidade_fisica_kg) FILTER (WHERE l.estagio_transito='transito_local') AS tl
  FROM stockbridge.lote l WHERE l.ativo AND l.status='transito' GROUP BY 1
),
-- Parte A — critério ANTIGO (só n_id_receb)
parte_a_old AS (
  SELECT pc.ncodprod AS produto, SUM(pc.nqtde)::numeric AS kg
  FROM stockbridge.nf_pedido_mapa mapa
  JOIN public."tbl_pedidosCompras_ACXE" pc ON pc.cnumero = mapa.pedido_acxe_omie
  WHERE mapa.ativo AND pc.nqtde > 0
    AND ( NOT EXISTS (SELECT 1 FROM stockbridge.nf_pedido_filhote f WHERE f.mapa_id=mapa.id AND f.ativo)
       OR EXISTS (SELECT 1 FROM stockbridge.nf_pedido_filhote f
                  LEFT JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote,8,'0')
                  WHERE f.mapa_id=mapa.id AND f.ativo
                    AND (h.n_id_nf IS NULL OR h.n_id_receb=0 OR h.n_id_receb IS NULL)) )
  GROUP BY pc.ncodprod
),
-- Parte A — critério NOVO (Fix 1: aceita mov/legado)
parte_a_new AS (
  SELECT pc.ncodprod AS produto, SUM(pc.nqtde)::numeric AS kg
  FROM stockbridge.nf_pedido_mapa mapa
  JOIN public."tbl_pedidosCompras_ACXE" pc ON pc.cnumero = mapa.pedido_acxe_omie
  WHERE mapa.ativo AND pc.nqtde > 0
    AND ( NOT EXISTS (SELECT 1 FROM stockbridge.nf_pedido_filhote f WHERE f.mapa_id=mapa.id AND f.ativo)
       OR EXISTS (SELECT 1 FROM stockbridge.nf_pedido_filhote f
                  LEFT JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote,8,'0')
                  WHERE f.mapa_id=mapa.id AND f.ativo
                    AND (h.n_id_nf IS NULL OR h.n_id_receb=0 OR h.n_id_receb IS NULL)
                    AND NOT EXISTS (SELECT 1 FROM stockbridge.movimentacao m WHERE m.ativo AND m.subtipo='importacao' AND m.nota_fiscal=LPAD(f.nf_filhote,8,'0'))
                    AND NOT EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml WHERE ml.ativo AND ml.nota_fiscal=LPAD(f.nf_filhote,8,'0'))) )
  GROUP BY pc.ncodprod
),
parte_b_base AS (
  SELECT i.n_cod_prod AS produto, h.n_nf, i.q_com
  FROM public."tbl_nf_header_ACXE" h
  JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
  WHERE h.tp_nf=0 AND LEFT(i.cfop,1)='3' AND h.d_emi >= :'cutoff'::date
    AND NOT EXISTS (SELECT 1 FROM stockbridge.movimentacao m WHERE m.ativo AND m.subtipo='importacao' AND m.nota_fiscal=h.n_nf)
    AND NOT EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml WHERE ml.ativo AND ml.nota_fiscal=h.n_nf)
    AND NOT EXISTS (SELECT 1 FROM stockbridge.nf_pedido_mapa mapa WHERE LPAD(mapa.nf_mae,8,'0')=h.n_nf AND mapa.ativo)
),
-- Parte B — ANTIGA (exclui só NF mãe)
parte_b_old AS (SELECT produto, SUM(q_com)::numeric AS kg FROM parte_b_base GROUP BY produto),
-- Parte B — NOVA (Fix 2: exclui também filhotes de mapa ativo)
parte_b_new AS (
  SELECT produto, SUM(q_com)::numeric AS kg FROM parte_b_base b
  WHERE NOT EXISTS (SELECT 1 FROM stockbridge.nf_pedido_mapa mapa
                    JOIN stockbridge.nf_pedido_filhote f ON f.mapa_id=mapa.id AND f.ativo
                    WHERE mapa.ativo AND LPAD(f.nf_filhote,8,'0') = b.n_nf)
  GROUP BY produto
)
SELECT
  (SELECT round(SUM(kg)::numeric,0) FROM parte_a_old WHERE produto IN (SELECT produto FROM produtos_validos)) AS parte_a_old,
  (SELECT round(SUM(kg)::numeric,0) FROM parte_a_new WHERE produto IN (SELECT produto FROM produtos_validos)) AS parte_a_new,
  (SELECT round(SUM(kg)::numeric,0) FROM parte_b_old WHERE produto IN (SELECT produto FROM produtos_validos)) AS parte_b_old,
  (SELECT round(SUM(kg)::numeric,0) FROM parte_b_new WHERE produto IN (SELECT produto FROM produtos_validos)) AS parte_b_new,
  (SELECT round((COALESCE(SUM(kg),0))::numeric,0) FROM parte_a_old WHERE produto IN (SELECT produto FROM produtos_validos))
    + (SELECT round((COALESCE(SUM(kg),0))::numeric,0) FROM parte_b_old WHERE produto IN (SELECT produto FROM produtos_validos)) AS total_antes,
  (SELECT round((COALESCE(SUM(kg),0))::numeric,0) FROM parte_a_new WHERE produto IN (SELECT produto FROM produtos_validos))
    + (SELECT round((COALESCE(SUM(kg),0))::numeric,0) FROM parte_b_new WHERE produto IN (SELECT produto FROM produtos_validos)) AS total_depois,
  (SELECT round(SUM(np)::numeric,0) FROM trans WHERE produto IN (SELECT produto FROM produtos_validos)) AS fup_no_porto,
  (SELECT round(SUM(tl)::numeric,0) FROM trans WHERE produto IN (SELECT produto FROM produtos_validos)) AS fup_transito_local;
