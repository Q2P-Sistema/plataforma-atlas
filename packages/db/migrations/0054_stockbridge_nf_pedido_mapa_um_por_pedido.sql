-- Migration: 0054 — StockBridge: um mapa NF mãe/filhote por pedido (ACXEGDP-409)
--
-- Antes: o upsert do POST /admin/nf-pedido-mapa era um ON CONFLICT no índice
--   único PARCIAL nf_pedido_mapa_pedido_idx (WHERE ativo = true). Pedido já
--   concluído (mapa auto-desativado) não dava conflito, então cada carga do n8n
--   (aba inteira da FUP, de hora em hora) criava um mapa NOVO com filhotes novas,
--   desativado logo em seguida. Em PROD, 06/10/2026: 30.808 mapas para 70
--   pedidos (3 ativos), 140.476 filhotes, ~33 mapas novos por carga. Nenhum
--   consumidor somava as cópias (filtram mapa.ativo, único por pedido, ou usam
--   EXISTS/DISTINCT) — o dano é volume nas duas tabelas e em shared.audit_log.
-- Agora: o serviço reaproveita a linha do pedido (troca NF mãe e filhotes,
--   reabre/fecha conforme o recebimento) e não grava nada quando a FUP não
--   mudou. Esta migration:
--   1. mantém UMA linha por pedido — a ativa; sem ativa, a mais recente — com
--      as filhotes ATIVAS dela, e apaga o resto (cópias + filhotes inativas da
--      linha mantida, que eram as mesmas NFs regravadas a cada carga ou
--      correções antigas da planilha);
--   2. recria nf_pedido_mapa_pedido_idx como índice único TOTAL.
-- Porque: com um mapa por pedido o índice não precisa mais ser parcial, e o
--   índice total faz uma regressão falhar alto (23505) em vez de crescer em
--   silêncio. O nome é mantido para que reaplicar a 0039 (os scripts de
--   apply reaplicam todos os arquivos) não recrie o índice parcial.
--
-- Hard delete de propósito: as cópias são subproduto do defeito, não histórico
-- de negócio, e o ciclo de vida de cada linha (INSERT/UPDATE) já está em
-- shared.audit_log. Os triggers de auditoria ficam LIGADOS — cada DELETE também
-- é auditado (Princípio IV).
--
-- Reaplicável: com o índice já total a limpeza é pulada (NOTICE). O bloco DO é
-- atômico mesmo em auto-commit (DBeaver: selecionar o bloco inteiro e Ctrl+Enter;
-- sem linha em branco dentro dele para o DBeaver não partir o script). Rodar fora do
-- minuto :13 (carga do n8n): a troca do índice bloqueia escrita na tabela.
--
-- Volume do defeito (UAT/PROD, ~30 mil mapas): rodar ANTES, em auto-commit,
-- scripts/limpeza-nf-pedido-mapa-lotes.sql (mesma regra, um pedido por COMMIT).
-- Num bloco único essa limpeza não terminou no UAT em 06/10/2026; depois dos
-- lotes, esta migration só troca o índice.

-- ── 1. Limpeza + índice único total (só enquanto o índice ainda é parcial) ───
DO $$
DECLARE
    v_filhotes integer;
    v_mapas    integer;
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_index i
        WHERE i.indexrelid = to_regclass('stockbridge.nf_pedido_mapa_pedido_idx')
          AND i.indisunique
          AND i.indpred IS NULL
    ) THEN
        RAISE NOTICE '0054: nf_pedido_mapa_pedido_idx já é único total — limpeza já feita';
        RETURN;
    END IF;
    -- Mesma ordem que upsertNfPedidoMapa usa para escolher a linha do pedido.
    CREATE TEMP TABLE _nf_pedido_mapa_rank ON COMMIT DROP AS
    SELECT id,
           row_number() OVER (
               PARTITION BY pedido_acxe_omie
               ORDER BY ativo DESC, importado_em DESC, updated_at DESC, id DESC
           ) AS rn
    FROM stockbridge.nf_pedido_mapa;
    DELETE FROM stockbridge.nf_pedido_filhote f
    USING _nf_pedido_mapa_rank r
    WHERE f.mapa_id = r.id
      AND (r.rn > 1 OR f.ativo = false);
    GET DIAGNOSTICS v_filhotes = ROW_COUNT;
    DELETE FROM stockbridge.nf_pedido_mapa m
    USING _nf_pedido_mapa_rank r
    WHERE m.id = r.id
      AND r.rn > 1;
    GET DIAGNOSTICS v_mapas = ROW_COUNT;
    DROP TABLE _nf_pedido_mapa_rank;
    DROP INDEX IF EXISTS stockbridge.nf_pedido_mapa_pedido_idx;
    CREATE UNIQUE INDEX nf_pedido_mapa_pedido_idx
        ON stockbridge.nf_pedido_mapa (pedido_acxe_omie);
    RAISE NOTICE '0054: % mapas e % filhotes removidos; índice único total criado', v_mapas, v_filhotes;
END $$;

-- ── 2. Comentários (fora do bloco: reaplicar a 0039 reescreve os dela) ──────
COMMENT ON TABLE stockbridge.nf_pedido_mapa IS
  'Mapeamento pedido-de-importação → NF mãe. UM registro por pedido (índice único nf_pedido_mapa_pedido_idx, migration 0054); ativo = false quando todas as filhotes foram recebidas, reaberto se voltar a ter filhote pendente. Alimentado pelo workflow FUP n8n (aba inteira, de hora em hora) ou manualmente pelo gestor via API. Usado pelo cockpit para calcular posição fiscal pendente de importação. Vide ACXEGDP-159.';

COMMENT ON TABLE stockbridge.nf_pedido_filhote IS
  'NF filhotes (uma por container/caminhão) de cada pedido do mapa. n_id_receb lido ao vivo de tbl_nf_header_ACXE — não armazenado aqui. Quando a FUP muda as filhotes do pedido, as anteriores viram ativo = false (soft delete) e as novas são inseridas; carga sem mudança não regrava nada.';
