-- Migration: 0029 — Operador pode dispensar rejeicao da propria caixa de entrada
--
-- Antes: rejeicoes ficavam na inbox do operador (FilaOmie / SaidaManual) ate o
-- fim dos tempos (saida manual) ou ate o lote ser inativado / re-submissao
-- (recebimento). Operador nao tinha como dizer "vi, nao vou re-lancar".
--
-- Agora: nova coluna `dispensada_em`. Quando setada, a aprovacao some da inbox
-- do operador mas continua na auditoria (status='rejeitada' inalterado).
-- Trigger de audit ja registra o UPDATE — historico preservado.

ALTER TABLE stockbridge.aprovacao
  ADD COLUMN IF NOT EXISTS dispensada_em TIMESTAMPTZ;

COMMENT ON COLUMN stockbridge.aprovacao.dispensada_em IS
  'Operador marcou a rejeicao como vista/descartada. NULL = ainda na inbox. Nao altera status — apenas tira da listagem em listarMinhasRejeicoes.';
