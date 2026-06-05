-- Migration: 011 StockBridge Kg Standardization
-- Renomeia colunas de toneladas para Kg e multiplica valores existentes por 1000.
-- Convencao Q2P: operacao diaria e OMIE usam Kg. Backend e UI agora alinhados.
-- custo_usd mantem valor em USD/tonelada — so renomeia para deixar explicito (custo_usd_ton).
-- Views em shared.* sao recriadas com nomes _kg (nao ha ALTER de coluna derivada).

-- ── stockbridge.movimentacao ──────────────────────────────
ALTER TABLE stockbridge.movimentacao RENAME COLUMN quantidade_t TO quantidade_kg;
UPDATE stockbridge.movimentacao SET quantidade_kg = quantidade_kg * 1000;

-- ── stockbridge.lote ──────────────────────────────────────
ALTER TABLE stockbridge.lote RENAME COLUMN quantidade_fisica TO quantidade_fisica_kg;
ALTER TABLE stockbridge.lote RENAME COLUMN quantidade_fiscal TO quantidade_fiscal_kg;
ALTER TABLE stockbridge.lote RENAME COLUMN custo_usd          TO custo_usd_ton;
UPDATE stockbridge.lote
   SET quantidade_fisica_kg = quantidade_fisica_kg * 1000,
       quantidade_fiscal_kg = quantidade_fiscal_kg * 1000;
-- custo_usd_ton: valor inalterado (continua sendo USD por tonelada)

-- ── stockbridge.aprovacao ─────────────────────────────────
ALTER TABLE stockbridge.aprovacao RENAME COLUMN quantidade_prevista_t TO quantidade_prevista_kg;
ALTER TABLE stockbridge.aprovacao RENAME COLUMN quantidade_recebida_t TO quantidade_recebida_kg;
UPDATE stockbridge.aprovacao
   SET quantidade_prevista_kg = quantidade_prevista_kg * 1000
 WHERE quantidade_prevista_kg IS NOT NULL;
UPDATE stockbridge.aprovacao
   SET quantidade_recebida_kg = quantidade_recebida_kg * 1000
 WHERE quantidade_recebida_kg IS NOT NULL;

-- ── stockbridge.divergencia ───────────────────────────────
ALTER TABLE stockbridge.divergencia RENAME COLUMN quantidade_delta_t TO quantidade_delta_kg;
UPDATE stockbridge.divergencia SET quantidade_delta_kg = quantidade_delta_kg * 1000;

-- ── stockbridge.config_produto ────────────────────────────
ALTER TABLE stockbridge.config_produto RENAME COLUMN consumo_medio_diario_t TO consumo_medio_diario_kg;
UPDATE stockbridge.config_produto
   SET consumo_medio_diario_kg = consumo_medio_diario_kg * 1000
 WHERE consumo_medio_diario_kg IS NOT NULL;

-- ── View: shared.vw_sb_saldo_por_produto ─────────────────
DROP VIEW IF EXISTS shared.vw_sb_saldo_por_produto;
CREATE VIEW shared.vw_sb_saldo_por_produto AS
SELECT
    l.produto_codigo_acxe,
    l.cnpj,
    l.localidade_id,
    SUM(CASE WHEN l.status = 'reconciliado' AND l.estagio_transito IS NULL THEN l.quantidade_fisica_kg ELSE 0 END) AS fisica_disponivel_kg,
    SUM(CASE WHEN l.status = 'reconciliado' AND l.estagio_transito IS NULL THEN l.quantidade_fiscal_kg  ELSE 0 END) AS fiscal_kg,
    SUM(CASE WHEN l.status = 'provisorio'                                   THEN l.quantidade_fisica_kg ELSE 0 END) AS provisorio_kg,
    SUM(CASE WHEN l.estagio_transito = 'transito_intl'                      THEN l.quantidade_fisica_kg ELSE 0 END) AS transito_intl_kg,
    SUM(CASE WHEN l.estagio_transito = 'porto_dta'                          THEN l.quantidade_fisica_kg ELSE 0 END) AS porto_dta_kg,
    SUM(CASE WHEN l.estagio_transito = 'transito_interno'                   THEN l.quantidade_fisica_kg ELSE 0 END) AS transito_interno_kg
FROM stockbridge.lote l
WHERE l.ativo = true
GROUP BY l.produto_codigo_acxe, l.cnpj, l.localidade_id;

-- View vw_sb_correlacao_produto: sem colunas de unidade, nao precisa alterar.
-- View vw_sb_fornecedor_ativo: sem colunas de unidade, nao precisa alterar.
