# Phase 1 — Quickstart: Validações na Busca de NF do Recebimento

**Feature**: 012-validacao-busca-nf | **Date**: 2026-06-24

Como exercitar e validar a feature em dev e em UAT.

## Pré-requisitos
- Monorepo instalado (`pnpm install`).
- `OMIE_MODE=mock` em dev (sem credenciais OMIE). Os cenários sintéticos vêm das fixtures do mock.

## 1. Testes automatizados (dev, mock)

```bash
# engine pura + rotas do recebimento
pnpm --filter @atlas/stockbridge test
# (ou o runner Vitest do módulo)
```

Cobertura esperada (ver [contracts/receiving-validation.md](./contracts/receiving-validation.md) §4):
- **Unit** `validarNfRecebivel`: cancelada → bloqueada/cancelada; entrada de terceiro (acxe) → bloqueada/nao_emitida_acxe; saída ACXE → ok; q2p não bloqueia por emitente; NF ACXE cancelada → cancelada (não emitente); sinal ausente → indeterminada.
- **Integração** (Supertest): GET fila e POST recebimento devolvendo 422 nos bloqueios e 201 no fail-open; ausência de escrita no bloqueio; spy confirmando alerta no fail-open.

## 2. Fixtures do mock a adicionar

Em [packages/integrations/omie/src/stockbridge/mock.ts](../../packages/integrations/omie/src/stockbridge/mock.ts), `mockConsultarNF` deve poder devolver, por número/sufixo de NF, cenários:
- NF **válida ACXE** (já existe): saída, emitente ACXE, sem sinais de cancelamento.
- NF **cancelada**: `cancelada=true` (ex.: `dCan` preenchido).
- NF **de entrada de terceiro**: `tpNF`=entrada / `cnpjEmitente` ≠ ACXE.
- NF **indeterminada**: sem `tpNF`/`cnpjEmitente` (ou sem sinais de cancelamento determináveis).

Sugestão: convencionar números de NF de teste (ex.: terminação `...90`=cancelada, `...91`=entrada terceiro, `...92`=indeterminada) para os testes serem legíveis.

## 3. Teste manual em dev (UI)

1. Subir API + web (`pnpm dev` conforme o projeto).
2. StockBridge → Recebimento → buscar a NF de teste "cancelada" → deve mostrar mensagem de bloqueio (não listar para receber).
3. Buscar a NF "entrada de terceiro" (contexto ACXE) → mensagem `não foi emitida pela ACXE`.
4. Buscar a NF válida → fluxo normal de conferência/recebimento.
5. Buscar a NF "indeterminada" → recebe normalmente; verificar log estruturado `nf_recebimento_bloqueado`/`nf_indeterminada` e o e-mail de alerta (em dev, conferir o transporte de e-mail mockado/log do Sendgrid).

## 4. Validação contra OMIE real (UAT) — obrigatória

Dev é mock e o banco DEV é sanitizado/defasado; os **nomes/posições reais** dos campos de cancelamento e emitente em `produtos/nfconsultar/` só se confirmam ao vivo (ver [research.md](./research.md) R1/R2).

1. Em UAT (OMIE real, `OMIE_MODE=real`), escolher:
   - uma NF **sabidamente cancelada** → confirmar bloqueio `NF_CANCELADA`.
   - um **número colidente** (existe como entrada de terceiro e como saída ACXE) → confirmar que só a NF da ACXE é aceita.
   - uma NF **válida** recém-emitida → confirmar que recebe normalmente (sem falso bloqueio).
2. Se algum campo real divergir do mapeado, ajustar o mapeamento em `nf.ts` (a engine não muda).
3. Registrar o resultado no roteiro de paridade da validação paralela do StockBridge (Princípio V) — esta feature torna o Atlas mais estrito que o legado; a divergência (bloquear cancelada/não-ACXE) é melhoria intencional.

## 5. Critérios de pronto (mapeados ao spec)
- SC-001/SC-002/SC-003: bloqueios funcionando, nenhuma escrita em bloqueio.
- SC-004: nenhum falso bloqueio em NFs válidas da ACXE (regressão coberta por teste + UAT).
- SC-005: toda tentativa bloqueada mostra `userMessage` clara.
- SC-006/SC-007: bloqueios logados; indeterminados liberam + alertam admin (spy/te-mail).
