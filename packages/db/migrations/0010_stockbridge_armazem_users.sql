-- Migration: 010 StockBridge — Armazem_id em atlas.users
-- Adiciona vinculo operador → localidade (Clarificacao Q2 da spec: operador fixo em um armazem)
-- Idempotente: usa ADD COLUMN IF NOT EXISTS.
-- Depende de 0008_stockbridge_core.sql (tabela stockbridge.localidade)

ALTER TABLE atlas.users
    ADD COLUMN IF NOT EXISTS armazem_id UUID
    REFERENCES stockbridge.localidade(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_armazem_id_idx ON atlas.users (armazem_id) WHERE armazem_id IS NOT NULL;

-- A atualizacao da trigger de audit (atlas.audit_users) ja captura mudancas em todas as colunas
-- via to_jsonb(NEW), entao nao precisa de alteracao.

COMMENT ON COLUMN atlas.users.armazem_id IS 'FK para stockbridge.localidade. Somente operadores precisam — gestor/diretor passam livres.';
