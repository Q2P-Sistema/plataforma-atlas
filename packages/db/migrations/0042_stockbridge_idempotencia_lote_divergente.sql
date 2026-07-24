-- Migration: 0042 — StockBridge: idempotência cobre o fluxo divergente (STK-02, ACXEGDP-282)
--
-- Antes: o fluxo de recebimento com divergência cria apenas lote (status
--   'aguardando_aprovacao') + aprovacao — nenhuma movimentacao. A checagem de
--   idempotência (nfJaProcessada) só consultava movimentacao + movimentacao_legado,
--   então enquanto o gestor não decidia, a mesma NF continuava "livre": aparecia na
--   fila e podia ser processada de novo. Aprovando os dois lotes (opIds distintos),
--   dois ajustes OMIE reais para a mesma NF. lote.nota_fiscal tinha só índice
--   não-único (lote_nota_fiscal_idx, migration 0008).
-- Agora: UNIQUE INDEX parcial impede dois lotes 'aguardando_aprovacao' ativos para
--   o mesmo (nota_fiscal, produto). A checagem de aplicação em nfJaProcessada
--   (recebimento.service.ts) passa a considerar lotes abertos — o índice é a
--   garantia contra corrida; o check da aplicação dá o erro amigável antes.
-- Porque: janela real de ajuste duplicado no ERP confirmada na auditoria
--   ACXEGDP-238 (verificação adversarial, 2 verificadores).
--
-- Decisões de escopo do predicado:
--   - produto_codigo_acxe na chave (não só nota_fiscal): mesmo padrão do precedente
--     lote_uq_nf_produto (migration 0036) e não bloqueia o fix futuro de NF
--     multi-item (STK-10, ACXEGDP-289), que criará um lote por item da mesma NF.
--   - Só status 'aguardando_aprovacao': lote rejeitado libera re-recebimento
--     (legítimo), lote em transito nunca deve bloquear (a NF dele será recebida
--     depois), e provisorio/reconciliado já são cobertos pela movimentacao criada
--     na mesma transação (movimentacao_nf_idempotencia_idx, migration 0014).
--   - ativo = true: soft-delete libera unicidade, alinhado à migration 0014.

-- ── 1. Índice único parcial ─────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS lote_uq_nf_recebimento_aberto
  ON stockbridge.lote (nota_fiscal, produto_codigo_acxe)
  WHERE status = 'aguardando_aprovacao'
    AND nota_fiscal IS NOT NULL
    AND ativo = true;

COMMENT ON INDEX stockbridge.lote_uq_nf_recebimento_aberto IS
  'STK-02 (ACXEGDP-282): uma NF+produto só pode ter UM lote aguardando_aprovacao ativo. Impede segundo recebimento da mesma NF divergente antes da decisão do gestor (que geraria ajuste OMIE duplicado na aprovação).';
