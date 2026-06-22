# Implementation Plan: Conferência de Estoque ACXE vs Q2P (StockBridge)

**Branch**: `011-conferencia-estoque` | **Date**: 2026-06-22 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/011-conferencia-estoque/spec.md`

## Summary

Trazer para dentro do StockBridge a conferência de estoque que hoje é feita por planilha Excel (Power Query): comparar a posição física **ACXE × Q2P** por local e produto, classificar cada linha em `Status Geral` (`OK` / `Negativo` / `Divergente` / `Divergente e Negativo`) e destacar os problemas no topo. Adicionar um **badge vermelho** na navegação (estilo "aprovações pendentes") com a contagem de itens com `Status Geral ≠ OK`. Feature **somente leitura** (v1, sem tratativa).

**Abordagem técnica** (derivada da pesquisa Phase 0):

- **Fonte de dados**: ler **as tabelas-base** `public."tbl_posicaoEstoque_ACXE"` e `public."tbl_posicaoEstoque_Q2P"` (sincronizadas pelo n8n) — **não** a view `vw_posicaoEstoqueUnificada`, porque ela filtra `fisico >= 0` e descartaria justamente os saldos negativos que a conferência precisa flagrar.
- **Mapa De→Para de locais** (`ESPELHADO`/`INDIVIDUAL`, empresa) **não existe no OMIE/Postgres** — vira tabela de configuração nova `stockbridge.conferencia_local_map`, semeada com as 23 linhas do mapa atual da planilha (migration `0040` + trigger de auditoria).
- **Pivot + soma** por `(codigo do local, descrição, tipo, produto normalizado)` em **SQL** (FULL OUTER JOIN das duas agregações por empresa); **regras de negócio** (`Diferença`, `Saldo Negativo`, `Status Geral`, blacklist residual, ordenação, KPIs) em **TypeScript** coberto por **Vitest** (garante a paridade 100% com a planilha — SC-003).
- **Backend**: 2 endpoints sob `/api/v1/stockbridge/conferencia` (lista+resumo; contagem para o badge), padrão dos módulos 008/009.
- **Frontend**: nova entrada de menu `Conferência de Estoque` + página read-only (tabela hand-rolled Tailwind, filtros-chip, KPI cards, cores por severidade) + hook TanStack Query do badge, replicando o padrão do badge de aprovações.

## Technical Context

**Language/Version**: TypeScript 5.5+ (strict), Node.js 20 LTS
**Primary Dependencies**: Backend — Express 4, Drizzle ORM (tabela de config + migration), raw SQL via `getPool()` (@atlas/core) para a agregação, Zod (validação). Frontend — React 18 + Vite, TanStack Query, Tailwind (componentes hand-rolled), lucide-react, `@atlas/ui` (`ShellLayout`, `SidebarSubItem`)
**Storage**: PostgreSQL 16 — **leitura** de `public."tbl_posicaoEstoque_ACXE"`, `public."tbl_posicaoEstoque_Q2P"`, `public."tbl_locaisEstoques_ACXE"`, `public."tbl_locaisEstoques_Q2P"`; **escrita** apenas na nova tabela de config `stockbridge.conferencia_local_map` (seed + edição futura). Sem escrita em OMIE.
**Testing**: Vitest (engine de `Status Geral` + paridade), Supertest (rotas)
**Target Platform**: Linux server (Docker Swarm), monólito `apps/api` + `apps/web`
**Project Type**: Web (módulo `modules/stockbridge` + frontend `apps/web`)
**Performance Goals**: base de ~13k linhas (ACXE 6.895 + Q2P 6.160) → ~6.1k linhas comparadas; endpoint de lista responsivo (alvo < 800 ms); endpoint de contagem barato (badge com `refetchInterval` 30 s)
**Constraints**: NÃO usar `vw_posicaoEstoqueUnificada` (filtra negativos); usar `MAX(ddataposicao)` por empresa (robusto a sync atrasado); feature já coberta pela flag `MODULE_STOCKBRIDGE_ENABLED`; quantidades exibidas em Kg (= `fisico` cru, já em Kg)
**Scale/Scope**: 23 locais no mapa; ~6,1k linhas/dia; dezenas de problemas/dia (hoje: 27)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Princípio | Avaliação | Status |
|---|---|---|
| **I. Monólito Modular com Fronteiras Inegociáveis** | Código novo só em `modules/stockbridge` e `apps/web`; nova tabela nasce em `stockbridge.*` (nunca `public`); leitura de `public.*` é exceção legítima (tabelas OMIE sincronizadas); sem importar internals de outro módulo. | ✅ PASS |
| **II. OMIE é Fonte de Verdade, Atlas Lê do Postgres** | Feature 100% leitura do Postgres local (`tbl_posicaoEstoque_*` via n8n sync). Zero chamada à API OMIE. Não seta status de documento OMIE. Encaixe perfeito. | ✅ PASS |
| **III. Dinheiro Só em TypeScript** | Não há cálculo financeiro, mas a regra de negócio (`Status Geral`, `Diferença`, `Saldo Negativo`) fica em TS com cobertura Vitest. Nenhuma lógica em n8n; nenhum SQL solto escrevendo domínio. | ✅ PASS |
| **IV. Audit Log Append-Only via Trigger** | A única tabela mutável (`stockbridge.conferencia_local_map`) recebe trigger de auditoria (INSERT/UPDATE/DELETE → `shared.audit_log`) na mesma migration. A conferência em si é read-only (sem tabela de tratativa na v1). | ✅ PASS |
| **V. Validação Paralela, Zero Big-Bang** | Substitui uma **planilha**, não o legado PHP — mas a disciplina de paridade vale: SC-003 exige output idêntico à planilha. Plano de paridade documentado em [quickstart.md](./quickstart.md) (comparar as ~6,1k linhas). Desligamento da planilha só após paridade confirmada. | ✅ PASS |

**Resultado**: nenhuma violação. Seção *Complexity Tracking* fica vazia.

## Project Structure

### Documentation (this feature)

```text
specs/011-conferencia-estoque/
├── spec.md              # Especificação (/speckit.specify)
├── plan.md              # Este arquivo (/speckit.plan)
├── research.md          # Phase 0 — decisões técnicas
├── data-model.md        # Phase 1 — entidades + regras + SQL de agregação
├── quickstart.md        # Phase 1 — validação de paridade vs planilha
├── contracts/           # Phase 1 — contratos de API
│   ├── get-conferencia.md
│   └── get-conferencia-contagem.md
├── checklists/
│   └── requirements.md  # (/speckit.specify)
└── tasks.md             # Phase 2 (/speckit.tasks — NÃO criado aqui)
```

### Source Code (repository root)

```text
packages/db/
├── migrations/
│   └── 0040_stockbridge_conferencia_local_map.sql   # nova tabela config + trigger audit + seed 23 locais
└── src/schemas/
    └── stockbridge.ts                                # + tabela Drizzle conferenciaLocalMap

