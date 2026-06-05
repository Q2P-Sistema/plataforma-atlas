-- Migration: 0026 — Redesign da Saida Manual (sem FIFO; saldo via OMIE)
--
-- Spec: specs/007-stockbridge-module/spec-saida-manual-redesign.md
--
-- Pontos principais:
--   * Saida manual passa a ser agnostica de lote — SKU+galpao+empresa direto
--   * Comodato (so Q2P): material vai pra estoque virtual 90.0.1 TROCA via API OMIE
--   * Reserva de saldo evita race condition entre lancamentos pendentes
--   * Retorno de comodato aceita SKU/qtd divergente (gera 2 movimentacoes)

-- ── 1. Localidade virtual TROCA (Q2P only) ─────────────────────────
INSERT INTO stockbridge.localidade (codigo, nome, tipo, cnpj)
VALUES ('90.0.1', 'TROCA', 'virtual_ajuste', NULL)
ON CONFLICT (codigo) DO NOTHING;

-- Q2P ja tem 90.0.1 TROCA no OMIE (codigo_local_estoque=8197553809).
-- ACXE nao tera comodato — coluna ACXE permanece NULL.
INSERT INTO stockbridge.localidade_correlacao (localidade_id, codigo_local_estoque_q2p)
SELECT id, 8197553809
FROM stockbridge.localidade
WHERE codigo = '90.0.1'
ON CONFLICT DO NOTHING;

-- ── 2. Movimentacao: novas colunas ─────────────────────────────────
ALTER TABLE stockbridge.movimentacao
  ADD COLUMN IF NOT EXISTS produto_codigo_acxe BIGINT,
  ADD COLUMN IF NOT EXISTS galpao TEXT,
  ADD COLUMN IF NOT EXISTS galpao_destino TEXT,                       -- transf_intra_cnpj
  ADD COLUMN IF NOT EXISTS empresa TEXT,
  ADD COLUMN IF NOT EXISTS criado_por UUID REFERENCES atlas.users(id),
  ADD COLUMN IF NOT EXISTS dt_prevista_retorno DATE,
  ADD COLUMN IF NOT EXISTS movimentacao_origem_id UUID REFERENCES stockbridge.movimentacao(id);

ALTER TABLE stockbridge.movimentacao
  DROP CONSTRAINT IF EXISTS movimentacao_empresa_check;
ALTER TABLE stockbridge.movimentacao
  ADD CONSTRAINT movimentacao_empresa_check
  CHECK (empresa IS NULL OR empresa IN ('acxe', 'q2p'));

-- Pelo menos um identificador: lote_id OU (sku+galpao+empresa).
-- Movimentacoes antigas (criadas antes desta migration) sao 100% via lote_id, OK.
ALTER TABLE stockbridge.movimentacao
  DROP CONSTRAINT IF EXISTS movimentacao_chk_lote_ou_sku;
