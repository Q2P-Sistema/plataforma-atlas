-- Migration: 0033 — Estoque 21.2 EXTREMA (NACIONAL) — ACXE-only
--
-- Cria a localidade nacional de Extrema para ACXE (código OMIE 4452867179).
-- Correlação apenas no lado ACXE (Q2P NULL) — portanto não-espelhado,
-- elegível para recebimento nacional ACXE e inelegível para importação.

INSERT INTO stockbridge.localidade (codigo, nome, tipo)
VALUES ('21.2', 'EXTREMA (NACIONAL)', 'proprio')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO stockbridge.localidade_correlacao (localidade_id, codigo_local_estoque_acxe, codigo_local_estoque_q2p)
SELECT id, 4452867179, NULL
FROM stockbridge.localidade
WHERE codigo = '21.2'
ON CONFLICT DO NOTHING;

-- Garante que operadores vinculados ao galpao 21.1 (Extrema) também acessem 21.2
INSERT INTO stockbridge.user_galpao (user_id, galpao)
SELECT ug.user_id, '21.2'
FROM stockbridge.user_galpao ug
WHERE ug.galpao = '21.1'
ON CONFLICT (user_id, galpao) DO NOTHING;
