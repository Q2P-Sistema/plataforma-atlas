-- Migration: 0031 — custo_unitario_brl em stockbridge.movimentacao
--
-- Permite que recebimentos nacionais (entrada_manual sem lote) armazenem o valor
-- unitario informado pelo operador na NF. Usado por aprovacao.service ao chamar
-- OMIE em vez do placeholder 0.01.

ALTER TABLE stockbridge.movimentacao
  ADD COLUMN IF NOT EXISTS custo_unitario_brl numeric(14, 6);
