# Phase 1 — Data Model: Validações na Busca de NF do Recebimento

**Feature**: 012-validacao-busca-nf | **Date**: 2026-06-24

> **Sem persistência nova.** Esta feature **não cria tabela, não altera schema e não gera migration**. Os "modelos" abaixo são **tipos TypeScript** (em memória) consumidos no fluxo de recebimento. O dado de origem é a resposta ao vivo de `produtos/nfconsultar/` do OMIE.

---

## 1. `ConsultarNFResponse` (estendido)

Arquivo: [packages/integrations/omie/src/stockbridge/nf.ts](../../packages/integrations/omie/src/stockbridge/nf.ts)

Campos **já existentes** (mantidos): `nNF`, `cChaveNFe`, `dEmi`, `nCodProd`, `codigoLocalEstoque`, `qCom`, `uCom`, `xProd`, `vUnCom`, `vNF`, `nCodCli`, `cRazao`.

Campos **novos** (derivados da mesma resposta `ConsultarNF`):

| Campo | Tipo | Origem (raw OMIE) | Descrição |
|---|---|---|---|
| `cancelada` | `boolean` | `ide.dCan` / `ide.dInut` / denegação (`cDeneg`) preenchidos | `true` se a NF está cancelada, inutilizada ou denegada (critério FR-003/005). Derivado: OR dos sinais. |
| `sinaisCancelamento` | `{ dCan?: string; dInut?: string; cDeneg?: string }` | `ide`/`compl` | Sinais brutos preservados para log/diagnóstico (opcional; útil no alerta). |
| `tpNF` | `number \| undefined` | `ide.tpNF` | Tipo de operação: `0`=entrada, `1`=saída. `undefined` se ausente → indeterminado. |
| `cnpjEmitente` | `string \| undefined` | `nfEmitInt`/emitente | CNPJ de quem emitiu a NF. `undefined` se ausente → indeterminado. |

**Regras de validação derivadas** (não são colunas — são lógica da engine):
- `cancelada === true` → **bloqueada (cancelada)**.
- Contexto ACXE e (`tpNF` indica entrada **ou** `cnpjEmitente` ≠ CNPJ ACXE) → **bloqueada (nao_emitida_acxe)**.
- Sinais necessários ausentes (`cancelada` não-determinável, ou `tpNF`/`cnpjEmitente` ausentes quando relevantes) → **indeterminada** (fail-open).

---

## 2. `ResultadoValidacaoNf` (novo — união discriminada)

Arquivo: `modules/stockbridge/src/services/nf-validacao.service.ts` (novo)

```text
type ResultadoValidacaoNf =
  | { status: 'ok' }
  | { status: 'bloqueada'; motivo: 'cancelada' | 'nao_emitida_acxe' }
  | { status: 'indeterminada'; motivo: 'cancelamento_desconhecido' | 'emitente_desconhecido' }
```

| Estado | Significado | Efeito no call-site |
|---|---|---|
| `ok` | NF válida e (no contexto ACXE) emitida pela ACXE | segue o fluxo normal de recebimento |
| `bloqueada / cancelada` | NF cancelada/inutilizada/denegada | erro tipado `NotaFiscalCanceladaError` → HTTP 422 |
| `bloqueada / nao_emitida_acxe` | NF de entrada de terceiro (colisão) | erro tipado `NotaFiscalNaoEmitidaPelaAcxeError` → HTTP 422 |
| `indeterminada / *` | Sinal necessário ausente na resposta OMIE | fail-open: recebe + `enviarAlertaNfIndeterminada` + log |

**Função pura** (sem I/O):
`validarNfRecebivel(nf: ConsultarNFResponse, contexto: { cnpj: 'acxe' | 'q2p' }): ResultadoValidacaoNf`

Ordem de avaliação: **cancelamento primeiro** (vale para qualquer contexto), depois **emitente** (só no contexto ACXE). Assim "NF da ACXE porém cancelada" é bloqueada por cancelamento (edge case do spec).

---

## 3. Entrada de contexto

A engine precisa apenas do `cnpj` do contexto de recebimento (`'acxe' | 'q2p'`), já presente em `getFilaOmie`/`processarRecebimento` ([recebimento.service.ts](../../modules/stockbridge/src/services/recebimento.service.ts)). O CNPJ real da ACXE para comparação com `cnpjEmitente` deve vir de configuração/constante já existente do cliente OMIE (não hardcode espalhado).

---

## Transições de estado

Nenhuma. A validação é **stateless** — uma função pura de `(NF, contexto) → resultado`. Não há ciclo de vida persistido, não há máquina de estados nova. O estado do recebimento (provisório/aprovação/etc.) permanece exatamente como hoje.

## Auditoria / persistência

- **Bloqueio**: nenhuma escrita em tabela (a NF não entra). Registro via Pino estruturado (FR-009): `{ evento: 'nf_recebimento_bloqueado', motivo, nf, cnpj, userId }`.
- **Fail-open**: o recebimento segue normalmente e suas escritas já são cobertas pelos triggers de audit existentes do StockBridge (Princípio IV). O alerta ao admin é efeito colateral (e-mail), não persistência de domínio.
