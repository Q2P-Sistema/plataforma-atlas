# Tasks: Forecast Planner

**Input**: Design documents from `/specs/003-forecast-planner/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md

## Phase 1: Setup

**Purpose**: Module scaffold, dependencies, DB migration

- [ ] T001 Create module structure: modules/forecast/package.json, tsconfig.json, src/index.ts
- [ ] T002 [P] Add forecast dependencies to modules/forecast/package.json (drizzle-orm, decimal.js, zod, express, @atlas/core, @atlas/db, @atlas/auth)
- [ ] T003 [P] Create Drizzle schema in packages/db/src/schemas/forecast.ts (config_sazonalidade, config_forecast, sazonalidade_log tables)
- [ ] T004 [P] Export forecast schema types from packages/db/src/index.ts
- [ ] T005 Create migration packages/db/migrations/0004_forecast_planner.sql (schema forecast, 3 tables, seeds sazonalidade defaults, config seeds, audit triggers)
- [ ] T006 Register forecast module in apps/api/src/modules.ts (MODULE_FORECAST_ENABLED flag, forecastRouter mount)

---

## Phase 2: Foundational — Data Layer

**Purpose**: Services that read OMIE tables and provide data to all user stories

- [ ] T007 Create familia.service.ts in modules/forecast/src/services/ — reads tbl_produtos_Q2P + tbl_posicaoEstoque_Q2P, aggregates by descricao_familia, returns families with 3-layer stock, CMC, marca
- [ ] T008 [P] Create pedidos.service.ts in modules/forecast/src/services/ — reads tbl_pedidosCompras_ACXE joined to tbl_produtos_ACXE, maps to Q2P products via descricao match, returns pending arrivals with dates
- [ ] T009 [P] Create vendas.service.ts in modules/forecast/src/services/ — reads tbl_movimentacaoEstoqueHistorico_Q2P, filters des_origem='Venda de Produto', aggregates ABS(qtde) by id_prod for last 365 days
- [ ] T010 Create config.service.ts in modules/forecast/src/services/ — CRUD for forecast.config_forecast table (same pattern as hedge config.service)
- [ ] T011 [P] Create sazonalidade.service.ts in modules/forecast/src/services/ — read/write forecast.config_sazonalidade, log changes to forecast.sazonalidade_log, return effective factors

**Checkpoint**: Data layer complete — all source data accessible via typed service functions

---

## Phase 3: User Story 1 — Estoque por Familia (Priority: P1)

**Goal**: Comprador ve tabela de familias com estoque 3 camadas, CMC, cobertura

**Independent Test**: Access /api/v1/forecast/familias, see ~30 real families with stock data from BD

- [ ] T012 [US1] Implement GET /api/v1/forecast/familias route in modules/forecast/src/routes/forecast.routes.ts — calls familia.service + vendas.service, calculates cobertura_dias per family
- [ ] T013 [US1] Create ForecastDashboard.tsx in apps/web/src/pages/forecast/ — table of families with columns: Familia, Disponivel, Reservado, Transito, Total, CMC, Venda/dia, Cobertura, Status
- [ ] T014 [US1] Add expandable row in ForecastDashboard.tsx — click family shows SKU grid with individual stock, CMC, contribuicao %
- [ ] T015 [US1] Add empresa filter (ACXE/Q2P/Todas) and status filter (critico/atencao/ok) to ForecastDashboard.tsx
- [ ] T016 [US1] Register forecast pages in apps/web/src/App.tsx — add sidebar module with sub-items (Dashboard, Forecast 120d, Shopping List, Config)
- [ ] T017 [P] [US1] Write test familia.test.ts in modules/forecast/src/__tests__/ — stock aggregation by family, intl/nacional detection via marca, cobertura_dias calculation

**Checkpoint**: US1 functional — families table with real BD data, expandable SKUs

---

## Phase 4: User Story 2 — Rolling Forecast 120d (Priority: P1)

**Goal**: Projecao dia-a-dia com grafico de zonas, deteccao de ruptura, dia ideal de pedido

**Independent Test**: POST /api/v1/forecast/calcular, see 120-day serie with ruptura detected

- [ ] T018 [US2] Create forecast.service.ts in modules/forecast/src/services/ — buildForecastFamilia() function: 120-day loop with estoque(d) = estoque(d-1) + chegadas(d) - demanda_sazonalizada(d), detects ruptura and dia_pedido_ideal
- [ ] T019 [US2] Implement sazonalidade application in forecast.service.ts — getSazFactor(familia_id, mes) reads from config_sazonalidade, applies to daily demand
- [ ] T020 [US2] Implement arrival injection in forecast.service.ts — integrates pedidos.service arrivals (ddtprevisao) into 120-day series as positive stock events
- [ ] T021 [US2] Implement POST /api/v1/forecast/calcular route in forecast.routes.ts — accepts optional familia_id, variacao_anual_pct, buffer_dias; returns FamiliaForecast[]
- [ ] T022 [US2] Create RollingForecastPage.tsx in apps/web/src/pages/forecast/ — family selector, 120-day area chart with colored zones (ok=green, atencao=yellow, critico=red, ruptura=red-bg), arrival lines, order deadline marker
- [ ] T023 [US2] Add SKU breakdown grid below chart in RollingForecastPage.tsx — codigo, descricao, disponivel, transito, demanda/dia, cobertura, LT
- [ ] T024 [US2] Add pedidos em rota section below SKU grid — shows pending purchase orders with countdown to arrival
- [ ] T025 [P] [US2] Write test forecast.test.ts in modules/forecast/src/__tests__/ — ruptura detection, dia_pedido_ideal calculation, sazonalidade application, arrival injection, edge cases (zero demand, zero stock)

**Checkpoint**: US2 functional — 120-day forecast with chart, ruptura detection, arrivals modeled

---

## Phase 5: User Story 3 — Sugestao MOQ (Priority: P2)

**Goal**: Quantidade sugerida arredondada por MOQ, descontando pipeline

**Independent Test**: See Qtd Sugerida column in forecast table, verify MOQ rounding

- [ ] T026 [US3] Add MOQ calculation to forecast.service.ts — qtdBruta = SUM(demanda_sazonalizada) for LT+60 days, qtdLiquida = max(0, bruta - em_rota), qtdSugerida = arredMOQ(liquida, moq)
- [ ] T027 [US3] Add valor_brl estimation to forecast.service.ts — qtdSugerida * preco_ultimo_pedido or fallback CMC
- [ ] T028 [US3] Add Qtd Sugerida, Valor BRL, MOQ columns to ForecastDashboard.tsx family table
- [ ] T029 [P] [US3] Write test for MOQ rounding in forecast.test.ts — 25t intl, 12t nacional, edge case MOQ > necessidade

**Checkpoint**: US3 functional — purchase suggestions with MOQ and pipeline deduction

---

## Phase 6: User Story 4 — Compra Local Emergencial (Priority: P2)

**Goal**: Detecta prazo perdido, calcula compra local com custo de oportunidade

**Independent Test**: Family with prazo perdido shows emergency local purchase card

- [ ] T030 [US4] Add compra local logic to forecast.service.ts — triggered when diaPedidoIdeal < 0, calculates diaAbrirLocal, gapDias, custoOportunidade, qtdLocal (MOQ 12t), valorLocal
- [ ] T031 [US4] Add CompraLocalCard component in RollingForecastPage.tsx — shows emergency purchase details when prazo_perdido=true
- [ ] T032 [P] [US4] Write test for compra local in forecast.test.ts — trigger condition, gap calculation, MOQ 12t

**Checkpoint**: US4 functional — emergency local purchase detected and displayed

---

## Phase 7: User Story 5 — Painel Urgentes 15 Dias (Priority: P2)

**Goal**: Dashboard filtrado com familias que precisam de acao em 15 dias

**Independent Test**: GET /api/v1/forecast/urgentes returns only families with diaPedidoIdeal <= 15

- [ ] T033 [US5] Implement GET /api/v1/forecast/urgentes route in forecast.routes.ts — filters and sorts by urgency
- [ ] T034 [US5] Add "Compras 15 Dias" tab/section in ForecastDashboard.tsx — urgent-only view with status badges and action indicators (Compra Intl / Compra Local / OK)
- [ ] T035 [US5] Add KPI summary cards at top of ForecastDashboard.tsx — Estoque Total, Proxima Ruptura, Familias Criticas, Valor a Comprar

**Checkpoint**: US5 functional — urgent panel shows only actionable families

---

## Phase 8: User Story 6 — Sazonalidade Config (Priority: P3)

**Goal**: Comprador ajusta indices de sazonalidade por familia/mes

**Independent Test**: Change sazonalidade factor, verify forecast recalculates

- [ ] T036 [US6] Implement GET /api/v1/forecast/sazonalidade route in forecast.routes.ts
- [ ] T037 [US6] Implement PATCH /api/v1/forecast/sazonalidade route in forecast.routes.ts — validates fator 0.1-3.0, logs change
- [ ] T038 [US6] Create ForecastConfigPage.tsx in apps/web/src/pages/forecast/ — sazonalidade table (12 months x families), editable factors, sugerido vs usuario, log display
- [ ] T039 [US6] Add general config section to ForecastConfigPage.tsx — variacao_anual, buffer_dias, lead_time_local, MOQ params
- [ ] T040 [P] [US6] Write test sazonalidade.test.ts in modules/forecast/src/__tests__/ — factor application, COALESCE logic, range validation, log creation

**Checkpoint**: US6 functional — sazonalidade editable with audit log

---

## Phase 9: User Story 7 — Shopping List (Priority: P3)

**Goal**: Lista de compras editavel, copiavel para executor

**Independent Test**: Generate list from forecast, edit quantity, copy to clipboard

- [ ] T041 [US7] Create ShoppingListPage.tsx in apps/web/src/pages/forecast/ — table generated from forecast results, columns: checkbox, Familia, Qtd (editable, MOQ-enforced), Comprar em, Chega em, LT, Ruptura, Estoque+Rota, Valor, Obs
- [ ] T042 [US7] Add "Copiar para Executor" button in ShoppingListPage.tsx — formats selected items as text for clipboard
- [ ] T043 [US7] Add quantity edit with MOQ enforcement in ShoppingListPage.tsx — up/down by MOQ step, recalculate valor on change

**Checkpoint**: US7 functional — shopping list editable and copyable

---

## Phase 10: Polish & Cross-Cutting

**Purpose**: Integration, refinement, validation

- [ ] T044 [P] Verify sidebar sub-items registered in T016 render correctly with lucide-react icons
- [ ] T045 Run quickstart.md validation scenarios — verify all 5 scenarios pass
- [ ] T046 Compare forecast results with planilha "Planejador de Compras - Rev Latest.xlsm" for 3 critical families
- [ ] T047 [P] Verify TypeScript build passes: pnpm --filter @atlas/forecast build && pnpm --filter @atlas/web build

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Data Layer)**: Depends on Phase 1 (schema + module registration)
- **Phase 3 (US1)**: Depends on Phase 2 (familia.service, vendas.service)
- **Phase 4 (US2)**: Depends on Phase 2 + Phase 3 (needs familia data + UI shell)
- **Phase 5 (US3)**: Depends on Phase 4 (needs forecast engine)
- **Phase 6 (US4)**: Depends on Phase 4 (needs forecast engine)
- **Phase 7 (US5)**: Depends on Phase 4 (needs forecast results)
- **Phase 8 (US6)**: Depends on Phase 2 (sazonalidade.service) — can run parallel to US3-5
- **Phase 9 (US7)**: Depends on Phase 4 (needs forecast results)
- **Phase 10 (Polish)**: After desired stories complete

### User Story Dependencies

- **US1 (P1)**: Depends on data layer only — first to implement
- **US2 (P1)**: Depends on US1 (family data) — second to implement
- **US3 (P2)**: Depends on US2 (forecast engine) — extends it with MOQ
- **US4 (P2)**: Depends on US2 (forecast engine) — extends it with emergency logic
- **US5 (P2)**: Depends on US2 (forecast results) — filters existing data
- **US6 (P3)**: Independent of US3-5 — can run in parallel after Phase 2
- **US7 (P3)**: Depends on US2 (forecast results) — presentation layer

### Parallel Opportunities

Within Phase 2: T008, T009, T011 can run in parallel (different files, different tables)
Within Phase 3: T016, T017 can run in parallel
US3+US4+US5 can run in parallel after US2 completes
US6 can run in parallel with US3-5

---

## Implementation Strategy

### MVP (US1 + US2)

1. Phase 1: Setup (T001-T006)
2. Phase 2: Data Layer (T007-T011)
3. Phase 3: US1 — Families table (T012-T017)
4. Phase 4: US2 — Forecast engine + chart (T018-T025)
5. **VALIDATE**: Compare with spreadsheet

### Full Delivery

6. Phase 5-7: US3+US4+US5 in parallel (T026-T035)
7. Phase 8: US6 — Sazonalidade config (T036-T040)
8. Phase 9: US7 — Shopping list (T041-T043)
9. Phase 10: Polish (T044-T047)

---

## Summary

- **Total tasks**: 47
- **US1 (Families)**: 6 tasks
- **US2 (Forecast 120d)**: 8 tasks
- **US3 (MOQ)**: 4 tasks
- **US4 (Compra Local)**: 3 tasks
- **US5 (Urgentes)**: 3 tasks
- **US6 (Sazonalidade)**: 5 tasks
- **US7 (Shopping List)**: 3 tasks
- **Setup + Foundation + Polish**: 15 tasks
- **Parallel opportunities**: 15 tasks marked [P]
- **MVP scope**: US1+US2 = 25 tasks
