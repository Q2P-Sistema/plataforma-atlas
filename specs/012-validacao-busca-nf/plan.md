# Implementation Plan: Validações na Busca de NF do Recebimento (cancelada + emitente ACXE)

**Branch**: `012-validacao-busca-nf` | **Date**: 2026-06-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/012-validacao-busca-nf/spec.md`
**Jira**: ACXEGDP-204 + ACXEGDP-205 (subtarefas de ACXEGDP-114)

## Summary

Adicionar duas validações sobre o resultado da busca de NF por número no recebimento StockBridge, atuando no mesmo ponto de código (`consultarNF` → `getFilaOmie`/`processarRecebimento`):

1. **NF cancelada** não pode ser recebida (ACXEGDP-204).
2. No contexto **ACXE**, considerar apenas NFs **emitidas pela ACXE**, descartando NF de entrada de terceiro com numeração coincidente (ACXEGDP-205).

**Abordagem técnica**: estender o tipo de retorno de `consultarNF` (`packages/integrations/omie`) para expor os sinais de cancelamento (`ide.dCan`/`ide.dInut`/`compl.cDeneg`) e de emitente/tipo de operação (`ide.tpNF` e CNPJ emitente) que já vêm na mesma resposta do OMIE consultada ao vivo. Uma **função pura de validação** em TypeScript (coberta por Vitest) decide `ok | bloqueada | indeterminada`. Ela é aplicada nos **dois** caminhos (busca e confirmação) para não deixar janela (FR-008). Bloqueio → erro tipado → HTTP 422 com `userMessage` pt-BR (padrão existente). Indeterminado → **fail-open**: recebimento segue, alerta ao admin/gestor (reuso do padrão `notificacao.service.ts`) + log estruturado (FR-010).

**Sem migration, sem nova tabela, sem escrita nova no OMIE.** A leitura de cancelamento/emitente piga-back na chamada `consultarNF` que o recebimento já faz — exceção ao Princípio II **já documentada** (007).

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, Node.js 20 LTS
**Primary Dependencies**: Express 4 (rota de recebimento), `@atlas/integrations-omie` (cliente `consultarNF`), `@atlas/core` (`createLogger`, `sendEmail`, `getAdminEmail`), Zod (validação de entrada já existente), React 18 + TanStack Query (exibição da mensagem). Sem novas dependências.
**Storage**: Nenhum novo. Leitura **ao vivo** da API OMIE via `produtos/nfconsultar/` (chamada já existente no fluxo); nenhuma escrita em banco além do recebimento normal já existente. Sem migration.
**Testing**: Vitest (unit da engine de validação + mapeamento de campos do mock OMIE), Supertest (rota — bloqueio 422 e fail-open 201). `OMIE_MODE=mock` cobre cenários sintéticos; paridade dos campos reais valida-se em UAT/PROD (dev é sanitizado e mock).
**Target Platform**: Linux server (Docker Swarm, container `apps/api` + `apps/web`).
**Project Type**: Web — monorepo modular (módulo `stockbridge` + pacote `integrations/omie` + `apps/web`).
**Performance Goals**: Custo adicional ~zero — os sinais vêm da resposta `ConsultarNF` que já é buscada; **não** adicionar chamada OMIE extra. Operação manual (poucos recebimentos/dia), sem alvo de throughput.
**Constraints**: (a) NÃO introduzir segunda chamada OMIE por busca; (b) fail-open quando o sinal não vier do OMIE (FR-010), nunca travar operação legítima por ausência de dado; (c) validação aplicada de forma idêntica em busca e confirmação (FR-008).
**Scale/Scope**: Baixo volume, operador-driven. Mudança localizada em ~5 arquivos backend + 2 frontend.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Princípio | Avaliação | Status |
|---|---|---|
| **I. Monólito Modular com Fronteiras Inegociáveis** | Mudanças confinadas a `packages/integrations/omie` (pacote compartilhado, consumido via index), `modules/stockbridge/*` e `apps/web`. Nenhuma leitura direta de tabela privada de outro módulo; nenhuma query cross-módulo nova. | ✅ PASS |
| **II. OMIE é Fonte de Verdade, Atlas Lê do Postgres** | A validação lê cancelamento/emitente **ao vivo** do OMIE. Isso **não é uma exceção nova**: a chamada `consultarNF` (`produtos/nfconsultar/`) já é exceção documentada ao Princípio II (leitura de NF individual — `specs/007-stockbridge-module/research.md` §2). Só estendemos os campos mapeados da MESMA resposta. Enquadra-se na exceção (1) "dado fresquíssimo que não pode aguardar o sync" e evita TOCTOU (mesma foto da NF que está sendo recebida). Reafirmado no clarify. | ✅ PASS (exceção pré-existente, documentada em [research.md](./research.md)) |
| **III. Dinheiro Só em TypeScript** | Toda a lógica (engine de validação, decisão de bloqueio/fail-open) em TS, coberta por Vitest. Nenhum cálculo/regra em n8n. | ✅ PASS |
| **IV. Audit Log Append-Only via Trigger** | Caminho de **bloqueio** não escreve em tabela de domínio → sem necessidade de trigger nova. Caminho **fail-open** é um recebimento normal (triggers de audit existentes do StockBridge já cobrem). Tentativas bloqueadas são registradas via Pino estruturado (FR-009) — sem nova tabela. | ✅ PASS |
| **V. Validação Paralela, Zero Big-Bang** | StockBridge ainda não está em produção (aguarda validação paralela). Esta feature torna o Atlas **mais estrito** que o legado (bloqueia NF cancelada/não-ACXE). Se o legado PHP não filtrava, a divergência é **melhoria intencional**, não bug — deve ser registrada no roteiro de paridade da validação paralela (não exige ADR próprio). | ✅ PASS (com nota de paridade) |

**Resultado do gate**: PASS. Nenhuma violação que exija justificativa em Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/012-validacao-busca-nf/
├── plan.md              # Este arquivo
├── spec.md              # Especificação (com Clarifications)
├── research.md          # Phase 0 — decisões técnicas
├── data-model.md        # Phase 1 — tipos/entidades (sem DB)
├── quickstart.md        # Phase 1 — como testar
├── contracts/           # Phase 1 — contrato dos endpoints de recebimento
│   └── receiving-validation.md
├── checklists/
│   └── requirements.md  # checklist de qualidade da spec
└── tasks.md             # Phase 2 (/speckit.tasks — NÃO criado aqui)
```

### Source Code (repository root)

```text
packages/integrations/omie/src/stockbridge/
├── nf.ts                 # ESTENDER: RawConsultarNF + ConsultarNFResponse
│                         #   → cancelamento (dCan/dInut/cDeneg) + emitente/tpNF + cnpjEmitente
└── mock.ts               # ESTENDER: fixtures p/ NF cancelada, NF de entrada (não-ACXE) e indeterminada

modules/stockbridge/src/
├── services/
│   ├── nf-validacao.service.ts   # NOVO — engine PURA: validarNfRecebivel(nf, contexto) → ok|bloqueada|indeterminada
│   ├── recebimento.service.ts    # WIRE: aplicar validação em getFilaOmie (após consultarNF) e processarRecebimento
│   ├── notificacao.service.ts    # ADICIONAR: enviarAlertaNfIndeterminada (espelha enviarAlertaProdutoSemCorrelato)
│   └── <erros do stockbridge>    # ADICIONAR: NotaFiscalCanceladaError, NotaFiscalNaoEmitidaPelaAcxeError
│                                 #   (junto de NotaFiscalJaProcessadaError / CorrelacaoNaoEncontradaError)
├── routes/
│   └── recebimento.routes.ts     # MAPEAR novos erros → HTTP 422 { data:null, error:{ code, userMessage } }
└── (tests Vitest)                # unit da engine + supertest das rotas (bloqueio 422 / fail-open 201)

apps/web/src/pages/stockbridge/operador/
├── FilaOmiePage.tsx              # exibir motivo do bloqueio na BUSCA (cancelada / não-ACXE)
└── ConferenciaModal.tsx         # exibir motivo na CONFIRMAÇÃO (defesa em profundidade)
```

**Structure Decision**: Web monorepo modular. A lógica de validação nasce como **service puro** em `modules/stockbridge/src/services/nf-validacao.service.ts` (mesmo padrão do `conferencia.service.ts` — engine em TS coberta por Vitest), consumindo o tipo estendido de `consultarNF`. Os dois pontos de entrada (`getFilaOmie`, `processarRecebimento`) chamam a mesma engine, garantindo FR-008. A camada de transporte (rotas) e a UI reusam padrões já existentes de erro/mensagem.

## Complexity Tracking

> Constitution Check passou sem violações — preenchimento não requerido.

Nota única registrada (não é violação): a leitura ao vivo do OMIE para cancelamento/emitente reaproveita a exceção ao Princípio II **já existente** da chamada `consultarNF`; a justificativa está consolidada em [research.md](./research.md) §3, sem necessidade de novo ADR.
