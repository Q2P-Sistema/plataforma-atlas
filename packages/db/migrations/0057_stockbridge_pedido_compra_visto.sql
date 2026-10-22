-- Migration: 0057 — StockBridge: cache de pedidos de compra vistos (ACXEGDP-437)
--
-- Antes: a sugestão de pedido de compra (PC) da NF nacional (feature 017, 0056) lia
--   só a cópia local `tbl_pedidosCompras_<empresa>`, que é a lista de PCs PENDENTES
--   do OMIE (n8n Rev 1.5). O OMIE tira dessa lista o PC que já tem item associado a
--   um recebimento de NF-e, antes de o recebimento ser concluído: em 22/10/2026 o
--   PC 306 da Zaraplast sumiu da cópia entre a associação (13h) e a conclusão (15h)
--   da NF 60199, e voltou depois como recebido parcial. Na janela, o detalhe da NF
--   mostrava "Vínculo do OMIE" sem número, sem saldo e exigindo justificativa, e os
--   demais itens da mesma NF ficavam sem candidato (NF_SEM_PC), com o PC existindo
--   e com saldo.
-- Agora: `stockbridge.pedido_compra_visto` guarda a última versão de cada item de PC
--   que passou pela cópia (chave: empresa + item do PC). O Atlas a alimenta no cron
--   :05/:35 e ao abrir uma NF (no máximo a cada 5 min), gravando só o que mudou. A
--   sugestão usa o cache para os PCs que a cópia não trouxe (número, produto, saldo
--   da última vez em que o PC foi visto); a confirmação continua conferindo o saldo
--   ao vivo (FR-009).
-- Porque: o número e o saldo do PC vinculado precisam aparecer na tela, e os outros
--   itens da NF precisam do PC como candidato, mesmo com o PC fora da lista de
--   pendentes. O cache é derivado da cópia (sem valor de negócio próprio); a
--   auditoria (Princípio IV) registra só mudanças reais — o histórico do PC.
--
-- Ver specs/017-recebimento-nacional-com-pc/ (research D16; data-model §11).

-- ── 1. Cache de itens de PC vistos ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stockbridge.pedido_compra_visto (
    id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa           VARCHAR(4)    NOT NULL CHECK (empresa IN ('q2p', 'acxe')),
    n_cod_ped         BIGINT        NOT NULL,
    n_cod_item        BIGINT        NOT NULL,
    pc_numero         VARCHAR(50)   NOT NULL DEFAULT '',
    n_cod_for         BIGINT,
    produto_descricao VARCHAR(255),
    unidade           VARCHAR(10),
    qtde              NUMERIC(14,3),
    qtde_rec          NUMERIC(14,3),
    preco_unit        NUMERIC(14,6),
    etapa             VARCHAR(2),
    dt_previsao       DATE,
    valor_total_pc    NUMERIC(14,2),
    visto_em          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT pedido_compra_visto_item_uq UNIQUE (empresa, n_cod_item)
);

COMMENT ON TABLE stockbridge.pedido_compra_visto IS
  'Feature 017 (ACXEGDP-437): última versão de cada item de pedido de compra visto na cópia local tbl_pedidosCompras_<empresa>. O OMIE tira da lista de pendentes o PC com item associado a um recebimento aberto; a sugestão usa este cache para o que a cópia não traz. Derivado da cópia; a confirmação confere o saldo ao vivo.';
COMMENT ON COLUMN stockbridge.pedido_compra_visto.visto_em IS
  'Momento em que o Atlas viu estes dados na cópia pela última vez com alguma mudança (o upsert só grava o que mudou) — é o atualizadoEmMs da sugestão para PC fora da cópia.';

CREATE INDEX IF NOT EXISTS pedido_compra_visto_ped_idx ON stockbridge.pedido_compra_visto (empresa, n_cod_ped);
CREATE INDEX IF NOT EXISTS pedido_compra_visto_for_idx ON stockbridge.pedido_compra_visto (empresa, n_cod_for);

-- ── 2. Trigger de auditoria (Princípio IV) ────────────────────────────────────
-- O upsert só grava linha que mudou (IS DISTINCT FROM), então cada registro aqui é
-- uma mudança real do PC (saldo, etapa, preço) — não o ruído de cada sincronização.
CREATE OR REPLACE FUNCTION stockbridge.audit_pedido_compra_visto()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'pedido_compra_visto', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_sb_pedido_compra_visto ON stockbridge.pedido_compra_visto;
CREATE TRIGGER trg_audit_sb_pedido_compra_visto
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.pedido_compra_visto
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_pedido_compra_visto();
