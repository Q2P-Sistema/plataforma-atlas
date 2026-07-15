# Contrato — Recebimento de Importação Multi-Item

**Feature**: 013-importacao-multi-produto | **Date**: 2026-07-15

Dois endpoints já existentes mudam de forma; nenhum endpoint novo. Auth e middlewares inalterados: `requireAuth` + `csrfProtection` + `requireModule('stockbridge')` + `requireOperador` + `requireArmazemVinculado`. Importação é **ACXE-only**.

---

## 1. `GET /api/v1/stockbridge/fila`

Busca a NF por número e devolve os itens a receber.

**Query** (inalterada): `{ nf: string(min 1), cnpj?: 'acxe'|'q2p' }` — o front envia `cnpj='acxe'`.

**Mudança**: para uma NF multi-item, devolve **N** elementos em `data` (um por produto), em vez de bloquear. O shape de `FilaItem` é o atual — a lista simplesmente passa a ter mais de um item.

**Resposta `200`**:
```jsonc
{ "data": [
    { "nf": "0000531", "tipo": "importacao", "cnpj": "acxe",
      "produto": { "codigo": <acxe>, "nome": "PEBD 101" },
      "qtdOriginal": 24000, "unidade": "kg", "qtdKg": 24000,
      "localidadeCodigo": "...", "dtEmissao": "2026-07-07", "custoBrl": <rateado> },
    { "nf": "0000531", ..., "produto": { "nome": "PEBD 323" }, ... }
  ], "error": null }
```
- `custoBrl` por item passa a refletir o **valor rateado** do item (D2 do research), não `vNF÷qtd`.

**Erros** (mapeamento inalterado, menos um): `422 NF_CANCELADA`, `422 IMPORTACAO_APENAS_ACXE`, `422 NF_NAO_EMITIDA_ACXE`, `500 FILA_FAIL`. **Removido**: `422 NF_MULTI_ITEM` (multi-item deixa de ser bloqueio).

---

## 2. `POST /api/v1/stockbridge/recebimento`

Confirma o recebimento de **1..N** produtos de uma NF. Contrato **unificado**: o corpo sempre carrega `itens[]` (single-item = array de 1).

**Body** (Zod):
```jsonc
{
  "nf": "0000531",
  "cnpj": "acxe",
  "itens": [                                   // min 1
    {
      "produto_codigo_acxe": 123456,           // int > 0 — identifica a linha da NF (do fila)
      "quantidade_input": 24000,               // number > 0
      "unidade_input": "kg",                   // 't'|'kg'|'saco'|'bigbag'
      "localidade_id": "uuid",
      "observacoes": "…",                      // obrigatório se o item diverge
      "tipo_divergencia": "faltando"           // 'faltando'|'varredura' — obrigatório se diverge
    }
  ]
}
```
Regras Zod adicionais: `itens` não-vazio; `produto_codigo_acxe` único dentro do array (um produto por linha da NF); refine por item: se há divergência (a engine detecta no servidor), `observacoes` e `tipo_divergencia` obrigatórios.

**Sucesso `201`**:
```jsonc
{ "data": {
    "nf": "0000531",
    "itens": [
      { "produtoCodigoAcxe": 123456, "status": "provisorio",
        "loteId": "…", "loteCodigo": "L…", "movimentacaoId": "…",
        "omie": { "acxe": "…", "q2p": "…" } },
      { "produtoCodigoAcxe": 234567, "status": "aguardando_aprovacao",
        "loteId": "…", "aprovacaoId": "…", "deltaKg": -320 },
      { "produtoCodigoAcxe": 345678, "status": "pendente_q2p",
        "loteId": "…", "movimentacaoId": "…", "omie": { "acxe": "…" } }
    ],
    "resumo": { "recebidos": 1, "aguardandoAprovacao": 1, "pendentesOmie": 1, "falhas": 0 }
  }, "error": null }
```

### Regras de resposta / erro (dois portões — D5 do research)

**Portão 1 — validação prévia (tudo-ou-nada, antes de qualquer escrita OMIE)**. Falha aqui ⇒ **nenhum** item gravado:
| Situação | HTTP | code |
|---|---|---|
| Body inválido (Zod) | `400` | `INVALID_INPUT` |
| Sem sessão | `401` | `UNAUTHENTICATED` |
| NF cancelada | `422` | `NF_CANCELADA` |
| NF não emitida pela ACXE | `422` | `NF_NAO_EMITIDA_ACXE` |
| cnpj != acxe | `422` | `IMPORTACAO_APENAS_ACXE` |
| **Qualquer** produto sem correlato Q2P / inválido | `409` | `PRODUTO_SEM_CORRELATO` (mensagem nomeia o(s) produto(s) pela **descrição**) |
| Todos os produtos já recebidos (idempotência) | `409` | `NF_JA_PROCESSADA` |
| Excedente (recebido > NF) em algum item | `422` | `QUANTIDADE_EXCEDE_NF` (nomeia o item) |

**Portão 2 — escrita (best-effort por item)**. Passou o Portão 1 ⇒ resposta é sempre `201`; o desfecho de cada item vem em `data.itens[].status`:
- `provisorio` — conferiu, OMIE dual OK.
- `aguardando_aprovacao` — divergência; foi para o gestor (OMIE diferido).
- `pendente_q2p` — ACXE OK, Q2P falhou; recuperável no painel de operações pendentes (por item).
- `falha_acxe` — ACXE falhou; item **não** persistido; re-submeter a NF completa esse item (idempotência por produto pula os já concluídos).

> **Recebimento resumível**: como a idempotência é por (NF, empresa, produto), re-`POST` da mesma NF reprocessa só os itens que ainda não concluíram; itens `provisorio`/`aguardando_aprovacao` já existentes não duplicam (índice + checagem `produtoDaNfJaRecebido`).

---

## 3. Notas de compatibilidade

- **Single-item (N=1)**: o front envia `itens: [umItem]`; a resposta traz `itens: [umResultado]`. O comportamento observável (OMIE dual, provisório/divergência, idempotência) é idêntico ao atual — a suíte Vitest single-item é a guarda de regressão.
- **Painel de operações pendentes** (`GET /operacoes-pendentes`, retry por `movimentacaoId`): **inalterado**. Cada item pendente é uma `movimentacao` independente; N itens pendentes de uma NF aparecem como N linhas, cada uma com retry próprio.
- **Aprovação** (`POST /aprovacoes/:id/aprovar` no ramo `recebimento_divergencia`): **inalterada**; opera por `aprovacao` (uma por item divergente).
