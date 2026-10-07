-- =============================================================================
-- limpeza-nf-pedido-mapa-lotes.sql — ACXEGDP-409
--
-- Limpeza das duplicatas de stockbridge.nf_pedido_mapa/_filhote EM LOTES (um
-- pedido por vez, COMMIT a cada pedido), para rodar ANTES da migration 0054 nos
-- bancos com o volume do defeito (UAT e PROD, ~30 mil mapas e ~140 mil filhotes).
-- Mesma regra da 0054: por pedido fica a linha ativa (sem ativa, a mais recente)
-- com as filhotes ATIVAS dela; o resto é apagado, com os triggers de auditoria
-- ligados. Depois dela, a 0054 não acha nada para apagar e só troca o índice.
--
-- Por que em lotes: num bloco único a limpeza vira uma transação com ~170 mil
-- DELETEs + ~170 mil INSERTs de auditoria, sem sinal de progresso — no UAT
-- (shared_buffers 160 MB, max_wal_size 256 MB) não terminou em 06/10/2026.
-- Em lotes, cada pedido é atômico e o que já foi feito fica feito: dá para
-- interromper e rodar de novo (pedido já limpo vira no-op).
--
-- Como rodar: em AUTO-COMMIT, fora de BEGIN/transação explícita (COMMIT dentro
-- do DO só é aceito assim). DBeaver em "Auto": selecionar o bloco inteiro e
-- Ctrl+Enter. psql: SEM -1 (psql -v ON_ERROR_STOP=1 -f <arquivo>).
-- Fora do minuto :13 (carga do n8n). Progresso: NOTICE por pedido, ou
--   SELECT count(*) FROM stockbridge.nf_pedido_mapa;   -- desce até o nº de pedidos
-- =============================================================================

DO $$
DECLARE
    p          record;
    v_filhotes integer;
    v_mapas    integer;
    v_inicio   timestamptz;
    v_n        integer := 0;
BEGIN
    FOR p IN
        SELECT pedido_acxe_omie, count(*) AS linhas
        FROM stockbridge.nf_pedido_mapa
        GROUP BY pedido_acxe_omie
        ORDER BY count(*), pedido_acxe_omie
    LOOP
        v_inicio := clock_timestamp();
        -- Mesma ordem que upsertNfPedidoMapa e a 0054 usam para escolher a linha.
        WITH r AS (
            SELECT id,
                   row_number() OVER (
                       ORDER BY ativo DESC, importado_em DESC, updated_at DESC, id DESC
                   ) AS rn
            FROM stockbridge.nf_pedido_mapa
            WHERE pedido_acxe_omie = p.pedido_acxe_omie
        )
        DELETE FROM stockbridge.nf_pedido_filhote f
        USING r
        WHERE f.mapa_id = r.id
          AND (r.rn > 1 OR f.ativo = false);
        GET DIAGNOSTICS v_filhotes = ROW_COUNT;
        WITH r AS (
            SELECT id,
                   row_number() OVER (
                       ORDER BY ativo DESC, importado_em DESC, updated_at DESC, id DESC
                   ) AS rn
            FROM stockbridge.nf_pedido_mapa
            WHERE pedido_acxe_omie = p.pedido_acxe_omie
        )
        DELETE FROM stockbridge.nf_pedido_mapa m
        USING r
        WHERE m.id = r.id
          AND r.rn > 1;
        GET DIAGNOSTICS v_mapas = ROW_COUNT;
        COMMIT;
        v_n := v_n + 1;
        IF v_mapas > 0 OR v_filhotes > 0 THEN
            RAISE NOTICE '[%] pedido %: % mapas e % filhotes removidos em % s',
                v_n, p.pedido_acxe_omie, v_mapas, v_filhotes,
                round(extract(epoch FROM clock_timestamp() - v_inicio)::numeric, 1);
        END IF;
    END LOOP;
    RAISE NOTICE 'limpeza concluída: % pedidos verificados — agora aplicar a migration 0054', v_n;
END $$;
