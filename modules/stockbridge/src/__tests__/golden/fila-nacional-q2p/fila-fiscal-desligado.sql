
      WITH nf_unificada AS (
        SELECT a.*,
               CASE WHEN COALESCE(rv.n_id_pedido, 0) > 0 THEN rv.n_id_pedido END    AS n_id_pedido,
               CASE WHEN COALESCE(rv.n_id_pedido, 0) > 0 THEN rv.n_id_it_pedido END AS n_id_it_pedido,
               NULLIF(btrim(rv.n_num_ped_compra), '')                                  AS n_num_ped_compra,
               rv.c_associar_existente, rv.c_ignorar_item, rv.c_nao_gerar_mov_estoque,
               rv.c_recebido                                        AS receb_recebido,
               rv.n_qtde_nfe                                        AS q_com_xml,  -- a nota de entrada traz a quantidade RECEBIDA
               rv.c_unidade_nfe                                     AS u_com_xml
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
            AND COALESCE(h.deletada, false) = false AND COALESCE(h.cancelada, false) = false
        ) a
        LEFT JOIN LATERAL (
          SELECT ri.*, r.c_recebido
            FROM public."tbl_recebimentoNFe_Q2P" r
            JOIN public."tbl_recebimentoNFe_itens_Q2P" ri ON ri.n_id_receb = r.n_id_receb
           WHERE r.c_chave_nfe = a.c_chave_nfe AND ri.n_sequencia = a.n_seq
           LIMIT 1
        ) rv ON true
      ),
      linhas AS (
        SELECT
          u.c_chave_nfe, u.n_nf, u.dest_razao, u.dest_cnpj_cpf, u.d_emi, u.fiscal_pendente,
          upper(regexp_replace(btrim(unaccent(u.x_prod)), '\s+', ' ', 'g'))                    AS desc_norm,
          u.valor_item                   AS valor_item,
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
  )            AS recebido,
          -- FR-030 (research D25): pendencia por RESTANTE do lado da NF. Item com
          -- 1 de N produtos gravado (falha/retomada) continua na fila; legado
          -- (match por numero, sem parcela) NAO cai aqui — nf_atribuida = 0.
          -- Duas quantidades oficiais (D19): a nota de entrada (quantidade RECEBIDA, editavel no portal) e
          -- o XML (so na faixa comparavel; fora dela e unidade trocada e vale a nota de entrada).
          (u.q_com * CASE upper(btrim(u.u_com)) WHEN 'KG' THEN 1 WHEN 'TON' THEN 1000 WHEN 'TL' THEN 1000 END) AS nf_kg,
          CASE WHEN (u.q_com_xml * CASE upper(btrim(u.u_com_xml)) WHEN 'KG' THEN 1 WHEN 'TON' THEN 1000 WHEN 'TL' THEN 1000 END) BETWEEN (u.q_com * CASE upper(btrim(u.u_com)) WHEN 'KG' THEN 1 WHEN 'TON' THEN 1000 WHEN 'TL' THEN 1000 END) * 0.5 AND (u.q_com * CASE upper(btrim(u.u_com)) WHEN 'KG' THEN 1 WHEN 'TON' THEN 1000 WHEN 'TL' THEN 1000 END) * 2 THEN (u.q_com_xml * CASE upper(btrim(u.u_com_xml)) WHEN 'KG' THEN 1 WHEN 'TON' THEN 1000 WHEN 'TL' THEN 1000 END) ELSE (u.q_com * CASE upper(btrim(u.u_com)) WHEN 'KG' THEN 1 WHEN 'TON' THEN 1000 WHEN 'TL' THEN 1000 END) END AS nf_kg_xml,
          (SELECT COALESCE(SUM(m.quantidade_nf_kg), 0) FROM stockbridge.movimentacao m
            WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
              AND m.nf_chave_acesso = u.c_chave_nfe
                AND (m.nf_item_descricao_normalizada = upper(regexp_replace(btrim(unaccent(u.x_prod)), '\s+', ' ', 'g')) OR u.n_seq = ANY(m.nf_item_sequencias)))       AS nf_atribuida,
          -- 017 (D7): recebimento concluido fora do Atlas COM movimento de estoque no OMIE
          (u.receb_recebido = 'S' AND u.c_ignorar_item = 'N' AND u.c_nao_gerar_mov_estoque = 'N') AS estoque_lancado
        FROM nf_unificada u
        WHERE u.cfop = ANY($1::text[])
          AND NOT u.cancelada AND NOT u.deletada
          AND NOT EXISTS (
        SELECT 1 FROM stockbridge.fornecedor_exclusao fe
         WHERE fe.reincluido_em IS NULL AND fe.fornecedor_cnpj = u.dest_cnpj_cpf AND fe.empresa = 'q2p')
          AND NOT EXISTS (
        SELECT 1 FROM stockbridge.nf_dispensa d
         WHERE d.nf_chave_acesso = u.c_chave_nfe AND d.revertido_em IS NULL)
      ),
      itens AS (
        SELECT c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi, desc_norm,
               bool_or(fiscal_pendente)                                 AS fiscal_pendente,
               SUM(valor_item)                                          AS valor_item,
               bool_and(recebido)                                       AS recebido,
               SUM(nf_kg)                                               AS nf_kg,
               SUM(nf_kg_xml)                                           AS nf_kg_xml,
               MAX(nf_atribuida)                                        AS nf_atribuida,
               bool_or(estoque_lancado)                                 AS estoque_lancado
        FROM linhas
        GROUP BY c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi, desc_norm
      ),
      itens_flag AS (
        SELECT *,
               (NOT recebido
                OR (nf_kg IS NOT NULL AND nf_atribuida > 0 AND GREATEST(0, LEAST(
                  CASE WHEN nf_kg >= nf_atribuida - 1 THEN nf_kg - nf_atribuida END,
                  CASE WHEN nf_kg_xml >= nf_atribuida - 1 THEN nf_kg_xml - nf_atribuida END)) > 1)) AS pendente
        FROM itens
      )
      SELECT
        c_chave_nfe                                                   AS nf_chave_acesso,
        ltrim(n_nf, '0')                                              AS nota_fiscal,
        dest_razao                                                    AS fornecedor_nome,
        dest_cnpj_cpf                                                 AS fornecedor_cnpj,
        d_emi::text                                                   AS dt_emissao,
        (CURRENT_DATE - d_emi::date)::int                             AS dias_desde_emissao,
        COUNT(*)::int                                                 AS itens_total,
        COUNT(*) FILTER (WHERE pendente)::int                         AS itens_pendentes,
        SUM(valor_item)::float8                                       AS valor_total_brl,
        CASE WHEN bool_or(fiscal_pendente) THEN 'pendente' ELSE 'concluido' END AS fiscal,
        NULL::text                                       AS fiscal_concluido_em,
        COALESCE(bool_or(estoque_lancado) FILTER (WHERE pendente), false) AS estoque_lancado
      FROM itens_flag
      GROUP BY c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi
      HAVING COUNT(*) FILTER (WHERE pendente) > 0
      ORDER BY d_emi ASC, n_nf ASC
      