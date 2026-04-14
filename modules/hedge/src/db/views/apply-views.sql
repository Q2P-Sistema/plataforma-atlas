-- =============================================================================
-- apply-views.sql — Recria todas as views do módulo hedge na ordem correta
--
-- Ordem de dependência:
--   1. vw_hedge_pagar_usd    (sem deps de view)
--   2. vw_hedge_estoque      (sem deps de view)
--   3. vw_hedge_receber_usd  (sem deps de view)
--   4. vw_hedge_importacoes  (sem deps de view)
--   5. vw_hedge_resumo       (depende das 4 acima)
--
-- Como aplicar:
--   psql -h <host> -U <user> -d acxe_q2p -f apply-views.sql
--
-- As views usam CREATE OR REPLACE VIEW — seguro para re-executar.
-- Não há DROP; se uma view precisar mudar colunas, use DROP VIEW em cascata
-- manualmente antes de rodar este script.
--
-- BDs alvo:
--   dev:  10.0.0.166  (pg-atlas-dev)
--   prod: 10.0.0.143  (pg-acxe)
-- =============================================================================

\echo '-- [1/5] vw_hedge_pagar_usd'
\i vw_hedge_pagar_usd.sql

\echo '-- [2/5] vw_hedge_estoque'
\i vw_hedge_estoque.sql

\echo '-- [3/5] vw_hedge_receber_usd'
\i vw_hedge_receber_usd.sql

\echo '-- [4/5] vw_hedge_importacoes'
\i vw_hedge_importacoes.sql

\echo '-- [5/5] vw_hedge_resumo'
\i vw_hedge_resumo.sql

\echo '-- Todas as views aplicadas com sucesso.'
