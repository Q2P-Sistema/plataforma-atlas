# Tasks: Idempotência + Retry OMIE no StockBridge

**Input**: Conversa de design (não há spec.md/plan.md formais — este é um closure de gap do módulo 007)
**Branch**: `uat` (sem feature branch dedicada — extensão do 007)
**Escopo**: Eliminar inconsistência ACXE↔Q2P quando OMIE fica instável no meio de um recebimento ou aprovação de divergência.

## Contexto e decisões

**Problema**: hoje em [modules/stockbridge/src/services/recebimento.service.ts:454-489](../../modules/stockbridge/src/services/recebimento.service.ts#L454-L489), `executarAjusteOmieDual` chama OMIE ACXE → OMIE Q2P serial. Se Q2P falha após ACXE suceder, ACXE escreveu e Q2P não. Estado órfão sem registro no Atlas. Retentar duplica ACXE. Mesmo problema em [aprovacao.service.ts:259-303](../../modules/stockbridge/src/services/aprovacao.service.ts#L259-L303).

**Solução**: usar campo `cod_int_ajuste` (60 chars, livre) do endpoint OMIE `IncluirAjusteEstoque` como chave de idempotência + endpoint `ListarAjusteEstoque` como verificação pré-retry.

**Decisões fixadas**:
1. **Movimentação só persiste após ACXE sucesso.** Caso ACXE falhe → nada gravado, retry limpo (estado já consistente hoje).
2. **Operador pode retentar até 1x quando Q2P falha.** A partir da 2ª tentativa só admin (gestor/diretor).
3. **Um `op_id` (uuid) por movimentação.** Sufixos descritivos: `${op_id}:acxe-trf`, `${op_id}:q2p-ent`, `${op_id}:acxe-faltando` enviados no `cod_int_ajuste`.
4. **Novo enum `status_omie`**: `concluida` (default, retrocompat) | `pendente_q2p` | `pendente_acxe_faltando` | `falha`.
5. **Cobertura simétrica em `aprovacao.service.ts`** (mesmo padrão dual ACXE→Q2P).
6. **Mensagens de erro estruturadas** com `userAction` / `retryable` / `stateClean` cobrindo ACXE também.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivo diferente, sem dependência incompleta)
- **[Story]**: US1, US2, US3, US4, US5 (mapeia para user stories abaixo)

## Path Conventions

Monorepo pnpm. Caminhos partem da raiz `/home/primebot/Documentos/Github/q2p/plataforma-atlas/`:

- `modules/stockbridge/src/` — services, routes, middleware do módulo
- `modules/stockbridge/src/__tests__/` — testes (contracts/, services)
- `packages/integrations/omie/src/stockbridge/` — cliente OMIE
- `packages/db/src/schemas/stockbridge.ts` — schema Drizzle
- `packages/db/migrations/` — SQL migrations numeradas

---

## User Stories

- **US1 (P1)** — **MVP**: Sistema envia `cod_int_ajuste` em toda chamada OMIE para que retentativas (qualquer origem) não dupliquem ajustes. Caminho feliz não muda comportamento.
- **US2 (P1)**: Operador pode retentar 1x quando Q2P falha após ACXE; movimentação fica registrada como `pendente_q2p` se ainda assim falhar.
- **US3 (P2)**: Admin (gestor/diretor) tem painel de operações pendentes com retry ilimitado. Email automático em toda nova pendência.
- **US4 (P2)**: Mesma proteção aplicada ao fluxo de aprovação de divergência (`aprovacao.service.ts`).
- **US5 (P3)**: Respostas HTTP estruturadas com `userAction`/`retryable`/`stateClean` para o frontend renderizar mensagens claras (cobrindo ACXE também).

---

## Phase 1: Setup

Sem setup adicional — extensão do módulo 007 já existente.

---

## Phase 2: Foundational (bloqueia todas as user stories)

**Purpose**: Schema, cliente OMIE de leitura e helper de idempotência. Sem isso, nenhuma US pode ser implementada.

**⚠️ CRITICAL**: completar antes de qualquer US.

