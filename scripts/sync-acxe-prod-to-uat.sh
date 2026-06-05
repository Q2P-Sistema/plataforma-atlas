#!/usr/bin/env bash
# =============================================================================
# sync-acxe-prod-to-uat.sh
# Copia o banco acxe_q2p INTEIRO de prod -> uat.
# Estrategia: DROP DATABASE no destino + CREATE DATABASE + pg_restore.
# Tudo (schemas, tabelas, views, funcoes, triggers, sequences, dados) e
# recriado a partir do dump do prod. O destino fica identico ao prod.
#
# Apos o restore, reaplica:
#   - SELECT em public.* para 'claude_ro' (MCP read-only)
#   - Ownership do schema 'crm' para 'crm_dev' + SELECT em public.*
#     (acessos criados em UAT que precisam sobreviver ao sync)
#
# Pre-requisitos:
#   - pg_dump / pg_restore / psql instalados (>= major version do servidor)
#   - Variaveis de ambiente do prod (obrigatorias):
#       PROD_USER         usuario do db.manager01.q2p.com.br
#       PGPASSWORD_PROD   senha (se nao setada, sera pedida)
#   - Variaveis do UAT (opcional):
#       PGPASSWORD_UAT    senha do postgres no UAT (se nao setada, sera pedida)
#
# Uso:
#   export PROD_USER=meu.usuario
#   export PGPASSWORD_PROD='senhaaqui'    # opcional; sem isso o script pergunta
#   export PGPASSWORD_UAT='senhaaqui'     # opcional; sem isso o script pergunta
#   scripts/sync-acxe-prod-to-uat.sh
# =============================================================================

set -euo pipefail

# -- Config ------------------------------------------------------------------
PROD_HOST="${PROD_HOST:-db.manager01.q2p.com.br}"
PROD_PORT="${PROD_PORT:-5432}"
PROD_DB="${PROD_DB:-acxe_q2p}"
PROD_USER="${PROD_USER:-}"

UAT_HOST="${UAT_HOST:-db.manager01.q2p.com.br}"
UAT_PORT="${UAT_PORT:-5437}"
UAT_DB="${UAT_DB:-acxe_q2p}"
UAT_USER="${UAT_USER:-postgres}"

PARALLEL_JOBS="${PARALLEL_JOBS:-4}"
DUMP_DIR="/tmp/acxe_dump_$(date +%Y%m%d_%H%M%S)"

# -- Pre-checks --------------------------------------------------------------
[ -z "$PROD_USER" ] && {
  echo "X PROD_USER nao setado."
  echo "   Rode: export PROD_USER=<seu-usuario-prod>"
  exit 1
}

for cmd in pg_dump pg_restore psql; do
  command -v "$cmd" >/dev/null || { echo "X '$cmd' nao instalado"; exit 1; }
done

# Senha do prod
if [ -z "${PGPASSWORD_PROD:-}" ]; then
  read -rsp "Senha do prod ($PROD_USER@$PROD_HOST:$PROD_PORT): " PGPASSWORD_PROD
  echo
fi

# Senha do UAT
if [ -z "${PGPASSWORD_UAT:-}" ]; then
  read -rsp "Senha do UAT ($UAT_USER@$UAT_HOST:$UAT_PORT): " PGPASSWORD_UAT
  echo
fi

# Helpers psql
uat_psql_admin() {
  # Conecta ao banco 'postgres' do UAT pra dar DROP/CREATE no acxe_q2p
  PGPASSWORD="$PGPASSWORD_UAT" psql -h "$UAT_HOST" -p "$UAT_PORT" -U "$UAT_USER" -d postgres "$@"
}

uat_psql() {
  PGPASSWORD="$PGPASSWORD_UAT" psql -h "$UAT_HOST" -p "$UAT_PORT" -U "$UAT_USER" -d "$UAT_DB" "$@"
}

# -- Confirmacao -------------------------------------------------------------
cat <<EOF

+-------------------------------------------------------------------------+
| SYNC FULL acxe_q2p  prod -> uat                                         |
+-------------------------------------------------------------------------+
| Origem : $PROD_USER@$PROD_HOST:$PROD_PORT/$PROD_DB
| Destino: $UAT_USER@$UAT_HOST:$UAT_PORT/$UAT_DB
| Dump   : $DUMP_DIR (-j $PARALLEL_JOBS)
| Modo   : DROP DATABASE + CREATE DATABASE + restore COMPLETO
|          (todos os dados/schemas do UAT serao SOBRESCRITOS)
+-------------------------------------------------------------------------+

EOF
read -rp "Continuar? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Abortado."; exit 0; }

mkdir -p "$DUMP_DIR"

# -- 1) Validar conectividade -------------------------------------------------
echo
echo "> [1/5] Validando conectividade"

PGPASSWORD="$PGPASSWORD_PROD" psql -h "$PROD_HOST" -p "$PROD_PORT" -U "$PROD_USER" \
  -d "$PROD_DB" -tAc "SELECT 1" >/dev/null
echo "  ok prod: $PROD_USER@$PROD_HOST:$PROD_PORT/$PROD_DB"

