-- Migration: 019 StockBridge — fallback de 3 camadas no calculo de consumo medio + NULL como sinal explicito
--
-- Contexto:
-- A funcao calcular_consumo_medio_diario_kg da migration 0017 usava composicao 70/30
-- (90d + mesmo mes ano anterior). Problema descoberto na validacao com dados reais:
-- o sync OMIE so tem historico desde Mai/2025. Em Abr/2026, "mesmo mes ano anterior"
-- cai num mes praticamente vazio, e janela 90d cai em Jan-Abr/2026. Produtos com
-- vendas substanciais em Mai-Dez/2025 (fora de ambas as janelas) ficavam zerados e
-- caiam no default 100 kg/dia — subestimando dramaticamente.
--
-- Solucao: fallback em 3 camadas. Tambem removemos o "default 100" do refresh e
-- trigger; produto sem dados em nenhuma camada agora grava NULL (sinal explicito
-- de "Sem dados" na UI), em vez de mascarar com 100 que confunde diretor.
--
-- Camadas:
--   1. mes_ano_anterior > 0  →  composicao 70/30 (preferida — captura sazonalidade)
--   2. senao, 90d > 0        →  90d puro (tendencia recente sem termo sazonal vazio)
--   3. senao, 365d > 0       →  365d puro (historico longo prazo, captura quem
--                                vendeu no ano mas parou nos ultimos 90 dias)
--   4. senao                 →  NULL (genuinamente sem dados)
--
-- Caller (refresh + trigger) NAO faz mais COALESCE com 100. UI exibe "Sem dados".

-- ── 1. Recria funcao com fallback de 3 camadas ──────────────────────────────
DROP FUNCTION IF EXISTS stockbridge.calcular_consumo_medio_diario_kg(bigint);

CREATE OR REPLACE FUNCTION stockbridge.calcular_consumo_medio_diario_kg(p_codigo_acxe bigint)
RETURNS numeric
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
    -- Codigos cliente Q2P na tabela ACXE (intercompany)
    v_q2p_matriz               bigint := 4151024070;
    v_q2p_filial               bigint := 4151026325;
BEGIN
    SELECT descricao INTO v_descricao_acxe
    FROM public."tbl_produtos_ACXE"
    WHERE codigo_produto = p_codigo_acxe;

    IF v_descricao_acxe IS NULL THEN
        RETURN NULL;
    END IF;

    -- Match Q2P por descricao textual (codigos OMIE sao aleatorios por empresa)
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

    -- ── Vendas ultimos 365 dias (camada 3 — fallback final) ──────────────
    -- Calculado so se as camadas 1 e 2 nao tiverem dados; otimiza nao pagar
    -- esse SUM no caso comum onde 90d ja basta.
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
        -- Camada 1: composicao 70/30 (preferida — pondera recente + sazonal)
        RETURN ROUND(
            0.7 * (v_qtd_90d / 90.0) +
            0.3 * (v_qtd_mes_ano_anterior::numeric / GREATEST(v_dias_mes_ano_anterior, 1)),
            2
        );
    ELSIF v_qtd_90d > 0 THEN
        -- Camada 2: 90d puro (tendencia recente, sem termo sazonal vazio puxando pra zero)
        RETURN ROUND(v_qtd_90d / 90.0, 2);
    ELSIF v_qtd_365d > 0 THEN
        -- Camada 3: 365d puro (historico longo — captura quem vendeu no ano mas parou)
        RETURN ROUND(v_qtd_365d / 365.0, 2);
    ELSE
        -- Genuinamente sem dados
        RETURN NULL;
    END IF;
END;
$$;

COMMENT ON FUNCTION stockbridge.calcular_consumo_medio_diario_kg(bigint) IS
  'Calcula consumo medio diario em kg via fallback de 3 camadas: (1) composicao 70/30 com mesmo mes ano anterior, (2) 90d puro, (3) 365d puro. Retorna NULL se sem vendas em 365d. Soma Q2P+ACXE excluindo intercompany. Match Q2P por descricao.';

-- ── 2. Recria trigger AFTER INSERT — produto novo entra com NULL ─────────────
-- Em vez de default 100 kg/dia, deixa NULL pra UI exibir "Sem dados". Diretor
-- entende que produto novo nao tem historico, em vez de pensar que 100 e estimativa.

CREATE OR REPLACE FUNCTION stockbridge.auto_popular_config_produto()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_familia_ativa boolean;
BEGIN
    SELECT incluir_em_metricas INTO v_familia_ativa
    FROM stockbridge.familia_omie_atlas
    WHERE familia_omie = NEW.descricao_familia;

    IF v_familia_ativa IS TRUE THEN
        INSERT INTO stockbridge.config_produto (
            produto_codigo_acxe, consumo_medio_diario_kg, lead_time_dias, incluir_em_metricas
        )
        VALUES (NEW.codigo_produto, NULL, 90, true)
        ON CONFLICT (produto_codigo_acxe) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION stockbridge.auto_popular_config_produto() IS
  'Cria linha em stockbridge.config_produto para produtos ACXE novos cuja familia OMIE esta marcada incluir_em_metricas=true. consumo_medio_diario_kg fica NULL (UI exibe "Sem dados") ate o proximo refresh popular via vendas reais.';

-- ── 3. Recria refresh removendo COALESCE com 100 ─────────────────────────────
-- Guarda NULL puro quando a funcao retornar NULL — UI exibe "Sem dados" em vez
-- de simular 100 kg/dia que confundia diretor (parecia estimativa real).

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
        SET consumo_medio_diario_kg =
                stockbridge.calcular_consumo_medio_diario_kg(c.produto_codigo_acxe),
            updated_at = now();

        GET DIAGNOSTICS v_count = ROW_COUNT;
    END IF;

    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION stockbridge.refresh_consumo_medio_se_stale(integer) IS
  'Recalcula consumo_medio_diario_kg de todos os produtos em config_produto se MAX(updated_at) for mais antigo que p_ttl_minutes. Grava NULL puro quando calcular_consumo_medio_diario_kg retornar NULL (UI exibe "Sem dados").';

-- ── 4. Refresh imediato — recalcula todos com a nova funcao ──────────────────
UPDATE stockbridge.config_produto c
SET consumo_medio_diario_kg = stockbridge.calcular_consumo_medio_diario_kg(c.produto_codigo_acxe),
    updated_at = now();
