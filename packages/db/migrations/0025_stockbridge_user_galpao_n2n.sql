-- Migration: 025 StockBridge — vinculacao N:N user × galpao + galpao em localidade
--
-- Contexto:
-- A vinculacao operador → armazem hoje e 1:1 via atlas.users.armazem_id (FK pra
-- stockbridge.localidade.id). Limita o operador a UM unico bucket OMIE (ex: 11.1
-- importado), enquanto o galpao fisico tem multiplos buckets (11.1 importado +
-- 11.2 nacional). Tambem nao permite atribuir N galpoes pra um mesmo usuario
-- (gestor de Sao Paulo cobrindo 11 + 12).
--
-- Solucao:
-- 1. Adiciona coluna `galpao` em stockbridge.localidade — agrupador fisico
--    derivado do prefixo numerico do codigo (11.1, 11.2 → '11'; 21.1 → '21').
-- 2. Cria tabela N:N stockbridge.user_galpao(user_id, galpao) — usuario pode
--    ter 0..N galpoes vinculados.
-- 3. Migra dados existentes de atlas.users.armazem_id pra user_galpao.
-- 4. Marca atlas.users.armazem_id como DEPRECATED via COMMENT (nao remove
--    agora pra nao quebrar codigo legado que possa ainda ler — remove em
--    migration futura quando todo o codigo migrar).
--
-- Caller esperado: service meu-estoque.service.ts le os galpoes do usuario
-- e filtra vw_posicaoEstoqueUnificadaFamilia por codigo_estoque LIKE 'galpao.%'.

-- ── 1. Coluna galpao em localidade ───────────────────────────────────────────
ALTER TABLE stockbridge.localidade
    ADD COLUMN IF NOT EXISTS galpao text;

COMMENT ON COLUMN stockbridge.localidade.galpao IS
  'Agrupador fisico (ex: "11" agrega "11.1" importado + "11.2" nacional). NULL para localidades virtuais.';

-- Popula galpao a partir do prefixo numerico do codigo
-- "11.1" → "11" | "21.1" → "21" | "90.0.2" → NULL (virtual)
UPDATE stockbridge.localidade
SET galpao = CASE
    WHEN tipo IN ('proprio', 'tpl', 'porto_seco')
         AND codigo ~ '^[0-9]+\.[0-9]+$'
    THEN split_part(codigo, '.', 1)
    ELSE NULL
END
WHERE galpao IS NULL;

-- ── 2. Tabela N:N user_galpao ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stockbridge.user_galpao (
    user_id    uuid NOT NULL REFERENCES atlas.users(id) ON DELETE CASCADE,
    galpao     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, galpao)
);

COMMENT ON TABLE stockbridge.user_galpao IS
  'Vinculo N:N usuario × galpao fisico. Operador deve ter >=1 linha; gestor/diretor sem linha = ve todos.';

CREATE INDEX IF NOT EXISTS user_galpao_galpao_idx ON stockbridge.user_galpao (galpao);

-- ── 3. Backfill: migra users.armazem_id existentes pra user_galpao ──────────
-- Pega o galpao da localidade vinculada e cria 1 linha por user.
INSERT INTO stockbridge.user_galpao (user_id, galpao)
SELECT u.id, l.galpao
FROM atlas.users u
JOIN stockbridge.localidade l ON l.id = u.armazem_id
WHERE u.armazem_id IS NOT NULL
  AND l.galpao IS NOT NULL
ON CONFLICT (user_id, galpao) DO NOTHING;

-- ── 4. Deprecate users.armazem_id ────────────────────────────────────────────
COMMENT ON COLUMN atlas.users.armazem_id IS
  '[DEPRECATED 2026-04-29] Substituido por stockbridge.user_galpao (N:N + agrupador fisico). Mantido nesta migration pra nao quebrar codigo legado — remover em migration futura quando services migrarem.';
