WITH nf_unificada AS (
        SELECT a.*,
               CASE WHEN COALESCE(rv.n_id_pedido, 0) > 0 THEN rv.n_id_pedido END    AS n_id_pedido,
               CASE WHEN COALESCE(rv.n_id_pedido, 0) > 0 THEN rv.n_id_it_pedido END AS n_id_it_pedido,
               NULLIF(btrim(rv.n_num_ped_compra), '')                                  AS n_num_ped_compra,
               rv.c_associar_existente, rv.c_ignorar_item, rv.c_nao_gerar_mov_estoque,
               rv.c_recebido                                        AS receb_recebido,
               rv.n_qtde_nfe                                        AS q_com_xml,  -- a nota de entrada traz a quantidade RECEBIDA
               rv.c_unidade_nfe                                     AS u_com_xml,
               false                                                AS fiscal_revertido
        FROM (
          SELECT h.c_chave_nfe, h.n_nf, h.dest_razao, h.dest_cnpj_cpf, h.d_emi::date AS d_emi,
                 h.n_id_receb::bigint                                 AS n_id_receb,
                 false                                                AS fiscal_pendente,
                 COALESCE(h.cancelada, false) AS cancelada,
                 COALESCE(h.deletada, false)                          AS deletada,
                 i.n_cod_item::bigint                                 AS n_cod_item,  -- ordem NUMERICA dos itens (FILA-6)
                 i.x_prod, i.cfop, i.q_com, i.u_com,
                 i.v_prod                                             AS valor_item,  -- D26: NAO v_tot_item (IPI em dobro)
                 (SELECT COALESCE(
                  MAX(ri.n_sequencia) FILTER (WHERE ri.n_id_item = i.n_cod_item),
                  CASE WHEN COUNT(*) > 0 AND COUNT(*) FILTER (WHERE COALESCE(ri.n_id_item, 0) <> 0) = 0
                       THEN (SELECT COUNT(*)::int FROM public."tbl_nf_itens_Q2P" i2
                              WHERE i2.n_id_nf = i.n_id_nf AND i2.n_cod_item <= i.n_cod_item)
                  END)
             FROM public."tbl_recebimentoNFe_Q2P" r
             JOIN public."tbl_recebimentoNFe_itens_Q2P" ri ON ri.n_id_receb = r.n_id_receb
            WHERE r.c_chave_nfe = h.c_chave_nfe)                      AS n_seq,
                 i.v_un_com                                           AS preco_comercial,  -- 017: preco SEM tributos (D3)
                 NULL::bigint                                         AS fornecedor_codigo
          FROM public."tbl_nf_header_Q2P" h
          JOIN public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf
          WHERE h.tp_nf = 0
            AND h.d_emi >= $2::date
            AND NOT COALESCE(GREATEST((SELECT MAX(CASE WHEN rrp.d_alt IS NOT NULL AND rrp.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrp.d_alt::date + rrp.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END) FROM public."tbl_recebimentoNFe_Q2P" rrp
                WHERE rrp.c_chave_nfe = h.c_chave_nfe AND rrp.c_recebido = 'N' AND COALESCE(rrp.c_cancelada, 'N') <> 'S') - interval '2 minutes',
              (SELECT MAX(COALESCE(rfr.revertido_omie_em, rfr.revertido_em)) FROM stockbridge.recebimento_fiscal rfr
                WHERE rfr.nf_chave_acesso = h.c_chave_nfe AND rfr.status = 'revertido')) > GREATEST(
              (SELECT MAX(rfc.finalizado_em) FROM stockbridge.recebimento_fiscal rfc
                WHERE rfc.nf_chave_acesso = h.c_chave_nfe AND rfc.status IN ('concluido', 'ja_concluido', 'revertido')),
              (SELECT MAX(CASE WHEN hnc.d_alt IS NOT NULL AND hnc.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (hnc.d_alt::date + hnc.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END) FROM public."tbl_nf_header_Q2P" hnc
                WHERE hnc.c_chave_nfe = h.c_chave_nfe AND hnc.tp_nf = 0),
              (SELECT MAX(GREATEST(CASE WHEN rrc.d_alt IS NOT NULL AND rrc.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrc.d_alt::date + rrc.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END, CASE WHEN rrc.d_rec IS NOT NULL AND rrc.h_rec::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrc.d_rec::date + rrc.h_rec::text::time) AT TIME ZONE 'America/Sao_Paulo' END)) FROM public."tbl_recebimentoNFe_Q2P" rrc
                WHERE rrc.c_chave_nfe = h.c_chave_nfe AND rrc.c_recebido = 'S')), false)
        ) a
        LEFT JOIN LATERAL (
          SELECT ri.*, r.c_recebido
            FROM public."tbl_recebimentoNFe_Q2P" r
            JOIN public."tbl_recebimentoNFe_itens_Q2P" ri ON ri.n_id_receb = r.n_id_receb
           WHERE r.c_chave_nfe = a.c_chave_nfe AND ri.n_sequencia = a.n_seq
           LIMIT 1
        ) rv ON true
        UNION ALL
        
        SELECT r.c_chave_nfe, r.c_numero_nfe AS n_nf, r.c_razao_social AS dest_razao, r.c_cnpj_cpf AS dest_cnpj_cpf,
               r.d_emissao                                          AS d_emi,
               r.n_id_receb::bigint                                 AS n_id_receb,
               NOT (EXISTS (SELECT 1 FROM stockbridge.recebimento_fiscal rf
            WHERE rf.nf_chave_acesso = r.c_chave_nfe AND rf.status IN ('concluido', 'ja_concluido')) AND NOT COALESCE(GREATEST((SELECT MAX(CASE WHEN rrp.d_alt IS NOT NULL AND rrp.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrp.d_alt::date + rrp.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END) FROM public."tbl_recebimentoNFe_Q2P" rrp
                WHERE rrp.c_chave_nfe = r.c_chave_nfe AND rrp.c_recebido = 'N' AND COALESCE(rrp.c_cancelada, 'N') <> 'S') - interval '2 minutes',
              (SELECT MAX(COALESCE(rfr.revertido_omie_em, rfr.revertido_em)) FROM stockbridge.recebimento_fiscal rfr
                WHERE rfr.nf_chave_acesso = r.c_chave_nfe AND rfr.status = 'revertido')) > GREATEST(
              (SELECT MAX(rfc.finalizado_em) FROM stockbridge.recebimento_fiscal rfc
                WHERE rfc.nf_chave_acesso = r.c_chave_nfe AND rfc.status IN ('concluido', 'ja_concluido', 'revertido')),
              (SELECT MAX(CASE WHEN hnc.d_alt IS NOT NULL AND hnc.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (hnc.d_alt::date + hnc.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END) FROM public."tbl_nf_header_Q2P" hnc
                WHERE hnc.c_chave_nfe = r.c_chave_nfe AND hnc.tp_nf = 0),
              (SELECT MAX(GREATEST(CASE WHEN rrc.d_alt IS NOT NULL AND rrc.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrc.d_alt::date + rrc.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END, CASE WHEN rrc.d_rec IS NOT NULL AND rrc.h_rec::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrc.d_rec::date + rrc.h_rec::text::time) AT TIME ZONE 'America/Sao_Paulo' END)) FROM public."tbl_recebimentoNFe_Q2P" rrc
                WHERE rrc.c_chave_nfe = r.c_chave_nfe AND rrc.c_recebido = 'S')), false))  AS fiscal_pendente,
               COALESCE(r.c_cancelada = 'S', false)                 AS cancelada,  -- nulo no ramo do ledger nao pode sumir com a NF
               false                                                AS deletada,
               ri.n_sequencia::bigint                               AS n_cod_item,
               ri.c_descricao_produto                               AS x_prod,
               ri.c_cfop_entrada                                    AS cfop,       -- CFOP de ENTRADA (o c_cfop e o do fornecedor)
               ri.n_qtde_nfe                                        AS q_com,
               ri.c_unidade_nfe                                     AS u_com,
               ri.v_total_item                                      AS valor_item,  -- = v_prod (research D7 da 016)
               ri.n_sequencia::int                                  AS n_seq,
               ri.n_preco_unit                                      AS preco_comercial,  -- 017: preco SEM tributos (D3)
               NULLIF(r.n_id_fornecedor, 0)                         AS fornecedor_codigo,
               CASE WHEN COALESCE(ri.n_id_pedido, 0) > 0 THEN ri.n_id_pedido END    AS n_id_pedido,
               CASE WHEN COALESCE(ri.n_id_pedido, 0) > 0 THEN ri.n_id_it_pedido END AS n_id_it_pedido,
               NULLIF(btrim(ri.n_num_ped_compra), '')                                  AS n_num_ped_compra,
               ri.c_associar_existente, ri.c_ignorar_item, ri.c_nao_gerar_mov_estoque,
               r.c_recebido                                         AS receb_recebido,
               ri.n_qtde_nfe                                        AS q_com_xml,
               ri.c_unidade_nfe                                     AS u_com_xml,
               COALESCE(GREATEST((SELECT MAX(CASE WHEN rrp.d_alt IS NOT NULL AND rrp.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrp.d_alt::date + rrp.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END) FROM public."tbl_recebimentoNFe_Q2P" rrp
                WHERE rrp.c_chave_nfe = r.c_chave_nfe AND rrp.c_recebido = 'N' AND COALESCE(rrp.c_cancelada, 'N') <> 'S') - interval '2 minutes',
              (SELECT MAX(COALESCE(rfr.revertido_omie_em, rfr.revertido_em)) FROM stockbridge.recebimento_fiscal rfr
                WHERE rfr.nf_chave_acesso = r.c_chave_nfe AND rfr.status = 'revertido')) > GREATEST(
              (SELECT MAX(rfc.finalizado_em) FROM stockbridge.recebimento_fiscal rfc
                WHERE rfc.nf_chave_acesso = r.c_chave_nfe AND rfc.status IN ('concluido', 'ja_concluido', 'revertido')),
              (SELECT MAX(CASE WHEN hnc.d_alt IS NOT NULL AND hnc.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (hnc.d_alt::date + hnc.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END) FROM public."tbl_nf_header_Q2P" hnc
                WHERE hnc.c_chave_nfe = r.c_chave_nfe AND hnc.tp_nf = 0),
              (SELECT MAX(GREATEST(CASE WHEN rrc.d_alt IS NOT NULL AND rrc.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrc.d_alt::date + rrc.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END, CASE WHEN rrc.d_rec IS NOT NULL AND rrc.h_rec::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrc.d_rec::date + rrc.h_rec::text::time) AT TIME ZONE 'America/Sao_Paulo' END)) FROM public."tbl_recebimentoNFe_Q2P" rrc
                WHERE rrc.c_chave_nfe = r.c_chave_nfe AND rrc.c_recebido = 'S')), false)  AS fiscal_revertido
        FROM public."tbl_recebimentoNFe_Q2P" r
        JOIN public."tbl_recebimentoNFe_itens_Q2P" ri ON ri.n_id_receb = r.n_id_receb
        WHERE r.d_emissao >= $2::date
          AND (NOT EXISTS (SELECT 1 FROM public."tbl_nf_header_Q2P" h2 WHERE h2.c_chave_nfe = r.c_chave_nfe) OR COALESCE(GREATEST((SELECT MAX(CASE WHEN rrp.d_alt IS NOT NULL AND rrp.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrp.d_alt::date + rrp.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END) FROM public."tbl_recebimentoNFe_Q2P" rrp
                WHERE rrp.c_chave_nfe = r.c_chave_nfe AND rrp.c_recebido = 'N' AND COALESCE(rrp.c_cancelada, 'N') <> 'S') - interval '2 minutes',
              (SELECT MAX(COALESCE(rfr.revertido_omie_em, rfr.revertido_em)) FROM stockbridge.recebimento_fiscal rfr
                WHERE rfr.nf_chave_acesso = r.c_chave_nfe AND rfr.status = 'revertido')) > GREATEST(
              (SELECT MAX(rfc.finalizado_em) FROM stockbridge.recebimento_fiscal rfc
                WHERE rfc.nf_chave_acesso = r.c_chave_nfe AND rfc.status IN ('concluido', 'ja_concluido', 'revertido')),
              (SELECT MAX(CASE WHEN hnc.d_alt IS NOT NULL AND hnc.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (hnc.d_alt::date + hnc.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END) FROM public."tbl_nf_header_Q2P" hnc
                WHERE hnc.c_chave_nfe = r.c_chave_nfe AND hnc.tp_nf = 0),
              (SELECT MAX(GREATEST(CASE WHEN rrc.d_alt IS NOT NULL AND rrc.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrc.d_alt::date + rrc.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END, CASE WHEN rrc.d_rec IS NOT NULL AND rrc.h_rec::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrc.d_rec::date + rrc.h_rec::text::time) AT TIME ZONE 'America/Sao_Paulo' END)) FROM public."tbl_recebimentoNFe_Q2P" rrc
                WHERE rrc.c_chave_nfe = r.c_chave_nfe AND rrc.c_recebido = 'S')), false))
          AND (
                (r.c_recebido = 'N' AND r.c_cancelada = 'N' AND r.c_etapa = '40'
                 AND COALESCE(r.c_bloqueado, 'N') <> 'S' AND COALESCE(r.c_devolvido, 'N') <> 'S')
             OR EXISTS (SELECT 1 FROM stockbridge.recebimento_fiscal rf
            WHERE rf.nf_chave_acesso = r.c_chave_nfe AND rf.status IN ('concluido', 'ja_concluido'))
             OR (COALESCE(GREATEST((SELECT MAX(CASE WHEN rrp.d_alt IS NOT NULL AND rrp.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrp.d_alt::date + rrp.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END) FROM public."tbl_recebimentoNFe_Q2P" rrp
                WHERE rrp.c_chave_nfe = r.c_chave_nfe AND rrp.c_recebido = 'N' AND COALESCE(rrp.c_cancelada, 'N') <> 'S') - interval '2 minutes',
              (SELECT MAX(COALESCE(rfr.revertido_omie_em, rfr.revertido_em)) FROM stockbridge.recebimento_fiscal rfr
                WHERE rfr.nf_chave_acesso = r.c_chave_nfe AND rfr.status = 'revertido')) > GREATEST(
              (SELECT MAX(rfc.finalizado_em) FROM stockbridge.recebimento_fiscal rfc
                WHERE rfc.nf_chave_acesso = r.c_chave_nfe AND rfc.status IN ('concluido', 'ja_concluido', 'revertido')),
              (SELECT MAX(CASE WHEN hnc.d_alt IS NOT NULL AND hnc.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (hnc.d_alt::date + hnc.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END) FROM public."tbl_nf_header_Q2P" hnc
                WHERE hnc.c_chave_nfe = r.c_chave_nfe AND hnc.tp_nf = 0),
              (SELECT MAX(GREATEST(CASE WHEN rrc.d_alt IS NOT NULL AND rrc.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrc.d_alt::date + rrc.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END, CASE WHEN rrc.d_rec IS NOT NULL AND rrc.h_rec::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrc.d_rec::date + rrc.h_rec::text::time) AT TIME ZONE 'America/Sao_Paulo' END)) FROM public."tbl_recebimentoNFe_Q2P" rrc
                WHERE rrc.c_chave_nfe = r.c_chave_nfe AND rrc.c_recebido = 'S')), false))
          )
       )
       SELECT u.c_chave_nfe, u.x_prod, upper(regexp_replace(btrim(unaccent(u.x_prod)), '\s+', ' ', 'g')) AS desc_norm, u.q_com::float8 AS q_com, u.u_com,
              u.valor_item::float8 AS valor_item, u.preco_comercial::float8 AS preco_comercial, u.n_seq,
              u.n_id_pedido::text AS n_id_pedido, u.n_id_it_pedido::text AS n_id_it_pedido, u.n_num_ped_compra,
              u.fornecedor_codigo::text AS fornecedor_codigo, (
    EXISTS (SELECT 1 FROM stockbridge.movimentacao m
              WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
                AND m.nf_chave_acesso = u.c_chave_nfe
                AND (m.nf_item_descricao_normalizada = upper(regexp_replace(btrim(unaccent(u.x_prod)), '\s+', ' ', 'g')) OR u.n_seq = ANY(m.nf_item_sequencias)))
    OR EXISTS (SELECT 1 FROM stockbridge.movimentacao m
              WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
                AND m.nf_chave_acesso IS NULL
                AND m.empresa = 'q2p'
                AND ltrim(m.nota_fiscal, '0') = ltrim(u.n_nf, '0')
                AND m.created_at >= (u.d_emi)::date)
    OR EXISTS (SELECT 1 FROM stockbridge.aprovacao a
              WHERE a.tipo_aprovacao = 'recebimento_externo' AND a.status = 'aprovada'
                AND a.nf_chave_acesso = u.c_chave_nfe
                AND upper(regexp_replace(btrim(unaccent(a.nf_item_descricao)), '\s+', ' ', 'g')) = upper(regexp_replace(btrim(unaccent(u.x_prod)), '\s+', ' ', 'g')))
  ) AS recebido
         FROM nf_unificada u
        WHERE u.c_chave_nfe = ANY($3::text[]) AND u.fiscal_pendente AND u.cfop = ANY($1::text[])
          AND NOT u.cancelada AND NOT u.deletada
        ORDER BY u.c_chave_nfe, u.n_cod_item