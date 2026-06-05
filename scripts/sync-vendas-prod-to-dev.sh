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
#   - public."tbl_posicaoEstoque_ACXE"           saldo atual por SKU/local OMIE
#   - public."tbl_posicaoEstoque_Q2P"            (consumido por Meu Estoque do
#                                                 StockBridge via vw_posicaoEstoqueUnificadaFamilia)
#   - public."tbl_locaisEstoques_ACXE"           cadastro de galpoes/locais OMIE
#   - public."tbl_locaisEstoques_Q2P"            (descricao humana dos codigos
#                                                 11.1, 21.2, 90.0.2 etc. — usado
#                                                 pelo cockpit pra label "GP22 — Extrema")
#   - public."tbl_nf_header_ACXE"                + _itens_ACXE        historico
#   - public."tbl_nf_header_Q2P"                 + _itens_Q2P         de NFs
#   - public."tbl_nf_header_Q2P_Filial"          + _itens_Q2P_Filial  do OMIE
#       (header + itens; usado pelo StockBridge para reconciliar posicao fiscal x
#       fisica via campo nIdReceb)
#   - public."tbl_dadosPlanilhaFUPComex"         FUP de Comex — material em transito
#                                                 internacional. Lido pela migration
#                                                 0024 (one-shot INSERT em stockbridge.lote).
#   - public."tbl_pedidosCompras_ACXE"           pedidos de compra ACXE. JOIN com FUP
#                                                 pra rastrear lote ↔ pedido.
#   Obs: tbl_posicaoEstoque_Q2P_Filial NAO existe em prod — Filial nao opera estoque.
#   Obs: tbl_staging_nf_header_* NAO sincronizadas — sao transientes do n8n.
#   Obs: apos sincronizar FUP/pedidos, o script chama
#       stockbridge.refresh_lotes_em_transito_se_stale(0) na etapa [5/6] pra
#       UPSERT/soft-delete dos lotes em stockbridge.lote. Lotes ja recebidos
#       (status != 'transito') ou ja movidos pra localidade fisica sao preservados.
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
  'tbl_posicaoEstoque_ACXE'
  'tbl_posicaoEstoque_Q2P'
  'tbl_locaisEstoques_ACXE'
  'tbl_locaisEstoques_Q2P'
  'tbl_nf_header_ACXE'
  'tbl_nf_itens_ACXE'
  'tbl_nf_header_Q2P'
  'tbl_nf_itens_Q2P'
  'tbl_nf_header_Q2P_Filial'
  'tbl_nf_itens_Q2P_Filial'
  'tbl_dadosPlanilhaFUPComex'
  'tbl_pedidosCompras_ACXE'
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

# Lista de views dependentes (cadeia transitiva via CTE recursivo).
# Pega views diretas (nivel 1) e tambem views que dependem de views (nivel N+).
# Ex: tbl_posicaoEstoque_* ← vw_posicaoEstoqueUnificada ← vw_recebiveisTotal ← vw_fluxoCaixa
DEP_VIEWS=$(dev_psql -A -t -X <<SQL
WITH RECURSIVE base_tables AS (
  SELECT c.oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ($(printf "'%s'," "${TABLES[@]}" | sed 's/,$//'))
),
deps AS (
  -- Nivel 1: views/matviews que dependem diretamente das tabelas
  SELECT DISTINCT c.oid, c.relname, c.relkind, n.nspname, 1 AS nivel
  FROM pg_depend d
  JOIN pg_rewrite r   ON r.oid = d.objid
  JOIN pg_class c     ON c.oid = r.ev_class
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE d.refobjid IN (SELECT oid FROM base_tables)
    AND c.relkind IN ('v','m')
    AND c.oid NOT IN (SELECT oid FROM base_tables)

  UNION

  -- Nivel N+: views que dependem de views ja em deps
  SELECT DISTINCT c.oid, c.relname, c.relkind, n.nspname, prev.nivel + 1
  FROM deps prev
  JOIN pg_depend d    ON d.refobjid = prev.oid
  JOIN pg_rewrite r   ON r.oid = d.objid
  JOIN pg_class c     ON c.oid = r.ev_class
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('v','m')
    AND c.oid <> prev.oid
)
-- Ordena por nivel ASC pra recriacao funcionar (base antes de dependentes)
SELECT quote_ident(nspname) || '.' || quote_ident(relname)
FROM (
  SELECT nspname, relname, MIN(nivel) AS nivel
  FROM deps
  GROUP BY nspname, relname
) sub
ORDER BY nivel, relname;
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
  echo "  DROP das views via CASCADE (cobre cadeia transitiva)..."
  # Usa CASCADE pra evitar ter que ordenar topologicamente as views.
  # Todas que dependem (direta ou indiretamente) caem juntas. Em [4/5]
  # recriamos todas a partir das definicoes salvas no _dependent_views.sql.
  while IFS= read -r view; do
    [ -z "$view" ] && continue
    kind=$(dev_psql -A -t -X -c "SELECT relkind FROM pg_class WHERE oid='$view'::regclass;" 2>/dev/null || true)
    [ -z "$kind" ] && continue  # ja foi dropada via CASCADE de outra
    keyword=$([ "$kind" = "m" ] && echo "MATERIALIZED VIEW" || echo "VIEW")
    dev_psql -v ON_ERROR_STOP=1 -c "DROP $keyword IF EXISTS $view CASCADE;"
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

# ── 5) Refresh stockbridge.lote a partir do FUP atualizado ──────────────────
# Forca TTL=0 porque acabamos de trocar todos os dados de origem (FUP +
# pedidos de compra). O auto-refresh do GET /transito tem TTL de 15min e
# poderia ficar bloqueado se o updated_at dos lotes for recente.
echo
echo "▶ [5/6] Refresh stockbridge.lote a partir do FUP sincronizado"
dev_psql -v ON_ERROR_STOP=1 -c "SELECT stockbridge.refresh_lotes_em_transito_se_stale(0) AS lotes_atualizados;"

# ── 6) Validacao ─────────────────────────────────────────────────────────────
echo
echo "▶ [6/6] Validando contagens no dev"
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
