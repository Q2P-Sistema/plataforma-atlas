-- Migration: 0048 — StockBridge: critério de escolha do pedido na baixa Q2P (ACXEGDP-344)
--
-- Antes: o ledger stockbridge.baixa_pedido_q2p registrava QUAL pedido foi
--   descontado, mas não POR QUÊ. E o serviço só usava o vínculo NF→pedido ACXE
--   (stockbridge.nf_pedido_mapa, feature 011) quando o mapa estava ATIVO — mas
--   o mapa é auto-desativado assim que todas as filhotes são recebidas, então
--   para toda NF já recebida o vínculo era descartado e a baixa caía na FIFO
--   por produto (137 das 150 NFs do backfill).
-- Agora: o serviço usa o vínculo inclusive histórico (mapa inativo = NF
--   recebida, não vínculo inválido) e grava o critério no ledger:
--   'vinculo_nf' = pedido Q2P casado com o pedido ACXE da NF; 'fifo' = fallback
--   por previsão de entrega quando não há vínculo (ou o vinculado não tem saldo).
-- Porque: a Comex precisa saber se o pedido zerado é o da carga que chegou ou
--   um "vizinho" escolhido por ordem de previsão — e o backfill precisa ser
--   auditável nesse ponto.

ALTER TABLE stockbridge.baixa_pedido_q2p
    ADD COLUMN IF NOT EXISTS criterio text
        CHECK (criterio IN ('vinculo_nf', 'fifo'));

COMMENT ON COLUMN stockbridge.baixa_pedido_q2p.criterio IS
  'ACXEGDP-344: vinculo_nf = pedido Q2P casado com o pedido ACXE da NF (nf_pedido_mapa, inclusive historico); fifo = fallback por dDtPrevisao. NULL em linhas sem_pedido.';
