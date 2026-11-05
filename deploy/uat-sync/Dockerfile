# Cópia diária do espelho OMIE (public.*) PROD -> UAT — ACXEGDP-405.
# Build a partir da raiz do repositório:
#   docker build -f deploy/uat-sync/Dockerfile -t plasticosq2p/atlas-uat-sync:dev .
#
# Só os clientes do PostgreSQL são usados (pg_dump/pg_restore/psql); o servidor
# da imagem nunca sobe. Mesma versão do PROD e do UAT (16.14, Debian bookworm):
# o pg_dump precisa ser >= a versão do servidor.
FROM postgres:16.14-bookworm

# python3: triagem de drift de schema do script; tzdata: fuso do agendamento.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 tzdata \
 && rm -rf /var/lib/apt/lists/*

ENV TZ=America/Sao_Paulo

# O script é o MESMO do repositório (nunca uma cópia editada no servidor —
# em 06/2026 uma cópia divergente apagava objetos do Atlas no UAT).
COPY --chmod=755 scripts/sync-omie-public-prod-to-uat.sh /opt/atlas-sync/sync-omie-public-prod-to-uat.sh
COPY --chmod=755 deploy/uat-sync/agendador.sh /opt/atlas-sync/agendador.sh

RUN mkdir -p /estado && chown postgres:postgres /estado
VOLUME ["/estado"]

USER postgres
WORKDIR /tmp
ENTRYPOINT ["/opt/atlas-sync/agendador.sh"]
