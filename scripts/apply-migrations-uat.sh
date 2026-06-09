#!/usr/bin/env bash
# =============================================================================
# apply-migrations-uat.sh
# Aplica as migrations Atlas (packages/db/migrations/*.sql) EM ORDEM no banco UAT.
#
# Por que não `drizzle-kit migrate`? O repo não mantém meta/_journal.json, então
# o runner do drizzle-kit não funciona aqui. As migrations são SQL puro e são
# aplicadas via psql na ordem numérica (0001 -> 0036...).
#
# Cada arquivo roda na própria transação (psql -1 -v ON_ERROR_STOP=1). Na 1ª
# falha o script PARA — corrija a migration e, se necessário, rode o
# sync-acxe-prod-to-uat.sh para resetar o banco antes de tentar de novo.
#
# Pré-requisitos: psql instalado; banco UAT já com o espelho OMIE em public.*
# (rode antes o sync-acxe-prod-to-uat.sh se quiser dados frescos).
#
# Uso:
#   export PGPASSWORD_UAT='senha'        # opcional; sem isso o script pergunta
#   scripts/apply-migrations-uat.sh
# =============================================================================

set -euo pipefail

UAT_HOST="${UAT_HOST:-db.manager01.q2p.com.br}"
UAT_PORT="${UAT_PORT:-5437}"
UAT_DB="${UAT_DB:-acxe_q2p}"
UAT_USER="${UAT_USER:-postgres}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG_DIR="$SCRIPT_DIR/../packages/db/migrations"

command -v psql >/dev/null || { echo "X 'psql' não instalado"; exit 1; }
[ -d "$MIG_DIR" ] || { echo "X migrations não encontradas em $MIG_DIR"; exit 1; }

if [ -z "${PGPASSWORD_UAT:-}" ]; then
  read -rsp "Senha do UAT ($UAT_USER@$UAT_HOST:$UAT_PORT/$UAT_DB): " PGPASSWORD_UAT
  echo
fi

mapfile -t FILES < <(ls "$MIG_DIR"/*.sql | sort)

cat <<EOF

+-------------------------------------------------------------------------+
| APLICAR MIGRATIONS ATLAS -> UAT                                         |
+-------------------------------------------------------------------------+
| Destino : $UAT_USER@$UAT_HOST:$UAT_PORT/$UAT_DB
| Arquivos: ${#FILES[@]} migrations (cada uma em sua transação)
+-------------------------------------------------------------------------+

EOF
read -rp "Continuar? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Abortado."; exit 0; }

for f in "${FILES[@]}"; do
  echo "> aplicando $(basename "$f")"
  PGPASSWORD="$PGPASSWORD_UAT" psql -h "$UAT_HOST" -p "$UAT_PORT" -U "$UAT_USER" \
    -d "$UAT_DB" -1 -v ON_ERROR_STOP=1 -q -f "$f"
done

# Concede leitura ao claude_ro (MCP pg-acxe-uat) nos schemas do Atlas.
# Reaplicado aqui porque o sync (DROP+restore) apaga schemas e grants; e o
# ALTER DEFAULT PRIVILEGES roda como postgres (quem cria as tabelas das
# migrations), cobrindo tabelas/views futuras.
echo
echo "> concedendo SELECT ao claude_ro nos schemas Atlas"
PGPASSWORD="$PGPASSWORD_UAT" psql -h "$UAT_HOST" -p "$UAT_PORT" -U "$UAT_USER" \
  -d "$UAT_DB" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE s text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro') THEN
    FOREACH s IN ARRAY ARRAY['stockbridge','shared','hedge','forecast','breakingpoint']
    LOOP
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO claude_ro', s);
      EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO claude_ro', s);
      EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO claude_ro', s);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO claude_ro', s);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON SEQUENCES TO claude_ro', s);
    END LOOP;
    RAISE NOTICE 'claude_ro: SELECT concedido nos schemas Atlas';
  ELSE
    RAISE NOTICE 'role claude_ro nao existe — pulando grant';
  END IF;
END$$;
SQL

echo
echo "> validando schemas criados"
PGPASSWORD="$PGPASSWORD_UAT" psql -h "$UAT_HOST" -p "$UAT_PORT" -U "$UAT_USER" \
  -d "$UAT_DB" -tAc \
  "SELECT nspname FROM pg_namespace WHERE nspname IN ('shared','stockbridge','hedge','forecast','breakingpoint') ORDER BY 1;"

unset PGPASSWORD_UAT
echo
echo "OK migrations aplicadas."
