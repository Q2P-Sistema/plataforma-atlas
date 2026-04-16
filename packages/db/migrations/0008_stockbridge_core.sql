-- Migration: 008 StockBridge Core
-- Creates stockbridge schema with 8 tables, indexes, audit triggers (Principio IV), and seeds
-- Audit log infrastructure (shared.audit_log) ja existe desde migration 0001

-- ── Schema ─────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS stockbridge;

-- ── Localidade ─────────────────────────────────────────────
CREATE TABLE stockbridge.localidade (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    codigo VARCHAR(50) NOT NULL UNIQUE,
    nome VARCHAR(255) NOT NULL,
    tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('proprio', 'tpl', 'porto_seco', 'virtual_transito', 'virtual_ajuste')),
    cnpj VARCHAR(50),
    cidade VARCHAR(100),
    ativo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_virtual_sem_cnpj CHECK (
        (tipo LIKE 'virtual_%' AND cnpj IS NULL)
        OR tipo NOT LIKE 'virtual_%'
    )
);
CREATE INDEX localidade_tipo_ativo_idx ON stockbridge.localidade (tipo, ativo);

-- ── Localidade Correlacao (ACXE ↔ Q2P) ─────────────────────
CREATE TABLE stockbridge.localidade_correlacao (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    localidade_id UUID NOT NULL UNIQUE REFERENCES stockbridge.localidade(id) ON DELETE CASCADE,
    codigo_local_estoque_acxe BIGINT,
    codigo_local_estoque_q2p BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_pelo_menos_um_codigo CHECK (
        codigo_local_estoque_acxe IS NOT NULL OR codigo_local_estoque_q2p IS NOT NULL
    )
);
CREATE UNIQUE INDEX localidade_corr_acxe_idx ON stockbridge.localidade_correlacao (codigo_local_estoque_acxe) WHERE codigo_local_estoque_acxe IS NOT NULL;
CREATE UNIQUE INDEX localidade_corr_q2p_idx ON stockbridge.localidade_correlacao (codigo_local_estoque_q2p) WHERE codigo_local_estoque_q2p IS NOT NULL;

