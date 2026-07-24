-- Migration: 012 StockBridge — persiste valor total da NF e local de estoque de origem ACXE
-- Motivacao:
--   * valor_total_nf_usd (vNF) e usado no calculo do valor unitario Q2P
--     (= ceil((vNF / qtdNfKg) * 1.145 * 100) / 100). Sem persistir, a aprovacao
--     de divergencia precisa re-consultar OMIE so pra resolver isso.
--   * codigo_local_estoque_origem_acxe e o local de estoque de origem (estoque
--     em transito) retornado pela consulta da NF — necessario na transferencia
--     ACXE (TRF/TRF) tanto no recebimento quanto na aprovacao posterior.
-- Ambos opcionais para nao quebrar lotes pre-existentes.

ALTER TABLE stockbridge.lote
  ADD COLUMN IF NOT EXISTS valor_total_nf_usd          numeric(14, 2),
  ADD COLUMN IF NOT EXISTS codigo_local_estoque_origem_acxe varchar(50);

COMMENT ON COLUMN stockbridge.lote.valor_total_nf_usd IS
  'Valor total da NF em USD (campo vNF/ICMSTot.vNF do OMIE) gravado no momento do recebimento — usado no calculo do valor unitario Q2P';
COMMENT ON COLUMN stockbridge.lote.codigo_local_estoque_origem_acxe IS
  'Codigo do local de estoque de origem ACXE (estoque em transito) retornado pela consulta da NF — usado como origem na transferencia OMIE TRF/TRF';
