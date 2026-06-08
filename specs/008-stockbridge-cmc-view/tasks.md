---
description: "Task list — StockBridge CMC View (008)"
---

# Tasks: StockBridge — Visão de CMC por Família e Produto

**Input**: Design documents from `/specs/008-stockbridge-cmc-view/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/cmc-api.md

**Tests**: Incluídos de forma focada (Vitest/Supertest) — não TDD-first, mas cobrindo o ponto de risco (agregação ponderada + acesso). Alinhado à cultura de testes do repo (`__tests__` em todo módulo) e à Constituição.

**Organization**: Tarefas agrupadas por user story. MVP = US1 (aba Snapshot diário).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência pendente)
- **[Story]**: US1 / US2 / US3
- Caminhos de arquivo são absolutos a partir da raiz do repo

## Convenções do módulo (do plan/research)

- Backend lê `public."tbl_historico_cmc_estoque"` direto via `getPool()` (`@atlas/core`). **Sem migration, sem escrita, sem audit.**
- Rotas sob `/api/v1/stockbridge` (já protegidas por `requireAuth` + `requireModule('stockbridge')`); CMC usa `requireGestor` (gestor+diretor).
- Envelope `{ data, error }`; validação Zod; CMC ponderado = `SUM(valor_total_cmc)/NULLIF(SUM(volume_total),0)`; família = `COALESCE(NULLIF(descricao_familia,''),'Sem família')`; unidades já em **kg / R$/kg** (sem conversão).
- Frontend Tailwind hand-rolled (sem shadcn), recharts p/ tendência, TanStack Query + `x-csrf-token`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Garantir a fonte de dados no ambiente alvo. (Infra do módulo já existe.)

- [ ] T001 Verificar presença de `public.tbl_historico_cmc_estoque` no banco do ambiente alvo; em **dev**, rodar `scripts/sync-vendas-prod-to-dev.sh` (tabela já consta no array `TABLES`) e validar com `SELECT count(*), max(data_snapshot) FROM public.tbl_historico_cmc_estoque;` conforme `specs/008-stockbridge-cmc-view/quickstart.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Base compartilhada pelas 3 stories (tipos, helpers de query, esqueleto de rota, shell da página + menu). 

**⚠️ CRITICAL**: Nenhuma user story começa antes desta fase.

- [ ] T002 [P] Definir os read-model types (`CmcResumo`, `CmcProdutoNode`, `CmcFamiliaNode`, `CmcSnapshotResponse`, `CmcTendenciaResponse`, `CmcFiltrosResponse`) conforme `data-model.md` em `modules/stockbridge/src/services/cmc.service.ts`
- [ ] T003 Implementar helpers compartilhados em `modules/stockbridge/src/services/cmc.service.ts`: `getPool()`; normalização de filtros (familia[]/produto[]/origem/data); builder de `WHERE` parametrizado; expressão de CMC ponderado; resolução de `MAX(data_snapshot)` + flag `defasado` (≠ `CURRENT_DATE`) (depends T002)
- [ ] T004 Criar `modules/stockbridge/src/routes/cmc.routes.ts` (esqueleto): `Router`, `requireGestor` (de `middleware/role.js`), schemas Zod por endpoint, envelope `{data,error}`, erro `CMC_FAIL`/`INVALID_INPUT` (depends T003)
- [ ] T005 Registrar `cmcRouter` em `modules/stockbridge/src/routes/stockbridge.routes.ts` (import + `router.use(cmcRouter)`) (depends T004)
- [ ] T006 [P] Adicionar item de menu em `apps/web/src/App.tsx`: entrada `{ id:'sb-custos', name:'Custos de Estoque', path:'/stockbridge/custos', icon, roles:['gestor','diretor'] }` em `STOCKBRIDGE_SUB_ITEMS` + `<Route path="custos" element={<CmcPage/>}>` no bloco StockBridge
- [ ] T007 [P] Criar shell `apps/web/src/pages/stockbridge/gestor/CmcPage.tsx`: alternador de abas (Snapshot default / Tendência) via `useState`, helper de fetch com `credentials:'include'` + `x-csrf-token`, área para barra de filtros (preenchida em US3)

**Checkpoint**: Rota e menu existem; página abre vazia. Stories podem começar.

---

## Phase 3: User Story 1 — Aba Snapshot diário (Priority: P1) 🎯 MVP

**Goal**: Lista de famílias com CMC ponderado, volume e valor (quebra Importado/Nacional), árvore de produtos estilo Explorer e resumo global no topo.

**Independent Test**: Abrir a aba com ≥1 dia de dados → famílias listadas; clicar expande produtos; soma dos produtos = total da família; resumo global mostra volume+valor (sem CMC global); operador recebe 403.

