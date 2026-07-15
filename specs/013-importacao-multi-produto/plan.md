# Implementation Plan: Recebimento de NF de Importação com Múltiplos Produtos

**Branch**: `013-importacao-multi-produto` | **Date**: 2026-07-15 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/013-importacao-multi-produto/spec.md`
**Jira**: ACXEGDP-115 (subtarefa de ACXEGDP-114) — reaberta em 15/07

## Summary

Destravar o recebimento de NF de importação com mais de um produto (hoje bloqueado — STK-10) e recebê-la inteira numa operação: cada produto conferido, correlacionado, lançado no OMIE (ACXE transferência + Q2P entrada) e registrado como entrada independente.

**Abordagem técnica**: a infraestrutura já é majoritariamente por-produto (opId determinístico, correlação ACXE↔Q2P, ajuste dual OMIE e pendências). A mudança concentra-se em: (1) reestruturar `consultarNF` para expor `itens[]` (remove o bloqueio); (2) **ratear** o total da NF (com tributos) entre os itens pelo valor comercial de cada um — reduz exatamente à fórmula atual para N=1; (3) uma **migration** que torna a idempotência de `entrada_nf` por (NF, empresa, **produto**); (4) refatorar `processarRecebimento` para um **loop por item** sobre a lógica single-item já validada, com **dois portões** — validação prévia tudo-ou-nada (um produto sem correlato bloqueia a NF) e escrita best-effort por item (falha de OMIE num item vira pendência recuperável, não derruba o lote); (5) trazer a UX de lista de itens (modelo do recebimento nacional, mas pré-preenchida pela NF). Divergência física × fiscal é tratada **por item**, reusando a máquina de aprovação faltando/varredura.

**Uma migration, nenhuma tabela nova.** `lote`/`movimentacao`/`aprovacao` já são por-produto e são reusadas. Decisões de detalhe (fórmula do rateio, granularidade de lote) resolvidas no [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, Node.js 20 LTS
**Primary Dependencies**: Express 4 (rotas de recebimento/fila), `@atlas/integrations-omie` (cliente `consultarNF` + ajuste idempotente), `@atlas/core` (`getPool`/`getDb`, `createLogger`, `sendEmail`), Drizzle ORM (migration + schema), `decimal.js` (rateio), Zod (validação de entrada), React 18 + TanStack Query (UI de lista). Sem novas dependências.
**Storage**: PostgreSQL 16 — **1 migration** (`0046`, split do índice de idempotência de `stockbridge.movimentacao`). Leitura de NF individual ao vivo via `produtos/nfconsultar/` e escrita de ajuste via `estoque/ajuste/` — ambas exceções ao Princípio II **já documentadas** (007). Sem tabela nova.
**Testing**: Vitest (rateio puro, mapeamento `consultarNF`, engine dos dois portões, idempotência por produto, divergência por item) + Supertest (rotas). `OMIE_MODE=mock` com fixtures multi-item; paridade de valor real valida-se em UAT/PROD (dev sanitizado).
**Target Platform**: Linux server (Docker Swarm, `apps/api` + `apps/web`).
**Project Type**: Web — monorepo modular (`modules/stockbridge` + `packages/integrations/omie` + `packages/db` + `apps/web`).
**Performance Goals**: Operação manual, baixo volume (~2-3 NFs multi-item/mês). N chamadas OMIE por NF (uma dual por produto) — aceitável no volume; sem alvo de throughput. Não adicionar consulta OMIE extra além da já feita.
**Constraints**: (a) N=1 **DEVE** reproduzir o comportamento single-item atual (suíte Vitest existente é a guarda); (b) tudo-ou-nada na validação prévia — nenhuma escrita OMIE até todos os itens passarem; (c) falha de OMIE por item é pendência recuperável, não erro de lote; (d) idempotência por produto torna o recebimento resumível; (e) nunca exibir código OMIE ao operador (ACXEGDP-313) — mensagens por descrição.
**Scale/Scope**: Mudança em ~8 arquivos backend + 2 frontend + 1 migration. Multi-item é ~3% das NFs de importação.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Princípio | Avaliação | Status |
|---|---|---|
| **I. Monólito Modular com Fronteiras Inegociáveis** | Mudanças em `packages/integrations/omie` (pacote compartilhado, consumido via `index`), `modules/stockbridge/*`, `packages/db/migrations` e `apps/web`. Nenhuma leitura direta de tabela privada de outro módulo; nenhuma query cross-módulo nova. Nova tabela? Não — só índice em `stockbridge.*`. | ✅ PASS |
| **II. OMIE é Fonte de Verdade, Atlas Lê do Postgres** | Leitura de NF (`consultarNF`) e escrita de ajuste (`estoque/ajuste/`) são exceções **já documentadas** (007 §2). Multi-item apenas itera `raw.det[]` da **mesma** resposta que já é buscada e faz N ajustes duais (um por produto) via o mesmo caminho de escrita. Nenhuma exceção nova ao Princípio II. Validação fiscal (cancelada/emitente) segue lendo do espelho `tbl_nf_header_*`. | ✅ PASS (exceção pré-existente) |
| **III. Dinheiro Só em TypeScript** | Rateio de valor, valoração ACXE/Q2P, decisão dos dois portões, idempotência e dual-CNPJ — tudo em TS coberto por Vitest. Nenhum cálculo/regra em n8n. | ✅ PASS |
| **IV. Audit Log Append-Only via Trigger** | **Sem tabela nova** — a migration só troca índice. As triggers de audit já existentes em `lote`/`movimentacao`/`aprovacao` cobrem as N linhas por NF. Soft-delete (`ativo=false`) preserva histórico; sem hard delete. | ✅ PASS |
| **V. Validação Paralela, Zero Big-Bang** | StockBridge TS ainda não está em produção (o legado PHP é o sistema vivo). Multi-item de importação é **nova capacidade**; a paridade deve comparar o recebimento pela plataforma com o processo manual OMIE atual (as ~2-3 NFs/mês). Registrar no roteiro de paridade da validação paralela (não exige ADR próprio). Mudar o contrato TS de `POST /recebimento` é seguro (pré-produção). | ✅ PASS (com nota de paridade) |

**Resultado do gate**: PASS. Nenhuma violação que exija justificativa em Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/013-importacao-multi-produto/
├── plan.md              # Este arquivo
├── spec.md              # Especificação (com Clarifications)
├── research.md          # Phase 0 — 7 decisões técnicas
├── data-model.md        # Phase 1 — migration 0046 + tipos
├── quickstart.md        # Phase 1 — como validar (mock/Vitest/UAT)
├── contracts/
│   └── recebimento-multi-item.md   # Phase 1 — contrato /fila e /recebimento
├── checklists/
│   └── requirements.md  # checklist de qualidade da spec
└── tasks.md             # Phase 2 (/speckit.tasks — NÃO criado aqui)
```

### Source Code (repository root)

```text
packages/integrations/omie/src/stockbridge/
├── nf.ts                 # REESTRUTURAR: ConsultarNFResponse → cabeçalho + itens[]; remover throw multi-item
└── mock.ts               # ESTENDER: fixtures NF multi-item (3 produtos; 1 sem correlato; 1 divergente; erro Q2P)

packages/db/
├── migrations/0046_stockbridge_idempotencia_entrada_por_produto.sql   # NOVO: split do índice (entrada por produto)
└── src/schemas/stockbridge.ts   # SYNC: refletir os dois índices de movimentacao

modules/stockbridge/src/
├── services/
│   ├── recebimento.service.ts      # REFATOR: extrair processarItemRecebimento; loop multi-item; rateio;
│   │                               #   produtoDaNfJaRecebido/contarTentativas por produto; Portão 1 (valida todos)
│   ├── correlacao.service.ts       # inalterado (já por produto; chamado N× no Portão 1)
│   ├── aprovacao.service.ts        # inalterado (ramo recebimento_divergencia invocado por item)
│   └── notificacao.service.ts      # consolidar alerta de aprovação por NF; remover enviarAlertaNfMultiItem
├── routes/
│   ├── recebimento.routes.ts       # POST /recebimento aceita itens[]; remove mapeamento NF_MULTI_ITEM
│   └── fila.routes.ts              # GET /fila devolve N itens; remove NF_MULTI_ITEM
└── __tests__/                      # rateio, consultarNF, dois portões, idempotência por produto, divergência, N=1

apps/web/src/pages/stockbridge/operador/
├── FilaOmiePage.tsx                # lista N itens da NF (não bloqueia multi-item)
└── ConferenciaModal.tsx / novo form multi-item   # conferência por linha; submit itens[]; N=1 = experiência atual
```

**Structure Decision**: Web monorepo modular. O coração é a **refatoração de `processarRecebimento`** para um orquestrador multi-item que faz o loop de um `processarItemRecebimento` extraído da lógica single-item já validada — garantindo, por construção, que N=1 reproduz o comportamento atual (o rateio e a idempotência reduzem ao caso de hoje). A reestruturação de `consultarNF` (cabeçalho + `itens[]`) fica no pacote `integrations/omie`, com consumidor único no serviço. A idempotência por produto é a única mudança de schema (índice). A UI estende a fila/conferência para uma lista pré-preenchida.

## Complexity Tracking

> Constitution Check passou sem violações — preenchimento não requerido.

Notas de design (não são violações):
- **Migration 0046** (índice de idempotência por produto) é necessária porque o índice atual (0044) limita `entrada_nf` a uma por (NF, empresa); é split, não alteração destrutiva, e a chave nova é superconjunto da antiga (ver [data-model.md](./data-model.md) §1).
- **Contrato de `POST /recebimento`** passa a `itens[]` (unificado single/multi). Seguro pré-produção (Princípio V); a suíte single-item é a guarda de regressão do caso N=1.
- **Base de custo** do rateio **confirmada em 15/07: com tributos, como hoje** (ver [research.md](./research.md) §D2). A fórmula de arredondamento/reconciliação de resíduo fica para a implementação.
