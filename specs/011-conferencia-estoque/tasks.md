# Tasks: Conferência de Estoque ACXE vs Q2P (StockBridge)

**Input**: Design documents from `/specs/011-conferencia-estoque/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: INCLUÍDOS — a paridade 100% com a planilha (SC-003) e o gate do Princípio III (regra de negócio em TS coberta por Vitest) exigem testes da engine `Status Geral`. Supertest nas rotas.

**Organization**: Tarefas agrupadas por user story. MVP = US1 + US2 (ambas P1).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência pendente)
- **[Story]**: US1 (lista) · US2 (badge) · US3 (filtros/cores/KPIs) · US4 (frescor)
- Caminhos de arquivo absolutos a partir da raiz do repo.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirmar pré-condições. A branch `011-conferencia-estoque`, o módulo `modules/stockbridge` e as deps já existem — setup é mínimo.

- [X] T001 Confirmar `MODULE_STOCKBRIDGE_ENABLED=true` no `.env` local e que `pnpm install` está atualizado na raiz (`/home/primebot/Documentos/Github/q2p/plataforma-atlas`).
- [X] T002 Confirmar conectividade de leitura às tabelas OMIE `public."tbl_posicaoEstoque_ACXE"/"_Q2P"` no banco de dev (smoke `SELECT MAX(ddataposicao)`), conforme [research.md](./research.md#resumo-de-descobertas-do-banco-evidência).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Núcleo de dados + engine de regras que **US1 e US2 compartilham**. Nenhuma user story começa antes disto.

**⚠️ CRITICAL**: bloqueia todas as stories.

- [X] T003 Criar migration `packages/db/migrations/0040_stockbridge_conferencia_local_map.sql`: tabela `stockbridge.conferencia_local_map` (colunas/índices/CHECKs conforme [data-model.md §1.1](./data-model.md)), trigger de auditoria `AFTER INSERT/UPDATE/DELETE → shared.audit_log` (padrão da migration 0039), e `COMMENT`s. Seguir o skill `stockbridge-migration`.
- [X] T004 No mesmo arquivo da migration 0040, inserir o **seed das 23 linhas** do mapa De→Para com `INSERT ... ON CONFLICT (codigo_local_estoque) DO NOTHING` (tabela completa em [data-model.md §5](./data-model.md#seed)).
- [X] T005 [P] Adicionar a tabela Drizzle `conferenciaLocalMap` em `packages/db/src/schemas/stockbridge.ts` (definição em [data-model.md §1.1](./data-model.md)) e exportar `LocalidadeMap`/`NewLocalidadeMap` (`$inferSelect/$inferInsert`).
- [X] T006 [P] Adicionar tipos em `modules/stockbridge/src/types.ts`: `ConferenciaItem`, `ConferenciaResumo`, `ConferenciaResponse`, e as uniões `StatusGeral`/`StatusSaldoNegativo` ([data-model.md §1.2](./data-model.md)). Exportar a constante `CONFERENCIA_BLACKLIST = ['CONS_','PRD00001','SUC-','STRETCH']`.
- [X] T007 Criar `modules/stockbridge/src/services/conferencia.service.ts` com a **engine pura** (funções `statusSaldoNegativo`, `statusGeral`, `pesoStatus`/comparador de ordenação) exatamente conforme [data-model.md §2–§3](./data-model.md). Funções puras, sem I/O, exportadas para teste.
- [X] T008 Criar `modules/stockbridge/src/services/__tests__/conferencia.engine.test.ts` (Vitest) cobrindo os invariantes de [data-model.md §2](./data-model.md): INDIVIDUAL nunca Divergente; ESPELHADO Δ=0 ambos negativos → `Negativo`; prioridade exata das 4 regras; ausência de lado = 0; ordenação problemas-no-topo. **Deve falhar antes da engine estar correta, passar depois.**
- [X] T009 No `conferencia.service.ts`, implementar a query SQL de agregação (CTE `datas`+`base`+pivot via `FILTER`) de [data-model.md §4](./data-model.md) usando `getPool()`; mapear `bigint`→`Number()` (gotcha do projeto); aplicar a engine e produzir `{ resumo, itens }` ordenado. Falha → `throw` logado via `createLogger('stockbridge:conferencia')`.
- [X] T010 Registrar o sub-router em `modules/stockbridge/src/routes/stockbridge.routes.ts`: `import conferenciaRouter` + `router.use(conferenciaRouter)` (junto dos demais, sob o prefixo `/api/v1/stockbridge` com `requireAuth`+`requireModule`).

**Checkpoint**: schema aplicado, engine testada e verde, service retornando dados — base pronta.

---

## Phase 3: User Story 1 — Ver as divergências numa tela (Priority: P1) 🎯 MVP

**Goal**: Tela "Conferência de Estoque" que substitui a varredura da planilha — tabela com `Status Geral`, problemas no topo.

**Independent Test**: como gestor, abrir `/stockbridge/conferencia` e ver a lista ordenada (problemas primeiro) com as 10 colunas; conferir contra a planilha (paridade).

### Tests for User Story 1

- [X] T011 [P] [US1] Supertest em `modules/stockbridge/src/routes/__tests__/conferencia.routes.test.ts`: `GET /api/v1/stockbridge/conferencia` retorna `200 { data:{resumo,itens}, error:null }`, exige gestor+, e o 1º item tem `statusGeral` de problema (casos de [contracts/get-conferencia.md](./contracts/get-conferencia.md#casos-de-teste-supertest--vitest)).

### Implementation for User Story 1

- [X] T012 [US1] Criar `modules/stockbridge/src/routes/conferencia.routes.ts` com `GET /api/v1/stockbridge/conferencia` protegido por `requireGestor`, sem filtros ainda (retorna lista completa + `resumo`), envelope `{data,error}`, log de erro `CONFERENCIA_FAIL`.
- [X] T013 [P] [US1] Criar `apps/web/src/pages/stockbridge/gestor/conferencia/types.ts` (espelho dos tipos da API) e `.../conferencia/format.ts` reaproveitando `fmtKg` (separador pt-BR).
- [X] T014 [US1] Criar `apps/web/src/pages/stockbridge/gestor/ConferenciaEstoquePage.tsx`: `useQuery` para `GET /conferencia`, tabela hand-rolled Tailwind com as 10 colunas, ordenada como vem da API; estados loading/erro/vazio. Sem cores/chips/KPIs ainda (US3).
- [X] T015 [US1] Em `apps/web/src/App.tsx`: adicionar item `{ id:'sb-conferencia-estoque', name:'Conferência de Estoque', path:'/stockbridge/conferencia', icon: <lucide>, roles:['gestor','diretor'] }` em `STOCKBRIDGE_SUB_ITEMS` e a rota `<Route path="conferencia" element={<ConferenciaEstoquePage/>} />` sob `<Route path="stockbridge">`.

**Checkpoint**: US1 funcional e testável — já substitui a planilha (consulta + ordenação). Validar paridade ([quickstart.md](./quickstart.md)).

---

## Phase 4: User Story 2 — Badge de alerta na navegação (Priority: P1)

**Goal**: Bolinha vermelha com a contagem de itens `≠ OK` no menu, estilo aprovações.

**Independent Test**: com posição contendo N problemas, o badge mostra N; zerando, o badge some.

### Tests for User Story 2

- [X] T016 [P] [US2] Supertest em `conferencia.routes.test.ts`: `GET /api/v1/stockbridge/conferencia/contagem` retorna `{ contagem, porStatus, datas }` e `contagem == soma de porStatus == resumo.totalProblemas` (casos de [contracts/get-conferencia-contagem.md](./contracts/get-conferencia-contagem.md#casos-de-teste)).

### Implementation for User Story 2

- [X] T017 [US2] Em `conferencia.service.ts`, adicionar `contarConferencia()` (reusa a mesma CTE/engine, retorna só `{contagem, porStatus, dataPosicaoAcxe, dataPosicaoQ2p, defasagemEntreEmpresas}`) — evita transferir as ~6k linhas.
- [X] T018 [US2] Adicionar `GET /api/v1/stockbridge/conferencia/contagem` (requireGestor) em `conferencia.routes.ts`.
- [X] T019 [US2] Em `apps/web/src/App.tsx`: `useQuery(['stockbridge','conferencia','contagem'])` com `enabled` por papel e `refetchInterval: 30_000` (snippet em [contracts/get-conferencia-contagem.md](./contracts/get-conferencia-contagem.md#consumo-no-frontend-replica-o-badge-de-aprovações)); no `.map` dos sub-itens, `if (s.id==='sb-conferencia-estoque') return {...s, badge: conferenciaCount}`.

**Checkpoint**: badge vermelho aparece/atualiza/some. US1+US2 = MVP completo entregue.

---

## Phase 5: User Story 3 — Filtros, cores e KPIs (Priority: P2)

**Goal**: Ir direto ao problema — chips de filtro, linhas coloridas por severidade, KPI cards no topo.

**Independent Test**: com mix de status, cada chip filtra corretamente e os KPI cards batem com o resumo.

### Tests for User Story 3

- [X] T020 [P] [US3] Estender `conferencia.routes.test.ts`: `?status=problemas` → todos `≠ OK`; `?tipo=INDIVIDUAL` → nenhum `Divergente*`; `?status=xpto` → `400 INVALID_INPUT`.

### Implementation for User Story 3

- [X] T021 [US3] Adicionar validação Zod dos query params (`status`, `tipo`, `codigoEstoque`, `busca`) em `conferencia.routes.ts` e aplicar a filtragem no `conferencia.service.ts` **após a engine** (resumo permanece do universo completo — ver [contracts/get-conferencia.md](./contracts/get-conferencia.md#request--query-params-todos-opcionais-default--sem-filtro)).
- [X] T022 [P] [US3] Na `ConferenciaEstoquePage.tsx`, adicionar chips de filtro de um clique ("Apenas divergentes", "Estoque negativo", "Ignorar OK") ligados ao query param `status` (padrão de chips da `DivergenciasPage.tsx`).
- [X] T023 [P] [US3] Na `ConferenciaEstoquePage.tsx`, codificação por cores por severidade (crítico=vermelho `Divergente e Negativo`; atenção=âmbar `Divergente`/`Negativo`; neutro `OK`).
- [X] T024 [P] [US3] Na `ConferenciaEstoquePage.tsx`, KPI cards (componente `ResumoCard`) com `totalSkusDivergentes`, `somaDiferencaKg`, `totalQuebrasNegativas` vindos de `resumo`.

**Checkpoint**: tela com paridade de eficiência à planilha (filtros + visual).

---

## Phase 6: User Story 4 — Frescor dos dados (Priority: P2)

**Goal**: Mostrar a data de posição ACXE/Q2P e avisar defasagem entre empresas.

**Independent Test**: exibir as duas datas; com datas diferentes, mostrar aviso.

### Implementation for User Story 4

- [X] T025 [US4] Na `ConferenciaEstoquePage.tsx`, exibir `dataPosicaoAcxe`/`dataPosicaoQ2p` (do `resumo`) no cabeçalho e um banner de aviso quando `defasagemEntreEmpresas === true` (FR-015). Dados já vêm do service (T009/T017) — sem mudança de backend.

**Checkpoint**: todas as user stories independentes e funcionais.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T026 [P] Frontend-design-review da `ConferenciaEstoquePage.tsx` (gramática pt-BR, consistência com design system) via agente `frontend-design-reviewer`.
- [X] T027 Rodar `npm test && npm run lint` (Vitest + ESLint incl. `eslint-plugin-boundaries`) e corrigir o que aparecer.
- [X] T028 Executar a **validação de paridade** de [quickstart.md](./quickstart.md): `totalProblemas == 27` (12 Divergente / 11 Negativo / 4 Divergente e Negativo) e spot-check de unidade (PEBD 100 / 11.1). Registrar resultado no card Jira ACXEGDP-198.
- [X] T029 [P] Atualizar `CLAUDE.md`/seção StockBridge com nota curta sobre a feature (fonte = tabelas-base, mapa em `stockbridge.conferencia_local_map`, badge = itens ≠ OK).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (P1)**: sem dependências.
- **Foundational (P2)**: depende do Setup — **bloqueia US1–US4**. Dentro dela: T003→T004 (mesmo arquivo, sequencial); T005/T006 [P]; T007→T008 (engine→teste); T009 depende de T003/T005/T007; T010 depende de T012 existir? Não — T010 só faz `router.use`; pode vir após T012 criar o arquivo. Ajuste: T010 movido para logo após T012 (ver nota).
- **US1 (P3)** e **US2 (P4)**: ambas P1, dependem só da Foundational; podem ser paralelas após T009. US2 reusa o service (T017) e a rota (T012/T018 mesmo arquivo → sequencial).
- **US3 (P5)** / **US4 (P6)**: dependem de US1 (mesma página/rota).
- **Polish (P7)**: por último.

> Nota sobre T010: o `router.use(conferenciaRouter)` exige o arquivo `conferencia.routes.ts` (criado em T012). Ordem efetiva: T012 → T010. Mantido em Foundational por ser plumbing compartilhado por US1+US2.

### Within Each User Story

- Testes antes da implementação (devem falhar primeiro).
- Service antes da rota; rota antes da página; página antes de filtros/cores/KPIs.

### Parallel Opportunities

- T005 e T006 em paralelo (arquivos diferentes).
- T013 em paralelo com o backend de US1.
- US1 e US2 em paralelo após Foundational (cuidado: T012/T018 editam o mesmo `conferencia.routes.ts` → sequencial entre si).
- T022/T023/T024 (US3) em paralelo entre si (mesma página, mas blocos distintos — coordenar para evitar conflito de merge na `ConferenciaEstoquePage.tsx`).

---

## Implementation Strategy

### MVP First (US1 + US2 — ambas P1)

1. Phase 1 (Setup) → Phase 2 (Foundational: migration+seed+schema+engine+testes+service).
2. Phase 3 (US1: lista) → **validar paridade** ([quickstart.md](./quickstart.md)).
3. Phase 4 (US2: badge).
4. **STOP & VALIDATE**: planilha pode ser aposentada após paridade confirmada (SC-001/SC-003).

### Incremental Delivery

US3 (filtros/cores/KPIs) → US4 (frescor) → Polish. Cada uma agrega valor sem quebrar as anteriores.

---

## Notes

- Acesso definido como **gestor+** (decisão confirmada pelo usuário, 2026-06-22) — D9 do [research.md](./research.md).
- Não confundir com a página "Divergências" (feature 009, provisório×OMIE): nomes/ids/rotas distintos (D10).
- Fonte = tabelas-base `tbl_posicaoEstoque_*` (NÃO `vw_posicaoEstoqueUnificada`, que filtra negativos — D1).
- Commit por tarefa ou grupo lógico; Conventional Commits com escopo `(stockbridge)` e referência `ACXEGDP-198`.
- Total: **29 tarefas** — Setup 2, Foundational 8, US1 5, US2 4, US3 5, US4 1, Polish 4.
