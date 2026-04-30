#!/usr/bin/env bash
# =============================================================================
# sync-vendas-prod-to-dev.sh
# Copia tabelas de vendas (ACXE + Q2P matriz + Q2P filial, com itens) +
# cadastro de produtos da Filial do Postgres de producao para o pg-atlas-dev.
# Dump COMPLETO (schema + dados): as tabelas no destino sao DROP + recriadas a
# partir do prod.
#
# Tabelas:
#   - public."tbl_pedidosVendas_ACXE"            + _itens_ACXE
#   - public."tbl_pedidosVendas_Q2P"             + _itens_Q2P
#   - public."tbl_pedidosVendas_Q2P_Filial"      + _itens_Q2P_Filial
#   - public."tbl_produtos_Q2P_Filial"           (cadastro de produtos da Filial,
#       necessario pra match por descricao na funcao StockBridge — produtos da
#       ACXE/Q2P matriz vem por outros syncs e ja estao em dev)
#
# Tratamento de views dependentes:
#   pg_restore --clean nao suporta CASCADE. Se houver views (ou matviews) no
#   dev dependendo dessas tabelas, o DROP TABLE falha silenciosamente, o
#   restore tenta inserir por cima dos dados existentes e duplica tudo.
#   Esse script faz o tratamento manual: detecta views dependentes, salva a
#   definicao, dropa, roda o restore, e recria as views ao final.
#
# Pre-requisitos:
#   - bw (Bitwarden CLI) logado, BW_SESSION exportado
#   - direnv allow ja rodado neste diretorio (pra DATABASE_URL_PASSWORD)
#   - pg_dump / pg_restore / psql instalados (mesma major version do servidor)
#   - jq
#   - Variaveis de ambiente do prod setadas antes de rodar:
#       PROD_USER         usuario do db.manager01.q2p.com.br
#       PGPASSWORD_PROD   senha (se nao setada, sera pedida)
#
# Uso:
#   export PROD_USER=meu.usuario
#   export PGPASSWORD_PROD='senhaaqui'   # opcional; sem isso o script pergunta
#   scripts/sync-vendas-prod-to-dev.sh
# =============================================================================

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
PROD_HOST="${PROD_HOST:-db.manager01.q2p.com.br}"
PROD_PORT="${PROD_PORT:-5432}"
PROD_DB="${PROD_DB:-acxe_q2p}"
PROD_USER="${PROD_USER:-}"

DEV_HOST="${DEV_HOST:-159.203.89.175}"
DEV_PORT="${DEV_PORT:-5436}"
DEV_DB="${DEV_DB:-acxe_q2p}"
DEV_USER="${DEV_USER:-postgres}"

PARALLEL_JOBS="${PARALLEL_JOBS:-4}"
DUMP_DIR="/tmp/vendas_dump_$(date +%Y%m%d_%H%M%S)"
DEP_VIEWS_FILE="$DUMP_DIR/_dependent_views.sql"

TABLES=(
  'tbl_pedidosVendas_ACXE'
  'tbl_pedidosVendas_itens_ACXE'
  'tbl_pedidosVendas_Q2P'
  'tbl_pedidosVendas_itens_Q2P'
  'tbl_pedidosVendas_Q2P_Filial'
  'tbl_pedidosVendas_itens_Q2P_Filial'
  'tbl_produtos_Q2P_Filial'
)

# ── Pre-checks ───────────────────────────────────────────────────────────────
[ -z "${BW_SESSION:-}" ] && {
  echo "❌ BW_SESSION nao setado."
  echo "   Rode primeiro: export BW_SESSION=\$(bw unlock --raw)"
  exit 1
}

[ -z "$PROD_USER" ] && {
  echo "❌ PROD_USER nao setado."
  echo "   Rode: export PROD_USER=<seu-usuario-prod>"
  exit 1
}

if [ -z "${PGPASSWORD_PROD:-}" ]; then
  read -rsp "Senha do prod ($PROD_USER@$PROD_HOST): " PGPASSWORD_PROD
  echo
fi

for cmd in pg_dump pg_restore psql jq bw; do
  command -v "$cmd" >/dev/null || { echo "❌ '$cmd' nao instalado"; exit 1; }
done

# Senha do dev via Bitwarden
DEV_PASSWORD="$(bw get item 'Atlas Dev Secrets' --session "$BW_SESSION" 2>/dev/null \
  | jq -r '.fields[] | select(.name=="DATABASE_URL_PASSWORD") | .value')"
[ -z "$DEV_PASSWORD" ] || [ "$DEV_PASSWORD" = "null" ] && {
  echo "❌ Nao consegui ler DATABASE_URL_PASSWORD do Bitwarden."
  exit 1
}

# Helpers psql
dev_psql() {
  PGPASSWORD="$DEV_PASSWORD" psql -h "$DEV_HOST" -p "$DEV_PORT" -U "$DEV_USER" -d "$DEV_DB" "$@"
}

# ── Confirmacao ──────────────────────────────────────────────────────────────
cat <<EOF

┌─────────────────────────────────────────────────────────────────────────┐
│ SYNC vendas prod → dev                                                  │
├─────────────────────────────────────────────────────────────────────────┤
│ Origem : $PROD_USER@$PROD_HOST:$PROD_PORT/$PROD_DB
│ Destino: $DEV_USER@$DEV_HOST:$DEV_PORT/$DEV_DB
│ Dump   : $DUMP_DIR (-j $PARALLEL_JOBS)
│ Modo   : COMPLETO — DROP + recriar ${#TABLES[@]} tabelas no dev (CASCADE)
│         + views dependentes serao salvas e recriadas
└─────────────────────────────────────────────────────────────────────────┘

Tabelas:
$(printf '  - public."%s"\n' "${TABLES[@]}")

EOF
read -rp "Continuar? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Abortado."; exit 0; }

