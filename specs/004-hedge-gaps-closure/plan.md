# Implementation Plan: Hedge Gaps Closure

**Branch**: `004-hedge-gaps-closure` | **Date**: 2026-04-13 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/004-hedge-gaps-closure/spec.md`

## Summary

Fechar 7 gaps pendentes do motor de hedge cambial Atlas (de 22 originais). O trabalho principal e incluir estoque nao pago na exposicao por bucket (GAP-01), adicionar cache Redis para posicao/estoque (GAP-10), completar parametros operacionais (GAP-14), e migrar graficos do motor para usar dados reais (GAP-F6). O modulo `modules/hedge/` ja esta substancialmente implementado — este work e refinamento, nao greenfield.

## Technical Context

**Language/Version**: TypeScript 5.5+ (strict mode) / Node.js 20 LTS
**Primary Dependencies**: Express 4 (API), React 18 + Vite (frontend), Drizzle ORM (queries), decimal.js (aritmetica financeira), recharts (graficos), Zod (validacao)
**Storage**: PostgreSQL 16, schema `hedge.*` (6 tabelas), Redis 8 (cache PTAX 15min — expandir para posicao/estoque)
**Testing**: Vitest (45 testes existentes em 4 suites)
**Target Platform**: Linux server (Docker Swarm DigitalOcean)
**Project Type**: Monolito modular — modulo `modules/hedge/`
**Performance Goals**: Dashboard < 500ms em cache hit (vs 2-5s cold)
**Constraints**: Fallback gracioso se Redis indisponivel
**Scale/Scope**: ~5 usuarios internos (gestor/diretor), 6-12 buckets mensais ativos

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Status | Justificativa |
|-----------|--------|---------------|
| I. Monolito Modular | PASS | Todo codigo em `modules/hedge/src/`. Nenhum import cross-modulo. Schema `hedge.*`. |
| II. OMIE fonte de verdade | PASS | `est_nao_pago_usd` vem de `vw_hedge_resumo` (view SQL no Postgres). Nenhuma chamada API OMIE. |
| III. Dinheiro so em TypeScript | PASS | Distribuicao proporcional de estoque nao pago e calculo no service TS, com Decimal.js. Nenhuma logica financeira em n8n ou SQL. |
| IV. Audit Log Append-Only | PASS | Tabela `configMotor` ja tem trigger de audit. Novos seeds usam mesma tabela. Nenhuma tabela nova criada. |
| V. Validacao Paralela | PASS | Hedge ainda nao esta em producao. Gap analysis documenta comparacao legado vs Atlas. Principio sera aplicado quando for a prod. |

Nenhuma violacao. Nenhum item no Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/004-hedge-gaps-closure/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── api.md
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
modules/hedge/src/
├── services/
│   ├── posicao.service.ts    # GAP-01: distribuir est_nao_pago_usd nos buckets
│   ├── motor.service.ts      # Ja usa loadMotorConfig() — sem mudanca
│   ├── config.service.ts     # GAP-14: seed parametros operacionais extras
│   └── cache.service.ts      # GAP-10: wrapper Redis para posicao/estoque (novo)
├── routes/
│   └── hedge.routes.ts       # Integrar cache + invalidacao
└── __tests__/
    ├── posicao.test.ts       # Testes novos para distribuicao est_nao_pago
    └── cache.test.ts         # Testes para cache wrapper (novo)

apps/web/src/pages/hedge/
└── MotorMVPage.tsx           # GAP-F6: graficos com dados reais do motor

packages/db/migrations/
└── 0005_hedge_gaps.sql       # Seeds de parametros operacionais extras
```

**Structure Decision**: Modulo existente. Unico arquivo novo e `cache.service.ts`. Demais sao edits em arquivos existentes.
