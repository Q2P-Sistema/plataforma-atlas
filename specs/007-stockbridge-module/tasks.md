---

description: "Tarefas do modulo StockBridge — port do sistema PHP legado para TypeScript"
---

# Tasks: StockBridge — Controle Fisico de Estoque

**Input**: Design documents from `/specs/007-stockbridge-module/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: INCLUIDOS — o plan.md exige cobertura Vitest 90%+ em services financeiros (Principio III da constituicao) e Supertest para contratos de rota.

**Organization**: Tarefas agrupadas por User Story (P1 → P3) para implementacao e validacao incremental. Validacao paralela com legado PHP (Principio V) e tarefa transversal na fase Polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Pode rodar em paralelo (arquivos diferentes, sem dependencia)
- **[Story]**: A qual US a tarefa pertence (US1 a US8)
- Caminhos absolutos do monorepo

## Path Conventions

Monorepo pnpm + Turborepo:
- `packages/db/migrations/` — SQL
- `packages/db/src/schemas/` — Drizzle
- `packages/integrations/omie/` — cliente OMIE
- `modules/stockbridge/src/` — backend do modulo
- `apps/api/src/` — registro de rotas
- `apps/web/src/pages/stockbridge/` — frontend

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Inicializacao do modulo e dependencias compartilhadas

- [X] T001 Criar estrutura de diretorios do modulo em `modules/stockbridge/src/{routes,services,__tests__,scripts}` e `apps/web/src/pages/stockbridge/{operador,gestor,diretor}`
- [X] T002 Atualizar `modules/stockbridge/package.json` com deps: `@atlas/core`, `@atlas/auth`, `@atlas/db`, `@atlas/integrations`, `zod`, `decimal.js`, `mysql2` (dev), `vitest` (dev), `supertest` (dev)
- [X] T003 Criar `modules/stockbridge/tsconfig.json` herdando de `tsconfig.base.json`
- [X] T004 [P] Adicionar `MODULE_STOCKBRIDGE_ENABLED=false` em `.env.example` e documentar em `README.md`
- [X] T005 [P] Adicionar credenciais OMIE no `.env.example`: `OMIE_API_URL`, `OMIE_ACXE_KEY`, `OMIE_ACXE_SECRET`, `OMIE_Q2P_KEY`, `OMIE_Q2P_SECRET`, `OMIE_MODE` (real|mock)
- [X] T006 [P] Adicionar credenciais MySQL legado no `.env.example`: `MYSQL_Q2P_HOST`, `MYSQL_Q2P_USER`, `MYSQL_Q2P_PASS`, `MYSQL_Q2P_DB` (apenas para script de migracao)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Infraestrutura critica que bloqueia TODAS as user stories

**⚠️ CRITICAL**: Nenhuma user story pode comecar ate esta fase terminar.

### Schema e migrations

- [X] T007 Criar `packages/db/migrations/0008_stockbridge_core.sql` — schema `stockbridge.*`, 8 tabelas (localidade, localidade_correlacao, lote, movimentacao, aprovacao, divergencia, fornecedor_exclusao, config_produto) com PKs, FKs, checks e indices conforme [data-model.md](data-model.md)
- [X] T007b Pre-check da infraestrutura de audit: verificar em `packages/db/migrations/0001_atlas_infra_base.sql` e `0002_hedge_engine.sql` se `shared.audit_log_trigger(table_name text)` existe como funcao PL/pgSQL; se nao, adicionar criacao da funcao + tabela `shared.audit_log` append-only na migration 0008 antes dos triggers. Documentar achado em `specs/007-stockbridge-module/pre-migration-notes.md`
- [X] T008 Adicionar triggers `shared.audit_log_trigger` em todas as 8 tabelas do `stockbridge.*` dentro da migration 0008 (Principio IV); depende de T007b ter confirmado a assinatura da funcao
- [X] T009 Adicionar seeds minimos na migration 0008: localidades padrao (6 reais + 2 virtuais), tipos de divergencia (Faltando, Varredura)
- [X] T010 Criar `packages/db/migrations/0009_stockbridge_views.sql` — views `shared.vw_sb_saldo_por_produto`, `shared.vw_sb_correlacao_produto`, `shared.vw_sb_fornecedor_ativo`
- [X] T011 Criar Drizzle schema em `packages/db/src/schemas/stockbridge.ts` espelhando as 8 tabelas
- [X] T012 Exportar tipos Drizzle em `packages/db/src/schemas/index.ts`
- [X] T013 Rodar migrations em `pg-atlas-dev` e validar criacao do schema (`SELECT table_name FROM information_schema.tables WHERE table_schema = 'stockbridge'`)

### Integracao OMIE

- [X] T014 [P] Criar `packages/integrations/omie/stockbridge/nf.ts` — funcao `consultarNF(numeroNota, cnpj)` chamando `produtos/nfconsultar/` via cliente HTTP
- [X] T015 [P] Criar `packages/integrations/omie/stockbridge/ajuste-estoque.ts` — funcao `incluirAjusteEstoque(params, cnpj)` chamando `estoque/ajuste/` (suporta tipo TRF/ENT com motivos INI/TRF)
- [X] T016 [P] Criar `packages/integrations/omie/stockbridge/pedido-compra.ts` — funcao `alteraPedidoCompra(params, cnpj)` chamando `produtos/pedidocompra/` (para AlteraPedCompra)
- [X] T017 [P] Criar `packages/integrations/omie/stockbridge/mock.ts` — implementacao fake de todos os endpoints para `OMIE_MODE=mock`
- [X] T018 [P] Tests Vitest para cada funcao OMIE em `packages/integrations/omie/stockbridge/__tests__/` com fixtures de resposta real e cenarios de erro

### Registro do modulo

- [X] T019 Criar `modules/stockbridge/src/index.ts` exportando `stockbridgeRouter` (placeholder inicial)
- [X] T020 Registrar modulo em `apps/api/src/modules.ts` sob feature flag `MODULE_STOCKBRIDGE_ENABLED`
- [X] T021 [P] Criar middleware de perfil em `modules/stockbridge/src/middleware/role.ts` com helpers `requireOperador()`, `requireGestor()`, `requireDiretor()` usando `@atlas/auth`
- [X] T022 [P] Criar middleware `modules/stockbridge/src/middleware/armazem-vinculado.ts` que valida `shared.users.armazem_id` para operadores
- [X] T023a Verificar em `packages/db/migrations/0001_atlas_infra_base.sql` se `shared.users` ja tem coluna `armazem_id`. Documentar resultado (existe/nao existe) em `specs/007-stockbridge-module/pre-migration-notes.md`
- [X] T023b Se T023a confirmar que nao existe, criar `packages/db/migrations/0010_stockbridge_armazem_users.sql` adicionando `ALTER TABLE shared.users ADD COLUMN armazem_id uuid NULL REFERENCES stockbridge.localidade(id)` (migration idempotente com `IF NOT EXISTS`)

### Frontend shell

- [X] T024 [P] Criar `apps/web/src/pages/stockbridge/SBLayout.tsx` com navegacao lateral condicional por perfil
- [X] T025 Registrar rotas `/stockbridge/*` em `apps/web/src/App.tsx` sob feature flag e adicionar entrada ao menu principal

### Tipos compartilhados

- [X] T026 [P] Criar `modules/stockbridge/src/types.ts` com enums e tipos comuns: `StatusLote`, `EstagioTransito`, `TipoMovimento`, `SubtipoMovimento`, `TipoAprovacao`, `TipoDivergencia`, `Perfil`

**Checkpoint**: Fundacao pronta. User stories podem comecar em paralelo.

---

## Phase 3: User Story 1 - Recebimento de NF com Conferencia Fisica (Priority: P1) 🎯 MVP

**Goal**: Operador consegue confirmar recebimento fisico de NF da fila OMIE, com ou sem divergencia, atualizando saldo em ambos os CNPJs.

**Independent Test**: Inserir NF no OMIE mock, operador chama `POST /recebimento`, lote e movimentacao criados corretamente, OMIE mockado recebe duas chamadas `IncluirAjusteEstoque` (ACXE + Q2P), log aparece em `/movimentacoes`.

### Tests for User Story 1 (TDD)

> Escrever os testes ANTES e garantir que FALHAM antes da implementacao.

- [X] T027 [P] [US1] Contract test `POST /recebimento` em `modules/stockbridge/src/__tests__/contracts/recebimento.contract.test.ts` (cenarios sucesso, divergencia, idempotencia, produto sem correlato)
- [X] T028 [P] [US1] Unit test `motor.service.ts#converterParaToneladas()` em `modules/stockbridge/src/__tests__/motor.test.ts` (4 unidades: t, kg, saco 25kg, bigbag 1t)
- [X] T029 [P] [US1] Unit test `correlacao.service.ts#getCorrelacao()` em `modules/stockbridge/src/__tests__/correlacao.test.ts` (match de descricao positivo, sem match, case sensitivity)
- [X] T030 [P] [US1] Integration test fluxo completo recebimento em `modules/stockbridge/src/__tests__/recebimento.test.ts` com OMIE mock: sem divergencia → lote provisorio; com divergencia → lote aguardando_aprovacao; NF duplicada → 409

### Implementation for User Story 1

- [X] T031 [P] [US1] Criar `modules/stockbridge/src/services/correlacao.service.ts#getCorrelacao(produtoCodigoAcxe, localidadeDestinoCodigo)` lendo `shared.vw_sb_correlacao_produto`
- [X] T032 [P] [US1] Criar `modules/stockbridge/src/services/motor.service.ts#converterParaToneladas(qtd, unidade)` puro (sem I/O), testado por T028
- [X] T033 [US1] Criar `modules/stockbridge/src/services/recebimento.service.ts#getFilaOmie(perfilArmazem)` consultando fila de NFs pendentes (idempotencia checa `stockbridge.movimentacao.nota_fiscal` + `ativo=true`)
- [X] T034 [US1] Implementar `recebimento.service.ts#processarRecebimento(input)` transacional: (1) valida idempotencia, (2) resolve correlacao produto, (3) chama OMIE ACXE `IncluirAjusteEstoque`, (4) chama OMIE Q2P `IncluirAjusteEstoque`, (5) grava `stockbridge.lote`, (6) grava `stockbridge.movimentacao` com ambos os lados. Rollback BD se Q2P falhar apos ACXE sucesso + alerta
- [X] T035 [US1] Implementar tratamento de divergencia em `recebimento.service.ts#processarRecebimentoComDivergencia(input)`: cria lote `aguardando_aprovacao`, cria `stockbridge.aprovacao` nivel `gestor`, grava divergencia tipo `faltando`/`varredura`
- [X] T036 [US1] Criar `modules/stockbridge/src/routes/fila.routes.ts` com `GET /fila` (requireOperador + armazemVinculado)
- [X] T037 [US1] Criar `modules/stockbridge/src/routes/recebimento.routes.ts` com `POST /recebimento` (requireOperador), validacao Zod, chamada ao service
- [X] T038 [US1] Montar sub-routers em `modules/stockbridge/src/routes/stockbridge.routes.ts` e atualizar `modules/stockbridge/src/index.ts`
- [X] T039 [US1] Adicionar notificacao email via `@atlas/integrations/email` quando produto sem correlato (replicar mensagem do legado em `research.md` secao 10)
- [X] T040 [P] [US1] Criar `apps/web/src/pages/stockbridge/operador/FilaOmiePage.tsx` — lista de NFs com filtros de tipo, busca, cards coloridos por tipo de NF
- [X] T041 [P] [US1] Criar `apps/web/src/pages/stockbridge/operador/ConferenciaModal.tsx` — modal de confirmacao com input qtd + unidade, deteccao automatica de divergencia, campo motivo obrigatorio quando diverge
- [X] T042 [US1] Criar `apps/web/src/pages/stockbridge/operador/MeuEstoquePage.tsx` — saldo fisico por item do armazem vinculado, consultando view `shared.vw_sb_saldo_por_produto`

**Checkpoint**: Operador pode receber NF end-to-end. MVP funcional mas sem cockpit gestor ainda.

---

## Phase 4: User Story 2 - Cockpit de Estoque por Produto (Priority: P1) 🎯 MVP

**Goal**: Gestor ve saldos consolidados por SKU, cobertura em dias e criticidade, com drill-down em divergencias.

**Independent Test**: Com lotes em varias localidades, `GET /cockpit` retorna SKUs agrupados, cobertura calculada corretamente, criticidade respeitando thresholds (<50% LT=critico, <120% LT=alerta, >400% LT=excesso).

### Tests for User Story 2

- [X] T043 [P] [US2] Unit test `motor.service.ts#calcularCobertura(saldo, consumoMedio)` em `modules/stockbridge/src/__tests__/motor.test.ts`
- [X] T044 [P] [US2] Unit test `motor.service.ts#classificarCriticidade(cobertura, leadTime, saldo, consumoMedio)` com 4 cenarios (critico, alerta, ok, excesso)
- [X] T045 [P] [US2] Integration test `GET /cockpit` em `modules/stockbridge/src/__tests__/cockpit.test.ts` — valida totalizadores, filtros por familia/CNPJ

### Implementation for User Story 2

- [X] T046 [P] [US2] Implementar `motor.service.ts#calcularCobertura()` e `motor.service.ts#classificarCriticidade()` puros
- [X] T047 [US2] Criar `modules/stockbridge/src/services/cockpit.service.ts#getCockpit(filtros)` que junta `shared.vw_sb_saldo_por_produto` + `public.tb_produtos_ACXE` + `stockbridge.config_produto` para produzir lista de SKUs com cobertura/criticidade
- [X] T048 [US2] Adicionar ao mesmo service `getResumo(filtros)` para totalizadores do topo (fisico, fiscal, transito, provisorio, divergencias, aprovacoes pendentes, criticos/alertas)
- [X] T049 [US2] Criar `modules/stockbridge/src/routes/cockpit.routes.ts` com `GET /cockpit` (requireGestor) aceitando query `familia`, `cnpj`, `criticidade`
- [X] T050 [P] [US2] Criar `apps/web/src/pages/stockbridge/gestor/CockpitPage.tsx` — cards SKU com barras de cobertura, badges criticidade, resumo topo
- [X] T051 [P] [US2] Criar `apps/web/src/pages/stockbridge/gestor/ModalDivergencias.tsx` — drill-down de divergencias agrupavel por familia/NCM/status

**Checkpoint**: MVP completo (US1 + US2). Recebimento + visibilidade. Pode ir pra validacao paralela em staging.

---

## Phase 5: User Story 3 - Aprovacoes Hierarquicas (Priority: P2)

**Goal**: Gestor/Diretor revisa pendencias (divergencias, entradas manuais, saidas manuais) e aprova/rejeita. Operador pode re-submeter apos rejeicao.

**Independent Test**: Criar lote `aguardando_aprovacao`, gestor chama `POST /aprovacoes/:id/aprovar`, lote muda para `provisorio`; chamar `rejeitar`, operador re-submete via `POST /aprovacoes/:id/resubmeter`.

### Tests for User Story 3

- [X] T052 [P] [US3] Integration test ciclo aprovar/rejeitar/re-submeter em `modules/stockbridge/src/__tests__/aprovacao.test.ts`
- [X] T053 [P] [US3] Contract test `POST /aprovacoes/:id/(aprovar|rejeitar|resubmeter)` em `modules/stockbridge/src/__tests__/contracts/aprovacao.contract.test.ts`

### Implementation for User Story 3

- [X] T054 [P] [US3] Criar `modules/stockbridge/src/services/aprovacao.service.ts#listarPendencias(perfilNivel)` com filtro por nivel
- [X] T055 [US3] Implementar `aprovacao.service.ts#aprovar(id, usuarioId)` transacional: update `stockbridge.aprovacao.status=aprovada`, update `stockbridge.lote.status` (provisorio ou reconciliado), cria movimentacao se for entrada manual
- [X] T056 [US3] Implementar `aprovacao.service.ts#rejeitar(id, usuarioId, motivo)` — update aprovacao + lote para `rejeitado`
- [X] T057 [US3] Implementar `aprovacao.service.ts#resubmeter(id, novosDados, usuarioId)` — qualquer operador vinculado ao armazem do lote rejeitado pode re-submeter; lote volta para `aguardando_aprovacao` com dados atualizados; gera entrada de audit com novo `lancado_por`
- [X] T058 [US3] Validar autoridade no service: Gestor nao pode aprovar tipos que exigem Diretor (comodato, saidas especiais) — retorna erro `APROVACAO_NIVEL_INSUFICIENTE`
- [X] T059 [US3] Criar `modules/stockbridge/src/routes/aprovacao.routes.ts` com endpoints `GET /aprovacoes`, `POST /aprovacoes/:id/aprovar`, `POST /aprovacoes/:id/rejeitar`, `POST /aprovacoes/:id/resubmeter`
- [X] T060 [P] [US3] Criar `apps/web/src/pages/stockbridge/gestor/AprovacoesPage.tsx` — cards de pendencias com contexto (qtd prevista vs recebida, motivo, quem lancou), botoes Aprovar/Rejeitar
- [X] T061 [P] [US3] Criar `apps/web/src/pages/stockbridge/operador/ReSubmeterModal.tsx` — UI de re-submissao apos rejeicao
- [X] T062 [US3] Adicionar notificacao email ao gestor/diretor quando nova pendencia criada (usar `@atlas/integrations/email`)

**Checkpoint**: Ciclo de aprovacoes completo. Sistema ja pode processar divergencias sem intervencao manual no BD.

---

## Phase 6: User Story 4 - Pipeline de Transito Maritimo (Priority: P2)

**Goal**: Gestor/Diretor ve lotes nas 4 fases de transito (intl, porto/DTA, interno, reservado) com visibilidade correta por perfil. Avanco de fase manual ate ComexFlow existir.

**Independent Test**: Criar lote `transito_intl` (so gestor ve), avancar via `PATCH /transito/:id/avancar` para `porto_dta` (requer DI+DTA), depois `transito_interno` (NF transporte), depois recebimento no armazem.

### Tests for User Story 4

- [X] T063 [P] [US4] Unit test transicoes de estagio valido/invalido em `modules/stockbridge/src/__tests__/transito.test.ts`
- [X] T064 [P] [US4] Integration test visibilidade por perfil — operador NAO deve ver lotes `transito_intl`/`porto_dta`
- [X] T065 [P] [US4] Contract test `PATCH /transito/:lote_id/avancar` incluindo validacao de DI/DTA obrigatorios em `porto_dta`

### Implementation for User Story 4

- [X] T066 [P] [US4] Criar `modules/stockbridge/src/services/transito.service.ts#listarPorEstagio(perfil)` filtrando por visibilidade
- [X] T067 [US4] Implementar `transito.service.ts#avancarEstagio(loteId, novoEstagio, dados)` com validacoes: `porto_dta` exige DI+DTA; `transito_interno` exige NF transporte; transicao invalida = erro
- [X] T068 [US4] Criar `modules/stockbridge/src/routes/transito.routes.ts` com `GET /transito`, `PATCH /transito/:lote_id/avancar`
- [X] T069 [US4] Adicionar flag visual `atrasado` em lote quando `dt_prev_chegada < now()` e ainda em transito (via view ou calculo TS)
- [X] T070 [P] [US4] Criar `apps/web/src/pages/stockbridge/gestor/TransitoPage.tsx` — Kanban 4 colunas, cards por estagio, CTA de avanco
- [X] T071 [P] [US4] Criar `apps/web/src/pages/stockbridge/gestor/AvancarEstagioModal.tsx` — formulario dinamico por estagio destino

**Checkpoint**: Visibilidade do pipeline de importacao. Operador ve so transito interno/reservado conforme FR-006.

---

## Phase 7: User Story 5 - Saidas Automaticas via OMIE (Priority: P2)

**Goal**: n8n faz polling de NFs de saida OMIE e chama endpoint interno; sistema debita saldo automaticamente. Trata debito cruzado (Q2P fatura + fisico ACXE).

**Independent Test**: Enviar POST `/saida-automatica/processar` com NF de venda Q2P cujo estoque fisico esta em Acxe; verificar (a) saldo fisico Acxe debitado, (b) saldo fiscal Q2P debitado, (c) `stockbridge.divergencia` tipo `cruzada` criada, (d) notificacao gestor+diretor enviada.

### Tests for User Story 5

- [X] T072 [P] [US5] Unit test `saida-automatica.service.ts#detectarDebitoCruzado()` em `modules/stockbridge/src/__tests__/debito-cruzado.test.ts`
- [X] T073 [P] [US5] Integration test end-to-end de cada subtipo (venda, remessa, transf_cnpj, devolucao_fornecedor, debito_cruzado, regularizacao_fiscal) em `modules/stockbridge/src/__tests__/saida-automatica.test.ts`
- [X] T074 [P] [US5] Contract test `POST /saida-automatica/processar` com `X-Atlas-Integration-Key` (403 sem header, 401 com header invalido)

### Implementation for User Story 5

- [X] T075 [P] [US5] Criar middleware `modules/stockbridge/src/middleware/integration-key.ts` que valida `X-Atlas-Integration-Key` contra env `ATLAS_INTEGRATION_KEY`
- [X] T076 [P] [US5] Criar `modules/stockbridge/src/services/saida-automatica.service.ts#processar(payload)` com identificacao de subtipo, calculo de impacto fisico/fiscal
- [X] T077 [US5] Implementar `saida-automatica.service.ts#detectarDebitoCruzado()` — compara CNPJ emissor da NF com CNPJ da localidade fisica origem; se diferentes, cria `stockbridge.divergencia` tipo `cruzada`
- [X] T077b [US5] Implementar notificacao via `@atlas/integrations/email` para gestor+diretor quando debito cruzado detectado (FR-018 item c) — integrar com `detectarDebitoCruzado()`
- [X] T078 [US5] Implementar `saida-automatica.service.ts#regularizarFiscal(movimentacaoId)` — consumido quando NF de transferencia de regularizacao e processada, baixa divergencia cruzada aberta
- [X] T079 [US5] Criar `modules/stockbridge/src/routes/saida-automatica.routes.ts` com `POST /saida-automatica/processar` (integrationKey middleware)
- [X] T080 [P] [US5] Criar workflow n8n `workflows/stockbridge-saida-automatica.json` — polling 5min em `produtos/nfconsultar/` por tipos de saida, POST para endpoint Atlas
- [X] T081 [US5] Documentar em `quickstart.md` como importar/configurar o workflow n8n

**Checkpoint**: Saidas automaticas funcionando. Sistema completo end-to-end para producao em staging.

---

## Phase 8: User Story 6 - Saidas Manuais com Aprovacao (Priority: P3)

**Goal**: Operador registra saidas sem NF (comodato, amostra, descarte, etc.) com nivel de aprovacao correto.

**Independent Test**: Operador chama `POST /saida-manual` com subtipo=comodato; sistema cria movimentacao + aprovacao nivel `diretor`; diretor aprova; saldo fisico reduzido, fiscal inalterado; retorno via `POST /comodato/:id/retorno` reverte o debito.

### Tests for User Story 6

- [X] T082 [P] [US6] Unit test regras de nivel de aprovacao por subtipo em `modules/stockbridge/src/__tests__/saida-manual.test.ts`
- [X] T083 [P] [US6] Integration test ciclo completo comodato: registro → aprovacao → retorno

### Implementation for User Story 6

- [X] T084 [P] [US6] Criar `modules/stockbridge/src/services/saida-manual.service.ts#registrar(input, usuarioId)` com mapa subtipo → nivel aprovacao
- [X] T085 [US6] Implementar `saida-manual.service.ts#registrarRetornoComodato(movimentacaoId)` — reverte debito fisico, marca movimentacao original com referencia ao retorno
- [X] T086 [US6] Implementar regras de impacto fisico/fiscal por subtipo conforme documentado em `research.md`:
  - transf_intra_cnpj: -origem +destino, sem impacto fiscal
  - comodato: -fisico temporario, fiscal inalterado
  - amostra/brinde: -fisico definitivo, divergencia fiscal
  - descarte/perda/quebra: -fisico definitivo, divergencia fiscal
  - inventario_menos: -saldo, divergencia fiscal
- [X] T087 [US6] Criar `modules/stockbridge/src/routes/saida-manual.routes.ts` com `POST /saida-manual`, `POST /comodato/:movimentacao_id/retorno`
- [X] T088 [P] [US6] Criar `apps/web/src/pages/stockbridge/operador/SaidaManualPage.tsx` — formulario com select de subtipo, campos dinamicos, avisos de nivel de aprovacao

**Checkpoint**: Todos os 19 tipos de movimentacao suportados (FR-010).

---

## Phase 9: User Story 7 - Metricas e KPIs para Diretoria (Priority: P3)

**Goal**: Diretor ve valor total estoque (BRL/USD), exposicao cambial, evolucao 6m, tabela analitica por SKU, gerencia fornecedores.

**Independent Test**: `GET /metricas` retorna valores ponderados usando PTAX atual (Redis cache 15min via @atlas/hedge); `GET /metricas/evolucao?meses=6` retorna serie por familia.

### Tests for User Story 7

- [X] T089 [P] [US7] Unit test `motor.service.ts#calcularCMP()` (custo medio ponderado por lote)
- [X] T090 [P] [US7] Unit test calculo de exposicao cambial (so lotes `transito_intl` x custo_usd)
- [X] T091 [P] [US7] Integration test `GET /metricas` com PTAX mock

### Implementation for User Story 7

- [X] T092 [P] [US7] Implementar `motor.service.ts#calcularCMP(lotes)` — media ponderada USD/t
- [X] T093 [US7] Criar `modules/stockbridge/src/services/metricas.service.ts#getKPIs()` integrando com `@atlas/hedge/ptax` (reuso do cache Redis existente) para converter USD → BRL
- [X] T094 [US7] Implementar `metricas.service.ts#getEvolucao(meses)` — agregar movimentacoes historicas por mes/familia
- [X] T095 [US7] Implementar `metricas.service.ts#getTabelaAnalitica()` — SKU x (qtd, CMP, cobertura, valor BRL, divergencias)
- [X] T096 [US7] Criar `modules/stockbridge/src/routes/metricas.routes.ts` com `GET /metricas`, `GET /metricas/evolucao`, `GET /metricas/tabela-analitica` (todos requireDiretor)
- [X] T097 [P] [US7] Criar `modules/stockbridge/src/services/fornecedor.service.ts#excluir(cnpj, motivo, usuarioId)` e `reincluir(cnpj)` gravando em `stockbridge.fornecedor_exclusao`
- [X] T098 [P] [US7] Criar `modules/stockbridge/src/routes/fornecedor.routes.ts` com `GET /fornecedores`, `POST /fornecedores/:cnpj/excluir`, `POST /fornecedores/:cnpj/reincluir`
- [X] T099 [P] [US7] Criar `apps/web/src/pages/stockbridge/diretor/MetricasPage.tsx` — KPIs topo, grafico evolucao, tabela analitica
- [X] T100 [P] [US7] Criar `apps/web/src/pages/stockbridge/diretor/FornecedoresPage.tsx` — tabela com toggle excluir/reincluir

**Checkpoint**: Visao estrategica completa.

---

## Phase 10: User Story 8 - Gestao de Localidades e Configuracao (Priority: P3)

**Goal**: Gestor/Diretor gerencia locais de estoque (CRUD) e configura SKUs (consumo, lead time, incluir em metricas).

**Independent Test**: `POST /localidades` cria local, aparece em dropdowns; `PATCH` desativa, some de dropdowns mas mantem em historico; `PATCH /config/produtos/:codigo` atualiza consumo medio, cockpit recalcula cobertura.

### Tests for User Story 8

- [X] T101 [P] [US8] Unit test validacoes de criacao de localidade (tipo virtual sem CNPJ, codigo unico)
- [X] T102 [P] [US8] Contract test CRUD `localidades` e `config/produtos`

### Implementation for User Story 8

- [X] T103 [P] [US8] Criar `modules/stockbridge/src/services/localidade.service.ts` (CRUD + validacoes)
- [X] T104 [P] [US8] Criar `modules/stockbridge/src/services/config-produto.service.ts` (upsert por `produto_codigo_acxe`)
- [X] T105 [US8] Criar `modules/stockbridge/src/routes/localidade.routes.ts` com CRUD (requireGestor)
- [X] T106 [US8] Criar `modules/stockbridge/src/routes/config.routes.ts` com `GET /config/produtos`, `PATCH /config/produtos/:codigo_acxe` (requireDiretor)
- [X] T107 [P] [US8] Criar `apps/web/src/pages/stockbridge/gestor/LocalidadesPage.tsx` — tabela CRUD com formulario inline
- [X] T108 [P] [US8] Criar `apps/web/src/pages/stockbridge/diretor/ConfigProdutosPage.tsx` — tabela editavel de consumo/lead time/familia por SKU

**Checkpoint**: Todas as 8 user stories implementadas.

---

## Phase 11: Movimentacoes — listagem, soft delete (suporte a US2/US3)

> Pequena fase suporte — rota de movimentacoes e transversal.

- [X] T109 [P] Criar `modules/stockbridge/src/services/movimentacao.service.ts#listar(filtros)` com JOIN `shared.users` e paginacao
- [X] T110 [P] Criar `modules/stockbridge/src/services/movimentacao.service.ts#softDelete(id, usuarioId, motivo)` — marca `ativo=false`, grava audit
- [X] T111 Criar `modules/stockbridge/src/routes/movimentacao.routes.ts` com `GET /movimentacoes`, `DELETE /movimentacoes/:id`
- [X] T112 [P] Criar `apps/web/src/pages/stockbridge/gestor/MovimentacoesPage.tsx` — log paginado com filtros

---

## Phase 12: Migracao de Dados do MySQL Legado

> Pre-requisito para cutover. Executado manualmente no dia do go-live.

- [ ] T113 Criar `modules/stockbridge/src/scripts/migrate-from-mysql.ts` com:
  - flag `--dry-run`
  - leitura via `mysql2/promise` das tabelas: `tb_movimentacao`, `tb_estoque_local_acxe`, `tb_estoque_local_q2p`, `tb_converteCodigoLocalEstoque`, `tb_tp_divergencia`, `tb_tp_status_movimento`, `tb_users`
  - insercao em transacao no PG conforme mapeamento em [research.md](research.md) secao 6
  - mapeamento de `id_user` MySQL → `shared.users.id` novo via email
  - relatorio final de contagens
- [ ] T114 [P] Adicionar script ao `package.json` do modulo: `"migrate-from-mysql": "tsx src/scripts/migrate-from-mysql.ts"`
- [ ] T115 [P] Testar em staging com dump copia de producao, validar integridade (contagens + spot-check de ids_movest)

---

## Phase 13: Validacao Paralela com Legado PHP (Principio V)

> Transversal — executar durante 2 semanas em staging antes do cutover.

- [ ] T116 Documentar criterios de paridade em `specs/007-stockbridge-module/paridade-criterios.md`: (1) mesma NF gera `id_movest_acxe` e `id_movest_q2p` em ambos sistemas, (2) tratamento de divergencia identico, (3) emails disparados nos mesmos eventos
- [ ] T117 Criar script `modules/stockbridge/src/scripts/validar-paridade.ts` que compara movimentacoes recentes entre MySQL e PG e lista divergencias
- [ ] T118 Executar validacao paralela em staging durante 2 semanas — recebimentos processados em ambos os sistemas manualmente
- [ ] T119 Reunir relatorio diario de divergencias; investigar cada uma; aceitar via ADR se for bug do legado ou corrigir no Atlas
- [ ] T120 Decisao explicita de cutover apos 2 semanas sem divergencia nova — registro em ADR ou PR de decisao

---

## Phase 14: Polish & Cross-Cutting Concerns

- [ ] T121 [P] Dashboard Grafana `stockbridge-operacional` — fila OMIE, recebimentos hoje, erros, latencia OMIE p50/p95
- [ ] T122 [P] Dashboard Grafana `stockbridge-gestao` — divergencias abertas, aprovacoes pendentes, pipeline de transito
- [ ] T123 [P] Dashboard Grafana `stockbridge-diretoria` — valor estoque, exposicao cambial, evolucao 6m
- [ ] T124 [P] Alertas Grafana: OMIE p95 >10s por 5min; recebimento falho ao escrever no OMIE; divergencia nao tratada em 7 dias
- [ ] T125 [P] Adicionar feature flag reconhecimento em `apps/web/src/hooks/useFeatureFlags.ts` para ocultar menu StockBridge quando desabilitado
- [X] T126 Atualizar `CLAUDE.md` e `README.md` com status do modulo (de placeholder para produtivo)
- [X] T127 Executar `pnpm test --filter @atlas/stockbridge` e garantir 90%+ cobertura em services financeiros
- [X] T128 [P] Code review contra as 5 principios da constituicao — conferir cada gate
- [ ] T129 [P] Performance smoke: validar SC-001 (<2min recebimento), SC-002 (<3s cockpit), SC-005 (<30s aprovacao) com dados de staging
- [ ] T130 Rodar checklist completo do `quickstart.md` em staging antes do cutover

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: Sem dependencias
- **Phase 2 (Foundational)**: Depende de Phase 1 — BLOQUEIA todas as user stories
- **Phase 3 (US1)**: Depende de Phase 2. MVP inicial.
- **Phase 4 (US2)**: Depende de Phase 2. Paralelo a Phase 3 (equipe).
- **Phase 5 (US3)**: Depende de Phase 2. Paralelo a Phase 3/4 (equipe).
- **Phase 6 (US4)**: Depende de Phase 2.
- **Phase 7 (US5)**: Depende de Phase 2. Idealmente apos US1 (reusa logica de movimentacao).
- **Phase 8 (US6)**: Depende de Phase 5 (US3) — reusa fluxo de aprovacao.
- **Phase 9 (US7)**: Depende de Phase 2 + Hedge PTAX service existente.
- **Phase 10 (US8)**: Depende de Phase 2.
- **Phase 11 (Movimentacoes)**: Suporte, nao bloqueia US mas e util pra Gestor.
- **Phase 12 (Migracao)**: Independente das US — pode rodar em paralelo.
- **Phase 13 (Validacao Paralela)**: Depende de Phases 3-8 (todas as US core prontas).
- **Phase 14 (Polish)**: Depende de US relevantes.

### Parallel Opportunities

- **Setup (T001-T006)**: T004-T006 em paralelo apos T001-T003
- **Foundational (T007-T026)**: T014-T018 (OMIE), T021-T022 (middlewares), T024-T026 em paralelo
- **Dentro de cada US**: Tasks marcadas [P] sao paralelas (diferentes arquivos)
- **Entre US**: US1, US2, US3, US4 podem ser paralelizados com 4 devs apos Phase 2
- **Migracao (T113-T115)**: Paralelo a todo desenvolvimento

---

## Parallel Example: User Story 1

```bash
# Tests em paralelo
Task T027 "Contract test POST /recebimento in modules/stockbridge/src/__tests__/contracts/recebimento.contract.test.ts"
Task T028 "Unit test converterParaToneladas in modules/stockbridge/src/__tests__/motor.test.ts"
Task T029 "Unit test getCorrelacao in modules/stockbridge/src/__tests__/correlacao.test.ts"
Task T030 "Integration test recebimento in modules/stockbridge/src/__tests__/recebimento.test.ts"

# Services base em paralelo
Task T031 "correlacao.service.ts"
Task T032 "motor.service.ts converter"

# Frontend em paralelo
Task T040 "FilaOmiePage.tsx"
Task T041 "ConferenciaModal.tsx"
```

---

## Implementation Strategy

### MVP First (US1 + US2)

1. **Phase 1** (Setup) — 1 dia
2. **Phase 2** (Foundational) — 3 dias (migrations + OMIE integration)
3. **Phase 3** (US1 Recebimento) — 5 dias
4. **Phase 4** (US2 Cockpit) — 3 dias
5. **STOP e VALIDAR** — deploy em staging, operador testa com OMIE sandbox
6. **Phase 12** (Migracao) — prepara em paralelo

**Total MVP**: ~2 semanas para 1 dev. Entrega recebimento + visibilidade — suficiente para substituir 80% do legado PHP.

### Incremental Delivery

1. MVP (US1+US2) → staging com dados sinteticos
2. +US3 (Aprovacoes) → fluxo completo de divergencia
3. +US4 (Transito) → visibilidade importacao
4. +US5 (Saidas automaticas) → sistema independente do operador
5. +US6 (Saidas manuais) → cobre 100% dos 19 tipos
6. +US7+US8 (Metricas + Config) → valor estrategico
7. **Phase 13** (Validacao paralela) 2 semanas em staging com NFs reais
8. **Phase 12 + cutover** (Migracao) → producao

### Parallel Team Strategy

Com 2 devs:
- Dev A: US1, US3, US6 (sequencia operador→aprovacao→saida manual)
- Dev B: US2, US4, US7 (sequencia cockpit→transito→metricas)
- Setup e Foundational: ambos juntos
- US5 e US8: quem terminar primeiro

---

## Notes

- Tasks [P] = arquivos diferentes, sem dependencia
- Cada US e independentemente testavel (checkpoint ao final de cada phase)
- Tests SEMPRE antes da implementacao (TDD exigido pela constituicao para services financeiros)
- Commit apos cada task ou grupo logico (padrao Conventional Commits)
- Validacao paralela (Phase 13) nao e opcional — Principio V
- Excecao ao Principio II (escrita OMIE) documentada em plan.md e research.md
