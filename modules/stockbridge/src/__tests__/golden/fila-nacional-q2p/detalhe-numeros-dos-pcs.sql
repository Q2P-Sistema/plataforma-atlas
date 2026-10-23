SELECT ncodped::text AS ncodped, MIN(btrim(cnumero)) AS numero, 1 AS prio
         FROM public."tbl_pedidosCompras_Q2P" WHERE ncodped = ANY($1::bigint[]) GROUP BY ncodped
       UNION ALL
       SELECT n_cod_ped::text, MIN(btrim(pc_numero)), 2
         FROM stockbridge.recebimento_fiscal_pc WHERE n_cod_ped = ANY($1::bigint[]) AND status = 'concluido' GROUP BY n_cod_ped
       UNION ALL
       SELECT n_cod_ped::text, MIN(NULLIF(btrim(pc_numero), '')), 3
         FROM stockbridge.pedido_compra_visto WHERE empresa = 'q2p' AND n_cod_ped = ANY($1::bigint[]) GROUP BY n_cod_ped
       ORDER BY 3