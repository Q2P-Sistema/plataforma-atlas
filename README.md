# Atlas — Plataforma ACXE+Q2P

Monólito modular que consolida 7 módulos internos de operação sobre um único banco Postgres compartilhado. Escrito em TypeScript, organizado como monorepo pnpm + Turborepo, deployado via Docker Swarm + Traefik.

> **Status:** Infraestrutura base completa (spec 001). Auth, 2FA, admin CRUD, audit log, feature flags, CI/CD, deploy. Pronto para migrar modulos de dominio.

## Stack

| Camada | Ferramenta |
|---|---|
| Linguagem | TypeScript (strict) |
| Runtime | Node 20 |
| Monorepo | pnpm workspaces + Turborepo |
| Backend | Express |
| Query builder / migrations | Drizzle + Drizzle Kit |
| Frontend | React 18 + Vite |
| Design system | shadcn/ui + Tailwind CSS |
| Estado cliente | Zustand + TanStack Query |
| Banco | PostgreSQL 16 com pgvector |
| Cache / rate limit | Redis 8 |
| Logs | Pino → Loki → Grafana (self-hosted) |
| Testes | Vitest + Supertest |
| Reverse proxy | Traefik |
| Orquestração prod/staging | Docker Swarm via Portainer |
| Orquestração dev | docker-compose |
| Infra base | DigitalOcean (1 VPS manager + 1 VPS database) |
| Bus cross-módulo interno | Postgres LISTEN/NOTIFY |
| Hub de orquestração / ETL / LLM | n8n (mesma infra) |
| Storage de arquivos | Backblaze B2 (S3-compatible) |
| E-mail transacional | Sendgrid API |
| CI/CD | GitHub Actions → Docker Hub → Portainer |

## Estrutura

```
atlas/
├── packages/               # Reutilizável, sem estado, sem regra de domínio
│   ├── core/               # db pool, logger, config
│   ├── auth/               # JWT + roles (operador/gestor/diretor)
│   ├── ui/                 # Design system React compartilhado
│   ├── db/                 # Migrations centralizadas + contratos de views `shared`
│   └── integrations/
│       ├── omie/           # Cliente OMIE único (polling incremental por dDtAlt)
│       └── bcb/            # Cliente BCB (PTAX)
│
├── modules/                # Domínio — cada módulo expõe serviços via index.ts público
│   ├── hedge/              # Motor hedge USD/BRL, buckets, NDFs, mark-to-market
│   ├── stockbridge/        # Estoque físico, lotes, dual-CNPJ, fase pescado (porte do legado PHP)
│   ├── breakingpoint/      # Projeção de liquidez BRL 26 semanas, FINIMP
│   ├── clevel/             # Dashboard C-Level (DRE, FX sensitivity, intercompany)
│   ├── comexinsight/       # Rastreador marítimo, 14 fases
│   ├── comexflow/          # Gestão ciclo de vida de importações, Kanban 14 fases
│   └── forecast/           # Forecast Planner (pedidos, lead times, sazonalidade)
│
├── apps/                   # O que sobe em produção
│   ├── api/                # API única — importa módulos habilitados via feature flag
│   └── web/                # Shell React único — rotas por módulo, identidade visual unificada
│
├── integrations/
│   └── crm/                # Cliente HTTP do CRM Q2P externo (empresa contratada)
│
└── docs/
    └── adr/                # Architecture Decision Records
```

**Distinção importante:**

- `packages/` = reutilizável, sem estado, sem regra de negócio.
- `modules/` = domínio, com regras, expõe serviços via `index.ts`.
- `apps/` = o que sobe em produção, importa de `modules/` e `packages/`.
- `integrations/` = clientes de sistemas externos que não são nossos.

## Regras de fronteira

- Módulos só se importam via `index.ts` público. Proibido importar de `modules/X/src/internal/*` a partir de outro módulo.
- Enforcement via `eslint-plugin-boundaries` (configurado em [eslint.config.js](eslint.config.js)).
- Módulos compartilham dados do banco **apenas via views** no schema `shared`. Tabelas privadas de cada módulo ficam em schema próprio (`hedge`, `stockbridge`, etc.). Nunca ler tabelas cruas de outro módulo.
- Migrations centralizadas em `packages/db/migrations/` — sem inferno de ordem entre módulos.

