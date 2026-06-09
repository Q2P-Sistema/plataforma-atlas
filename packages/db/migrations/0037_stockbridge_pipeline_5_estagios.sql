-- Migration: 0037 — StockBridge: pipeline 5 estágios
--
-- Antes (migration 0036):
--   FUP só em '02 - Em Águas' → transito_intl
--   NFs emitidas não recebidas → porto_dta
--   Pipeline UI: 3 estágios (Trânsito Intl → Nacionalização → Disponível)
--
-- Agora: 5 estágios operacionais mapeados diretamente da FUP:
--   01 - Aguardando Booking  → aguardando_embarque  (pedido feito, booking pendente)
--   02 - Em Águas            → transito_intl          (em rota marítima)
--   03 / etapa 20,30,31      → no_porto               (porto, DTA, sem NF ainda)
--   NF emitida + não recv    → porto_dta              (NF ok, aguardando recebimento)
--
-- FUP 03 subdividido pela `etapa` (sub-estágio):
--   20 - Aguardando Registro DI          → no_porto    (sem NF ainda)
--   30 - Aguardando Registro DTA/Remoção → no_porto    (sem NF ainda)
--   31 - Material em Porto Seco          → no_porto    (sem NF ainda)
--   21 - Aguardando Exoneração de ICMS   → NÃO criar lote FUP (NF mãe emitida —
--                                          material já capturado como porto_dta via NF-tracking)
--   22 - Aguardando Recebimento no Galpão → idem (NF mãe + filhote emitidas)
--   23 - Aguardando Devolução Containers → NÃO criar lote (já entregue no galpão —
--                                          OMIE tem saldo físico)
--   04/05 → não rastrear (NF-tracking assume a partir da emissão da NF)
--
-- Transições automáticas (exemplo):
--   Pedido avança 01→02: ON CONFLICT DO UPDATE seta estagio_transito='transito_intl'
--   Pedido avança 03/etapa=20→03/etapa=21: soft-delete do lote no_porto;
--     o NF-tracking cria porto_dta automaticamente quando a NF aparecer.
--
-- Remove também: rastreamento OMIE 90.0.2 do cockpit (cockpit.service.ts):
--   transito_interno_kg passa a ser só lotes Atlas com estagio='transito_interno'
--   (vazio após esta migration — eliminando dupla contagem com porto_dta).

