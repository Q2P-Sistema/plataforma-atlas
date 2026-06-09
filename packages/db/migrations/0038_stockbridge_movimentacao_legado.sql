-- Migration: 0038 — StockBridge: tabela de histórico do legado MySQL
--
-- Antes:
--   O histórico de recebimentos do sistema PHP legado (MySQL `tb_movimentacao`,
--   ~731 linhas) não tinha onde morar no Atlas. A `stockbridge.movimentacao`
--   tem o CHECK `movimentacao_chk_lote_ou_sku` (exige lote_id OU produto+galpão+
--   empresa) e o índice UNIQUE parcial `(nota_fiscal, tipo_movimento)` para
--   entrada_nf ativa — ambos incompatíveis com as linhas do legado, que são
--   recibos dual-CNPJ puros, SEM produto/quantidade/galpão e podendo repetir NF.
--
-- Agora:
--   Tabela dedicada `stockbridge.movimentacao_legado` que espelha 1:1 o
--   `tb_movimentacao` do MySQL. Importada pelo script one-shot
--   `modules/stockbridge/src/scripts/migrate-from-mysql.ts`.
--
-- Porque:
--   Esses registros são histórico FECHADO — servem só para AUDITORIA e
--   IDEMPOTÊNCIA ("não reprocessar uma NF que o legado já processou"). NÃO
--   afetam saldo (o saldo desses recebimentos já está consolidado no OMIE).
--   Recriá-los como `lote`/`movimentacao` ricos duplicaria o estoque que o OMIE
--   já reflete (mesmo risco que derrubou o rastreamento de trânsito por NF) e
--   esbarraria no índice 1-por-NF para as ~150 NFs multi-item. A tabela
--   dedicada preserva o dado fielmente, sem nenhum desses riscos.
--
-- Idempotência do import: UNIQUE(id_legado) = PK original do MySQL
--   (tb_movimentacao.id_movimentacao). Re-rodar o script faz ON CONFLICT DO
--   NOTHING — não duplica.
--
-- Ver specs/007-stockbridge-module/research.md seção 6 (migração MySQL→PG).

-- ── 1. Tabela ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stockbridge.movimentacao_legado (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    id_legado       integer     NOT NULL,                 -- tb_movimentacao.id_movimentacao (MySQL)
    nota_fiscal     varchar(50) NOT NULL,                 -- NF zero-padded (igual ao OMIE n_nf)
    -- lado ACXE
    mv_acxe         smallint,
    dt_acxe         timestamptz,
    id_movest_acxe  varchar(100),
    id_ajuste_acxe  varchar(100),
    id_user_acxe    uuid REFERENCES atlas.users(id),
    -- lado Q2P
    mv_q2p          smallint,
    dt_q2p          timestamptz,
    id_movest_q2p   varchar(100),
    id_ajuste_q2p   varchar(100),
    id_user_q2p     uuid REFERENCES atlas.users(id),
    -- controle
    ativo           boolean     NOT NULL DEFAULT true,    -- soft delete do legado (tb_movimentacao.ativo)
    migrado_em      timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Índices ───────────────────────────────────────────────────────────────
-- UNIQUE(id_legado): idempotência do import one-shot (re-run não duplica).
CREATE UNIQUE INDEX IF NOT EXISTS movimentacao_legado_id_legado_idx
    ON stockbridge.movimentacao_legado (id_legado);
-- btree(nota_fiscal): lookup de idempotência "NF já processada no legado?".
CREATE INDEX IF NOT EXISTS movimentacao_legado_nota_fiscal_idx
    ON stockbridge.movimentacao_legado (nota_fiscal);

-- ── 3. Trigger de auditoria (Princípio IV — obrigatório em stockbridge.*) ──────
CREATE OR REPLACE FUNCTION stockbridge.audit_movimentacao_legado()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'movimentacao_legado', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_sb_movimentacao_legado ON stockbridge.movimentacao_legado;
CREATE TRIGGER trg_audit_sb_movimentacao_legado
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.movimentacao_legado
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_movimentacao_legado();

COMMENT ON TABLE stockbridge.movimentacao_legado IS
  'Histórico 1:1 do tb_movimentacao do MySQL legado (recibos dual-CNPJ de NF). Audit + idempotência apenas — não afeta saldo (OMIE já consolidou). Importado por migrate-from-mysql.ts. UNIQUE(id_legado) garante import idempotente.';
