-- Migration: 018 StockBridge — refresh do consumo_medio_diario_kg via TTL
--
-- Contexto:
-- A funcao stockbridge.calcular_consumo_medio_diario_kg() criada na 0017 calcula
-- o consumo via composicao 70/30 das vendas. Mas no backfill ela rodou UMA VEZ.
-- Sem refresh, config_produto.consumo_medio_diario_kg fica stale conforme novas
-- vendas chegam.
--
-- Solucao: funcao refresh_consumo_medio_se_stale(ttl_minutes) que:
-- 1. Verifica MAX(updated_at) em config_produto
-- 2. Se antigo (alem do TTL): UPDATE em massa recalculando todos os produtos
-- 3. Caso contrario: no-op (zero queries pesadas)
--
-- Caller padrao: listarConfigProdutos do service (chamado quando diretor abre a
-- tela Config Produtos). TTL default 60 minutos — primeira abertura em cada
-- janela de 1h dispara recalculo, refreshes seguintes em ~5ms.

CREATE OR REPLACE FUNCTION stockbridge.refresh_consumo_medio_se_stale(
    p_ttl_minutes integer DEFAULT 60
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_max_updated timestamptz;
    v_count       integer := 0;
BEGIN
    SELECT MAX(updated_at) INTO v_max_updated
    FROM stockbridge.config_produto;

    -- Se nunca atualizou OU passou do TTL: recalcula
    IF v_max_updated IS NULL
       OR v_max_updated < now() - (p_ttl_minutes || ' minutes')::interval THEN

        UPDATE stockbridge.config_produto c
        SET consumo_medio_diario_kg = COALESCE(
                stockbridge.calcular_consumo_medio_diario_kg(c.produto_codigo_acxe),
                100
            ),
            updated_at = now();

        GET DIAGNOSTICS v_count = ROW_COUNT;
    END IF;

    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION stockbridge.refresh_consumo_medio_se_stale(integer) IS
  'Recalcula consumo_medio_diario_kg de todos os produtos em config_produto se MAX(updated_at) for mais antigo que p_ttl_minutes. Retorna count de linhas atualizadas (0 se ainda fresco). Caller: listarConfigProdutos.';
