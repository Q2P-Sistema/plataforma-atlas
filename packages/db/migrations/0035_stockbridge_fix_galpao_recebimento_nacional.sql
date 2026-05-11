-- Migration: 0035 — Corrige galpao de recebimentos nacionais ja gravados.
--
-- Antes: recebimento-nacional.service.ts gravava em movimentacao.galpao o
-- codigo_local_estoque do OMIE (numerico, ex '8123584710'). Isso fazia a UI
-- mostrar o numero bruto em vez do label legivel (Santo André - Nacional).
-- Codigo fixado no commit anterior — agora grava loc.codigo (interno Atlas).
--
-- Esta migration corrige registros legados via mapeamento codigo_omie -> codigo
-- da localidade_correlacao.

UPDATE stockbridge.movimentacao m
SET galpao = l.codigo
FROM stockbridge.localidade l
JOIN stockbridge.localidade_correlacao lc ON lc.localidade_id = l.id
WHERE (lc.codigo_local_estoque_q2p::text = m.galpao
       OR lc.codigo_local_estoque_acxe::text = m.galpao)
  AND m.galpao ~ '^[0-9]{6,}$';

UPDATE stockbridge.aprovacao a
SET galpao = l.codigo
FROM stockbridge.localidade l
JOIN stockbridge.localidade_correlacao lc ON lc.localidade_id = l.id
WHERE (lc.codigo_local_estoque_q2p::text = a.galpao
       OR lc.codigo_local_estoque_acxe::text = a.galpao)
  AND a.galpao ~ '^[0-9]{6,}$';