ALTER TABLE stockbridge.movimentacao
  ADD CONSTRAINT movimentacao_chk_lote_ou_sku
  CHECK (
    lote_id IS NOT NULL
    OR (produto_codigo_acxe IS NOT NULL AND galpao IS NOT NULL AND empresa IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS movimentacao_sku_galpao_empresa_idx
  ON stockbridge.movimentacao (produto_codigo_acxe, galpao, empresa)
  WHERE produto_codigo_acxe IS NOT NULL;

CREATE INDEX IF NOT EXISTS movimentacao_origem_idx
  ON stockbridge.movimentacao (movimentacao_origem_id)
  WHERE movimentacao_origem_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS movimentacao_criado_por_idx
  ON stockbridge.movimentacao (criado_por, created_at DESC)
  WHERE criado_por IS NOT NULL;

-- ── 3. Aprovacao: lote_id opcional + novas colunas ────────────────
ALTER TABLE stockbridge.aprovacao
  ALTER COLUMN lote_id DROP NOT NULL;

ALTER TABLE stockbridge.aprovacao
  ADD COLUMN IF NOT EXISTS produto_codigo_acxe BIGINT,
  ADD COLUMN IF NOT EXISTS galpao TEXT,
  ADD COLUMN IF NOT EXISTS empresa TEXT,
  ADD COLUMN IF NOT EXISTS movimentacao_id UUID REFERENCES stockbridge.movimentacao(id);

ALTER TABLE stockbridge.aprovacao
  DROP CONSTRAINT IF EXISTS aprovacao_empresa_check;
ALTER TABLE stockbridge.aprovacao
  ADD CONSTRAINT aprovacao_empresa_check
  CHECK (empresa IS NULL OR empresa IN ('acxe', 'q2p'));

-- Pelo menos um identificador: lote_id OU (sku+galpao+empresa).
ALTER TABLE stockbridge.aprovacao
  DROP CONSTRAINT IF EXISTS aprovacao_chk_lote_ou_sku;
ALTER TABLE stockbridge.aprovacao
  ADD CONSTRAINT aprovacao_chk_lote_ou_sku
  CHECK (
    lote_id IS NOT NULL
    OR (produto_codigo_acxe IS NOT NULL AND galpao IS NOT NULL AND empresa IS NOT NULL)
  );

-- Adiciona retorno_comodato no CHECK de tipo_aprovacao
ALTER TABLE stockbridge.aprovacao
  DROP CONSTRAINT IF EXISTS aprovacao_tipo_aprovacao_check;
ALTER TABLE stockbridge.aprovacao
  ADD CONSTRAINT aprovacao_tipo_aprovacao_check
  CHECK (tipo_aprovacao IN (
    'recebimento_divergencia',
    'entrada_manual',
    'saida_transf_intra',
    'saida_comodato',
    'saida_amostra',
    'saida_descarte',
    'saida_quebra',
    'ajuste_inventario',
    'retorno_comodato'
  ));

-- ── 4. Reserva de saldo (controle de concorrencia) ────────────────
CREATE TABLE IF NOT EXISTS stockbridge.reserva_saldo (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  movimentacao_id UUID NOT NULL UNIQUE REFERENCES stockbridge.movimentacao(id) ON DELETE CASCADE,
  produto_codigo_acxe BIGINT NOT NULL,
  galpao TEXT NOT NULL,
  empresa TEXT NOT NULL CHECK (empresa IN ('acxe', 'q2p')),
  quantidade_kg NUMERIC(12,3) NOT NULL CHECK (quantidade_kg > 0),
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'liberada', 'consumida')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolvido_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS reserva_sku_idx
  ON stockbridge.reserva_saldo (produto_codigo_acxe, galpao, empresa, status)
  WHERE status = 'ativa';

-- ── 5. Backfill / migracao de dados antigos ───────────────────────
-- Movimentacoes antigas tem id_user_acxe ou id_user_q2p — populate criado_por
-- pra que o filtro "minhas" funcione retroativamente.
UPDATE stockbridge.movimentacao
   SET criado_por = COALESCE(id_user_acxe, id_user_q2p)
 WHERE criado_por IS NULL
   AND (id_user_acxe IS NOT NULL OR id_user_q2p IS NOT NULL);

-- ── 6. Comentarios documentando o redesign ────────────────────────
COMMENT ON COLUMN stockbridge.movimentacao.produto_codigo_acxe IS 'Saida manual sem lote: SKU referenciado direto (codigo OMIE ACXE como id canonico)';
COMMENT ON COLUMN stockbridge.movimentacao.galpao IS 'Saida manual sem lote: prefixo do galpao (ex: 11, 13, 40); ler stockbridge.localidade.galpao';
COMMENT ON COLUMN stockbridge.movimentacao.empresa IS 'Saida manual sem lote: ''acxe'' ou ''q2p'' — define qual API OMIE chamar';
COMMENT ON COLUMN stockbridge.movimentacao.criado_por IS 'Usuario que disparou a movimentacao na UI (substitui id_user_acxe/id_user_q2p)';
COMMENT ON COLUMN stockbridge.movimentacao.dt_prevista_retorno IS 'Comodato apenas: data prevista de retorno do material';
COMMENT ON COLUMN stockbridge.movimentacao.movimentacao_origem_id IS 'Retorno de comodato: aponta para a movimentacao de saida original';
COMMENT ON TABLE stockbridge.reserva_saldo IS 'Reserva de saldo enquanto saida manual aguarda aprovacao — evita race condition';
