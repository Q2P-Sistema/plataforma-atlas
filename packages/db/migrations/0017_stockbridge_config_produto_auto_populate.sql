-- Migration: 017 StockBridge — familia_omie_atlas + auto-popular config_produto via vendas
--
-- Contexto:
-- 1. stockbridge.config_produto guarda configuracao por SKU (consumo medio diario,
--    lead time). Hoje produtos novos sincronizados de public.tbl_produtos_ACXE nao
--    geram linha — cockpit/metricas silenciosamente sem cobertura.
-- 2. familia_categoria (campo per-produto) era duplicado para todo SKU da mesma
--    familia OMIE. Vira lookup table dedicada (familia_omie_atlas) — single source
--    of truth, edicao em 1 lugar so.
-- 3. consumo_medio_diario_kg passa a ser CALCULADO via vendas reais (composicao
--    70/30 entre ultimos 90 dias e mesmo mes do ano anterior). Default 100 quando
--    sem historico.
--
-- Detalhes:
-- - Vendas consideram ACXE + Q2P matriz, EXCLUINDO vendas ACXE→Q2P
--   (codigos cliente 4151024070 e 4151026325) — intercompany nao conta.
-- - Match Q2P↔ACXE por descricao textual (mesma regra do correlacao.service.ts).
-- - Backfill so cria linha em config_produto para familias com incluir_em_metricas=true.
-- - Familias desativadas (STRETCH, INDUSTRIALIZADO, USO E CONSUMO, etc.) ficam
--   registradas em familia_omie_atlas para rastreabilidade, mas seus produtos NAO
--   entram em config_produto.

-- Defesa: caso versao anterior do 0017 tenha sido rodada, limpa antes de recriar.
DROP TRIGGER IF EXISTS trg_auto_popular_config_produto ON public."tbl_produtos_ACXE";
DROP FUNCTION IF EXISTS stockbridge.auto_popular_config_produto();
DROP FUNCTION IF EXISTS stockbridge.calcular_consumo_medio_diario_kg(bigint);

