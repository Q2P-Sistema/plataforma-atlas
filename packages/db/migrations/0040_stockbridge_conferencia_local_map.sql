-- Migration: 0040 — StockBridge: mapa De→Para de locais para Conferência de Estoque (ACXE × Q2P)
--
-- Contexto:
--   A "Conferência de Estoque" substitui a planilha Excel que cruza a posição
--   física de ACXE e Q2P por local/produto e classifica cada linha em Status Geral
--   (OK / Negativo / Divergente / Divergente e Negativo).
--
--   As tabelas OMIE public."tbl_locaisEstoques_ACXE"/"_Q2P" só têm
--   (codigo_local_estoque, codigo, descricao) — NÃO carregam a classificação
--   ESPELHADO/INDIVIDUAL nem o vínculo de empresa que a regra de negócio exige.
--   Essa classificação é mantida manualmente pelo usuário na planilha (aba
--   tbl_locaisEstoque, 23 linhas). Como é config de domínio do Atlas, vive em
--   stockbridge.* (Princípio I) e é auditada por trigger (Princípio IV).
--
--   Pares ESPELHADO (importados 11.x/12.x/21.1/31.1) compartilham o `codigo`
--   textual entre as duas empresas — é por ele que ACXE e Q2P se encontram na
--   mesma linha do comparativo.
--
-- Fonte: specs/011-conferencia-estoque/{plan,research,data-model}.md | ACXEGDP-198

