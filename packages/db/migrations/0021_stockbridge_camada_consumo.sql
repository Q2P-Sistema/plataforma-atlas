-- Migration: 021 StockBridge — expor camada do fallback usada no calculo de consumo
--
-- Contexto:
-- A funcao calcular_consumo_medio_diario_kg retorna numeric, mas perde a info
-- de qual das 3 camadas (70/30, 90d, 365d) foi usada. UI quer exibir essa info
-- por SKU pra diretor entender a confiabilidade do numero (70/30 sazonal e mais
-- robusto que 365d puro).
--
-- Solucao:
-- 1. Adiciona coluna camada_consumo (text) em config_produto.
-- 2. Recria funcao retornando TABLE(consumo numeric, camada text).
-- 3. Atualiza refresh pra popular ambas as colunas no UPDATE.
-- 4. Re-executa pra backfill.
--
-- Valores possiveis de camada_consumo:
--   '70/30' — composicao 70% × 90d + 30% × mesmo mes ano anterior
--   '90d'   — media dos ultimos 90 dias (sem termo sazonal)
--   '365d'  — media de 365 dias (fallback final)
--   NULL    — sem vendas em 365d (UI exibe "Sem dados")

-- ── 1. Coluna camada_consumo ─────────────────────────────────────────────────
ALTER TABLE stockbridge.config_produto
    ADD COLUMN IF NOT EXISTS camada_consumo text;

COMMENT ON COLUMN stockbridge.config_produto.camada_consumo IS
  'Qual camada do fallback foi usada no ultimo calculo: 70/30, 90d, 365d, ou NULL (sem dados).';

-- ── 2. Recria funcao retornando (consumo, camada) ────────────────────────────
DROP FUNCTION IF EXISTS stockbridge.calcular_consumo_medio_diario_kg(bigint);

CREATE OR REPLACE FUNCTION stockbridge.calcular_consumo_medio_diario_kg(p_codigo_acxe bigint)
RETURNS TABLE(consumo numeric, camada text)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_qtd_90d                  numeric := 0;
    v_qtd_365d                 numeric := 0;
    v_qtd_mes_ano_anterior     numeric := 0;
    v_dias_mes_ano_anterior    integer;
    v_data_inicio_mes_anterior date;
    v_data_fim_mes_anterior    date;
    v_descricao_acxe           text;
    v_codigo_q2p               bigint;
    v_q2p_matriz               bigint := 4151024070;
    v_q2p_filial               bigint := 4151026325;
