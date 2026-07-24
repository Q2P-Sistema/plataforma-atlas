# Implementation Plan: StockBridge — Controle Fisico de Estoque

**Branch**: `007-stockbridge-module` | **Date**: 2026-04-16 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/007-stockbridge-module/spec.md`

## Summary

Portar o sistema legado PHP de recebimento (2+ anos em producao) para um modulo TypeScript do Atlas, preservando integralmente o comportamento do sistema atual: fluxo dual-CNPJ (ACXE+Q2P), integracao direta com OMIE via API (consulta NF + ajuste de estoque — unica excecao autorizada ao Principio II), correlacao de produtos por match textual (mantida do legado na v1), e soft delete com auditoria. Adicionar os fluxos nao-implementados no legado (cockpit por SKU, aprovacoes hierarquicas, pipeline de transito 4 fases, saidas automaticas via polling n8n, saidas manuais, metricas e KPIs). Migrar apenas o log `tb_movimentacao` e tabelas de dominio simples do MySQL; os produtos, fornecedores e clientes ja existem no PostgreSQL via sync n8n. Validacao paralela obrigatoria (Principio V) — legado PHP continua rodando ate paridade 100% validada com dados reais.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, Node.js 20 LTS
**Primary Dependencies**: Express 4 (API), React 18 + Vite (frontend), Drizzle ORM (schema + migrations), raw SQL via getPool() (queries OMIE), mysql2 (migracao one-shot do legado), axios (cliente OMIE), decimal.js (aritmetica financeira), Recharts (graficos), Zod (validacao), shadcn/ui + Tailwind (UI)
**Storage**: PostgreSQL 16 — leitura em `public.*` (tabelas OMIE sincronizadas), escrita em `stockbridge.*` (schema proprio do modulo); MySQL legado acessado apenas no script one-shot de migracao
**Testing**: Vitest — cobertura 90%+ em `motor.service.ts`, `recebimento.service.ts`, `aprovacao.service.ts`, `divergencia.service.ts`; Supertest para contratos de rota
**Target Platform**: Linux server / Docker Swarm (stack Atlas)
**Project Type**: Modulo de monolito web (monorepo pnpm + Turborepo)
**Performance Goals**: Fila OMIE <2s; Cockpit SKU <3s (SC-002); recebimento end-to-end <2min (SC-001); aprovacao <30s (SC-005)
**Constraints**:
- **Excecao documentada ao Principio II**: escrita na API OMIE (`estoque/ajuste/` e `produtos/pedidocompra/`) — herdada do legado, sem alternativa (OMIE nao tem webhook de entrada). Leitura tambem chama OMIE diretamente para consulta de NF pelo numero (nao ha NF futura no banco).
- **Principio V aplica**: sistema PHP legado em producao — validacao paralela obrigatoria ate paridade 100%.
- **Correlacao de produto ACXE↔Q2P** por match textual de `tb_produtos_ACXE.descricao = tb_produtos_Q2P.descricao` (legacy preservado na v1).
**Scale/Scope**: ~4-5 operadores, 2 gestores, 2 diretores; 731 movimentacoes em 17 meses (~43/mes); 2 CNPJs; 6 locais fisicos reais; 522 produtos ACXE / 546 Q2P; ~30-50 NFs de importacao em transito simultaneamente

## Constitution Check

*GATE: Verificado antes da fase de implementacao. Re-checar em code review.*

| Principio | Status | Observacao |
|-----------|--------|------------|
| I. Monolito Modular com Fronteiras | ✅ PASS | Schema `stockbridge.*` proprio; export via `index.ts`; leitura de produtos/fornecedores via views em schema `shared` (nao acesso direto a `public.tbl_*`) |
| II. OMIE e Fonte de Verdade, Atlas Le do Postgres | ⚠️ EXCECAO DOCUMENTADA | StockBridge escreve no OMIE (ajuste de estoque, alteracao de pedido) — unica excecao autorizada pela propria constituicao (Principio II, 2a parte). Consulta NF na API OMIE porque NF recem-emitida pode nao estar no sync ainda. Comportamento herdado do legado; documentado em `research.md`. |
| III. Dinheiro So em TypeScript | ✅ PASS | Todo calculo (conversao unidade, cobertura, CMP, debito cruzado) em TS com testes Vitest. Nenhum calculo em n8n — n8n so faz polling de NFs de saida do OMIE e chama endpoint interno do Atlas. |
| IV. Audit Log Append-Only | ✅ PASS | Triggers em `stockbridge.movimentacao`, `stockbridge.lote`, `stockbridge.aprovacao` gravando em `shared.audit_log`. Soft delete (`ativo=0`) tambem gera linha de audit (UPDATE). |
| V. Validacao Paralela, Zero Big-Bang | ✅ PASS | Sistema PHP legado permanece em producao rodando em Apache paralelo ate paridade validada. Plano de validacao documentado em `research.md` (Estrategia de Cutover). Cada recebimento processado no Atlas **tambem** e processado no legado; comparacao de outputs diaria ate 2 semanas sem divergencia. |

**Complexity Tracking**: Uma excecao ao Principio II — escrita na API OMIE. Justificativa:

| Violacao | Por que necessaria | Alternativa mais simples rejeitada porque |
|----------|--------------------|-----------------------------------------|
| Chamada direta a `estoque/ajuste/` e `produtos/nfconsultar/` na API OMIE | OMIE nao suporta webhook de saida; n8n sync e incremental por `dDtAlt` e pode ter delay de minutos a horas; consulta de NF recem-emitida precisa ser online; escrita de ajuste precisa retornar `id_movest` imediatamente para rastreio | n8n como proxy adicionaria latencia + ponto de falha sem beneficio (ele tambem chamaria a mesma API); cache local nao ajuda em escrita. O sistema legado ja opera assim por 2 anos sem problemas. |

## Project Structure

### Documentation (this feature)

```text
specs/007-stockbridge-module/
├── plan.md              ← este arquivo
├── spec.md              ← especificacao funcional (8 US, 19 FR, 10 SC)
├── research.md          ← decisoes tecnicas, estrategia de cutover, mapeamento MySQL→PG
├── data-model.md        ← modelo de dados (8 tabelas novas + 2 views shared)
├── quickstart.md        ← como rodar, testar e habilitar em dev
├── contracts/
│   └── api.md           ← ~29 endpoints REST em 13 grupos funcionais documentados
├── checklists/
│   └── requirements.md  ← checklist de qualidade (todos passando)
└── tasks.md             ← gerado por /speckit-tasks (proximo passo)
```

### Source Code

```text
packages/db/
├── migrations/
│   ├── 0008_stockbridge_core.sql      ← schema stockbridge.*, 8 tabelas, triggers audit, seeds
│   └── 0009_stockbridge_views.sql     ← views shared.vw_sb_* para cross-modulo (Hedge, Forecast)
└── src/schemas/
    ├── stockbridge.ts                 ← Drizzle schema (lote, movimentacao, aprovacao, divergencia, localidade, tp_divergencia, tp_status_movimento, correlacao_produto)
    └── index.ts                       ← re-exportar tipos

