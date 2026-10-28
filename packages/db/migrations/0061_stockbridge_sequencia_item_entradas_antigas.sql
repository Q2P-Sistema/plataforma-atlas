-- Migration: 0061 — sequencia do item da NF nas entradas nacionais antigas (feature 017, T102, ACXEGDP-437)
--
-- Antes: a movimentacao da compra nacional so passou a gravar nf_item_sequencias (a sequencia do item no
--        recebimento de NF-e) com a ACXEGDP-412 (0055, 07/10/2026). As entradas da Q2P sem ela casam com o
--        item da NF so pela descricao, e o OMIE troca a descricao quando registra a NF de novo: a NF 36624,
--        recebida em 06/10, voltou a fila como pendente em 27/10/2026 (risco de entrada em dobro).
-- Agora: grava a sequencia nessas entradas a partir do espelho de recebimentos. NF com um item so no
--        recebimento recebe a sequencia dele; com varios, as sequencias das linhas com a descricao da entrada
--        (a do recebimento ou a da nota de entrada ligada pelo codigo do item), como o Atlas grava hoje para o
--        item (todas as linhas de mesma descricao). Entrada sem sequencia determinavel fica como esta.
--        Medido em PROD em 28/10/2026: 39 entradas (32 ativas), todas determinaveis.
-- Porque: identidade do item que nao depende da descricao (T102 da 017).
--
-- So dados, idempotente: so toca nf_item_sequencias nula. Sem o espelho de recebimentos ou de itens de NF
-- da Q2P (banco sem as tabelas do n8n) nao faz nada. So a Q2P: a entrada nacional da ACXE comecou em
-- 26/10/2026, ja com a sequencia. A trigger de auditoria de stockbridge.movimentacao grava cada linha.
-- Ordem com a imagem: indiferente (o codigo ja casa por descricao OU sequencia).
-- Ver specs/017-recebimento-nacional-com-pc/research.md, pendencia 8.

DO $$
DECLARE
    v_linhas integer;
BEGIN
    IF to_regclass('public."tbl_recebimentoNFe_Q2P"') IS NULL
       OR to_regclass('public."tbl_recebimentoNFe_itens_Q2P"') IS NULL
       OR to_regclass('public."tbl_nf_header_Q2P"') IS NULL
       OR to_regclass('public."tbl_nf_itens_Q2P"') IS NULL THEN
        RAISE NOTICE '0061: espelho de recebimentos ou de NF da Q2P ausente — nada a fazer';
        RETURN;
    END IF;

    WITH alvo AS (
        SELECT m.id, m.nf_chave_acesso, m.nf_item_descricao_normalizada AS descricao
          FROM stockbridge.movimentacao m
         WHERE m.subtipo = 'compra_nacional'
           AND m.empresa = 'q2p'
           AND m.nf_chave_acesso IS NOT NULL
           AND m.nf_item_sequencias IS NULL
    ),
    -- linhas do recebimento de NF-e da chave, com a descricao normalizada como em normalizarDescricaoSql
    linha_receb AS (
        SELECT r.c_chave_nfe, ri.n_sequencia, ri.n_id_item,
               upper(regexp_replace(btrim(unaccent(ri.c_descricao_produto)), '\s+', ' ', 'g')) AS descricao
          FROM public."tbl_recebimentoNFe_Q2P" r
          JOIN public."tbl_recebimentoNFe_itens_Q2P" ri ON ri.n_id_receb = r.n_id_receb
         WHERE r.c_chave_nfe IN (SELECT nf_chave_acesso FROM alvo)
    ),
    -- linhas da nota de entrada (o n_id_item do recebimento concluido e o n_cod_item da NF)
    linha_nf AS (
        SELECT h.c_chave_nfe, i.n_cod_item,
               upper(regexp_replace(btrim(unaccent(i.x_prod)), '\s+', ' ', 'g')) AS descricao
          FROM public."tbl_nf_header_Q2P" h
          JOIN public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf
         WHERE h.c_chave_nfe IN (SELECT nf_chave_acesso FROM alvo)
    ),
    calculo AS (
        SELECT a.id,
               CASE WHEN (SELECT count(*) FROM linha_receb lr WHERE lr.c_chave_nfe = a.nf_chave_acesso) = 1
                    THEN (SELECT array_agg(lr.n_sequencia) FROM linha_receb lr WHERE lr.c_chave_nfe = a.nf_chave_acesso)
                    ELSE (SELECT array_agg(DISTINCT lr.n_sequencia ORDER BY lr.n_sequencia)
                            FROM linha_receb lr
                           WHERE lr.c_chave_nfe = a.nf_chave_acesso
                             AND (lr.descricao = a.descricao
                                  OR EXISTS (SELECT 1 FROM linha_nf ln
                                              WHERE ln.c_chave_nfe = lr.c_chave_nfe
                                                AND ln.n_cod_item = lr.n_id_item
                                                AND ln.descricao = a.descricao)))
               END AS sequencias
          FROM alvo a
    )
    UPDATE stockbridge.movimentacao m
       SET nf_item_sequencias = c.sequencias
      FROM calculo c
     WHERE m.id = c.id
       AND c.sequencias IS NOT NULL
       AND m.nf_item_sequencias IS NULL;

    GET DIAGNOSTICS v_linhas = ROW_COUNT;
    RAISE NOTICE '0061: % entrada(s) nacional(is) da Q2P com a sequencia do item preenchida', v_linhas;
END $$;