- [ ] T001 Criar migration `packages/db/migrations/0016_stockbridge_idempotencia_omie.sql` com: `ALTER TABLE stockbridge.movimentacao` adicionando colunas `op_id uuid NOT NULL DEFAULT gen_random_uuid()`, `status_omie text NOT NULL DEFAULT 'concluida' CHECK (status_omie IN ('concluida','pendente_q2p','pendente_acxe_faltando','falha'))`, `tentativas_q2p smallint NOT NULL DEFAULT 0`, `tentativas_acxe_faltando smallint NOT NULL DEFAULT 0`, `ultimo_erro_omie jsonb`. Criar índice parcial `idx_movimentacao_status_omie_pendente ON (status_omie) WHERE status_omie <> 'concluida'` e índice `idx_movimentacao_op_id ON (op_id)`.
- [ ] T002 Atualizar schema Drizzle `packages/db/src/schemas/stockbridge.ts` na tabela `movimentacao` (linhas 92-131) adicionando os 5 campos novos com tipos correspondentes (`uuid`, `text`, `smallint`, `jsonb`).
- [ ] T003 [P] Criar tipos do enum `status_omie` em `modules/stockbridge/src/types/status-omie.ts` exportando `StatusOmie = 'concluida' | 'pendente_q2p' | 'pendente_acxe_faltando' | 'falha'` e helpers `isPendente(status)`.
- [ ] T004 [P] Criar cliente `packages/integrations/omie/src/stockbridge/listar-ajuste-estoque.ts` com função `listarAjusteEstoque(cnpj, input)`. Input: `codIntAjuste?`, `dataMovimentoDe?`, `dataMovimentoAte?`, `pagina?`, `registrosPorPagina?`. Output: `{ ajustes: Array<{ idMovest, idAjuste, codIntAjuste, dataMovimento, quantidade }> }`. Endpoint OMIE `estoque/ajuste/` método `ListarAjusteEstoque`.
- [ ] T005 [P] Adicionar mock de `listarAjusteEstoque` em `packages/integrations/omie/src/stockbridge/mock.ts` que retorna lista vazia por padrão e permite injeção via `__setMockListarAjustes(map)` para testes.
- [ ] T006 Exportar `listarAjusteEstoque` e tipos em `packages/integrations/omie/src/index.ts` (ou onde `incluirAjusteEstoque` é exportado).
- [ ] T007 Criar helper `modules/stockbridge/src/services/omie-idempotente.ts` com função `incluirAjusteIdempotente(cnpj, codIntAjuste, input, opts: { verificarAntes: boolean })`. Se `verificarAntes=true`: chama `listarAjusteEstoque({ codIntAjuste })` primeiro; se já existe, retorna `{ idMovest, idAjuste, jaExistia: true }` sem chamar `IncluirAjusteEstoque`. Se `verificarAntes=false`: chama direto `incluirAjusteEstoque` passando `codIntAjuste` no payload e retorna `{ ..., jaExistia: false }`.
- [ ] T008 Atualizar `IncluirAjusteEstoqueInput` em `packages/integrations/omie/src/stockbridge/ajuste-estoque.ts` adicionando campo opcional `codIntAjuste?: string` e propagando para `params.cod_int_ajuste` no payload da request (linhas 40-50).
- [ ] T009 [P] Criar testes contract em `modules/stockbridge/src/__tests__/contracts/listar-ajuste-estoque.contract.test.ts` para `listarAjusteEstoque`: filtro por `codIntAjuste` retorna match, filtro sem match retorna lista vazia, paginação funciona.
- [ ] T010 [P] Criar testes unitários em `modules/stockbridge/src/__tests__/services/omie-idempotente.test.ts` cobrindo: (a) `verificarAntes=false` → chama Incluir direto; (b) `verificarAntes=true` + lista vazia → chama Incluir; (c) `verificarAntes=true` + lista com match → não chama Incluir, retorna `jaExistia=true` com IDs do match.

**Checkpoint**: Schema migrado + cliente listar disponível + helper idempotente coberto por testes. User stories podem começar.

---