- [ ] T008 [P] [US1] Implementar `listarSnapshotCmc(filtros)` em `modules/stockbridge/src/services/cmc.service.ts` retornando `CmcSnapshotResponse` (famílias agregadas + `produtos[]` por produto×origem + `porOrigem` + `resumo` + `dataSnapshot`/`defasado`); volume 0 → cmc `null` (depends T003)
- [ ] T009 [US1] Adicionar `GET /api/v1/stockbridge/cmc/snapshot` em `modules/stockbridge/src/routes/cmc.routes.ts` (Zod: `data?`, `familia[]`, `produto[]`, `origem?`) chamando `listarSnapshotCmc` (depends T008, T004)
- [ ] T010 [P] [US1] Criar `apps/web/src/pages/stockbridge/gestor/cmc/FamiliaTree.tsx`: linha de família expansível (estilo pastas, `ChevronDown`), `produtos[]` como folhas, CMC exibido como "—" quando `null`, famílias recolhidas por padrão
- [ ] T011 [US1] Criar `apps/web/src/pages/stockbridge/gestor/cmc/CmcSnapshotTab.tsx`: `useQuery` no endpoint snapshot; resumo global no topo (volume kg + valor R$, **sem** CMC global); lista de famílias via `FamiliaTree`; rótulo "Posição em DD/MM" + aviso quando `defasado`; estado vazio explícito (depends T010, T009)
- [ ] T012 [US1] Montar `CmcSnapshotTab` como aba padrão em `apps/web/src/pages/stockbridge/gestor/CmcPage.tsx` (depends T011, T007)
- [ ] T013 [P] [US1] Testes em `modules/stockbridge/src/__tests__/cmc.test.ts`: CMC da família é ponderado por volume (≠ média aritmética); reconciliação produtos↔família; "Sem família"; volume 0 → cmc null; operador → 403 (depends T009)

**Checkpoint**: Aba Snapshot 100% funcional e demonstrável (sem filtros). MVP entregável.

---

## Phase 4: User Story 2 — Aba Tendência histórica (Priority: P2)

**Goal**: Série diária do CMC ponderado por família (ou produto) num período, com lacunas em dias sem coleta.

**Independent Test**: Com vários dias de snapshots, selecionar período/família → série reflete os valores diários; dia sem snapshot aparece como lacuna (sem interpolar).

- [ ] T014 [P] [US2] Implementar `listarTendenciaCmc(filtros)` em `modules/stockbridge/src/services/cmc.service.ts` retornando `CmcTendenciaResponse` (`datas[]` + `series[]` com `pontos` `null` nos dias sem `data_snapshot`) (depends T003)
- [ ] T015 [US2] Adicionar `GET /api/v1/stockbridge/cmc/tendencia` em `modules/stockbridge/src/routes/cmc.routes.ts` (Zod: `de?`, `ate?`, `familia[]`, `produto[]`, `origem?`) (depends T014, T004)
- [ ] T016 [US2] Criar `apps/web/src/pages/stockbridge/gestor/cmc/CmcTendenciaTab.tsx`: recharts `LineChart` com `connectNulls={false}`, eixo Y em R$/kg, seletor de período (padrão: todo histórico); `useQuery` no endpoint tendência; estado vazio (depends T015, T007)
- [ ] T017 [US2] Montar `CmcTendenciaTab` como segunda aba em `apps/web/src/pages/stockbridge/gestor/CmcPage.tsx` (depends T016, T012)
- [ ] T018 [P] [US2] Teste em `modules/stockbridge/src/__tests__/cmc.test.ts`: tendência retorna `null` (lacuna) em dia sem snapshot; uma série por família (depends T015)

**Checkpoint**: Abas Snapshot e Tendência funcionam de forma independente.

---

## Phase 5: User Story 3 — Filtros multi-seleção + ordenação (Priority: P3)

**Goal**: Combos multi-seleção de família e produto nas duas abas (produto respeita família), filtro de origem, e ordenação por valor imobilizado na aba Snapshot.

**Independent Test**: Aplicar cada filtro em cada aba → lista/série/totais refletem só os itens filtrados; combo de produto mostra só produtos das famílias selecionadas; ordenar por valor traz maiores primeiro.

