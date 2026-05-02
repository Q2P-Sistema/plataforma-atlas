-- Migration: 024 StockBridge — popula stockbridge.lote em trânsito a partir do FUP
--
-- Contexto:
-- O modulo StockBridge tem UI/listagem/promoção de lotes em trânsito (status='transito',
-- estagio_transito ∈ {transito_intl, porto_dta, transito_interno, reservado}), mas
-- nenhum codigo cria esses lotes — havia um buraco. Em produção, a fonte é a planilha
-- FUP de Comex (`tbl_dadosPlanilhaFUPComex`), atualizada várias vezes ao dia por
-- workflow externo. Os produtos+quantidades reais vêm via JOIN com pedidosCompras
-- (`tbl_pedidosCompras_ACXE.cnumero = fup.pedido_acxe_omie`).
--
-- Esta migration:
-- 1. Adiciona coluna `pedido_compra_acxe` em `stockbridge.lote` pra rastrear origem
--    + UNIQUE INDEX parcial pra UPSERT por (pedido, produto).
-- 2. Recria localidade virtual `90.0.2 TRÂNSITO` (removida em sessão anterior — agora
--    é necessária como destino de lotes em trânsito antes de chegar na localidade física).
-- 3. Cria função `stockbridge.refresh_lotes_em_transito_se_stale(ttl_minutes)` que
--    le FUP×pedidosCompras_ACXE e UPSERT em `lote` (status=transito). Soft-delete
--    em lotes que saíram da janela (avançaram pra "04 - Aguardando Finalização" ou
--    cancelados). Padrão idêntico ao `refresh_consumo_medio_se_stale` (TTL→no-op).
-- 4. Backfill imediato.
--
-- Mapeamento etapa_global FUP → estagio_transito Atlas:
--   '02 - Em Águas'                                      → transito_intl
--   '03 - Nacionalização' + etapa LIKE '22%'             → transito_interno
--   '03 - Nacionalização' + outras etapas (20/21/24)     → porto_dta
--   '04 - Aguardando Finalização Financeiro' / encerrado → fora da janela (soft-delete)
--   '01 - Aguardando Booking' / cancelado                → fora da janela
--
-- Localidade do lote em trânsito:
--   - Sempre 90.0.2 TRÂNSITO no insert (lote ainda não chegou em localidade física)
--   - Quando operador avança pra `transito_interno` ou recebe a NF, ele move pra
--     localidade física via avancarEstagio() ou recebimento.
--   - O UPDATE do refresh NÃO mexe em localidade_id se operador já mudou
--     (preservada por estar fora do SET).

-- ── 1. Coluna pedido_compra_acxe + UNIQUE INDEX parcial ──────────────────────
ALTER TABLE stockbridge.lote
    ADD COLUMN IF NOT EXISTS pedido_compra_acxe text;

COMMENT ON COLUMN stockbridge.lote.pedido_compra_acxe IS
  'Numero do pedido de compra ACXE (cnumero em tbl_pedidosCompras_ACXE) quando o lote vem do FUP. NULL para lotes criados via recebimento direto.';

CREATE UNIQUE INDEX IF NOT EXISTS lote_uq_pedido_compra_produto
  ON stockbridge.lote (pedido_compra_acxe, produto_codigo_acxe)
  WHERE pedido_compra_acxe IS NOT NULL;

-- ── 2. Recria localidade virtual 90.0.2 TRÂNSITO ─────────────────────────────
INSERT INTO stockbridge.localidade (codigo, nome, tipo, cnpj, ativo)
VALUES ('90.0.2', 'TRÂNSITO', 'virtual_transito', NULL, true)
ON CONFLICT (codigo) DO UPDATE SET
  nome = EXCLUDED.nome,
  tipo = EXCLUDED.tipo,
  ativo = true,
  updated_at = now();

