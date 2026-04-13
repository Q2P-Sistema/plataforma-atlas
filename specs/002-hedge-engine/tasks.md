# Tasks: Hedge Engine

**Input**: Design documents from `/specs/002-hedge-engine/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: Incluidos para services financeiros criticos (motor MV, NDF, posicao, PTAX) conforme Principio III da constituicao.

**Organization**: Tasks agrupadas por user story para implementacao e teste independentes.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Pode rodar em paralelo (arquivos diferentes, sem dependencia)
- **[Story]**: User story a qual a task pertence (US1, US2, etc.)
- Paths relativos a raiz do monorepo

---

## Phase 1: Setup (Module Initialization)

**Purpose**: Criar estrutura do modulo Hedge e integracao BCB no monorepo.

- [x] T001 Criar `modules/hedge/package.json` com deps: drizzle-orm, decimal.js, @atlas/core, @atlas/db, @atlas/auth, zod
- [x] T002 [P] Criar `modules/hedge/tsconfig.json` estendendo `tsconfig.base.json`
- [x] T003 [P] Criar `packages/integrations/bcb/package.json` com deps: @atlas/core (Redis cache)
- [x] T004 [P] Criar `packages/integrations/bcb/tsconfig.json` estendendo `tsconfig.base.json`
- [x] T005 Adicionar `recharts` como dependencia de `apps/web`
- [x] T006 Rodar `pnpm install` pra resolver todas as deps

**Checkpoint**: `pnpm install` sem erros, estrutura de diretorios criada.

---

## Phase 2: Foundational (Schema + PTAX + Routing)

**Purpose**: Schema Postgres, integracao PTAX BCB e routing base que DEVEM estar completos antes de qualquer user story.

**CRITICAL**: Nenhum trabalho de user story comeca antes desta fase estar completa.

- [x] T007 Criar `packages/db/src/schemas/hedge.ts` — Drizzle schema das 10 tabelas (bucket_mensal, ndf_registro, titulos_pagar, ptax_historico, ndf_taxas, posicao_snapshot, estoque_snapshot, alerta, config_motor, sync_log)
- [x] T008 Criar `packages/db/migrations/0002_hedge_engine.sql` — CREATE SCHEMA hedge, todas as tabelas, indexes, triggers de audit log (ndf_registro, titulos_pagar, config_motor, alerta), view shared.vw_hedge_posicao, seed config_motor defaults
- [x] T009 Exportar schema hedge de `packages/db/src/index.ts`
- [x] T010 Implementar `packages/integrations/bcb/src/ptax.service.ts` — fetch PTAX da API BCB (serie SGS-1), cache Redis 15min, validacao sanidade (3.00-10.00), fallback ultima cotacao, retorno {data_ref, venda, compra, atualizada}
- [x] T011 [P] Implementar `packages/integrations/bcb/src/index.ts` — re-export ptax service
- [x] T012 Criar `modules/hedge/src/routes/hedge.routes.ts` — Express router vazio, registrado em apps/api quando MODULE_HEDGE_ENABLED=true
- [x] T013 Atualizar `apps/api/src/modules.ts` — importar e registrar hedge router quando habilitado
- [x] T014 Criar `modules/hedge/src/index.ts` — public API do modulo (re-exports)
- [x] T015 Escrever teste `packages/integrations/bcb/src/__tests__/ptax.test.ts` — mock HTTP, verifica cache, validacao sanidade, fallback

**Checkpoint**: Schema hedge criado no banco, PTAX busca do BCB funciona, rota /api/v1/hedge/* responde.

---

## Phase 3: User Story 1 — Dashboard de Posicao Cambial (Priority: P1)

**Goal**: Operador abre /hedge e ve dashboard com 5 KPIs, tabela de buckets e graficos.

**Independent Test**: Abrir /hedge, ver KPIs com dados, tabela de buckets com 6+ meses, filtrar por localidade.

### Implementation for User Story 1

- [x] T016 [US1] Implementar `modules/hedge/src/services/posicao.service.ts` — calcularPosicao(filtros): agrega titulos_pagar por bucket mensal, cruza com NDFs ativos, calcula KPIs (exposure, cobertura_pct, gap), gera/atualiza buckets. Usa decimal.js.
- [x] T017 [US1] Implementar `modules/hedge/src/services/bucket.service.ts` — getBuckets(filtros), recalcularBucket(id), determinar status (ok/sub_hedged/over_hedged). Threshold: <60% sub_hedged, >100% over_hedged.
- [x] T018 [US1] Adicionar rotas em `modules/hedge/src/routes/hedge.routes.ts` — GET /api/v1/hedge/posicao (KPIs + buckets), GET /api/v1/hedge/posicao/historico (snapshots pra graficos)
- [x] T019 [US1] Implementar `apps/web/src/pages/hedge/PositionDashboard.tsx` — 5 cards KPI, tabela de buckets com DataTable, filtro por localidade/empresa
- [x] T020 [P] [US1] Implementar graficos em PositionDashboard: donut cobertura (recharts PieChart), barras exposicao por mes (BarChart), linha PTAX historico (LineChart)
- [x] T021 [US1] Atualizar `apps/web/src/App.tsx` — substituir ModulePlaceholder do /hedge por PositionDashboard e subrotas
- [x] T022 [US1] Escrever teste `modules/hedge/src/__tests__/posicao.test.ts` — calculo de KPIs com dados mock, bucket status correto, filtro por localidade

**Checkpoint**: Dashboard carrega com KPIs, tabela de buckets e graficos. Filtro por localidade funciona.

---

## Phase 4: User Story 2 — Motor de Minima Variancia (Priority: P1)

**Goal**: Gestor ajusta lambda e ve recomendacoes de hedge por bucket em tempo real.

**Independent Test**: Abrir /hedge/motor, mover slider lambda, ver recomendacoes atualizarem, aprovar cria NDF pendente.

### Implementation for User Story 2

- [x] T023 [US2] Implementar `modules/hedge/src/services/motor.service.ts` — calcularCamadas(lambda, pct_estoque_nao_pago): L1 base (60%, bump se estoque > 50%), L2 = lambda * 25, L3 = 100 - L1 - L2. Selecionar instrumento por prazo. Gerar recomendacoes por bucket. Toda aritmetica com decimal.js.
- [x] T024 [US2] Adicionar rotas — POST /api/v1/hedge/motor/calcular (retorna camadas + recomendacoes), POST /api/v1/hedge/motor/aprovar (cria NDF pendente a partir de recomendacao)
- [x] T025 [US2] Implementar `apps/web/src/pages/hedge/MotorMVPage.tsx` — 4 sliders (lambda, cambio, NDF 90d taxa, % estoque nao pago), 3 cards de camadas L1/L2/L3, tabela de recomendacoes com botao "Aprovar"
- [x] T026 [US2] Escrever teste `modules/hedge/src/__tests__/motor.test.ts` — L1+L2+L3 somam 100%, lambda 0 → L2=0, lambda 1 → L2=25, selecao instrumento por prazo (<=15d Trava, <=35d NDF 30d, etc.), bump L1 com estoque > 50%

**Checkpoint**: Motor calcula camadas, recomendacoes aparecem, aprovacao cria NDF pendente.

---

## Phase 5: User Story 3 — Gestao de NDFs e Contratos (Priority: P1)

**Goal**: CRUD completo de NDFs com ciclo de vida pendente → ativo → liquidado/cancelado.

**Independent Test**: Criar NDF, ativar, liquidar com PTAX, ver resultado calculado. Cancelar outro NDF.

### Implementation for User Story 3

- [x] T027 [US3] Implementar `modules/hedge/src/services/ndf.service.ts` — criarNdf(dados): calcula custo_brl, associa bucket. ativarNdf(id). liquidarNdf(id, ptax_liquidacao): calcula resultado_brl. cancelarNdf(id). listarNdfs(filtros). Validacao de transicoes de estado. Toda aritmetica com decimal.js.
- [x] T028 [US3] Adicionar rotas — GET /api/v1/hedge/ndfs, POST /api/v1/hedge/ndfs, PATCH .../ativar, PATCH .../liquidar, PATCH .../cancelar
- [x] T029 [US3] Implementar `apps/web/src/pages/hedge/NDFListPage.tsx` — DataTable com NDFs (notional, taxa, status, resultado), modal criar NDF, botoes ativar/liquidar/cancelar, filtro por status/empresa
- [x] T030 [US3] Escrever teste `modules/hedge/src/__tests__/ndf.test.ts` — criar calcula custo correto, transicao pendente→ativo OK, transicao ativo→liquidado calcula resultado, transicao invalida (liquidado→ativo) rejeita, cancelar recalcula bucket

**Checkpoint**: CRUD NDF completo, ciclo de vida funcional, calculo de custo e resultado corretos.

---

## Phase 6: User Story 4 — Integracao PTAX BCB (Priority: P2)

**Goal**: PTAX busca automatica, historico, fallback e indicador visual.

**Independent Test**: PTAX do dia aparece no dashboard. Simular falha BCB → ultima cotacao usada com aviso.

### Implementation for User Story 4

- [x] T031 [US4] Implementar `modules/hedge/src/services/ptax.service.ts` — wrapper que usa bcb integration, persiste historico em hedge.ptax_historico, expoe getAtual(), getHistorico(dias). Logica de persistencia e consulta local.
- [x] T032 [US4] Adicionar rotas — GET /api/v1/hedge/ptax (atual + historico recente)
- [x] T033 [P] [US4] Adicionar indicador visual de PTAX no PositionDashboard — badge "atualizada" / "desatualizada" com cor
- [x] T034 [US4] Escrever teste — persistencia de PTAX, fallback quando BCB offline, rejeicao de valor fora de sanidade

**Checkpoint**: PTAX carrega do BCB, persiste localmente, fallback funciona.

---

## Phase 7: User Story 5 — Simulacao de Margem (Priority: P2)

**Goal**: Grid de cenarios de cambio com margem calculada.

**Independent Test**: Abrir simulador, ver grid 13 cenarios (4.50-7.50), alterar parametros.

### Implementation for User Story 5

- [x] T035 [US5] Implementar `modules/hedge/src/services/simulacao.service.ts` — simularMargem(faturamento, custos, volume_usd): calcula custo_com_hedge e custo_sem_hedge para cada cenario de 4.50 a 7.50 step 0.25. Usa decimal.js.
- [x] T036 [US5] Adicionar rota — POST /api/v1/hedge/simulacao/margem
- [x] T037 [US5] Implementar `apps/web/src/pages/hedge/MarginSimulationPage.tsx` — form de parametros (faturamento, custos, volume), grid de cenarios com cores (verde margem boa, vermelho margem ruim)
- [x] T038 [US5] Escrever teste — 13 cenarios gerados, calculo com hedge vs sem hedge correto, aritmetica decimal

**Checkpoint**: Simulacao calcula 13 cenarios em < 1 segundo.

---

## Phase 8: User Story 6 — Estoque por Localidade (Priority: P2)

**Goal**: Visualizacao de estoque importado por deposito.

**Independent Test**: Abrir /hedge/estoque, ver localidades com valores, filtrar por empresa.

### Implementation for User Story 6

- [x] T039 [US6] Implementar `modules/hedge/src/services/estoque.service.ts` — getEstoque(filtros): le dados de estoque (snapshot ou OMIE direto), agrupa por localidade, calcula totais e % pago
- [x] T040 [US6] Adicionar rota — GET /api/v1/hedge/estoque
- [x] T041 [US6] Implementar `apps/web/src/pages/hedge/InventoryPage.tsx` — cards KPI (maritimo/alfandega/deposito/total), DataTable por localidade, filtro empresa, pie chart pago/a pagar

**Checkpoint**: Estoque carrega com localidades, filtro por empresa funciona.

---

## Phase 9: User Story 7 — Alertas (Priority: P3)

**Goal**: Alertas automaticos por gap de cobertura com gestao (lido/resolvido).

**Independent Test**: Bucket com gap > 1M → alerta critico gerado. Marcar lido. Resolver.

### Implementation for User Story 7

- [x] T042 [US7] Implementar `modules/hedge/src/services/alerta.service.ts` — gerarAlertas(buckets): avalia gap por threshold (critico >=1M, alta 500K-1M, media >0). marcarLido(id). resolver(id). listarAlertas(filtros).
- [x] T043 [US7] Adicionar rotas — GET /api/v1/hedge/alertas, PATCH .../lido, PATCH .../resolver
- [x] T044 [US7] Implementar `apps/web/src/pages/hedge/AlertsPage.tsx` — lista de alertas com badge severidade, botoes lido/resolver, tab historico
- [x] T045 [US7] Integrar geracao de alertas no calculo de posicao (posicao.service chama alerta.service apos recalculo)

**Checkpoint**: Alertas gerados automaticamente, gestao de lifecycle funciona.

---

## Phase 10: User Story 8 — Configuracao e Taxas (Priority: P3)

**Goal**: Editar parametros do motor e taxas NDF de mercado.

**Independent Test**: Alterar lambda default, salvar. Inserir taxa NDF 90d, verificar calculo usa.

### Implementation for User Story 8

- [x] T046 [US8] Implementar `modules/hedge/src/services/config.service.ts` — getConfig(), updateConfig(chave, valor). getTaxasNdf(data_ref). inserirTaxaNdf(data_ref, prazo, taxa).
- [x] T047 [US8] Adicionar rotas — GET/PATCH /api/v1/hedge/config, GET/POST /api/v1/hedge/taxas-ndf
- [x] T048 [US8] Implementar `apps/web/src/pages/hedge/ConfigPage.tsx` — form de parametros (lambda, localidades, thresholds), tabela de taxas NDF editavel, status de conexoes (DB/BCB/Redis)

**Checkpoint**: Config persiste, taxas NDF editaveis, motor usa valores atualizados.

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: Qualidade, navegacao e validacao final.

- [x] T049 [P] Adicionar navegacao interna do Hedge na sidebar — subrotas (Dashboard, NDFs, Motor, Simulacao, Estoque, Alertas, Config) como submenu quando /hedge esta ativo
- [x] T050 [P] Adicionar badge de alertas nao-lidos no menu Hedge da sidebar
- [x] T051 Rodar migration 0002 no banco dev e verificar schema
- [x] T052 Verificar que audit log registra mutacoes em ndf_registro, config_motor, alerta
- [x] T053 Rodar `pnpm test` — garantir todos os testes passam
- [x] T054 Rodar `pnpm typecheck` — zero erros
- [x] T055 Testar fluxo completo: PTAX → criar NDF → ativar → ver cobertura → motor recomenda → aprovar → liquidar → resultado
- [x] T056 Verificar performance: dashboard < 2s, motor < 500ms, simulacao < 1s

**Checkpoint**: `pnpm test && pnpm typecheck` verde. Fluxo completo funciona. Performance dentro dos criterios.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Sem dependencias — comeca imediatamente
- **Foundational (Phase 2)**: Depende de Phase 1 — BLOQUEIA todas as user stories
- **US1 Dashboard (Phase 3)**: Depende de Phase 2 — precisa de schema + PTAX + routing
- **US2 Motor MV (Phase 4)**: Depende de US1 (precisa de buckets calculados)
- **US3 NDFs (Phase 5)**: Depende de US1 (precisa de buckets pra associar)
- **US4 PTAX (Phase 6)**: Depende de Phase 2 (BCB integration pronta)
- **US5 Simulacao (Phase 7)**: Depende de US3 (precisa de NDFs pra calcular margem com hedge)
- **US6 Estoque (Phase 8)**: Depende de Phase 2 (schema pronto)
- **US7 Alertas (Phase 9)**: Depende de US1 (precisa de buckets pra avaliar gap)
- **US8 Config (Phase 10)**: Depende de Phase 2 (schema config_motor)
- **Polish (Phase 11)**: Depende de todas as user stories desejadas

### User Story Dependencies

- **US1 (P1)**: Foundation → Dashboard (ponto de entrada)
- **US2 (P1)**: US1 → Motor MV (precisa de buckets)
- **US3 (P1)**: US1 → NDFs (precisa de buckets pra associar)
- **US4 (P2)**: Foundation → PTAX (independente)
- **US5 (P2)**: US3 → Simulacao (precisa de NDFs)
- **US6 (P2)**: Foundation → Estoque (independente)
- **US7 (P3)**: US1 → Alertas (precisa de buckets)
- **US8 (P3)**: Foundation → Config (independente)

### Parallel Opportunities

Apos Phase 2 completa:
- **Paralelo A**: US4 (PTAX) + US6 (Estoque) + US8 (Config) — independentes
- **Sequencial critico**: US1 → US2 → US5 (cadeia de dependencia do motor)
- **Sequencial critico**: US1 → US3 (NDFs dependem de buckets)
- **Sequencial**: US1 → US7 (alertas dependem de buckets)

---

## Implementation Strategy

### MVP (US1 + US2 + US3)

1. Phase 1: Setup
2. Phase 2: Foundational (schema + PTAX + routing)
3. Phase 3: US1 — Dashboard (posicao, buckets, KPIs)
4. Phase 5: US3 — NDFs (CRUD + ciclo de vida)
5. Phase 4: US2 — Motor MV (camadas + recomendacoes)
6. **STOP e VALIDAR**: Dashboard funciona, NDFs registram, Motor recomenda

### Incremental

7. Phase 6: US4 — PTAX (historico + fallback)
8. Phase 7: US5 — Simulacao de margem
9. Phase 8: US6 — Estoque
10. Phase 9: US7 — Alertas
11. Phase 10: US8 — Config
12. Phase 11: Polish
