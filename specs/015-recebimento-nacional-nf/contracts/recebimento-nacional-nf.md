# Contract — Recebimento Nacional a partir da NF

**Feature**: `015-recebimento-nacional-nf`

Todas as rotas ficam sob o prefixo já protegido em [stockbridge.routes.ts:37](../../../modules/stockbridge/src/routes/stockbridge.routes.ts#L37) (`requireAuth` + `csrfProtection` + `requireModule('stockbridge')`) e usam o envelope padrão `{ data, error }`.

As três rotas existentes do recebimento nacional (`GET .../localidades`, `GET .../produtos`, `POST .../nacional`) **permanecem inalteradas** — FR-014 exige que o caminho manual siga funcionando.

**Identidade do documento**: a NF é identificada pela **chave de acesso de 44 dígitos**, nunca pelo número. O número colide entre fornecedores (125 colisões nas 3.241 NFs elegíveis — research D19) e serve apenas para exibição.

---

## 1. `GET /api/v1/stockbridge/recebimento/nacional/fila`

Lista as NFs nacionais elegíveis. Leitura 100% do espelho — zero chamada OMIE.

**Role**: `requireOperador` + `requireArmazemVinculado`.

**Query**: `{ fornecedor?: string, q?: string }`

A data de corte **não** é parâmetro de requisição: é configuração do ambiente (7 dias antes da entrada em operação — research D23). Expor como query permitiria a um cliente puxar histórico que a feature decidiu não cobrir.

Os exemplos abaixo usam a NF 66724 real, verificada no espelho PROD em 17/09/2026.

**200**:
```json
{ "data": [ {
  "nfChaveAcesso": "35260868176072000128550010000667241693158505",
  "notaFiscal": "66724",
  "fornecedorNome": "ISOFORMA PLASTICOS INDUSTRIAIS LTDA",
  "fornecedorCnpj": "68.176.072/0001-28",
  "dtEmissao": "2026-08-06",
  "diasDesdeEmissao": 42,
  "cfop": "1.102",
  "itensTotal": 1,
  "itensPendentes": 1,
  "valorTotalBrl": 156604.00
} ], "error": null }
```

Ordenação: emissão mais antiga primeiro; desempate pelo número.

**Erros**: `400 INVALID_QUERY`; `500 FILA_NACIONAL_FAIL`.
**Degradação**: falha de banco devolve lista vazia com log `warn`, como `getFilaPendente` — a fila é informativa e não pode derrubar a tela.

---

## 2. `GET /api/v1/stockbridge/recebimento/nacional/fila/:chaveAcesso`

Detalhe de uma NF, com itens resolvidos e sugestões de produto.

**Path**: `chaveAcesso` — 44 dígitos.

**200**:
```json
{ "data": {
  "nfChaveAcesso": "35260868176072000128550010000667241693158505",
  "notaFiscal": "66724",
  "fornecedorNome": "ISOFORMA PLASTICOS INDUSTRIAIS LTDA",
  "fornecedorCnpj": "68.176.072/0001-28",
  "dtEmissao": "2026-08-06",
  "cfop": "1.102",
  "valorTotalBrl": 156604.00,
  "itens": [ {
    "indice": 0,
    "descricaoFornecedor": "SUCATA  PSAI MOIDO MESCLADO GROSSO",
    "quantidadeNf": 13160.0,
    "unidadeOriginal": "KG",
    "quantidadeNfKg": 13160.0,
    "valorUnitarioBrl": 11.90,
    "valorTotalItemBrl": 156604.00,
    "produtosSugeridos": [
      { "codigo": 3033097757, "descricao": "PS CRISTAL A", "vezesUsada": 12 },
      { "codigo": 3033097763, "descricao": "PS AI B",      "vezesUsada": 9 }
    ],
    "bloqueio": null,
    "jaRecebido": false,
    "quantidadeNfJaAtribuidaKg": 0,
    "quantidadeRestanteKg": 13160.0,
    "baixadoComoExterno": false
  } ]
} , "error": null }
```

`jaRecebido` vem da checagem de duas vias (data-model §3.1): por (chave, descrição) no caminho novo, e por número + empresa para os recebimentos do formulário manual, que não têm chave. `baixadoComoExterno` indica item retirado da fila por recebimento externo aprovado (§5).

`produtosSugeridos` é uma **lista** — a correlação é 1:N (research D18). Vem vazia quando o par (fornecedor, descrição) é inédito, e nesse caso `bloqueio` é `"sem_correlacao"`. Os valores possíveis são `null`, `"unidade_nao_conversivel"` (grafia fora da tabela), `"unidade_incoerente"` (a unidade declarada contradiz a quantidade — FR-029) e `"sem_correlacao"`.

Itens com a mesma descrição na mesma NF são agregados antes de devolver (a NF 58396 da Zaraplast tem 6 linhas para 4 descrições).

**Erros**: `404 NF_NAO_ENCONTRADA` (fora do espelho, do recorte de CFOP ou da janela); `422 NF_CANCELADA`; `422 FORNECEDOR_EXCLUIDO`; `500 DETALHE_NF_FAIL`.

---

## 3. `POST /api/v1/stockbridge/recebimento/nacional/por-nf`

Dá entrada nos itens escolhidos. O cliente **não** envia valor — esse vem da NF. Envia a quantidade **conferida na balança**, que pode divergir da NF.

**Role**: `requireOperador` + `requireArmazemVinculado`.

**Body**:
```json
{
  "nf_chave_acesso": "35260868176072000128550010000667241693158505",
  "observacoes": "opcional",
  "itens": [ {
    "indice": 0,
    "descricao_fornecedor": "SUCATA  PSAI MOIDO MESCLADO GROSSO",
    "quantidade_conferida_kg": 13500.0,
    "motivo_divergencia": "Peso da balança acima do declarado na NF",
    "produtos": [
      { "produto_codigo_q2p": 3033097757, "quantidade_kg": 9000.0, "localidade_id": "uuid" },
      { "produto_codigo_q2p": 3033097763, "quantidade_kg": 4500.0, "localidade_id": "uuid" }
    ]
  } ]
}
```

**Regras de validação**:

| Regra | Comportamento |
|---|---|
| `Σ produtos[].quantidade_kg` = **quantidade ainda não distribuída** do item | obrigatório (FR-021). Na primeira submissão é a conferida inteira; numa retomada, é o que falta — senão a regra pediria redistribuir peso já lançado. O **rateio do valor**, porém, usa sempre a quantidade conferida do item inteiro como denominador, nunca o `Σ` da submissão (data-model.md §6) |
| `\|quantidade_conferida_kg − quantidadeNfKg\| > 1` | é divergência: `motivo_divergencia` passa a ser obrigatório (FR-018) |
| conferida **maior** que a da NF | **aceita** com motivo (FR-019) — diferente da importação, que lança `QuantidadeExcedeNfError` |
| `quantidade_conferida_kg` ausente | assume a quantidade da NF (caminho sem divergência) |
| valor de item ou valor total no payload | rejeitado — o valor vem da NF |
| item com unidade não conversível **ou incoerente** | **não é erro da requisição**: o item volta com `status: "bloqueado_unidade"` ou `"bloqueado_unidade_incoerente"` e os demais itens da NF são processados normalmente (FR-009, FR-029 + edge case da spec) |
| `produtos[]` com o mesmo `produto_codigo_q2p` repetido no mesmo item | rejeitado com `PRODUTO_REPETIDO_NO_ITEM` — sem isso a segunda linha colide no índice e é traduzida para `ja_recebido`, perdendo peso em silêncio |
| `localidade_id` espelhada | rejeitada no servidor, mesmo se o cliente enviar |

**201** (sempre que passa a validação de entrada; desfecho por produto, no padrão da feature 013):
```json
{ "data": {
  "nfChaveAcesso": "352608...8505",
  "notaFiscal": "66724",
  "produtos": [ {
    "produto": "PS CRISTAL A",
    "status": "aguardando_aprovacao",
    "movimentacaoId": "uuid",
    "aprovacaoId": "uuid",
    "quantidadeKg": 9000.0,
    "quantidadeNfKg": 8773.33,
    "divergenciaKg": 226.67,
    "valorItemBrl": 104402.67
  } ],
  "resumo": { "enviadosParaAprovacao": 2, "jaRecebidos": 0, "bloqueados": 0, "falhas": 0 }
}, "error": null }
```

**Status por produto**: `aguardando_aprovacao` | `ja_recebido` | `bloqueado_unidade` | `bloqueado_unidade_incoerente` | `falha`.
Não há `provisorio` nem `pendente_q2p`: o nacional é single-empresa e o ajuste OMIE só ocorre na aprovação do gestor (fluxo atual, inalterado).

**Erros**: `400 INVALID_INPUT`; `400 DISTRIBUICAO_NAO_FECHA` (soma dos produtos ≠ conferida); `400 MOTIVO_DIVERGENCIA_OBRIGATORIO`; `400 LOCALIDADE_NAO_ELEGIVEL`; `404 NF_NAO_ENCONTRADA`; `404 PRODUTO_NAO_ENCONTRADO`; `400 PRODUTO_REPETIDO_NO_ITEM`; `409 NF_JA_PROCESSADA` (todos os produtos já recebidos); `500 RECEBIMENTO_NACIONAL_NF_FAIL`.

> `UNIDADE_NAO_CONVERSIVEL` **não** é erro de requisição. Uma versão anterior deste contrato o listava como `422` e, ao mesmo tempo, previa `bloqueado_unidade` como status por produto — as duas coisas são incompatíveis, e a spec exige que os demais itens sejam recebidos. Vale o status por produto.

**Idempotência**: garantida por `movimentacao_nf_nacional_idempotencia_idx` sobre `(nf_chave_acesso, nf_item_descricao_normalizada, produto_codigo_q2p)`. Violação `23505` vira `status: "ja_recebido"` do produto, não erro da requisição — reenviar a mesma NF é seguro e completa só o que falta.

A descrição do item entra na chave porque duas linhas distintas da mesma NF podem ser classificadas no **mesmo** produto (descrições que diferem só por lote). Sem ela, a segunda linha colidiria e seria traduzida para `ja_recebido`, perdendo a quantidade sem nenhum erro visível.

**Mensagens**: produto por descrição, local por nome. Nenhum código interno do OMIE em mensagem de usuário (ACXEGDP-313).

---

## 4. `PUT /api/v1/stockbridge/recebimento/nacional/correlacao`

Grava ou ajusta a correlação memorizada. Chamada implicitamente no recebimento e explicitamente quando o operador altera antes de dar entrada.

**Role**: `requireOperador`.

**Body**:
```json
{
  "nf_chave_acesso": "35260868176072000128550010000667241693158505",
  "descricao_nf": "SUCATA  PSAI MOIDO MESCLADO GROSSO",
  "produtos_codigo_q2p": [3033097757, 3033097763]
}
```

Envia o **conjunto** de produtos. Produtos ausentes do conjunto que existiam antes são desativados (`ativo = false`, auditado), nunca removidos.

`fornecedor_cnpj`, `fornecedor_nome` e `produto_descricao` — que o modelo define como `NOT NULL` — são resolvidos **no servidor** a partir da chave da NF e do catálogo, não enviados pelo cliente. O cliente não tem como saber a razão social canônica, e aceitá-la do payload abriria caminho para gravar um nome divergente do cadastro.

**200**: `{ "data": { "adicionados": 1, "mantidos": 1, "desativados": 0 }, "error": null }`

**Erros**: `400 INVALID_INPUT`; `404 PRODUTO_NAO_ENCONTRADO`; `400 PRODUTO_REPETIDO_NO_ITEM`; `500 CORRELACAO_FAIL`.

---

## 5. `POST /api/v1/stockbridge/recebimento/nacional/recebimento-externo`

Declara que itens de uma NF já entraram no estoque **fora do Atlas** — tipicamente por recebimento feito direto no OMIE. Cria uma aprovação de gestor; **não** cria movimentação, **não** altera estoque e **não** chama o OMIE.

**Role**: `requireOperador`. **Aprovação**: `gestor`.
**Flag**: só responde com `STOCKBRIDGE_RECEBIMENTO_EXTERNO_ENABLED=true`; desligada, devolve `403 RECEBIMENTO_EXTERNO_DESABILITADO`.

**Body**:
```json
{
  "nf_chave_acesso": "35260868176072000128550010000667241693158505",
  "motivo": "Recebido direto no OMIE em 12/09 por indisponibilidade do Atlas",
  "itens": [ { "indice": 0, "descricao_fornecedor": "SUCATA  PSAI MOIDO MESCLADO GROSSO" } ]
}
```

`motivo` é obrigatório. `itens` vazio ou ausente significa **todos os itens pendentes** da NF.

A granularidade é o **item da NF** (pela descrição), não o produto: o item da fila ainda não tem produto associado — é justamente por isso que ele não foi recebido pelo caminho normal.

**201**: `{ "data": { "aprovacoesCriadas": 1, "status": "pendente_aprovacao" }, "error": null }`

Enquanto a aprovação está pendente, o item continua aparecendo na fila marcado como "baixa solicitada" — só sai quando o gestor aprova. Se o gestor rejeitar, volta a pendente normal.

**Erros**: `400 MOTIVO_OBRIGATORIO`; `400 INVALID_INPUT`; `403 RECEBIMENTO_EXTERNO_DESABILITADO`; `404 NF_NAO_ENCONTRADA`; `409 ITEM_JA_RECEBIDO` (item já tem movimentação — não cabe baixa externa); `500 RECEBIMENTO_EXTERNO_FAIL`.

**Reversão**: gestor reverte uma baixa já aprovada pela tela de aprovações, devolvendo o item à fila. Auditado pela trigger de `aprovacao`.

---

## Invariantes de contrato

1. Nenhuma rota desta feature chama a API do OMIE (Princípio II); a única ida ao OMIE do fluxo nacional continua sendo o ajuste de estoque na aprovação.
2. Valor de item e valor total nunca vêm do cliente — sempre da NF (SC-001).
3. A quantidade conferida vem do cliente por desenho: é o peso da balança, e divergir da NF é situação normal e registrada (FR-017, FR-020).
4. Unidade fora da tabela bloqueia o item; nunca é convertida por aproximação (FR-009).
5. Local espelhado é recusado no servidor (defesa em profundidade já existente em `resolverLocalidadesParaItens`).
6. Documentos fiscais distintos que compartilham o mesmo número são tratados como distintos (FR-013).
7. Toda mensagem de erro nomeia produto por descrição e local por nome (ACXEGDP-313).
8. Item em unidade não conversível bloqueia **apenas a si mesmo** — nunca a NF inteira.
9. Recebimento externo jamais cria movimentação, altera estoque ou chama o OMIE. Seu único efeito é retirar o item da fila, após aprovação.
10. A data de corte é configuração de ambiente, nunca parâmetro de requisição.
