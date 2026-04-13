# Implementation Plan: Forecast Planner

**Branch**: `003-forecast-planner` | **Date**: 2026-04-13 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/003-forecast-planner/spec.md`

## Summary

Planejador de compras de materia-prima (polimeros) com rolling forecast 120 dias, deteccao de ruptura, sugestao de quantidade MOQ, sazonalidade por familia, compra local emergencial e shopping list. Dados vem integralmente do BD PostgreSQL ja populado via n8n (OMIE). Motor de forecast roda server-side com testes Vitest. Frontend React com graficos recharts e tabelas DataTable.

## Technical Context

**Language/Version**: TypeScript 5.5+ (strict mode) / Node.js 20 LTS
**Primary Dependencies**: Express 4 (API), React 18 + Vite (frontend), Drizzle ORM (queries forecast schema), raw SQL via getPool() (leitura tabelas OMIE public.*), recharts (graficos), Zod (validacao)
**Storage**: PostgreSQL 16 — leitura de tabelas OMIE em public.*, escrita em schema forecast.* (config, sazonalidade)
**Testing**: Vitest (unit tests para motor de forecast, sazonalidade, MOQ)
**Target Platform**: Linux server (Docker) + browser
**Project Type**: Modulo do monolito Atlas (modules/forecast)
**Performance Goals**: Calculo de forecast para ~30 familias em < 2 segundos
**Constraints**: Dados OMIE refresh hourly via n8n — sem API OMIE direta (Principio II)
**Scale/Scope**: ~30 familias, ~500 SKUs, ~15k movimentacoes/ano, 1-3 usuarios simultaneos

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Monolito Modular | PASS | Modulo em modules/forecast/, schema forecast.*, views shared se necessario, index.ts como superficie |
| II. OMIE via Postgres | PASS | Todas as queries leem do BD (tbl_posicaoEstoque, tbl_pedidosCompras, tbl_movimentacaoEstoque). Zero chamadas API OMIE |
| III. Dinheiro em TS | PASS | Motor de forecast em TypeScript com testes Vitest. Calculo de valor, MOQ, cobertura tudo em TS |
| IV. Audit Log | PASS | Tabela sazonalidade_log para mudancas de config. Trigger de audit em forecast.config se necessario |
| V. Validacao Paralela | N/A | Forecast Planner e greenfield — nao substitui legado em producao. Planilha Excel serve como referencia de validacao, nao como sistema paralelo |

## Project Structure

### Documentation (this feature)

```text
specs/003-forecast-planner/
├── plan.md              # This file
├── research.md          # Phase 0 — data source decisions
├── data-model.md        # Phase 1 — entities and mappings
├── quickstart.md        # Phase 1 — validation scenarios
├── contracts/
│   └── api.md           # Phase 1 — API endpoints
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 — task breakdown (via /speckit.tasks)
```

### Source Code (repository root)

```text
modules/forecast/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                    # Exports forecastRouter
    ├── routes/
    │   └── forecast.routes.ts      # Express router — all /api/v1/forecast/* endpoints
    ├── services/
    │   ├── familia.service.ts      # Reads families + stock + vendas12m from BD
    │   ├── forecast.service.ts     # 120-day rolling simulation engine
    │   ├── pedidos.service.ts      # Reads purchase orders pipeline from Acxe
    │   ├── sazonalidade.service.ts # CRUD sazonalidade + log
    │   └── config.service.ts       # Forecast config params
    └── __tests__/
        ├── forecast.test.ts        # Engine: ruptura, cobertura, MOQ
        ├── sazonalidade.test.ts    # Factor application, edge cases
        └── familia.test.ts         # Stock aggregation, intl/nacional

apps/web/src/pages/forecast/
├── ForecastDashboard.tsx           # US1+US5 — family table + urgent panel
├── RollingForecastPage.tsx         # US2 — 120-day chart + SKU grid
├── ShoppingListPage.tsx            # US7 — editable purchase list
└── ForecastConfigPage.tsx          # US6 — sazonalidade + params

packages/db/
├── src/schemas/forecast.ts         # Drizzle schema: config_sazonalidade, config_forecast, sazonalidade_log
└── migrations/
    └── 0004_forecast_planner.sql   # Schema + tables + seeds + audit triggers
```

**Structure Decision**: Same pattern as hedge module — backend in modules/forecast, frontend pages in apps/web/src/pages/forecast, schema in packages/db. Raw SQL via getPool() for OMIE tables, Drizzle for forecast.* tables.

## Phases

### Phase 0: Research (completed)

See [research.md](research.md) — 8 decisions documented covering data sources, product mapping, engine placement, seasonality storage, and validation approach.

### Phase 1: Design (completed)

See:
- [data-model.md](data-model.md) — 5 source tables + 3 forecast tables + computed structures
- [contracts/api.md](contracts/api.md) — 7 endpoints (GET familias, POST calcular, GET urgentes, GET/PATCH sazonalidade, GET/PATCH config)
- [quickstart.md](quickstart.md) — 5 validation scenarios + spreadsheet comparison guide

### Phase 2: Tasks

To be generated via `/speckit.tasks`.

## Constitution Re-Check (post Phase 1)

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Monolito Modular | PASS | modules/forecast/ with index.ts surface. Schema forecast.*. No cross-module imports |
| II. OMIE via Postgres | PASS | All 5 source tables are public.* read via getPool(). No OMIE API |
| III. Dinheiro em TS | PASS | forecast.service.ts handles all financial calcs. Tests planned for MOQ, ruptura, cobertura |
| IV. Audit Log | PASS | sazonalidade_log table + forecast.config audit trigger in migration |
| V. Validacao Paralela | N/A | Greenfield. Spreadsheet validation per quickstart.md |

All gates pass. Ready for `/speckit.tasks`.
