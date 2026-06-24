#!/usr/bin/env bash
# =============================================================================
# sync-omie-public-prod-to-uat.sh
#
# Atualiza APENAS o schema public (espelho OMIE) de prod -> uat.
# Preserva integralmente todos os schemas Atlas que o UAT ja modificou:
#   stockbridge.*, shared.*, hedge.*, forecast.*, breakingpoint.*, crm.*
#
# Estrategia:
#   1. Captura contagens de PROD (baseline para validacao)
#   2. Triagem de drift de schema PROD vs UAT: auto-ADD COLUMN aditivo; exclui
#      do reload tabelas com drift destrutivo/ausentes (nunca esvazia em silencio)
#   3. pg_dump --schema=public --data-only do PROD
#   4. TRUNCATE de todas as tabelas public.* no UAT (comando unico, por causa de FKs)
#   5. pg_restore no UAT
#   6. Valida contagens UAT vs PROD live — retenta individualmente tabelas divergentes
#   7. Regranta acessos UAT-only (claude_ro, crm_dev)
#   8. Recomputa os caches derivados do Atlas (transito FUP, consumo) — TTL=0,
#      para o cockpit refletir os dados novos sem esperar o lazy-load da API
#
# ATENCAO — race com n8n:
#   O pg_dump tira um snapshot consistente no momento em que inicia. Dados
#   sincronizados pelo n8n APOS o dump abrir a transacao nao serao incluidos.
#   Para dados absolutamente frescos, pause os workflows de sync n8n antes
#   de rodar este script e reative logo apos.
#
# Pre-requisitos:
#   - pg_dump / pg_restore / psql instalados (>= versao do servidor)
#   - Variaveis do prod (obrigatorias):
#       PROD_USER         usuario do db.manager01.q2p.com.br
#       PGPASSWORD_PROD   senha (se nao setada, sera pedida)
#   - Variaveis do UAT (opcional):
#       PGPASSWORD_UAT    senha do postgres no UAT (se nao setada, sera pedida)
#
# Uso:
#   export PROD_USER=meu.usuario
#   export PGPASSWORD_PROD='senhaaqui'
#   export PGPASSWORD_UAT='senhaaqui'
#   scripts/sync-omie-public-prod-to-uat.sh
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
DUMP_DIR="/tmp/omie_public_dump_$(date +%Y%m%d_%H%M%S)"

# Tabelas criadas pelas migrations Atlas em public.* — nao existem em PROD,
# devem ser excluidas do TRUNCATE e do restore para nao perder dados.
ATLAS_TABLES_IN_PUBLIC=(
  'tb_movimentacao_q2p_legado'
)

# -- Pre-checks --------------------------------------------------------------
[ -z "$PROD_USER" ] && {
  echo "X PROD_USER nao setado."
  echo "   Rode: export PROD_USER=<seu-usuario-prod>"
  exit 1
}

for cmd in pg_dump pg_restore psql awk join sort; do
  command -v "$cmd" >/dev/null || { echo "X '$cmd' nao instalado"; exit 1; }
done

# Senhas
if [ -z "${PGPASSWORD_PROD:-}" ]; then
  read -rsp "Senha do prod ($PROD_USER@$PROD_HOST:$PROD_PORT): " PGPASSWORD_PROD
  echo
fi
if [ -z "${PGPASSWORD_UAT:-}" ]; then
  read -rsp "Senha do UAT ($UAT_USER@$UAT_HOST:$UAT_PORT): " PGPASSWORD_UAT
  echo
fi

# Helpers
prod_psql() {
  PGPASSWORD="$PGPASSWORD_PROD" psql -h "$PROD_HOST" -p "$PROD_PORT" \
    -U "$PROD_USER" -d "$PROD_DB" "$@"
}
uat_psql() {
  PGPASSWORD="$PGPASSWORD_UAT" psql -h "$UAT_HOST" -p "$UAT_PORT" \
    -U "$UAT_USER" -d "$UAT_DB" "$@"
}

