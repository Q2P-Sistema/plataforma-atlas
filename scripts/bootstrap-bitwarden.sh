#!/usr/bin/env bash
# =============================================================================
# bootstrap-bitwarden.sh
# Cria (ou atualiza) o item "Atlas Dev Secrets" no cofre Bitwarden com os
# secrets do .env local. Uso: rodar uma unica vez, apos preencher o .env.
#
# Pre-requisitos:
#   - bw (Bitwarden CLI) logado
#   - BW_SESSION exportado: export BW_SESSION=$(bw unlock --raw)
#   - jq
#   - .env no diretorio raiz do projeto, ja preenchido
#
# Depois deste script:
#   rm .env            # secrets estao no Bitwarden agora
#   cp .envrc.example .envrc
#   direnv allow
# =============================================================================

set -euo pipefail

ITEM_NAME="Atlas Dev Secrets"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

# ── Pre-checks ───────────────────────────────────────────────────────────────
[ -z "${BW_SESSION:-}" ] && {
  echo "❌ BW_SESSION nao setado."
  echo "   Rode primeiro: export BW_SESSION=\$(bw unlock --raw)"
  exit 1
}

[ ! -f "$ENV_FILE" ] && {
  echo "❌ $ENV_FILE nao encontrado."
  exit 1
}

command -v jq >/dev/null || { echo "❌ jq nao instalado"; exit 1; }
command -v bw >/dev/null || { echo "❌ bw nao instalado"; exit 1; }

# ── Extrai valores do .env ───────────────────────────────────────────────────
read_env() {
  grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//'
}

DATABASE_URL=$(read_env DATABASE_URL)
# extrai senha do formato postgresql://user:PASS@host:port/db
DATABASE_URL_PASSWORD=$(echo "$DATABASE_URL" | sed -nE 's|.*://[^:]+:([^@]+)@.*|\1|p')

SESSION_SECRET=$(read_env SESSION_SECRET)
ATLAS_INTEGRATION_KEY=$(read_env ATLAS_INTEGRATION_KEY)
OMIE_ACXE_KEY=$(read_env OMIE_ACXE_KEY)
OMIE_ACXE_SECRET=$(read_env OMIE_ACXE_SECRET)
OMIE_Q2P_KEY=$(read_env OMIE_Q2P_KEY)
OMIE_Q2P_SECRET=$(read_env OMIE_Q2P_SECRET)
SENDGRID_API_KEY=$(read_env SENDGRID_API_KEY)

# ── Valida extracao ──────────────────────────────────────────────────────────
missing=()
for var in DATABASE_URL_PASSWORD SESSION_SECRET ATLAS_INTEGRATION_KEY \
           OMIE_ACXE_KEY OMIE_ACXE_SECRET OMIE_Q2P_KEY OMIE_Q2P_SECRET \
           SENDGRID_API_KEY; do
  [ -z "${!var:-}" ] && missing+=("$var")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "❌ Variaveis faltando ou vazias no .env:"
  printf '   - %s\n' "${missing[@]}"
  exit 1
fi

# ── Monta o payload JSON ─────────────────────────────────────────────────────
# Tipo 1 = Hidden; tipo 2 (item) = Secure Note
FIELDS=$(jq -n \
  --arg dbp "$DATABASE_URL_PASSWORD" \
  --arg ss "$SESSION_SECRET" \
  --arg aik "$ATLAS_INTEGRATION_KEY" \
  --arg oak "$OMIE_ACXE_KEY" \
  --arg oas "$OMIE_ACXE_SECRET" \
  --arg oqk "$OMIE_Q2P_KEY" \
  --arg oqs "$OMIE_Q2P_SECRET" \
  --arg sg "$SENDGRID_API_KEY" \
  '[
    {name: "DATABASE_URL_PASSWORD", value: $dbp, type: 1},
    {name: "SESSION_SECRET",        value: $ss,  type: 1},
    {name: "ATLAS_INTEGRATION_KEY", value: $aik, type: 1},
    {name: "OMIE_ACXE_KEY",         value: $oak, type: 1},
    {name: "OMIE_ACXE_SECRET",      value: $oas, type: 1},
    {name: "OMIE_Q2P_KEY",          value: $oqk, type: 1},
    {name: "OMIE_Q2P_SECRET",       value: $oqs, type: 1},
    {name: "SENDGRID_API_KEY",      value: $sg,  type: 1}
  ]')

ITEM_JSON=$(jq -n \
  --arg name "$ITEM_NAME" \
  --argjson fields "$FIELDS" \
  '{
    type: 2,
    name: $name,
    notes: "Secrets do plataforma-atlas (gerado via scripts/bootstrap-bitwarden.sh).\n\nUsado pelo .envrc + direnv em dev local.\nRegerar? Apagar .env com os valores reais, rodar script de novo.",
    secureNote: { type: 0 },
    fields: $fields
  }')

# ── Cria ou atualiza ─────────────────────────────────────────────────────────
EXISTING_ID=$(bw list items --session "$BW_SESSION" 2>/dev/null \
  | jq -r --arg name "$ITEM_NAME" '.[] | select(.name == $name) | .id' \
  | head -1)

if [ -n "$EXISTING_ID" ]; then
  echo "⚠  Item \"$ITEM_NAME\" ja existe no cofre (id: $EXISTING_ID)."
  read -r -p "Substituir? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Cancelado."
    exit 0
  fi
  echo "$ITEM_JSON" | bw encode | bw edit item "$EXISTING_ID" --session "$BW_SESSION" >/dev/null
  echo "✓ Item \"$ITEM_NAME\" atualizado."
else
  echo "$ITEM_JSON" | bw encode | bw create item --session "$BW_SESSION" >/dev/null
  echo "✓ Item \"$ITEM_NAME\" criado no cofre."
fi

# ── Valida ───────────────────────────────────────────────────────────────────
NUM_FIELDS=$(bw get item "$ITEM_NAME" --session "$BW_SESSION" | jq '.fields | length')
echo "✓ Item tem $NUM_FIELDS custom fields cadastrados."

cat <<'EOF'

Proximos passos:
  1. Verifique no app do Bitwarden que o item "Atlas Dev Secrets" aparece
     com 8 campos.
  2. Apague o .env antigo (secrets estao no cofre agora):
        rm .env
  3. Ative o direnv:
        cp .envrc.example .envrc
        direnv allow
  4. Rotacione as chaves que passaram por esta conversa:
        - Sendgrid (gerar nova no dashboard)
        - OMIE keys (regerar nas duas empresas)
        - SESSION_SECRET e ATLAS_INTEGRATION_KEY (openssl rand -base64 24)
EOF
