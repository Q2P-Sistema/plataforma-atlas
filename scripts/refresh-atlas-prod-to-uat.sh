#!/usr/bin/env bash
# =============================================================================
# refresh-atlas-prod-to-uat.sh — recomeça o UAT do estado Atlas de PRODUÇÃO
#
# Copia os DADOS dos schemas Atlas do PROD para o UAT:
#   atlas, stockbridge, shared, hedge, forecast, breakingpoint
# É o inverso do copy-atlas-uat-to-prod.sh (go-live). O espelho OMIE (public.*)
# tem script próprio: sync-omie-public-prod-to-uat.sh. ACXEGDP-405.
#
# O que acontece com o UAT:
#   - TODO o estado Atlas do UAT (movimentações, aprovações, testes) é apagado e
#     substituído pelo do PROD. Antes, um backup data-only vai para $DUMP_DIR.
#   - atlas.sessions NÃO é copiada (todo mundo faz login de novo no UAT).
#   - atlas.users vem do PROD com as mesmas senhas e o mesmo 2FA; tokens de
#     reset de senha e bloqueios por tentativa são zerados.
#
# Garantias:
#   - PROD só é lido: todo psql do PROD abre com default_transaction_read_only
#     e o pg_dump só lê. Origem igual ao destino aborta.
#   - Não toca no public.* de nenhum dos dois bancos.
#   - Schema do PROD à frente do UAT (tabela/coluna que o UAT não tem) aborta:
#     aplique as migrations no UAT antes (apply-migrations-uat.sh).
#
# O PROD continua operando durante a cópia, então a validação compara a
# contagem do UAT com a do PROD antes E depois do dump: tabela que não mudou
# tem de bater exato; tabela que mudou no meio é aceita entre os dois valores.
#
# Recomendado: API do UAT parada (scale 0) durante o refresh e religada depois
# (zera a sombra do OMIE em memória e evita escrita no meio do restore).
#
# Uso:
#   export PROD_USER=<usuario-prod>              # obrigatório, sem default
#   export PGPASSWORD_PROD='…' PGPASSWORD_UAT='…'  # senão, pergunta
#   DRY_RUN=1 scripts/refresh-atlas-prod-to-uat.sh   # só checagens, não escreve
#   scripts/refresh-atlas-prod-to-uat.sh
# Variáveis opcionais: BACKUP_UAT=0 (pula o backup), PARALLEL_JOBS, DUMP_DIR,
#   UAT_HOST/PORT/DB/USER, PROD_HOST/PORT/DB.
# =============================================================================

set -euo pipefail
export LC_ALL=C

UAT_HOST="${UAT_HOST:-db.manager01.q2p.com.br}"
UAT_PORT="${UAT_PORT:-5437}"
UAT_DB="${UAT_DB:-acxe_q2p}"
UAT_USER="${UAT_USER:-postgres}"

PROD_HOST="${PROD_HOST:-db.manager01.q2p.com.br}"
PROD_PORT="${PROD_PORT:-5432}"
PROD_DB="${PROD_DB:-acxe_q2p}"
PROD_USER="${PROD_USER:-}"

PARALLEL_JOBS="${PARALLEL_JOBS:-4}"
DUMP_DIR="${DUMP_DIR:-/tmp/atlas_refresh_uat_$(date +%Y%m%d_%H%M%S)}"
BACKUP_UAT="${BACKUP_UAT:-1}"
DRY_RUN="${DRY_RUN:-0}"

SCHEMAS=(atlas stockbridge shared hedge forecast breakingpoint)
# Tabelas cujos dados NÃO vêm do PROD (o UAT fica com elas vazias).
SEM_DADOS=(atlas.sessions)

[ -z "$PROD_USER" ] && { echo "X PROD_USER nao setado (sem default de proposito)."; exit 1; }
for cmd in pg_dump pg_restore psql join sort comm awk; do
  command -v "$cmd" >/dev/null || { echo "X '$cmd' nao instalado"; exit 1; }
