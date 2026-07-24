-- Migration: 0037 — StockBridge: pipeline 5 estágios (100% FUP-driven)
--
-- Antes (migration 0036):
--   FUP só em '02 - Em Águas' → transito_intl
--   NFs emitidas não recebidas → porto_dta  ← DESCARTADO (ver abaixo)
--   Pipeline UI: 3 estágios (Trânsito Intl → Nacionalização → Disponível)
--
-- Agora: 5 estágios operacionais, TODOS derivados do FUP de Comex:
--   01 - Aguardando Booking        → aguardando_embarque  (booking pendente)
--   02 - Em Águas                  → transito_intl          (em rota marítima)
--   03 / etapa 20,30,31            → no_porto               (porto/DTA, sem NF ainda)
--   03 / etapa 21,22               → transito_local         (NF emitida, a caminho do galpão)
--   OMIE galpões físicos           → Disponível             (saldo físico, fora desta função)
--
-- POR QUE FUP-ONLY (rastreamento via NF removido):
--   tbl_nf_header_ACXE mistura NF MÃE (cobre o pedido/container todo) com NFs
--   FILHOTES (uma por caminhão, para o transporte). As duas são indistinguíveis
--   na tabela — somá-las dobra o volume. O FUP é a fonte de verdade operacional
--   da equipe de Comex e já cobre todas as etapas de trânsito.
--
-- FUP 03 subdividido pela `etapa` (sub-estágio):
--   20 - Aguardando Registro DI          → no_porto        (sem NF ainda)
--   30 - Aguardando Registro DTA/Remoção → no_porto        (sem NF ainda)
--   31 - Material em Porto Seco          → no_porto        (sem NF ainda)
--   21 - Aguardando Exoneração de ICMS   → transito_local  (NF mãe emitida)
--   22 - Aguardando Recebimento Galpão   → transito_local  (NF mãe + filhote)
--   23 - Aguardando Devolução Containers → NÃO rastrear (já entregue — OMIE tem saldo)
--   04/05 → não rastrear
--
-- Transições automáticas (ON CONFLICT DO UPDATE seta estagio_transito):
--   01→02:        aguardando_embarque → transito_intl
--   02→03/et=20:  transito_intl → no_porto
--   03/et=20→21:  no_porto → transito_local
--   03/et=22→23:  soft-delete (saiu dos estágios rastreados; OMIE assume o saldo)
--
-- Cleanup: lotes legados criados pela abordagem NF (nf_origem_id IS NOT NULL)
--   são soft-deletados — não há mais Parte NF que os recrie.

-- ── Ampliar CHECK constraint de estagio_transito ─────────────────────────────
-- O valor é varchar(30) mas há um CHECK que restringe a lista. Os 3 novos
-- estágios (aguardando_embarque, no_porto, transito_local) precisam ser
-- permitidos antes do backfill. 'porto_dta' é MANTIDO na lista: vira valor
-- legado (nunca mais produzido pelo código novo) mas continua válido para as
-- linhas históricas soft-deletadas que ainda carregam esse estágio.
-- Idempotente: DROP IF EXISTS + ADD.
ALTER TABLE stockbridge.lote DROP CONSTRAINT IF EXISTS lote_estagio_transito_check;
ALTER TABLE stockbridge.lote ADD CONSTRAINT lote_estagio_transito_check
    CHECK ((estagio_transito)::text = ANY ((ARRAY[
        'aguardando_embarque',
        'transito_intl',
        'no_porto',
        'transito_local',
        'porto_dta',
        'transito_interno',
        'reservado'
    ])::text[]));

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
    v_count_softdel    integer := 0;
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
        RAISE EXCEPTION 'Localidade virtual 90.0.2 TRANSITO nao encontrada';
    END IF;

    -- ── Parte 1: FUP — 4 estágios ativos em único UPSERT ────────────────────
    -- CASE determina estagio_transito a partir de etapa_global + etapa.
    -- ON CONFLICT DO UPDATE seta estagio_transito = EXCLUDED tratando
    -- transições (01→02, 02→03/et=20, 03/et=20→21) sem criar duplicatas.
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
                WHEN fup.etapa_global = '03 - Nacionalização'
                     AND fup.etapa LIKE ANY(ARRAY['20%', '30%', '31%']) THEN 'no_porto'
                WHEN fup.etapa_global = '03 - Nacionalização'
                     AND fup.etapa LIKE ANY(ARRAY['21%', '22%'])        THEN 'transito_local'
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
                  AND fup.etapa LIKE ANY(ARRAY['20%', '21%', '22%', '30%', '31%'])
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

    -- ── Parte 2: Soft-delete lotes FUP que saíram dos estágios rastreados ───
    -- Material soft-deletado quando o pedido avançou para:
    --   - etapa_global '03' / etapa=23 (entregue no galpão — OMIE tem saldo)
    --   - etapa_global '04'/'05' (pós-nacionalização)
    --   - etapa_global NULL ou removido do FUP
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
                    AND fup.etapa LIKE ANY(ARRAY['20%', '21%', '22%', '30%', '31%'])
                )
            )
      );
    GET DIAGNOSTICS v_count_softdel = ROW_COUNT;

    RETURN v_count_fup + v_count_softdel;
END;
$$;

COMMENT ON FUNCTION stockbridge.refresh_lotes_em_transito_se_stale(integer) IS
  'Pipeline 5 estágios 100% FUP-driven: 01→aguardando_embarque, 02→transito_intl, 03/etapa(20/30/31)→no_porto, 03/etapa(21/22)→transito_local (único UPSERT CASE, ON CONFLICT trata transições). FUP 03/etapa 23 e 04/05 não rastreados (OMIE assume o saldo físico). Rastreamento via NF removido (NF mãe+filhote indistinguíveis → dupla contagem). Soft-delete FUP quando sai dos estágios rastreados. TTL: no-op se MAX(updated_at)>now()-ttl_minutes.';

-- ── Cleanup: lotes legados criados pela abordagem NF (migration 0036) ──────────
-- Não há mais Parte NF que os recrie; soft-delete uma vez. O saldo correspondente
-- está no OMIE (entrada já consolidada) ou volta a aparecer via FUP etapa 21/22.
UPDATE stockbridge.lote
SET ativo = false, updated_at = now()
WHERE nf_origem_id IS NOT NULL AND ativo = true AND status = 'transito';

-- ── Backfill imediato ─────────────────────────────────────────────────────────
SELECT stockbridge.refresh_lotes_em_transito_se_stale(0) AS backfill_count;
