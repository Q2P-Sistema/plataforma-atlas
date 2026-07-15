---
description: "Task list — Recebimento de NF de Importação com Múltiplos Produtos"
---

# Tasks: Recebimento de NF de Importação com Múltiplos Produtos

**Input**: Design documents from `/specs/013-importacao-multi-produto/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/recebimento-multi-item.md)

**Tests**: incluídos — a constituição (Princípio III) exige cobertura Vitest para fluxos dual-CNPJ/NF, e o [quickstart.md](./quickstart.md) §2 lista os casos.

**Organização**: por user story (P1→P3). Nota de realidade: as três stories refatoram o mesmo serviço (`recebimento.service.ts`), então rodam **sequencialmente** (P1→P2→P3), não em paralelo entre si — a independência é de **testabilidade** (cada story tem teste próprio), não de arquivo.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência pendente)
- **[Story]**: US1 / US2 / US3 (mapeia as stories do spec.md)

## Path Conventions

Monorepo modular: `packages/integrations/omie/`, `packages/db/`, `modules/stockbridge/`, `apps/web/`.

---

## Phase 1: Setup

**Purpose**: baseline de regressão antes de mexer.

- [x] T001 Rodar a suíte single-item atual na branch como baseline verde (`pnpm --filter @atlas/stockbridge test` + `pnpm --filter @atlas/integrations-omie test`) e anotar a contagem — é a guarda de regressão do caso N=1.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: plumbing por-produto que TODAS as stories usam.

**⚠️ CRITICAL**: nenhuma story começa antes desta fase fechar.

- [x] T002 [P] Criar migration `packages/db/migrations/0046_stockbridge_idempotencia_entrada_por_produto.sql` — DROP do `movimentacao_nf_idempotencia_idx`; criar `movimentacao_nf_entrada_idempotencia_idx` UNIQUE `(nota_fiscal, empresa, produto_codigo_acxe)` WHERE `entrada_nf AND ativo AND empresa IS NOT NULL AND produto_codigo_acxe IS NOT NULL`; criar `movimentacao_nf_saida_idempotencia_idx` UNIQUE `(nota_fiscal, empresa)` WHERE `saida_automatica AND ativo AND empresa IS NOT NULL`. Cabeçalho Antes/Agora/Porque (skill `stockbridge-migration`). Sem tabela nova → sem trigger nova.
- [x] T003 [P] Sincronizar o schema Drizzle `packages/db/src/schemas/stockbridge.ts` — refletir os dois índices novos na definição de `movimentacao` (remover o índice único antigo, adicionar os dois).
- [x] T004 [P] Reestruturar `consultarNF` em `packages/integrations/omie/src/stockbridge/nf.ts` — `ConsultarNFResponse` = `{ nNF, cChaveNFe, dEmi, vNF, nCodCli, cRazao, itens: ItemNF[] }`; mapear `raw.det[]` → `itens[]`; **remover** o `throw NotaFiscalMultiItemError` (e a classe, se sem outros usos após a limpeza da Phase 6).
- [x] T005 [P] Fixtures multi-item em `packages/integrations/omie/src/stockbridge/mock.ts` — NF de 3 produtos (todos correlacionáveis); NF com 1 produto sem correlato; NF com 1 item divergente; NF que força erro de Q2P num item. `mockConsultarNF` devolve `itens[]`.
- [x] T006 [P] Atualizar `packages/integrations/omie/src/__tests__/nf.test.ts` — asserts sobre `itens[]` (N itens) e ausência de throw em `det.length>1`.
- [x] T007 Função pura de **rateio** em `modules/stockbridge/src/services/recebimento.service.ts` — `ratearValorNf(vNF, itens): valorItem[]` em `Decimal`: `peso_i = vUnCom_i×qCom_i`, `valorItem_i = vNF×peso_i/Σ`, com **reconciliação de resíduo** no último item para `Σ = vNF` exato. Deve reduzir a `valorItem = vNF` quando N=1.
- [x] T008 Idempotência por-produto em `modules/stockbridge/src/services/recebimento.service.ts` — `nfJaProcessada` → `produtoDaNfJaRecebido(nf, empresa, produtoAcxe)` (entrada_nf ativa + lote aberto **daquele produto**; legado mantém checagem por-NF); `contarTentativasAnteriores` por produto; `isViolacaoIdempotenciaNf` aceita `movimentacao_nf_entrada_idempotencia_idx`.
- [x] T009 Extrair `processarItemRecebimento(item, cabecalhoNf, valorItemRateado, ctx)` de `modules/stockbridge/src/services/recebimento.service.ts` — a unidade por-item do caminho limpo (correlação → `executarAjusteOmieDual` → persistir `lote` provisório + `movimentacao`), preservando byte-a-byte o comportamento single-item (opId por produto já existe).
- [x] T010 Esqueleto do orquestrador `processarRecebimento(input: { nf, cnpj, itens[] })` em `modules/stockbridge/src/services/recebimento.service.ts` — normaliza NF; validação fiscal (cancelada/emitente, reuso); **Portão 1** (loop de validação de todos os itens — completado na US3); **Portão 2** (loop best-effort chamando `processarItemRecebimento` — caminho limpo na US1, divergência na US2); monta `ProcessarRecebimentoResult` (`itens[]` + `resumo`).
- [x] T011 [P] Rota `POST /recebimento` em `modules/stockbridge/src/routes/recebimento.routes.ts` — schema Zod `{ nf, cnpj:'acxe', itens: [{ produto_codigo_acxe, quantidade_input, unidade_input, localidade_id, observacoes?, tipo_divergencia? }].min(1) }` (produto único no array); mapear snake→camel; resposta `201 { data:{ nf, itens, resumo } }`.
- [x] T012 [P] Rota `GET /fila` em `modules/stockbridge/src/routes/fila.routes.ts` — devolver os N itens da NF (a lista já é array; remover a suposição de 1). `custoBrl` por item = valor rateado.

**Checkpoint**: infra por-produto pronta; consultarNF expõe itens[]; idempotência por produto; orquestrador esqueleto compila.

---

## Phase 3: User Story 1 - Receber NF com vários produtos (Priority: P1) 🎯 MVP

**Goal**: destravar e receber uma NF multi-item cujas quantidades conferem — N entradas independentes em ACXE+Q2P, cada uma com seu valor.

**Independent Test**: NF real (ou mock) com 2–3 produtos, quantidades = NF → confirmar → N entradas provisórias, valores por linha, `Σ valores = vNF`.

### Tests for User Story 1

- [x] T013 [P] [US1] Teste Supertest do caminho feliz em `modules/stockbridge/src/__tests__/` — `POST /recebimento` com `itens` de 3 produtos (mock) → 201, `resumo.recebidos=3`, 6 ajustes OMIE (3 acxe-trf + 3 q2p-ent) com `cod_int_ajuste` distintos.
- [x] T014 [P] [US1] Teste do rateio em contexto — 3 itens de valores distintos → custo/kg por item coerente com a linha; `Σ valorItem = vNF`.
- [x] T015 [P] [US1] Teste de regressão **N=1** — a suíte single-item existente passa sem mudança de comportamento (mesmo OMIE, mesmo lote provisório).

### Implementation for User Story 1

- [x] T016 [US1] Completar o **caminho limpo** do Portão 2 no orquestrador (`recebimento.service.ts`) — para cada item que confere (|Δ|≤1 kg), chamar `processarItemRecebimento`, coletar `status:'provisorio'` ou `pendente_q2p`; montar `resumo`.
- [x] T017 [US1] Pré-validar correlação de **todos** os itens no Portão 1 (caminho feliz: todos passam) via `getCorrelacao` por item, antes do Portão 2 (`recebimento.service.ts`). (O bloqueio-quando-falha é a US3.)
- [x] T018 [US1] Notificação de conclusão consolidada por NF (`modules/stockbridge/src/services/notificacao.service.ts`) — um resumo do recebimento concluído (reuso do padrão fire-and-forget).
- [x] T019 [P] [US1] UI — `apps/web/src/pages/stockbridge/operador/FilaOmiePage.tsx` lista os N itens da NF (não bloqueia multi-item); badge/where needed.
- [x] T020 [US1] UI — conferência por item em `apps/web/src/pages/stockbridge/operador/` (estender `ConferenciaModal` ou novo `ConferenciaMultiItem`): produto/valor read-only, qtd física (default NF, sempre kg — ACXEGDP-176) + localidade destino editáveis por linha; submit `itens[]`; N=1 renderiza a experiência atual.

**Checkpoint**: MVP — recebimento multi-item feliz funciona ponta-a-ponta; N=1 intacto. **PARAR e VALIDAR** (quickstart §1 US1).

---

## Phase 4: User Story 2 - Conferência com divergência por produto (Priority: P2)

**Goal**: item divergente (físico < fiscal) vai à aprovação do gestor por item, sem travar os itens que conferem.

**Independent Test**: NF de 3, um item 320 kg a menos → 2 provisórios + 1 aguardando_aprovacao; aprovar → OMIE + diferença ao estoque especial; outros intactos.

### Tests for User Story 2

- [x] T021 [P] [US2] Teste Supertest — NF com 1 item divergente + 2 exatos → 201, `resumo` {recebidos:2, aguardandoAprovacao:1}; item divergente com `aprovacaoId`.
- [x] T022 [P] [US2] Teste — excedente (recebido > NF) em um item → `422 QUANTIDADE_EXCEDE_NF` nomeando o item; itens válidos não gravam (faz parte do Portão 1/regra por item).
- [x] T023 [P] [US2] Teste — notificação consolidada: NF com 2 itens divergentes gera **um** e-mail ao gestor listando os dois.

### Implementation for User Story 2

- [x] T024 [US2] Roteamento de divergência por item no Portão 2 (`recebimento.service.ts`) — item com |Δ|>1 kg (e Δ<0) invoca `processarRecebimentoComDivergencia` por item (lote aguardando_aprovacao + aprovacao, sem OMIE agora); coletar `status:'aguardando_aprovacao'`.
- [x] T025 [US2] Regra de excedente por item (`recebimento.service.ts`) — Δ>1 kg bloqueia aquele item (mensagem existente), integrado ao Portão 1.
- [x] T026 [US2] Notificação consolidada de aprovação pendente por NF (`notificacao.service.ts`) — um e-mail listando os itens aguardando aprovação (padrão `enviarAlertaRecebimentoNacionalLote`), no lugar de N e-mails.
- [x] T027 [US2] UI — campos de divergência por linha em `apps/web/src/pages/stockbridge/operador/` (motivo obrigatório + faltando/varredura quando |Δ|>1 kg; aviso de excedente por linha); painel NF/Recebido/Δ por item.
- [x] T028 [US2] Confirmar que a aprovação (`aprovacao.service.ts`, ramo `recebimento_divergencia`) opera inalterada por `aprovacao` — teste de que aprovar um item não afeta os demais da NF.

**Checkpoint**: US1 + US2 funcionam; divergência é por item.

---

## Phase 5: User Story 3 - Bloqueio tudo-ou-nada por produto sem correlato (Priority: P3)

**Goal**: qualquer produto sem correlato Q2P (ou inválido) bloqueia a NF inteira, com o produto nomeado, zero escrita.

**Independent Test**: NF de 3 com 1 produto não cadastrado na Q2P → `409 PRODUTO_SEM_CORRELATO` nomeando o produto; nenhum lote/OMIE; após cadastrar, receber tudo (resumível).

### Tests for User Story 3

- [x] T029 [P] [US3] Teste Supertest — NF com 1 de 3 sem correlato → 409, mensagem nomeia o produto pela **descrição**; zero ajustes no mock; zero lotes.
- [x] T030 [P] [US3] Teste — produto inválido (qtd/dado essencial ausente) → mesmo bloqueio total.
- [x] T031 [P] [US3] Teste **resumível** — após falha de Q2P num item, re-`POST` da NF completa só o item pendente; itens concluídos não duplicam (idempotência por produto).

### Implementation for User Story 3

- [x] T032 [US3] Endurecer o **Portão 1** no orquestrador (`recebimento.service.ts`) — validar correlação + validade de **todos** os itens antes de **qualquer** escrita OMIE; se algum falha, abortar a NF inteira sem efeitos colaterais.
- [x] T033 [US3] Erro de bloqueio agregado (`recebimento.service.ts` + `recebimento.routes.ts`) — coletar o(s) produto(s) sem correlato e responder `409 PRODUTO_SEM_CORRELATO` com `userMessage` nomeando por descrição (ACXEGDP-313: nunca código OMIE ao operador).
- [x] T034 [US3] Garantir a propriedade **zero-write** — a validação (Portão 1) roda antes do Portão 2; teste de invariante (INV-4 do data-model).

**Checkpoint**: as três stories independentes funcionam.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T035 [P] Remover o bloqueio multi-item obsoleto — mapeamento `NF_MULTI_ITEM`→422 em `recebimento.routes.ts` e `fila.routes.ts`; `enviarAlertaNfMultiItem` em `notificacao.service.ts`; `consultarNFComAlertaMultiItem` (simplifica para chamada direta); testes que assertavam o bloqueio.
- [x] T036 [P] Atualizar a seção StockBridge do `CLAUDE.md` — recebimento de importação passa a suportar multi-produto (idempotência por (NF, empresa, produto), migration 0046).
- [ ] T037 Rodar `frontend-design-reviewer` sobre o diff de UI (convenção do projeto para mudanças visuais).
- [x] T038 Validação quickstart.md — `OMIE_MODE=mock` (US1/US2/US3 manuais) + `pnpm --filter @atlas/stockbridge test` + `pnpm --filter @atlas/integrations-omie test` + `tsc --noEmit` nos pacotes tocados verdes.
- [ ] T039 Nota de paridade (Princípio V) — registrar no roteiro de validação paralela que multi-item de importação é nova capacidade; paridade = comparar recebimento pela plataforma × processo manual OMIE das NFs multi-item.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sem dependência.
- **Foundational (Phase 2)**: depende do Setup; **BLOQUEIA** todas as stories. Dentro dela: T002/T003 (DB) ∥ T004/T005/T006 (OMIE) podem ir juntos; T007→T008→T009→T010 são no mesmo arquivo (sequenciais); T011/T012 (rotas) após T010.
- **US1 (Phase 3)**: depende da Foundational. É o MVP.
- **US2 (Phase 4)**: depende da Foundational; integra ao orquestrador da US1 (mesmo arquivo → após US1).
- **US3 (Phase 5)**: depende da Foundational; endurece o Portão 1 do orquestrador (após US1; independe de US2).
- **Polish (Phase 6)**: depois das stories desejadas.

### User Story Dependencies

- **US1 (P1)**: só Foundational. Entrega valor sozinha (MVP).
- **US2 (P2)**: Foundational + orquestrador da US1 (compartilham `recebimento.service.ts`). Testável isolada.
- **US3 (P3)**: Foundational + orquestrador da US1. Independe de US2. Testável isolada.

### Within Each User Story

- Testes antes da implementação (devem falhar primeiro).
- Serviço antes de rota antes de UI.
- Story completa antes da próxima prioridade.

### Parallel Opportunities

- Foundational: **T002, T003, T004, T005, T006** em paralelo (DB + OMIE, arquivos distintos).
- Testes marcados [P] de uma story rodam juntos.
- **Entre stories não há paralelismo real** (compartilham `recebimento.service.ts`) — sequência P1→P2→P3.

---

## Parallel Example: Foundational

```bash
# Arquivos distintos, sem dependência entre si:
T002  packages/db/migrations/0046_*.sql
T003  packages/db/src/schemas/stockbridge.ts
T004  packages/integrations/omie/src/stockbridge/nf.ts
T005  packages/integrations/omie/src/stockbridge/mock.ts
T006  packages/integrations/omie/src/__tests__/nf.test.ts
```

---

## Implementation Strategy

### MVP First (US1)

1. Phase 1 (baseline) → Phase 2 (Foundational, CRÍTICA) → Phase 3 (US1).
2. **PARAR e VALIDAR** US1 no quickstart (mock) — recebimento multi-item feliz + N=1 intacto.
3. Aplicar migration 0046 em UAT (DBeaver) e validar com NF multi-item real (ex.: NF 5336/5288). Demo.

### Incremental Delivery

1. Foundational → base pronta.
2. US1 → testar → aplicar migration UAT → validar real (MVP: elimina o processo manual).
3. US2 → divergência por item → testar → validar.
4. US3 → tudo-ou-nada → testar → validar.
5. Polish → limpeza do bloqueio obsoleto + docs + design review.

### Ordem de aplicação da migration

A migration 0046 é aplicada por você via DBeaver (como as 0042–0045), **junto ou logo após** o merge da US1 — antes de qualquer recebimento multi-item real em UAT (o índice antigo violaria com 2 produtos na mesma NF).

---

## Notes

- [P] = arquivos diferentes, sem dependência. O grosso da lógica vive em `recebimento.service.ts` → sequencial.
- Cada story tem teste próprio; a independência é de testabilidade, não de arquivo.
- N=1 é a guarda de regressão em todas as fases — a suíte single-item existente **não pode** quebrar.
- Nunca exibir código OMIE ao operador (ACXEGDP-313) — mensagens por descrição.
- Commit após cada tarefa ou grupo lógico; PR base `uat`; `git branch --show-current` antes de push.
- Migration segue a skill `stockbridge-migration` (cabeçalho Antes/Agora/Porque; sem tabela nova → sem trigger).