modules/stockbridge/src/
├── services/
│   ├── conferencia.service.ts                        # query SQL (pivot) + engine Status Geral + KPIs
│   └── __tests__/
│       └── conferencia.engine.test.ts                # Vitest: regras Status Geral / Saldo Negativo / ordenação
├── routes/
│   ├── conferencia.routes.ts                         # GET /conferencia ; GET /conferencia/contagem
│   └── stockbridge.routes.ts                         # + router.use(conferenciaRouter)
└── types.ts                                          # + tipos ConferenciaItem / ConferenciaResumo

apps/web/src/
├── App.tsx                                           # + item de menu, + useQuery do badge, + rota, + wiring do badge
└── pages/stockbridge/gestor/
    ├── ConferenciaEstoquePage.tsx                    # tela read-only (tabela + chips + KPIs + cores)
    └── conferencia/
        ├── types.ts
        └── format.ts                                 # reaproveita fmtKg
```

**Structure Decision**: Web/monorepo existente. Backend no módulo `modules/stockbridge` (services + routes), schema/migration em `packages/db`, frontend em `apps/web`. Segue exatamente o padrão dos módulos read-only 008 (CMC) e 009 (Meu Estoque): SQL pesado via `getPool()`, regra de negócio em TS, página gestor+ com tabela Tailwind hand-rolled.

## Complexity Tracking

> Sem violações de constituição — seção não aplicável.
