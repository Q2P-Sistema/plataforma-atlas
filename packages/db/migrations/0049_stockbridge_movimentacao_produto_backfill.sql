-- Migration: 0049 — StockBridge: re-backfill do produto nas movimentações de entrada_nf (ACXEGDP-344)
--
-- Antes: 3 movimentações de entrada_nf (NFs 5439 em 30/07, 5434 em 31/07 e
--   mais uma em 24/08/2026) foram gravadas com produto_codigo_acxe/q2p NULL —
--   o produto ficou só no lote. Desde a feature 014 a checagem "recebida" da
--   fila, do cockpit e das pendências fiscais é POR PRODUTO
--   (recebidaViaMovimentacaoSql: m.produto_codigo_acxe = <produto>), então
--   essas NFs seguem aparecendo como "a receber" mesmo com o ajuste dual OMIE
--   concluído nas duas empresas. A migration 0046 já fazia este backfill, mas
--   só para as linhas existentes na hora em que rodou.
-- Agora: repete o backfill a partir do lote (ACXE e Q2P), idempotente. As
--   linhas entram no índice de idempotência por produto (0046) — verificado
--   que nenhuma colide com movimentação já existente.
-- Porque: NF recebida não pode continuar na fila de recebimento (risco de
--   recebimento duplicado) nem inflar a posição fiscal pendente.

UPDATE stockbridge.movimentacao m
SET produto_codigo_acxe = l.produto_codigo_acxe,
    produto_codigo_q2p  = COALESCE(m.produto_codigo_q2p, l.produto_codigo_q2p),
    updated_at          = now()
FROM stockbridge.lote l
WHERE l.id = m.lote_id
  AND m.tipo_movimento = 'entrada_nf'
  AND m.ativo = true
  AND m.produto_codigo_acxe IS NULL
  AND l.produto_codigo_acxe IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM stockbridge.movimentacao x
     WHERE x.ativo = true AND x.tipo_movimento = 'entrada_nf'
       AND x.nota_fiscal = m.nota_fiscal AND x.empresa = m.empresa
       AND x.produto_codigo_acxe = l.produto_codigo_acxe
  );

-- Complementa o Q2P onde só o ACXE já estava preenchido (61 linhas no UAT em
-- 28/08 — a baixa de pedido resolve pelo lote, mas o dado na movimentação
-- evita o fallback).
UPDATE stockbridge.movimentacao m
SET produto_codigo_q2p = l.produto_codigo_q2p,
    updated_at         = now()
FROM stockbridge.lote l
WHERE l.id = m.lote_id
  AND m.tipo_movimento = 'entrada_nf'
  AND m.ativo = true
  AND m.produto_codigo_q2p IS NULL
  AND l.produto_codigo_q2p IS NOT NULL;
