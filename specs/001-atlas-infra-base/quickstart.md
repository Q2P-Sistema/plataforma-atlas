# Quickstart: Atlas Infraestrutura Base

**Feature**: 001-atlas-infra-base
**Date**: 2026-04-12

## Pré-requisitos

- Docker e Docker Compose instalados
- Node.js 20 LTS (via nvm, `.nvmrc` no repo)
- pnpm 10+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- Git

## Setup Local (5 passos)

### 1. Clonar e instalar dependências

```bash
git clone git@github.com:<org>/plataforma-atlas.git
cd plataforma-atlas
pnpm install
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Editar `.env` com:
- `DATABASE_URL` — Postgres local (o docker-compose sobe um pra você)
- `REDIS_URL` — Redis local (idem)
- `SEED_ADMIN_EMAIL` — e-mail do primeiro admin
- `SEED_ADMIN_PASSWORD` — senha do primeiro admin
- `SESSION_SECRET` — string aleatória pra assinar cookies
- `N8N_HEALTH_URL` — URL do health check do n8n (se estiver rodando; opcional em dev)

### 3. Subir serviços locais

```bash
docker compose up -d
```

Sobe: Postgres 16 (porta 5432), Redis 8 (porta 6379).

### 4. Rodar migrations e seed

```bash
pnpm --filter @atlas/db migrate
```

Cria schemas `atlas` e `shared`, tabelas `users`, `sessions`, `audit_log`, triggers, e faz seed do admin inicial.

### 5. Iniciar em modo desenvolvimento

```bash
pnpm dev
```

Turbo sobe `apps/api` (porta 3005) e `apps/web` (porta 5173) com hot-reload.

## Verificação

1. Abrir `http://localhost:5173` → tela de login
2. Fazer login com `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
3. Ver sidebar com 7 módulos (todos desabilitados por default)
4. Acessar `http://localhost:3005/api/v1/health` → status healthy

## Comandos úteis

| Comando | O que faz |
|---------|-----------|
| `pnpm dev` | Sobe api + web em modo dev com hot-reload |
| `pnpm build` | Build de produção de todos os workspaces |
| `pnpm lint` | Lint (ESLint + boundaries) |
| `pnpm typecheck` | Verificação de tipos TS |
| `pnpm test` | Roda Vitest em todos os workspaces |
| `pnpm --filter @atlas/db migrate` | Aplica migrations pendentes |
| `pnpm --filter @atlas/db generate` | Gera migration a partir de diff no schema Drizzle |
| `docker compose up -d` | Sobe Postgres + Redis locais |
| `docker compose down` | Para serviços locais |

## Deploy em Staging

Staging roda no mesmo Swarm que producao, isolado por:
- Stack separada (`atlas-staging` vs `atlas`)
- Banco de dados separado (`STAGING_DATABASE_URL`)
- Redis separado ou prefixado (`STAGING_REDIS_URL`)
- Dominio separado via Traefik (`STAGING_DOMAIN`)
- Network interna propria (`staging_internal`)

### Variaveis de ambiente

Criar um `.env.staging` no manager-01 com:
- `STAGING_DATABASE_URL` — Postgres staging (banco `atlas_staging`)
- `STAGING_REDIS_URL` — Redis staging
- `STAGING_SESSION_SECRET` — secret diferente do prod
- `STAGING_SEED_ADMIN_EMAIL` / `STAGING_SEED_ADMIN_PASSWORD`
- `STAGING_DOMAIN` — ex: `staging.acxe.com.br`
- `DOCKER_HUB_USER`

### Deploy manual

```bash
# Build e push de imagens com tag :staging
docker build -t <dockerhub-user>/atlas-api:staging -f apps/api/Dockerfile .
docker build -t <dockerhub-user>/atlas-web:staging -f apps/web/Dockerfile .
docker push <dockerhub-user>/atlas-api:staging
docker push <dockerhub-user>/atlas-web:staging

# Deploy no Swarm (via SSH ou Portainer)
cd deploy
docker stack deploy -c atlas-staging.stack.yml --with-registry-auth atlas-staging
```

### Verificar

```bash
docker stack services atlas-staging
curl -s https://staging.acxe.com.br/api/v1/health | jq .data.status
```

## Deploy em Produção

Automático via GitHub Actions no merge em `main`. Pipeline:
1. Lint + typecheck + test
2. Build imagens Docker
3. Push pra Docker Hub
4. Portainer/Swarm atualiza a stack `atlas`

### Rollback

Se o deploy apresentar problemas, o rollback e imediato via Swarm:

```bash
# Reverter API para a versao anterior
docker service update --rollback atlas_api

# Reverter Web para a versao anterior
docker service update --rollback atlas_web
```

O rollback do Docker Swarm e instantaneo (reverte para a task anterior).
O stack.yml configura `failure_action: rollback` no update_config, entao se o healthcheck falhar durante o deploy, o Swarm reverte automaticamente.

Para verificar o status apos rollback:
```bash
docker service ps atlas_api --no-trunc
docker service ps atlas_web --no-trunc
```
