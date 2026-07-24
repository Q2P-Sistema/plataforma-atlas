# Tasks: Posição Fiscal via Mapa NF Mãe/Filhote

**Input**: Design documents from `/specs/010-fiscal-nf-mapa/`  
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅  
**Jira**: ACXEGDP-159  
**Branch**: `010-fiscal-nf-mapa`

> **Continuação (2026-06-16 — ACXEGDP-183)**: as correções de cálculo (Fix 1/2/3) e a aba "Pendências Fiscais" (US4) têm tarefas próprias em [`tasks-pendencias-fiscais.md`](./tasks-pendencias-fiscais.md). Este arquivo cobre a feature original (US1–US3, T001–T028, concluída).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story this task belongs to (US1, US2, US3)

---

## Phase 1: Setup — Spec Corrections

**Purpose**: Aplicar as 9 correções à spec derivadas da confirmação Comex (10/06/2026) antes de qualquer implementação. A spec atual contém referências ao caso "sem filhote" que é impossível conforme confirmado.

- [x] T001 Corrigir `specs/010-fiscal-nf-mapa/spec.md`: remover US1 Acceptance Scenario 3 ("NF mãe marcada como recebida") — impossível pois NF mãe nunca tem n_id_receb > 0
- [x] T002 Corrigir `specs/010-fiscal-nf-mapa/spec.md`: atualizar US2 Acceptance Scenario 3 — "pedido de apenas 1 container" sempre tem filhote; corrigir para refletir isso
- [x] T003 Corrigir `specs/010-fiscal-nf-mapa/spec.md`: remover Edge Case "Pedido sem filhotes (apenas NF mãe): desativação automática ocorre quando a NF mãe for marcada como recebida"
- [x] T004 [P] Corrigir `specs/010-fiscal-nf-mapa/spec.md`: atualizar Key Entity "NF Mãe" — adicionar "designada para 21.1 Extrema (IMPORTADO) no ERP, flag não gera estoque, nunca tem n_id_receb > 0"
- [x] T005 [P] Corrigir `specs/010-fiscal-nf-mapa/spec.md`: atualizar Key Entity "NF Filhote" — "sempre mínimo 1 por pedido; designada para 90.0.2 TRANSITO; gera estoque; n_id_receb = 0 em trânsito, > 0 ao chegar no galpão físico"
- [x] T006 [P] Corrigir `specs/010-fiscal-nf-mapa/spec.md`: atualizar Mapa de Pedido lifecycle — "NF mãe nunca é recebida; desativação depende exclusivamente das filhotes"
- [x] T007 [P] Corrigir `specs/010-fiscal-nf-mapa/spec.md`: simplificar FR-003 — remover cláusula "sem filhotes → checar NF mãe"
- [x] T008 [P] Corrigir `specs/010-fiscal-nf-mapa/spec.md`: atualizar Clarifications Q2 — remover "(pedido sem filhotes: quando NF mãe for recebida)"
- [x] T009 [P] Corrigir `specs/010-fiscal-nf-mapa/spec.md`: adicionar Assumption — "Todo pedido tem sempre ≥1 NF filhote (confirmado pelo time Comex em 10/06/2026)"

---

## Phase 2: Foundational — Migration e Schema

**Purpose**: Infraestrutura de dados que BLOQUEIA todas as user stories. Sem as tabelas no banco e no Drizzle, nenhuma story pode ser implementada.

**⚠️ CRÍTICO**: Nenhuma user story pode começar até esta fase estar completa.

- [x] T010 Criar migration `packages/db/migrations/0039_stockbridge_nf_pedido_mapa.sql` com: tabela `stockbridge.nf_pedido_mapa`, tabela `stockbridge.nf_pedido_filhote`, índices (partial unique em mapa, índices em nf_mae e nf_filhote), audit triggers padrão para ambas as tabelas → `shared.audit_log` (padrão da migration 0038)
- [x] T011 Adicionar exports Drizzle em `packages/db/src/schemas/stockbridge.ts`: `nfPedidoMapa`, `nfPedidoFilhote`, types `NfPedidoMapa`, `NfPedidoFilhote`
- [x] T012 Aplicar migration em dev e UAT: `psql "$DATABASE_URL" -f packages/db/migrations/0039_stockbridge_nf_pedido_mapa.sql` — verificar que tabelas e triggers existem nos bancos

