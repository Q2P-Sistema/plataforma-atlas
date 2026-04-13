# Tasks: Forecast Advanced Features

**Input**: Design documents from `/specs/005-forecast-advanced-features/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md, quickstart.md

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

---

## Phase 1: Setup

**Purpose**: Sidebar entries e rotas para as novas paginas

- [X] T001 In `apps/web/src/App.tsx`, add 2 new sidebar sub-items for Forecast: { id: 'forecast-demanda', name: 'Demanda', path: '/forecast/demanda', icon: BarChart3 } and { id: 'forecast-insights', name: 'Insights', path: '/forecast/insights', icon: Lightbulb }. Add corresponding Route elements for DemandAnalysisPage and BusinessInsightsPage.

---

## Phase 2: Foundational

**Purpose**: Nenhuma tarefa foundational — modulo forecast ja existe com toda infraestrutura.

**Checkpoint**: Setup completo — user stories podem comecar.

---

## Phase 3: User Story 1 — Aba Analise de Demanda (Priority: P1)

**Goal**: Tabela de vendas mensais por familia com YoY%, sparkline, expansao por SKU.

**Independent Test**: Abrir `/forecast/demanda`, verificar vendas 24m, YoY%, sparkline e expansao SKU.

### Implementation

- [X] T002 [US1] Create `modules/forecast/src/services/demanda.service.ts` with function `getVendasMensais()` that queries `tbl_movimentacaoEstoqueHistorico_Q2P` JOIN `tbl_produtos_Q2P`, groups by `descricao_familia` and `TO_CHAR(dt_mov, 'YYYY-MM')`, filters `des_origem = 'Venda de Produto'` and `cancelamento != 'S'`, last 24 months. Returns array of { familia, meses[], ultimos_3m[], yoy: { trimestre_atual, trimestre_anterior, variacao_pct, tendencia }, sparkline[], skus[] }.
- [X] T003 [US1] In `modules/forecast/src/routes/forecast.routes.ts`, add `GET /api/v1/forecast/demanda` endpoint that calls `getVendasMensais()` and returns via `sendSuccess()`. Requires auth.
- [X] T004 [P] [US1] Create `apps/web/src/pages/forecast/DemandAnalysisPage.tsx` with: (1) table of families with columns: Familia, Mes-3, Mes-2, Mes-1, YoY% (colored arrow), Sparkline (recharts Sparkline or mini AreaChart). (2) Expandable rows showing SKUs with codigo, descricao, volume_24m, contribuicao_pct, cobertura_dias. (3) useQuery to fetch `/api/v1/forecast/demanda`.
- [X] T005 [P] [US1] Write test in `modules/forecast/src/__tests__/demanda.test.ts` verifying: (1) YoY calculation — given Q1 atual=49100, Q1 anterior=42300, variacao=16.08%, tendencia='subindo'. (2) tendencia='descendo' when variacao < -10%. (3) tendencia='estavel' when between -10% and +10%. (4) sparkline has exactly 24 entries.

**Checkpoint**: Aba Demanda funcional com dados reais. Comprador identifica tendencia em <10s.

---

## Phase 4: User Story 2 — Aba Business Insights (Priority: P2)

**Goal**: Fornecedores com LT, score COMEX, historico importacao, janela compra otima.

**Independent Test**: Abrir `/forecast/insights`, verificar fornecedores, score COMEX 4 meses, historico.

### Implementation

- [X] T006 [US2] Create `modules/forecast/src/services/insights.service.ts` with: (1) `getFornecedores()` — queries `tbl_dadosPlanilhaFUPComex` grouped by `fornecedor`, returns nome, pais_origem, ARRAY_AGG(DISTINCT familia_produto), AVG(data_desembarque - data_proforma) as lt_efetivo, COUNT, MAX(data_proforma). (2) `getScoreCOMEX()` — queries FUP grouped by month (last 12), calculates score per month using formula: preco_score*0.4 + volume_score*0.3 + cambio_score*0.3, normalized 0-100, with classificacao (COMPRAR>=70, BOM>=55, NEUTRO>=40, CAUTELA>=25, EVITAR<25). (3) `getHistoricoImportacao()` — queries FUP grouped by month, returns volume_kg, valor_usd, preco_ton_usd, taxa_dolar per month.
- [X] T007 [US2] In `modules/forecast/src/routes/forecast.routes.ts`, add `GET /api/v1/forecast/insights` endpoint that calls getFornecedores(), getScoreCOMEX(), getHistoricoImportacao() in parallel and returns combined response. Requires auth.
- [X] T008 [P] [US2] Create `apps/web/src/pages/forecast/BusinessInsightsPage.tsx` with: (1) Fornecedores table: columns nome, pais, familias (tags), LT efetivo, total importacoes, ultimo embarque. (2) Score COMEX section: 4 cards (proximo 4 meses) each with score bar 0-100, classificacao badge colored (green COMPRAR, emerald BOM, amber NEUTRO, orange CAUTELA, red EVITAR). (3) Historico importacao: recharts BarChart with volume_kg bars + Line overlay for preco_ton_usd, 12 months. useQuery to fetch `/api/v1/forecast/insights`.
- [X] T009 [P] [US2] Write test in `modules/forecast/src/__tests__/insights.test.ts` verifying: (1) score COMEX classification — score 72 → 'COMPRAR', score 58 → 'BOM', score 43 → 'NEUTRO', score 30 → 'CAUTELA', score 20 → 'EVITAR'. (2) score normalization — all scores between 0 and 100. (3) fornecedor LT calculation — given dates, returns correct average days.

**Checkpoint**: Aba Insights funcional. Comprador identifica melhor mes para compra em <30s.

---

## Phase 5: User Story 3 — Analise IA na Shopping List (Priority: P3)

**Goal**: Botao "Analisar com IA" na Shopping List que envia contexto ao n8n e exibe recomendacoes.

**Independent Test**: Montar shopping list, clicar "Analisar com IA", ver recomendacoes por item.

### Implementation

- [X] T010 [US3] Create `modules/forecast/src/services/ai-analysis.service.ts` with function `analyzeShoppingList(itens)` that: (1) builds payload with itens + contexto (total_itens, total_valor, data_analise). (2) POSTs to n8n webhook URL (from config or env var `N8N_FORECAST_ANALYZE_URL`). (3) Parses response into { resumo_executivo, alertas[], recomendacoes[] }. (4) Handles timeout (30s) and errors with null return. (5) Validates response shape with Zod.
- [X] T011 [US3] In `modules/forecast/src/routes/forecast.routes.ts`, add `POST /api/v1/forecast/shopping-list/analyze` endpoint that receives { itens[] }, calls analyzeShoppingList(), returns result or error with code LLM_UNAVAILABLE. Requires auth.
- [X] T012 [US3] In `apps/web/src/pages/forecast/ShoppingListPage.tsx`, add: (1) "Analisar com IA" button (disabled when no items selected, shows loading spinner during analysis). (2) Analysis result panel below the table showing: resumo_executivo card, alertas list, recomendacoes table with columns Familia, Acao (badge: green COMPRAR AGORA, amber AGUARDAR, blue REVISAR, gray OK), Justificativa, Prioridade. (3) useMutation to POST `/api/v1/forecast/shopping-list/analyze`. (4) Clear analysis when items change. (5) Error state with friendly message when LLM unavailable.

**Checkpoint**: Analise IA funcional. Recomendacoes por item com justificativa.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T013 Run all forecast tests (`npx vitest run` in modules/forecast/) — ensure no regressions
- [X] T014 [P] Update `docs/gap-analysis-forecast-legacy-vs-atlas.md` marking GAP-F1, GAP-F2, GAP-F4 as RESOLVIDO
- [X] T015 Run quickstart.md validation scenarios (5 cenarios) against running dev server

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — T001 can start immediately
- **US1 (Phase 3)**: Depends on T001 (routes registered in App.tsx)
- **US2 (Phase 4)**: Depends on T001. Can run in parallel with US1.
- **US3 (Phase 5)**: Independent of US1/US2 — modifies existing ShoppingListPage. Can run in parallel.
- **Polish (Phase 6)**: Depends on all user stories complete.

### User Story Dependencies

- **US1 (P1)**: Independent — new service + new page
- **US2 (P2)**: Independent — new service + new page
- **US3 (P3)**: Independent — new service + edit existing page

### Parallel Opportunities

- T004 and T005 can run in parallel (page vs test)
- T008 and T009 can run in parallel (page vs test)
- T002 and T006 can run in parallel (different services)
- T004 and T008 can run in parallel (different pages)
- T013 and T014 can run in parallel (tests vs docs)

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete T001 (routes + sidebar)
2. Complete T002-T005 (US1: Aba Demanda)
3. **STOP and VALIDATE**: Verify YoY%, sparkline, SKU expansion with real data
4. This alone delivers the most requested missing feature

### Incremental Delivery

1. Setup (T001) → Sidebar + routes ready
2. US1 (T002-T005) → Aba Demanda → **MVP done**
3. US2 (T006-T009) → Aba Insights → Timing intelligence
4. US3 (T010-T012) → Analise IA → Nice-to-have
5. Polish (T013-T015) → Validated and documented

---

## Notes

- Total: 15 tasks across 6 phases
- 3 new services: demanda, insights, ai-analysis
- 2 new pages: DemandAnalysisPage, BusinessInsightsPage
- 1 edited page: ShoppingListPage (add AI button + panel)
- 3 new endpoints: GET demanda, GET insights, POST analyze
- 2 new test files: demanda.test.ts, insights.test.ts
- No database tables created — all read-only from OMIE
- N8N_FORECAST_ANALYZE_URL env var needed for US3
