# Tasks: Hedge Gaps Closure

**Input**: Design documents from `/specs/004-hedge-gaps-closure/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md, quickstart.md

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)

---

## Phase 1: Setup

**Purpose**: Migration de seeds e infraestrutura de cache

- [ ] T001 Create migration `packages/db/migrations/0005_hedge_gaps.sql` with INSERT seeds for 5 new config_motor parameters (desvio_padrao_brl=3.76, custo_financiamento_pct=5.5, prazo_recebimento=38, transit_medio_dias=80, giro_estoque_dias=30)
- [ ] T002 [P] Create `modules/hedge/src/services/cache.service.ts` with generic `cached<T>(key, ttl, fetchFn)` wrapper using `getRedis()` from @atlas/core, plus `invalidate(pattern)` for cache busting and graceful fallback when Redis is unavailable

---

## Phase 2: Foundational

**Purpose**: Nenhuma tarefa foundational bloqueante — o modulo hedge ja existe e esta funcional. As user stories sao independentes.

**Checkpoint**: Setup completo — user stories podem comecar.

---

## Phase 3: User Story 1 — Exposicao precisa por bucket (Priority: P1)

**Goal**: Incluir `est_nao_pago_usd` distribuido proporcionalmente na exposicao de cada bucket.

**Independent Test**: Comparar exposicao por bucket com e sem est_nao_pago. Soma das parcelas deve igualar o total do resumo VPS.

### Implementation

- [ ] T003 [US1] In `modules/hedge/src/services/posicao.service.ts`, modify `calcularPosicao()` to distribute `resumo.est_nao_pago_usd` proportionally across buckets based on each bucket's `pagarUsd / totalPagarUsd` ratio. Add `est_nao_pago_usd` and `exposicao_usd` fields to each bucket in the response.
- [ ] T004 [US1] In `modules/hedge/src/routes/hedge.routes.ts`, update the `GET /posicao` response mapping to include `est_nao_pago_usd` and `exposicao_usd` per bucket, and add `est_nao_pago_usd` to the KPIs object.
- [ ] T005 [US1] In `modules/hedge/src/services/motor.service.ts`, update `calcularMotor()` to use `exposicao_usd` (pagar + est_nao_pago) instead of just `pagarUsd` when calculating gap and coverage per bucket.
- [ ] T006 [P] [US1] Write test in `modules/hedge/src/__tests__/posicao.test.ts` verifying proportional distribution of est_nao_pago_usd: given 3 buckets with pagar_usd [500K, 300K, 200K] and est_nao_pago_usd=100K, verify parcels are [50K, 30K, 20K] and sum=100K. Also test edge case: est_nao_pago_usd=0 means no change.
- [ ] T007 [US1] In `apps/web/src/pages/hedge/PositionDashboard.tsx`, add `Est. Nao Pago` column to the bucket table showing the per-bucket value, and update the KPI card for Exposure to reflect the total including est_nao_pago.

**Checkpoint**: Dashboard mostra exposicao corrigida. Motor usa exposicao total. Testes passam.

---

## Phase 4: User Story 2 — Dashboard responsivo com cache (Priority: P2)

**Goal**: Cache Redis para posicao, estoque e localidades com invalidacao em mutacoes.

**Independent Test**: Segundo acesso ao dashboard retorna em <500ms com header X-Cache: HIT. Criar NDF invalida o cache.

### Implementation

- [ ] T008 [US2] In `modules/hedge/src/routes/hedge.routes.ts`, wrap `GET /posicao` handler with `cached('atlas:hedge:posicao:{empresa}', 300, fetchFn)` from cache.service. Set `X-Cache` response header (HIT/MISS). Ensure `recalcularBuckets()` + `gerarAlertas()` only run on cache MISS.
- [ ] T009 [P] [US2] In `modules/hedge/src/routes/hedge.routes.ts`, wrap `GET /estoque` handler with `cached('atlas:hedge:estoque:{empresa}', 3600, fetchFn)` and `GET /estoque/localidades` with `cached('atlas:hedge:localidades', 3600, fetchFn)`. Set `X-Cache` header.
- [ ] T010 [US2] In `modules/hedge/src/routes/hedge.routes.ts`, add `invalidate('atlas:hedge:posicao:*')` calls after successful NDF create/ativar/liquidar/cancelar and after `PUT /estoque/localidades`. Add `invalidate('atlas:hedge:localidades')` after `PUT /estoque/localidades`.
- [ ] T011 [P] [US2] Write test in `modules/hedge/src/__tests__/cache.test.ts` verifying: (1) `cached()` returns fetchFn result on first call, (2) returns cached result on second call, (3) falls back to fetchFn when Redis unavailable, (4) `invalidate()` causes next call to re-fetch.

**Checkpoint**: Dashboard loads fast on repeat visits. Cache invalidated on mutations. Fallback works without Redis.

---

## Phase 5: User Story 3 — Parametros operacionais completos (Priority: P3)

**Goal**: Todos os parametros exibidos na Config Page tem seeds e sao persistidos corretamente.

**Independent Test**: Todos os 5 novos parametros aparecem com valores default na Config. Alteracao persiste.

### Implementation

- [ ] T012 [US3] Run migration `0005_hedge_gaps.sql` created in T001 to seed the 5 parameters. Verify via `SELECT * FROM hedge.config_motor WHERE chave IN ('desvio_padrao_brl','custo_financiamento_pct','prazo_recebimento','transit_medio_dias','giro_estoque_dias')`.
- [ ] T013 [US3] In `modules/hedge/src/services/config.service.ts`, verify that `getConfig()` returns all parameters including the 5 new ones. Add `descricao` values if missing from seeds.
- [ ] T014 [P] [US3] In `apps/web/src/pages/hedge/ConfigPage.tsx`, verify that all 5 new parameters render correctly with their default values and are editable. No code change expected — this is a verification task after seeds are applied.

**Checkpoint**: Config page shows all params. Values persist across page reloads.

---

## Phase 6: User Story 4 — Graficos Motor MV com dados reais (Priority: P4)

**Goal**: Graficos no MotorMVPage usam dados retornados pelo motor em vez de calculos locais.

**Independent Test**: Valores nos graficos sao consistentes com os dados na tabela de recomendacoes.

### Implementation

- [ ] T015 [US4] In `apps/web/src/pages/hedge/MotorMVPage.tsx`, replace the local cost/protection chart calculation (which uses `spotRate * coverage` approximations) with data from `data.recomendacoes` array — plot `custo_ndf_brl` per bucket and `cobertura_alvo` from the motor response.
- [ ] T016 [US4] In `apps/web/src/pages/hedge/MotorMVPage.tsx`, replace the local margin simulation chart with data from `data.custo_acao_brl` and `data.cobertura_global_pct` returned by the motor, removing the `spotRate` and `ndf90Rate` slider-based approximations.

**Checkpoint**: Charts reflect real motor data. Consistency between table values and chart values.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T017 Run all existing hedge tests (`npx vitest run` in modules/hedge/) — ensure no regressions from changes in T003-T016
- [ ] T018 [P] Update `docs/gap-analysis-hedge-legacy-vs-atlas.md` marking GAP-01, GAP-10, GAP-14, GAP-F6 as RESOLVIDO with resolution details
- [ ] T019 Run quickstart.md validation scenarios (5 cenarios) manually against running dev server

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — T001 and T002 can start immediately and in parallel
- **US1 (Phase 3)**: Depends on T002 (cache.service needed by routes, but US1 itself doesn't need cache — can start after T001)
- **US2 (Phase 4)**: Depends on T002 (cache.service.ts). Can run in parallel with US1.
- **US3 (Phase 5)**: Depends only on T001 (migration). Can run in parallel with US1 and US2.
- **US4 (Phase 6)**: No dependencies on other stories. Can run in parallel with all.
- **Polish (Phase 7)**: Depends on all user stories complete.

### User Story Dependencies

- **US1 (P1)**: Independent — only needs existing posicao.service.ts
- **US2 (P2)**: Depends on T002 (cache.service.ts from Setup)
- **US3 (P3)**: Depends on T001 (migration from Setup)
- **US4 (P4)**: Independent — only modifies frontend page

### Parallel Opportunities

- T001 and T002 can run in parallel (different files)
- T006 (test) can run in parallel with T003-T005 (TDD)
- T009 can run in parallel with T008 (different handlers in same file, but different endpoints)
- T011 can run in parallel with T008-T010 (test file vs routes)
- T014 is verification only — can run after T012
- T015 and T016 can run in parallel (different chart sections in same file)
- T017 and T018 can run in parallel (tests vs docs)

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete T001 (migration) + T002 (cache.service)
2. Complete T003-T007 (US1: est_nao_pago distribution)
3. **STOP and VALIDATE**: Verify exposure per bucket matches legacy calculation
4. This alone fixes the most critical calculation gap

### Incremental Delivery

1. Setup (T001-T002) → Foundation ready
2. US1 (T003-T007) → Exposure corrected → **MVP done**
3. US2 (T008-T011) → Dashboard fast
4. US3 (T012-T014) → Config complete
5. US4 (T015-T016) → Charts accurate
6. Polish (T017-T019) → Validated and documented

---

## Notes

- Total: 19 tasks across 7 phases
- No schema changes needed (bucket_mensal stays as-is, est_nao_pago calculated in runtime)
- Only 1 new file: cache.service.ts
- 1 new migration: 0005_hedge_gaps.sql (seeds only, no DDL)
- 2 new test files: expanded posicao.test.ts + new cache.test.ts