-- ── 3. Função de refresh com TTL ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION stockbridge.refresh_lotes_em_transito_se_stale(
    p_ttl_minutes integer DEFAULT 15
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_max_updated     timestamptz;
    v_count_upsert    integer := 0;
    v_count_softdel   integer := 0;
    v_loc_transito_id uuid;
BEGIN
    SELECT MAX(updated_at) INTO v_max_updated
    FROM stockbridge.lote
    WHERE pedido_compra_acxe IS NOT NULL;

    IF v_max_updated IS NOT NULL
       AND v_max_updated > now() - (p_ttl_minutes || ' minutes')::interval THEN
        RETURN 0;
    END IF;

    SELECT id INTO v_loc_transito_id
    FROM stockbridge.localidade
    WHERE codigo = '90.0.2' AND tipo = 'virtual_transito'
    LIMIT 1;

    IF v_loc_transito_id IS NULL THEN
        RAISE EXCEPTION 'Localidade virtual 90.0.2 TRANSITO nao encontrada — esperada pra ancorar lotes em trânsito';
    END IF;

    -- UPSERT dos lotes em trânsito
    WITH upserted AS (
        INSERT INTO stockbridge.lote (
            codigo, produto_codigo_acxe, fornecedor_nome, pais_origem,
            quantidade_fisica_kg, quantidade_fiscal_kg, custo_brl_kg,
            status, estagio_transito, localidade_id, cnpj,
            di, dt_entrada, dt_prev_chegada,
            pedido_compra_acxe
        )
        SELECT
            'F-' || fup.pedido_acxe_omie || '-' || pc.ncodprod                          AS codigo,
            pc.ncodprod                                                                  AS produto_codigo_acxe,
            COALESCE(fup.fornecedor, 'sem fornecedor')                                   AS fornecedor_nome,
            fup.pais_origem,
            pc.nqtde                                                                     AS quantidade_fisica_kg,
            pc.nqtde                                                                     AS quantidade_fiscal_kg,
            CASE WHEN fup.volume_total_kg > 0
                 THEN ROUND((fup.valor_total_reais / fup.volume_total_kg)::numeric, 4)
                 ELSE NULL END                                                           AS custo_brl_kg,
            'transito'                                                                   AS status,
            CASE
                WHEN fup.etapa_global = '02 - Em Águas'                       THEN 'transito_intl'
                WHEN fup.etapa_global = '03 - Nacionalização'
                     AND fup.etapa LIKE '22%'                                 THEN 'transito_interno'
                WHEN fup.etapa_global = '03 - Nacionalização'                 THEN 'porto_dta'
            END                                                                          AS estagio_transito,
            v_loc_transito_id                                                            AS localidade_id,
            'acxe'                                                                       AS cnpj,
            fup.numero_di                                                                AS di,
            COALESCE(fup.data_importacao::date, CURRENT_DATE)                            AS dt_entrada,
            COALESCE(fup.eta, fup.eta_estimado)                                          AS dt_prev_chegada,
            fup.pedido_acxe_omie                                                         AS pedido_compra_acxe
        FROM public."tbl_dadosPlanilhaFUPComex" fup
        JOIN public."tbl_pedidosCompras_ACXE" pc ON pc.cnumero = fup.pedido_acxe_omie
        WHERE fup.etapa_global IN ('02 - Em Águas', '03 - Nacionalização')
        ON CONFLICT (pedido_compra_acxe, produto_codigo_acxe)
        WHERE pedido_compra_acxe IS NOT NULL
        DO UPDATE SET
            estagio_transito     = EXCLUDED.estagio_transito,
            quantidade_fisica_kg = EXCLUDED.quantidade_fisica_kg,
            quantidade_fiscal_kg = EXCLUDED.quantidade_fiscal_kg,
            custo_brl_kg         = EXCLUDED.custo_brl_kg,
            fornecedor_nome      = EXCLUDED.fornecedor_nome,
            pais_origem          = EXCLUDED.pais_origem,
            di                   = EXCLUDED.di,
            dt_prev_chegada      = EXCLUDED.dt_prev_chegada,
            ativo                = true,
            updated_at           = now()
        -- Preserva localidade_id se operador já moveu pra física durante transito_interno
        -- (não sobrescreve no UPDATE)
        WHERE stockbridge.lote.status = 'transito'  -- só atualiza se ainda em trânsito
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_count_upsert FROM upserted;

    -- Soft delete pra lotes que sumiram da janela (foram pra '04' / encerrados / cancelados)
    -- mas só pra os que ainda estão em status='transito' (preserva os já recebidos)
    UPDATE stockbridge.lote l
    SET ativo = false, updated_at = now()
    WHERE l.pedido_compra_acxe IS NOT NULL
      AND l.ativo = true
      AND l.status = 'transito'
      AND NOT EXISTS (
        SELECT 1 FROM public."tbl_dadosPlanilhaFUPComex" fup
        WHERE fup.pedido_acxe_omie = l.pedido_compra_acxe
          AND fup.etapa_global IN ('02 - Em Águas', '03 - Nacionalização')
      );

    GET DIAGNOSTICS v_count_softdel = ROW_COUNT;

    RETURN v_count_upsert + v_count_softdel;
END;
$$;

COMMENT ON FUNCTION stockbridge.refresh_lotes_em_transito_se_stale(integer) IS
  'Le FUP × pedidosCompras_ACXE e UPSERT em stockbridge.lote (status=transito). Soft-delete em lotes que saíram da janela. TTL: no-op se MAX(updated_at) > now() - ttl_minutes. Caller: GET /transito do StockBridge.';

-- ── 4. Backfill imediato ─────────────────────────────────────────────────────
SELECT stockbridge.refresh_lotes_em_transito_se_stale(0) AS backfill_count;
