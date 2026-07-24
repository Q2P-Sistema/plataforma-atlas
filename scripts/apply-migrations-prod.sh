#!/usr/bin/env bash
# =============================================================================
# apply-migrations-prod.sh
# Aplica as migrations Atlas (packages/db/migrations/*.sql) EM ORDEM no banco
# de PRODUCAO (espelho OMIE vivo — public.* NAO e tocado pelos dados, apenas
# recebe os objetos Atlas que as proprias migrations criam: vw_hedge_*,
# trigger trg_auto_popular_config_produto, tb_movimentacao_q2p_legado).
#
# Por que nao `drizzle-kit migrate`? O repo nao mantem meta/_journal.json —
# as migrations sao SQL puro, aplicadas via psql em ordem numerica.
# Cada arquivo roda na propria transacao (psql -1 -v ON_ERROR_STOP=1); na 1a
# falha o script PARA sem meio-estado na migration que falhou.
#
# Uso:
#   export PROD_USER=<usuario-prod>            # obrigatorio, sem default
#   export PGPASSWORD_PROD='senha'             # opcional; sem isso pergunta
#   scripts/apply-migrations-prod.sh                # aplica tudo
#   scripts/apply-migrations-prod.sh --precheck-only # so valida o espelho OMIE
#
# Seguranca: exige confirmacao dupla (y + digitar "PROD").
# =============================================================================

set -euo pipefail

PROD_HOST="${PROD_HOST:-db.manager01.q2p.com.br}"
PROD_PORT="${PROD_PORT:-5432}"
PROD_DB="${PROD_DB:-acxe_q2p}"
PROD_USER="${PROD_USER:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG_DIR="$SCRIPT_DIR/../packages/db/migrations"

PRECHECK_ONLY=false
[[ "${1:-}" == "--precheck-only" ]] && PRECHECK_ONLY=true

[ -z "$PROD_USER" ] && {
  echo "X PROD_USER nao setado (sem default de proposito — destino e PRODUCAO)."
  echo "   Rode: export PROD_USER=<seu-usuario-prod>"
  exit 1
}
command -v psql >/dev/null || { echo "X 'psql' nao instalado"; exit 1; }
[ -d "$MIG_DIR" ] || { echo "X migrations nao encontradas em $MIG_DIR"; exit 1; }

if [ -z "${PGPASSWORD_PROD:-}" ]; then
  read -rsp "Senha do PROD ($PROD_USER@$PROD_HOST:$PROD_PORT/$PROD_DB): " PGPASSWORD_PROD
  echo
fi

prod_psql() {
  PGPASSWORD="$PGPASSWORD_PROD" psql -h "$PROD_HOST" -p "$PROD_PORT" \
    -U "$PROD_USER" -d "$PROD_DB" "$@"
}

# -- Pre-check: espelho OMIE precisa existir ANTES das migrations -------------
# Tabelas public.* referenciadas pelas migrations (0006/0009/0017/0019/0021-
# 0024/0036/0037/0040/0041). Lista extraida por grep das migrations — se uma
# migration nova referenciar tabela OMIE nova, adicione aqui.
echo
echo "> Pre-check do espelho OMIE em PROD (dependencias das migrations)"
MISSING=$(prod_psql -tA <<'SQL'
SELECT string_agg(t, E'\n')
FROM unnest(ARRAY[
  'tbl_cadastroFornecedoresClientes_ACXE',
  'tbl_categorias_ACXE',
  'tbl_dadosPlanilhaFUPComex',
  'tbl_locaisEstoques_ACXE',
  'tbl_nf_header_ACXE',
  'tbl_nf_itens_ACXE',
  'tbl_pedidosCompras_ACXE',
  'tbl_pedidosVendas_ACXE',
  'tbl_pedidosVendas_itens_ACXE',
  'tbl_pedidosVendas_itens_Q2P',
  'tbl_pedidosVendas_itens_Q2P_Filial',
  'tbl_pedidosVendas_Q2P',
  'tbl_pedidosVendas_Q2P_Filial',
  'tbl_produtos_ACXE',
  'tbl_produtos_Q2P',
  'tbl_produtos_Q2P_Filial'
]) AS t
WHERE to_regclass(format('public.%I', t)) IS NULL;
SQL
)
if [ -n "$MISSING" ]; then
  echo "X Tabelas OMIE AUSENTES em PROD — migrations vao falhar. Investigar sync n8n:"
  echo "$MISSING" | sed 's/^/    - /'
  exit 1