-- ── Reescrever refresh_lotes_em_transito_se_stale ────────────────────────────
CREATE OR REPLACE FUNCTION stockbridge.refresh_lotes_em_transito_se_stale(
    p_ttl_minutes integer DEFAULT 15
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_max_updated      timestamptz;
    v_loc_transito_id  uuid;
    v_count_fup        integer := 0;
    v_count_nf         integer := 0;
    v_count_softdel    integer := 0;
    v_count_softdel_nf integer := 0;
BEGIN
    SELECT MAX(updated_at) INTO v_max_updated
    FROM stockbridge.lote
    WHERE pedido_compra_acxe IS NOT NULL OR nf_origem_id IS NOT NULL;

    IF v_max_updated IS NOT NULL
       AND v_max_updated > now() - (p_ttl_minutes || ' minutes')::interval THEN
        RETURN 0;
    END IF;

    SELECT id INTO v_loc_transito_id
    FROM stockbridge.localidade
    WHERE codigo = '90.0.2' AND tipo = 'virtual_transito'
    LIMIT 1;

    IF v_loc_transito_id IS NULL THEN
        RAISE EXCEPTION 'Localidade virtual 90.0.2 TRANSITO nao encontrada';
    END IF;

    -- ── Parte 1: FUP — 3 estágios ativos em único UPSERT ────────────────────
    -- CASE determina estagio_transito.
    -- ON CONFLICT DO UPDATE seta estagio_transito = EXCLUDED tratando
    -- transições (01→02, 02→03/etapa=20) sem criar duplicatas.
    --
    -- Incluídos:
    --   etapa_global '01' e '02' completos
    --   etapa_global '03' SOMENTE quando etapa LIKE '20%', '30%' ou '31%'
    --     (sem NF emitida; etapa 21/22 já cobertos por porto_dta via NF-tracking;
    --      etapa 23 já entregue no galpão)
    WITH upserted AS (
        INSERT INTO stockbridge.lote (
            codigo, produto_codigo_acxe, fornecedor_nome, pais_origem,
            quantidade_fisica_kg, quantidade_fiscal_kg, custo_brl_kg,
            status, estagio_transito, localidade_id, cnpj,
            di, dt_entrada, dt_prev_chegada, pedido_compra_acxe
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
                WHEN fup.etapa_global = '01 - Aguardando Booking' THEN 'aguardando_embarque'
                WHEN fup.etapa_global = '02 - Em Águas'           THEN 'transito_intl'
                WHEN fup.etapa_global = '03 - Nacionalização'     THEN 'no_porto'
            END                                                                          AS estagio_transito,
            v_loc_transito_id                                                            AS localidade_id,
            'acxe'                                                                       AS cnpj,
            fup.numero_di                                                                AS di,
            COALESCE(fup.data_importacao::date, CURRENT_DATE)                            AS dt_entrada,
            COALESCE(fup.eta, fup.eta_estimado)                                          AS dt_prev_chegada,
            fup.pedido_acxe_omie                                                         AS pedido_compra_acxe
        FROM public."tbl_dadosPlanilhaFUPComex" fup
        JOIN public."tbl_pedidosCompras_ACXE" pc ON pc.cnumero = fup.pedido_acxe_omie
        WHERE pc.ncodprod IS NOT NULL
          AND pc.nqtde > 0
          AND (
              fup.etapa_global IN ('01 - Aguardando Booking', '02 - Em Águas')
              OR (
                  fup.etapa_global = '03 - Nacionalização'
                  AND fup.etapa LIKE ANY(ARRAY['20%', '30%', '31%'])
              )
          )
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
        WHERE stockbridge.lote.status = 'transito'
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_count_fup FROM upserted;

    -- ── Parte 2: Nacionalização via NF (emitidas + não recebidas) ───────────
    -- Sem mudança em relação à migration 0036 — lotes porto_dta vêm de NFs de
    -- entrada emitidas nos últimos 90 dias que ainda não aparecem em
    -- tb_movimentacao_q2p_legado (mv_acxe=1 AND mv_q2p=1 AND ativo=1) nem em
    -- stockbridge.movimentacao (entrada_nf/entrada_manual).
    WITH nfs_em_aberto AS (
        SELECT
            h.n_id_nf,
            h.n_nf,
            h.dest_razao,
            h.d_emi,
            i.n_cod_prod,
            i.q_com
        FROM public."tbl_nf_header_ACXE" h
        JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
        WHERE h.tp_nf = 0
          AND h.deletada = false
          AND h.d_emi > (now() - interval '90 days')::date
          AND i.n_cod_prod IS NOT NULL
          AND i.q_com > 0
          AND NOT EXISTS (
              SELECT 1 FROM public."tb_movimentacao_q2p_legado" mv
              WHERE mv.nota_fiscal = h.n_nf::int
                AND mv.mv_acxe = 1 AND mv.mv_q2p = 1 AND mv.ativo = 1
          )
          AND NOT EXISTS (
              SELECT 1 FROM stockbridge.movimentacao m
              WHERE m.nota_fiscal = h.n_nf
                AND m.tipo_movimento IN ('entrada_nf', 'entrada_manual')
                AND m.ativo = true
          )
    ),
    upserted_nf AS (
        INSERT INTO stockbridge.lote (
            codigo, produto_codigo_acxe, fornecedor_nome,
            quantidade_fisica_kg, quantidade_fiscal_kg,
            status, estagio_transito, localidade_id, cnpj,
            dt_entrada, nf_origem_id
        )
        SELECT
            'N-' || n.n_nf || '-' || n.n_cod_prod                                        AS codigo,
            n.n_cod_prod                                                                  AS produto_codigo_acxe,
            COALESCE(n.dest_razao, 'sem fornecedor')                                      AS fornecedor_nome,
            n.q_com                                                                       AS quantidade_fisica_kg,
            n.q_com                                                                       AS quantidade_fiscal_kg,
            'transito'                                                                    AS status,
            'porto_dta'                                                                   AS estagio_transito,
            v_loc_transito_id                                                             AS localidade_id,
            'acxe'                                                                        AS cnpj,
            COALESCE(n.d_emi::date, CURRENT_DATE)                                         AS dt_entrada,
            n.n_id_nf                                                                     AS nf_origem_id
        FROM nfs_em_aberto n
        ON CONFLICT (nf_origem_id, produto_codigo_acxe)
            WHERE nf_origem_id IS NOT NULL
        DO UPDATE SET
            quantidade_fisica_kg = EXCLUDED.quantidade_fisica_kg,
            quantidade_fiscal_kg = EXCLUDED.quantidade_fiscal_kg,
            fornecedor_nome      = EXCLUDED.fornecedor_nome,
            ativo                = true,
            updated_at           = now()
        WHERE stockbridge.lote.status = 'transito'
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_count_nf FROM upserted_nf;

    -- ── Parte 3a: Soft-delete lotes FUP que saíram dos estágios rastreados ───
    -- Material soft-deletado quando:
    --   - saiu de '01'/'02' (avançou para '03' com etapa=21/22/23 ou '04'/'+)
    --   - OU estava em '03' / etapa=20/30/31 e avançou para etapa=21 (NF emitida):
    --     nesse caso porto_dta NF-based assume automaticamente
    UPDATE stockbridge.lote l
    SET ativo = false, updated_at = now()
    WHERE l.pedido_compra_acxe IS NOT NULL
      AND l.ativo = true
      AND l.status = 'transito'
      AND NOT EXISTS (
          SELECT 1 FROM public."tbl_dadosPlanilhaFUPComex" fup
          WHERE fup.pedido_acxe_omie = l.pedido_compra_acxe
            AND (
                fup.etapa_global IN ('01 - Aguardando Booking', '02 - Em Águas')
                OR (
                    fup.etapa_global = '03 - Nacionalização'
                    AND fup.etapa LIKE ANY(ARRAY['20%', '30%', '31%'])
                )
            )
      );
    GET DIAGNOSTICS v_count_softdel = ROW_COUNT;

    -- ── Parte 3b: Soft-delete lotes NF que foram recebidos ──────────────────
    -- Sem mudança em relação à migration 0036.
    UPDATE stockbridge.lote l
    SET ativo = false, updated_at = now()
    WHERE l.nf_origem_id IS NOT NULL
      AND l.ativo = true
      AND l.status = 'transito'
      AND EXISTS (
          SELECT 1 FROM public."tbl_nf_header_ACXE" h
          WHERE h.n_id_nf = l.nf_origem_id
            AND (
                EXISTS (
                    SELECT 1 FROM public."tb_movimentacao_q2p_legado" mv
                    WHERE mv.nota_fiscal = h.n_nf::int
                      AND mv.mv_acxe = 1 AND mv.mv_q2p = 1 AND mv.ativo = 1
                )
                OR EXISTS (
                    SELECT 1 FROM stockbridge.movimentacao m
                    WHERE m.nota_fiscal = h.n_nf
                      AND m.tipo_movimento IN ('entrada_nf', 'entrada_manual')
                      AND m.ativo = true
                )
            )
      );
    GET DIAGNOSTICS v_count_softdel_nf = ROW_COUNT;

    RETURN v_count_fup + v_count_nf + v_count_softdel + v_count_softdel_nf;
END;
$$;

COMMENT ON FUNCTION stockbridge.refresh_lotes_em_transito_se_stale(integer) IS
  'Pipeline 5 estágios: FUP 01→aguardando_embarque, 02→transito_intl, 03/etapa(20/30/31)→no_porto (único UPSERT CASE, ON CONFLICT trata transições). FUP 03/etapa(21/22/23) e 04/05 não rastreados (NF-tracking assume). NFs emitidas não recebidas→porto_dta. Soft-delete FUP quando sai dos estágios rastreados; soft-delete NF quando recebida. TTL: no-op se MAX(updated_at)>now()-ttl_minutes.';

-- ── Backfill imediato ─────────────────────────────────────────────────────────
SELECT stockbridge.refresh_lotes_em_transito_se_stale(0) AS backfill_count;