done
if [ "$UAT_HOST:$UAT_PORT/$UAT_DB" == "$PROD_HOST:$PROD_PORT/$PROD_DB" ]; then
  echo "X Origem e destino sao o mesmo banco ($UAT_HOST:$UAT_PORT/$UAT_DB). Abortado."
  exit 1
fi

if [ -z "${PGPASSWORD_PROD:-}" ]; then
  read -rsp "Senha do PROD ($PROD_USER@$PROD_HOST:$PROD_PORT): " PGPASSWORD_PROD; echo
fi
if [ -z "${PGPASSWORD_UAT:-}" ]; then
  read -rsp "Senha do UAT ($UAT_USER@$UAT_HOST:$UAT_PORT): " PGPASSWORD_UAT; echo
fi

uat_psql() {
  PGPASSWORD="$PGPASSWORD_UAT" psql -X -h "$UAT_HOST" -p "$UAT_PORT" \
    -U "$UAT_USER" -d "$UAT_DB" "$@"
}
# PROD só leitura: qualquer escrita acidental falha no próprio Postgres.
prod_psql() {
  PGOPTIONS='-c default_transaction_read_only=on' PGPASSWORD="$PGPASSWORD_PROD" \
    psql -X -h "$PROD_HOST" -p "$PROD_PORT" -U "$PROD_USER" -d "$PROD_DB" "$@"
}

SCHEMA_IN_LIST="'atlas','stockbridge','shared','hedge','forecast','breakingpoint'"
SEM_DADOS_IN_LIST=$(printf "'%s'," "${SEM_DADOS[@]}"); SEM_DADOS_IN_LIST="${SEM_DADOS_IN_LIST%,}"

DUMP_SCHEMA_ARGS=()
for s in "${SCHEMAS[@]}"; do DUMP_SCHEMA_ARGS+=(-n "$s"); done
EXCLUDE_ARGS=()
for t in "${SEM_DADOS[@]}"; do EXCLUDE_ARGS+=(--exclude-table-data="$t"); done

COUNTS_SQL="
SELECT schemaname || '.' || tablename,
  (xpath('/row/n/text()',
    query_to_xml(format('SELECT count(*) AS n FROM %I.%I', schemaname, tablename), false, true, '')
  ))[1]::text::bigint
FROM pg_tables
WHERE schemaname IN (${SCHEMA_IN_LIST})
  AND schemaname || '.' || tablename NOT IN (${SEM_DADOS_IN_LIST})
ORDER BY 1;"

TABLES_SQL="SELECT schemaname || '.' || tablename FROM pg_tables
WHERE schemaname IN (${SCHEMA_IN_LIST}) ORDER BY 1;"

# tabela.coluna|nullable|tem_default
COLUMNS_SQL="SELECT c.table_schema || '.' || c.table_name || '.' || c.column_name,
  c.is_nullable, (c.column_default IS NOT NULL OR c.is_identity = 'YES' OR c.is_generated = 'ALWAYS')
FROM information_schema.columns c
JOIN pg_tables t ON t.schemaname = c.table_schema AND t.tablename = c.table_name
WHERE c.table_schema IN (${SCHEMA_IN_LIST}) ORDER BY 1;"

# -- Confirmação ---------------------------------------------------------------
cat <<EOF

+-------------------------------------------------------------------------+
| REFRESH DO ESTADO ATLAS   PROD -> uat                                   |
+-------------------------------------------------------------------------+
| Origem : $PROD_USER@$PROD_HOST:$PROD_PORT/$PROD_DB  (somente leitura)
| Destino: $UAT_USER@$UAT_HOST:$UAT_PORT/$UAT_DB
| Schemas: ${SCHEMAS[*]}
| Sem dados do PROD: ${SEM_DADOS[*]}
| Pasta  : $DUMP_DIR (-j $PARALLEL_JOBS)  backup do UAT: $([ "$BACKUP_UAT" = 1 ] && echo sim || echo NAO)
| Modo   : $([ "$DRY_RUN" = 1 ] && echo 'DRY_RUN (só checagens, nada é escrito)' || echo 'EXECUÇÃO')
|                                                                         |
| No UAT, TODAS as tabelas desses schemas serão apagadas e recarregadas   |
| com os dados do PROD — testes e histórico do UAT se perdem.             |
+-------------------------------------------------------------------------+

