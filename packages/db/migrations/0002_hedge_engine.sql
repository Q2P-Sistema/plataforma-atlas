-- Migration: 002 Hedge Engine
-- Creates hedge schema with 10 tables, indexes, audit triggers, shared view, and config seed

-- ── Schema ─────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS hedge;

-- ── Bucket Mensal ──────────────────────────────────────────
CREATE TABLE hedge.bucket_mensal (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    mes_ref DATE NOT NULL,
    empresa VARCHAR(10) NOT NULL CHECK (empresa IN ('acxe', 'q2p')),
    pagar_usd NUMERIC(15,2) NOT NULL DEFAULT 0,
    ndf_usd NUMERIC(15,2) NOT NULL DEFAULT 0,
    cobertura_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL CHECK (status IN ('ok', 'sub_hedged', 'over_hedged')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bucket_mes_empresa_idx ON hedge.bucket_mensal (mes_ref, empresa);
CREATE INDEX bucket_status_idx ON hedge.bucket_mensal (status);

-- ── NDF Registro ───────────────────────────────────────────
CREATE TABLE hedge.ndf_registro (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tipo VARCHAR(10) NOT NULL CHECK (tipo IN ('ndf', 'trava', 'acc')),
    notional_usd NUMERIC(15,2) NOT NULL,
    taxa_ndf NUMERIC(8,4) NOT NULL,
    ptax_contratacao NUMERIC(8,4) NOT NULL,
    prazo_dias INTEGER NOT NULL,
    data_contratacao DATE NOT NULL,
    data_vencimento DATE NOT NULL,
    custo_brl NUMERIC(15,2) NOT NULL,
    resultado_brl NUMERIC(15,2),
    ptax_liquidacao NUMERIC(8,4),
    status VARCHAR(20) NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'ativo', 'liquidado', 'cancelado')),
    bucket_id UUID REFERENCES hedge.bucket_mensal(id),
    empresa VARCHAR(10) NOT NULL,
    observacao TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ndf_status_idx ON hedge.ndf_registro (status);
CREATE INDEX ndf_bucket_idx ON hedge.ndf_registro (bucket_id);
CREATE INDEX ndf_empresa_idx ON hedge.ndf_registro (empresa);
CREATE INDEX ndf_vencimento_idx ON hedge.ndf_registro (data_vencimento);

-- ── Titulos a Pagar ────────────────────────────────────────
CREATE TABLE hedge.titulos_pagar (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    omie_id BIGINT NOT NULL UNIQUE,
    valor_usd NUMERIC(15,2) NOT NULL,
    vencimento DATE NOT NULL,
    bucket_mes DATE NOT NULL,
    ptax_nf NUMERIC(8,4),
    status VARCHAR(20) NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'liquidado', 'arquivado')),
    empresa VARCHAR(10) NOT NULL,
    fornecedor VARCHAR(255),
    numero_documento VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX titulos_bucket_mes_idx ON hedge.titulos_pagar (bucket_mes);
CREATE INDEX titulos_status_idx ON hedge.titulos_pagar (status);
CREATE INDEX titulos_empresa_idx ON hedge.titulos_pagar (empresa);
CREATE INDEX titulos_vencimento_idx ON hedge.titulos_pagar (vencimento);