-- ── 1. Tabela de configuração ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stockbridge.conferencia_local_map (
    id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo_local_estoque bigint       NOT NULL UNIQUE,   -- FK lógica → tbl_posicaoEstoque_*.codigo_local_estoque
    codigo               varchar(50)  NOT NULL,          -- código textual do local (ex. '11.1') — chave de agrupamento ACXE↔Q2P
    descricao            varchar(255) NOT NULL,          -- nome do local (ex. 'SANTO ANDRÉ (IMPORTADO)')
    nome_comparativo     varchar(255),                   -- rótulo amigável por empresa (ex. 'IMPORTADO 1 - ACXE')
    tipo                 varchar(20)  NOT NULL CHECK (tipo IN ('ESPELHADO', 'INDIVIDUAL')),
    empresa              varchar(20)  NOT NULL CHECK (empresa IN ('ACXE', 'Q2P')),
    ativo                boolean      NOT NULL DEFAULT true,
    updated_by           uuid         REFERENCES atlas.users(id),
    created_at           timestamptz  NOT NULL DEFAULT now(),
    updated_at           timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conferencia_local_map_codigo_idx
    ON stockbridge.conferencia_local_map (codigo);
CREATE INDEX IF NOT EXISTS conferencia_local_map_tipo_idx
    ON stockbridge.conferencia_local_map (tipo) WHERE ativo = true;

-- ── 2. Trigger de auditoria (Princípio IV) ───────────────────────────────────
CREATE OR REPLACE FUNCTION stockbridge.audit_conferencia_local_map()
RETURNS TRIGGER AS $$
DECLARE old_vals JSONB := NULL; new_vals JSONB := NULL;
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN old_vals := to_jsonb(OLD); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_vals := to_jsonb(NEW); END IF;
    INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
    VALUES ('stockbridge', 'conferencia_local_map', TG_OP, COALESCE(NEW.id, OLD.id)::TEXT, old_vals, new_vals);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_sb_conferencia_local_map ON stockbridge.conferencia_local_map;
CREATE TRIGGER trg_audit_sb_conferencia_local_map
    AFTER INSERT OR UPDATE OR DELETE ON stockbridge.conferencia_local_map
    FOR EACH ROW EXECUTE FUNCTION stockbridge.audit_conferencia_local_map();

COMMENT ON TABLE stockbridge.conferencia_local_map IS
  'Mapa De→Para de locais de estoque para a Conferência de Estoque ACXE×Q2P. Espelho da aba tbl_locaisEstoque da planilha. tipo=ESPELHADO indica par bilateral (mesmo `codigo` textual nas duas empresas); INDIVIDUAL = local de uma empresa só. Vide ACXEGDP-198 / specs/011-conferencia-estoque.';
COMMENT ON COLUMN stockbridge.conferencia_local_map.codigo IS
  'Código textual do local (ex. 11.1). Chave de agrupamento que une ACXE e Q2P na mesma linha do comparativo.';
COMMENT ON COLUMN stockbridge.conferencia_local_map.tipo IS
  'ESPELHADO: ACXE deve espelhar Q2P (divergência possível). INDIVIDUAL: nunca marcado como Divergente.';

-- ── 3. Seed — 23 locais (snapshot da planilha, 2026-06-22) ────────────────────
INSERT INTO stockbridge.conferencia_local_map
    (codigo_local_estoque, codigo, descricao, nome_comparativo, tipo, empresa)
VALUES
    (4506526722, '10.0.3',     'VARREDURA',                'VARREDURA STO ANDRÉ - ACXE', 'INDIVIDUAL', 'ACXE'),
    (8115873874, '11.1',       'SANTO ANDRÉ (IMPORTADO)',  'IMPORTADO 1 - Q2P',          'ESPELHADO',  'Q2P'),
    (4498926337, '11.1',       'SANTO ANDRÉ (IMPORTADO)',  'IMPORTADO 1 - ACXE',         'ESPELHADO',  'ACXE'),
    (8123584710, '11.2',       'SANTO ANDRÉ (NACIONAL)',   'NACIONAL 1 - Q2P',           'INDIVIDUAL', 'Q2P'),
    (8115873724, '12.1',       'SANTO ANDRÉ (IMPORTADO)',  'IMPORTADO 2 - Q2P',          'ESPELHADO',  'Q2P'),
    (4498926061, '12.1',       'SANTO ANDRÉ (IMPORTADO)',  'IMPORTADO 2 - ACXE',         'ESPELHADO',  'ACXE'),
    (8123584481, '12.2',       'SANTO ANDRÉ (NACIONAL)',   'NACIONAL 2 - Q2P',           'INDIVIDUAL', 'Q2P'),
    (4504071362, '20.0.3',     'VARREDURA',                'VARREDURA EXTREMA - ACXE',   'INDIVIDUAL', 'ACXE'),
    (4506855468, '20.0.4',     'FALTANDO',                 'FALTANDO - ACXE',            'INDIVIDUAL', 'ACXE'),
    (4530985781, '20.0.5',     'PROCESSO',                 'PROCESSO - ACXE',            'INDIVIDUAL', 'ACXE'),
    (4553878431, '20.0.6',     'CONSUMO',                  'CONSUMO - ACXE',             'INDIVIDUAL', 'ACXE'),
    (4553940398, '20.0.7',     'PRODUÇÃO',                 'PRODUÇÃO - ACXE',            'INDIVIDUAL', 'ACXE'),
    (7960459966, '21.1',       'EXTREMA',                  'EXTREMA - Q2P',              'ESPELHADO',  'Q2P'),
    (4004166399, '21.1',       'EXTREMA',                  'EXTREMA - ACXE',             'ESPELHADO',  'ACXE'),
    (8042180936, '31.1',       'ARMAZÉM EXTERNO',          'ARMAZÉM EXTERNO - Q2P',      'ESPELHADO',  'Q2P'),
    (4776458297, '31.1',       'ARMAZÉM EXTERNO',          'ARMAZÉM EXTERNO - ACXE',     'ESPELHADO',  'ACXE'),
    (8197553809, '90.0.1',     'TROCA',                    'TROCA - Q2P',                'INDIVIDUAL', 'Q2P'),
    (8429029971, '90.0.2',     'TRÂNSITO',                 'TRÂNSITO - Q2P',             'INDIVIDUAL', 'Q2P'),
    (4503767789, '90.0.2',     'TRÂNSITO',                 'TRÂNSITO - ACXE',            'INDIVIDUAL', 'ACXE'),
    (2994810198, 'INATIVO 01', 'INATIVO 01',               'Estoque Físico',             'INDIVIDUAL', 'Q2P'),
    (4452867179, 'INATIVO 01', 'INATIVO 01',               'Estoque Físico',             'INDIVIDUAL', 'ACXE'),
    (3031596403, 'INATIVO 02', 'INATIVO 02',               'EIM',                        'INDIVIDUAL', 'Q2P'),
    (8123584925, 'INATIVO 03', 'INATIVO 03',               'Q2P-SP-P3',                  'INDIVIDUAL', 'Q2P')
ON CONFLICT (codigo_local_estoque) DO NOTHING;