packages/integrations/
└── omie/
    ├── client.ts                      ← cliente HTTP OMIE (ja existe parcialmente, expandir)
    └── stockbridge/
        ├── nf.ts                      ← ConsultarNF
        ├── ajuste-estoque.ts          ← IncluirAjusteEstoque (TRF/ENT com motivos INI/TRF)
        └── pedido-compra.ts           ← AlteraPedCompra

modules/stockbridge/
├── package.json                       ← deps: @atlas/core, @atlas/auth, @atlas/db, @atlas/integrations
├── tsconfig.json
└── src/
    ├── index.ts                       ← export { stockbridgeRouter }
    ├── routes/
    │   ├── stockbridge.routes.ts      ← router raiz, monta sub-routers
    │   ├── fila.routes.ts             ← GET /fila (NFs pendentes OMIE)
    │   ├── recebimento.routes.ts      ← POST /recebimento (com/sem divergencia)
    │   ├── cockpit.routes.ts          ← GET /cockpit (SKUs + saldos + criticidade)
    │   ├── lote.routes.ts             ← GET/PATCH /lotes
    │   ├── aprovacao.routes.ts        ← GET /aprovacoes, POST /aprovacoes/:id/(aprovar|rejeitar)
    │   ├── transito.routes.ts         ← GET /transito, PATCH /transito/:id/avancar
    │   ├── movimentacao.routes.ts     ← GET /movimentacoes (paginado), DELETE /movimentacoes/:id (soft)
    │   ├── localidade.routes.ts       ← CRUD localidades
    │   ├── fornecedor.routes.ts       ← exclusao/inclusao na fila de compra nacional
    │   ├── metricas.routes.ts         ← KPIs, evolucao 6m, tabela analitica
    │   └── saida-manual.routes.ts     ← POST saidas manuais (comodato, amostra, descarte, etc.)
    ├── services/
    │   ├── motor.service.ts           ← calc puro (saldos, cobertura, criticidade, CMP, debito cruzado)
    │   ├── recebimento.service.ts     ← orquestracao recebimento (OMIE + BD + auditoria, transacional)
    │   ├── aprovacao.service.ts       ← fluxo aprovacao/rejeicao/re-submissao
    │   ├── divergencia.service.ts     ← tratamento Faltando/Varredura/Cruzada
    │   ├── transito.service.ts        ← pipeline 4 fases, avanco manual ate ComexFlow existir
    │   ├── localidade.service.ts      ← CRUD + validacoes
    │   ├── fornecedor.service.ts      ← filtro de fila
    │   ├── correlacao.service.ts      ← match de descricao ACXE↔Q2P (legacy)
    │   ├── saida-automatica.service.ts ← consumidor de eventos do poller n8n (venda, transf, remessa, devolucao)
    │   └── saida-manual.service.ts    ← saidas manuais com aprovacao
    ├── __tests__/
    │   ├── motor.test.ts              ← saldos, cobertura, criticidade, conversao unidade
    │   ├── recebimento.test.ts        ← sem/com divergencia, idempotencia, OMIE mock
    │   ├── aprovacao.test.ts          ← aprovar, rejeitar, re-submeter
    │   ├── debito-cruzado.test.ts     ← Q2P fatura + ACXE fisico, regularizacao
    │   └── correlacao.test.ts         ← match de descricao (incluindo casos de nao-match)
    └── scripts/
        └── migrate-from-mysql.ts      ← one-shot: tb_movimentacao, tb_estoque_local_*, enums do MySQL → PG

