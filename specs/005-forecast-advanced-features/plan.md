# Implementation Plan: Forecast Advanced Features

**Branch**: `005-forecast-advanced-features` | **Date**: 2026-04-13 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/005-forecast-advanced-features/spec.md`

## Summary

Adicionar 3 features avancadas ao Forecast Planner: (1) Aba Demanda com vendas mensais 24m, YoY%, sparkline e expansao por SKU, (2) Aba Business Insights com fornecedores, score COMEX e janela de compra otima, (3) Analise IA da Shopping List via gateway n8n/LLM. Dados confirmados no BD: 54 meses de vendas (desde 2021-11), 227 importacoes FUP com 22 fornecedores e 42 familias, fornecedores ACXE com pais_origem na FUP.

## Technical Context

**Language/Version**: TypeScript 5.5+ (strict mode) / Node.js 20 LTS
**Primary Dependencies**: Express 4 (API), React 18 + Vite (frontend), Drizzle ORM + raw SQL via getPool(), recharts (graficos/sparklines), Zod (validacao)
**Storage**: PostgreSQL 16 — leitura de tabelas OMIE em public.* (tbl_movimentacaoEstoqueHistorico_Q2P, tbl_dadosPlanilhaFUPComex, tbl_cadastroFornecedoresClientes_ACXE)
**Testing**: Vitest (32 testes existentes no forecast)
**Target Platform**: Linux server (Docker Swarm DigitalOcean)
**Project Type**: Monolito modular — modulo `modules/forecast/`
**Performance Goals**: Aba Demanda < 2s, Aba Insights < 3s, Analise IA < 15s
**Constraints**: Gateway LLM via n8n (Principio III). Sem tabelas novas — tudo read-only de OMIE.
**Scale/Scope**: ~5 usuarios internos (comprador/gestor), ~30 familias, ~42 familias FUP

## Constitution Check

| Principio | Status | Justificativa |
|-----------|--------|---------------|
| I. Monolito Modular | PASS | Todo codigo em `modules/forecast/src/`. Nenhum import cross-modulo. |
| II. OMIE fonte de verdade | PASS | Leitura de tabelas OMIE via Postgres (tbl_movimentacao*, tbl_dadosPlanilha*, tbl_cadastro*). Zero chamada API OMIE. |
| III. Dinheiro so em TypeScript | PASS | Score COMEX calculado em TS com logica de negocio. Gateway LLM via n8n para analise (nao calculo financeiro). |
| IV. Audit Log | N/A | Sem tabelas novas. Nenhuma escrita em tabelas de dominio. |
| V. Validacao Paralela | N/A | Features novas — nao substituem legado. |

Nenhuma violacao.

## Project Structure

### Documentation (this feature)

```text
specs/005-forecast-advanced-features/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── api.md           # API contracts
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
modules/forecast/src/
├── services/
│   ├── demanda.service.ts      # US1: vendas mensais, YoY, sparkline data
│   ├── insights.service.ts     # US2: fornecedores, score COMEX, janela compra
│   └── ai-analysis.service.ts  # US3: gateway n8n para analise IA
├── routes/
│   └── forecast.routes.ts      # 3 novos endpoints (GET demanda, GET insights, POST analyze)
└── __tests__/
    ├── demanda.test.ts          # Testes YoY, sparkline, agregacao
    └── insights.test.ts         # Testes score COMEX, classificacao

apps/web/src/pages/forecast/
├── DemandAnalysisPage.tsx       # US1: aba demanda
├── BusinessInsightsPage.tsx     # US2: aba insights
└── ShoppingListPage.tsx         # US3: botao + painel analise IA (edit)
```

**Structure Decision**: Modulo existente. 3 novos services, 2 novas paginas, 1 pagina editada, 3 novos endpoints.
