# Tasks: Posição Fiscal — Correções (Fix 1/2/3) + Aba "Pendências Fiscais"

**Input**: Design documents de `/specs/010-fiscal-nf-mapa/` (emenda 2026-06-16 — ACXEGDP-183)
**Prerequisites**: plan.md (§ Amendment 2026-06-16), spec.md (US1, US4, FR-011→021), research.md (Decisions 7–12), data-model.md (visão derivada)

**Tests**: NÃO solicitados nesta feature. Validação é via SQL no UAT (`mcp pg-acxe-uat`) + build `tsc`. `apps/web` não tem infra de teste de DB; o pool é mockado nos contract tests existentes (o SQL real não roda em teste).

**Organization**: tarefas agrupadas por user story. Continuação da feature 010 (tasks T001–T028 = feature original, concluídas). Numeração segue em **T029+**.

**Escopo**: só importação · aba somente leitura · sem nova tabela/migration.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência)
- **[US1]** = correção de cálculo (cockpit reflete pendência real) · **[US4]** = aba Pendências Fiscais

---

## Phase A: Correções já entregues (Fix 1 + Fix 2) — em UAT

**Purpose**: rastreabilidade — entregues nesta sessão antes do ciclo spec-kit formal.

- [x] T029 [US1] Fix 1 — "filhote recebida" aceita `n_id_receb>0` OU `movimentacao`(importacao) OU `movimentacao_legado` na Parte A e na auto-desativação, em `modules/stockbridge/src/services/cockpit.service.ts` e `modules/stockbridge/src/services/nf-pedido-mapa.service.ts` *(commits `d59cb77`→`917f7e1`)*
- [x] T030 [US1] Fix 2 — fallback CFOP 3.xxx (Parte B) exclui NFs que sejam mãe **ou** filhote de mapa ativo, em `modules/stockbridge/src/services/cockpit.service.ts` *(commits `945ea8e`→`173f78c`)*

**Checkpoint**: Pendência de importação em UAT 3.354.625 → 1.145.000 kg. ✅

---

## Phase B: Fix 3 — Parte A conta saldo (Priority: P1) 🎯

**Goal** (US1): recebimento parcial deixa de inflar a posição fiscal — a Parte A conta o saldo (`pedido − filhotes já recebidas`), não o pedido inteiro.

**Independent Test**: rodar a CTE da Parte A no UAT e confirmar Parte A = **939.250 kg** (era 1.094.000); pedidos 455/485 deixam de contar as filhotes já recebidas; pedido 508 (sem filhote) segue cheio (168.000).

- [x] T031 [US1] Substituir a sub-CTE da Parte A em `modules/stockbridge/src/services/cockpit.service.ts` por `GREATEST(pc.nqtde − COALESCE(Σ q_com das filhotes recebidas por (mapa_id, ncodprod), 0), 0)`; "recebida" = OR de 3 fontes (idêntico ao Fix 1); preservar Parte B e o GROUP BY externo *(aplicado; forma agrupada por (mapa,produto) p/ robustez)*
- [x] T032 [US1] Validador `validacao-posicao-fiscal-mae-filhote.sql` atualizado p/ Fix 1/2/3/4 + baseline refrescado pós-sync (Parte A saldo 939.250 · Parte B 51.000 · total 990.250)
- [x] T033 [US1] Validado no UAT: Parte A saldo = **939.250** (vs 1.094.000 inteiro); build `tsc` OK
- [x] T044 [US1] **Fix 4** — fallback (Parte B) exclui mãe/filhote de QUALQUER mapa (não só ativo) em `cockpit.service.ts`; elimina ~298.000 kg de falsa pendência (mãe de mapa desativado vazando). Validado UAT: Parte B 349.000 → **51.000**

**Checkpoint**: US1 completa — cálculo da pendência sem dupla contagem com o físico.

---

## Phase C: Aba "Pendências Fiscais" — Backend (Priority: P2)

**Goal** (US4): endpoint read-only que detalha, por pedido/NF, recebido vs. não recebido + fonte, exoneração (data/dias), aging das filhotes e sinal de inconsistência; + seção sem-mapa (Parte B).

**Independent Test**: `GET /api/v1/stockbridge/pendencias-fiscais` (gestor) retorna pedidos com filhotes (recebida+fonte+nfEmitida+diasDesdeEmissao), exoneração (dataEntrada=`d_emi` mãe, diasEmExoneracao), `inconsistencia` para 455/485, e `semMapa[]` com as 6 NFs (5174/5175/5176/5177/5216/5217).

- [x] T034 [P] [US4] Criar `modules/stockbridge/src/services/pendencias-fiscais.service.ts` — `getPool()` raw SQL com 4 queries (detalhe por filhote; qtde do pedido por produto; estágio FUP + `loteEmTransito`; Parte B sem-mapa), montagem em TS do `PendenciasFiscaisData` (pedidos[], semMapa[], resumo), aging = `hoje − d_emi`, `inconsistencia` = ≥1 filhote NF emitida não recebida E `NOT loteEmTransito` (FR-015), `Number()` em BIGINT
- [x] T035 [US4] Criar `modules/stockbridge/src/routes/pendencias-fiscais.routes.ts` — `GET /api/v1/stockbridge/pendencias-fiscais`, `requireGestor`, `QuerySchema` Zod (`status`, `incluir_metricas`), resposta `{data,error}`, try/catch 500; registrar `pendenciasFiscaisRouter` em `modules/stockbridge/src/routes/stockbridge.routes.ts` (seção autenticada)
- [x] T036 [US4] Validar o endpoint no UAT (`mcp pg-acxe-uat` replicando as queries) — saldo coerente com cockpit (Fix 3); exoneração lista pedidos com `diasEmExoneracao`; aging por filhote; build `tsc`

