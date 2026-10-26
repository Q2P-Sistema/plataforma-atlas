SELECT CASE WHEN (SELECT MAX(CASE WHEN rrp.d_alt IS NOT NULL AND rrp.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrp.d_alt::date + rrp.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END) FROM public."tbl_recebimentoNFe_Q2P" rrp
                WHERE rrp.c_chave_nfe = $1::text AND rrp.c_recebido = 'N' AND COALESCE(rrp.c_cancelada, 'N') <> 'S') - interval '2 minutes' > GREATEST(
              (SELECT MAX(rfc.finalizado_em) FROM stockbridge.recebimento_fiscal rfc
                WHERE rfc.nf_chave_acesso = $1::text AND rfc.status IN ('concluido', 'ja_concluido', 'revertido')),
              (SELECT MAX(CASE WHEN hnc.d_alt IS NOT NULL AND hnc.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (hnc.d_alt::date + hnc.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END) FROM public."tbl_nf_header_Q2P" hnc
                WHERE hnc.c_chave_nfe = $1::text AND hnc.tp_nf = 0),
              (SELECT MAX(GREATEST(CASE WHEN rrc.d_alt IS NOT NULL AND rrc.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrc.d_alt::date + rrc.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END, CASE WHEN rrc.d_rec IS NOT NULL AND rrc.h_rec::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrc.d_rec::date + rrc.h_rec::text::time) AT TIME ZONE 'America/Sao_Paulo' END)) FROM public."tbl_recebimentoNFe_Q2P" rrc
                WHERE rrc.c_chave_nfe = $1::text AND rrc.c_recebido = 'S'))
                THEN (SELECT MAX(CASE WHEN rrp.d_alt IS NOT NULL AND rrp.h_alt::text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN (rrp.d_alt::date + rrp.h_alt::text::time) AT TIME ZONE 'America/Sao_Paulo' END) FROM public."tbl_recebimentoNFe_Q2P" rrp
                WHERE rrp.c_chave_nfe = $1::text AND rrp.c_recebido = 'N' AND COALESCE(rrp.c_cancelada, 'N') <> 'S')
                ELSE (SELECT rfo.revertido_omie_em FROM stockbridge.recebimento_fiscal rfo
                WHERE rfo.nf_chave_acesso = $1::text AND rfo.status = 'revertido'
                ORDER BY COALESCE(rfo.revertido_omie_em, rfo.revertido_em) DESC, rfo.revertido_em DESC
                LIMIT 1) END AS em