#!/usr/bin/env bash
# =============================================================================
# sync-acxe-dev-to-uat.sh
# Copia o banco acxe_q2p INTEIRO de dev -> uat.
# Estrategia: DROP DATABASE no destino + CREATE DATABASE + pg_restore.
# Tudo (schemas, tabelas, views, funcoes, triggers, sequences, dados) e
# recriado a partir do dump do dev. O destino fica identico ao dev.
#
# Pre-requisitos:
#   - bw (Bitwarden CLI) logado, BW_SESSION exportado (pra senha do dev)
#   - pg_dump / pg_restore / psql instalados (>= major version do servidor)
#   - jq
#   - Variaveis opcionais:
#       PGPASSWORD_UAT   senha do postgres no UAT (se nao setada, sera pedida)
#
# Uso:
#   export BW_SESSION=$(bw unlock --raw)
#   export PGPASSWORD_UAT='senhaaqui'    # opcional; sem isso o script pergunta
#   scripts/sync-acxe-dev-to-uat.sh
# =============================================================================

set -euo pipefail

# -- Config ------------------------------------------------------------------
DEV_HOST="${DEV_HOST:-159.203.89.175}"
DEV_PORT="${DEV_PORT:-5436}"
DEV_DB="${DEV_DB:-acxe_q2p}"
DEV_USER="${DEV_USER:-postgres}"

UAT_HOST="${UAT_HOST:-db.manager01.q2p.com.br}"
UAT_PORT="${UAT_PORT:-5437}"
UAT_DB="${UAT_DB:-acxe_q2p}"
UAT_USER="${UAT_USER:-postgres}"

PARALLEL_JOBS="${PARALLEL_JOBS:-4}"
DUMP_DIR="/tmp/acxe_dump_$(date +%Y%m%d_%H%M%S)"

# -- Pre-checks --------------------------------------------------------------
[ -z "${BW_SESSION:-}" ] && {
  echo "X BW_SESSION nao setado."
  echo "   Rode primeiro: export BW_SESSION=\$(bw unlock --raw)"
  exit 1
}

for cmd in pg_dump pg_restore psql jq bw; do
  command -v "$cmd" >/dev/null || { echo "X '$cmd' nao instalado"; exit 1; }
done

# Senha do dev via Bitwarden
DEV_PASSWORD="$(bw get item 'Atlas Dev Secrets' --session "$BW_SESSION" 2>/dev/null \
  | jq -r '.fields[] | select(.name=="DATABASE_URL_PASSWORD") | .value')"
[ -z "$DEV_PASSWORD" ] || [ "$DEV_PASSWORD" = "null" ] && {
  echo "X Nao consegui ler DATABASE_URL_PASSWORD do Bitwarden (item 'Atlas Dev Secrets')."
  exit 1
}

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
| SYNC FULL acxe_q2p  dev -> uat                                          |
+-------------------------------------------------------------------------+
| Origem : $DEV_USER@$DEV_HOST:$DEV_PORT/$DEV_DB
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

PGPASSWORD="$DEV_PASSWORD" psql -h "$DEV_HOST" -p "$DEV_PORT" -U "$DEV_USER" \
  -d "$DEV_DB" -tAc "SELECT 1" >/dev/null
echo "  ok dev: $DEV_USER@$DEV_HOST:$DEV_PORT/$DEV_DB"

uat_psql_admin -tAc "SELECT 1" >/dev/null
echo "  ok uat: $UAT_USER@$UAT_HOST:$UAT_PORT/postgres"

# -- 2) Dump do dev ----------------------------------------------------------
echo
echo "> [2/5] pg_dump (dev) -> $DUMP_DIR/dump"
echo

PGPASSWORD="$DEV_PASSWORD" pg_dump \
  -h "$DEV_HOST" -p "$DEV_PORT" -U "$DEV_USER" -d "$DEV_DB" \
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

# -- Re-grant claude_ro -------------------------------------------------------
echo
echo "> Re-grant SELECT para claude_ro (MCP)"
uat_psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro') THEN
    RAISE NOTICE 'role claude_ro nao existe no UAT — pulando grant';
  ELSE
    GRANT CONNECT ON DATABASE acxe_q2p TO claude_ro;
    GRANT USAGE ON SCHEMA public TO claude_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO claude_ro;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO claude_ro;
    RAISE NOTICE 'claude_ro re-grant ok';
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

unset PGPASSWORD_UAT DEV_PASSWORD
echo
echo "OK Sync concluido."