apps/api/src/
└── modules.ts                         ← adicionar registro do stockbridgeRouter (quando MODULE_STOCKBRIDGE_ENABLED)

apps/web/src/
├── App.tsx                            ← adicionar STOCKBRIDGE_SUB_ITEMS + rotas /stockbridge/*
└── pages/stockbridge/
    ├── SBLayout.tsx                   ← wrapper com navegacao condicional por perfil (Operador/Gestor/Diretor)
    ├── operador/
    │   ├── FilaOmiePage.tsx           ← fila de NFs pendentes, filtro por tipo
    │   ├── MeuEstoquePage.tsx         ← saldo por item do armazem do operador
    │   └── ConferenciaModal.tsx       ← modal de confirmacao com/sem divergencia
    ├── gestor/
    │   ├── CockpitPage.tsx            ← dashboard SKU com cards criticidade
    │   ├── AprovacoesPage.tsx         ← painel de pendencias
    │   ├── TransitoPage.tsx           ← pipeline 4 fases Kanban
    │   ├── PosicaoFiscalPage.tsx      ← fisico vs fiscal por CNPJ, divergencias
    │   ├── MovimentacoesPage.tsx      ← log paginado
    │   └── LocalidadesPage.tsx        ← CRUD localidades
    └── diretor/
        ├── MetricasPage.tsx           ← KPIs, evolucao 6m, tabela analitica
        ├── FornecedoresPage.tsx       ← excluir/reincluir na fila
        └── UsuariosPage.tsx           ← gestao de usuarios e armazem vinculado (delegado ao Atlas infra)
```

**Structure Decision**: Web application — backend em `modules/stockbridge/`, frontend em `apps/web/src/pages/stockbridge/` dividido em subdiretorios por perfil (operador/gestor/diretor). Padrao identico aos modulos Hedge/Forecast/BreakingPoint. Integracao OMIE no `packages/integrations/omie/stockbridge/` porque o cliente OMIE e cross-modulo (Hedge ja le do sync, StockBridge escreve).

## Complexity Tracking

Uma unica violacao ao Principio II — ja tratada na secao Constitution Check acima com justificativa e opcoes rejeitadas.
