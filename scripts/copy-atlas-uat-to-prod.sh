#!/usr/bin/env bash
# =============================================================================
# copy-atlas-uat-to-prod.sh — ONE-SHOT do go-live (cutover)
#
# Transplanta o ESTADO OPERACIONAL Atlas do UAT (que rodou como producao desde
# junho/2026) para o banco de PRODUCAO: dados dos schemas
#   atlas, stockbridge, shared, hedge, forecast, breakingpoint
#
# Pre-requisitos:
#   - PROD ja com as 46+ migrations aplicadas (scripts/apply-migrations-prod.sh)
#   - UAT CONGELADO (stack uat-atlas em scale 0) — a validacao exige igualdade
#     EXATA de contagens, o que so vale com a origem parada
#
# Estrategia (padrao do sync espelho, direcao invertida, so schemas Atlas):
#   1. Conectividade + pre-checks (schemas presentes em PROD)
#   2. Baseline de contagens do UAT (origem congelada)
#   3. pg_dump --data-only dos 6 schemas (UAT) — inclui setval das sequences
#   4. TRUNCATE de todas as tabelas dos 6 schemas em PROD num UNICO comando
#      (FKs internas: lote<->movimentacao<->aprovacao, user_galpao->users, ...)
#      sob session_replication_role=replica (nao dispara triggers de auditoria)
#   5. pg_restore em PROD (--disable-triggers)
#   6. Validacao: contagem PROD == UAT (EXATA) por tabela; retry individual
#   7. Sequences: confere/corrige last_value em PROD
#   8. Grants claude_ro + refresh dos caches derivados (transito FUP, consumo)
#
# GARANTIA: este script NAO menciona nem toca o schema do espelho OMIE — apenas
# os 6 schemas Atlas listados em SCHEMAS.
#
# Uso:
#   export PROD_USER=<usuario-prod>          # obrigatorio, sem default
#   export PGPASSWORD_PROD='senha' PGPASSWORD_UAT='senha'   # senao, pergunta
#   scripts/copy-atlas-uat-to-prod.sh
# =============================================================================

set -euo pipefail

UAT_HOST="${UAT_HOST:-db.manager01.q2p.com.br}"
UAT_PORT="${UAT_PORT:-5437}"
UAT_DB="${UAT_DB:-acxe_q2p}"
UAT_USER="${UAT_USER:-postgres}"

PROD_HOST="${PROD_HOST:-db.manager01.q2p.com.br}"
PROD_PORT="${PROD_PORT:-5432}"
PROD_DB="${PROD_DB:-acxe_q2p}"
PROD_USER="${PROD_USER:-}"

PARALLEL_JOBS="${PARALLEL_JOBS:-4}"
DUMP_DIR="${DUMP_DIR:-/tmp/atlas_state_dump_$(date +%Y%m%d_%H%M%S)}"

SCHEMAS=(atlas stockbridge shared hedge forecast breakingpoint)

[ -z "$PROD_USER" ] && {
  echo "X PROD_USER nao setado (sem default de proposito — destino e PRODUCAO)."
  exit 1
}
for cmd in pg_dump pg_restore psql join sort awk; do
  command -v "$cmd" >/dev/null || { echo "X '$cmd' nao instalado"; exit 1; }
done

if [ -z "${PGPASSWORD_UAT:-}" ]; then
  read -rsp "Senha do UAT ($UAT_USER@$UAT_HOST:$UAT_PORT): " PGPASSWORD_UAT; echo
fi
if [ -z "${PGPASSWORD_PROD:-}" ]; then
  read -rsp "Senha do PROD ($PROD_USER@$PROD_HOST:$PROD_PORT): " PGPASSWORD_PROD; echo
fi

uat_psql() {
  PGPASSWORD="$PGPASSWORD_UAT" psql -h "$UAT_HOST" -p "$UAT_PORT" \
    -U "$UAT_USER" -d "$UAT_DB" "$@"
}
prod_psql() {
  PGPASSWORD="$PGPASSWORD_PROD" psql -h "$PROD_HOST" -p "$PROD_PORT" \
    -U "$PROD_USER" -d "$PROD_DB" "$@"
}

