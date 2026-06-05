-- Migration: 0030 — Localidades por sub-estoque (granularidade .1/.2)
--
-- Antes: stockbridge.localidade tinha 4 entradas fisicas (11.1, 12.1, 21.1, 31.1)
-- com campo `galpao` agregando (11, 12, 21, 31). Faltavam 11.2 e 12.2 (nacionais
-- Q2P-only). Vinculacao operador era por agregador (galpao='11' cobria 11.1+11.2).
--
-- Agora: cada sub-estoque e uma localidade propria. galpao = codigo (sem agregar).
-- Operador escolhe o sub-estoque exato. Permite distinguir importado x nacional
-- na saida manual e na vinculacao.

-- ── 1. Renomear localidades existentes pro nome OMIE atual ─────────────
UPDATE stockbridge.localidade SET nome = 'SANTO ANDRÉ (IMPORTADO)' WHERE codigo IN ('11.1', '12.1');
UPDATE stockbridge.localidade SET nome = 'EXTREMA'                  WHERE codigo = '21.1';
UPDATE stockbridge.localidade SET nome = 'ARMAZÉM EXTERNO'          WHERE codigo = '31.1';

-- ── 2. galpao agora = codigo (granularidade sub-estoque) ───────────────
UPDATE stockbridge.localidade SET galpao = codigo WHERE galpao IS NOT NULL;

-- ── 3. Adicionar nacionais Q2P-only ────────────────────────────────────
INSERT INTO stockbridge.localidade (codigo, nome, tipo, galpao) VALUES
  ('11.2', 'SANTO ANDRÉ (NACIONAL)', 'proprio', '11.2'),
  ('12.2', 'SANTO ANDRÉ (NACIONAL)', 'proprio', '12.2')
ON CONFLICT (codigo) DO NOTHING;

-- ── 4. Correlação OMIE Q2P (ACXE NULL — só Q2P tem nacional) ──────────
INSERT INTO stockbridge.localidade_correlacao (localidade_id, codigo_local_estoque_q2p)
SELECT id, 8123584710 FROM stockbridge.localidade WHERE codigo = '11.2'
ON CONFLICT DO NOTHING;

INSERT INTO stockbridge.localidade_correlacao (localidade_id, codigo_local_estoque_q2p)
SELECT id, 8123584481 FROM stockbridge.localidade WHERE codigo = '12.2'
ON CONFLICT DO NOTHING;

-- ── 5. Migrar user_galpao: agregadores -> sub-estoques ────────────────
-- Quem tinha '11' (=11.x) ganha 11.1 + 11.2; idem '12'. '21' e '31' viram '21.1' e '31.1'.
INSERT INTO stockbridge.user_galpao (user_id, galpao)
SELECT user_id, novo FROM (
  SELECT user_id, '11.1'::text AS novo FROM stockbridge.user_galpao WHERE galpao = '11'
  UNION ALL
  SELECT user_id, '11.2'      FROM stockbridge.user_galpao WHERE galpao = '11'
  UNION ALL
  SELECT user_id, '12.1'      FROM stockbridge.user_galpao WHERE galpao = '12'
  UNION ALL
  SELECT user_id, '12.2'      FROM stockbridge.user_galpao WHERE galpao = '12'
  UNION ALL
  SELECT user_id, '21.1'      FROM stockbridge.user_galpao WHERE galpao = '21'
  UNION ALL
  SELECT user_id, '31.1'      FROM stockbridge.user_galpao WHERE galpao = '31'
) sub
ON CONFLICT (user_id, galpao) DO NOTHING;

DELETE FROM stockbridge.user_galpao WHERE galpao IN ('11', '12', '21', '31');

-- ── 6. Backfill movimentacao.galpao antigas (agregador -> sub-estoque) ─
-- Movimentacoes ja gravadas com galpao='11' viram '11.1' (assume importado, mais
-- comum). Esse campo é só pra UI de listagem — nao afeta OMIE (idMovest ja gravado).
UPDATE stockbridge.movimentacao SET galpao = '11.1' WHERE galpao = '11';
UPDATE stockbridge.movimentacao SET galpao = '12.1' WHERE galpao = '12';
UPDATE stockbridge.movimentacao SET galpao = '21.1' WHERE galpao = '21';
UPDATE stockbridge.movimentacao SET galpao = '31.1' WHERE galpao = '31';

UPDATE stockbridge.movimentacao SET galpao_destino = '11.1' WHERE galpao_destino = '11';
UPDATE stockbridge.movimentacao SET galpao_destino = '12.1' WHERE galpao_destino = '12';
UPDATE stockbridge.movimentacao SET galpao_destino = '21.1' WHERE galpao_destino = '21';
UPDATE stockbridge.movimentacao SET galpao_destino = '31.1' WHERE galpao_destino = '31';

-- aprovacao.galpao tambem
UPDATE stockbridge.aprovacao SET galpao = '11.1' WHERE galpao = '11';
UPDATE stockbridge.aprovacao SET galpao = '12.1' WHERE galpao = '12';
UPDATE stockbridge.aprovacao SET galpao = '21.1' WHERE galpao = '21';
UPDATE stockbridge.aprovacao SET galpao = '31.1' WHERE galpao = '31';

-- reserva_saldo.galpao
UPDATE stockbridge.reserva_saldo SET galpao = '11.1' WHERE galpao = '11';
UPDATE stockbridge.reserva_saldo SET galpao = '12.1' WHERE galpao = '12';
UPDATE stockbridge.reserva_saldo SET galpao = '21.1' WHERE galpao = '21';
UPDATE stockbridge.reserva_saldo SET galpao = '31.1' WHERE galpao = '31';