-- ── Lote ───────────────────────────────────────────────────
CREATE TABLE stockbridge.lote (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    codigo VARCHAR(50) NOT NULL UNIQUE,
    produto_codigo_acxe BIGINT NOT NULL,
    produto_codigo_q2p BIGINT,
    fornecedor_nome VARCHAR(255) NOT NULL,
    pais_origem VARCHAR(100),
    quantidade_fisica NUMERIC(12,3) NOT NULL DEFAULT 0,
    quantidade_fiscal NUMERIC(12,3) NOT NULL DEFAULT 0,
    custo_usd NUMERIC(12,2),
    status VARCHAR(30) NOT NULL DEFAULT 'provisorio' CHECK (status IN (
        'reconciliado', 'divergencia', 'transito',
        'provisorio', 'aguardando_aprovacao', 'rejeitado'
    )),
    estagio_transito VARCHAR(30) CHECK (estagio_transito IN (
        'transito_intl', 'porto_dta', 'transito_interno', 'reservado'
    )),
    localidade_id UUID REFERENCES stockbridge.localidade(id),
    cnpj VARCHAR(50) NOT NULL,
    nota_fiscal VARCHAR(50),
    manual BOOLEAN NOT NULL DEFAULT false,
    di VARCHAR(50),
    dta VARCHAR(50),
    dt_entrada DATE NOT NULL,
    dt_prev_chegada DATE,
    ativo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lote_produto_status_idx ON stockbridge.lote (produto_codigo_acxe, status, ativo);
CREATE INDEX lote_cnpj_localidade_idx ON stockbridge.lote (cnpj, localidade_id);
CREATE INDEX lote_nota_fiscal_idx ON stockbridge.lote (nota_fiscal);
CREATE INDEX lote_estagio_idx ON stockbridge.lote (estagio_transito) WHERE estagio_transito IS NOT NULL;

-- ── Movimentacao (modelo pareado ACXE + Q2P) ───────────────
-- Clarificacao Q8: uma linha por NF com ambos os lados do dual-CNPJ
CREATE TABLE stockbridge.movimentacao (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    nota_fiscal VARCHAR(50) NOT NULL,
    tipo_movimento VARCHAR(30) NOT NULL CHECK (tipo_movimento IN (
        'entrada_nf', 'entrada_manual', 'saida_automatica',
        'saida_manual', 'ajuste', 'regularizacao_fiscal', 'debito_cruzado'
    )),
    subtipo VARCHAR(50),
    lote_id UUID REFERENCES stockbridge.lote(id),
    quantidade_t NUMERIC(12,3) NOT NULL,
    mv_acxe SMALLINT,
    dt_acxe TIMESTAMPTZ,
    id_movest_acxe VARCHAR(100),
    id_ajuste_acxe VARCHAR(100),
    id_user_acxe UUID REFERENCES atlas.users(id),
    mv_q2p SMALLINT,
    dt_q2p TIMESTAMPTZ,
    id_movest_q2p VARCHAR(100),
    id_ajuste_q2p VARCHAR(100),
    id_user_q2p UUID REFERENCES atlas.users(id),
    observacoes TEXT,
    ativo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotencia: uma NF OMIE (entrada_nf ou saida_automatica) so pode ser processada uma vez
CREATE UNIQUE INDEX movimentacao_nf_idempotencia_idx
    ON stockbridge.movimentacao (nota_fiscal, tipo_movimento)
    WHERE tipo_movimento IN ('entrada_nf', 'saida_automatica');
CREATE INDEX movimentacao_tipo_ativo_idx ON stockbridge.movimentacao (tipo_movimento, ativo);
CREATE INDEX movimentacao_created_idx ON stockbridge.movimentacao (created_at DESC);
CREATE INDEX movimentacao_lote_idx ON stockbridge.movimentacao (lote_id);

-- ── Aprovacao (fluxo hierarquico) ──────────────────────────
CREATE TABLE stockbridge.aprovacao (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    lote_id UUID NOT NULL REFERENCES stockbridge.lote(id) ON DELETE CASCADE,
    precisa_nivel VARCHAR(20) NOT NULL CHECK (precisa_nivel IN ('gestor', 'diretor')),
    tipo_aprovacao VARCHAR(30) NOT NULL CHECK (tipo_aprovacao IN (
        'recebimento_divergencia', 'entrada_manual',
        'saida_transf_intra', 'saida_comodato', 'saida_amostra',
        'saida_descarte', 'saida_quebra', 'ajuste_inventario'
    )),
    quantidade_prevista_t NUMERIC(12,3),
    quantidade_recebida_t NUMERIC(12,3),
    tipo_divergencia VARCHAR(30) CHECK (tipo_divergencia IN ('faltando', 'varredura', 'cruzada')),
    observacoes TEXT,
    lancado_por UUID NOT NULL REFERENCES atlas.users(id),
    lancado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    aprovado_por UUID REFERENCES atlas.users(id),
    aprovado_em TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovada', 'rejeitada')),
    rejeicao_motivo TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX aprovacao_status_nivel_idx ON stockbridge.aprovacao (status, precisa_nivel);
CREATE INDEX aprovacao_lote_idx ON stockbridge.aprovacao (lote_id);
CREATE INDEX aprovacao_lancado_por_idx ON stockbridge.aprovacao (lancado_por);

-- ── Divergencia (fisico vs fiscal, incluindo cruzada) ──────
CREATE TABLE stockbridge.divergencia (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    lote_id UUID REFERENCES stockbridge.lote(id),
    movimentacao_id UUID REFERENCES stockbridge.movimentacao(id),
    tipo VARCHAR(30) NOT NULL CHECK (tipo IN ('faltando', 'varredura', 'cruzada', 'fiscal_pendente')),
    quantidade_delta_t NUMERIC(12,3) NOT NULL,
    valor_usd NUMERIC(12,2),
    status VARCHAR(20) NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'regularizada', 'descartada')),
    regularizada_em TIMESTAMPTZ,
    regularizada_por_movimentacao_id UUID REFERENCES stockbridge.movimentacao(id),
    observacoes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX divergencia_tipo_status_idx ON stockbridge.divergencia (tipo, status);
CREATE INDEX divergencia_lote_idx ON stockbridge.divergencia (lote_id);
CREATE INDEX divergencia_mov_idx ON stockbridge.divergencia (movimentacao_id);

-- ── Fornecedor Exclusao (filtro de fila compra nacional) ──
CREATE TABLE stockbridge.fornecedor_exclusao (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    fornecedor_cnpj VARCHAR(50) NOT NULL,
    fornecedor_nome VARCHAR(255) NOT NULL,
    motivo TEXT,
    excluido_por UUID NOT NULL REFERENCES atlas.users(id),
    excluido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    reincluido_em TIMESTAMPTZ,
    reincluido_por UUID REFERENCES atlas.users(id)
);
CREATE UNIQUE INDEX fornecedor_exclusao_ativa_idx
    ON stockbridge.fornecedor_exclusao (fornecedor_cnpj)
    WHERE reincluido_em IS NULL;

-- ── Config Produto (consumo medio, lead time, familia) ─────
CREATE TABLE stockbridge.config_produto (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    produto_codigo_acxe BIGINT NOT NULL UNIQUE,
    consumo_medio_diario_t NUMERIC(10,3),
    lead_time_dias INTEGER,
    familia_categoria VARCHAR(50),
    incluir_em_metricas BOOLEAN NOT NULL DEFAULT true,
    updated_by UUID REFERENCES atlas.users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Auto-update updated_at trigger ─────────────────────────
CREATE OR REPLACE FUNCTION stockbridge.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sb_localidade_updated_at
    BEFORE UPDATE ON stockbridge.localidade
    FOR EACH ROW EXECUTE FUNCTION stockbridge.set_updated_at();

CREATE TRIGGER trg_sb_lote_updated_at
    BEFORE UPDATE ON stockbridge.lote
    FOR EACH ROW EXECUTE FUNCTION stockbridge.set_updated_at();

CREATE TRIGGER trg_sb_movimentacao_updated_at
    BEFORE UPDATE ON stockbridge.movimentacao
    FOR EACH ROW EXECUTE FUNCTION stockbridge.set_updated_at();

CREATE TRIGGER trg_sb_config_produto_updated_at
    BEFORE UPDATE ON stockbridge.config_produto
    FOR EACH ROW EXECUTE FUNCTION stockbridge.set_updated_at();

-- ── Audit Log Triggers (Principio IV) ──────────────────────
-- Padrao: funcao dedicada por tabela (como hedge e breakingpoint)
-- Todas as 8 tabelas sao auditaveis

CREATE OR REPLACE FUNCTION stockbridge.audit_localidade()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'localidade', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_sb_localidade
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.localidade
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_localidade();

CREATE OR REPLACE FUNCTION stockbridge.audit_localidade_correlacao()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'localidade_correlacao', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_sb_localidade_correlacao
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.localidade_correlacao
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_localidade_correlacao();

CREATE OR REPLACE FUNCTION stockbridge.audit_lote()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'lote', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_sb_lote
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.lote
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_lote();

CREATE OR REPLACE FUNCTION stockbridge.audit_movimentacao()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'movimentacao', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_sb_movimentacao
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.movimentacao
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_movimentacao();

CREATE OR REPLACE FUNCTION stockbridge.audit_aprovacao()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'aprovacao', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_sb_aprovacao
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.aprovacao
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_aprovacao();

CREATE OR REPLACE FUNCTION stockbridge.audit_divergencia()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'divergencia', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_sb_divergencia
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.divergencia
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_divergencia();

CREATE OR REPLACE FUNCTION stockbridge.audit_fornecedor_exclusao()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'fornecedor_exclusao', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_sb_fornecedor_exclusao
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.fornecedor_exclusao
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_fornecedor_exclusao();

CREATE OR REPLACE FUNCTION stockbridge.audit_config_produto()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'config_produto', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_sb_config_produto
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.config_produto
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_config_produto();

-- ── Seeds: Localidades reais (extraidas do MySQL legado) ───
INSERT INTO stockbridge.localidade (codigo, nome, tipo, cnpj, cidade, ativo) VALUES
    ('11.1',   'SANTO ANDRE (antigo Galpao 5)', 'proprio', 'Acxe Matriz', 'Santo Andre', true),
    ('12.1',   'SANTO ANDRE (antigo Galpao 4)', 'proprio', 'Acxe Matriz', 'Santo Andre', true),
    ('21.1',   'EXTREMA',                       'proprio', 'Acxe Matriz', 'Extrema',     true),
    ('31.1',   'ARMAZEM EXTERNO (ATN)',         'tpl',     NULL,          'Guarulhos',   true),
    ('90.0.2', 'TRANSITO',                      'virtual_transito', NULL, NULL,          true),
    ('10.0.3', 'VARREDURA',                     'virtual_ajuste',   NULL, NULL,          true)
ON CONFLICT (codigo) DO NOTHING;

-- Seeds: Correlacao ACXE ↔ Q2P (codigos OMIE reais do legado)
-- Precisa vincular a localidade_id apos seed anterior
DO $$
DECLARE
    v_id_11_1 UUID; v_id_12_1 UUID; v_id_21_1 UUID;
    v_id_31_1 UUID; v_id_trans UUID; v_id_varr UUID;
BEGIN
    SELECT id INTO v_id_11_1 FROM stockbridge.localidade WHERE codigo = '11.1';
    SELECT id INTO v_id_12_1 FROM stockbridge.localidade WHERE codigo = '12.1';
    SELECT id INTO v_id_21_1 FROM stockbridge.localidade WHERE codigo = '21.1';
    SELECT id INTO v_id_31_1 FROM stockbridge.localidade WHERE codigo = '31.1';
    SELECT id INTO v_id_trans FROM stockbridge.localidade WHERE codigo = '90.0.2';
    SELECT id INTO v_id_varr FROM stockbridge.localidade WHERE codigo = '10.0.3';

    INSERT INTO stockbridge.localidade_correlacao (localidade_id, codigo_local_estoque_acxe, codigo_local_estoque_q2p) VALUES
        (v_id_11_1,  4498926337, 8115873874),
        (v_id_12_1,  4498926061, 8115873724),
        (v_id_21_1,  4004166399, 7960459966),
        (v_id_31_1,  4776458297, 8042180936),
        (v_id_trans, 4503767789, 8429029971),
        (v_id_varr,  4506526722, NULL)
    ON CONFLICT DO NOTHING;
END $$;
