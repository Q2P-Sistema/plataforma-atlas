# Phase 1 — Contract: Endpoints de Recebimento (validação de NF)

**Feature**: 012-validacao-busca-nf | **Date**: 2026-06-24

Esta feature **não cria endpoints novos** — altera o comportamento de dois endpoints existentes do StockBridge, adicionando respostas de bloqueio e mantendo o caminho feliz. Contrato expresso como deltas sobre o comportamento atual.

Arquivo de rotas: [modules/stockbridge/src/routes/recebimento.routes.ts](../../../modules/stockbridge/src/routes/recebimento.routes.ts)

Envelope de resposta (padrão existente): `{ data: <T> | null, error: <ErroBody> | null }`.

```text
ErroBody = {
  code: string          // identificador estável p/ o frontend
  userMessage: string   // pt-BR, exibível ao operador
  message?: string      // técnico (log/diagnóstico)
}
```

---

## 1. GET `/api/v1/stockbridge/fila?nf=<numero>&cnpj=acxe|q2p`

Busca a NF por número (consulta OMIE ao vivo via `consultarNF`).

### Caminho feliz (inalterado)
- **200** `{ data: FilaItemOmie[], error: null }` — NF válida e (contexto ACXE) emitida pela ACXE. NF já processada continua retornando `data: []` (idempotência, inalterado).

### Novos bloqueios

| Situação | HTTP | `error.code` | `error.userMessage` (pt-BR, sugestão) |
|---|---|---|---|
| NF cancelada/inutilizada/denegada | **422** | `NF_CANCELADA` | "A NF {n} está cancelada no OMIE e não pode ser recebida." |
| NF não emitida pela ACXE (entrada de terceiro) — só contexto ACXE | **422** | `NF_NAO_EMITIDA_ACXE` | "A NF {n} não foi emitida pela ACXE (consta como nota de entrada de outro fornecedor). Verifique o número." |

### Fail-open (indeterminado)
- **200** com `data` normal — não bloqueia. Efeitos colaterais: alerta ao admin (`enviarAlertaNfIndeterminada`) + log estruturado. (Opcional: incluir `data[].avisoIndeterminado: true` para a UI exibir nota não-bloqueante; não obrigatório.)

---

## 2. POST `/api/v1/stockbridge/recebimento`

Confirma o recebimento. Reaplica a MESMA validação (FR-008 — defesa em profundidade), pois o status da NF pode ter mudado entre busca e confirmação.

### Caminho feliz (inalterado)
- **201** `{ data: ProcessarRecebimentoResult, error: null }`.

### Novos bloqueios (antes de qualquer escrita/lote/ajuste OMIE)

| Situação | HTTP | `error.code` |
|---|---|---|
| NF cancelada | **422** | `NF_CANCELADA` |
| NF não emitida pela ACXE (contexto ACXE) | **422** | `NF_NAO_EMITIDA_ACXE` |

Garantia (FR-002/FR-003): em qualquer bloqueio, **nenhum** lote, movimentação ou ajuste OMIE é criado.

### Fail-open (indeterminado)
- **201** normal + alerta admin + log. O recebimento segue (FR-010 — não travar por falta de dado).

### Códigos existentes preservados
- **409** `NotaFiscalJaProcessadaError` (idempotência) e `CorrelacaoNaoEncontradaError` — inalterados.
- **502** `OmieAjusteError` — inalterado.

---

## 3. Matriz de decisão (engine `validarNfRecebivel`)

| `cancelada` | contexto | emitente/tpNF | Resultado | HTTP |
|---|---|---|---|---|
| `true` | qualquer | qualquer | bloqueada / cancelada | 422 `NF_CANCELADA` |
| `false` | acxe | entrada / CNPJ ≠ ACXE | bloqueada / nao_emitida_acxe | 422 `NF_NAO_EMITIDA_ACXE` |
| `false` | acxe | saída / CNPJ = ACXE | ok | 200/201 |
| `false` | q2p | (filtro emitente não se aplica) | ok | 200/201 |
| indeterminável | qualquer | — | indeterminada → fail-open | 200/201 + alerta |

> Avaliação **cancelamento antes de emitente**: NF da ACXE porém cancelada → bloqueada por `NF_CANCELADA`.

---

## 4. Critérios de teste do contrato (Vitest + Supertest)

1. GET fila com NF cancelada → 422 `NF_CANCELADA`, `data: null`.
2. GET fila (contexto acxe) com NF de entrada de terceiro → 422 `NF_NAO_EMITIDA_ACXE`.
3. GET fila com NF válida da ACXE → 200 com item.
4. POST recebimento de NF cancelada → 422 e **nenhuma** escrita (verificar ausência de lote/movimentação/ajuste).
5. POST recebimento com sinal ausente (indeterminado) → 201 + `enviarAlertaNfIndeterminada` chamado (spy) + log.
6. Contexto q2p: filtro de emitente NÃO bloqueia (comportamento atual preservado).
7. NF da ACXE cancelada → bloqueada por `NF_CANCELADA` (não por emitente).