# Monta exclusao SQL para as tabelas Atlas em public.*
atlas_exclusion_sql() {
  local list=""
  for t in "${ATLAS_TABLES_IN_PUBLIC[@]}"; do
    [ -n "$list" ] && list="$list,"
    list="$list '${t}'"
  done
  echo "$list"
}

# -- Confirmacao -------------------------------------------------------------
cat <<EOF

+-------------------------------------------------------------------------+
| SYNC SELETIVO  public.*  prod -> uat                                    |
+-------------------------------------------------------------------------+
| Origem : $PROD_USER@$PROD_HOST:$PROD_PORT/$PROD_DB
| Destino: $UAT_USER@$UAT_HOST:$UAT_PORT/$UAT_DB
| Dump   : $DUMP_DIR (-j $PARALLEL_JOBS)
|                                                                         |
| O QUE MUDA no UAT:                                                      |
|   - Todas as tabelas em public.* serao truncadas e recarregadas do PROD |
|                                                                         |
| O QUE NAO MUDA no UAT:                                                  |
|   - stockbridge.*, shared.*, hedge.*, forecast.*, breakingpoint.*       |
|   - crm.* e quaisquer outros schemas nao-public                         |
|   - public.tb_movimentacao_q2p_legado (historico MySQL legado)          |
+-------------------------------------------------------------------------+

EOF
# Modo nao-interativo para execucao agendada (cron). Ative com ASSUME_YES=1
# ou passando --yes/-y. Sem isso, pede confirmacao como antes.
if [[ "${ASSUME_YES:-}" == "1" || "${1:-}" == "--yes" || "${1:-}" == "-y" ]]; then
  echo "Continuar? [y/N] y  (ASSUME_YES — modo nao-interativo)"
  confirm=y
else
  read -rp "Continuar? [y/N] " confirm
fi
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Abortado."; exit 0; }

mkdir -p "$DUMP_DIR"

# -- 1) Validar conectividade -------------------------------------------------
echo
echo "> [1/6] Validando conectividade"

prod_psql -tAc "SELECT 1" >/dev/null
echo "  ok prod: $PROD_USER@$PROD_HOST:$PROD_PORT/$PROD_DB"

uat_psql -tAc "SELECT 1" >/dev/null
echo "  ok uat:  $UAT_USER@$UAT_HOST:$UAT_PORT/$UAT_DB"

