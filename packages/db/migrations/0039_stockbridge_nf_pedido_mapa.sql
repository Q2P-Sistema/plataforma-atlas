-- Migration: 0039 — StockBridge: tabelas de mapeamento NF mãe/filhote
--
-- Contexto:
--   O card "Posição Fiscal Pendente de Importação" do cockpit usa CFOP 3.xxx
--   como proxy para detectar importações pendentes. Isso nunca fecha o gap:
--   NF mãe (cobre o pedido completo) não é marcada como recebida no OMIE;
--   as NF filhotes (uma por container/caminhão) são as que geram estoque e
--   recebem n_id_receb > 0 quando chegam ao galpão.
--
--   Sem o mapeamento mãe→filhotes, o número fiscal fica permanentemente inflado.
--
-- Solução:
--   Duas tabelas normalizadas:
--   - nf_pedido_mapa: um row por pedido de importação ativo, com a NF mãe.
--   - nf_pedido_filhote: N rows por pedido (1–12 containers).
--
--   O cockpit passa a usar estas tabelas como Parte A (pedidos COM mapa) e
--   mantém a lógica CFOP 3.xxx como Parte B (fallback para pedidos SEM mapa),
--   garantindo retrocompatibilidade durante a transição.
--
-- Fonte: specs/010-fiscal-nf-mapa/plan.md | ACXEGDP-159
-- Confirmação Comex (10/06/2026): todo pedido sempre emite ≥1 filhote;
--   NF mãe nunca tem n_id_receb > 0 (flag "não gera estoque", estoque 21.1 Extrema).

-- ── 1. Tabela principal: um row por pedido ativo ──────────────────────────────
CREATE TABLE IF NOT EXISTS stockbridge.nf_pedido_mapa (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_acxe_omie varchar(50) NOT NULL,   -- cnumero em tbl_pedidosCompras_ACXE / número FUP
    nf_mae           varchar(50) NOT NULL,   -- NF que cobre o pedido completo (21.1 Extrema, não gera estoque)
    ativo            boolean     NOT NULL DEFAULT true,
    importado_em     timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- UNIQUE parcial: apenas um mapa ativo por pedido (last-write-wins via upsert)
CREATE UNIQUE INDEX IF NOT EXISTS nf_pedido_mapa_pedido_idx
    ON stockbridge.nf_pedido_mapa (pedido_acxe_omie) WHERE ativo = true;

-- Lookup reverso: "qual pedido está associado a esta NF mãe?"
CREATE INDEX IF NOT EXISTS nf_pedido_mapa_nf_mae_idx
    ON stockbridge.nf_pedido_mapa (nf_mae);

-- ── 2. Tabela de filhotes: N rows por pedido (1-12 containers) ───────────────
CREATE TABLE IF NOT EXISTS stockbridge.nf_pedido_filhote (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    mapa_id    uuid        NOT NULL REFERENCES stockbridge.nf_pedido_mapa(id),
    nf_filhote varchar(50) NOT NULL,   -- NF por container (90.0.2 TRANSITO, gera estoque)
    posicao    smallint    NOT NULL,   -- 1–12, coluna da planilha FUP (NF Filhote 1..12)
    ativo      boolean     NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- JOIN eficiente mapa→filhotes
CREATE INDEX IF NOT EXISTS nf_pedido_filhote_mapa_idx
    ON stockbridge.nf_pedido_filhote (mapa_id);

-- Lookup reverso: "esta NF filhote já está em algum pedido ativo?"
CREATE INDEX IF NOT EXISTS nf_pedido_filhote_nf_idx
    ON stockbridge.nf_pedido_filhote (nf_filhote);

-- ── 3. Trigger de auditoria — nf_pedido_mapa (Princípio IV) ──────────────────
CREATE OR REPLACE FUNCTION stockbridge.audit_nf_pedido_mapa()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'nf_pedido_mapa', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_sb_nf_pedido_mapa ON stockbridge.nf_pedido_mapa;
CREATE TRIGGER trg_audit_sb_nf_pedido_mapa
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.nf_pedido_mapa
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_nf_pedido_mapa();

-- ── 4. Trigger de auditoria — nf_pedido_filhote (Princípio IV) ───────────────
CREATE OR REPLACE FUNCTION stockbridge.audit_nf_pedido_filhote()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'nf_pedido_filhote', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_sb_nf_pedido_filhote ON stockbridge.nf_pedido_filhote;
CREATE TRIGGER trg_audit_sb_nf_pedido_filhote
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.nf_pedido_filhote
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_nf_pedido_filhote();

COMMENT ON TABLE stockbridge.nf_pedido_mapa IS
  'Mapeamento pedido-de-importação → NF mãe. Um registro ativo por pedido. Alimentado pelo workflow FUP n8n ou manualmente pelo gestor via API. Usado pelo cockpit para calcular posição fiscal pendente de importação. Vide ACXEGDP-159.';

COMMENT ON TABLE stockbridge.nf_pedido_filhote IS
  'NF filhotes (uma por container/caminhão) de cada pedido do mapa. n_id_receb lido ao vivo de tbl_nf_header_ACXE — não armazenado aqui. Soft-delete em cada upsert do pedido pai.';
