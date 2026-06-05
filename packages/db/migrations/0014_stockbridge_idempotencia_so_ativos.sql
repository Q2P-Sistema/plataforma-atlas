-- Migration: 014 StockBridge — UNIQUE INDEX de idempotencia ignora linhas inativas
-- Bug: o select de idempotencia em getFilaOmie/processarRecebimento filtra por
-- ativo=true, mas o UNIQUE INDEX nao filtrava — entao se uma movimentacao fosse
-- soft-deleted (ativo=false), o codigo achava que a NF estava livre mas o INSERT
-- batia em violacao de constraint. Estado preso: NF aparece como pendente porem
-- nao se consegue reprocessar.
--
-- Fix: adicionar `AND ativo = true` no predicado do UNIQUE INDEX. Soft-delete
-- ganha o direito de "nao existir" para fins de unicidade, alinhado com a logica
-- do servico.
--
-- Sem dados precisam ser migrados: o predicado novo e mais permissivo, entao
-- nenhum dado existente passa a violar a constraint.

DROP INDEX IF EXISTS stockbridge.movimentacao_nf_idempotencia_idx;

CREATE UNIQUE INDEX movimentacao_nf_idempotencia_idx
    ON stockbridge.movimentacao (nota_fiscal, tipo_movimento)
    WHERE tipo_movimento IN ('entrada_nf', 'saida_automatica')
      AND ativo = true;

COMMENT ON INDEX stockbridge.movimentacao_nf_idempotencia_idx IS
  'Idempotencia: uma NF OMIE (entrada_nf ou saida_automatica) so pode ter UMA movimentacao ATIVA. Soft-deleted (ativo=false) liberam re-processamento.';
