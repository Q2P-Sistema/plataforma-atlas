-- Migration: 023 StockBridge — adiciona Q2P_Filial + corrige intercompany Q2P matriz
--
-- Mudancas em calcular_consumo_medio_diario_kg:
--
-- A) Adiciona Q2P_Filial como terceira fonte de vendas (alem de Q2P matriz e
--    ACXE-externa). Filial faturou no passado e nao deve voltar a faturar — o
--    bloco serve principalmente pra enriquecer historico (camadas mes-ano-
--    anterior e 365d). Match por descricao via tbl_produtos_Q2P_Filial.
--
-- B) Corrige intercompany Q2P matriz: a versao anterior nao filtrava vendas
--    Q2P matriz → ACXE (3 codigos) nem Q2P matriz → Filial (1 codigo). Eram
--    contadas como vendas externas. A correcao adiciona esses 4 codigos no
--    NOT IN das queries Q2P matriz.
--
-- C) Adiciona intercompany na Filial: filtra vendas Filial → ACXE
--    (4554041504) e Filial → Q2P matriz (4460161229).
--
-- Codigos de intercompany (mapeamento conhecido em 2026-04-29):
--   Vendido por Q2P matriz, recebido por ACXE:    8429046131, 3070534015, 8429031700
--   Vendido por Q2P matriz, recebido por Filial:  3105160549
--   Vendido por ACXE,        recebido por Q2P:    4151024070
--   Vendido por ACXE,        recebido por Filial: 4151026325
--   Vendido por Filial,      recebido por ACXE:   4554041504
--   Vendido por Filial,      recebido por Q2P:    4460161229
--
-- A tabela Filial NAO tem coluna excluido_omie (Rev 2.0 dos workflows ainda
-- nao foi migrada pra ela). Por isso o bloco Filial omite esse filtro.

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
    v_codigo_filial            bigint;

    -- Intercompany visto da ACXE (Q2P matriz + Q2P Filial)
    v_intercompany_acxe   bigint[] := ARRAY[4151024070, 4151026325]::bigint[];
    -- Intercompany visto da Q2P matriz (ACXE × 3 + Filial × 1)
    v_intercompany_q2p    bigint[] := ARRAY[8429046131, 3070534015, 8429031700, 3105160549]::bigint[];
    -- Intercompany visto da Filial (ACXE + Q2P matriz)
    v_intercompany_filial bigint[] := ARRAY[4554041504, 4460161229]::bigint[];
