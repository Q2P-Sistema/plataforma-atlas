-- Migration: 0036 — StockBridge: lotes em trânsito por NF (desacopla do etapa_global do FUP)
--
-- Antes: stockbridge.refresh_lotes_em_transito_se_stale() (migration 0024)
--   classificava lotes pelo etapa_global do FUP:
--     '02 - Em Águas'                              -> transito_intl
--     '03 - Nacionalização' + etapa LIKE '22%'    -> transito_interno
--     '03 - Nacionalização' (outras)              -> porto_dta
--   Problema: etapas administrativas pós-chegada (ex: '23 - Aguardando Devolução
--   dos Containers') perduram meses depois do material chegar fisicamente.
--   Resultado: pedido 456 (ABS GP35 28t) ficava em porto_dta no cockpit mesmo
--   com material recebido no galpão há um mês — operador esperando minuta de
--   devolução do container do transportador.
--
-- Agora: duas fontes independentes:
--   1) Trânsito Internacional via FUP, restrito a `etapa_global = '02 - Em Águas'`.
--   2) Nacionalização via NF de entrada emitida (tbl_nf_header_ACXE) que ainda
--      NÃO foi recebida em nenhuma das duas fontes:
--        - public.tb_movimentacao_q2p_legado (MySQL db_q2p.tb_movimentacao
--          sincronizada) com mv_acxe=1 AND mv_q2p=1 AND ativo=1
--        - stockbridge.movimentacao (futuro) com tipo_movimento IN
--          ('entrada_nf','entrada_manual') AND ativo=true
--   3) Soft-delete cobre lotes FUP que saíram de '02 - Em Águas' E lotes NF
--      que foram recebidos em qualquer das fontes.
--
-- Porque: a verdade operacional do recebimento mora na tabela db_q2p.tb_movimentacao
--   do PHP legado — quando uma NF aparece lá com mv_acxe=1 + mv_q2p=1, foi
--   efetivamente lançada nos dois OMIE. Etapa do FUP é admin/fiscal, não físico.
--
-- Ver plano: ~/.claude/plans/peaceful-skipping-naur.md

-- ── 1. Coluna nf_origem_id em stockbridge.lote ────────────────────────────
ALTER TABLE stockbridge.lote
    ADD COLUMN IF NOT EXISTS nf_origem_id bigint;

COMMENT ON COLUMN stockbridge.lote.nf_origem_id IS
  'tbl_nf_header_ACXE.n_id_nf quando o lote vem de NF emitida (Nacionalização). NULL para lotes do FUP (Trânsito Internacional) ou criados via recebimento direto.';

CREATE UNIQUE INDEX IF NOT EXISTS lote_uq_nf_produto
  ON stockbridge.lote (nf_origem_id, produto_codigo_acxe)
  WHERE nf_origem_id IS NOT NULL;

