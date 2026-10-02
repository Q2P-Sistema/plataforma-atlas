# Contract — Recebimento Fiscal da NF Nacional pelo Atlas (API)

**Feature**: `016-recebimento-fiscal-nf`

Mesmo prefixo protegido da feature 015 (`requireAuth` + `csrfProtection` + `requireModule('stockbridge')`), envelope `{ data, error }`, identidade da NF pela **chave de acesso** (44 dígitos). As rotas da 015 continuam valendo; esta feature **estende** três delas e **adiciona** quatro.

Flag `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` (default `false`). Desligada: fila/detalhe/POST comportam-se exatamente como na 015 e as rotas novas respondem `403 RECEBIMENTO_FISCAL_DESABILITADO`.

---

## 1. `GET /api/v1/stockbridge/recebimento/nacional/fila` — estendida

Cada item ganha a situação fiscal. A fonte "fiscal pendente" só entra com a flag ligada.

**200** (acrescido ao shape da 015):
```json
{ "data": [ {
  "nfChaveAcesso": "35261014555032000753550010000068421827355174",
  "notaFiscal": "6842",
  "fornecedorNome": "REPLAS COMERCIAL LTDA",
  "fornecedorCnpj": "14.555.032/0007-53",
  "dtEmissao": "2026-10-01",
  "diasDesdeEmissao": 1,
  "itensTotal": 1,
  "itensPendentes": 1,
  "valorTotalBrl": 203400.00,
  "fiscal": "pendente",
  "fiscalConcluidoPeloAtlasEm": null
} ], "error": null }
```

Invariantes: (1) uma chave aparece uma única vez; (2) chave com dispensa ativa não aparece; (3) `fiscal: "concluido"` sempre que a NF existe no espelho de NF **ou** há ledger `concluido`/`ja_concluido`; (4) ordenação por emissão, desempate pelo número — igual à 015.

## 2. `GET /api/v1/stockbridge/recebimento/nacional/fila/:chaveAcesso` — estendida

**200** (acrescido):
```json
{ "data": {
  "…": "shape da 015",
  "fiscal": "pendente",
  "nIdReceb": 8510564869,
  "recebimentoFiscalHabilitado": true,
  "dispensavel": true
}, "error": null }
```

Itens de NF com fiscal pendente vêm do espelho de recebimentos (`v_total_item` como valor do item — research D7). `linhasForaDoRecorte` conta os itens com `c_cfop_entrada` fora do recorte.

**Erros** (além dos da 015): `404 NF_NAO_ENCONTRADA` também quando a NF só existe com dispensa ativa (mensagem: "A NF <n> foi dispensada da fila pelo gestor em <data>. Para recebê-la, peça a reversão da dispensa.").

## 3. `POST /api/v1/stockbridge/recebimento/nacional/por-nf` — estendida

Corpo **inalterado** (`.strict()`). Comportamento novo, nesta ordem:

1. Portão 1 (validação tudo-ou-nada) — igual à 015.
2. **Fiscal**: se `fiscal === "pendente"` e há ao menos um produto a gravar e a flag está ligada → `EDITAR` → `IGNORAR` → `Concluir` no OMIE, com lock no ledger.
3. Portão 2 (gravação por produto) — igual à 015.

**201** (acrescido):
```json
{ "data": {
  "…": "shape da 015",
  "fiscal": { "status": "concluido", "concluidoEm": "2026-10-02T10:39:50.000Z",
              "mensagem": "Recebimento fiscal da NF 6842 (REPLAS COMERCIAL LTDA) concluído no OMIE." }
}, "error": null }
```

`fiscal.status`: `concluido` | `ja_concluido` ("já estava concluído no OMIE — nada a fazer") | `nao_aplicavel` (fiscal já feito antes; ou nenhum produto será gravado) | `desligado`.

**Erros novos** (nenhum deles grava movimentação/aprovação):

| HTTP | code | Quando | userMessage |
|---|---|---|---|
| 502 | `RECEBIMENTO_FISCAL_FAIL` | fault/timeout em EDITAR, IGNORAR ou Concluir e a reconsulta não mostrou concluído | "Não foi possível concluir o recebimento fiscal da NF 6842 (REPLAS COMERCIAL LTDA) no OMIE. Nada foi registrado — tente novamente em instantes. Se persistir, avise o fiscal." (fornecedor nulo → "(fornecedor não identificado no OMIE)") |
| 409 | `RECEBIMENTO_FISCAL_EM_ANDAMENTO` | outra confirmação da mesma NF está em curso (ledger `em_andamento` < 5 min) | "O recebimento fiscal da NF 6842 já está sendo concluído. Aguarde alguns segundos e recarregue a nota." |
| 422 | `RECEBIMENTO_FISCAL_SEM_FORNECEDOR` | NF sem fornecedor cadastrado no OMIE (fault específico — research D8) | "A NF 6842 está sem fornecedor cadastrado no OMIE. Peça ao fiscal para cadastrar o fornecedor e tente de novo." |