mkdir -p "$DUMP_DIR"

# ── 1) Captura definicao das views dependentes ───────────────────────────────
echo
echo "▶ [1/5] Detectando views/matviews dependentes no dev"

# Lista de views dependentes (qualified name)
DEP_VIEWS=$(dev_psql -A -t -X <<SQL
SELECT DISTINCT quote_ident(n.nspname) || '.' || quote_ident(c.relname)
FROM pg_depend d
JOIN pg_rewrite r        ON r.oid = d.objid
JOIN pg_class c          ON c.oid = r.ev_class
JOIN pg_namespace n      ON n.oid = c.relnamespace
JOIN pg_class src        ON src.oid = d.refobjid
JOIN pg_namespace nsrc   ON nsrc.oid = src.relnamespace
WHERE nsrc.nspname = 'public'
  AND src.relname IN ($(printf "'%s'," "${TABLES[@]}" | sed 's/,$//'))
  AND c.relkind IN ('v','m')
  AND c.relname NOT IN ($(printf "'%s'," "${TABLES[@]}" | sed 's/,$//'));
SQL
)

if [ -z "$DEP_VIEWS" ]; then
  echo "  ✓ Nenhuma view dependente — restore direto."
  : > "$DEP_VIEWS_FILE"
else
  echo "  Views encontradas:"
  echo "$DEP_VIEWS" | sed 's/^/    - /'

  # Salva definicoes em arquivo SQL
  : > "$DEP_VIEWS_FILE"
  while IFS= read -r view; do
    [ -z "$view" ] && continue
    kind=$(dev_psql -A -t -X -c "SELECT relkind FROM pg_class WHERE oid='$view'::regclass;")
    case "$kind" in
      v) keyword="VIEW" ;;
      m) keyword="MATERIALIZED VIEW" ;;
      *) echo "  ⚠ relkind '$kind' nao suportado pra '$view' — pulando"; continue ;;
    esac
    def=$(dev_psql -A -t -X -c "SELECT pg_get_viewdef('$view'::regclass, true);")
    {
      echo "-- $view"
      echo "DROP $keyword IF EXISTS $view;"
      echo "CREATE $keyword $view AS"
      echo "$def"
      echo ""
    } >> "$DEP_VIEWS_FILE"
  done <<< "$DEP_VIEWS"

  echo "  ✓ Definicoes salvas em $DEP_VIEWS_FILE"
  echo
  echo "  DROP das views (necessario antes do restore)..."
  while IFS= read -r view; do
    [ -z "$view" ] && continue
    kind=$(dev_psql -A -t -X -c "SELECT relkind FROM pg_class WHERE oid='$view'::regclass;")
    keyword=$([ "$kind" = "m" ] && echo "MATERIALIZED VIEW" || echo "VIEW")
    dev_psql -v ON_ERROR_STOP=1 -c "DROP $keyword IF EXISTS $view;"
  done <<< "$DEP_VIEWS"
fi

# ── 2) Dump do prod ──────────────────────────────────────────────────────────
echo
echo "▶ [2/5] pg_dump (prod) → $DUMP_DIR/dump"
echo

DUMP_ARGS=(-h "$PROD_HOST" -p "$PROD_PORT" -U "$PROD_USER" -d "$PROD_DB"
  -Fd -j "$PARALLEL_JOBS"
  --no-owner --no-privileges
  -f "$DUMP_DIR/dump" --verbose)
for t in "${TABLES[@]}"; do
  DUMP_ARGS+=(-t "public.\"$t\"")
done

PGPASSWORD="$PGPASSWORD_PROD" pg_dump "${DUMP_ARGS[@]}"

echo
echo "✓ Dump pronto. Tamanho: $(du -sh "$DUMP_DIR/dump" | awk '{print $1}')"

# ── 3) Restore no dev ────────────────────────────────────────────────────────
echo
echo "▶ [3/5] pg_restore (dev) — DROP + recriar tabelas"
echo

PGPASSWORD="$DEV_PASSWORD" pg_restore \
  -h "$DEV_HOST" -p "$DEV_PORT" -U "$DEV_USER" -d "$DEV_DB" \
  -j "$PARALLEL_JOBS" \
  --clean --if-exists \
  --no-owner --no-privileges \
  --verbose "$DUMP_DIR/dump"

# ── 4) Recriar views ─────────────────────────────────────────────────────────
if [ -s "$DEP_VIEWS_FILE" ]; then
  echo
  echo "▶ [4/5] Recriando views dependentes"
  dev_psql -v ON_ERROR_STOP=1 -f "$DEP_VIEWS_FILE"
  echo "  ✓ Views recriadas"
else
  echo
  echo "▶ [4/5] Sem views dependentes — pulando"
fi

# ── 5) Validacao ─────────────────────────────────────────────────────────────
echo
echo "▶ [5/5] Validando contagens no dev"
echo

dev_psql -v ON_ERROR_STOP=1 -X -A -F$'\t' <<SQL
\\echo Contagens:
$(for t in "${TABLES[@]}"; do
    echo "SELECT '$t' AS tabela, count(*) FROM public.\"$t\" UNION ALL"
  done | sed '$ s/UNION ALL$/;/')
SQL

# ── Limpeza ──────────────────────────────────────────────────────────────────
echo
read -rp "Remover $DUMP_DIR? [Y/n] " cleanup
if [[ ! "$cleanup" =~ ^[Nn]$ ]]; then
  rm -rf "$DUMP_DIR"
  echo "✓ Dump removido."
else
  echo "Dump preservado em $DUMP_DIR (defs de view em $DEP_VIEWS_FILE)"
fi

unset PGPASSWORD_PROD DEV_PASSWORD
echo
echo "✅ Sync concluido."