SCHEMA_IN_LIST="'atlas','stockbridge','shared','hedge','forecast','breakingpoint'"
DUMP_SCHEMA_ARGS=()
for s in "${SCHEMAS[@]}"; do DUMP_SCHEMA_ARGS+=(-n "$s"); done

COUNTS_SQL="
SELECT schemaname || '.' || tablename,
  (xpath('/row/n/text()',
    query_to_xml(
      format('SELECT count(*) AS n FROM %I.%I', schemaname, tablename),
      false, true, ''
    )
  ))[1]::text::bigint AS cnt
FROM pg_tables
WHERE schemaname IN (${SCHEMA_IN_LIST})
ORDER BY 1;"

# -- Confirmacao ---------------------------------------------------------------
cat <<EOF

+-------------------------------------------------------------------------+
| TRANSPLANTE DE ESTADO ATLAS  uat -> *** PRODUCAO ***  (one-shot cutover)|
+-------------------------------------------------------------------------+
| Origem : $UAT_USER@$UAT_HOST:$UAT_PORT/$UAT_DB  (deve estar CONGELADO)
| Destino: $PROD_USER@$PROD_HOST:$PROD_PORT/$PROD_DB
| Schemas: ${SCHEMAS[*]}
| Dump   : $DUMP_DIR (-j $PARALLEL_JOBS)
|                                                                         |
| Em PROD, TODAS as tabelas desses schemas serao TRUNCADAS e recarregadas |
| com os dados do UAT (inclui seeds de migration — serao substituidos).   |
| NAO rode este script depois que a operacao ja estiver em PROD.          |
+-------------------------------------------------------------------------+

EOF
read -rp "Continuar? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Abortado."; exit 0; }
read -rp "Confirmacao dupla — digite PROD para prosseguir: " confirm2
[[ "$confirm2" == "PROD" ]] || { echo "Abortado (confirmacao invalida)."; exit 0; }

mkdir -p "$DUMP_DIR"

# -- 1) Conectividade + pre-checks --------------------------------------------
echo
echo "> [1/8] Conectividade e pre-checks"
uat_psql -tAc "SELECT 1" >/dev/null && echo "  ok uat"
prod_psql -tAc "SELECT 1" >/dev/null && echo "  ok prod"

PROD_SCHEMAS=$(prod_psql -tAc \
  "SELECT count(*) FROM pg_namespace WHERE nspname IN (${SCHEMA_IN_LIST});")
if [ "$PROD_SCHEMAS" -ne "${#SCHEMAS[@]}" ]; then
  echo "X PROD tem $PROD_SCHEMAS de ${#SCHEMAS[@]} schemas Atlas — rode apply-migrations-prod.sh antes."
  exit 1
fi
echo "  ok ${#SCHEMAS[@]} schemas Atlas presentes em PROD"

# Guarda anti-desastre: se PROD ja tem movimentacao alem do seed, alguem ja
# operou em producao — transplantar por cima destruiria esse estado.
PROD_MOV=$(prod_psql -tAc "SELECT count(*) FROM stockbridge.movimentacao;" 2>/dev/null || echo 0)
UAT_MOV=$(uat_psql -tAc "SELECT count(*) FROM stockbridge.movimentacao;")
if [ "${PROD_MOV:-0}" -gt 0 ]; then
  echo
  echo "  ! ATENCAO: stockbridge.movimentacao em PROD ja tem $PROD_MOV linha(s) (UAT: $UAT_MOV)."
  echo "    Se a operacao ja rodou em PROD, ABORTE — o transplante apagaria esse estado."
  read -rp "  Tem CERTEZA que PROD ainda nao operou? digite SOBRESCREVER: " confirm3
  [[ "$confirm3" == "SOBRESCREVER" ]] || { echo "Abortado."; exit 0; }