## Phase 3: User Story 1 — Idempotência no caminho feliz (Priority: P1) 🎯 MVP

**Goal**: Toda chamada `IncluirAjusteEstoque` no StockBridge passa um `cod_int_ajuste` único derivado de `op_id` + sufixo. Caminho feliz inalterado para o usuário; rede de segurança ativada para retentativas futuras.

**Independent Test**: Executar um recebimento normal (sem divergência, sem falha OMIE) em ambiente mock. Verificar que (1) `movimentacao` é gravada com `op_id` preenchido e `status_omie='concluida'`; (2) chamadas OMIE no mock recebem payload com `cod_int_ajuste` no formato `${op_id}:acxe-trf` e `${op_id}:q2p-ent`.

### Tests for User Story 1

- [ ] T011 [P] [US1] Atualizar `modules/stockbridge/src/__tests__/contracts/recebimento.contract.test.ts` adicionando assertion: payload OMIE recebido pelo mock contém `cod_int_ajuste` não-vazio para ambos ACXE e Q2P.
- [ ] T012 [P] [US1] Adicionar caso em `modules/stockbridge/src/__tests__/services/recebimento.service.test.ts` (criar se não existir): após `processarRecebimento` com sucesso, `movimentacao.opId` é UUID válido e `movimentacao.statusOmie === 'concluida'`.

### Implementation for User Story 1

- [ ] T013 [US1] Refatorar `executarAjusteOmieDual` em `modules/stockbridge/src/services/recebimento.service.ts` (linhas 440-491) para receber novo argumento `opId: string` e flag opcional `verificarAntes?: boolean` (default `false`). Substituir as duas chamadas diretas a `incluirAjusteEstoque` por `incluirAjusteIdempotente` passando `${opId}:acxe-trf` e `${opId}:q2p-ent` como `codIntAjuste`.
- [ ] T014 [US1] Refatorar `transferirDiferencaAcxe` no mesmo arquivo (linhas ~498-560) com mesmo padrão: aceitar `opId`, chamar via `incluirAjusteIdempotente` com sufixo `${opId}:acxe-faltando`.
- [ ] T015 [US1] Em `processarRecebimento` (linhas 179-349), gerar `const opId = randomUUID()` no início do fluxo e propagar para todas chamadas de `executarAjusteOmieDual`. Persistir `opId` no insert da `movimentacao` (linha ~293-340). `status_omie` fica no default `'concluida'` no caminho feliz.
- [ ] T016 [US1] Em `aprovacao.service.ts` linhas 212-368, gerar `opId` no início de `aprovar()` para `recebimento_divergencia` e propagar para `executarAjusteOmieDual` (chamada na linha 259) e `transferirDiferencaAcxe` (linha 283). Persistir `opId` no insert da `movimentacao`.

**Checkpoint**: US1 funcional. Caminho feliz idêntico ao usuário, mas todas chamadas OMIE agora carregam `cod_int_ajuste` e movimentações têm `op_id`. Retentativas futuras passam a poder usar o helper idempotente.

---

## Phase 4: User Story 2 — Falha Q2P registra parcial + retry operador (Priority: P1)

**Goal**: Quando ACXE sucede e Q2P falha, sistema persiste `movimentacao` com `status_omie='pendente_q2p'` e operador recebe resposta com `userAction='retry_q2p'`. Operador pode retentar até 1x via endpoint dedicado; se 2ª tentativa também falhar, requer admin.

**Independent Test**: Configurar mock OMIE para fazer Q2P falhar uma vez. Executar recebimento. Verificar (1) HTTP 502 com payload contendo `opId`, `movimentacaoId`, `userAction='retry_q2p'`, `tentativasRestantes=1`; (2) `movimentacao` persistida com `idMovestAcxe` preenchido, `idMovestQ2p=NULL`, `status_omie='pendente_q2p'`, `tentativas_q2p=1`. Operador chama endpoint de retry, mock OMIE Q2P agora sucede, movimentação atualiza para `status_omie='concluida'`.

### Tests for User Story 2