uat_psql_admin -tAc "SELECT 1" >/dev/null
echo "  ok uat: $UAT_USER@$UAT_HOST:$UAT_PORT/postgres"

# -- 2) Dump do prod ----------------------------------------------------------
echo
echo "> [2/5] pg_dump (prod) -> $DUMP_DIR/dump"
echo

PGPASSWORD="$PGPASSWORD_PROD" pg_dump \
  -h "$PROD_HOST" -p "$PROD_PORT" -U "$PROD_USER" -d "$PROD_DB" \
  -Fd -j "$PARALLEL_JOBS" \
  --no-owner --no-privileges \
  -f "$DUMP_DIR/dump" \
  --verbose

echo
echo "  ok dump pronto. Tamanho: $(du -sh "$DUMP_DIR/dump" | awk '{print $1}')"

# -- 3) DROP + CREATE database no UAT -----------------------------------------
echo
echo "> [3/5] Recriando database $UAT_DB no UAT"

# DROP com FORCE termina conexoes ativas (PG 13+). Necessario porque uma
# sessao aberta no banco impede o DROP. Em PG 16 (nosso UAT) e suportado.
uat_psql_admin -v ON_ERROR_STOP=1 <<SQL
DROP DATABASE IF EXISTS "$UAT_DB" WITH (FORCE);
CREATE DATABASE "$UAT_DB";
SQL

echo "  ok database recriada"

# -- 4) Restore no UAT --------------------------------------------------------
echo
echo "> [4/5] pg_restore (uat)"
echo

PGPASSWORD="$PGPASSWORD_UAT" pg_restore \
  -h "$UAT_HOST" -p "$UAT_PORT" -U "$UAT_USER" -d "$UAT_DB" \
  -j "$PARALLEL_JOBS" \
  --no-owner --no-privileges \
  --verbose "$DUMP_DIR/dump"

# -- 5) Validacao -------------------------------------------------------------
echo
echo "> [5/5] Validando UAT"
echo

uat_psql -X -A -F$'\t' <<'SQL'
\echo
\echo Schemas:
SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY nspname;
\echo
\echo Top 20 tabelas por tamanho:
SELECT
  schemaname || '.' || relname AS tabela,
  pg_size_pretty(pg_total_relation_size(relid)) AS tamanho,
  n_live_tup AS linhas
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 20;
\echo
\echo Totais:
SELECT
  (SELECT count(*) FROM pg_stat_user_tables) AS tabelas,
  (SELECT count(*) FROM pg_views WHERE schemaname NOT IN ('pg_catalog','information_schema')) AS views,
  (SELECT count(*) FROM pg_matviews) AS matviews,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')) AS funcoes;
SQL

# -- Reaplicar acessos do UAT -------------------------------------------------
# Roles sao cluster-level e sobrevivem ao DROP DATABASE, mas os GRANTs e a
# ownership de schema sao por-banco e foram perdidos. Reaplica aqui o que
# foi configurado especificamente no UAT (claude_ro pro MCP, crm_dev pra
# equipe de CRM). Se a role nao existir no cluster, pula com aviso.
echo
echo "> Reaplicando acessos UAT-only (claude_ro, crm_dev)"
uat_psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  -- claude_ro: SELECT em public.*
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro') THEN
    GRANT CONNECT ON DATABASE acxe_q2p TO claude_ro;
    GRANT USAGE ON SCHEMA public TO claude_ro;
    GRANT SELECT ON ALL TABLES    IN SCHEMA public TO claude_ro;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO claude_ro;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES    TO claude_ro;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO claude_ro;
    RAISE NOTICE 'claude_ro ok';
  ELSE
    RAISE NOTICE 'role claude_ro nao existe — pulando';
  END IF;

  -- crm_dev: dono do schema crm + SELECT em public
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_dev') THEN
    GRANT CONNECT ON DATABASE acxe_q2p TO crm_dev;

    -- Schema crm pode nao existir em prod ainda; cria se preciso e da owner
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'crm') THEN
      CREATE SCHEMA crm AUTHORIZATION crm_dev;
    ELSE
      ALTER SCHEMA crm OWNER TO crm_dev;
    END IF;

    GRANT USAGE ON SCHEMA public TO crm_dev;
    GRANT SELECT ON ALL TABLES    IN SCHEMA public TO crm_dev;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO crm_dev;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES    TO crm_dev;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO crm_dev;
    RAISE NOTICE 'crm_dev ok';
  ELSE
    RAISE NOTICE 'role crm_dev nao existe — pulando';
  END IF;
END$$;
SQL

# -- Limpeza ------------------------------------------------------------------
echo
read -rp "Remover $DUMP_DIR? [Y/n] " cleanup
if [[ ! "$cleanup" =~ ^[Nn]$ ]]; then
  rm -rf "$DUMP_DIR"
  echo "  ok dump removido"
else
  echo "  dump preservado em $DUMP_DIR"
fi

unset PGPASSWORD_PROD PGPASSWORD_UAT
echo
echo "OK Sync concluido."