- [ ] T019 [P] [US3] Implementar `listarFiltrosCmc(familiaSelecionada?)` em `modules/stockbridge/src/services/cmc.service.ts` retornando `CmcFiltrosResponse` (`familias[]` + `produtos[]` filtrados por família, do snapshot mais recente) (depends T003)
- [ ] T020 [US3] Adicionar `GET /api/v1/stockbridge/cmc/filtros` em `modules/stockbridge/src/routes/cmc.routes.ts` (Zod: `familia[]?`) (depends T019, T004)
- [ ] T021 [P] [US3] Criar `apps/web/src/pages/stockbridge/gestor/cmc/MultiSelectCombo.tsx`: dropdown hand-rolled com busca + checkboxes (multi-seleção)
- [ ] T022 [US3] Adicionar barra de filtros em `apps/web/src/pages/stockbridge/gestor/CmcPage.tsx` (família multi, produto multi respeitando família via endpoint filtros, origem) compartilhada pelas 2 abas; propagar filtros para as queries de Snapshot e Tendência (depends T021, T020, T012, T017)
- [ ] T023 [US3] Aba Snapshot: ordenação por valor imobilizado (desc) e recálculo de resumo/totais com filtros aplicados em `apps/web/src/pages/stockbridge/gestor/cmc/CmcSnapshotTab.tsx` (depends T022, T011)
- [ ] T024 [P] [US3] Teste em `modules/stockbridge/src/__tests__/cmc.test.ts`: filtros (família/produto/origem) afetam snapshot e resumo; `filtros` restringe produtos pela família (depends T020)

**Checkpoint**: Todas as 3 stories funcionais e independentes.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T025 [P] Rodar smoke tests do `specs/008-stockbridge-cmc-view/quickstart.md` (curl snapshot/tendencia/filtros + operador 403) e validação manual da UI
- [ ] T026 [P] Reconciliar valores com o Metabase Dashboard 14 (mesma data/família/origem) e registrar no PR (SC-004)
- [ ] T027 Rodar `pnpm lint` (inclui `eslint-plugin-boundaries`), `pnpm typecheck` e build; corrigir violações

---

## Dependencies & Execution Order

### Phase Dependencies
- **Setup (P1)**: sem dependências.
- **Foundational (P2)**: depende do Setup. **Bloqueia** todas as stories. Backend sequencial T002→T003→T004→T005; frontend T006/T007 em paralelo.
- **US1 (P3)**: depende da Foundational. É o MVP.
- **US2 (P4)**: depende da Foundational; integra ao shell (T017 após T012).
- **US3 (P5)**: depende da Foundational; a barra de filtros (T022) integra ambas as abas, então após T012 e T017.
- **Polish (P6)**: após as stories desejadas.

### User Story Dependencies
- **US1**: independente (snapshot sem filtros).
- **US2**: independente (tendência sem filtros); só compartilha o shell.
- **US3**: adiciona filtros sobre US1/US2 — para o filtro valer nas duas abas precisa de US1 e US2 montadas (T022 depende de T012 e T017). Se entregar US3 só sobre US1, ajustar T022 para a aba existente.

### Within Each User Story
- Service (query) → rota → componentes UI → montagem no shell → teste.
- Tarefas no mesmo arquivo (`cmc.service.ts`, `cmc.routes.ts`, `CmcPage.tsx`, `cmc.test.ts`) **não** são paralelas entre si.

### Parallel Opportunities
- Foundational: T002 (backend) ‖ T006 ‖ T007 (frontend).
- US1: T008 (service) ‖ T010 (FamiliaTree); T013 (teste) após T009.
- US2: T014 (service) cedo; T018 (teste) ‖ T016 (frontend) após T015.
- US3: T019 (service) ‖ T021 (MultiSelectCombo); T024 (teste) após T020.

---

## Parallel Example: User Story 1

```bash
# Em paralelo (arquivos diferentes):
Task T008: "listarSnapshotCmc em modules/stockbridge/src/services/cmc.service.ts"
Task T010: "FamiliaTree em apps/web/src/pages/stockbridge/gestor/cmc/FamiliaTree.tsx"
# Depois, em sequência: T009 (rota) → T011 (SnapshotTab) → T012 (montar) ; T013 (teste) após T009
```

---

## Implementation Strategy

### MVP First (US1)
1. Phase 1 (Setup) → 2. Phase 2 (Foundational) → 3. Phase 3 (US1) → **validar aba Snapshot isolada** → demo.

### Incremental Delivery
1. Setup + Foundational → base pronta.
2. + US1 → aba Snapshot (MVP) → demo.
3. + US2 → aba Tendência → demo.
4. + US3 → filtros nas duas abas + ordenação → demo.
5. Polish (reconciliação Metabase, lint/boundaries, quickstart).

---

## Notes
- **Sem migration** e **sem trigger de audit** (feature read-only) — não criar nada em `packages/db/migrations/`.
- `tbl_historico_cmc_estoque` é fonte externa (n8n) em `public.*` — só leitura.
- Acesso = `requireGestor`; "Administrador" da spec = `diretor` (não existe role `admin` no Atlas — ver research D2).
- Unidades já em kg/R$/kg — não aplicar conversão de toneladas.
- Commit por tarefa ou grupo lógico; PR obrigatório (Conventional Commits, escopo `stockbridge`).