EOF
if [ "$DRY_RUN" != 1 ]; then
  read -rp "Para prosseguir, digite UAT: " confirm
  [[ "$confirm" == "UAT" ]] || { echo "Abortado."; exit 0; }
fi

mkdir -p "$DUMP_DIR"

# -- 1) Conectividade ------------------------------------------------------------
echo
echo "> [1/9] Conectividade"
prod_psql -tAc "SELECT 1" >/dev/null && echo "  ok prod (sessão somente leitura)"
uat_psql -tAc "SELECT 1" >/dev/null && echo "  ok uat"

# -- 2) Schema: PROD não pode estar à frente do UAT ------------------------------
echo
echo "> [2/9] Comparando schema Atlas PROD x UAT"
prod_psql -tA -c "$TABLES_SQL" > "$DUMP_DIR/prod_tables.txt"
uat_psql  -tA -c "$TABLES_SQL" > "$DUMP_DIR/uat_tables.txt"
prod_psql -tAF'|' -c "$COLUMNS_SQL" > "$DUMP_DIR/prod_columns.txt"
uat_psql  -tAF'|' -c "$COLUMNS_SQL" > "$DUMP_DIR/uat_columns.txt"

SO_PROD_TAB=$(comm -23 "$DUMP_DIR/prod_tables.txt" "$DUMP_DIR/uat_tables.txt")
SO_UAT_TAB=$(comm -13 "$DUMP_DIR/prod_tables.txt" "$DUMP_DIR/uat_tables.txt")
cut -d'|' -f1 "$DUMP_DIR/prod_columns.txt" | sort > "$DUMP_DIR/prod_cols_nomes.txt"
cut -d'|' -f1 "$DUMP_DIR/uat_columns.txt"  | sort > "$DUMP_DIR/uat_cols_nomes.txt"
SO_PROD_COL=$(comm -23 "$DUMP_DIR/prod_cols_nomes.txt" "$DUMP_DIR/uat_cols_nomes.txt")
SO_UAT_COL=$(comm -13 "$DUMP_DIR/prod_cols_nomes.txt" "$DUMP_DIR/uat_cols_nomes.txt")

ABORTA_SCHEMA=0
if [ -n "$SO_PROD_TAB" ] || [ -n "$SO_PROD_COL" ]; then
  echo "  X O PROD tem estrutura que o UAT não tem (UAT atrás nas migrations):"
  [ -n "$SO_PROD_TAB" ] && echo "$SO_PROD_TAB" | sed 's/^/      tabela /'
  [ -n "$SO_PROD_COL" ] && echo "$SO_PROD_COL" | sed 's/^/      coluna /'
  ABORTA_SCHEMA=1
fi
if [ -n "$SO_UAT_COL" ]; then
  # Coluna só no UAT recebe default/NULL; NOT NULL sem default derruba o restore.
  while read -r col; do
    [ -z "$col" ] && continue
    linha=$(grep "^${col}|" "$DUMP_DIR/uat_columns.txt")
    nullable=$(echo "$linha" | cut -d'|' -f2); tem_default=$(echo "$linha" | cut -d'|' -f3)
    tabela="${col%.*}"
    if echo "$SO_UAT_TAB" | grep -qx "$tabela"; then continue; fi
    if [ "$nullable" = "NO" ] && [ "$tem_default" != "t" ]; then
      echo "  X coluna só no UAT, NOT NULL e sem default: $col (o restore da tabela falharia)"
      ABORTA_SCHEMA=1
    else
      echo "  ~ coluna só no UAT (fica com default/NULL): $col"
    fi
  done <<< "$SO_UAT_COL"
fi
if [ "$ABORTA_SCHEMA" = 1 ]; then
  echo "  Alinhe o schema (migrations) antes do refresh. Abortado."
  exit 1
