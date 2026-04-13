-- Migration: 004 Forecast Planner
-- Creates forecast schema with config, sazonalidade, and audit

-- ── Schema ─────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS forecast;

-- ── Config Sazonalidade ────────────────────────────────────
CREATE TABLE forecast.config_sazonalidade (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    familia_id VARCHAR(100) NOT NULL,
    mes INTEGER NOT NULL CHECK (mes >= 1 AND mes <= 12),
    fator_sugerido NUMERIC(4,2) NOT NULL DEFAULT 1.00,
    fator_usuario NUMERIC(4,2),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (familia_id, mes)
);

-- ── Config Forecast ────────────────────────────────────────
CREATE TABLE forecast.config_forecast (
    chave VARCHAR(100) PRIMARY KEY,
    valor JSONB NOT NULL,
    descricao TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Sazonalidade Log ───────────────────────────────────────
CREATE TABLE forecast.sazonalidade_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    familia_id VARCHAR(100) NOT NULL,
    mes INTEGER NOT NULL,
    fator_anterior NUMERIC(4,2),
    fator_novo NUMERIC(4,2) NOT NULL,
    usuario VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Auto-update updated_at ─────────────────────────────────
CREATE OR REPLACE FUNCTION forecast.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_config_saz_updated_at
    BEFORE UPDATE ON forecast.config_sazonalidade
    FOR EACH ROW EXECUTE FUNCTION forecast.set_updated_at();

CREATE TRIGGER trg_config_forecast_updated_at
    BEFORE UPDATE ON forecast.config_forecast
    FOR EACH ROW EXECUTE FUNCTION forecast.set_updated_at();

-- ── Audit Triggers (Principio IV) ──────────────────────────
CREATE OR REPLACE FUNCTION forecast.audit_config_forecast()
RETURNS TRIGGER AS $$
DECLARE
    old_vals JSONB := NULL;
    new_vals JSONB := NULL;
BEGIN
    IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('forecast', 'config_forecast', TG_OP, COALESCE(NEW.chave, OLD.chave), old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_config_forecast
    AFTER INSERT OR UPDATE OR DELETE ON forecast.config_forecast
    FOR EACH ROW EXECUTE FUNCTION forecast.audit_config_forecast();

-- ── Config Seeds ───────────────────────────────────────────
INSERT INTO forecast.config_forecast (chave, valor, descricao) VALUES
    ('variacao_anual_pct', '5', 'Crescimento anual de demanda (%)'),
    ('buffer_dias', '10', 'Buffer de seguranca alem do LT (dias)'),
    ('lead_time_local', '7', 'Lead time referencia para compra local emergencial (dias)'),
    ('moq_internacional', '25000', 'MOQ internacional (kg) — 25 toneladas'),
    ('moq_nacional', '12000', 'MOQ nacional (kg) — 12 toneladas'),
    ('horizonte_dias', '120', 'Horizonte do forecast (dias)'),
    ('horizonte_cobertura', '60', 'Dias alem do LT para cobrir na sugestao')
ON CONFLICT (chave) DO NOTHING;

-- ── Sazonalidade Default Seeds ─────────────────────────────
-- Indices padrao do legado — aplicados a todas as familias que nao tiverem override
-- Formato: fator 1.00 = demanda media, >1 = pico, <1 = baixa
INSERT INTO forecast.config_sazonalidade (familia_id, mes, fator_sugerido) VALUES
    ('_DEFAULT', 1, 0.88), ('_DEFAULT', 2, 0.90), ('_DEFAULT', 3, 0.96),
    ('_DEFAULT', 4, 1.02), ('_DEFAULT', 5, 1.06), ('_DEFAULT', 6, 1.08),
    ('_DEFAULT', 7, 1.08), ('_DEFAULT', 8, 1.07), ('_DEFAULT', 9, 1.02),
    ('_DEFAULT', 10, 0.98), ('_DEFAULT', 11, 0.96), ('_DEFAULT', 12, 0.91)
ON CONFLICT (familia_id, mes) DO NOTHING;