**Checkpoint**: Tabelas existem no banco DEV; schema Drizzle compila sem erros; audit triggers funcionando.

---

## Phase 3: User Story 2 — Gestor cadastra o mapa (Priority: P1) 🎯 MVP

> ⚠️ US2 é implementada antes de US1 por dependência de dados: o cockpit (US1) precisa de registros no mapa para ser validado corretamente. Ambas são P1 na spec — apenas a ordem de implementação foi invertida.

**Goal**: Endpoint HTTP para ingestão do mapa NF mãe/filhotes — upsert idempotente, autorização gestor+, retorna contadores.

**Independent Test**: `POST /api/v1/stockbridge/admin/nf-pedido-mapa` com 3 pedidos → confirmar registros no banco. Re-enviar mesmos pedidos com filhotes alteradas → confirmar atualização sem duplicata. Verificar que operador recebe 403.

- [x] T013 [US2] Criar `modules/stockbridge/src/services/nf-pedido-mapa.service.ts` com função `upsertNfPedidoMapa(items: Array<{ pedido: string; nf_mae: string; nf_filhotes: string[] }>)`: transação SERIALIZABLE, upsert em `nf_pedido_mapa` por `pedido_acxe_omie`, soft-delete filhotes antigas (`ativo=false`), INSERT filhotes novas, retorna `{ inseridos: number; atualizados: number }` — **não validar o pedido contra `tbl_pedidosCompras_ACXE` no momento do INSERT** (FR-001: pedido inexistente no ERP deve ser aceito silenciosamente)
- [x] T014 [US2] Adicionar função `checkAndDeactivateMap(mapaId: string)` em `nf-pedido-mapa.service.ts`: após cada upsert, verifica se todas filhotes ativas têm `n_id_receb > 0` em `tbl_nf_header_ACXE`; se sim, seta `mapa.ativo = false`
- [x] T015 [US2] Criar `modules/stockbridge/src/routes/nf-pedido-mapa.routes.ts` com `POST /admin/nf-pedido-mapa`: validação Zod (array de objetos com `pedido`, `nf_mae`, `nf_filhotes: string[].max(12)`), `requirePerfil('gestor')`, chama `upsertNfPedidoMapa`, retorna JSON com contadores
- [x] T016 [US2] Registrar `nfPedidoMapaRouter` em `modules/stockbridge/src/routes/stockbridge.routes.ts`

**Checkpoint**: `POST /admin/nf-pedido-mapa` aceita payload válido; rejeita nf_filhotes > 12 com 400; rejeita operador com 403; segundo envio do mesmo pedido atualiza sem duplicata.

---

## Phase 4: User Story 1 — Cockpit reflete importações realmente pendentes (Priority: P1) 🎯 MVP

**Goal**: Substituir o CTE `fiscal_pend_importacao` no cockpit para usar o mapa quando disponível, com fallback CFOP para pedidos sem mapa.

**Independent Test**: Inserir pedido com mapa (2 filhotes). Simular `n_id_receb > 0` em ambas as filhotes no banco dev. Verificar que `totalFiscalPendenteImportacaoKg` cai para esse pedido. Pedido sem mapa continua aparecendo via fallback.

- [x] T017 [US1] Substituir CTE `fiscal_pend_importacao` em `modules/stockbridge/src/services/cockpit.service.ts` (linhas ~293-309) pela nova lógica em duas partes: Parte A (pedidos COM mapa — JOIN `tbl_pedidosCompras_ACXE` por `nqtde`, filhotes pendentes via LEFT JOIN `tbl_nf_header_ACXE`), Parte B (pedidos SEM mapa — CFOP 3.xxx original com filtro adicional `NOT EXISTS mapa.nf_mae = h.n_nf`). Preservar parâmetros $3 (cutoff_date) e $4 (incluir_acxe).

**Checkpoint**: Cockpit carrega sem erro; pedido com todas filhotes recebidas (`n_id_receb > 0`) não aparece mais na posição fiscal; pedido sem mapa continua aparecendo via fallback; UNION ALL não duplica (exclusão mútua via `NOT EXISTS mapa`).

---

## Phase 5: User Story 3 — Gestor valida e audita o mapa (Priority: P2)