fi
if [ -n "$SO_UAT_TAB" ]; then
  echo "  ! Tabelas que só existem no UAT (migration em teste) — ficarão VAZIAS:"
  echo "$SO_UAT_TAB" | sed 's/^/      /'
fi
echo "  ok schema compatível ($(wc -l < "$DUMP_DIR/prod_tables.txt") tabelas no PROD)"

# -- 3) Conexões ativas no UAT ----------------------------------------------------
echo
echo "> [3/9] Conexões abertas no banco do UAT (API ligada escreve no meio do restore)"
CONEXOES=$(uat_psql -tAF' | ' -c "
  SELECT usename, COALESCE(NULLIF(application_name, ''), '-'), COALESCE(client_addr::text, 'local'), state
  FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
  ORDER BY 1, 2;")
if [ -n "$CONEXOES" ]; then
  echo "$CONEXOES" | sed 's/^/    /'
  if [ "$DRY_RUN" != 1 ]; then
    echo "  ! Recomendado: stack uat-atlas em scale 0 durante o refresh."
    read -rp "  Seguir mesmo assim? digite CONTINUAR: " c3
    [[ "$c3" == "CONTINUAR" ]] || { echo "Abortado."; exit 0; }
  fi
else
  echo "  ok nenhuma outra conexão"
fi

# -- Contagens do PROD (antes) ----------------------------------------------------
prod_psql -tAF'|' -c "$COUNTS_SQL" | sort > "$DUMP_DIR/prod_counts_antes.txt"

if [ "$DRY_RUN" = 1 ]; then
  echo
  echo "> DRY_RUN — o que seria copiado (PROD agora):"
  uat_psql -tAF'|' -c "$COUNTS_SQL" | sort > "$DUMP_DIR/uat_counts_atual.txt"
  printf '    %-52s %12s %12s\n' "tabela" "PROD" "UAT hoje"
  join -t'|' -a1 -e '-' -o 0,1.2,2.2 "$DUMP_DIR/prod_counts_antes.txt" "$DUMP_DIR/uat_counts_atual.txt" \
    | awk -F'|' '$2 != $3 { printf "    %-52s %12s %12s\n", $1, $2, $3 }'
  echo "    (só tabelas com contagem diferente)"
  echo
  echo "OK DRY_RUN concluído — nada foi escrito."
  unset PGPASSWORD_PROD PGPASSWORD_UAT
  read -rp "Remover os arquivos de checagem em $DUMP_DIR? [Y/n] " limpar
  if [[ "${limpar:-y}" =~ ^[Nn]$ ]]; then
    echo "  arquivos preservados em $DUMP_DIR"
  else
    rm -rf "$DUMP_DIR"
    echo "  ok removidos"
  fi
  exit 0
fi

# -- 4) Backup do estado Atlas do UAT --------------------------------------------
echo
if [ "$BACKUP_UAT" = 1 ]; then
  echo "> [4/9] Backup data-only do estado Atlas do UAT -> $DUMP_DIR/backup_uat"
  PGPASSWORD="$PGPASSWORD_UAT" pg_dump \
    -h "$UAT_HOST" -p "$UAT_PORT" -U "$UAT_USER" -d "$UAT_DB" \
    "${DUMP_SCHEMA_ARGS[@]}" --data-only --no-owner --no-privileges \
    -Fd -j "$PARALLEL_JOBS" -f "$DUMP_DIR/backup_uat"
  echo "  ok backup: $(du -sh "$DUMP_DIR/backup_uat" | awk '{print $1}')"
  echo "    (rollback: TRUNCATE dos 6 schemas no UAT + pg_restore --data-only --disable-triggers desta pasta)"
else
  echo "> [4/9] Backup do UAT pulado (BACKUP_UAT=0)"
fi

# -- 5) Dump do PROD ------------------------------------------------------------------
echo
echo "> [5/9] pg_dump --data-only dos schemas Atlas (PROD) -> $DUMP_DIR/dump_prod"
PGPASSWORD="$PGPASSWORD_PROD" pg_dump \
  -h "$PROD_HOST" -p "$PROD_PORT" -U "$PROD_USER" -d "$PROD_DB" \
  "${DUMP_SCHEMA_ARGS[@]}" "${EXCLUDE_ARGS[@]}" \
  --data-only --no-owner --no-privileges \
  -Fd -j "$PARALLEL_JOBS" -f "$DUMP_DIR/dump_prod"
prod_psql -tAF'|' -c "$COUNTS_SQL" | sort > "$DUMP_DIR/prod_counts_depois.txt"
echo "  ok dump: $(du -sh "$DUMP_DIR/dump_prod" | awk '{print $1}')"

# -- 6) TRUNCATE + restore no UAT -------------------------------------------------
echo
echo "> [6/9] Truncando os schemas Atlas no UAT e restaurando o PROD"
uat_psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE
  tbl_list text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
    INTO tbl_list
  FROM pg_tables
  WHERE schemaname IN (${SCHEMA_IN_LIST});

  IF tbl_list IS NULL THEN
    RAISE EXCEPTION 'Nenhuma tabela Atlas encontrada no UAT';
  END IF;

  SET session_replication_role = replica;
  EXECUTE 'TRUNCATE TABLE ' || tbl_list || ' RESTRICT';
  SET session_replication_role = DEFAULT;
END\$\$;
SQL
echo "  ok truncate"

set +e
PGPASSWORD="$PGPASSWORD_UAT" pg_restore \
  -h "$UAT_HOST" -p "$UAT_PORT" -U "$UAT_USER" -d "$UAT_DB" \
  --data-only --disable-triggers --no-owner --no-privileges \
  -j "$PARALLEL_JOBS" \
  "$DUMP_DIR/dump_prod" 2>"$DUMP_DIR/restore_stderr.txt"
RESTORE_RC=$?
set -e
if [ $RESTORE_RC -ne 0 ]; then
  echo "  ! pg_restore rc=$RESTORE_RC — $DUMP_DIR/restore_stderr.txt (seguindo para a validação)"
else
  echo "  ok restore sem erros"
fi

# -- 7) Validação -------------------------------------------------------------------
echo
echo "> [7/9] Validando contagens (UAT x PROD antes/depois do dump)"
uat_psql -tAF'|' -c "$COUNTS_SQL" | sort > "$DUMP_DIR/uat_counts.txt"

# tabela|antes|depois|uat
join -t'|' "$DUMP_DIR/prod_counts_antes.txt" "$DUMP_DIR/prod_counts_depois.txt" \
  | join -t'|' -a1 -e '-1' -o 0,1.2,1.3,2.2 - "$DUMP_DIR/uat_counts.txt" > "$DUMP_DIR/validacao.txt"

DIVERGENTES=()
while IFS='|' read -r tbl antes depois uat; do
  [ -z "$tbl" ] && continue
  if [ "$antes" == "$depois" ]; then
    [ "$uat" == "$antes" ] || { DIVERGENTES+=("$tbl"); echo "  DIVERGENTE  $tbl: PROD=$antes  UAT=$uat"; }
  else
    lo=$(( antes < depois ? antes : depois )); hi=$(( antes > depois ? antes : depois ))
    if [ "$uat" -ge "$lo" ] && [ "$uat" -le "$hi" ]; then
      echo "  ~ $tbl mudou no PROD durante a cópia (antes=$antes depois=$depois) — UAT=$uat aceito"
    else
      DIVERGENTES+=("$tbl"); echo "  DIVERGENTE  $tbl: PROD antes=$antes depois=$depois  UAT=$uat"
    fi
  fi
done < "$DUMP_DIR/validacao.txt"

ERROS=()
if [ ${#DIVERGENTES[@]} -eq 0 ]; then
  echo "  ok todas as tabelas conferem"
else
  echo
  echo "  Retentando ${#DIVERGENTES[@]} tabela(s) individualmente..."
  for tbl in "${DIVERGENTES[@]}"; do
    sch="${tbl%%.*}"; tab="${tbl#*.}"
    RETRY="$DUMP_DIR/retry_${sch}_${tab}.dump"
    echo "  --> $tbl"
    set +e
    PGPASSWORD="$PGPASSWORD_PROD" pg_dump \
      -h "$PROD_HOST" -p "$PROD_PORT" -U "$PROD_USER" -d "$PROD_DB" \
      -t "\"${sch}\".\"${tab}\"" --data-only --no-owner --no-privileges \
      -Fc -f "$RETRY" 2>"$DUMP_DIR/retry_${sch}_${tab}_dump_err.txt"
    rc=$?
    set -e
    [ $rc -ne 0 ] && { echo "     X dump falhou"; ERROS+=("$tbl (dump)"); continue; }

    # DELETE (não TRUNCATE): tabela referenciada por FK não trunca sozinha.
    uat_psql -v ON_ERROR_STOP=1 -q -c \
      "SET session_replication_role = replica; DELETE FROM \"${sch}\".\"${tab}\"; SET session_replication_role = DEFAULT;"
    set +e
    PGPASSWORD="$PGPASSWORD_UAT" pg_restore \
      -h "$UAT_HOST" -p "$UAT_PORT" -U "$UAT_USER" -d "$UAT_DB" \
      --data-only --disable-triggers --no-owner --no-privileges --single-transaction \
      "$RETRY" 2>"$DUMP_DIR/retry_${sch}_${tab}_restore_err.txt"
    rc=$?
    set -e
    [ $rc -ne 0 ] && {
      echo "     X restore falhou — $DUMP_DIR/retry_${sch}_${tab}_restore_err.txt"
      head -5 "$DUMP_DIR/retry_${sch}_${tab}_restore_err.txt"
      ERROS+=("$tbl (restore)"); continue
    }
    novo_uat=$(uat_psql -tAc "SELECT count(*) FROM \"${sch}\".\"${tab}\"")
    agora_prod=$(prod_psql -tAc "SELECT count(*) FROM \"${sch}\".\"${tab}\"")
    if [ "$novo_uat" == "$agora_prod" ]; then
      echo "     ok UAT=$novo_uat == PROD=$agora_prod"
    else
      echo "     X segue divergente: UAT=$novo_uat PROD=$agora_prod"
      ERROS+=("$tbl (divergente)")
    fi
  done
fi

# -- 8) Sanitização do UAT + sequences --------------------------------------------
echo
echo "> [8/9] Sanitizando usuários e conferindo sequences no UAT"
uat_psql -v ON_ERROR_STOP=1 -q <<'SQL'
SET session_replication_role = replica;
UPDATE atlas.users
   SET password_reset_token = NULL,
       password_reset_expires = NULL,
       failed_login_attempts = 0,
       locked_until = NULL;
SET session_replication_role = DEFAULT;
SQL
echo "  ok tokens de reset e bloqueios zerados; atlas.sessions vazia (login de novo)"

prod_psql -tAF'|' -c "
  SELECT schemaname || '.' || sequencename, last_value
  FROM pg_sequences WHERE schemaname IN (${SCHEMA_IN_LIST}) AND last_value IS NOT NULL ORDER BY 1;" \
  > "$DUMP_DIR/prod_seqs.txt"
n_seq=0
while IFS='|' read -r seq val; do
  [ -z "$seq" ] && continue
  uat_psql -tAc "SELECT setval('${seq}', ${val});" >/dev/null 2>&1 && n_seq=$((n_seq + 1)) \
    || echo "  ! sequence $seq não ajustada (existe no UAT?)"
done < "$DUMP_DIR/prod_seqs.txt"
echo "  ok $n_seq sequence(s) iguais às do PROD"

# -- 9) Grants + caches derivados ---------------------------------------------------
echo
echo "> [9/9] Grants claude_ro + refresh de caches derivados no UAT"
uat_psql -v ON_ERROR_STOP=1 -q <<'SQL'
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
uat_psql -q <<'SQL'
DO $$
DECLARE v integer;
BEGIN
  IF to_regprocedure('stockbridge.refresh_lotes_em_transito_se_stale(integer)') IS NOT NULL THEN
    BEGIN
      SELECT stockbridge.refresh_lotes_em_transito_se_stale(0) INTO v;
      RAISE NOTICE 'transito: % lote(s) recomputado(s) da FUP', v;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'refresh de transito falhou (cockpit pega no proximo load): %', SQLERRM;
    END;
  END IF;
  IF to_regprocedure('stockbridge.refresh_consumo_medio_se_stale(integer)') IS NOT NULL THEN
    BEGIN
      SELECT stockbridge.refresh_consumo_medio_se_stale(0) INTO v;
      RAISE NOTICE 'consumo: % registro(s) recomputado(s)', v;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'refresh de consumo falhou (cockpit pega no proximo load): %', SQLERRM;
    END;
  END IF;
END$$;
SQL

# -- Resumo -----------------------------------------------------------------------
echo
echo "> Tabelas críticas — UAT x PROD (agora):"
CRITICAS_SQL="
SELECT 'atlas.users', count(*) FROM atlas.users
UNION ALL SELECT 'stockbridge.lote', count(*) FROM stockbridge.lote
UNION ALL SELECT 'stockbridge.movimentacao', count(*) FROM stockbridge.movimentacao
UNION ALL SELECT 'stockbridge.aprovacao', count(*) FROM stockbridge.aprovacao
UNION ALL SELECT 'stockbridge.nf_pedido_mapa', count(*) FROM stockbridge.nf_pedido_mapa
UNION ALL SELECT 'stockbridge.baixa_pedido_q2p', count(*) FROM stockbridge.baixa_pedido_q2p
UNION ALL SELECT 'shared.audit_log', count(*) FROM shared.audit_log
ORDER BY 1;"
uat_psql -tAF'|' -c "$CRITICAS_SQL" > "$DUMP_DIR/criticas_uat.txt"
prod_psql -tAF'|' -c "$CRITICAS_SQL" > "$DUMP_DIR/criticas_prod.txt"
printf '    %-32s %10s %10s\n' "tabela" "UAT" "PROD"
join -t'|' "$DUMP_DIR/criticas_uat.txt" "$DUMP_DIR/criticas_prod.txt" \
  | awk -F'|' '{ printf "    %-32s %10s %10s\n", $1, $2, $3 }'

unset PGPASSWORD_PROD PGPASSWORD_UAT

if [ ${#ERROS[@]} -gt 0 ]; then
  echo
  echo "X Refresh terminou com tabelas divergentes:"
  for e in "${ERROS[@]}"; do echo "    - $e"; done
  echo "  Dump do PROD e backup do UAT preservados em $DUMP_DIR"
  exit 1
fi

echo
echo "OK Refresh PROD -> UAT concluído. Religue a API do UAT (scale 1) e confira o health."

# -- Limpeza ----------------------------------------------------------------------
# O dump do PROD só serve para esta cópia; o backup do UAT é o que permite desfazer
# o refresh — por isso os defaults são diferentes.
echo
read -rp "Apagar o dump do PROD ($(du -sh "$DUMP_DIR/dump_prod" | awk '{print $1}'))? [Y/n] " limpar_dump
if [[ "${limpar_dump:-y}" =~ ^[Nn]$ ]]; then
  echo "  dump do PROD preservado em $DUMP_DIR/dump_prod"
else
  rm -rf "$DUMP_DIR/dump_prod" "$DUMP_DIR"/retry_*
  echo "  ok dump do PROD apagado"
fi
if [ -d "$DUMP_DIR/backup_uat" ]; then
  read -rp "Apagar também o backup do UAT ($(du -sh "$DUMP_DIR/backup_uat" | awk '{print $1}'), serve para desfazer o refresh)? [y/N] " limpar_backup
  if [[ "${limpar_backup:-n}" =~ ^[Yy]$ ]]; then
    rm -rf "$DUMP_DIR"
    echo "  ok backup apagado (pasta $DUMP_DIR removida)"
  else
    echo "  backup do UAT preservado em $DUMP_DIR/backup_uat — apague quando os testes confirmarem o refresh"
  fi
else
  rm -rf "$DUMP_DIR"
  echo "  ok pasta $DUMP_DIR removida"
fi