**Checkpoint**: backend da aba pronto e validado contra dados reais.

---

## Phase D: Aba "Pendências Fiscais" — Frontend (Priority: P2)

**Goal** (US4): a tela que o gestor abre para diagnóstico.

**Independent Test**: logar como gestor, abrir `/stockbridge/pendencias-fiscais`; ver pedidos agrupados (mãe + filhotes recebidas/pendentes coloridas), badges de status/inconsistência/aging, seção exoneração (dias) e seção importação sem mapa; toggle `incluir_metricas` revela 5174–5177.

- [x] T037 [P] [US4] Criar `apps/web/src/pages/stockbridge/gestor/PendenciasFiscaisPage.tsx` — molde `DivergenciasPage` (useApiFetch + useQuery, `fmtKg`/`fmtData`, filtros toggle); agrupado por pedido (expandível); badges status + inconsistência "chegou — NF aberta" + faixas de aging; cards de resumo; seção exoneração; seção "importação sem mapa"; toggle `incluir_metricas`
- [x] T038 [US4] Registrar a página em `apps/web/src/App.tsx` — import, `<Route path="pendencias-fiscais" element={<PendenciasFiscaisPage />} />` dentro de `path="stockbridge"`, item em `STOCKBRIDGE_SUB_ITEMS` (após `sb-divergencias`, ícone `FileWarning`, roles `['gestor','diretor']`)

**Checkpoint**: US4 completa — aba funcional ponta a ponta.

---

## Phase E: Entrega & Polish

**Purpose**: build, deploy UAT, rastreabilidade.

- [x] T039 Build completo — `pnpm --filter @atlas/stockbridge run build` (tsc) + build de `apps/web` (tsc + vite)
- [x] T040 Commit `9c97d93` (010) + cherry-pick `407a53b` (uat) — pushados; CI :uat em verificação
- [x] T041 [P] Atualizar ACXEGDP-183 (comentário com o resultado do Fix 3 + aba) e a memória do projeto
- [x] T042 [P] Faixas de aging extraídas p/ constantes nomeadas (AGING_ATENCAO/CRITICO_DIAS, provisórias 30/60d, a calibrar c/ comex); dias sempre exibidos. PendenciasFiscaisPage.tsx
- [x] T043 [P] Predicado 'recebida' (movimentacao/legado) extraído p/ fragmento compartilhado fiscal-recebida-sql.ts (FR-013), usado em cockpit (A+B), pendencias-fiscais e auto-desativação — anti-drift

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase A**: concluída (Fix 1/2 em UAT).
- **Phase B (Fix 3)**: independente da aba; pode ir primeiro (corrige o cálculo que a aba também reflete).
- **Phase C (backend aba)**: reusa a definição de "recebida" (Fix 1, T029, feito). T034 → T035 → T036 (service → rota → validação).
- **Phase D (frontend aba)**: T037 pode começar em paralelo ao backend; T038 e o teste E2E precisam do endpoint (T035) no ar.
- **Phase E**: depende de B + C + D concluídas.

### Within stories

- US1: T031 → T032 → T033.
- US4: T034 → T035 → T036; T037 [P] em paralelo; T038 após T037; E2E após T035+T038.

### Parallel Opportunities

- **T031** (cockpit.service.ts) e **T034** (pendencias-fiscais.service.ts) são arquivos diferentes → [P].
- **T037** (página React) em paralelo com o backend (C) → [P].
- **T041/T042** (Jira/memória/assumption) em paralelo no fim.

---

## Parallel Example

```bash
# Após Fix 1/2 (Phase A, feito), iniciar em paralelo:
Task: "T031 [US1] Fix 3 saldo em cockpit.service.ts"
Task: "T034 [US4] pendencias-fiscais.service.ts"
Task: "T037 [US4] PendenciasFiscaisPage.tsx (frontend)"
```

---

## Implementation Strategy

### MVP / ordem recomendada

1. **Fix 3 (Phase B)** — entrega valor imediato (número do cockpit correto); independente da aba. Validar em UAT e já mandar.
2. **Aba backend (Phase C)** — endpoint read-only; validar números contra dados reais.
3. **Aba frontend (Phase D)** — a tela.
4. **Entrega (Phase E)** — build + cherry-pick uat + Jira a cada incremento (Fix 3 pode ir antes da aba).

### Entrega incremental

- Fix 3 → UAT (cockpit fecha) → demo.
- Aba backend → validar endpoint.
- Aba frontend → gestor usa a tela de diagnóstico.

---

## Notes

- `[P]` = arquivos diferentes, sem dependência.
- Sem migration / sem nova tabela — aba é visão derivada (data-model § Amendment).
- "recebida" DEVE ser idêntica em cockpit (Parte A), aba e auto-desativação (FR-013) — não duplicar lógica divergente.
- Validação é via UAT (`mcp pg-acxe-uat`) — não há teste automatizado de DB neste módulo.
- Commit por tarefa/grupo lógico; entrega 010 → cherry-pick uat (não tocar `main`).