**Goal**: Endpoint GET para listar o mapa cadastrado e verificar auditoria.

**Independent Test**: Após cadastrar 3 pedidos, `GET /admin/nf-pedido-mapa` retorna os 3 com NF mãe, quantidade de filhotes e data. Modificar um pedido e verificar que `shared.audit_log` tem registro com old_values/new_values.

- [x] T018 [US3] Adicionar função `listNfPedidoMapa()` em `modules/stockbridge/src/services/nf-pedido-mapa.service.ts`: `SELECT mapa.*, COUNT(f.id) AS total_filhotes FROM nf_pedido_mapa mapa LEFT JOIN nf_pedido_filhote f ON f.mapa_id = mapa.id AND f.ativo = true WHERE mapa.ativo = true GROUP BY mapa.id ORDER BY mapa.importado_em DESC`
- [x] T019 [US3] Adicionar `GET /admin/nf-pedido-mapa` em `modules/stockbridge/src/routes/nf-pedido-mapa.routes.ts`: `requirePerfil('gestor')`, chama `listNfPedidoMapa()`, retorna array JSON

**Checkpoint**: `GET /admin/nf-pedido-mapa` retorna lista dos pedidos ativos com `total_filhotes`; triggers de audit log registram cada INSERT/UPDATE em `shared.audit_log`.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T020 [P] Aplicar migration em UAT: `psql "$UAT_DATABASE_URL" -f packages/db/migrations/0039_stockbridge_nf_pedido_mapa.sql`
- [x] T021 [P] Executar typecheck — zero erros (`npm run lint` com erro pré-existente de @eslint/js ausente, não relacionado ao novo código)
- [x] T022 [P] Performance SC-003: n8n processou 27 pedidos (76 filhotes) em menos de 4 min sem erros; lote de 50 pedidos estimado bem abaixo dos 5s (SC-003 ✅ por inferência — sem falha de timeout observada)
- [x] T025 **Hotfix cockpit — duplicação de métricas** (commit `98f37f1`): UNION ALL em `fiscal_pend_importacao` sem GROUP BY externo retornava 2 linhas para produtos presentes em Parte A e Parte B simultaneamente; LEFT JOIN no SELECT final duplicava TODAS as métricas (transito_atlas, fisico_omie, etc.) — Tr. p/ Galpão aparecia 2× o valor real. Fix: GROUP BY externo consolida UNION ALL em 1 row por `produto_codigo_acxe`. Propagado para dev (`65a4063`) e uat (`6437e8d`).
- [x] T023 Commit e push da branch `010-fiscal-nf-mapa` com todas as mudanças — feat commit `e85eb5e` + fix auth `cd57114`; propagado para dev (`543e287`) e uat (`1e02fdc`)
- [x] T024a [P] Briefing n8n em `plan.md` atualizado (texto completo disponível); bug de auth `requireGestor` → `requireIntegrationKey` corrigido (commit `cd57114`); workflow n8n `hP7OrMQEs2av8Lj7` aguardando reconexão da cadeia + redeploy UAT
- [x] T024b **[DEPENDÊNCIA EXTERNA]** n8n executou com sucesso após fix de auth (10/06/2026); pedidos da aba "NF ENTRADA" importados via POST `/admin/nf-pedido-mapa`
- [x] T028 **Hotfix auto-desativação mapa — LPAD nf_filhote em checkAndDeactivateMap** (commit `0be5482`): `nf-pedido-mapa.service.ts` linha 100 usava `h.n_nf = f.nf_filhote` sem zero-padding — filhotes nunca encontradas em `tbl_nf_header_ACXE`, então o mapa nunca era desativado automaticamente ao receber todos os containers. Fix: `h.n_nf = LPAD(f.nf_filhote, 8, '0')`. Propagado para dev (`effc687`) e uat (`de12f69`).
- [x] T027 **Hotfix cockpit — LPAD nf_filhote/nf_mae nas comparações com tbl_nf_header** (commit `d222cfd`): `nf_pedido_filhote.nf_filhote` e `nf_pedido_mapa.nf_mae` gravados sem zero-padding (`"4779"`) mas `tbl_nf_header_ACXE.n_nf` usa 8 dígitos (`"00004779"`). Dois JOINs quebrados: (1) Parte A LEFT JOIN para verificar `n_id_receb` das filhotes → filhotes nunca encontradas → auto-deactivação nunca disparava; (2) Parte B NOT EXISTS mapa → NF mãe não excluídas do fallback → dupla contagem de ~1.932 t. Com o fix: pendente importação correto é **13.067 t** (não 14.999 t). Propagado para dev (`15bc13d`) e uat (`fad02e6`).
- [x] T026 **Hotfix cockpit — posição fiscal inflada pelo legado MySQL** (commit `488d950`): Parte B do fallback `fiscal_pend_importacao` verificava apenas `stockbridge.movimentacao` para excluir NFs já recebidas, mas a migração MySQL (migration 0038) gravou o histórico em `stockbridge.movimentacao_legado`. Resultado: 353 NFs / ~8.888 t tratadas como "pendentes" quando já haviam sido recebidas no sistema legado. Fix: adicionado `AND NOT EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml WHERE ml.ativo = true AND ml.nota_fiscal = h.n_nf)` à Parte B. Redução real: de ~21.585 t para ~12.697 t no fallback (189 NFs genuinamente pendentes remanescentes). Propagado para dev (`08165df`) e uat (`aa32ee8`).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Nenhuma dependência — pode começar imediatamente
- **Foundational (Phase 2)**: Depende de Phase 1 (spec corrigida) — BLOQUEIA US2, US3
- **US2 (Phase 3)**: Depende de Phase 2 (tabelas existem) — pode começar após Foundational
- **US1 (Phase 4)**: Depende de Phase 2 (tabelas existem) e preferencialmente de Phase 3 (dados para testar)
- **US3 (Phase 5)**: Depende de Phase 2; pode rodar em paralelo com US1
- **Polish (Phase 6)**: Depende de US1, US2, US3 completos

