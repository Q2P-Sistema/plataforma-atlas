-- Migration: 0050 — StockBridge: encerramento manual de pedido Q2P no ledger (ACXEGDP-344)
--
-- Antes: o ledger stockbridge.baixa_pedido_q2p só aceitava linhas ligadas a
--   uma movimentação de entrada (movimentacao_id NOT NULL). Pedidos Q2P
--   abertos cuja carga não vem mais (FUP "00 - CANCELADO") ou cujo processo
--   já encerrou sem baixa (FUP "05 - Encerrado", NF recebida no legado) —
--   15 pedidos / ~948 t em 28/08/2026 — só podiam ser zerados na interface
--   do OMIE, sem trilha no Atlas.
-- Agora: movimentacao_id passa a ser opcional; criterio e origem ganham
--   'manual'; nova coluna motivo (texto do gestor). O encerramento manual
--   (encerrarPedidoQ2p / --encerrar) grava uma linha por pedido com saldo
--   anterior → 0,1 kg e o motivo, auditada pelo trigger existente.
-- Porque: Princípio IV — toda escrita no OMIE feita pelo Atlas fica
--   rastreável (quem, quando, por quê, de quanto para quanto).

ALTER TABLE stockbridge.baixa_pedido_q2p
    ALTER COLUMN movimentacao_id DROP NOT NULL;

ALTER TABLE stockbridge.baixa_pedido_q2p
    DROP CONSTRAINT IF EXISTS baixa_pedido_q2p_criterio_check,
    ADD CONSTRAINT baixa_pedido_q2p_criterio_check
        CHECK (criterio IN ('vinculo_nf', 'fifo', 'manual'));

ALTER TABLE stockbridge.baixa_pedido_q2p
    DROP CONSTRAINT IF EXISTS baixa_pedido_q2p_origem_check,
    ADD CONSTRAINT baixa_pedido_q2p_origem_check
        CHECK (origem IN ('fluxo', 'retry', 'backfill', 'manual'));

ALTER TABLE stockbridge.baixa_pedido_q2p
    ADD COLUMN IF NOT EXISTS motivo text;

COMMENT ON COLUMN stockbridge.baixa_pedido_q2p.motivo IS
  'ACXEGDP-344: justificativa informada pelo gestor em encerramentos manuais (criterio=manual, movimentacao_id NULL) e reversoes.';
