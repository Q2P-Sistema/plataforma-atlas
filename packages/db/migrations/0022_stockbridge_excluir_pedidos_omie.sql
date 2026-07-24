-- Migration: 022 StockBridge — filtra excluido_omie no calculo de consumo
--
-- Contexto:
-- Rev 2.0 dos workflows "Reconcilia Exclusoes de Pedidos" deixou de apagar os
-- itens em tbl_pedidosVendas_itens_* quando um pedido some do OMIE — agora so
-- marca tbl_pedidosVendas_*.excluido_omie = TRUE no header. Isso preserva
-- historico/rastreabilidade, mas exige que TODA query de consumo passe a
-- filtrar excluido_omie no JOIN, senao itens orfaos de pedidos excluidos
-- continuariam sendo somados.
--
-- Hoje (2026-04-29) ja existem 100 pedidos Q2P com excluido_omie=true. Sem
-- esse filtro, os itens deles estao inflando o consumo medio diario.
--
-- Mudanca: adiciona AND COALESCE(p.excluido_omie, false) = false em todos os 6
-- SUMs da funcao calcular_consumo_medio_diario_kg (3 camadas × 2 empresas).
-- Resto da funcao identico a 0021.

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
          AND COALESCE(p.excluido_omie,   false) = false
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
          AND COALESCE(p.excluido_omie,   false) = false
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
          AND COALESCE(p.excluido_omie,   false) = false
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
          AND COALESCE(p.excluido_omie,   false) = false
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
              AND COALESCE(p.excluido_omie,   false) = false
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
              AND COALESCE(p.excluido_omie,   false) = false
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
  'Retorna (consumo numeric, camada text) via fallback de 3 camadas (70/30, 90d, 365d). Filtra cancelado/devolvido/denegado/excluido_omie. Camada NULL = sem dados.';

-- Backfill imediato pra reaplicar o filtro nos valores ja salvos
UPDATE stockbridge.config_produto c
SET (consumo_medio_diario_kg, camada_consumo, updated_at) = (
    SELECT calc.consumo, calc.camada, now()
    FROM stockbridge.calcular_consumo_medio_diario_kg(c.produto_codigo_acxe) AS calc
);