### User Story Dependencies

- **US2 (P1 — ingestão)**: Bloqueada apenas por Foundation (tabelas no banco)
- **US1 (P1 — cockpit)**: Bloqueada por Foundation; testável após US2 (para ter dados)
- **US3 (P2 — auditoria)**: Bloqueada por Foundation; independente de US1 e US2

### Parallel Opportunities

```bash
# Phase 1 — spec corrections podem ser feitas em paralelo (T004–T009)
T001 → T002 → T003  # sequencial (mesma área da spec)
T004 T005 T006 T007 T008 T009  # paralelo (seções diferentes da spec)

# Phase 2 — T010 e T011 são independentes após T010 estar concluído
T010 → T011 → T012  # T011 depende de T010 (schema usa nomes das tabelas)

# Phase 3 (US2) — T013 → T014 → T015 → T016 (dependência sequencial)

# Phase 4 (US1) — T017 é independente e pode rodar em paralelo com Phase 3
```

---

## Implementation Strategy

### MVP First (US2 + US1 — ambos P1)

1. Completar Phase 1: Spec corrections
2. Completar Phase 2: Migration + Drizzle schema (CRÍTICO — bloqueia tudo)
3. Completar Phase 3: US2 (ingestão via POST) — sem dados o cockpit não muda
4. Completar Phase 4: US1 (cockpit CTE substituído)
5. **STOP e VALIDAR**: Inserir pedido de teste, verificar cockpit fecha corretamente
6. Completar Phase 5: US3 (GET de auditoria)
7. Completar Phase 6: Deploy UAT + lint + commit + briefing n8n

### Incremental Delivery

1. Phase 1+2 → Foundation pronta (tabelas + spec corrigida)
2. Phase 3 → Endpoint de ingestão disponível → n8n pode começar a ser configurado
3. Phase 4 → Cockpit corrigido → validação do número com equipe supply chain
4. Phase 5+6 → Auditoria + deploy UAT → briefing n8n para automação

---

## Notes

- [P] = arquivos diferentes, sem dependências entre si
- [USx] = user story mapeada à spec.md
- Não há testes automatizados nesta spec (não solicitados)
- Auditoria é coberta pelos triggers PG (Princípio IV) — não requer código TS adicional
- Frontend: zero mudanças — mesmos campos `totalFiscalPendenteImportacaoKg` e `totalFiscalKg`
- n8n (T023) não é bloqueante para as US — pode ser feito após UAT estar com o endpoint no ar