-- ── PTAX Historico ─────────────────────────────────────────
CREATE TABLE hedge.ptax_historico (
    data_ref DATE PRIMARY KEY,
    venda NUMERIC(8,4) NOT NULL,
    compra NUMERIC(8,4) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── NDF Taxas de Mercado ───────────────────────────────────
CREATE TABLE hedge.ndf_taxas (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    data_ref DATE NOT NULL,
    prazo_dias INTEGER NOT NULL CHECK (prazo_dias IN (30, 60, 90, 120, 180)),
    taxa NUMERIC(8,4) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (data_ref, prazo_dias)
);

-- ── Posicao Snapshot ───────────────────────────────────────
CREATE TABLE hedge.posicao_snapshot (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    data_ref DATE NOT NULL UNIQUE,
    exposure_usd NUMERIC(15,2) NOT NULL,
    ndf_ativo_usd NUMERIC(15,2) NOT NULL,
    gap_usd NUMERIC(15,2) NOT NULL,
    cobertura_pct NUMERIC(5,2) NOT NULL,
    ptax_ref NUMERIC(8,4) NOT NULL,
    raw_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Estoque Snapshot ───────────────────────────────────────
CREATE TABLE hedge.estoque_snapshot (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    data_ref DATE NOT NULL,
    empresa VARCHAR(10) NOT NULL,
    localidade VARCHAR(100) NOT NULL,
    valor_brl NUMERIC(15,2) NOT NULL,
    custo_usd_estimado NUMERIC(15,2) NOT NULL,
    pago BOOLEAN NOT NULL DEFAULT false,
    fase VARCHAR(30) CHECK (fase IN ('maritimo', 'alfandega', 'deposito')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX estoque_data_empresa_idx ON hedge.estoque_snapshot (data_ref, empresa);

-- ── Alerta ─────────────────────────────────────────────────
CREATE TABLE hedge.alerta (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tipo VARCHAR(50) NOT NULL,
    severidade VARCHAR(20) NOT NULL CHECK (severidade IN ('critico', 'alta', 'media')),
    mensagem TEXT NOT NULL,
    bucket_id UUID REFERENCES hedge.bucket_mensal(id),
    lido BOOLEAN NOT NULL DEFAULT false,
    resolvido BOOLEAN NOT NULL DEFAULT false,
    resolvido_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX alerta_severidade_idx ON hedge.alerta (severidade);
CREATE INDEX alerta_lido_idx ON hedge.alerta (lido);

-- ── Config Motor ───────────────────────────────────────────
CREATE TABLE hedge.config_motor (
    chave VARCHAR(100) PRIMARY KEY,
    valor JSONB NOT NULL,
    descricao TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Sync Log ───────────────────────────────────────────────
CREATE TABLE hedge.sync_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    fonte VARCHAR(50) NOT NULL,
    operacao VARCHAR(100) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('sucesso', 'erro')),
    registros INTEGER DEFAULT 0,
    duracao_ms INTEGER,
    erro TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sync_log_fonte_idx ON hedge.sync_log (fonte);
CREATE INDEX sync_log_created_idx ON hedge.sync_log (created_at);

-- ── Auto-update updated_at trigger ─────────────────────────
CREATE OR REPLACE FUNCTION hedge.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bucket_mensal_updated_at
    BEFORE UPDATE ON hedge.bucket_mensal
    FOR EACH ROW EXECUTE FUNCTION hedge.set_updated_at();

CREATE TRIGGER trg_ndf_registro_updated_at
    BEFORE UPDATE ON hedge.ndf_registro
    FOR EACH ROW EXECUTE FUNCTION hedge.set_updated_at();

CREATE TRIGGER trg_titulos_pagar_updated_at
    BEFORE UPDATE ON hedge.titulos_pagar
    FOR EACH ROW EXECUTE FUNCTION hedge.set_updated_at();

CREATE TRIGGER trg_config_motor_updated_at
    BEFORE UPDATE ON hedge.config_motor
    FOR EACH ROW EXECUTE FUNCTION hedge.set_updated_at();

-- ── Audit Log Triggers (Principio IV) ──────────────────────
-- Tabelas criticas: ndf_registro, titulos_pagar, config_motor, alerta

CREATE OR REPLACE FUNCTION hedge.audit_ndf_registro()
RETURNS TRIGGER AS $$
DECLARE
    old_vals JSONB := NULL;
    new_vals JSONB := NULL;
BEGIN
    IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        old_vals := to_jsonb(OLD);
    END IF;
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        new_vals := to_jsonb(NEW);
    END IF;

    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('hedge', 'ndf_registro', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_ndf_registro
    AFTER INSERT OR UPDATE OR DELETE ON hedge.ndf_registro
    FOR EACH ROW EXECUTE FUNCTION hedge.audit_ndf_registro();

CREATE OR REPLACE FUNCTION hedge.audit_titulos_pagar()
RETURNS TRIGGER AS $$
DECLARE
    old_vals JSONB := NULL;
    new_vals JSONB := NULL;
BEGIN
    IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        old_vals := to_jsonb(OLD);
    END IF;
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        new_vals := to_jsonb(NEW);
    END IF;

    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('hedge', 'titulos_pagar', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_titulos_pagar
    AFTER INSERT OR UPDATE OR DELETE ON hedge.titulos_pagar
    FOR EACH ROW EXECUTE FUNCTION hedge.audit_titulos_pagar();

CREATE OR REPLACE FUNCTION hedge.audit_config_motor()
RETURNS TRIGGER AS $$
DECLARE
    old_vals JSONB := NULL;
    new_vals JSONB := NULL;
BEGIN
    IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        old_vals := to_jsonb(OLD);
    END IF;
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        new_vals := to_jsonb(NEW);
    END IF;

    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('hedge', 'config_motor', TG_OP, COALESCE(NEW.chave, OLD.chave), old_vals, new_vals);

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_config_motor
    AFTER INSERT OR UPDATE OR DELETE ON hedge.config_motor
    FOR EACH ROW EXECUTE FUNCTION hedge.audit_config_motor();

CREATE OR REPLACE FUNCTION hedge.audit_alerta()
RETURNS TRIGGER AS $$
DECLARE
    old_vals JSONB := NULL;
    new_vals JSONB := NULL;
BEGIN
    IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        old_vals := to_jsonb(OLD);
    END IF;
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        new_vals := to_jsonb(NEW);
    END IF;

    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('hedge', 'alerta', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_alerta
    AFTER INSERT OR UPDATE OR DELETE ON hedge.alerta
    FOR EACH ROW EXECUTE FUNCTION hedge.audit_alerta();

-- ── Shared View (Principio I) ──────────────────────────────
CREATE OR REPLACE VIEW shared.vw_hedge_posicao AS
SELECT data_ref, exposure_usd, ndf_ativo_usd, gap_usd, cobertura_pct, ptax_ref
FROM hedge.posicao_snapshot
ORDER BY data_ref DESC;

-- ── Config Motor Seed ──────────────────────────────────────
INSERT INTO hedge.config_motor (chave, valor, descricao) VALUES
    ('lambda_default', '0.5', 'Lambda default do Motor MV (0.0 a 1.0)'),
    ('threshold_critico', '1000000', 'Gap USD para alerta critico'),
    ('threshold_alta', '500000', 'Gap USD para alerta alta'),
    ('cobertura_base_pct', '60', 'Cobertura base L1 (%)'),
    ('cobertura_bump_pct', '68', 'Cobertura L1 com bump de estoque (%)'),
    ('estoque_bump_threshold', '0.5', 'Threshold de estoque nao-pago para bump L1')
ON CONFLICT (chave) DO NOTHING;