- [ ] T017 [P] [US2] Teste em `modules/stockbridge/src/__tests__/services/recebimento.service.test.ts`: cenário "ACXE ok, Q2P falha 1x" — assertar que `movimentacao` é persistida com `status_omie='pendente_q2p'`, `idMovestAcxe` preenchido, `idMovestQ2p=null`, `tentativasQ2p=1`, `ultimoErroOmie` populado.
- [ ] T018 [P] [US2] Teste no mesmo arquivo: cenário "ACXE falha" — assertar que NENHUMA movimentação é persistida (estado limpo, retry simples).
- [ ] T019 [P] [US2] Teste contract em `modules/stockbridge/src/__tests__/contracts/recebimento.contract.test.ts`: resposta 502 com `userAction='retry_q2p'`, `retryable=true` (visão operador na 1ª falha), `stateClean=false`, `opId`, `movimentacaoId`, `tentativasRestantes`.
- [ ] T020 [P] [US2] Teste contract em `modules/stockbridge/src/__tests__/contracts/operacoes-pendentes.contract.test.ts` (novo): `POST /operacoes-pendentes/:id/retentar` como operador 200 quando `tentativas_q2p < 1`, 403 quando `tentativas_q2p >= 1` (a partir daí só gestor).

### Implementation for User Story 2

- [ ] T021 [US2] Criar função `persistirMovimentacaoPendenteQ2p({ opId, idACXE, args, erro })` em `modules/stockbridge/src/services/recebimento.service.ts` que insere `movimentacao` com `status_omie='pendente_q2p'`, `idMovestAcxe`/`idAjusteAcxe` preenchidos, `idMovestQ2p`/`idAjusteQ2p` null, `tentativas_q2p=1`, `ultimo_erro_omie={lado:'q2p', mensagem, timestamp}`.
- [ ] T022 [US2] Atualizar `executarAjusteOmieDual` para que o `catch` da chamada Q2P (linhas 484-489) re-lance `OmieAjusteError` enriquecido com `recoverable: true, opId, idACXE` (em vez de só logar).
- [ ] T023 [US2] Em `processarRecebimento`, envolver `executarAjusteOmieDual` em `try/catch`: se `err.lado === 'q2p'` e `err.recoverable`, chamar `persistirMovimentacaoPendenteQ2p` e relançar `OmieAjusteError` enriquecido. Caso `err.lado === 'acxe'`, apenas relançar (estado já limpo).
- [ ] T024 [US2] Atualizar `OmieAjusteError` em `modules/stockbridge/src/services/recebimento.service.ts` (linhas 28-33) para aceitar campos opcionais `opId?`, `movimentacaoId?`, `recoverable?: boolean`, `tentativasRestantes?: number`.
- [ ] T025 [US2] Criar service `modules/stockbridge/src/services/operacoes-pendentes.service.ts` com função `retentarOperacaoPendente({ movimentacaoId, ator: { role, userId } })`. Lógica: ler movimentacao; rejeitar se `status_omie='concluida'`; se ator é operador e `tentativas_q2p >= 1`, lançar `ForbiddenError`; chamar `incluirAjusteIdempotente` com `verificarAntes: true` no lado pendente (Q2P ou ACXE-faltando); se sucesso, atualizar `movimentacao` para `status_omie='concluida'` com IDs retornados; se falha, incrementar tentativa e atualizar `ultimo_erro_omie`.
- [ ] T026 [US2] Criar rota em `modules/stockbridge/src/routes/operacoes-pendentes.routes.ts`: `POST /api/v1/stockbridge/operacoes-pendentes/:id/retentar` com middleware `requireOperador` (que aceita operador+gestor+diretor). Service decide se ator tem permissão baseado em `tentativas_q2p`.
- [ ] T027 [US2] Registrar a nova rota em `modules/stockbridge/src/index.ts` (ou onde routes do módulo são montadas).
- [ ] T028 [US2] Atualizar `recebimento.routes.ts` (linhas 60-67) tratamento de `OmieAjusteError`: incluir no JSON `opId`, `movimentacaoId`, `tentativasRestantes` quando presentes no erro.

