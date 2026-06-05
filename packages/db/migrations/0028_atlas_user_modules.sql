-- =============================================================================
-- Migration 0028: RBAC por modulo (atlas.user_modules)
-- Diretor sempre tem acesso a todos os modulos (bypass automatico, sem rows).
-- Operador e gestor precisam de grant explicito.
-- Acesso efetivo = (MODULE_*_ENABLED global) AND (role='diretor' OR existe grant).
-- =============================================================================

CREATE TABLE atlas.user_modules (
  user_id UUID NOT NULL REFERENCES atlas.users(id) ON DELETE CASCADE,
  module_key VARCHAR(40) NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by UUID REFERENCES atlas.users(id),
  PRIMARY KEY (user_id, module_key),
  CONSTRAINT user_modules_key_check CHECK (module_key IN (
    'hedge', 'stockbridge', 'breakingpoint',
    'clevel', 'comexinsight', 'comexflow', 'forecast'
  ))
);

CREATE INDEX user_modules_user_idx ON atlas.user_modules(user_id);
CREATE INDEX user_modules_key_idx ON atlas.user_modules(module_key);

-- =============================================================================
-- Audit trigger (mesma forma do atlas.users)
-- =============================================================================
CREATE OR REPLACE FUNCTION atlas.audit_user_modules()
RETURNS TRIGGER AS $$
DECLARE
  v_record_id TEXT;
  v_old JSONB;
  v_new JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_record_id := OLD.user_id::TEXT || ':' || OLD.module_key;
    v_old := to_jsonb(OLD);
    v_new := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_record_id := NEW.user_id::TEXT || ':' || NEW.module_key;
    v_old := NULL;
    v_new := to_jsonb(NEW);
  ELSE
    v_record_id := NEW.user_id::TEXT || ':' || NEW.module_key;
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
  END IF;

  INSERT INTO shared.audit_log (schema_name, table_name, operation, record_id, old_values, new_values)
  VALUES ('atlas', 'user_modules', TG_OP, v_record_id, v_old, v_new);

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_modules_audit
  AFTER INSERT OR UPDATE OR DELETE ON atlas.user_modules
  FOR EACH ROW
  EXECUTE FUNCTION atlas.audit_user_modules();

-- =============================================================================
-- Backfill: cada operador/gestor existente recebe grant pra todos os 7 modulos.
-- Preserva o comportamento atual (acesso global). Diretor nao precisa de rows.
-- granted_by = NULL sinaliza "backfill da migration", nao foi um diretor especifico.
-- =============================================================================
INSERT INTO atlas.user_modules (user_id, module_key, granted_by)
SELECT u.id, mk.key, NULL
FROM atlas.users u
CROSS JOIN (VALUES
  ('hedge'), ('stockbridge'), ('breakingpoint'),
  ('clevel'), ('comexinsight'), ('comexflow'), ('forecast')
) AS mk(key)
WHERE u.role IN ('operador', 'gestor')
  AND u.deleted_at IS NULL
ON CONFLICT (user_id, module_key) DO NOTHING;