fi
echo "  ok 16/16 tabelas exigidas pelas migrations presentes"

# Dependencias de RUNTIME (app le, migrations nao) — warn-only, nao aborta.
echo
echo "> Pre-check de runtime (warn-only — app le em producao)"
RUNTIME_MISSING=$(prod_psql -tA <<'SQL'
SELECT string_agg(t, E'\n')
FROM unnest(ARRAY[
  'vw_posicaoEstoqueUnificadaFamilia',
  'tbl_historico_cmc_estoque',
  'tbl_movimentacaoEstoqueHistorico_Q2P',
  'tbl_posicaoEstoque_ACXE',
  'tbl_posicaoEstoque_Q2P',
  'tbl_locaisEstoques_Q2P'
]) AS t
WHERE to_regclass(format('public.%I', t)) IS NULL;
SQL
)
if [ -n "$RUNTIME_MISSING" ]; then
  echo "  ! AVISO — objetos de runtime ausentes (telas correspondentes vao falhar):"
  echo "$RUNTIME_MISSING" | sed 's/^/    - /'
else
  echo "  ok objetos de runtime presentes"
fi

if $PRECHECK_ONLY; then
  echo
  echo "OK pre-check concluido (--precheck-only; nada foi aplicado)."
  exit 0
fi

# -- Guarda: nao aplicar por cima de schemas Atlas ja existentes ---------------
EXISTING=$(prod_psql -tAc \
  "SELECT count(*) FROM pg_namespace WHERE nspname IN ('atlas','shared','stockbridge','hedge','forecast','breakingpoint');")
if [ "$EXISTING" -gt 0 ]; then
  echo
  echo "X PROD ja tem $EXISTING schema(s) Atlas — este script e para o primeiro deploy."
  echo "   Para reverter tudo antes de reaplicar, use o SQL de reversao do runbook."
  exit 1
fi

mapfile -t FILES < <(ls "$MIG_DIR"/*.sql | sort)

cat <<EOF

+-------------------------------------------------------------------------+
| APLICAR MIGRATIONS ATLAS -> *** PRODUCAO ***                            |
+-------------------------------------------------------------------------+
| Destino : $PROD_USER@$PROD_HOST:$PROD_PORT/$PROD_DB
| Arquivos: ${#FILES[@]} migrations (cada uma em sua transacao)
| ATENCAO : este banco e o espelho OMIE VIVO de producao.                 |
+-------------------------------------------------------------------------+

EOF
read -rp "Continuar? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Abortado."; exit 0; }
read -rp "Confirmacao dupla — digite PROD para prosseguir: " confirm2
[[ "$confirm2" == "PROD" ]] || { echo "Abortado (confirmacao invalida)."; exit 0; }

for f in "${FILES[@]}"; do
  echo "> aplicando $(basename "$f")"
  prod_psql -1 -v ON_ERROR_STOP=1 -q -f "$f"
done

# Concede leitura ao claude_ro (MCP pg-acxe) nos schemas Atlas — INCLUINDO o
# schema `atlas` (gap conhecido no script de UAT: `atlas` ficou de fora e o MCP
# nao enxergava atlas.users; nao repetir em PROD).
echo
echo "> concedendo SELECT ao claude_ro nos schemas Atlas (incl. atlas)"
prod_psql -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE s text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro') THEN
    FOREACH s IN ARRAY ARRAY['atlas','stockbridge','shared','hedge','forecast','breakingpoint']
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
prod_psql -tAc \
  "SELECT nspname FROM pg_namespace WHERE nspname IN ('atlas','shared','stockbridge','hedge','forecast','breakingpoint') ORDER BY 1;"

unset PGPASSWORD_PROD
echo
echo "OK migrations aplicadas em PROD."