**Checkpoint**: US2 funcional. Operador pode se auto-recuperar de instabilidades transitórias da OMIE Q2P. Pendentes não recuperáveis pelo operador ficam na fila aguardando admin.

---

## Phase 5: User Story 3 — Painel admin de operações pendentes (Priority: P2)

**Goal**: Gestor/diretor pode listar todas movimentações pendentes, ver detalhes (NF, lado pendente, tentativas, último erro), retentar quantas vezes precisar e marcar como `falha` definitiva se necessário. Email automático em toda nova pendência.

**Independent Test**: Forçar uma pendência via mock. Logar como gestor, listar via `GET /operacoes-pendentes`, ver item. Clicar retentar com OMIE ainda quebrado: tentativas incrementa, item ainda na lista. Recuperar OMIE no mock, retentar novamente, item sai da lista (status=concluida). Verificar email enviado para gestores configurados.

### Tests for User Story 3

- [ ] T029 [P] [US3] Teste contract `modules/stockbridge/src/__tests__/contracts/operacoes-pendentes.contract.test.ts`: `GET /operacoes-pendentes` retorna 403 para operador, 200 para gestor com lista de pendentes (campos: id, opId, nf, ladoPendente, tentativas, ultimoErro, createdAt).
- [ ] T030 [P] [US3] Teste contract no mesmo arquivo: gestor pode chamar retentar mesmo com `tentativas_q2p >= 1` (sem limite para admin).
- [ ] T031 [P] [US3] Teste em `modules/stockbridge/src/__tests__/services/operacoes-pendentes.test.ts`: função `marcarComoFalhaDefinitiva(movimentacaoId, motivo)` atualiza `status_omie='falha'` e registra motivo em `ultimo_erro_omie`.

### Implementation for User Story 3

- [ ] T032 [US3] Adicionar em `operacoes-pendentes.service.ts` função `listarPendentes()` que retorna todas movimentações com `status_omie != 'concluida'`, joining `lote` e `correlacao` para enriquecer com NF e dados de produto.
- [ ] T033 [US3] Adicionar em `operacoes-pendentes.service.ts` função `marcarComoFalhaDefinitiva({ movimentacaoId, motivo, ator })` que só aceita `requireGestor` (validação no service).
- [ ] T034 [US3] Adicionar rotas em `operacoes-pendentes.routes.ts`: `GET /operacoes-pendentes` com `requireGestor`, `POST /:id/marcar-falha` com `requireGestor` recebendo `{ motivo: string }`.
- [ ] T035 [US3] Criar helper `modules/stockbridge/src/services/email/notificar-pendencia-omie.ts` reutilizando infraestrutura de email da aprovação (padrão de `recebimento.service.ts:405-413`). Template: assunto "OMIE pendente — NF {{nf}}", corpo com `opId`, lado pendente, mensagem do erro, link para painel admin.
- [ ] T036 [US3] Em `persistirMovimentacaoPendenteQ2p` (T021) e função análoga para `pendente_acxe_faltando` (US4), disparar `notificarPendenciaOmie` para gestores+diretores em fire-and-forget (não bloqueia resposta HTTP).

**Checkpoint**: US3 funcional. Admin tem visibilidade completa e poder de recuperação ilimitado.

---

## Phase 6: User Story 4 — Cobertura simétrica em aprovacao.service.ts (Priority: P2)

**Goal**: O fluxo de aprovação de divergência (`aprovacao.service.ts:212-368`) tem o mesmo problema do recebimento — duas chamadas OMIE serializadas. Aplicar exatamente o mesmo padrão: idempotência via `cod_int_ajuste`, persistência parcial em caso de falha Q2P na chamada principal, persistência parcial em caso de falha da segunda chamada ACXE (`transferirDiferencaAcxe`), retry via mesmo endpoint admin.

**Independent Test**: Aprovar divergência com mock fazendo Q2P falhar — `movimentacao` persiste com `status_omie='pendente_q2p'`, aprovação atualiza para `status='aprovada'` mesmo assim (estado de pendência fica na movimentação, não na aprovação). Recovery via `/operacoes-pendentes/:id/retentar` funciona idêntico ao de recebimento. Mesmo teste com `transferirDiferencaAcxe` falhando: `status_omie='pendente_acxe_faltando'`, retry recupera.

