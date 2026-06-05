-- Migration: 0027 — Comodato dual ACXE+Q2P
--
-- ACXE agora tem o local virtual '90.0.1 TROCA' criado no OMIE (codigo_local_estoque=4816825713).
-- Atualiza a correlacao para destravar comodato dual em galpoes espelhados.

UPDATE stockbridge.localidade_correlacao
SET codigo_local_estoque_acxe = 4816825713
WHERE localidade_id = (SELECT id FROM stockbridge.localidade WHERE codigo = '90.0.1');
