#!/usr/bin/env bash
# =============================================================================
# sync-vendas-prod-to-dev.sh
# Copia as 6 tabelas de vendas (ACXE + Q2P matriz + Q2P filial, com itens) do
# Postgres de producao para o pg-atlas-dev. Dump COMPLETO (schema + dados):
# as tabelas no destino sao DROP + recriadas a partir do prod.
#
# Tabelas:
#   - public."tbl_pedidosVendas_ACXE"            + _itens_ACXE
#   - public."tbl_pedidosVendas_Q2P"             + _itens_Q2P
#   - public."tbl_pedidosVendas_Q2P_Filial"      + _itens_Q2P_Filial
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
#
# Cuidado: as 6 tabelas no dev sao DROPadas (CASCADE) e recriadas. Qualquer
# view/trigger/FK em dev que dependa delas sera removida junto.
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

TABLES=(
  'public."tbl_pedidosVendas_ACXE"'
  'public."tbl_pedidosVendas_itens_ACXE"'
  'public."tbl_pedidosVendas_Q2P"'
  'public."tbl_pedidosVendas_itens_Q2P"'
  'public."tbl_pedidosVendas_Q2P_Filial"'
  'public."tbl_pedidosVendas_itens_Q2P_Filial"'
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

# ── Confirmacao ──────────────────────────────────────────────────────────────
cat <<EOF

┌─────────────────────────────────────────────────────────────────────────┐
│ SYNC vendas prod → dev                                                  │
├─────────────────────────────────────────────────────────────────────────┤
│ Origem : $PROD_USER@$PROD_HOST:$PROD_PORT/$PROD_DB
│ Destino: $DEV_USER@$DEV_HOST:$DEV_PORT/$DEV_DB
│ Dump   : $DUMP_DIR (-j $PARALLEL_JOBS)
│ Modo   : COMPLETO — DROP + recriar as 6 tabelas no dev (CASCADE)
└─────────────────────────────────────────────────────────────────────────┘

Tabelas:
$(printf '  - %s\n' "${TABLES[@]}")

EOF
read -rp "Continuar? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Abortado."; exit 0; }

# ── 1) Dump do prod ──────────────────────────────────────────────────────────
echo
echo "▶ [1/3] pg_dump (prod) → $DUMP_DIR"
echo

DUMP_ARGS=(-h "$PROD_HOST" -p "$PROD_PORT" -U "$PROD_USER" -d "$PROD_DB"
  -Fd -j "$PARALLEL_JOBS"
  --no-owner --no-privileges
  -f "$DUMP_DIR" --verbose)
for t in "${TABLES[@]}"; do
  DUMP_ARGS+=(-t "$t")
done

PGPASSWORD="$PGPASSWORD_PROD" pg_dump "${DUMP_ARGS[@]}"

echo
echo "✓ Dump pronto. Tamanho: $(du -sh "$DUMP_DIR" | awk '{print $1}')"

# ── 2) Restore no dev ────────────────────────────────────────────────────────
echo
echo "▶ [2/3] pg_restore (dev) — DROP + recriar tabelas"
echo

PGPASSWORD="$DEV_PASSWORD" pg_restore \
  -h "$DEV_HOST" -p "$DEV_PORT" -U "$DEV_USER" -d "$DEV_DB" \
  -j "$PARALLEL_JOBS" \
  --clean --if-exists \
  --no-owner --no-privileges \
  --verbose "$DUMP_DIR"

# ── 3) Validacao ─────────────────────────────────────────────────────────────
echo
echo "▶ [3/3] Validando contagens no dev"
echo

PGPASSWORD="$DEV_PASSWORD" psql \
  -h "$DEV_HOST" -p "$DEV_PORT" -U "$DEV_USER" -d "$DEV_DB" \
  -v ON_ERROR_STOP=1 -X -A -F$'\t' <<'SQL'
\echo Contagens:
SELECT 'tbl_pedidosVendas_ACXE'             AS tabela, count(*) FROM public."tbl_pedidosVendas_ACXE"
UNION ALL SELECT 'tbl_pedidosVendas_itens_ACXE',       count(*) FROM public."tbl_pedidosVendas_itens_ACXE"
UNION ALL SELECT 'tbl_pedidosVendas_Q2P',              count(*) FROM public."tbl_pedidosVendas_Q2P"
UNION ALL SELECT 'tbl_pedidosVendas_itens_Q2P',        count(*) FROM public."tbl_pedidosVendas_itens_Q2P"
UNION ALL SELECT 'tbl_pedidosVendas_Q2P_Filial',       count(*) FROM public."tbl_pedidosVendas_Q2P_Filial"
UNION ALL SELECT 'tbl_pedidosVendas_itens_Q2P_Filial', count(*) FROM public."tbl_pedidosVendas_itens_Q2P_Filial";
SQL

# ── Limpeza ──────────────────────────────────────────────────────────────────
echo
read -rp "Remover $DUMP_DIR? [Y/n] " cleanup
if [[ ! "$cleanup" =~ ^[Nn]$ ]]; then
  rm -rf "$DUMP_DIR"
  echo "✓ Dump removido."
else
  echo "Dump preservado em $DUMP_DIR"
fi

unset PGPASSWORD_PROD DEV_PASSWORD
echo
echo "✅ Sync concluido."
