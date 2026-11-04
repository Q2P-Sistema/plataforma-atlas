#!/usr/bin/env bash
# =============================================================================
# agendador.sh — cópia diária do espelho OMIE (public.*) PROD -> UAT dentro do
# container atlas-uat-sync (ACXEGDP-405).
#
# Regra: um "dia" de cópia começa em $SYNC_HORA (padrão 05:30, fuso $TZ). Se
# ainda não houve cópia bem-sucedida desde o início do dia, roda; falhou, tenta
# de novo a cada $SYNC_RETRY_MIN minutos até dar certo; deu certo, dorme até o
# próximo $SYNC_HORA. O sucesso fica gravado em $SYNC_ESTADO_DIR (volume), então
# reiniciar ou atualizar o container não repete a cópia do dia. No 1º deploy
# (volume vazio) a cópia roda na hora.
#
# Uso manual (console do container no Portainer):
#   /opt/atlas-sync/agendador.sh agora    roda uma cópia já (respeita a trava)
#   /opt/atlas-sync/agendador.sh status   mostra a última cópia bem-sucedida
#
# Duas cópias ao mesmo tempo travam o UAT (TRUNCATE x pg_restore): dentro do
# container a trava flock do script cuida disso; FORA dele não há trava — não
# deixe outro agendamento da cópia ligado (ex.: o cron antigo do notebook).
# =============================================================================
set -uo pipefail

HORA="${SYNC_HORA:-05:30}"
RETRY_MIN="${SYNC_RETRY_MIN:-60}"
TIMEOUT="${SYNC_TIMEOUT:-2h}"
ESTADO_DIR="${SYNC_ESTADO_DIR:-/estado}"
ESTADO="$ESTADO_DIR/ultimo-ok"
SCRIPT="${SYNC_SCRIPT:-/opt/atlas-sync/sync-omie-public-prod-to-uat.sh}"

log() { echo "[$(date '+%F %T %Z')] $*"; }

agora_s() { date +%s; }

# Início do dia de cópia corrente (epoch): hoje às $HORA, ou ontem se ainda não deu a hora.
inicio_do_dia() {
  local hoje
  hoje=$(date -d "today $HORA" +%s)
  if [ "$(agora_s)" -lt "$hoje" ]; then date -d "yesterday $HORA" +%s; else echo "$hoje"; fi
}

# Próximo $HORA (epoch).
proximo_inicio() {
  local hoje
  hoje=$(date -d "today $HORA" +%s)
  if [ "$(agora_s)" -lt "$hoje" ]; then echo "$hoje"; else date -d "tomorrow $HORA" +%s; fi
}

ultimo_ok() { if [ -f "$ESTADO" ]; then stat -c %Y "$ESTADO"; else echo 0; fi; }

rodar() {
  # Rodada que falha deixa o dump (~600 MB) em /tmp para diagnóstico: fica só o mais recente.
  # shellcheck disable=SC2012
  ls -dt /tmp/omie_public_dump_* 2>/dev/null | tail -n +2 | xargs -r rm -rf
  log "início da cópia PROD -> UAT"
  ASSUME_YES=1 timeout "$TIMEOUT" bash "$SCRIPT" </dev/null
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    touch "$ESTADO" || log "! não consegui gravar $ESTADO — a cópia pode se repetir no próximo reinício"
    log "fim da cópia (rc=0)"
  else
    log "fim da cópia (rc=$rc) — FALHOU"
  fi
  return "$rc"
}

case "${1:-}" in
  agora)
    rodar
    exit $?
    ;;
  status)
    if [ -f "$ESTADO" ]; then log "última cópia bem-sucedida: $(date -d "@$(ultimo_ok)" '+%F %T %Z')"; else log "nenhuma cópia bem-sucedida registrada"; fi
    exit 0
    ;;
  '') ;;
  *)
    echo "uso: $0 [agora|status]" >&2
    exit 2
    ;;
esac

# Laço do serviço. SIGTERM (docker stop / atualização da stack) encerra na hora,
# derrubando a cópia em andamento — o TRUNCATE só vale no commit, nada se perde.
trap 'log "encerrando (sinal recebido)"; kill $(jobs -p) 2>/dev/null; exit 143' TERM INT

mkdir -p "$ESTADO_DIR" 2>/dev/null
[ -w "$ESTADO_DIR" ] || log "! $ESTADO_DIR sem permissão de escrita — o sucesso não vai ficar registrado"
[ -n "${PROD_USER:-}" ] || { log "X PROD_USER não definido"; exit 1; }
[ -n "${PGPASSWORD_PROD:-}" ] || log "! PGPASSWORD_PROD vazio — o libpq vai procurar o ~/.pgpass"
[ -n "${PGPASSWORD_UAT:-}" ] || log "! PGPASSWORD_UAT vazio — o libpq vai procurar o ~/.pgpass"

log "agendador ativo: cópia diária às $HORA (${TZ:-UTC}), nova tentativa a cada $RETRY_MIN min até dar certo"
log "PROD ${PROD_USER}@${PROD_HOST:-db.manager01.q2p.com.br}:${PROD_PORT:-5432} -> UAT ${UAT_USER:-postgres}@${UAT_HOST:-db.manager01.q2p.com.br}:${UAT_PORT:-5437}"
"$0" status

while true; do
  if [ "$(ultimo_ok)" -lt "$(inicio_do_dia)" ]; then
    if rodar; then
      continue
    fi
    espera=$((RETRY_MIN * 60))
    log "nova tentativa em $RETRY_MIN min"
  else
    prox=$(proximo_inicio)
    espera=$((prox - $(agora_s)))
    log "próxima cópia em $(date -d "@$prox" '+%F %T %Z')"
  fi
  sleep "$espera" &
  wait $!
done