ATLAS_SCHEMAS=$(uat_psql -tAc "
  SELECT count(*) FROM pg_namespace
  WHERE nspname IN ('stockbridge','shared','hedge','forecast','breakingpoint');
")
if [ "$ATLAS_SCHEMAS" -lt 1 ]; then
  echo
  echo "X UAT sem schemas Atlas — rode apply-migrations-uat.sh primeiro."
  exit 1
fi
echo "  ok schemas Atlas presentes no UAT ($ATLAS_SCHEMAS de 5 encontrados)"

# -- 2) Capturar contagens de PROD (baseline) ---------------------------------
echo
echo "> [2/6] Capturando contagens de PROD (baseline para validacao pos-restore)"

EXCLUSION_LIST=$(atlas_exclusion_sql)

# query_to_xml executa a contagem de cada tabela dinamicamente numa unica query
prod_psql -tAF$'|' <<SQL > "$DUMP_DIR/prod_counts.txt"
SELECT tablename,
  (xpath('/row/n/text()',
    query_to_xml(
      format('SELECT count(*) AS n FROM public.%I', tablename),
      false, true, ''
    )
  ))[1]::text::bigint AS cnt
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename NOT IN (${EXCLUSION_LIST})
ORDER BY tablename;
SQL

echo "  ok $(wc -l < "$DUMP_DIR/prod_counts.txt") tabelas mapeadas"

# -- 2b) Triagem de DRIFT de schema PROD vs UAT -------------------------------
# O sync e --data-only: NAO traz DDL. Se o schema do PROD evoluiu (coluna nova,
# rename, tabela nova) e o UAT ficou no schema antigo, o COPY do restore falha
# com "column X does not exist" e a tabela fica VAZIA silenciosamente.
# Esta fase compara as colunas das tabelas-base public.* e:
#   - drift ADITIVO (coluna so em PROD, ausente no UAT) -> ALTER ADD COLUMN auto
#     (como nullable, p/ nao falhar em tabela com linhas) — a tabela continua
#     no conjunto de reload e se auto-cura.
#   - drift DESTRUTIVO (coluna so no UAT: rename/drop em PROD) ou TABELA AUSENTE
#     no UAT -> a tabela e EXCLUIDA do truncate+reload (dados antigos preservados,
#     nunca esvaziada) e listada no relatorio para reconciliacao manual.
#   - VIEWS com drift -> apenas detectadas e reportadas (mudanca em view pode ser
#     comportamental); DDL do PROD salva em prod_views.sql para revisao.
echo
echo "> [2b/6] Triagem de drift de schema (PROD vs UAT)"

COLS_SQL="SELECT c.relname || '|' || a.attname || '|' ||
       pg_catalog.format_type(a.atttypid, a.atttypmod) || '|' ||
       (CASE WHEN a.attnotnull THEN 't' ELSE 'f' END)
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY c.relname, a.attnum;"

prod_psql -tA -c "$COLS_SQL" > "$DUMP_DIR/prod_cols.txt"
uat_psql  -tA -c "$COLS_SQL" > "$DUMP_DIR/uat_cols.txt"

# DDL das views public do PROD (para revisao/reaplicacao manual de drift de view)
prod_psql -tA -c "
SELECT 'CREATE OR REPLACE VIEW public.\"' || c.relname || '\" AS ' ||
       pg_get_viewdef(c.oid, true) || E'\n'
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'v'
ORDER BY c.relname;" > "$DUMP_DIR/prod_views.sql" 2>/dev/null || true

python3 - "$DUMP_DIR/prod_cols.txt" "$DUMP_DIR/uat_cols.txt" \
          "$DUMP_DIR/auto_alter.sql" "$DUMP_DIR/skip_tables.txt" \
          "$DUMP_DIR/drift_report.txt" <<'PY'
import sys, collections
prod_p, uat_p, alter_p, skip_p, report_p = sys.argv[1:6]
def load(p):
    d = collections.OrderedDict()
    for line in open(p):
        line = line.rstrip('\n')
        if not line: continue
        tbl, col, typ, notnull = line.split('|')
        d.setdefault(tbl, collections.OrderedDict())[col] = (typ, notnull == 't')
    return d
prod, uat = load(prod_p), load(uat_p)
alter, skip, report = [], [], []
for tbl, pcols in prod.items():
    if tbl not in uat:
        skip.append(tbl)
        report.append(f"[TABELA AUSENTE]  {tbl}: existe em PROD, nao no UAT. "
                      f"Acao: criar via DDL do PROD; sera pulada no reload.")
        continue
    ucols = uat[tbl]
    additive = [c for c in pcols if c not in ucols]
    removed  = [c for c in ucols if c not in pcols]
    if removed:
        skip.append(tbl)
        report.append(f"[DRIFT DESTRUTIVO]  {tbl}: so-no-UAT (rename/drop em PROD)={removed} "
                      f"so-no-PROD={additive}. Acao: reconciliar manual; tabela PULADA no reload "
                      f"(dados antigos preservados).")
        continue
    for c in additive:
        typ, notnull = pcols[c]
        # nullable de proposito: ADD COLUMN NOT NULL falharia em tabela com linhas
        alter.append(f'ALTER TABLE public."{tbl}" ADD COLUMN IF NOT EXISTS "{c}" {typ};')
        extra = ' (NOT NULL em PROD — constraint nao aplicada)' if notnull else ''
        report.append(f"[DRIFT ADITIVO]  {tbl}.{c} {typ}{extra}: ADD COLUMN automatico no UAT.")
open(alter_p, 'w').write('\n'.join(alter) + ('\n' if alter else ''))
open(skip_p, 'w').write('\n'.join(skip) + ('\n' if skip else ''))
open(report_p, 'w').write('\n'.join(report) + ('\n' if report else 'Sem drift de schema em tabelas-base.\n'))
print(f"{len(alter)} ADD COLUMN | {len(skip)} tabela(s) pulada(s)")
PY

# Aplicar ALTERs aditivos no UAT (auto-cura de coluna nova)
if [ -s "$DUMP_DIR/auto_alter.sql" ]; then
  echo "  Aplicando drift aditivo (ADD COLUMN) no UAT:"
  sed 's/^/    /' "$DUMP_DIR/auto_alter.sql"
  uat_psql -v ON_ERROR_STOP=1 -f "$DUMP_DIR/auto_alter.sql"
fi

# Montar exclusao combinada (Atlas + tabelas puladas por drift) p/ truncate/validacao
SKIP_SQL=""
if [ -s "$DUMP_DIR/skip_tables.txt" ]; then
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    SKIP_SQL="$SKIP_SQL, '${t}'"
  done < "$DUMP_DIR/skip_tables.txt"
fi
EXCLUSION_LIST="$(atlas_exclusion_sql)${SKIP_SQL}"

if [ -s "$DUMP_DIR/skip_tables.txt" ]; then
  echo "  ! Tabelas EXCLUIDAS do reload (drift nao-aditivo, dados preservados):"
  sed 's/^/    - /' "$DUMP_DIR/skip_tables.txt"
fi
echo "  Relatorio completo de drift: $DUMP_DIR/drift_report.txt"
echo "  DDL das views do PROD (p/ revisao): $DUMP_DIR/prod_views.sql"

# -- 3) Dump public.* --data-only do prod -------------------------------------
echo
echo "> [3/6] pg_dump public.* --data-only (prod) -> $DUMP_DIR/dump"
echo

PGPASSWORD="$PGPASSWORD_PROD" pg_dump \
  -h "$PROD_HOST" -p "$PROD_PORT" -U "$PROD_USER" -d "$PROD_DB" \
  --schema=public \
  --data-only \
  --disable-triggers \
  --no-owner --no-privileges \
  -Fd -j "$PARALLEL_JOBS" \
  -f "$DUMP_DIR/dump" \
  --verbose

echo
echo "  ok dump pronto. Tamanho: $(du -sh "$DUMP_DIR/dump" | awk '{print $1}')"

# -- 4) TRUNCATE public.* no UAT ----------------------------------------------
echo
echo "> [4/6] Truncando tabelas public.* no UAT"

# TRUNCATE de TODAS as public.* num UNICO comando. Critico: ha FKs entre
# tabelas public (ex.: tbl_nf_itens_* -> tbl_nf_header_*). Um TRUNCATE
# tabela-a-tabela falha com "cannot truncate a table referenced in a foreign
# key constraint" — e session_replication_role=replica NAO dispensa essa
# checagem (ela so desliga o disparo de triggers). Listando todas juntas, a
# referenciada e a referenciadora caem no mesmo comando e a checagem passa,
# sem CASCADE e sem risco de tocar schemas Atlas.
uat_psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE
  tbl_list text;
BEGIN
  SELECT string_agg(format('public.%I', tablename), ', ')
    INTO tbl_list
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename NOT IN (${EXCLUSION_LIST});

  IF tbl_list IS NULL THEN
    RAISE EXCEPTION 'Nenhuma tabela public.* encontrada para truncar';
  END IF;

  SET session_replication_role = replica;
  EXECUTE 'TRUNCATE TABLE ' || tbl_list || ' RESTRICT';
  SET session_replication_role = DEFAULT;

  RAISE NOTICE 'Truncadas todas as tabelas public.* num unico comando';
END\$\$;
SQL

echo "  ok truncate concluido"

# -- 5) Restore no UAT --------------------------------------------------------
echo
echo "> [5/6] pg_restore public.* --data-only (uat)"
echo

# pg_restore retorna exit 1 se houver warnings (nao necessariamente erros fatais).
# Capturamos a saida de erro para inspecionar depois e continuamos de qualquer forma.
set +e
PGPASSWORD="$PGPASSWORD_UAT" pg_restore \
  -h "$UAT_HOST" -p "$UAT_PORT" -U "$UAT_USER" -d "$UAT_DB" \
  --schema=public \
  --data-only \
  --disable-triggers \
  --no-owner --no-privileges \
  -j "$PARALLEL_JOBS" \
  --verbose "$DUMP_DIR/dump" 2>"$DUMP_DIR/restore_stderr.txt"
RESTORE_RC=$?
set -e

if [ $RESTORE_RC -ne 0 ]; then
  echo
  echo "  ! pg_restore saiu com codigo $RESTORE_RC (pode haver erros parciais)."
  echo "    Erros registrados em: $DUMP_DIR/restore_stderr.txt"
  echo "    Continuando para a fase de validacao..."
else
  echo
  echo "  ok restore concluido sem erros"
fi

# -- 6) Validar contagens e retentar tabelas divergentes ----------------------
echo
echo "> [6/6] Validando contagens UAT vs PROD e retentando tabelas divergentes"

# Obter contagens do UAT
uat_psql -tAF$'|' <<SQL > "$DUMP_DIR/uat_counts.txt"
SELECT tablename,
  (xpath('/row/n/text()',
    query_to_xml(
      format('SELECT count(*) AS n FROM public.%I', tablename),
      false, true, ''
    )
  ))[1]::text::bigint AS cnt
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename NOT IN (${EXCLUSION_LIST})
ORDER BY tablename;
SQL

# Capturar contagens ATUAIS do PROD (pos-restore) para detectar race com n8n.
# O phase 2 capturou a baseline antes do dump; se o n8n rodou durante a sync
# (dump + restore levam minutos), PROD pode ter crescido. Comparar UAT contra
# a baseline desatualizada nao detectaria essa divergencia.
prod_psql -tAF$'|' <<SQL > "$DUMP_DIR/prod_counts_live.txt"
SELECT tablename,
  (xpath('/row/n/text()',
    query_to_xml(
      format('SELECT count(*) AS n FROM public.%I', tablename),
      false, true, ''
    )
  ))[1]::text::bigint AS cnt
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename NOT IN (${EXCLUSION_LIST})
ORDER BY tablename;
SQL

# Avisar se PROD mudou enquanto faziamos o dump/restore (n8n correu junto)
PROD_CHANGED=false
while IFS='|' read -r tbl baseline_cnt live_cnt; do
  [ -z "$tbl" ] && continue
  if [ "$live_cnt" != "$baseline_cnt" ]; then
    PROD_CHANGED=true
    echo "  ! n8n race detectado: $tbl  baseline=$baseline_cnt  live=$live_cnt"
  fi
done < <(join -t'|' -j1 \
  <(sort -t'|' -k1 "$DUMP_DIR/prod_counts.txt") \
  <(sort -t'|' -k1 "$DUMP_DIR/prod_counts_live.txt") \
  | awk -F'|' '{print $1 "|" $2 "|" $3}')

if [ "$PROD_CHANGED" = true ]; then
  echo
  echo "  AVISO: PROD foi atualizado pelo n8n durante a sync."
  echo "  Comparando UAT contra contagens ATUAIS do PROD (nao o baseline do dump)..."
  echo
fi

# Comparar UAT vs PROD LIVE (nao baseline) — detecta tanto falha de restore
# quanto race com n8n que adicionou dados depois do dump ser tirado.
DIVERGENT_TABLES=()
while IFS='|' read -r tbl prod_live_cnt uat_cnt; do
  [ -z "$tbl" ] && continue

  if [ -z "$uat_cnt" ]; then
    echo "  ! $tbl: existe em PROD mas nao no UAT — pulando"
    continue
  fi

  threshold=$(( prod_live_cnt * 99 / 100 ))

  if [ "$uat_cnt" -lt "$threshold" ]; then
    DIVERGENT_TABLES+=("$tbl")
    echo "  DIVERGENTE  $tbl: PROD_live=$prod_live_cnt  UAT=$uat_cnt  (esperado >=$threshold)"
  fi
done < <(join -t'|' -j1 \
  <(sort -t'|' -k1 "$DUMP_DIR/prod_counts_live.txt") \
  <(sort -t'|' -k1 "$DUMP_DIR/uat_counts.txt") \
  | awk -F'|' '{print $1 "|" $2 "|" $3}')

if [ ${#DIVERGENT_TABLES[@]} -eq 0 ]; then
  echo "  ok todas as tabelas dentro do esperado"
else
  echo
  echo "  Retentando ${#DIVERGENT_TABLES[@]} tabela(s) individualmente..."
  echo

  RETRY_ERRORS=()

  for tbl in "${DIVERGENT_TABLES[@]}"; do
    echo "  --> retry: $tbl"
    RETRY_DUMP="$DUMP_DIR/retry_${tbl}.dump"

    # a) Dump individual da tabela em PROD (-Fc = custom format, unico arquivo)
    set +e
    PGPASSWORD="$PGPASSWORD_PROD" pg_dump \
      -h "$PROD_HOST" -p "$PROD_PORT" -U "$PROD_USER" -d "$PROD_DB" \
      -t "public.\"${tbl}\"" \
      --data-only \
      --disable-triggers \
      --no-owner --no-privileges \
      -Fc \
      -f "$RETRY_DUMP" 2>"$DUMP_DIR/retry_${tbl}_dump_err.txt"
    DUMP_RC=$?
    set -e

    if [ $DUMP_RC -ne 0 ]; then
      echo "     X dump falhou (rc=$DUMP_RC) — veja $DUMP_DIR/retry_${tbl}_dump_err.txt"
      RETRY_ERRORS+=("$tbl (dump falhou)")
      continue
    fi

    # b) Esvaziar a tabela no UAT. Usamos DELETE (nao TRUNCATE) sob
    #    session_replication_role=replica: se a tabela for referenciada por FK
    #    (ex.: tbl_nf_header_ACXE <- tbl_nf_itens_ACXE), o TRUNCATE individual
    #    falharia com "cannot truncate a table referenced in a foreign key".
    #    DELETE em modo replica nao dispara os triggers de FK e nao toca nas
    #    tabelas-filhas — exatamente o que queremos no retry de uma so tabela.
    uat_psql -v ON_ERROR_STOP=1 -c \
      "SET session_replication_role = replica; DELETE FROM public.\"${tbl}\"; SET session_replication_role = DEFAULT;"

    # c) Restore individual com --single-transaction para capturar erro completo
    set +e
    PGPASSWORD="$PGPASSWORD_UAT" pg_restore \
      -h "$UAT_HOST" -p "$UAT_PORT" -U "$UAT_USER" -d "$UAT_DB" \
      --data-only \
      --disable-triggers \
      --no-owner --no-privileges \
      --single-transaction \
      "$RETRY_DUMP" 2>"$DUMP_DIR/retry_${tbl}_restore_err.txt"
    RESTORE_RC=$?
    set -e

    if [ $RESTORE_RC -ne 0 ]; then
      echo "     X restore falhou (rc=$RESTORE_RC) — veja $DUMP_DIR/retry_${tbl}_restore_err.txt"
      cat "$DUMP_DIR/retry_${tbl}_restore_err.txt" | head -10
      RETRY_ERRORS+=("$tbl (restore falhou — veja $DUMP_DIR/retry_${tbl}_restore_err.txt)")
      continue
    fi

    # d) Confirmar contagem pos-retry (compara contra PROD live, nao baseline)
    NEW_CNT=$(uat_psql -tAc "SELECT count(*) FROM public.\"${tbl}\"")
    PROD_CNT=$(grep "^${tbl}|" "$DUMP_DIR/prod_counts_live.txt" | cut -d'|' -f2)
    echo "     ok $tbl: UAT=$NEW_CNT  PROD_live=$PROD_CNT"
  done

  if [ ${#RETRY_ERRORS[@]} -gt 0 ]; then
    echo
    echo "  ATENCAO: as seguintes tabelas ainda apresentam problemas apos retry:"
    for e in "${RETRY_ERRORS[@]}"; do
      echo "    - $e"
    done
    echo "  Arquivos de log preservados em $DUMP_DIR para diagnostico."
  fi
fi

# -- Grants UAT-only + DEFAULT PRIVILEGES -------------------------------------
# CRITICO: as tabelas OMIE em public.* sao recriadas fora deste sync (n8n usa
# padrao staging->swap, dono=postgres). Um GRANT pontual nas tabelas atuais NAO
# sobrevive a recriacao — por isso o claude_ro perde o SELECT em public toda vez
# que o n8n recria uma tabela. A rede de seguranca real e o DEFAULT PRIVILEGE
# (pg_default_acl): com ele, TODA tabela nova criada por postgres em public ja
# nasce com SELECT pro claude_ro — exatamente como ja acontece nos schemas Atlas.
#
# Rodamos como SQL top-level via \gexec (NAO dentro de DO/plpgsql) e com
# FOR ROLE postgres explicito, garantindo a entrada em pg_default_acl. So gera
# comandos para as roles que existem no cluster.
echo
echo "> Reaplicando grants + DEFAULT PRIVILEGES em public (claude_ro, crm_dev)"

uat_psql -v ON_ERROR_STOP=1 <<'SQL'
SELECT format(cmd, rolname)
FROM (VALUES
  ('GRANT USAGE ON SCHEMA public TO %I'),
  ('GRANT SELECT ON ALL TABLES    IN SCHEMA public TO %I'),
  ('GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO %I'),
  ('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES    TO %I'),
  ('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON SEQUENCES TO %I')
) AS c(cmd)
CROSS JOIN (
  SELECT rolname FROM pg_roles WHERE rolname IN ('claude_ro','crm_dev')
) AS r
ORDER BY rolname
\gexec

-- Verificacao: confirma que a rede de seguranca (default acl) ficou em public
SELECT 'default_acl_public_' || pg_get_userbyid(defaclrole) AS check,
       defaclacl::text
FROM pg_default_acl d
JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public' AND d.defaclobjtype = 'r';
SQL

# -- Refresh dos caches derivados do Atlas ------------------------------------
# O cockpit nao le public.* direto: ele consome caches DERIVADOS em stockbridge.*
# (lote.estagio_transito vem da FUP; consumo medio vem dos pedidos de venda).
# Esses caches sao recomputados de forma lazy (funcoes *_se_stale com TTL),
# disparados pela API ao abrir o cockpit. Como acabamos de trocar os dados de
# public.*, forcamos o recalculo aqui (TTL=0) para o cockpit refletir os dados
# novos imediatamente, sem esperar o lazy-load. Defensivo: pula se as funcoes
# nao existirem e nao aborta o sync se um refresh falhar.
echo
echo "> Recomputando caches derivados do Atlas (transito FUP, consumo medio)"

uat_psql <<'SQL'
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
  ELSE
    RAISE NOTICE 'funcao refresh_lotes_em_transito_se_stale ausente — pulando';
  END IF;

  IF to_regprocedure('stockbridge.refresh_consumo_medio_se_stale(integer)') IS NOT NULL THEN
    BEGIN
      SELECT stockbridge.refresh_consumo_medio_se_stale(0) INTO v_consumo;
      RAISE NOTICE 'consumo: % registro(s) recomputado(s)', v_consumo;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'refresh de consumo falhou (cockpit pega no proximo load): %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'funcao refresh_consumo_medio_se_stale ausente — pulando';
  END IF;
END$$;
SQL

# -- Resumo final -------------------------------------------------------------
echo
echo "> Resumo final:"
uat_psql -X -A -F$'\t' <<'SQL'
SELECT
  schemaname AS schema,
  count(*) AS tabelas,
  -- format('%I.%I', ...) cita os identificadores; sem isso, relname com
  -- maiuscula (ex.: tbl_movimentacaoEstoqueHistorico_Q2P) e baixado e quebra.
  pg_size_pretty(sum(pg_total_relation_size(format('%I.%I', schemaname, relname)))) AS tamanho
FROM pg_stat_user_tables
WHERE schemaname IN ('public','stockbridge','shared','atlas','hedge','forecast','breakingpoint')
GROUP BY schemaname
ORDER BY schemaname;
SQL

echo
echo "> Tabelas OMIE criticas (UAT):"
uat_psql -X -A -F$'\t' <<'SQL'
SELECT 'tbl_historico_cmc_estoque'         AS tabela,
       count(*) AS linhas,
       max(data_snapshot::date) AS data_mais_recente
FROM public."tbl_historico_cmc_estoque"
UNION ALL
SELECT 'tbl_nf_header_ACXE',               count(*), max(d_emi::date)
FROM public."tbl_nf_header_ACXE"
UNION ALL
SELECT 'tbl_dadosPlanilhaFUPComex',         count(*), NULL
FROM public."tbl_dadosPlanilhaFUPComex"
UNION ALL
SELECT 'tbl_movimentacaoEstoqueHistorico_Q2P', count(*), NULL
FROM public."tbl_movimentacaoEstoqueHistorico_Q2P"
ORDER BY tabela;
SQL

echo
echo "> Schemas Atlas preservados:"
uat_psql -X -A -F$'\t' <<'SQL'
SELECT 'stockbridge.lote'        AS tabela, count(*) AS linhas FROM stockbridge.lote
UNION ALL
SELECT 'stockbridge.nf_pedido_mapa',        count(*) FROM stockbridge.nf_pedido_mapa
UNION ALL
SELECT 'atlas.users',                       count(*) FROM atlas.users
UNION ALL
SELECT 'public.tb_movimentacao_q2p_legado', count(*) FROM public."tb_movimentacao_q2p_legado";
SQL

# -- Limpeza ------------------------------------------------------------------
echo
if [ ${#DIVERGENT_TABLES[@]} -gt 0 ] && [ ${#RETRY_ERRORS[@]} -gt 0 ]; then
  echo "  Logs de erro preservados em $DUMP_DIR (nao removido automaticamente)."
else
  if [[ "${ASSUME_YES:-}" == "1" || "${1:-}" == "--yes" || "${1:-}" == "-y" ]]; then
    cleanup=y   # modo nao-interativo (cron): remove o dump por padrao
  else
    read -rp "Remover $DUMP_DIR? [Y/n] " cleanup
  fi
  if [[ ! "$cleanup" =~ ^[Nn]$ ]]; then
    rm -rf "$DUMP_DIR"
    echo "  ok dump removido"
  else
    echo "  dump preservado em $DUMP_DIR"
  fi
fi

unset PGPASSWORD_PROD PGPASSWORD_UAT
echo
echo "OK Sync seletivo public.* concluido. Schemas Atlas intactos."
