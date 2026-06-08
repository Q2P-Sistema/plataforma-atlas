# Implementation Plan: StockBridge — Visão de CMC por Família e Produto

**Branch**: `008-stockbridge-cmc-view` | **Date**: 2026-06-08 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/008-stockbridge-cmc-view/spec.md`

## Summary

Adicionar ao StockBridge um item de menu **"Custos de Estoque"** (acesso gestor+) com duas abas — **Snapshot diário** (CMC ponderado por família com árvore de produtos estilo Explorer + resumo global de volume/valor) e **Tendência histórica** (série diária do CMC). A feature é **somente leitura**: consome a tabela `public.tbl_historico_cmc_estoque` (já populada em prod pelo workflow n8n legado, sincronizada para UAT/dev) via `getPool()` + SQL bruto, seguindo o padrão existente do módulo (ex.: `meu-estoque.service.ts` lendo `vw_posicaoEstoqueUnificadaFamilia`). **Sem migration, sem escrita, sem trigger de audit** — a tabela é fonte externa em `public.*` e a feature só lê e agrega para exibição.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, Node.js 20 LTS
**Primary Dependencies**: Backend — Express 4, `@atlas/core` (`getPool`, `createLogger`), Zod. Frontend — React 18 + Vite, TanStack Query, **recharts ^3.8.1** (tendência), Tailwind (componentes hand-rolled — não há lib shadcn em `apps/web`), lucide-react (ícones), `@atlas/ui` (`ShellLayout`).
**Storage**: PostgreSQL 16 — **leitura apenas** de `public."tbl_historico_cmc_estoque"` (banco `acxe_q2p`). Sem novas tabelas, sem migration, sem escrita.
**Testing**: Vitest + Supertest (service + rota). Sem snapshot real necessário — fixtures sintéticas.
**Target Platform**: Linux server (Docker Swarm, `apps/api`) + SPA (`apps/web`).
**Project Type**: web (monorepo — módulo `modules/stockbridge` + app `apps/web`).
**Performance Goals**: Dataset pequeno: ~3.850 linhas/snapshot (550 produtos × 57 famílias × origem), cresce ~550 linhas/dia. Índices existentes (`idx_hist_data`, `idx_hist_familia`, `idx_hist_produto`, unique `uq_historico_dia_produto`) cobrem snapshot (eq em `data_snapshot`), tendência (range) e filtros. p95 < 1s trivial.
**Constraints**: Somente leitura; gate por feature flag `MODULE_STOCKBRIDGE_ENABLED`; acesso **gestor+** (sem operador); UI em **kg** e **R$/kg** — fonte já nessas unidades, **sem conversão**.
**Scale/Scope**: 1 página (2 abas), ~3 endpoints REST, 1 service, 1 item de menu. Usuários internos (dezenas).

## Constitution Check

*GATE: avaliado contra os 5 princípios da [constitution.md](../../.specify/memory/constitution.md).*

| Princípio | Status | Justificativa |
|---|---|---|
| **I. Monólito Modular** | ✅ PASS | Código novo só em `modules/stockbridge/*` e `apps/web/*`; sem import cross-módulo. **Nenhuma tabela nova** (não cria nada em `public` nem em schema de módulo). Leitura de `public.tbl_historico_cmc_estoque` segue o padrão já existente do módulo (lê `public.*` direto via `getPool`). Consumo é single-módulo → **não exige view em `shared`**. |
| **II. OMIE/Postgres é fonte** | ✅ PASS | Leitura 100% do Postgres local; **nunca** chama API OMIE. A tabela é populada por pipeline n8n (como as tabelas OMIE), Atlas só lê. |
| **III. Dinheiro só em TS** | ⚠️ PASS com nota | O **cálculo** do CMC ponderado já existe no workflow n8n legado (spec `002-historico-cmc-estoque`), **fora** do escopo desta feature e pré-existente ao Atlas. Esta feature só faz **agregação de leitura** (`Σ valor ÷ Σ volume` por família, em SQL/TS dentro de `apps/api`) para exibição — não há cálculo financeiro transacional nem regra de negócio nova em n8n. Ver Complexity Tracking. |
| **IV. Audit Log append-only** | ✅ N/A | Feature **somente leitura** — não há INSERT/UPDATE/DELETE em tabela de domínio. Nenhuma trigger de audit necessária. |
| **V. Validação Paralela** | ✅ PASS | Aditivo, não substitui legado. O relatório de CMC (Metabase/n8n) segue existindo em paralelo. Todo o StockBridge permanece sob `MODULE_STOCKBRIDGE_ENABLED` até paridade. |

**Stack obrigatória**: TS strict + Node 20 ✅; PostgreSQL 16 ✅; React 18 + Vite + Tailwind ✅; sem libs proibidas. PASS.

**Gate result: PASS** (1 nota documentada em Complexity Tracking, sem violação bloqueante).

## Project Structure

### Documentation (this feature)

```text
specs/008-stockbridge-cmc-view/
├── plan.md              # Este arquivo
├── research.md          # Phase 0 — decisões (arquitetura de dados, acesso, unidade, UI)
├── data-model.md        # Phase 1 — read models + fonte
├── quickstart.md        # Phase 1 — como rodar/validar localmente
├── contracts/
│   └── cmc-api.md       # Phase 1 — contrato dos endpoints REST
├── checklists/
│   └── requirements.md  # (do /speckit.specify)
└── tasks.md             # (gerado por /speckit.tasks — NÃO criado aqui)
```

### Source Code (repository root)

```text
modules/stockbridge/src/
├── services/
│   └── cmc.service.ts            # NOVO — lê tbl_historico_cmc_estoque, agrega família↔produto, monta série
├── routes/
│   ├── cmc.routes.ts            # NOVO — GET snapshot | tendencia | filtros (requireGestor)
│   └── stockbridge.routes.ts    # EDIT — router.use(cmcRouter)
├── middleware/role.ts           # (reuso: requireGestor)
└── __tests__/
    └── cmc.test.ts              # NOVO — service + rota (Vitest/Supertest)

apps/web/src/
├── pages/stockbridge/gestor/
│   ├── CmcPage.tsx              # NOVO — container com as 2 abas + filtros + resumo
│   └── cmc/                     # NOVO — componentes da página
│       ├── CmcSnapshotTab.tsx   #   lista de famílias + árvore de produtos + resumo global
│       ├── CmcTendenciaTab.tsx  #   gráfico recharts da série
│       ├── FamiliaTree.tsx      #   linha de família expansível (estilo Explorer)
│       └── MultiSelectCombo.tsx #   combo box multi-seleção (família/produto) — hand-rolled
└── App.tsx                      # EDIT — STOCKBRIDGE_SUB_ITEMS (item de menu) + <Route> da página

scripts/sync-vendas-prod-to-dev.sh  # JÁ EDITADO — tbl_historico_cmc_estoque no array TABLES
```

**Structure Decision**: Web/monorepo. Backend no módulo `stockbridge` (novo service + rota, registrados no router agregador existente). Frontend como nova página gestor em `apps/web`, com menu/rota adicionados no `App.tsx` (padrão dos demais itens StockBridge). **Nenhum** arquivo em `packages/db/migrations/` — não há objeto de banco novo.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Cálculo do CMC reside em n8n (Princípio III, "dinheiro só em TS") | O CMC ponderado já é produzido diariamente pelo workflow n8n legado (`Plc4nZOU2HgxaWM8`), pré-existente e fora do Atlas. Esta feature é só de **leitura/exibição**; reescrever o cálculo em TS seria reimplementar um produto de dados já validado em produção, contrariando a premissa da spec ("consome a fonte existente, não duplica"). | Reimplementar o snapshot diário de CMC em TS dentro do Atlas: rejeitado para v1 — duplicaria lógica, exigiria job/escrita/migration/audit e divergiria do dado que o Metabase já mostra. Fica registrado como evolução futura caso o produto de CMC migre para o Atlas. |
