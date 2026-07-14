-- Migration: 0044 — StockBridge: chave de idempotência de NF inclui a EMPRESA (STK-09, ACXEGDP-288)
--
-- Antes: movimentacao_nf_idempotencia_idx cobria (nota_fiscal, tipo_movimento)
--   sem a empresa — e os INSERTs de entrada_nf/saida_automatica nem preenchiam a
--   coluna `empresa`. Como a numeração de NF é POR EMISSOR, a NF 300 da Q2P era
--   bloqueada se a ACXE já tivesse processado a NF 300. No caminho de saída
--   automática era pior: a saída da 2ª empresa era engolida como
--   {idempotente:true} devolvendo o movimentacaoId da OUTRA empresa (perda
--   silenciosa da movimentação).
-- Agora: (1) backfill de `empresa` nas movimentações existentes (entrada_nf via
--   lote.cnpj; saida_automatica via mv_acxe/mv_q2p); (2) índice recriado como
--   (nota_fiscal, tipo_movimento, empresa). A aplicação passa a preencher
--   `empresa` nos dois INSERTs e a filtrar por ela nas checagens.
-- Porque: achado da auditoria ACXEGDP-238 (verificação adversarial, confiança
--   alta). Verificado no UAT vivo em 2026-07-14: 54 movimentações entrada_nf,
--   todas com empresa NULL e todas deriváveis do lote (cnpj='Acxe Matriz');
--   zero saida_automatica.
--
-- Segurança do índice novo: a chave nova é SUPERCONJUNTO da antiga — dados que
-- satisfazem (nota_fiscal, tipo_movimento) único não podem violar
-- (nota_fiscal, tipo_movimento, empresa). Predicado exige empresa IS NOT NULL:
-- linhas antigas que o backfill não conseguir derivar ficam fora do índice
-- (sem proteção nova, mas também sem quebrar a migration) — a aplicação sempre
-- preenche daqui em diante.

-- ── 1. Backfill: entrada_nf herda a empresa do cnpj do lote ─────────────────
UPDATE stockbridge.movimentacao m
SET empresa = CASE WHEN l.cnpj ILIKE '%acxe%' THEN 'acxe' ELSE 'q2p' END
FROM stockbridge.lote l
WHERE l.id = m.lote_id
  AND m.tipo_movimento = 'entrada_nf'
  AND m.empresa IS NULL;

-- ── 2. Backfill: saida_automatica herda do lado preenchido (mv_acxe/mv_q2p) ─
UPDATE stockbridge.movimentacao
SET empresa = CASE WHEN mv_acxe IS NOT NULL THEN 'acxe' ELSE 'q2p' END
WHERE tipo_movimento = 'saida_automatica'
  AND empresa IS NULL
  AND (mv_acxe IS NOT NULL OR mv_q2p IS NOT NULL);

-- ── 3. Índice de idempotência com a empresa na chave ────────────────────────
DROP INDEX IF EXISTS stockbridge.movimentacao_nf_idempotencia_idx;

CREATE UNIQUE INDEX movimentacao_nf_idempotencia_idx
    ON stockbridge.movimentacao (nota_fiscal, tipo_movimento, empresa)
    WHERE tipo_movimento IN ('entrada_nf', 'saida_automatica')
      AND ativo = true
      AND empresa IS NOT NULL;

COMMENT ON INDEX stockbridge.movimentacao_nf_idempotencia_idx IS
  'Idempotencia: uma NF OMIE (entrada_nf ou saida_automatica) so pode ter UMA movimentacao ATIVA por EMPRESA emissora (STK-09, ACXEGDP-288). Soft-deleted (ativo=false) liberam re-processamento.';
