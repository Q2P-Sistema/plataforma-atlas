---
description: "Task list — Fila de Recebimento em Modo Real + Correção de Granularidade Multi-Produto"
---

# Tasks: Fila de Recebimento em Modo Real + Correção de Granularidade Multi-Produto

**Input**: Design documents from `/specs/014-fila-recebimento-real/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/fila-real.md)

**Tests**: incluídos — a constituição (Princípio III) exige cobertura Vitest, e regressão single-item é requisito explícito da spec (SC-005).

**Organização**: por user story. US1 (fila) e US2 (correção de granularidade) compartilham a Foundational (a checagem "produto pendente"), mas depois disso são **independentes entre si** — arquivos diferentes (US1 toca `recebimento.service.ts`/`fila.routes.ts`/UI; US2 toca `cockpit.service.ts`/`cockpit-executivo.service.ts`/`pendencias-fiscais.service.ts`/`nf-pedido-mapa.service.ts`) — podem ser feitas em paralelo se houver 2 desenvolvedores. US3 estende US1 (mesma query da fila).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência pendente)
- **[Story]**: US1 / US2 / US3

## Path Conventions

`modules/stockbridge/`, `apps/web/`.

---

## Phase 1: Setup

- [ ] T001 Rodar a suíte `@atlas/stockbridge` atual como baseline verde (`pnpm --filter @atlas/stockbridge test`) e anotar a contagem — guarda de regressão.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: a checagem "produto pendente" que TODAS as stories usam.

**⚠️ CRITICAL**: nenhuma story começa antes desta fase fechar.

- [ ] T002 Estender `recebidaViaMovimentacaoSql` em `modules/stockbridge/src/services/fiscal-recebida-sql.ts` com parâmetro opcional `produtoExpr` — sem o parâmetro, comportamento idêntico ao atual (compatibilidade retroativa para qualquer uso que não precise de granularidade).
- [ ] T003 Nova função `produtoPendenteSql({nfExpr, produtoExpr, nIdRecebExpr})` em `fiscal-recebida-sql.ts` combinando as 3 fontes (n_id_receb OMIE por NF, legado por NF, Atlas por produto) — ver [data-model.md](./data-model.md) §1.
- [ ] T004 [P] Testes unitários de `produtoPendenteSql`/`recebidaViaMovimentacaoSql(nf, produto)` em `modules/stockbridge/src/__tests__/` — produto com movimentação daquele produto específico → não pendente; produto sem movimentação (mesmo com outro produto da mesma NF recebido) → pendente; match via legado/n_id_receb → todos os produtos da NF contam como recebidos (limitação documentada).

**Checkpoint**: checagem por produto pronta e testada isoladamente.

---

## Phase 3: User Story 1 - Ver e agir sobre a fila de recebimento pendente (Priority: P1) 🎯 MVP

**Goal**: operador abre o recebimento sem NF e vê a lista real de pendências mapeadas.

**Independent Test**: abrir a tela sem NF → lista aparece; clicar num item → busca daquela NF carrega automaticamente.

### Tests for User Story 1

- [ ] T005 [P] [US1] Teste Supertest — `GET /fila` sem `nf` devolve itens reais (banco com mapa/filhote/espelho mockados) em vez de `[]`.
- [ ] T006 [P] [US1] Teste — NF single-item pendente aparece na fila com `produtosTotal=1, produtosPendentes=1`.
- [ ] T007 [P] [US1] Teste — NF totalmente recebida não aparece na fila.

### Implementation for User Story 1

- [ ] T008 [US1] Implementar o Caso 2 de `getFilaOmie` (hoje `return []`) em `modules/stockbridge/src/services/recebimento.service.ts` — query sobre `nf_pedido_mapa`/`nf_pedido_filhote` (ativos) cruzada com `tbl_nf_header_ACXE`/`tbl_nf_itens_ACXE`, usando `produtoPendenteSql` (T003) por produto, agregada em `FilaQueueItem` (ver [data-model.md](./data-model.md) §2).
- [ ] T009 [US1] Confirmar que o guard existente de `GET /fila` (`requireOperador` + `requireArmazemVinculado`, em `modules/stockbridge/src/routes/fila.routes.ts`) cobre o caminho sem `nf` sem mudança — não é rota nova, é o mesmo endpoint.
- [ ] T010 [US1] UI — nova seção em `apps/web/src/pages/stockbridge/operador/FilaOmiePage.tsx` no lugar do placeholder `{!queryKey.nf && (...)}`: `useQuery` buscando `GET /fila` sem parâmetros quando não há busca ativa, renderizando a lista (NF, pedido, produtos pendentes, dias desde emissão) com estado de "fila vazia".
- [ ] T011 [US1] UI — clique num item da fila preenche `buscaNf` e chama `handleBuscar` (já existe) — sem abrir `ConferenciaModal` diretamente (ver [research.md](./research.md) D5).

**Checkpoint**: MVP — fila real funciona ponta-a-ponta. **PARAR e VALIDAR** (quickstart §1).

---

## Phase 4: User Story 2 - Cockpit e Pendências Fiscais não subestimam recebimento parcial (Priority: P2)

**Goal**: os 5 pontos existentes passam a usar a checagem por produto; NF single-item fica bit-a-bit idêntica.

**Independent Test**: NF de 3 produtos, 2 recebidos e 1 pendente → Cockpit conta o pendente; Pendências Fiscais mostra parcial; mapa permanece ativo.

### Tests for User Story 2

- [ ] T012 [P] [US2] Teste regressão single-item — `cockpit.service.ts` (3 usos: L260-261, L382-383, L405-406) produz resultado idêntico ao pré-correção para NF de 1 produto.
- [ ] T013 [P] [US2] Teste regressão single-item — `cockpit-executivo.service.ts` (L424-425).
- [ ] T014 [P] [US2] Teste regressão single-item — `pendencias-fiscais.service.ts` (L181-182, L209-210).
- [ ] T015 [P] [US2] Teste regressão single-item — `nf-pedido-mapa.service.ts` (auto-desativação, L108-109).
- [ ] T016 [P] [US2] Teste multi-produto parcial — `cockpit.service.ts` Parte A (`transito_recebido_filhotes`) não subtrai o produto pendente do trânsito local.
- [ ] T017 [P] [US2] Teste multi-produto parcial — `cockpit.service.ts` Parte B (fallback sem-mapa) não some da lista com o produto ainda pendente.
- [ ] T018 [P] [US2] Teste multi-produto parcial — `cockpit-executivo.service.ts` não conta o produto pendente como recebido no `transito_recebido_filhotes` valorizado.
- [ ] T019 [P] [US2] Teste multi-produto parcial — `pendencias-fiscais.service.ts` marca a filhote como parcial (não recebida), identificando o produto que falta.
- [ ] T020 [P] [US2] Teste multi-produto parcial — auto-desativação do mapa NÃO desativa enquanto houver produto pendente em qualquer filhote.

### Implementation for User Story 2

- [ ] T021 [US2] Corrigir os 3 usos em `modules/stockbridge/src/services/cockpit.service.ts` (L260-261, L382-383, L405-406) para `recebidaViaMovimentacaoSql(nf, produto)` com o produto da linha (`i.n_cod_prod`).
- [ ] T022 [US2] Corrigir o uso em `modules/stockbridge/src/services/cockpit-executivo.service.ts` (L424-425) — a CTE já agrupa por produto (`GROUP BY ... i.n_cod_prod`), só o filtro precisa acompanhar.
- [ ] T023 [US2] Corrigir os 2 usos em `modules/stockbridge/src/services/pendencias-fiscais.service.ts` (L181-182, L209-210); estender `FilhoteItem` com `produtosTotal`/`produtosRecebidos` (ver [data-model.md](./data-model.md) §3); `recebida` só `true` quando todos os produtos estão recebidos.
- [ ] T024 [US2] Corrigir a auto-desativação do mapa em `modules/stockbridge/src/services/nf-pedido-mapa.service.ts` (L108-109) para considerar produto, não só NF.

**Checkpoint**: os 5 pontos corrigidos; single-item sem regressão; multi-produto parcial correto em todos.

---

## Phase 5: User Story 3 - A fila mostra só o que é acionável (Priority: P3)

**Goal**: NF mãe, cancelada, ou não sincronizada nunca aparecem na fila; ordenação por mais antiga primeiro.

**Independent Test**: mapa com mãe + 1 filhote cancelada + 1 filhote sem `n_id_nf` + 1 filhote válida pendente → só a válida aparece.

### Tests for User Story 3

- [ ] T025 [P] [US3] Teste — NF mãe nunca aparece na fila (a query nunca itera `nf_mae` como item).
- [ ] T026 [P] [US3] Teste — NF filhote cancelada/deletada no OMIE não aparece.
- [ ] T027 [P] [US3] Teste — NF filhote sem `n_id_nf` (não sincronizada) não aparece.
- [ ] T028 [P] [US3] Teste — itens da fila vêm ordenados por data de emissão mais antiga primeiro.

### Implementation for User Story 3

- [ ] T029 [US3] Confirmar/ajustar os filtros na query de T008 — `nfValidaSql` (cancelada/deletada, já usado por Pendências Fiscais) + `n_id_nf IS NOT NULL` + `ORDER BY d_emi ASC`.

**Checkpoint**: fila só mostra o acionável.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T030 [P] Atualizar a seção StockBridge do `CLAUDE.md` — fila real (fonte de dados, exclusões) + granularidade por produto corrigida nos 5 pontos.
- [ ] T031 Rodar `frontend-design-reviewer` sobre o diff de `FilaOmiePage.tsx` (nova seção da fila).
- [ ] T032 Validação quickstart.md — cenário manual de recebimento parcial (mock/dev) + `pnpm --filter @atlas/stockbridge test` + `tsc --noEmit` verdes.
- [ ] T033 `pnpm --filter @atlas/web build` verde.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sem dependência.
- **Foundational (Phase 2)**: depende do Setup; **BLOQUEIA** US1 e US2 (ambas consomem `produtoPendenteSql`/`recebidaViaMovimentacaoSql` estendida).
- **US1 (Phase 3)**: depende só da Foundational. MVP.
- **US2 (Phase 4)**: depende só da Foundational. **Independente de US1** — arquivos diferentes, pode rodar em paralelo se houver capacidade.
- **US3 (Phase 5)**: depende de US1 (estende a mesma query da fila, T008).
- **Polish (Phase 6)**: depois das stories desejadas.

### Parallel Opportunities

- Foundational: T004 é o único teste, roda sozinho após T002/T003 (sequenciais, mesmo arquivo).
- **US1 e US2 podem rodar em paralelo** (arquivos completamente distintos) — diferente da feature 013, aqui não há disputa de arquivo entre stories.
- Dentro de US2: T012-T020 (todos os testes) são paralelos entre si (arquivos/casos distintos); T021-T024 (implementação) tocam arquivos distintos entre si, também paralelizáveis.

---

## Parallel Example: User Story 2 (todos os testes de uma vez)

```bash
T012  cockpit.service.ts — regressão single-item
T013  cockpit-executivo.service.ts — regressão single-item
T014  pendencias-fiscais.service.ts — regressão single-item
T015  nf-pedido-mapa.service.ts — regressão single-item
T016  cockpit.service.ts — multi-produto parcial (Parte A)
T017  cockpit.service.ts — multi-produto parcial (Parte B)
T018  cockpit-executivo.service.ts — multi-produto parcial
T019  pendencias-fiscais.service.ts — multi-produto parcial
T020  nf-pedido-mapa.service.ts — multi-produto parcial
```

---

## Implementation Strategy

### MVP First (US1)

1. Setup → Foundational (CRÍTICA) → US1.
2. **PARAR e VALIDAR** US1 (quickstart §1) — fila real funciona.
3. US2 (correção de granularidade) e US3 (exclusões da fila) podem seguir em qualquer ordem a partir daqui.

### Incremental Delivery

1. Foundational → checagem por produto pronta e testada isoladamente.
2. US1 → fila real → validar → já resolve o pedido original (operador não depende mais de saber NF de cor).
3. US2 → correção de granularidade → validar → Cockpit/Pendências Fiscais confiáveis mesmo com recebimento parcial.
4. US3 → polimento da fila (exclusões, ordenação).
5. Polish → CLAUDE.md, design review, build.

---

## Notes

- Sem migration nesta feature — nenhuma tarefa de banco além de queries.
- Regressão single-item é requisito formal (SC-005) — todo teste de correção (US2) tem par: "antes/depois idêntico para 1 produto" + "correto para N produtos parcial".
- `movimentacao_legado` e `n_id_receb` permanecem por NF (limitação de dado, não bug) — nenhuma tarefa tenta corrigir esses dois sinais para granularidade de produto (ver research.md D3).
- Commit após cada tarefa ou grupo lógico; PR base `uat`; `git branch --show-current` antes de push.
