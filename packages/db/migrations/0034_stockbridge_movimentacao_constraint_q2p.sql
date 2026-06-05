-- Migration: 0034 — Expandir chk_lote_ou_sku em movimentacao e aprovacao para aceitar produto_codigo_q2p
--
-- Antes: lote_id OR (produto_codigo_acxe + galpao + empresa)
-- Agora: lote_id OR (produto_codigo_acxe + galpao + empresa)
--                 OR (produto_codigo_q2p  + galpao + empresa)
--
-- Necessario para recebimentos nacionais Q2P que nao tem codigo ACXE.

ALTER TABLE stockbridge.movimentacao
  DROP CONSTRAINT movimentacao_chk_lote_ou_sku;

ALTER TABLE stockbridge.movimentacao
  ADD CONSTRAINT movimentacao_chk_lote_ou_sku CHECK (
    (lote_id IS NOT NULL)
    OR (produto_codigo_acxe IS NOT NULL AND galpao IS NOT NULL AND empresa IS NOT NULL)
    OR (produto_codigo_q2p  IS NOT NULL AND galpao IS NOT NULL AND empresa IS NOT NULL)
  );

ALTER TABLE stockbridge.aprovacao
  DROP CONSTRAINT aprovacao_chk_lote_ou_sku;

ALTER TABLE stockbridge.aprovacao
  ADD CONSTRAINT aprovacao_chk_lote_ou_sku CHECK (
    (lote_id IS NOT NULL)
    OR (produto_codigo_acxe IS NOT NULL AND galpao IS NOT NULL AND empresa IS NOT NULL)
    OR (produto_codigo_q2p  IS NOT NULL AND galpao IS NOT NULL AND empresa IS NOT NULL)
  );
