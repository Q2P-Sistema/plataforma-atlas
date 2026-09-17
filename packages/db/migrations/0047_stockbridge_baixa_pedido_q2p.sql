-- Migration: 0047 — StockBridge: baixa do pedido de compra Q2P após recebimento (ACXEGDP-344)
--
-- Antes: o recebimento de importação gravava lote + movimentação e fazia o
--   ajuste dual de estoque (ACXE→Q2P), mas NUNCA reduzia o saldo do pedido de
--   compra da Q2P no OMIE. O cliente `alterarPedidoCompra` (feature 007, T016)
--   existia sem call site. O legado PHP fazia essa baixa (AlteraPedCompra,
--   FIFO por produto) — desde o cutover (17/06/2026) 3,5 kt de NFs recebidas
--   pelo Atlas seguem com o pedido Q2P em aberto.
-- Agora: (1) `movimentacao.baixa_pedido_q2p` — estado da baixa POR MOVIMENTAÇÃO
--   (NULL = não se aplica; pendente → concluida | sem_saldo | falha). O fluxo
--   de recebimento marca 'pendente' ao gravar a entrada de importação e o
--   serviço de baixa resolve; o painel/retry e o backfill listam por aqui.
--   (2) `stockbridge.baixa_pedido_q2p` — LEDGER por (movimentação, pedido):
--   quanto foi descontado de cada pedido, saldo anterior/novo e o estado da
--   chamada OMIE. É a trilha de auditoria e a base da idempotência (o
--   AlteraPedCompra envia quantidade ABSOLUTA — sem ledger, um retry cego
--   descontaria duas vezes).
-- Porque: fechar o ciclo de compras (exceção ao Princípio II já autorizada em
--   specs/007-stockbridge-module/constitution-review.md, item 3) com
--   auditoria (Princípio IV) e retry seguro, no padrão de operações pendentes.
--
-- Backfill: as entradas de importação já concluídas (sem baixa) viram
--   'pendente' — o script one-shot `backfill-baixa-pedido-q2p.ts` (dry-run
--   primeiro) processa a fila em ordem cronológica. Nada é enviado ao OMIE por
--   esta migration.

-- ── 1. Estado da baixa na movimentação ──────────────────────────────────────
ALTER TABLE stockbridge.movimentacao
    ADD COLUMN IF NOT EXISTS baixa_pedido_q2p text
        CHECK (baixa_pedido_q2p IN ('pendente', 'concluida', 'sem_saldo', 'falha'));

COMMENT ON COLUMN stockbridge.movimentacao.baixa_pedido_q2p IS
  'ACXEGDP-344: baixa do pedido de compra Q2P (AlteraPedCompra) desta entrada de importação. NULL = nao se aplica (saidas, nacionais). pendente = aguardando; concluida = saldo dos pedidos reduzido; sem_saldo = descontou o que havia mas sobrou quantidade sem pedido aberto (revisar); falha = OMIE falhou (retentavel).';

CREATE INDEX IF NOT EXISTS idx_movimentacao_baixa_pedido_q2p_pendente
    ON stockbridge.movimentacao (created_at)
    WHERE baixa_pedido_q2p IN ('pendente', 'falha', 'sem_saldo');

-- ── 2. Ledger por (movimentação, pedido) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS stockbridge.baixa_pedido_q2p (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    movimentacao_id    uuid NOT NULL REFERENCES stockbridge.movimentacao(id),
    -- Pedido Q2P (id OMIE). NULL = linha de "resto sem pedido aberto".
    ncodped            bigint,
    cnumero            varchar(50),
    ncodprod           bigint NOT NULL,
    ncoditem           bigint,
    quantidade_kg      numeric(12,3) NOT NULL,
    saldo_anterior_kg  numeric(12,3),
    saldo_novo_kg      numeric(12,3),
    status             text NOT NULL
        CHECK (status IN ('pendente', 'concluida', 'falha', 'sem_pedido')),
    origem             text NOT NULL DEFAULT 'fluxo'
        CHECK (origem IN ('fluxo', 'retry', 'backfill')),
    tentativas         smallint NOT NULL DEFAULT 0,
    ultimo_erro        jsonb,
    criado_por         uuid REFERENCES atlas.users(id),
    ativo              boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE stockbridge.baixa_pedido_q2p IS
  'ACXEGDP-344: ledger da baixa de pedido de compra Q2P — uma linha por (movimentacao de entrada, pedido Q2P descontado). saldo_anterior/novo sao a quantidade do item ANTES/DEPOIS do AlteraPedCompra (absoluta). status=pendente e gravado ANTES da chamada OMIE (crash-safe: o retry compara o saldo ao vivo com saldo_novo para saber se a chamada persistiu).';

-- Um pedido só é descontado uma vez por movimentação (retry reaproveita a linha).
CREATE UNIQUE INDEX IF NOT EXISTS baixa_pedido_q2p_mov_pedido_uq
    ON stockbridge.baixa_pedido_q2p (movimentacao_id, ncodped)
    WHERE ativo = true AND ncodped IS NOT NULL;

-- No máximo uma linha de "resto sem pedido" por movimentação.
CREATE UNIQUE INDEX IF NOT EXISTS baixa_pedido_q2p_mov_sem_pedido_uq
    ON stockbridge.baixa_pedido_q2p (movimentacao_id)
    WHERE ativo = true AND ncodped IS NULL;

CREATE INDEX IF NOT EXISTS baixa_pedido_q2p_ncodped_idx
    ON stockbridge.baixa_pedido_q2p (ncodped);

-- ── 3. Auditoria (Princípio IV) ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION stockbridge.audit_baixa_pedido_q2p()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'baixa_pedido_q2p', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_sb_baixa_pedido_q2p ON stockbridge.baixa_pedido_q2p;
CREATE TRIGGER trg_audit_sb_baixa_pedido_q2p
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.baixa_pedido_q2p
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_baixa_pedido_q2p();

-- ── 4. Backfill: entradas de importação já concluídas viram 'pendente' ────────
-- Critério = o mesmo que o fluxo passa a usar: entrada_nf de importação da
-- ACXE com o ajuste dual concluído. O estado 'pendente' NÃO dispara nada por
-- si — só o script de backfill (ou o retry pelo painel) executa a baixa.
UPDATE stockbridge.movimentacao
SET baixa_pedido_q2p = 'pendente'
WHERE tipo_movimento = 'entrada_nf'
  AND subtipo = 'importacao'
  AND COALESCE(empresa, 'acxe') = 'acxe'
  AND ativo = true
  AND baixa_pedido_q2p IS NULL;