-- ── 2. Tabela espelho da db_q2p.tb_movimentacao (MySQL legado) ────────────
-- Não é schema stockbridge.* portanto sem trigger de auditoria.
-- Sincronizada via script de sync prod->dev (mysqldump) e, em produção,
-- via workflow n8n dedicado (a criar).
CREATE TABLE IF NOT EXISTS public."tb_movimentacao_q2p_legado" (
  nota_fiscal      integer PRIMARY KEY,
  mv_acxe          smallint,
  dt_acxe          timestamptz,
  id_movest_acxe   text,
  id_ajuste_acxe   text,
  id_user_acxe     integer,
  mv_q2p           smallint,
  dt_q2p           timestamptz,
  id_movest_q2p    text,
  id_ajuste_q2p    text,
  id_user_q2p      integer,
  ativo            smallint,
  synced_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public."tb_movimentacao_q2p_legado" IS
  'Espelho da tabela db_q2p.tb_movimentacao do MySQL legado (PHP). Usada como fonte de "NF recebida" durante validação paralela do StockBridge. Critério: mv_acxe=1 AND mv_q2p=1 AND ativo=1.';

CREATE INDEX IF NOT EXISTS tb_movimentacao_q2p_legado_recebida_idx
  ON public."tb_movimentacao_q2p_legado" (nota_fiscal)
  WHERE mv_acxe = 1 AND mv_q2p = 1 AND ativo = 1;

-- ── 3. Reescrever refresh_lotes_em_transito_se_stale ──────────────────────
CREATE OR REPLACE FUNCTION stockbridge.refresh_lotes_em_transito_se_stale(
    p_ttl_minutes integer DEFAULT 15
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_max_updated     timestamptz;
    v_loc_transito_id uuid;
    v_count_fup       integer := 0;
    v_count_nf        integer := 0;
    v_count_softdel   integer := 0;
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
        RAISE EXCEPTION 'Localidade virtual 90.0.2 TRANSITO nao encontrada — esperada pra ancorar lotes em trânsito';
    END IF;

    -- ── Parte 1: Trânsito Internacional via FUP (só '02 - Em Águas') ──
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
            'transito_intl'                                                              AS estagio_transito,
            v_loc_transito_id                                                            AS localidade_id,
            'acxe'                                                                       AS cnpj,
            fup.numero_di                                                                AS di,
            COALESCE(fup.data_importacao::date, CURRENT_DATE)                            AS dt_entrada,
            COALESCE(fup.eta, fup.eta_estimado)                                          AS dt_prev_chegada,
            fup.pedido_acxe_omie                                                         AS pedido_compra_acxe
        FROM public."tbl_dadosPlanilhaFUPComex" fup
        JOIN public."tbl_pedidosCompras_ACXE" pc ON pc.cnumero = fup.pedido_acxe_omie
        WHERE fup.etapa_global = '02 - Em Águas'    -- ← mudança: só águas
        ON CONFLICT (pedido_compra_acxe, produto_codigo_acxe)
            WHERE pedido_compra_acxe IS NOT NULL
        DO UPDATE SET
            estagio_transito     = 'transito_intl',
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

    -- ── Parte 2: Nacionalização via NF (emitidas + não recebidas) ──
    -- Critério "recebida":
    --   (a) tb_movimentacao_q2p_legado.mv_acxe=1 AND mv_q2p=1 AND ativo=1, OU
    --   (b) stockbridge.movimentacao.tipo_movimento IN ('entrada_nf','entrada_manual')
    --       com mesma nota_fiscal e ativo=true
    -- Safeguard: filtra NFs dos últimos 90 dias. NFs mais antigas que não têm
    -- registro de recebimento são presumidas "perdidas" — apareceriam como ruído
    -- no cockpit sem agregar valor operacional.
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
          AND i.n_cod_prod IS NOT NULL    -- ignora itens sem produto (servico/frete/etc)
          AND i.q_com > 0                 -- ignora itens zerados
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
            'N-' || n.n_nf || '-' || n.n_cod_prod                                       AS codigo,
            n.n_cod_prod                                                                AS produto_codigo_acxe,
            COALESCE(n.dest_razao, 'sem fornecedor')                                    AS fornecedor_nome,
            n.q_com                                                                     AS quantidade_fisica_kg,
            n.q_com                                                                     AS quantidade_fiscal_kg,
            'transito'                                                                  AS status,
            'porto_dta'                                                                 AS estagio_transito,
            v_loc_transito_id                                                           AS localidade_id,
            'acxe'                                                                      AS cnpj,
            COALESCE(n.d_emi::date, CURRENT_DATE)                                       AS dt_entrada,
            n.n_id_nf                                                                   AS nf_origem_id
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

    -- ── Parte 3a: Soft-delete em lotes FUP que saíram de '02 - Em Águas' ──
    UPDATE stockbridge.lote l
    SET ativo = false, updated_at = now()
    WHERE l.pedido_compra_acxe IS NOT NULL
      AND l.ativo = true
      AND l.status = 'transito'
      AND NOT EXISTS (
          SELECT 1 FROM public."tbl_dadosPlanilhaFUPComex" fup
          WHERE fup.pedido_acxe_omie = l.pedido_compra_acxe
            AND fup.etapa_global = '02 - Em Águas'
      );
    GET DIAGNOSTICS v_count_softdel = ROW_COUNT;

    -- ── Parte 3b: Soft-delete em lotes NF que foram recebidos ──
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
  'Refresca lotes em trânsito a partir de 2 fontes independentes: FUP em "02 - Em Águas" (Trânsito Intl) e NFs de entrada emitidas+não-recebidas (Nacionalização). Recebida = tb_movimentacao_q2p_legado(mv_acxe=1+mv_q2p=1+ativo=1) OU stockbridge.movimentacao(entrada_*+ativo). TTL: no-op se MAX(updated_at) > now() - ttl_minutes. Caller: GET /transito do StockBridge.';

-- ── 4. Backfill imediato ──────────────────────────────────────────────────
SELECT stockbridge.refresh_lotes_em_transito_se_stale(0) AS backfill_count;
