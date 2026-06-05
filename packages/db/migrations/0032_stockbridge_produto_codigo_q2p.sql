-- Migration: 0032 — produto_codigo_q2p em movimentacao e aprovacao
--
-- Permite que recebimentos nacionais Q2P armazenem o código de produto Q2P
-- diretamente (sem exigir match por descrição com ACXE). produto_codigo_acxe
-- permanece NULL para essas entradas — evita poluição de queries existentes
-- que assumem que o campo contém um código ACXE válido.

ALTER TABLE stockbridge.movimentacao
  ADD COLUMN IF NOT EXISTS produto_codigo_q2p bigint;

ALTER TABLE stockbridge.aprovacao
  ADD COLUMN IF NOT EXISTS produto_codigo_q2p bigint;
