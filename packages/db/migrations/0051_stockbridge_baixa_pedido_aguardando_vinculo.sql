-- Migration: 0051 — StockBridge: baixa do pedido Q2P exige vínculo NF→pedido (sem FIFO) (ACXEGDP-344)
--
-- Antes: quando a NF filhote não tinha vínculo com pedido ACXE no mapa
--   (stockbridge.nf_pedido_mapa, alimentado de hora em hora pelo n8n a
--   partir da planilha FUP), a baixa caía em FIFO — o pedido mais antigo do
--   produto. Em 28/08 isso zerou o pedido errado (NF 5210 → pedido 175, que
--   era de outra carga) e precisou de reversão. O excedente sobre o pedido
--   vinculado também transbordava para outro pedido do produto.
-- Agora: decisão de negócio (Flavio, 28/08) — a baixa SÓ acontece no pedido
--   Q2P casado com o pedido ACXE da NF filhote. Sem vínculo, a movimentação
--   fica em 'aguardando_vinculo' e um cron horário re-tenta assim que a FUP
--   for preenchida; após N dias, digest de alerta para a Comex. Excedente
--   sobre o pedido vinculado vira 'sem_saldo' com alerta (nunca desconta de
--   outra carga). 'fifo' permanece no CHECK de criterio só para o histórico.
-- Porque: pedido zerado indevidamente é o erro caro (a Comex perde a visão
--   da carga que ainda vem); baixa atrasada por horas só aparece na tela
--   como "Aguardando vínculo".

ALTER TABLE stockbridge.movimentacao
    DROP CONSTRAINT IF EXISTS movimentacao_baixa_pedido_q2p_check;
ALTER TABLE stockbridge.movimentacao
    ADD CONSTRAINT movimentacao_baixa_pedido_q2p_check
        CHECK (baixa_pedido_q2p IN ('pendente', 'aguardando_vinculo', 'concluida', 'sem_saldo', 'falha'));

COMMENT ON COLUMN stockbridge.movimentacao.baixa_pedido_q2p IS
  'ACXEGDP-344: baixa do pedido de compra Q2P (AlteraPedCompra) desta entrada de importação. NULL = nao se aplica. pendente = nunca processada; aguardando_vinculo = NF sem vinculo com pedido ACXE no mapa (FUP) — cron horario re-tenta; concluida = saldo do pedido vinculado reduzido; sem_saldo = pedido vinculado nao cobre a quantidade (revisar); falha = OMIE falhou (retentavel).';

DROP INDEX IF EXISTS stockbridge.idx_movimentacao_baixa_pedido_q2p_pendente;
CREATE INDEX IF NOT EXISTS idx_movimentacao_baixa_pedido_q2p_pendente
    ON stockbridge.movimentacao (created_at)
    WHERE baixa_pedido_q2p IN ('pendente', 'aguardando_vinculo', 'falha', 'sem_saldo');