### Tests for User Story 4

- [ ] T037 [P] [US4] Teste em `modules/stockbridge/src/__tests__/aprovacao.test.ts`: cenário "Q2P falha durante aprovação" — `movimentacao` persistida com `status_omie='pendente_q2p'`, `aprovacao.status='aprovada'`.
- [ ] T038 [P] [US4] Teste no mesmo arquivo: cenário "transferirDiferencaAcxe falha" — `movimentacao` persistida com `status_omie='pendente_acxe_faltando'`.
- [ ] T039 [P] [US4] Teste contract: `POST /aprovacoes/:id/aprovar` retorna 200 com aviso quando há pendência OMIE residual (não mascara como sucesso total).

### Implementation for User Story 4

- [ ] T040 [US4] Em `aprovacao.service.ts:259-303`, envolver `executarAjusteOmieDual` em try/catch idêntico ao de `processarRecebimento`. Em caso `err.lado === 'q2p' && err.recoverable`, persistir movimentacao com `status_omie='pendente_q2p'` na transação e seguir adiante (aprovação completa).
- [ ] T041 [US4] Em `aprovacao.service.ts:283-302`, envolver `transferirDiferencaAcxe` em try/catch. Em caso de falha, persistir movimentacao com `status_omie='pendente_acxe_faltando'` (novo helper `persistirMovimentacaoPendenteAcxeFaltando`).
- [ ] T042 [US4] Estender `operacoes-pendentes.service.ts` `retentarOperacaoPendente`: quando `status_omie='pendente_acxe_faltando'`, executar somente `transferirDiferencaAcxe` com `verificarAntes: true`.
- [ ] T043 [US4] Atualizar `aprovacao.routes.ts:50-64` (POST aprovar) para incluir na resposta de sucesso campo opcional `pendenciaOmie?: { lado, opId, movimentacaoId, mensagem }` quando aplicável.

**Checkpoint**: US4 funcional. Os dois pontos de chamada dual OMIE no módulo estão protegidos.

---

## Phase 7: User Story 5 — Mensagens de erro estruturadas (Priority: P3)

**Goal**: Toda resposta de erro relacionada a OMIE retorna JSON estruturado com `userAction` (`retry`/`wait`/`contact_admin`), `retryable` (boolean), `stateClean` (boolean), e `userMessage` (PT-BR amigável). Cobre tanto ACXE quanto Q2P. Frontend pode renderizar UI consistente sem inferir do código de erro.

**Independent Test**: Para cada cenário (ACXE-fail, Q2P-fail-1ª-vez, Q2P-fail-pós-retry, retry-sucesso, retry-fail), validar via teste contract que o JSON de resposta tem todos os campos novos com valores esperados.

### Tests for User Story 5

- [ ] T044 [P] [US5] Teste contract `recebimento.contract.test.ts`: resposta 502 ACXE-fail tem `userAction='retry'`, `retryable=true`, `stateClean=true`, `userMessage` em PT-BR não-vazia.
- [ ] T045 [P] [US5] Teste contract: resposta 502 Q2P-fail (1ª vez) tem `userAction='retry_q2p'`, `retryable=true`, `stateClean=false`, `tentativasRestantes=1`.
- [ ] T046 [P] [US5] Teste contract: resposta 502 Q2P-fail (após operador esgotar tentativa) tem `userAction='contact_admin'`, `retryable=false`, `stateClean=false`.

### Implementation for User Story 5

