-- =============================================================================
-- Usuário do PROD para a cópia diária do espelho PROD -> UAT (atlas-uat-sync,
-- ACXEGDP-405). Somente leitura, só no schema public.
--
-- Rodar no PROD (porta 5432, banco acxe_q2p) como postgres, trocando a senha:
--   psql -h db.manager01.q2p.com.br -p 5432 -U postgres -d acxe_q2p -f usuario-prod.sql
-- A mesma senha vai em PGPASSWORD_PROD na stack atlas-uat-sync do Portainer.
--
-- Por que não o claude_ro: ele é o usuário das consultas do Claude; com a cópia
-- dependendo dele, trocar ou revogar o acesso do Claude derrubaria o UAT junto.
-- =============================================================================

CREATE ROLE uat_sync_ro LOGIN PASSWORD 'TROCAR_POR_SENHA_FORTE'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

-- reforço: mesmo com um erro no script, nenhuma escrita passa
ALTER ROLE uat_sync_ro SET default_transaction_read_only = on;

GRANT CONNECT ON DATABASE acxe_q2p TO uat_sync_ro;
GRANT USAGE ON SCHEMA public TO uat_sync_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO uat_sync_ro;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO uat_sync_ro;

-- O n8n recria tabelas em public (staging -> swap) como postgres; sem o default
-- a tabela recriada nasce sem SELECT e a cópia daquela tabela falha.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO uat_sync_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON SEQUENCES TO uat_sync_ro;

-- Conferência 1: tabelas de public que o usuário NÃO lê (deve voltar vazio).
SELECT c.relname AS tabela_sem_select
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
   AND NOT has_table_privilege('uat_sync_ro', c.oid, 'SELECT');

-- Conferência 2: donos das tabelas de public. O default acima só cobre as criadas
-- por postgres; em 04/11/2026 eram 125 do postgres e 2 do claude_ro (monitoramento
-- do n8n, já cobertas pelo GRANT ON ALL TABLES). Dono novo e recorrente: repetir o
-- ALTER DEFAULT PRIVILEGES com FOR ROLE <dono>.
SELECT tableowner, count(*) FROM pg_tables WHERE schemaname = 'public' GROUP BY 1 ORDER BY 2 DESC;