BEGIN
    SELECT descricao INTO v_descricao_acxe
    FROM public."tbl_produtos_ACXE"
    WHERE codigo_produto = p_codigo_acxe;

    IF v_descricao_acxe IS NULL THEN
        consumo := NULL; camada := NULL; RETURN NEXT; RETURN;
    END IF;

    -- Match Q2P matriz por descricao
    SELECT codigo_produto INTO v_codigo_q2p
    FROM public."tbl_produtos_Q2P"
    WHERE descricao = v_descricao_acxe
      AND (inativo IS NULL OR inativo <> 'S')
    LIMIT 1;

    -- Match Filial por descricao
    SELECT codigo_produto INTO v_codigo_filial
    FROM public."tbl_produtos_Q2P_Filial"
    WHERE descricao = v_descricao_acxe
      AND (inativo IS NULL OR inativo <> 'S')
    LIMIT 1;

    -- ── Vendas ultimos 90 dias ───────────────────────────────────────────
    -- Q2P matriz
    IF v_codigo_q2p IS NOT NULL THEN
        SELECT v_qtd_90d + COALESCE(SUM(i.quantidade), 0) INTO v_qtd_90d
        FROM public."tbl_pedidosVendas_Q2P" p
        JOIN public."tbl_pedidosVendas_itens_Q2P" i ON i.codigo_pedido = p.codigo_pedido
        WHERE i.codigo_produto = v_codigo_q2p
          AND p.faturado = 'S'
          AND COALESCE(p.cancelado,         'N') <> 'S'
          AND COALESCE(p.devolvido,         'N') <> 'S'
          AND COALESCE(p.devolvido_parcial, 'N') <> 'S'
          AND COALESCE(p.denegado,          'N') <> 'S'
          AND COALESCE(p.excluido_omie,   false) = false
          AND p.codigo_cliente <> ALL(v_intercompany_q2p)
          AND p.dfat > now() - interval '90 days';
    END IF;

    -- ACXE externo
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
          AND p.codigo_cliente <> ALL(v_intercompany_acxe)
          AND p.dfat > now() - interval '90 days'
    ), 0);

    -- Q2P Filial (sem excluido_omie — coluna nao existe ainda)
    IF v_codigo_filial IS NOT NULL THEN
        v_qtd_90d := v_qtd_90d + COALESCE((
            SELECT SUM(i.quantidade)
            FROM public."tbl_pedidosVendas_Q2P_Filial" p
            JOIN public."tbl_pedidosVendas_itens_Q2P_Filial" i ON i.codigo_pedido = p.codigo_pedido
            WHERE i.codigo_produto = v_codigo_filial
              AND p.faturado = 'S'
              AND COALESCE(p.cancelado,         'N') <> 'S'
              AND COALESCE(p.devolvido,         'N') <> 'S'
              AND COALESCE(p.devolvido_parcial, 'N') <> 'S'
              AND COALESCE(p.denegado,          'N') <> 'S'
              AND p.codigo_cliente <> ALL(v_intercompany_filial)
              AND p.dfat > now() - interval '90 days'
        ), 0);
    END IF;

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
          AND p.codigo_cliente <> ALL(v_intercompany_q2p)
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
          AND p.codigo_cliente <> ALL(v_intercompany_acxe)
          AND p.dfat BETWEEN v_data_inicio_mes_anterior AND v_data_fim_mes_anterior
    ), 0);

    IF v_codigo_filial IS NOT NULL THEN
        v_qtd_mes_ano_anterior := v_qtd_mes_ano_anterior + COALESCE((
            SELECT SUM(i.quantidade)
            FROM public."tbl_pedidosVendas_Q2P_Filial" p
            JOIN public."tbl_pedidosVendas_itens_Q2P_Filial" i ON i.codigo_pedido = p.codigo_pedido
            WHERE i.codigo_produto = v_codigo_filial
              AND p.faturado = 'S'
              AND COALESCE(p.cancelado,         'N') <> 'S'
              AND COALESCE(p.devolvido,         'N') <> 'S'
              AND COALESCE(p.devolvido_parcial, 'N') <> 'S'
              AND COALESCE(p.denegado,          'N') <> 'S'
              AND p.codigo_cliente <> ALL(v_intercompany_filial)
              AND p.dfat BETWEEN v_data_inicio_mes_anterior AND v_data_fim_mes_anterior
        ), 0);
    END IF;

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
              AND p.codigo_cliente <> ALL(v_intercompany_q2p)
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
              AND p.codigo_cliente <> ALL(v_intercompany_acxe)
              AND p.dfat > now() - interval '365 days'
        ), 0);

        IF v_codigo_filial IS NOT NULL THEN
            v_qtd_365d := v_qtd_365d + COALESCE((
                SELECT SUM(i.quantidade)
                FROM public."tbl_pedidosVendas_Q2P_Filial" p
                JOIN public."tbl_pedidosVendas_itens_Q2P_Filial" i ON i.codigo_pedido = p.codigo_pedido
                WHERE i.codigo_produto = v_codigo_filial
                  AND p.faturado = 'S'
                  AND COALESCE(p.cancelado,         'N') <> 'S'
                  AND COALESCE(p.devolvido,         'N') <> 'S'
                  AND COALESCE(p.devolvido_parcial, 'N') <> 'S'
                  AND COALESCE(p.denegado,          'N') <> 'S'
                  AND p.codigo_cliente <> ALL(v_intercompany_filial)
                  AND p.dfat > now() - interval '365 days'
            ), 0);
        END IF;
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
  'Retorna (consumo, camada) somando 3 fontes (Q2P matriz + ACXE externa + Q2P Filial historica), com filtros de status e intercompany por empresa. Match por descricao em cada empresa.';

-- Backfill apos as coletas Q2P+Filial terminarem
UPDATE stockbridge.config_produto c
SET (consumo_medio_diario_kg, camada_consumo, updated_at) = (
    SELECT calc.consumo, calc.camada, now()
    FROM stockbridge.calcular_consumo_medio_diario_kg(c.produto_codigo_acxe) AS calc
);