fi

# -- 2) Baseline de contagens do UAT ------------------------------------------
echo
echo "> [2/8] Baseline de contagens do UAT (origem congelada)"
uat_psql -tAF'|' -c "$COUNTS_SQL" > "$DUMP_DIR/uat_counts.txt"
echo "  ok $(wc -l < "$DUMP_DIR/uat_counts.txt") tabelas mapeadas"

# -- 3) Dump data-only dos schemas Atlas (UAT) --------------------------------
echo
echo "> [3/8] pg_dump --data-only dos schemas Atlas (uat) -> $DUMP_DIR/dump"
PGPASSWORD="$PGPASSWORD_UAT" pg_dump \
  -h "$UAT_HOST" -p "$UAT_PORT" -U "$UAT_USER" -d "$UAT_DB" \
  "${DUMP_SCHEMA_ARGS[@]}" \
  --data-only \
  --disable-triggers \
  --no-owner --no-privileges \
  -Fd -j "$PARALLEL_JOBS" \
  -f "$DUMP_DIR/dump"
echo "  ok dump pronto. Tamanho: $(du -sh "$DUMP_DIR/dump" | awk '{print $1}')"

# -- 4) TRUNCATE em PROD (unico comando, modo replica) ------------------------
echo
echo "> [4/8] Truncando tabelas Atlas em PROD"
prod_psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE
  tbl_list text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
    INTO tbl_list
  FROM pg_tables
  WHERE schemaname IN (${SCHEMA_IN_LIST});

  IF tbl_list IS NULL THEN
    RAISE EXCEPTION 'Nenhuma tabela Atlas encontrada para truncar';
  END IF;

  SET session_replication_role = replica;
  EXECUTE 'TRUNCATE TABLE ' || tbl_list || ' RESTRICT';
  SET session_replication_role = DEFAULT;

  RAISE NOTICE 'Truncadas todas as tabelas Atlas num unico comando';
END\$\$;
SQL
echo "  ok truncate concluido"

# -- 5) Restore em PROD --------------------------------------------------------
echo
echo "> [5/8] pg_restore em PROD"
set +e
PGPASSWORD="$PGPASSWORD_PROD" pg_restore \
  -h "$PROD_HOST" -p "$PROD_PORT" -U "$PROD_USER" -d "$PROD_DB" \
  --data-only \
  --disable-triggers \
  --no-owner --no-privileges \
  -j "$PARALLEL_JOBS" \
  "$DUMP_DIR/dump" 2>"$DUMP_DIR/restore_stderr.txt"
RESTORE_RC=$?
set -e
if [ $RESTORE_RC -ne 0 ]; then
  echo "  ! pg_restore rc=$RESTORE_RC (pode haver erros parciais) — $DUMP_DIR/restore_stderr.txt"
  echo "    Seguindo para a validacao..."
else
  echo "  ok restore concluido sem erros"
fi

# -- 6) Validacao: igualdade EXATA + retry individual --------------------------
echo
echo "> [6/8] Validando contagens PROD vs UAT (igualdade EXATA)"
prod_psql -tAF'|' -c "$COUNTS_SQL" > "$DUMP_DIR/prod_counts.txt"

DIVERGENT_TABLES=()
while IFS='|' read -r tbl uat_cnt prod_cnt; do
  [ -z "$tbl" ] && continue
  if [ "$prod_cnt" != "$uat_cnt" ]; then
    DIVERGENT_TABLES+=("$tbl")
    echo "  DIVERGENTE  $tbl: UAT=$uat_cnt  PROD=$prod_cnt"
  fi
done < <(join -t'|' -j1 \
  <(sort -t'|' -k1,1 "$DUMP_DIR/uat_counts.txt") \
  <(sort -t'|' -k1,1 "$DUMP_DIR/prod_counts.txt") \
  | awk -F'|' '{print $1 "|" $2 "|" $3}')

