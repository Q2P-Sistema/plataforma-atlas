# Implementation Plan: Fila de Recebimento em Modo Real + Correção de Granularidade Multi-Produto

**Branch**: `014-fila-recebimento-real` | **Date**: 2026-07-16 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/014-fila-recebimento-real/spec.md`
**Jira**: ACXEGDP-299 (subtarefa de ACXEGDP-267/238) — reescopada em 16/07 para tratar só o STK-19c

## Summary

Duas frentes que compartilham uma peça técnica comum. (1) A fila de recebimento em modo real: hoje, sem digitar NF, a tela devolve lista vazia; passa a listar as NFs filhote mapeadas (`nf_pedido_mapa`/`nf_pedido_filhote`, feature 011), emitidas e com produto pendente, lendo só do espelho Postgres. (2) A correção de um bug de granularidade que a feature 013 (recebimento multi-produto) expôs em 5 pontos: a checagem "NF recebida" usada por Cockpit (3 usos + 1 no Cockpit Executivo novo), Pendências Fiscais (2 usos) e a auto-desativação do mapa é um `EXISTS` por NF inteira — com NF multi-produto parcialmente recebida, isso subestima pendência e pode desativar um mapa cedo demais.

**Abordagem técnica**: a peça central é estender `fiscal-recebida-sql.ts` com uma checagem "produto pendente" que usa granularidade de produto no caminho Atlas (`stockbridge.movimentacao`, que tem `produto_codigo_acxe`) — o único caminho capaz de multi-produto. Os dois sinais que são inerentemente por NF (histórico legado migrado, `n_id_receb` do OMIE) continuam por NF, porque não têm dado de produto para refinar (documentado como limitação aceita, não bug corrigível). Essa checagem única alimenta: a query nova da fila (Caso 2 de `getFilaOmie`, hoje um stub) e os 5 pontos existentes que hoje usam a checagem grosseira. A UI reaproveita 100% o fluxo de busca-por-NF já existente (feature 013) — item da fila preenche o campo de busca em vez de abrir o modal de conferência diretamente, porque o modal exige dados que só a chamada OMIE ao vivo (disparada pela busca) traz.

**Sem migration.** Nenhuma tabela nova — só queries novas/ajustadas sobre tabelas e colunas que já existem.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, Node.js 20 LTS
**Primary Dependencies**: Express 4 (rota da fila), Drizzle ORM + raw SQL via `getPool()` (queries sobre `nf_pedido_mapa`/`filhote` + espelho OMIE), React 18 + TanStack Query (seção nova na `FilaOmiePage`). Sem novas dependências.
**Storage**: PostgreSQL 16 — leitura de `stockbridge.nf_pedido_mapa`, `nf_pedido_filhote`, `stockbridge.movimentacao`, `stockbridge.movimentacao_legado`, `public."tbl_nf_header_ACXE"`, `public."tbl_nf_itens_ACXE"`. Sem escrita nova, sem migration.
**Testing**: Vitest (checagem "produto pendente" isolada + os 5 pontos corrigidos + a query da fila) + Supertest (rota nova). Casos de regressão: NF single-item deve produzir resultado idêntico ao de hoje em todos os 5 pontos.
**Target Platform**: Linux server (Docker Swarm, `apps/api` + `apps/web`).
**Project Type**: Web — monorepo modular (`modules/stockbridge` + `apps/web`).
**Performance Goals**: Fila é consultada quando o operador abre a tela sem NF — baixa frequência, sem alvo de throughput. Zero chamadas OMIE ao vivo adicionais (Princípio II).
**Constraints**: (a) fila é read-only, nenhuma escrita em `nf_pedido_mapa`/`filhote`; (b) nunca confiar em `mapa.ativo`/`filhote.ativo` isolado — sempre cruzar ao vivo com o espelho; (c) correção de granularidade é honesta sobre a limitação do legado/`n_id_receb` (permanecem por NF) — não simular precisão que o dado não tem; (d) NF single-item MUST produzir resultado idêntico ao atual em todos os 5 pontos corrigidos (guarda de regressão).
**Scale/Scope**: Mudança em ~7 arquivos backend + 1 frontend. Sem migration.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Princípio | Avaliação | Status |
|---|---|---|
| **I. Monólito Modular com Fronteiras Inegociáveis** | Mudanças inteiramente dentro de `modules/stockbridge/*` (serviços, rotas) e `apps/web` (UI). Nenhuma leitura direta de tabela privada de outro módulo; nenhuma query cross-módulo nova. Nenhuma tabela nova. | ✅ PASS |
| **II. OMIE é Fonte de Verdade, Atlas Lê do Postgres** | A fila lê exclusivamente do espelho Postgres (`tbl_nf_header_ACXE`/`tbl_nf_itens_ACXE`, sincronizados pelo n8n) — nenhuma chamada OMIE ao vivo nova. A única chamada OMIE do fluxo (`consultarNF`) já existe (feature 013) e só dispara quando o operador confirma a busca de uma NF. | ✅ PASS |
| **III. Dinheiro Só em TypeScript** | A checagem "produto pendente" e as correções em Cockpit/Pendências Fiscais são queries/lógica em TS, cobertas por Vitest. Nenhum cálculo em n8n. | ✅ PASS |
| **IV. Audit Log Append-Only via Trigger** | Nenhuma tabela nova, nenhuma escrita nova — não há mutação a auditar. As correções são em leitura (SELECT); o soft-delete/auditoria de `movimentacao`/`lote` já existentes (feature 013) não mudam. | ✅ PASS (N/A — feature é read-only) |
| **V. Validação Paralela, Zero Big-Bang** | A fila é capacidade nova sobre um módulo (StockBridge) ainda em validação paralela — não substitui nada do legado PHP (que nunca teve fila real, era 100% "digite o número"). A correção de granularidade é estritamente aditiva/corretiva sobre código já em `uat`; caso de single-item (o caso do legado) é garantido idêntico (constraint acima). | ✅ PASS |

**Resultado do gate**: PASS. Nenhuma violação que exija justificativa em Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/014-fila-recebimento-real/
├── plan.md              # Este arquivo
├── spec.md              # Especificação (com Clarifications)
├── research.md          # Phase 0 — 7 decisões técnicas
├── data-model.md         # Phase 1 — tipos/shape da fila (sem DB novo)
├── quickstart.md         # Phase 1 — como validar
├── contracts/
│   └── fila-real.md      # Phase 1 — contrato do endpoint novo
├── checklists/
│   └── requirements.md   # checklist de qualidade da spec
└── tasks.md               # Phase 2 (/speckit.tasks — NÃO criado aqui)
```

### Source Code (repository root)

```text
modules/stockbridge/src/
├── services/
│   ├── fiscal-recebida-sql.ts      # ESTENDER: recebidaViaMovimentacaoSql ganha filtro de produto opcional;
│   │                               #   nova função combinando as 3 fontes em "produto pendente"
│   ├── recebimento.service.ts      # IMPLEMENTAR: Caso 2 de getFilaOmie (hoje `return []`) — query da fila
│   ├── cockpit.service.ts          # CORRIGIR: 3 usos (transito_recebido_filhotes Parte A ×2, Parte B) passam
│   │                               #   a filtrar por produto
│   ├── cockpit-executivo.service.ts # CORRIGIR: 1 uso (consultarTransitoValorizado, ACXEGDP-314) — a query já
│   │                               #   agrupa por produto, só falta o filtro EXISTS acompanhar
│   ├── pendencias-fiscais.service.ts # CORRIGIR: 2 usos — FilhoteItem ganha status parcial (produto a produto)
│   └── nf-pedido-mapa.service.ts   # CORRIGIR: auto-desativação do mapa passa a checar produto, não só NF
├── routes/
│   └── fila.routes.ts              # ESTENDER ou rota nova: GET sem `nf` devolve a fila real (requireOperador)
└── __tests__/                      # produto pendente (unit), fila (rota), os 5 pontos corrigidos, regressão
                                     #   single-item em todos

apps/web/src/pages/stockbridge/operador/
└── FilaOmiePage.tsx                # nova seção no lugar do placeholder "Informe um número de NF"; clique
                                     #   preenche buscaNf e dispara handleBuscar existente (sem tocar ConferenciaModal)
```

**Structure Decision**: Web monorepo modular. O núcleo é a checagem "produto pendente" em `fiscal-recebida-sql.ts`, consumida por 6 pontos (a fila nova + os 5 existentes) — uma peça central corrigida uma vez, não seis implementações paralelas. A UI reaproveita 100% o fluxo de busca-por-NF da feature 013; a única coisa nova é a lista que precede a busca.

## Complexity Tracking

> Constitution Check passou sem violações — preenchimento não requerido.

Nota de design (não é violação): a correção de granularidade é deliberadamente **parcial e documentada** — cobre o caminho Atlas (`stockbridge.movimentacao`, o único capaz de multi-produto) e não finge resolver a limitação estrutural do histórico legado (`movimentacao_legado`, sem coluna de produto) nem do `n_id_receb` do OMIE (campo de cabeçalho). Ver [research.md](./research.md) D3 e [spec.md](./spec.md) Edge Cases.
