
    WITH nf_unificada AS (
        SELECT a.*,
               CASE WHEN COALESCE(rv.n_id_pedido, 0) > 0 THEN rv.n_id_pedido END    AS n_id_pedido,
               CASE WHEN COALESCE(rv.n_id_pedido, 0) > 0 THEN rv.n_id_it_pedido END AS n_id_it_pedido,
               NULLIF(btrim(rv.n_num_ped_compra), '')                                  AS n_num_ped_compra,
               rv.c_associar_existente, rv.c_ignorar_item, rv.c_nao_gerar_mov_estoque,
               rv.c_recebido                                        AS receb_recebido
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
            
        ) a
        LEFT JOIN LATERAL (
          SELECT ri.*, r.c_recebido
            FROM public."tbl_recebimentoNFe_Q2P" r
            JOIN public."tbl_recebimentoNFe_itens_Q2P" ri ON ri.n_id_receb = r.n_id_receb
           WHERE r.c_chave_nfe = a.c_chave_nfe AND ri.n_sequencia = a.n_seq
           LIMIT 1
        ) rv ON true
    )
    SELECT
      u.c_chave_nfe                                    AS nf_chave_acesso,
      u.n_nf                                           AS n_nf,
      ltrim(u.n_nf, '0')                               AS nota_fiscal,
      u.dest_razao                                     AS fornecedor_nome,
      u.dest_cnpj_cpf                                  AS fornecedor_cnpj,
      u.d_emi::text                                    AS dt_emissao,
      (CURRENT_DATE - u.d_emi::date)::int              AS dias_desde_emissao,
      u.cancelada                                      AS cancelada,
      u.deletada                                       AS deletada,
      NOT NOT EXISTS (
        SELECT 1 FROM stockbridge.fornecedor_exclusao fe
         WHERE fe.reincluido_em IS NULL AND fe.fornecedor_cnpj = u.dest_cnpj_cpf AND fe.empresa = 'q2p')             AS fornecedor_excluido,
      u.fiscal_pendente                                AS fiscal_pendente,
      u.n_id_receb                                     AS n_id_receb,
      u.n_cod_item                                     AS n_cod_item,
      u.x_prod                                         AS x_prod,
      upper(regexp_replace(btrim(unaccent(u.x_prod)), '\s+', ' ', 'g'))                                      AS desc_norm,
      u.cfop                                           AS cfop,
      u.q_com::float8                                  AS q_com,
      u.u_com                                          AS u_com,
      u.valor_item::float8                             AS valor_item,  -- D26: NAO v_tot_item
      (
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
  )                              AS recebido,
      EXISTS (SELECT 1 FROM stockbridge.aprovacao a
               WHERE a.tipo_aprovacao = 'recebimento_externo' AND a.status = 'aprovada'
                 AND a.nf_chave_acesso = u.c_chave_nfe
                 AND upper(regexp_replace(btrim(unaccent(a.nf_item_descricao)), '\s+', ' ', 'g')) = upper(regexp_replace(btrim(unaccent(u.x_prod)), '\s+', ' ', 'g'))) AS baixado_externo,
      EXISTS (SELECT 1 FROM stockbridge.aprovacao a
            WHERE a.tipo_aprovacao = 'recebimento_externo' AND a.status = 'pendente'
              AND a.nf_chave_acesso = u.c_chave_nfe
              AND upper(regexp_replace(btrim(unaccent(a.nf_item_descricao)), '\s+', ' ', 'g')) = upper(regexp_replace(btrim(unaccent(u.x_prod)), '\s+', ' ', 'g')))                       AS baixa_solicitada,
      (SELECT COALESCE(SUM(m.quantidade_nf_kg), 0) FROM stockbridge.movimentacao m
        WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
          AND m.nf_chave_acesso = u.c_chave_nfe
                AND (m.nf_item_descricao_normalizada = upper(regexp_replace(btrim(unaccent(u.x_prod)), '\s+', ' ', 'g')) OR u.n_seq = ANY(m.nf_item_sequencias)))::float8 AS nf_ja_atribuida_kg,
      (SELECT COALESCE(SUM(m.quantidade_kg), 0) FROM stockbridge.movimentacao m
        WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
          AND m.nf_chave_acesso = u.c_chave_nfe
                AND (m.nf_item_descricao_normalizada = upper(regexp_replace(btrim(unaccent(u.x_prod)), '\s+', ' ', 'g')) OR u.n_seq = ANY(m.nf_item_sequencias)))::float8 AS conferida_ja_gravada_kg,
      u.n_seq                                          AS n_seq,
      u.preco_comercial::float8                        AS preco_comercial,
      u.fornecedor_codigo::text                        AS fornecedor_codigo,
      u.n_id_pedido::text                              AS n_id_pedido,
      u.n_id_it_pedido::text                           AS n_id_it_pedido,
      u.n_num_ped_compra                               AS n_num_ped_compra,
      u.c_ignorar_item                                 AS c_ignorar_item,
      u.c_nao_gerar_mov_estoque                        AS c_nao_gerar_mov_estoque,
      u.receb_recebido                                 AS receb_recebido,
      EXISTS (SELECT 1 FROM stockbridge.recebimento_fiscal rf
            WHERE rf.nf_chave_acesso = u.c_chave_nfe AND rf.status IN ('concluido', 'ja_concluido'))  AS ledger_concluido
    FROM nf_unificada u
    WHERE u.c_chave_nfe = $1
    ORDER BY u.n_cod_item
    