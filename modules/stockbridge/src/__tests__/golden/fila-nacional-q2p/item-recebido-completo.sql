(
    EXISTS (SELECT 1 FROM stockbridge.movimentacao m
              WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
                AND m.nf_chave_acesso = u.c_chave_nfe
                AND (m.nf_item_descricao_normalizada = DESC_NORM OR u.n_seq = ANY(m.nf_item_sequencias)))
    OR EXISTS (SELECT 1 FROM stockbridge.movimentacao m
              WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
                AND m.nf_chave_acesso IS NULL
                AND m.empresa = 'q2p'
                AND ltrim(m.nota_fiscal, '0') = ltrim(u.n_nf, '0')
                AND m.created_at >= (u.d_emi)::date)
    OR EXISTS (SELECT 1 FROM stockbridge.aprovacao a
              WHERE a.tipo_aprovacao = 'recebimento_externo' AND a.status = 'aprovada'
                AND a.nf_chave_acesso = u.c_chave_nfe
                AND upper(regexp_replace(btrim(unaccent(a.nf_item_descricao)), '\s+', ' ', 'g')) = DESC_NORM)
  )