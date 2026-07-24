-- Migration: 013 StockBridge — corrige nomenclatura de USD para BRL
-- Motivacao: NF brasileira sempre carrega valores em reais (BRL). O sufixo "_usd"
-- veio do legado por confusao e foi mantido nas migrations 008/011/012. Os valores
-- numericos JA estao em BRL — so renomeamos os identificadores. Sem conversao de cambio.

ALTER TABLE stockbridge.lote RENAME COLUMN custo_usd_ton          TO custo_brl_kg;
ALTER TABLE stockbridge.lote RENAME COLUMN valor_total_nf_usd      TO valor_total_nf_brl;

COMMENT ON COLUMN stockbridge.lote.custo_brl_kg IS
  'Valor unitario do produto na NF (vUnCom) em BRL/kg — usado como custo unitario do lote';
COMMENT ON COLUMN stockbridge.lote.valor_total_nf_brl IS
  'Valor total da NF (vNF/ICMSTot.vNF) em BRL — usado no calculo do valor unitario Q2P (= ceil(vNF / qtdNfKg * 1.145 * 100) / 100)';