Invariantes: (5) repetir o POST não conclui o fiscal duas vezes (ledger) nem grava estoque em dobro (índice da 015); (6) falha no fiscal ⇒ zero `INSERT`; (7) `ja_concluido` ⇒ segue para o portão 2 normalmente.

## 4. `POST /api/v1/stockbridge/recebimento/nacional/dispensar` — nova

**Role**: `requireGestor`. **Body** (`.strict()`): `{ "nf_chave_acesso": "<44 dígitos>", "motivo": "<1..1000>" }`.

Qualquer NF da fila (fiscal pendente **ou** já feito) com ao menos um item pendente e sem dispensa ativa. Não chama OMIE. Grava a situação fiscal no momento da dispensa e **envia e-mail ao fiscal** (FR-026; destinatários em `STOCKBRIDGE_FISCAL_EMAILS`, default NFe ACXE + Mauricio Yared + Gustavo Dreer) descrevendo a pendência que fica no OMIE (etapa 40 aguardando manifestação/cancelamento, ou conta a pagar de R$ N a estornar ou manter); falha no e-mail não desfaz a dispensa (best-effort, logado).

**201**: `{ "data": { "id": "<uuid>", "notaFiscal": "1394", "fornecedorNome": "ECOPLAST …", "situacaoFiscalNaDispensa": "pendente", "dispensadoEm": "…" }, "error": null }`

**Erros**: `400 MOTIVO_OBRIGATORIO`; `404 NF_NAO_ENCONTRADA`; `409 NF_JA_DISPENSADA`; `422 NF_NAO_DISPENSAVEL` ("A NF <n> já foi recebida no Atlas — não há o que dispensar." — só quando nenhum item está pendente); `403 RECEBIMENTO_FISCAL_DESABILITADO`.

## 5. `GET /api/v1/stockbridge/recebimento/nacional/dispensas` — nova

**Role**: `requireGestor`. **Query**: `{ incluirRevertidas?: boolean }` (default `false`).

**200**:
```json
{ "data": [ {
  "id": "<uuid>", "nfChaveAcesso": "…", "notaFiscal": "1394",
  "fornecedorNome": "ECOPLAST INDUSTRIA E COMERCIO DE PLASTICO LTDA -ME",
  "situacaoFiscalNaDispensa": "concluido",
  "motivo": "Carga nunca chegou; fornecedor vai estornar",
  "dispensadoPor": { "id": "…", "nome": "…" }, "dispensadoEm": "…",
  "revertidoPor": null, "revertidoEm": null, "motivoReversao": null
} ], "error": null }
```

## 6. `POST /api/v1/stockbridge/recebimento/nacional/dispensas/:id/reverter` — nova

**Role**: `requireGestor`. **Body**: `{ "motivo": "<1..1000>" }`.

**200**: `{ "data": { "id": "…", "notaFiscal": "1394" }, "error": null }`. A NF volta à fila na situação fiscal em que estiver.

**Erros**: `404 DISPENSA_NAO_ENCONTRADA` (inexistente ou já revertida); `400 MOTIVO_OBRIGATORIO`.

## 7. `GET /api/v1/stockbridge/recebimento/nacional/fiscal` — nova (rastreabilidade)

**Role**: `requireGestor`. **Query**: `{ status?: 'concluido'|'ja_concluido'|'falha'|'em_andamento', limit?: 1..200 }`.

**200**: lista do ledger (`notaFiscal`, `fornecedorNome`, `status`, `passoFalha`, `confirmadoPor {id, nome}`, `iniciadoEm`, `finalizadoEm`). `erro_omie_*` **não** sai desta rota (fica no banco e no log — ACXEGDP-313).

---

## Invariantes gerais

8. Nenhuma mensagem ao usuário carrega `nIdReceb`, `faultcode` ou código de produto do OMIE.
9. Nenhuma rota de leitura consulta o OMIE; a única leitura ao vivo é a `ConsultarRecebimento` **dentro** do POST por-nf, imediatamente antes de escrever (exceção documentada ao Princípio II).
10. Operador não dispensa, não reverte e não lista o ledger (403 por `requireGestor`).