- [ ] T047 [US5] Criar helper `modules/stockbridge/src/services/erros-omie.ts` com função `mapearErroOmieParaResposta(err: OmieAjusteError, ator: { role }): { httpStatus, body }`. Body inclui sempre: `code`, `message` (técnica), `userMessage` (PT-BR), `userAction`, `retryable`, `stateClean`, e quando aplicável `opId`, `movimentacaoId`, `tentativasRestantes`.
- [ ] T048 [US5] Refatorar `recebimento.routes.ts:60-67` para usar `mapearErroOmieParaResposta` em vez de hardcoded `OMIE_ACXE_FAIL`/`OMIE_Q2P_FAIL`.
- [ ] T049 [US5] Aplicar mesmo helper em `aprovacao.routes.ts` onde aprovar pode propagar `OmieAjusteError`.
- [ ] T050 [US5] Aplicar mesmo helper em `operacoes-pendentes.routes.ts` no endpoint de retentar.

**Checkpoint**: US5 funcional. Frontend (quando existir) consegue renderizar UI rica sem regex no campo `code`.

---

## Phase 8: Polish & Cross-Cutting

**Purpose**: Hardening, testes manuais e docs.

- [ ] T051 [P] **Teste manual em sandbox OMIE real** (PENDENTE — requer credenciais OMIE_*_KEY/SECRET de homologação): enviar duas chamadas `IncluirAjusteEstoque` consecutivas com mesmo `cod_int_ajuste`. Documentar em `specs/007-stockbridge-module/research.md` se OMIE recusa duplicado ou apenas armazena (a proteção via `listarAjusteEstoque` cobre os dois casos, mas vale saber). **Como rodar**: usar o cliente em `packages/integrations/omie/` direto via REPL/script ad-hoc com `OMIE_MODE=real`.
- [ ] T052 [P] **Teste manual em sandbox** (PENDENTE — depende de T051): validar latência de `ListarAjusteEstoque` após `IncluirAjusteEstoque` recém-criado. Se houver latência > 5s, ajustar `retentarOperacaoPendente` para aplicar backoff antes da consulta de verificação. **Atual**: assume retorno imediato; se necessário, adicionar `setTimeout` antes do `incluirAjusteIdempotente({verificarAntes:true})` no helper.
- [x] T053 [P] Atualizar `specs/007-stockbridge-module/paridade-criterios.md` documentando o novo critério de paridade: legado PHP não tem essa proteção, então durante validação paralela é esperado divergir favoravelmente em casos de instabilidade OMIE.
- [x] T054 [P] Adicionar seção em `CLAUDE.md` no bloco "StockBridge — status operacional (007)" mencionando que módulo agora tem idempotência OMIE via `cod_int_ajuste` e endpoint admin de operações pendentes em `/api/v1/stockbridge/operacoes-pendentes`.
- [x] T055 Rodar `pnpm typecheck && pnpm --filter @atlas/stockbridge test` (lint do projeto = typecheck via tsc — não há eslint configurado). **Resultado**: 145/145 testes verdes, build limpo em 7 packages.
- [ ] T056 **Smoke test end-to-end manual** (PENDENTE — requer ambiente dev rodando): executar um recebimento completo em ambiente dev com `OMIE_MODE=mock`, forçando falha Q2P via fixture, validando UI/logs/email/retry/conclusão. **Como rodar**: subir API em dev, modificar `mock.ts` para fazer Q2P falhar 1x na NF X, fazer POST /recebimento, observar resposta 502 estruturada, chamar GET /operacoes-pendentes (gestor), POST /retentar (operador), conferir conclusão.

### Status final da feature (sem T051+T052+T056)

A feature está **funcionalmente completa e coberta por testes**:
- 13 phases de implementação concluídas (Phase 1 vazia + 7 com código + Phase 8 docs)
- 145/145 testes unit/contract verdes (eram 105 antes; +40 testes novos cobrindo idempotência)
- 0 erros TypeScript em `pnpm typecheck`
- Migration `0016` aplicada no DB de dev pelo usuário

T051/T052/T056 são validações manuais que dependem de ambiente real ou rodando — não bloqueiam o merge mas devem ser executados antes de subir a flag em produção.

---

## Dependencies