BEGIN
    SELECT descricao INTO v_descricao_acxe
    FROM public."tbl_produtos_ACXE"
    WHERE codigo_produto = p_codigo_acxe;

    IF v_descricao_acxe IS NULL THEN
        consumo := NULL; camada := NULL; RETURN NEXT; RETURN;
    END IF;

    SELECT codigo_produto INTO v_codigo_q2p
    FROM public."tbl_produtos_Q2P"
    WHERE descricao = v_descricao_acxe
      AND (inativo IS NULL OR inativo <> 'S')
    LIMIT 1;

    -- ── Vendas ultimos 90 dias ───────────────────────────────────────────
    IF v_codigo_q2p IS NOT NULL THEN
        SELECT COALESCE(SUM(i.quantidade), 0) INTO v_qtd_90d
        FROM public."tbl_pedidosVendas_Q2P" p
        JOIN public."tbl_pedidosVendas_itens_Q2P" i ON i.codigo_pedido = p.codigo_pedido
        WHERE i.codigo_produto = v_codigo_q2p
          AND p.faturado = 'S'
          AND COALESCE(p.cancelado,         'N') <> 'S'
          AND COALESCE(p.devolvido,         'N') <> 'S'
          AND COALESCE(p.devolvido_parcial, 'N') <> 'S'
          AND COALESCE(p.denegado,          'N') <> 'S'
          AND p.dfat > now() - interval '90 days';
    END IF;

    v_qtd_90d := v_qtd_90d + COALESCE((
        SELECT SUM(i.quantidade)
        FROM public."tbl_pedidosVendas_ACXE" p
        JOIN public."tbl_pedidosVendas_itens_ACXE" i ON i.codigo_pedido = p.codigo_pedido
        WHERE i.codigo_produto = p_codigo_acxe
          AND p.faturado = 'S'
          AND COALESCE(p.cancelado,         'N') <> 'S'
          AND COALESCE(p.devolvido,         'N') <> 'S'
          AND COALESCE(p.devolvido_parcial, 'N') <> 'S'
          AND COALESCE(p.denegado,          'N') <> 'S'
          AND p.codigo_cliente NOT IN (v_q2p_matriz, v_q2p_filial)
          AND p.dfat > now() - interval '90 days'
    ), 0);

    -- ── Vendas mesmo mes do ano anterior ─────────────────────────────────
    v_data_inicio_mes_anterior := date_trunc('month', now() - interval '1 year')::date;
    v_data_fim_mes_anterior    := (v_data_inicio_mes_anterior + interval '1 month - 1 day')::date;
    v_dias_mes_ano_anterior    := EXTRACT(day FROM (
        v_data_fim_mes_anterior::timestamp - v_data_inicio_mes_anterior::timestamp + interval '1 day'
    ))::int;

    IF v_codigo_q2p IS NOT NULL THEN
        SELECT COALESCE(SUM(i.quantidade), 0) INTO v_qtd_mes_ano_anterior
        FROM public."tbl_pedidosVendas_Q2P" p
        JOIN public."tbl_pedidosVendas_itens_Q2P" i ON i.codigo_pedido = p.codigo_pedido
        WHERE i.codigo_produto = v_codigo_q2p
          AND p.faturado = 'S'
          AND COALESCE(p.cancelado,         'N') <> 'S'
          AND COALESCE(p.devolvido,         'N') <> 'S'
          AND COALESCE(p.devolvido_parcial, 'N') <> 'S'
          AND COALESCE(p.denegado,          'N') <> 'S'
          AND p.dfat BETWEEN v_data_inicio_mes_anterior AND v_data_fim_mes_anterior;
    END IF;

    v_qtd_mes_ano_anterior := v_qtd_mes_ano_anterior + COALESCE((
        SELECT SUM(i.quantidade)
        FROM public."tbl_pedidosVendas_ACXE" p
        JOIN public."tbl_pedidosVendas_itens_ACXE" i ON i.codigo_pedido = p.codigo_pedido
        WHERE i.codigo_produto = p_codigo_acxe
          AND p.faturado = 'S'
          AND COALESCE(p.cancelado,         'N') <> 'S'
          AND COALESCE(p.devolvido,         'N') <> 'S'
          AND COALESCE(p.devolvido_parcial, 'N') <> 'S'
          AND COALESCE(p.denegado,          'N') <> 'S'
          AND p.codigo_cliente NOT IN (v_q2p_matriz, v_q2p_filial)
          AND p.dfat BETWEEN v_data_inicio_mes_anterior AND v_data_fim_mes_anterior
    ), 0);

    -- ── Vendas 365 dias (camada 3 — so calcula se 1 e 2 zeraram) ─────────
    IF v_qtd_mes_ano_anterior = 0 AND v_qtd_90d = 0 THEN
        IF v_codigo_q2p IS NOT NULL THEN
            SELECT COALESCE(SUM(i.quantidade), 0) INTO v_qtd_365d
            FROM public."tbl_pedidosVendas_Q2P" p
            JOIN public."tbl_pedidosVendas_itens_Q2P" i ON i.codigo_pedido = p.codigo_pedido
            WHERE i.codigo_produto = v_codigo_q2p
              AND p.faturado = 'S'
              AND COALESCE(p.cancelado,         'N') <> 'S'
              AND COALESCE(p.devolvido,         'N') <> 'S'
              AND COALESCE(p.devolvido_parcial, 'N') <> 'S'
              AND COALESCE(p.denegado,          'N') <> 'S'
              AND p.dfat > now() - interval '365 days';
        END IF;

        v_qtd_365d := v_qtd_365d + COALESCE((
            SELECT SUM(i.quantidade)
            FROM public."tbl_pedidosVendas_ACXE" p
            JOIN public."tbl_pedidosVendas_itens_ACXE" i ON i.codigo_pedido = p.codigo_pedido
            WHERE i.codigo_produto = p_codigo_acxe
              AND p.faturado = 'S'
              AND COALESCE(p.cancelado,         'N') <> 'S'
              AND COALESCE(p.devolvido,         'N') <> 'S'
              AND COALESCE(p.devolvido_parcial, 'N') <> 'S'
              AND COALESCE(p.denegado,          'N') <> 'S'
              AND p.codigo_cliente NOT IN (v_q2p_matriz, v_q2p_filial)
              AND p.dfat > now() - interval '365 days'
        ), 0);
    END IF;

    -- ── Fallback de 3 camadas ────────────────────────────────────────────
    IF v_qtd_mes_ano_anterior > 0 THEN
        consumo := ROUND(
            0.7 * (v_qtd_90d / 90.0) +
            0.3 * (v_qtd_mes_ano_anterior::numeric / GREATEST(v_dias_mes_ano_anterior, 1)),
            2
        );
        camada := '70/30';
    ELSIF v_qtd_90d > 0 THEN
        consumo := ROUND(v_qtd_90d / 90.0, 2);
        camada := '90d';
    ELSIF v_qtd_365d > 0 THEN
        consumo := ROUND(v_qtd_365d / 365.0, 2);
        camada := '365d';
    ELSE
        consumo := NULL;
        camada := NULL;
    END IF;

    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION stockbridge.calcular_consumo_medio_diario_kg(bigint) IS
  'Retorna (consumo numeric, camada text) via fallback de 3 camadas. Camada: 70/30 | 90d | 365d | NULL.';

-- ── 3. Atualiza refresh pra gravar consumo + camada ──────────────────────────
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

    IF v_max_updated IS NULL
       OR v_max_updated < now() - (p_ttl_minutes || ' minutes')::interval THEN

        UPDATE stockbridge.config_produto c
        SET (consumo_medio_diario_kg, camada_consumo, updated_at) = (
            SELECT calc.consumo, calc.camada, now()
            FROM stockbridge.calcular_consumo_medio_diario_kg(c.produto_codigo_acxe) AS calc
        );

        GET DIAGNOSTICS v_count = ROW_COUNT;
    END IF;

    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION stockbridge.refresh_consumo_medio_se_stale(integer) IS
  'Recalcula consumo_medio_diario_kg e camada_consumo de todos os produtos em config_produto se MAX(updated_at) for mais antigo que p_ttl_minutes.';

-- ── 4. Backfill imediato ─────────────────────────────────────────────────────
UPDATE stockbridge.config_produto c
SET (consumo_medio_diario_kg, camada_consumo, updated_at) = (
    SELECT calc.consumo, calc.camada, now()
    FROM stockbridge.calcular_consumo_medio_diario_kg(c.produto_codigo_acxe) AS calc
);
