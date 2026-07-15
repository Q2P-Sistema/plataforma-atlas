-- Migration: 0046 — StockBridge: idempotência de entrada_nf por PRODUTO (ACXEGDP-115)
--
-- Antes: movimentacao_nf_idempotencia_idx (migration 0044) cobria
--   (nota_fiscal, tipo_movimento, empresa) para entrada_nf E saida_automatica
--   num único índice. Isso limita a NF de importação a UMA movimentação de
--   entrada ativa por empresa — o segundo produto de uma NF multi-item violaria
--   o índice.
-- Agora: split em dois índices purpose-specific:
--   (1) entrada_nf → (nota_fiscal, empresa, produto_codigo_acxe): N produtos da
--       mesma NF convivem, cada um idempotente na sua linha. Habilita o
--       recebimento de NF de importação com múltiplos produtos (feature 013)
--       e torna o recebimento RESUMÍVEL (re-submeter completa só os faltantes).
--   (2) saida_automatica → (nota_fiscal, empresa): inalterado em relação à 0044
--       (produto_codigo_acxe pode ser NULL na saída; NULLs são distintos em
--       índice único, então incluí-lo quebraria a proteção).
-- Porque: feature 013-importacao-multi-produto (ACXEGDP-115). ~3% das NFs de
--   importação têm mais de um produto (30 em 962 nos últimos 12 meses) e hoje
--   são bloqueadas (STK-10) para processo manual no OMIE.
--
-- Segurança: a chave nova de entrada_nf é SUPERCONJUNTO da antiga — dados que
-- satisfazem (nota_fiscal, tipo_movimento, empresa) único não podem violar
-- (nota_fiscal, empresa, produto_codigo_acxe). saida_automatica mantém a chave
-- exata da 0044. Linhas antigas de entrada_nf com produto_codigo_acxe NULL
-- ficam fora do índice novo (o predicado exige produto NOT NULL) — a aplicação
-- passa a preencher produto_codigo_acxe em todo INSERT de entrada_nf.
--
-- Sem tabela nova → sem trigger de audit nova (Princípio IV já coberto pelos
-- triggers existentes de stockbridge.movimentacao).

-- ── 1. Backfill: entrada_nf herda o produto do lote (linhas pré-feature) ─────
-- Garante que as entradas existentes entrem no índice novo (proteção contínua).
UPDATE stockbridge.movimentacao m
SET produto_codigo_acxe = l.produto_codigo_acxe
FROM stockbridge.lote l
WHERE l.id = m.lote_id
  AND m.tipo_movimento = 'entrada_nf'
  AND m.produto_codigo_acxe IS NULL;

-- ── 2. Split do índice de idempotência ───────────────────────────────────────
DROP INDEX IF EXISTS stockbridge.movimentacao_nf_idempotencia_idx;

CREATE UNIQUE INDEX movimentacao_nf_entrada_idempotencia_idx
    ON stockbridge.movimentacao (nota_fiscal, empresa, produto_codigo_acxe)
    WHERE tipo_movimento = 'entrada_nf'
      AND ativo = true
      AND empresa IS NOT NULL
      AND produto_codigo_acxe IS NOT NULL;

CREATE UNIQUE INDEX movimentacao_nf_saida_idempotencia_idx
    ON stockbridge.movimentacao (nota_fiscal, empresa)
    WHERE tipo_movimento = 'saida_automatica'
      AND ativo = true
      AND empresa IS NOT NULL;

COMMENT ON INDEX stockbridge.movimentacao_nf_entrada_idempotencia_idx IS
  'Idempotencia de recebimento por PRODUTO: uma NF pode ter N movimentacoes entrada_nf ativas (uma por produto, feature 013/ACXEGDP-115), mas nunca duas do MESMO produto na mesma empresa. Soft-deleted (ativo=false) liberam re-processamento.';

COMMENT ON INDEX stockbridge.movimentacao_nf_saida_idempotencia_idx IS
  'Idempotencia de saida automatica: uma NF OMIE so pode ter UMA saida_automatica ativa por empresa emissora (STK-09, ACXEGDP-288 — inalterado pela 0046).';