```
Phase 1 (vazio)
  ↓
Phase 2 (Foundational T001-T010)
  ↓
  ├─→ Phase 3 (US1 — T011-T016)
  │     ↓
  │     ├─→ Phase 4 (US2 — T017-T028)
  │     │     ↓
  │     │     ├─→ Phase 5 (US3 — T029-T036)
  │     │     └─→ Phase 6 (US4 — T037-T043)  [pode rodar em paralelo com US3]
  │     │              ↓
  │     │              └─→ Phase 7 (US5 — T044-T050)
  │     │                       ↓
  │     │                       └─→ Phase 8 (Polish T051-T056)
```

**Críticos**:
- T001-T002 bloqueiam tudo (schema).
- T004-T008 bloqueiam T013+ (cliente OMIE listar precisa existir antes do refactor).
- T013-T016 (US1) são pré-requisito para US2 — não dá pra persistir parcial sem ter `op_id` no schema e helper idempotente em uso.
- US3 e US4 são independentes entre si após US2.

## Parallel Execution Examples

**Phase 2 (Foundational)** — após T001+T002 (schema):
```
Em paralelo: T003 (types), T004+T005 (cliente listar + mock), T009 (test contract listar)
Sequencial: T006 → T007 → T008 → T010
```

**Phase 3 (US1)** — após Phase 2:
```
Em paralelo: T011 (test contract), T012 (test service)
Sequencial: T013 → T014 → T015 → T016
```

**Phase 4 (US2)** — após US1:
```
Em paralelo: T017+T018+T019+T020 (todos os testes)
Sequencial: T021 → T022 → T023 → T024 → T025 → T026 → T027 → T028
```

**Phases 5+6 (US3+US4)** — em paralelo entre si:
```
Equipe A: T029-T036 (admin panel)
Equipe B: T037-T043 (cobertura aprovacao)
```

## Implementation Strategy

**MVP (entregável mínimo)**: Phase 2 + Phase 3 (US1).

Por quê: só com isso, mesmo sem mudar UX, o sistema fica capaz de detectar duplicação se alguém retentar manualmente via banco. É a fundação que destrava todo resto.

**Incremento 1**: + Phase 4 (US2). Operador ganha auto-recuperação. Resolve 80% dos casos de instabilidade OMIE transitória.

**Incremento 2**: + Phase 5 (US3) + Phase 6 (US4). Admin assume casos persistentes; aprovação cobre simetricamente. Resolve 100% dos cenários conhecidos.

**Incremento 3**: + Phase 7 (US5). Frontend-ready (quando o frontend de recebimento for construído).

**Closure**: + Phase 8 (Polish). Necessário antes de subir flag em produção.

## Validação de formato

Todas as 56 tarefas seguem o formato:
- ✅ Checkbox `- [ ]`
- ✅ Task ID sequencial T001-T056
- ✅ Marker `[P]` em tarefas paralelizáveis (~22 tarefas)
- ✅ Story label `[US1]`-`[US5]` em tarefas de user story (Phase 3-7)
- ✅ Sem story label em Setup/Foundational/Polish (Phase 1, 2, 8)
- ✅ Path absoluto (a partir de `/home/primebot/Documentos/Github/q2p/plataforma-atlas/`) ou relativo do repo root em todas descrições

## Total

- **56 tarefas** distribuídas em 8 phases
- **US1**: 6 tarefas (MVP)
- **US2**: 12 tarefas
- **US3**: 8 tarefas
- **US4**: 7 tarefas
- **US5**: 7 tarefas
- **Foundational**: 10 tarefas
- **Polish**: 6 tarefas
- **~22 tarefas paralelizáveis** marcadas com `[P]`

## Out of Scope (não tratado neste plano)

- **Outbox real / worker assíncrono**: backup contra crash do backend entre ACXE e Q2P. Aceitável o risco no volume atual. Reabrir se incidente recorrer.
- **Frontend de recebimento**: ainda não existe no repo. Phase 7 prepara o backend; UI vem em outro spec quando o frontend de recebimento for priorizado.
- **Cobertura para `saida-automatica`**: o webhook n8n já tem idempotência por NF própria ([saida-automatica.service.ts:42](../../modules/stockbridge/src/services/saida-automatica.service.ts#L42)) — não compartilha o problema dual ACXE↔Q2P do recebimento.