-- ── 1. Tabela de mapping familia OMIE → familia Atlas ────────────────────────
CREATE TABLE IF NOT EXISTS stockbridge.familia_omie_atlas (
    familia_omie         text PRIMARY KEY,
    familia_atlas        text NOT NULL,
    incluir_em_metricas  boolean NOT NULL DEFAULT true,
    observacao           text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_sb_familia_omie_atlas_updated_at ON stockbridge.familia_omie_atlas;
CREATE TRIGGER trg_sb_familia_omie_atlas_updated_at
    BEFORE UPDATE ON stockbridge.familia_omie_atlas
    FOR EACH ROW EXECUTE FUNCTION stockbridge.set_updated_at();

COMMENT ON TABLE stockbridge.familia_omie_atlas IS
  'Mapping familia OMIE (texto vindo do sync) → familia Atlas macro (PE/PP/PS/PET/ABS/etc). incluir_em_metricas=false marca familia inteira como excluida do cockpit/metricas (USO E CONSUMO, ATIVO IMOBILIZADO, etc.).';

-- ── 2. Popula mapping inicial ────────────────────────────────────────────────
INSERT INTO stockbridge.familia_omie_atlas (familia_omie, familia_atlas, incluir_em_metricas, observacao) VALUES
    -- PE — Polietileno
    ('PEAD FILME',            'PE',          true,  NULL),
    ('PEAD SOPRO',            'PE',          true,  NULL),
    ('PEAD INJ 8',            'PE',          true,  NULL),
    ('PEAD INJ 20',           'PE',          true,  NULL),
    ('PEAD EXTRUSÃO',         'PE',          true,  NULL),
    ('PEBD CONV C/D',         'PE',          true,  NULL),
    ('PEBD CONV S/D',         'PE',          true,  NULL),
    ('PEBD IND',              'PE',          true,  NULL),
    ('PEBD INJ 20',           'PE',          true,  NULL),
    ('PEBD INJ 50',           'PE',          true,  NULL),
    ('PEBD COATING',          'PE',          true,  NULL),
    ('PELBD C/D',             'PE',          true,  NULL),
    ('PELBD S/D',             'PE',          true,  NULL),
    ('PELBD METALOCENO C/D',  'PE',          true,  NULL),
    ('PELBD METALOCENO S/D',  'PE',          true,  NULL),
    ('PELBD ANTIESTÁTICO',    'PE',          true,  NULL),
    ('MATERIA PRIMA PEAD',    'PE',          true,  'Sucata/borra/reciclado'),

    -- PP — Polipropileno
    ('PP RAFIA',              'PP',          true,  NULL),
    ('PP HOMO 35',            'PP',          true,  NULL),
    ('PP HOMO 25',            'PP',          true,  NULL),
    ('PP HOMO 12',            'PP',          true,  NULL),
    ('PP HOMO 40',            'PP',          true,  NULL),
    ('PP HOMO 59',            'PP',          true,  NULL),
    ('PP HOMO 1,5',           'PP',          true,  NULL),
    ('PP RANDOM',             'PP',          true,  NULL),
    ('PP COPO 40',            'PP',          true,  NULL),
    ('PP COPO 7',             'PP',          true,  NULL),
    ('PP COPO EXTRUSÃO',      'PP',          true,  NULL),
    ('PP FILME',              'PP',          true,  NULL),
    ('PP PRETO',              'PP',          true,  NULL),
    ('MATERIA PRIMA PP',      'PP',          true,  NULL),

    -- PS / PET / ABS
    ('PS CRISTAL',            'PS',          true,  NULL),
    ('PS REC',                'PS',          true,  NULL),
    ('PET NOVO',              'PET',         true,  NULL),
    ('PET REC',               'PET',         true,  NULL),
    ('ABS NOVO',              'ABS',         true,  NULL),

    -- Auxiliares
    ('ADITIVO',               'ADITIVO',     true,  NULL),
    ('PIGMENTO',              'PIGMENTO',    true,  NULL),

    -- Desativados (registrados para rastreabilidade)
    ('STRETCH',               'PE',          false, 'Produto final, nao MP — desativado'),
    ('INDUSTRIALIZADO',       'CPT',         false, 'Compostos terceirizados ACXE-only — desativado'),
    ('USO E CONSUMO',         'OPERACIONAL', false, 'Material de escritorio/operacao'),
    ('ATIVO IMOBILIZADO',     'OPERACIONAL', false, NULL),
    ('UNIFORMES',             'OPERACIONAL', false, NULL),
    ('LOCAÇÃO',               'OPERACIONAL', false, NULL)
ON CONFLICT (familia_omie) DO NOTHING;

-- ── 3. DROP coluna familia_categoria de config_produto ───────────────────────
-- A categoria agora vem do JOIN com familia_omie_atlas via tbl_produtos_ACXE.descricao_familia.
ALTER TABLE stockbridge.config_produto DROP COLUMN IF EXISTS familia_categoria;

-- ── 4. Funcao para calcular consumo medio diario via vendas ──────────────────
-- Composicao 70/30:
--   70% × (vendas_ultimos_90d / 90)
-- + 30% × (vendas_mesmo_mes_ano_anterior / dias_do_mes)
--
-- Vendas = soma de Q2P + ACXE, excluindo intercompany (ACXE→Q2P matriz/filial).
-- Match Q2P→ACXE por descricao textual.
-- Retorna NULL se produto nao tiver venda em nenhum dos dois periodos
-- (caller usa COALESCE com default).

CREATE OR REPLACE FUNCTION stockbridge.calcular_consumo_medio_diario_kg(p_codigo_acxe bigint)
RETURNS numeric
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_qtd_90d                  numeric := 0;
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

    -- Match Q2P por descricao textual
    SELECT codigo_produto INTO v_codigo_q2p
    FROM public."tbl_produtos_Q2P"
    WHERE descricao = v_descricao_acxe
      AND (inativo IS NULL OR inativo <> 'S')
    LIMIT 1;

    -- ── Vendas ultimos 90 dias ───────────────────────────────────────────
    -- Q2P (vendas externas; nao tem intercompany pra excluir)
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

    -- ACXE (exclui vendas para Q2P matriz/filial — intercompany)
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

    -- ── Composicao B (70/30) ─────────────────────────────────────────────
    IF v_qtd_90d = 0 AND v_qtd_mes_ano_anterior = 0 THEN
        RETURN NULL;
    END IF;

    RETURN ROUND(
        0.7 * (v_qtd_90d / 90.0) +
        0.3 * (v_qtd_mes_ano_anterior::numeric / GREATEST(v_dias_mes_ano_anterior, 1)),
        2
    );
END;
$$;

COMMENT ON FUNCTION stockbridge.calcular_consumo_medio_diario_kg(bigint) IS
  'Calcula consumo medio diario em kg via composicao 70% recente (90d) + 30% sazonal (mesmo mes ano anterior). Soma vendas Q2P + ACXE, exclui intercompany (ACXE→Q2P). Retorna NULL se produto nao tem venda nos dois periodos.';

-- ── 5. Trigger AFTER INSERT em tbl_produtos_ACXE ─────────────────────────────
-- Cria linha em config_produto so se a familia OMIE estiver ativa em
-- familia_omie_atlas. Defaults sao 100/90 — produto novo nao tem historico
-- de vendas, entao calcular_consumo_medio retornaria NULL e cairia no default.

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
        VALUES (NEW.codigo_produto, 100, 90, true)
        ON CONFLICT (produto_codigo_acxe) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_popular_config_produto
    AFTER INSERT ON public."tbl_produtos_ACXE"
    FOR EACH ROW
    EXECUTE FUNCTION stockbridge.auto_popular_config_produto();

COMMENT ON FUNCTION stockbridge.auto_popular_config_produto() IS
  'Cria linha em stockbridge.config_produto para produtos ACXE novos cuja familia OMIE esta marcada como incluir_em_metricas=true. Defaults: 100 kg/dia consumo, 90 dias lead time, incluir_em_metricas=true.';

-- ── 6. Backfill ──────────────────────────────────────────────────────────────
-- Cria config_produto para todos os produtos ACXE ativos cuja familia esta ativa.
-- Calcula consumo via vendas reais; cai pra default 100 quando NULL (produto sem
-- historico). Idempotente — ON CONFLICT DO NOTHING.

INSERT INTO stockbridge.config_produto (
    produto_codigo_acxe, consumo_medio_diario_kg, lead_time_dias, incluir_em_metricas
)
SELECT
    p.codigo_produto,
    COALESCE(stockbridge.calcular_consumo_medio_diario_kg(p.codigo_produto), 100),
    90,
    true
FROM public."tbl_produtos_ACXE" p
INNER JOIN stockbridge.familia_omie_atlas f
    ON f.familia_omie = p.descricao_familia
    AND f.incluir_em_metricas = true
WHERE (p.inativo IS NULL OR p.inativo <> 'S')
ON CONFLICT (produto_codigo_acxe) DO NOTHING;