RETRY_ERRORS=()
if [ ${#DIVERGENT_TABLES[@]} -eq 0 ]; then
  echo "  ok todas as tabelas com contagem identica ao UAT"
else
  echo
  echo "  Retentando ${#DIVERGENT_TABLES[@]} tabela(s) individualmente..."
  for tbl in "${DIVERGENT_TABLES[@]}"; do
    echo "  --> retry: $tbl"
    sch="${tbl%%.*}"; tab="${tbl#*.}"
    RETRY_DUMP="$DUMP_DIR/retry_${sch}_${tab}.dump"

    set +e
    PGPASSWORD="$PGPASSWORD_UAT" pg_dump \
      -h "$UAT_HOST" -p "$UAT_PORT" -U "$UAT_USER" -d "$UAT_DB" \
      -t "\"${sch}\".\"${tab}\"" \
      --data-only --disable-triggers --no-owner --no-privileges \
      -Fc -f "$RETRY_DUMP" 2>"$DUMP_DIR/retry_${sch}_${tab}_dump_err.txt"
    DUMP_RC=$?
    set -e
    if [ $DUMP_RC -ne 0 ]; then
      echo "     X dump falhou (rc=$DUMP_RC)"
      RETRY_ERRORS+=("$tbl (dump falhou)")
      continue
    fi

    # DELETE (nao TRUNCATE) sob modo replica: tabela referenciada por FK nao
    # pode ser truncada isoladamente; DELETE em replica nao dispara triggers.
    prod_psql -v ON_ERROR_STOP=1 -c \
      "SET session_replication_role = replica; DELETE FROM \"${sch}\".\"${tab}\"; SET session_replication_role = DEFAULT;"

    set +e
    PGPASSWORD="$PGPASSWORD_PROD" pg_restore \
      -h "$PROD_HOST" -p "$PROD_PORT" -U "$PROD_USER" -d "$PROD_DB" \
      --data-only --disable-triggers --no-owner --no-privileges \
      --single-transaction \
      "$RETRY_DUMP" 2>"$DUMP_DIR/retry_${sch}_${tab}_restore_err.txt"
    RC=$?
    set -e
    if [ $RC -ne 0 ]; then
      echo "     X restore falhou (rc=$RC) — $DUMP_DIR/retry_${sch}_${tab}_restore_err.txt"
      head -10 "$DUMP_DIR/retry_${sch}_${tab}_restore_err.txt"
      RETRY_ERRORS+=("$tbl (restore falhou)")
      continue
    fi

    NEW_CNT=$(prod_psql -tAc "SELECT count(*) FROM \"${sch}\".\"${tab}\"")
    UAT_CNT=$(grep "^${tbl}|" "$DUMP_DIR/uat_counts.txt" | cut -d'|' -f2)
    if [ "$NEW_CNT" == "$UAT_CNT" ]; then
      echo "     ok $tbl: PROD=$NEW_CNT == UAT=$UAT_CNT"
    else
      echo "     X $tbl segue divergente: PROD=$NEW_CNT UAT=$UAT_CNT"
      RETRY_ERRORS+=("$tbl (segue divergente)")
    fi
  done

  if [ ${#RETRY_ERRORS[@]} -gt 0 ]; then
    echo
    echo "X VALIDACAO FALHOU — tabelas com problema apos retry:"
    for e in "${RETRY_ERRORS[@]}"; do echo "    - $e"; done
    echo "  Criterio do cutover e igualdade EXATA. NO-GO ate resolver."
    echo "  Logs preservados em $DUMP_DIR"
    exit 1
  fi
fi

# -- 7) Sequences: conferir/corrigir last_value em PROD ------------------------
# O dump data-only ja inclui os setval, mas conferimos TODAS as sequences dos
# schemas Atlas (inclui as de coluna identity) e corrigimos qualquer atraso.
echo
echo "> [7/8] Conferindo sequences"
uat_psql -tAF'|' -c "
  SELECT schemaname || '.' || sequencename, COALESCE(last_value, 0)
  FROM pg_sequences WHERE schemaname IN (${SCHEMA_IN_LIST}) ORDER BY 1;" \
  > "$DUMP_DIR/uat_seqs.txt"

while IFS='|' read -r seq uat_val; do
  [ -z "$seq" ] && continue
  [ "$uat_val" = "0" ] && continue
  prod_psql -tAc \
    "SELECT setval('${seq}', GREATEST(${uat_val}, COALESCE((SELECT last_value FROM ${seq}), 1)));" >/dev/null
  echo "  ok $seq >= $uat_val"
done < "$DUMP_DIR/uat_seqs.txt"

# -- 8) Grants + refresh dos caches derivados ---------------------------------
echo
echo "> [8/8] Grants claude_ro + refresh de caches derivados em PROD"
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
    END LOOP;
  END IF;
END$$;
SQL

prod_psql <<'SQL'
DO $$
DECLARE
  v_transito integer;
  v_consumo  integer;
BEGIN
  IF to_regprocedure('stockbridge.refresh_lotes_em_transito_se_stale(integer)') IS NOT NULL THEN
    BEGIN
      SELECT stockbridge.refresh_lotes_em_transito_se_stale(0) INTO v_transito;
      RAISE NOTICE 'transito: % lote(s) recomputado(s) da FUP', v_transito;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'refresh de transito falhou (cockpit pega no proximo load): %', SQLERRM;
    END;
  END IF;

  IF to_regprocedure('stockbridge.refresh_consumo_medio_se_stale(integer)') IS NOT NULL THEN
    BEGIN
      SELECT stockbridge.refresh_consumo_medio_se_stale(0) INTO v_consumo;
      RAISE NOTICE 'consumo: % registro(s) recomputado(s)', v_consumo;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'refresh de consumo falhou (cockpit pega no proximo load): %', SQLERRM;
    END;
  END IF;
END$$;
SQL

# -- Resumo final --------------------------------------------------------------
echo
echo "> Resumo final (PROD):"
prod_psql -X -A -F$'\t' <<SQL
SELECT schemaname AS schema, count(*) AS tabelas,
  pg_size_pretty(sum(pg_total_relation_size(format('%I.%I', schemaname, relname)))) AS tamanho
FROM pg_stat_user_tables
WHERE schemaname IN (${SCHEMA_IN_LIST})
GROUP BY schemaname ORDER BY schemaname;
SQL

echo
echo "> Tabelas criticas (PROD):"
prod_psql -X -A -F$'\t' <<'SQL'
SELECT 'atlas.users' AS tabela, count(*) AS linhas FROM atlas.users
UNION ALL SELECT 'stockbridge.lote',                count(*) FROM stockbridge.lote
UNION ALL SELECT 'stockbridge.movimentacao',        count(*) FROM stockbridge.movimentacao
UNION ALL SELECT 'stockbridge.movimentacao_legado', count(*) FROM stockbridge.movimentacao_legado
UNION ALL SELECT 'stockbridge.aprovacao',           count(*) FROM stockbridge.aprovacao
UNION ALL SELECT 'stockbridge.conferencia_local_map', count(*) FROM stockbridge.conferencia_local_map
UNION ALL SELECT 'stockbridge.nf_pedido_mapa',      count(*) FROM stockbridge.nf_pedido_mapa
UNION ALL SELECT 'shared.audit_log',                count(*) FROM shared.audit_log
ORDER BY tabela;
SQL

echo
read -rp "Remover $DUMP_DIR? [Y/n] " cleanup
if [[ ! "${cleanup:-y}" =~ ^[Nn]$ ]]; then
  rm -rf "$DUMP_DIR"
  echo "  ok dump removido"
else
  echo "  dump preservado em $DUMP_DIR"
fi

unset PGPASSWORD_PROD PGPASSWORD_UAT
echo
echo "OK Transplante de estado Atlas uat -> PROD concluido."
