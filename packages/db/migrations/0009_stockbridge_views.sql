-- Migration: 009 StockBridge Shared Views
-- Creates 3 views in shared.* schema for cross-module read (Principio I)
-- Depends on migration 0008 and on OMIE sync tables (public.tb_produtos_*, public.tbl_cadastroFornecedoresClientes_*)

-- ── Saldo por produto (agregado por SKU/CNPJ/localidade) ───
-- Consumida pelo Cockpit (US2), Metricas (US7), Forecast, Hedge
CREATE OR REPLACE VIEW shared.vw_sb_saldo_por_produto AS
SELECT
    l.produto_codigo_acxe,
    l.cnpj,
    l.localidade_id,
    SUM(CASE WHEN l.status = 'reconciliado' AND l.estagio_transito IS NULL THEN l.quantidade_fisica ELSE 0 END) AS fisica_disponivel_t,
    SUM(CASE WHEN l.status = 'reconciliado' AND l.estagio_transito IS NULL THEN l.quantidade_fiscal  ELSE 0 END) AS fiscal_t,
    SUM(CASE WHEN l.status = 'provisorio'                                   THEN l.quantidade_fisica ELSE 0 END) AS provisorio_t,
    SUM(CASE WHEN l.estagio_transito = 'transito_intl'                      THEN l.quantidade_fisica ELSE 0 END) AS transito_intl_t,
    SUM(CASE WHEN l.estagio_transito = 'porto_dta'                          THEN l.quantidade_fisica ELSE 0 END) AS porto_dta_t,
    SUM(CASE WHEN l.estagio_transito = 'transito_interno'                   THEN l.quantidade_fisica ELSE 0 END) AS transito_interno_t
FROM stockbridge.lote l
WHERE l.ativo = true
GROUP BY l.produto_codigo_acxe, l.cnpj, l.localidade_id;

-- ── Correlacao de produto ACXE ↔ Q2P (match por descricao) ─
-- Preserva mecanismo legado (clarificacao Q6). Consumida pelo recebimento.
-- NOTA: depende de public.tb_produtos_ACXE e public.tb_produtos_Q2P (sync n8n).
-- Em ambientes sem essas tabelas, a view retorna erro ao ser consultada, mas a criacao nao falha.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('tb_produtos_ACXE', 'tb_produtos_acxe'))
       AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('tb_produtos_Q2P', 'tb_produtos_q2p')) THEN
        EXECUTE $view$
            CREATE OR REPLACE VIEW shared.vw_sb_correlacao_produto AS
            SELECT
                a.codigo_produto AS codigo_produto_acxe,
                q.codigo_produto AS codigo_produto_q2p,
                a.descricao,
                a.codigo_familia AS codigo_familia_acxe,
                q.codigo_familia AS codigo_familia_q2p
            FROM public.tb_produtos_ACXE a
            INNER JOIN public.tb_produtos_Q2P q ON a.descricao = q.descricao
            WHERE (a.inativo IS NULL OR a.inativo <> 'S')
              AND (q.inativo IS NULL OR q.inativo <> 'S')
        $view$;
    ELSE
        RAISE NOTICE 'Tabelas public.tb_produtos_ACXE/Q2P nao existem neste ambiente. View vw_sb_correlacao_produto nao sera criada. Execute sync OMIE primeiro.';
    END IF;
END $$;

-- ── Fornecedor ativo (respeita exclusoes do diretor) ───────
-- Consumida pela Fila OMIE (US1) para filtrar compra nacional
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('tbl_cadastroFornecedoresClientes_ACXE', 'tbl_cadastrofornecedoresclientes_acxe')) THEN
        EXECUTE $view$
            CREATE OR REPLACE VIEW shared.vw_sb_fornecedor_ativo AS
            SELECT f.*
            FROM public.tbl_cadastroFornecedoresClientes_ACXE f
            LEFT JOIN stockbridge.fornecedor_exclusao e
                ON e.fornecedor_cnpj = f.cnpj_cpf
               AND e.reincluido_em IS NULL
            WHERE e.id IS NULL
        $view$;
    ELSE
        RAISE NOTICE 'Tabela public.tbl_cadastroFornecedoresClientes_ACXE nao existe. View vw_sb_fornecedor_ativo nao sera criada.';
    END IF;
END $$;