## Constituição técnica e decisões arquiteturais

A **constituição técnica** do Atlas está em [TECH_STACK.md](TECH_STACK.md) — documento único que consolida todas as decisões de arquitetura, banco, segurança, deploy, infra, IA e cultura. É lei em uso, emendável mas não ignorável.

Decisões maiores detalhadas em **Architecture Decision Records** em [docs/adr/](docs/adr/):

- [ADR-0001](docs/adr/0001-monolito-modular.md) — Monólito modular em monorepo
- [ADR-0002](docs/adr/0002-postgres-views-compartilhadas.md) — Postgres compartilhado via views no schema `shared`
- [ADR-0003](docs/adr/0003-crm-externo.md) — CRM Q2P como integração HTTP externa
- [ADR-0004](docs/adr/0004-listen-notify-bus.md) — Eventos cross-módulo via Postgres LISTEN/NOTIFY
- [ADR-0005](docs/adr/0005-deploy-opcao-a-single-app.md) — Deploy "Opção A" — `apps/api` único com módulos habilitados por feature flag
- [ADR-0006](docs/adr/0006-n8n-como-hub-de-orquestracao.md) — n8n como hub de orquestração, ETL e gateway de LLM
- [ADR-0007](docs/adr/0007-omie-le-do-bd.md) — Atlas lê OMIE do Postgres, API só em exceção

## Ordem de migração dos módulos

1. **Hedge** — mais avançado em desenvolvimento (backend Node.js + frontend + `migration_001.sql`). Serve de cobaia pras fronteiras. Não está em produção, só dev mock-validado.
2. **StockBridge** — único ativo validado em produção (PHP puro em Apache há 2+ anos). Porte PHP → TS, revalidação em paralelo.
3. Breaking Point
4. ComexInsight
5. ComexFlow
6. Forecast
7. C-Level (por último — depende dos outros estarem estáveis)

## Regras imutáveis do ecossistema

1. **ERP OMIE é fonte de verdade** para NFs e contas. Nada é setado manualmente.
2. **Sync OMIE → Postgres é feito pelo n8n** (já em produção). Atlas lê do banco, não da API. API OMIE só é chamada pelo Atlas em exceções: dado fresquíssimo + pequeno, ou escrita (StockBridge emitindo NF entrada). Ver [ADR-0007](docs/adr/0007-omie-le-do-bd.md).
3. **Sync OMIE incremental por `dDtAlt`**. Full-refresh proibido em produção.
4. **Audit log append-only via triggers PL/pgSQL** em `shared.audit_log`. Nenhum `UPDATE`/`DELETE` na tabela de auditoria, nenhum caminho de escrita contorna o trigger.
5. **Fallback gracioso só para integrações externas** (OMIE, BCB, CRM, Backblaze, Sendgrid, LLM via n8n). Entre módulos internos, não existe.
6. **Queries de leitura sempre vão no Postgres, nunca na API OMIE.**
7. **Cálculo financeiro sempre em TypeScript, nunca em n8n.** Ver [ADR-0006](docs/adr/0006-n8n-como-hub-de-orquestracao.md).
8. **Identidade visual unificada** em todos os módulos — paleta quente areia, DM Sans + Fraunces. Dark mode como opção do usuário (toggle, default segue SO).

## Quickstart

```bash
git clone git@github.com:<org>/plataforma-atlas.git && cd plataforma-atlas
cp .env.example .env        # editar DATABASE_URL, REDIS_URL, SESSION_SECRET, SEED_ADMIN_*
docker compose -f deploy/docker-compose.yml up -d   # Postgres + Redis
pnpm install
pnpm dev                    # API :3005 + Web :5173
```

Detalhes completos em [specs/001-atlas-infra-base/quickstart.md](specs/001-atlas-infra-base/quickstart.md).

## Specs

| Spec | Status | Descricao |
|------|--------|-----------|
| [001-atlas-infra-base](specs/001-atlas-infra-base/) | Completa | Auth, 2FA, admin CRUD, audit log, feature flags, CI/CD, deploy, staging |
