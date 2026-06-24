# Tasks: Validações na Busca de NF do Recebimento (cancelada + emitente ACXE)

**Input**: Design documents from `/specs/012-validacao-busca-nf/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/receiving-validation.md)
**Jira**: ACXEGDP-204 + ACXEGDP-205 · **Branch**: `012-validacao-busca-nf`

**Tests**: INCLUÍDOS — o Princípio III (regra de negócio em TS coberta por Vitest) e os critérios de sucesso (SC-001…SC-007) exigem teste da engine `validarNfRecebivel` (Vitest) e das rotas (Supertest).

**Organization**: tarefas agrupadas por user story. **MVP = US1 + US2** (ambas P1 — os dois filtros pedidos).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência pendente)
- **[Story]**: US1 (cancelada) · US2 (emitente ACXE) · US3 (sem regressão) · US4 (indeterminado/fail-open)
- Caminhos absolutos a partir da raiz `/home/primebot/Documentos/Github/q2p/plataforma-atlas`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: confirmar pré-condições. Branch, módulo `modules/stockbridge`, pacote `packages/integrations/omie` e deps já existem — setup é mínimo.

- [X] T001 Confirmar `MODULE_STOCKBRIDGE_ENABLED=true` e `OMIE_MODE=mock` no `.env` local e `pnpm install` atualizado na raiz do repo.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: tipo estendido da NF + engine pura de validação que **todas as stories compartilham**. Espelha o padrão da feature 011 (engine em Foundational).

**⚠️ CRITICAL**: nenhuma user story começa antes desta fase.

- [X] T002 [P] Estender `packages/integrations/omie/src/stockbridge/nf.ts`: adicionar a `RawConsultarNF` os blocos de cancelamento (`ide.dCan`/`ide.dInut` + denegação `cDeneg`) e de emitente/tipo (`ide.tpNF`, emitente/`nfEmitInt`); estender `ConsultarNFResponse` com `cancelada: boolean` (OR dos sinais), `sinaisCancelamento`, `tpNF?`, `cnpjEmitente?` e mapear tudo na função `consultarNF` (conforme [data-model.md §1](./data-model.md)). Campo ausente ⇒ deixar `undefined` (cai em indeterminado downstream).
- [X] T003 [P] Estender `packages/integrations/omie/src/stockbridge/mock.ts` (`mockConsultarNF`): produzir, por convenção de número de NF, os 4 cenários — válida ACXE (atual), **cancelada** (`...90`), **entrada de terceiro** (`...91`, `tpNF` entrada / `cnpjEmitente`≠ACXE), **indeterminada** (`...92`, sem `tpNF`/`cnpjEmitente`/sinais) — conforme [quickstart.md §2](./quickstart.md).
- [X] T004 Criar `modules/stockbridge/src/services/nf-validacao.service.ts`: tipo união `ResultadoValidacaoNf` e a função **pura** `validarNfRecebivel(nf, contexto)` com a lógica completa (avaliar **cancelamento antes de emitente**; emitente só no contexto `acxe`), conforme [data-model.md §2](./data-model.md). CNPJ ACXE para comparação vem de constante/config do cliente OMIE, sem hardcode espalhado. Depende de T002.
- [X] T005 Criar `modules/stockbridge/src/services/__tests__/nf-validacao.test.ts` (Vitest) cobrindo a matriz de decisão de [contracts/receiving-validation.md §3](./contracts/receiving-validation.md): cancelada→bloqueada/cancelada; acxe+entrada-terceiro→bloqueada/nao_emitida_acxe; acxe+saída-ACXE→ok; q2p não bloqueia por emitente; NF ACXE cancelada→cancelada (não emitente); sinal ausente→indeterminada. **Falha antes da engine correta, passa depois.** Depende de T004, T003.

**Checkpoint**: tipo da NF expõe cancelamento+emitente; engine testada e verde. Base pronta.

---

## Phase 3: User Story 1 — Bloquear recebimento de NF cancelada (Priority: P1) 🎯 MVP

**Goal**: NF cancelada não aparece como recebível e não pode ser confirmada; operador vê o motivo.

**Independent Test**: buscar a NF de teste "cancelada" → mensagem de bloqueio na busca; tentar confirmar → 422, nenhum lote/movimentação/ajuste criado.

- [X] T006 [US1] Adicionar a classe de erro `NotaFiscalCanceladaError` em `modules/stockbridge/src/services/recebimento.service.ts` (junto de `NotaFiscalJaProcessadaError`), carregando `nf` e `userMessage` pt-BR.
- [X] T007 [US1] Em `getFilaOmie` (`modules/stockbridge/src/services/recebimento.service.ts`, após `consultarNF`), chamar `validarNfRecebivel(omieData, { cnpj })` e despachar: `bloqueada/cancelada`→`throw NotaFiscalCanceladaError`; demais status→seguir o fluxo atual (interino seguro até US2/US4). Estabelece o **ponto de integração** da validação.
- [X] T008 [US1] Em `processarRecebimento` (`recebimento.service.ts`, logo após `consultarNF` ~L261, **antes** de correlação/escritas/ajuste OMIE), aplicar a MESMA `validarNfRecebivel` e `throw NotaFiscalCanceladaError` quando cancelada — garantindo zero escrita (FR-002/FR-008).
- [X] T009 [US1] Mapear `NotaFiscalCanceladaError`→**HTTP 422** `{ data:null, error:{ code:'NF_CANCELADA', userMessage } }` em `modules/stockbridge/src/routes/fila.routes.ts` e `modules/stockbridge/src/routes/recebimento.routes.ts` (padrão dos demais erros tipados).
- [X] T010 [P] [US1] `apps/web/src/pages/stockbridge/operador/FilaOmiePage.tsx`: exibir a `userMessage` de `NF_CANCELADA` ao buscar (não listar a NF como recebível).
- [X] T011 [P] [US1] `apps/web/src/pages/stockbridge/operador/ConferenciaModal.tsx`: exibir a `userMessage` de `NF_CANCELADA` na confirmação (defesa em profundidade).
- [X] T012 [US1] Supertest em `modules/stockbridge/src/routes/__tests__/recebimento-validacao.routes.test.ts`: `GET /fila` NF cancelada→422 `NF_CANCELADA`; `POST /recebimento` NF cancelada→422 e **assert de nenhuma escrita** (sem lote/movimentação/ajuste) — [contracts §4](./contracts/receiving-validation.md) #1, #4.

**Checkpoint**: NF cancelada bloqueada em busca e confirmação, com mensagem; nenhuma escrita no bloqueio.

---

## Phase 4: User Story 2 — Considerar somente NFs emitidas pela ACXE (Priority: P1)

**Goal**: no contexto ACXE, NF de entrada de terceiro com número coincidente é bloqueada; só a NF emitida pela ACXE é recebível. Q2P inalterado.

**Independent Test**: buscar (contexto acxe) um número que é entrada de terceiro → mensagem `não emitida pela ACXE`; mesma busca no contexto q2p → comportamento atual (não bloqueia).

- [X] T013 [US2] Adicionar a classe `NotaFiscalNaoEmitidaPelaAcxeError` em `modules/stockbridge/src/services/recebimento.service.ts` (junto das demais), com `nf` e `userMessage` pt-BR.
- [X] T014 [US2] Estender o despacho em `getFilaOmie` e `processarRecebimento` (`recebimento.service.ts`): `bloqueada/nao_emitida_acxe`→`throw NotaFiscalNaoEmitidaPelaAcxeError`. Reaproveita o ponto de integração de T007/T008. Depende de US1.
- [X] T015 [US2] Mapear o erro→**HTTP 422** `code:'NF_NAO_EMITIDA_ACXE'` em `fila.routes.ts` e `recebimento.routes.ts`.
- [X] T016 [P] [US2] `apps/web/.../FilaOmiePage.tsx`: exibir a `userMessage` de `NF_NAO_EMITIDA_ACXE` na busca.
- [X] T017 [P] [US2] `apps/web/.../ConferenciaModal.tsx`: exibir a `userMessage` de `NF_NAO_EMITIDA_ACXE` na confirmação.
- [X] T018 [US2] Estender o Supertest (`recebimento-validacao.routes.test.ts`): acxe + entrada-de-terceiro→422 `NF_NAO_EMITIDA_ACXE`; **q2p NÃO bloqueia** por emitente; **NF ACXE cancelada→`NF_CANCELADA`** (cancelamento antes de emitente) — [contracts §4](./contracts/receiving-validation.md) #2, #6, #7.

**Checkpoint**: os dois filtros (US1+US2) ativos — MVP completo. Colisão de numeração resolvida no contexto ACXE.

---

## Phase 5: User Story 3 — Não regredir o recebimento de NFs válidas (Priority: P2)

**Goal**: garantir que NFs válidas e emitidas pela ACXE continuam recebíveis (sem falso bloqueio).

**Independent Test**: buscar e receber a NF de teste "válida ACXE" → fluxo normal, sem bloqueio.

- [X] T019 [US3] Supertest/integration (`recebimento-validacao.routes.test.ts`): NF válida ACXE passa em `GET /fila` e `POST /recebimento` exatamente como hoje; caso "já processada"→`data:[]` (idempotência) preservado — SC-004, [contracts §4](./contracts/receiving-validation.md) #3.

**Checkpoint**: regressão coberta — nenhuma NF legítima deixou de ser recebível.

---

## Phase 6: User Story 4 — Comportamento quando o dado é indeterminado (Priority: P3)

**Goal**: quando cancelamento/emitente não puder ser determinado, liberar o recebimento (fail-open) e alertar o admin/gestor.

**Independent Test**: buscar/receber a NF de teste "indeterminada" → recebe normalmente; alerta ao admin disparado e evento logado.

- [X] T020 [US4] Adicionar `enviarAlertaNfIndeterminada({ nf, cnpj, motivo })` em `modules/stockbridge/src/services/notificacao.service.ts`, espelhando `enviarAlertaProdutoSemCorrelato` (e-mail via `sendEmail`/`getAdminEmail`, fora de transação, try/catch logado).
- [X] T021 [US4] Implementar o ramo `indeterminada` do despacho em `getFilaOmie` e `processarRecebimento` (`recebimento.service.ts`): **seguir** o recebimento (fail-open), chamar `enviarAlertaNfIndeterminada` e logar `nf_indeterminada` via `createLogger` (FR-010). Depende de US1 (ponto de integração).
- [X] T022 [US4] Estender o Supertest: NF indeterminada→200/201 (segue) + **spy** confirmando `enviarAlertaNfIndeterminada` chamado + asserção de log — [contracts §4](./contracts/receiving-validation.md) #5.

**Checkpoint**: indeterminado não trava operação e sempre notifica o admin (SC-007).

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T023 [P] Documentar em comentário (no `nf-validacao.service.ts` e/ou no ponto de wiring em `recebimento.service.ts`) que a leitura de cancelamento/emitente reaproveita a **exceção ao Princípio II** já existente da chamada `consultarNF` (gate II: exceção deve estar documentada no service) — ver [research.md §3](./research.md).
- [ ] T024 [P] Rodar a validação do [quickstart.md §3](./quickstart.md) em dev (mock): os 4 cenários pela UI.
- [ ] T025 Validação contra **OMIE real em UAT** ([quickstart.md §4](./quickstart.md)): confirmar R1 (campos de cancelamento) e R2 (colisão por número) com NFs reais; registrar o resultado no roteiro de paridade da validação paralela do StockBridge (Princípio V — Atlas mais estrito que o legado é melhoria intencional).
- [X] T026 [P] Gate do repo: `npm test && npm run lint` verdes na raiz (typecheck + Vitest + boundaries).

---

## Dependencies & Execution Order

### Phase Dependencies
- **Setup (T001)** → **Foundational (T002–T005)** → **User Stories**.
- **Foundational bloqueia tudo**: sem o tipo estendido (T002) e a engine (T004), nenhuma story funciona.

### User Story Dependencies
- **US1 (P1)** estabelece o **ponto de integração** da validação nos dois call-sites (T007/T008). Pode começar logo após Foundational.
- **US2 (P1)** e **US4 (P3)** **estendem o mesmo despacho** introduzido em US1 (mesmos arquivos `recebimento.service.ts` + rotas) → dependem de US1 estar wired. Cada uma permanece **independentemente testável** pelo seu cenário.
- **US3 (P2)** depende só do Foundational (ramo `ok` já existe) — é puramente teste de regressão, independente das demais.

### Within Each Story
- Erro tipado → wiring no service → mapeamento na rota → frontend → testes.
- Tarefas de frontend (`FilaOmiePage` vs `ConferenciaModal`) são `[P]` entre si (arquivos diferentes).

### Parallel Opportunities
- Foundational: T002 e T003 em paralelo (`nf.ts` vs `mock.ts`).
- US1: T010 ∥ T011 (telas diferentes). US2: T016 ∥ T017.
- Polish: T023, T024, T026 em paralelo.
- ⚠️ NÃO paralelizar T007/T008/T014/T021: editam o mesmo `recebimento.service.ts` (mesmo despacho) — são sequenciais.

---

## Parallel Example: Foundational
```bash
# T002 e T003 tocam arquivos diferentes — em paralelo:
Task: "Estender tipos+mapping em packages/integrations/omie/src/stockbridge/nf.ts"
Task: "Estender fixtures em packages/integrations/omie/src/stockbridge/mock.ts"
```

## Implementation Strategy

### MVP (os dois filtros pedidos)
1. Setup (T001) → Foundational (T002–T005).
2. US1 (T006–T012) → bloqueio de cancelada funcional e testado.
3. US2 (T013–T018) → bloqueio de não-ACXE. **STOP & VALIDATE**: MVP = os dois filtros que o usuário pediu.

### Incremental
4. US3 (T019) → blindagem contra regressão.
5. US4 (T020–T022) → tratamento fail-open + alerta admin.
6. Polish (T023–T026) → doc da exceção, quickstart, **validação UAT contra OMIE real** (crítica), gate verde.

### Notas
- Verificar que os testes falham antes de implementar a engine/wiring.
- Commit por tarefa ou grupo lógico; PR único fecha ACXEGDP-204 + ACXEGDP-205.
- As incertezas R1/R2 só fecham em UAT (T025) — DEV é mock; fail-open (US4) é a rede de segurança até lá.
