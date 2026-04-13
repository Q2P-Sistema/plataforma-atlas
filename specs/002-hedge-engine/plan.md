# Implementation Plan: Hedge Engine

**Branch**: `002-hedge-engine` | **Date**: 2026-04-12 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/002-hedge-engine/spec.md`

## Summary

Migrar o motor de hedge cambial USD/BRL do legado Node.js/JavaScript para o Atlas monolito modular TypeScript. O modulo inclui: dashboard de posicao com 5 KPIs + graficos, motor de minima variancia com 3 camadas (L1/L2/L3), gestao de NDFs com ciclo de vida completo, integracao PTAX BCB, simulacao de margem por cenario, estoque por localidade, alertas automaticos e configuracao do motor. Backend como modulo em `modules/hedge/`, frontend como paginas React em `apps/web/src/pages/hedge/`, integracao BCB em `packages/integrations/bcb/`.

## Technical Context

**Language/Version**: TypeScript 5.5+ (strict mode) / Node.js 20 LTS
**Primary Dependencies**: Express 4 (API), React 18 + Vite (frontend), Drizzle ORM (queries), decimal.js (aritmetica financeira), recharts (graficos), Zod (validacao)
**Storage**: PostgreSQL 16, schema `hedge.*` (10 tabelas), Redis 8 (cache PTAX 15min)
**Testing**: Vitest + Supertest (backend), meta 90%+ nos services financeiros (motor, NDF, PTAX)
**Target Platform**: Docker Swarm (mesma infra Atlas)
**Project Type**: Modulo de dominio dentro de monolito modular web
**Performance Goals**: Dashboard < 2s, Motor MV recalc < 500ms, Simulacao 13 cenarios < 1s
**Constraints**: Calculo financeiro so em TS (Principio III), dados OMIE so do Postgres (Principio II), aritmetica decimal obrigatoria
**Scale/Scope**: ~5 usuarios simultaneos, ~12 buckets mensais, ~50-200 NDFs ativos, ~30 localidades de estoque

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Principio I — Monolito Modular com Fronteiras

- **PASS**: Hedge usa schema proprio `hedge.*`. Dados cruzados via view `shared.vw_hedge_posicao`. Modulo em `modules/hedge/` com `index.ts` publico. Fronteiras enforced por eslint-plugin-boundaries.

### Principio II — OMIE Le do Postgres

- **PASS**: Hedge le titulos a pagar de `public.tbl_*` (synced by n8n). Nenhuma chamada direta a API OMIE. Sync e responsabilidade do n8n.

### Principio III — Dinheiro So em TypeScript

- **PASS**: Motor MV, calculo de custo/resultado NDF, simulacao de margem — tudo em TypeScript com decimal.js. Nenhum calculo em n8n ou SQL.

### Principio IV — Audit Log Append-Only

- **PASS**: Tabelas criticas (ndf_registro, titulos_pagar, config_motor, alerta) terao triggers de audit log na migration. Tabelas de snapshot/log (append-only por natureza) nao precisam de trigger.

### Principio V — Validacao Paralela

- **PASS**: Hedge legado nunca rodou em producao. Nao ha sistema em paralelo a validar. A validacao sera contra dados reais pela primeira vez (PTAX real, titulos OMIE reais). Criterio: resultados de calculo revisados manualmente pelo gestor antes de confianca total.

## Project Structure

### Documentation (this feature)

```text
specs/002-hedge-engine/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── api.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code

```text
modules/hedge/
├── src/
│   ├── index.ts              # Public API do modulo
│   ├── services/
│   │   ├── motor.service.ts   # Motor MV (3 camadas, recomendacoes)
│   │   ├── ndf.service.ts     # CRUD + ciclo de vida NDFs
│   │   ├── posicao.service.ts # Calculo de posicao e buckets
│   │   ├── simulacao.service.ts # Simulacao de margem
│   │   ├── alerta.service.ts  # Geracao e gestao de alertas
│   │   └── config.service.ts  # Parametros do motor
│   ├── routes/
│   │   └── hedge.routes.ts    # Express router do modulo
│   └── __tests__/
│       ├── motor.test.ts
│       ├── ndf.test.ts
│       └── posicao.test.ts
├── package.json
└── tsconfig.json

packages/integrations/bcb/
├── src/
│   ├── index.ts
│   ├── ptax.service.ts        # Fetch + cache + validacao
│   └── __tests__/
│       └── ptax.test.ts
├── package.json
└── tsconfig.json

packages/db/
├── src/schemas/
│   └── hedge.ts               # Drizzle schema das 10 tabelas
└── migrations/
    └── 0002_hedge_engine.sql  # Schema + tabelas + triggers + view

apps/web/src/pages/hedge/
├── PositionDashboard.tsx
├── NDFListPage.tsx
├── MotorMVPage.tsx
├── MarginSimulationPage.tsx
├── InventoryPage.tsx
├── AlertsPage.tsx
└── ConfigPage.tsx
```

**Structure Decision**: Modulo de dominio em `modules/hedge/` seguindo pattern do monorepo Atlas. Integracao BCB em `packages/integrations/bcb/` porque sera compartilhada com outros modulos (Breaking Point, C-Level). Frontend em `apps/web/src/pages/hedge/` dentro do shell existente.
