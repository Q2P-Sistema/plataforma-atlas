# Contract — Recebimento Nacional com Pedido de Compra (API)

**Feature**: `017-recebimento-nacional-com-pc`

Mesmo prefixo das features 015 e 016: `/api/v1/stockbridge/recebimento/nacional`, com `requireAuth`, `csrfProtection`, `requireModule('stockbridge')`, envelope `{ data, error }` e NF identificada pela **chave de acesso**. Nenhuma rota nova: esta feature **estende** a fila, o detalhe, o POST por-nf e o GET do ledger fiscal.

Chaves:

- `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` (a da 016). Desligada: sem sugestão, sem vínculo e sem fiscal pelo Atlas. **Continuam ativos** o PC vinculado à vista nas NFs com fiscal já feito (FR-021) e o bloqueio de estoque já lançado pelo OMIE (FR-021a).
- `STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC` (default `true`): regra para NF sem PC (D6).
- `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED` (default `false`): NFs da ACXE na fila (História 5).

Mensagens ao operador identificam a NF, o fornecedor e o PC pelo **número** (ex.: "PC 304"). Nunca mostram `nCodPed`, `nIdReceb` ou códigos de 10 dígitos (ACXEGDP-313).

---

## 1. `GET /fila` (estendida)

Cada NF ganha:

```json
{ "empresa": "q2p", "pcSituacao": "vinculado_omie", "estoqueLancadoPeloOmie": false }
```

- `pcSituacao` segue a regra do data-model §8. Vale `nao_aplicavel` com fiscal já feito ou com a chave da 016 desligada.
- `estoqueLancadoPeloOmie` é calculado com a chave em qualquer posição (D7).
- Com a chave da ACXE desligada, só aparecem NFs da Q2P e `empresa` é sempre `"q2p"`.

## 2. `GET /fila/:chaveAcesso` (estendida)

O detalhe ganha `empresa`, `exigePc` e `estoqueLancadoPeloOmie`. Cada item agregado ganha `pc` (data-model §8):

```json
{ "indice": 0, "descricaoFornecedor": "SUCATA PLASTICO", "quantidadeNfKg": 18000, "sequenciasRecebimento": [1],
  "pc": {
    "vinculoOmie": { "pcNumero": "304", "nCodPed": 8516905979, "nCodItem": 8516907022, "produtoDescricao": "PS CRISTAL B",
                     "qtdPedidaKg": 18000, "saldoKg": 18000, "precoUnit": 11.30, "dtPrevisao": "2026-10-20",
                     "etapa": "15", "dentroTolerancia": true, "casaNumeroPedidoNf": true, "motivo": "Vínculo do OMIE" },
    "alertaVinculoOmie": null,
    "candidatos": [],
    "outrosDoFornecedor": [],
    "aguardandoAprovacao": [],
    "preSelecionado": { "nCodPed": 8516905979, "nCodItem": 8516907022 },
    "semPcMotivo": null,
    "vinculadoNoOmie": null } }
```

`nCodPed` e `nCodItem` vão ao front só como identificadores de seleção, nunca como texto. A tela mostra `pcNumero`.

**NF com fiscal já feito**: `pc.vinculadoNoOmie = { "pcNumero": "304" }` quando o recebimento concluído tem vínculo, e todas as listas ficam vazias.

**Estoque já lançado pelo OMIE**: `estoqueLancadoPeloOmie: true`. A tela mostra o aviso e não habilita o recebimento.

## 3. `POST /por-nf` (estendida)

Corpo: o da 015, com `itens[].pc` opcional (data-model §9), `.strict()` em todos os níveis.

**Ordem de execução** (estende a 016):

1. **Portão 1** (validação tudo-ou-nada, sem escrita), igual à 015, mais:
   - `estoqueLancadoPeloOmie` → `409 ESTOQUE_JA_LANCADO_PELO_OMIE`. NF "fiscal já feito" que o espelho de recebimentos não tem: uma `ConsultarRecebimento` por chave antes de decidir (D7);
   - fiscal pendente com a chave da 016 ligada:
     - item a gravar sem `pc`:
       - com `EXIGE_PC = true` → `422 NF_SEM_PC` (dispara o aviso a compras, deduplicado em 24 h);
       - com `EXIGE_PC = false` → segue sem vínculo nesse item (receita da 016);
     - `pc` fora dos candidatos e dos "outros do fornecedor" → `422 PC_NAO_ELEGIVEL`;
     - `pc` fora da tolerância, ou troca do vínculo do OMIE, sem `justificativa` → `422 PC_JUSTIFICATIVA_OBRIGATORIA`.
2. **Releitura** (só com fiscal pendente e algum `pc`), com trava consultiva por item de PC:
   - vínculo concluído pelo Atlas no mesmo item de PC há menos de 75 s → `409 PC_RECEM_USADO_AGUARDE` (`retryAfterSeconds`);
   - `ConsultarPedCompra` de cada PC: fora da etapa 15, sem o item, de outro fornecedor ou sem saldo → `409 PC_VINCULO_INVALIDO`, com a situação atual na mensagem.
3. **Fiscal** (016 estendida): ledger → `ConsultarRecebimento` → recusas da 016 + vínculo no recebimento diferente do que a tela mostrou (`409 VINCULO_OMIE_MUDOU`) → `ASSOCIAR-PEDIDO` nos itens com vínculo novo ou trocado → `EDITAR` nos itens sem os ajustes → `IGNORAR` **só** nos itens sem PC (modo "receber sem vínculo") → `Concluir`. Uma linha em `recebimento_fiscal_pc` por item, gravada **antes** da primeira escrita.
4. **Portão 2** (gravação física), igual à 015.

**201**, acrescido:

```json
{ "fiscal": { "status": "concluido", "concluidoEm": "2026-10-22T10:00:00.000Z",
              "mensagem": "Recebimento fiscal da NF 7813 (REPLAS COMERCIAL LTDA) concluído no OMIE, vinculado ao PC 304.",
              "vinculos": [ { "nSequencia": 1, "pcNumero": "304", "origem": "omie", "status": "concluido" } ],
              "semVinculo": [], "avisoCompras": false } }
```

**Erros novos** (nenhum grava movimentação, aprovação ou escrita no OMIE, salvo onde indicado):

| HTTP | code | Quando | userMessage (exemplo) |
|---|---|---|---|
| 409 | `ESTOQUE_JA_LANCADO_PELO_OMIE` | o fiscal foi concluído fora do Atlas com movimento de estoque | "O estoque da NF 7813 (REPLAS COMERCIAL LTDA) já entrou pelo OMIE no recebimento fiscal. Para não lançar em dobro, o recebimento físico foi bloqueado. Fale com o fiscal." |
| 422 | `NF_SEM_PC` | modo bloquear, item sem PC possível | "A NF 7813 tem item sem pedido de compra no OMIE (SUCATA PLASTICO). Compras foi avisado. A NF fica na fila até o PC ser lançado e aprovado." |
| 422 | `PC_NAO_ELEGIVEL` | PC enviado que não é do fornecedor, não está na etapa 15 ou não tem saldo, segundo a cópia local | "O PC 305 não pode ser vinculado à NF 7813: está aguardando aprovação." |
| 422 | `PC_JUSTIFICATIVA_OBRIGATORIA` | escolha fora da tolerância, ou troca do vínculo do OMIE, sem justificativa | "Informe por que o PC 302 foi escolhido para o item SUCATA PLASTICO (quantidade 4% acima do saldo)." |
| 409 | `PC_VINCULO_INVALIDO` | a releitura ao vivo do PC recusa | "O PC 304 já não tem saldo para a NF 7813 (saldo atual: 0 kg). Escolha outro PC." |
| 409 | `VINCULO_OMIE_MUDOU` | o vínculo no recebimento mudou desde a abertura da tela | "O vínculo da NF 7813 com pedido de compra mudou no OMIE. Recarregue a nota." |
| 409 | `PC_RECEM_USADO_AGUARDE` | o mesmo item de PC foi usado pelo Atlas há menos de 75 s | "O PC 304 acabou de ser usado em outro recebimento. Aguarde cerca de N segundos e tente de novo." |
| 502 | `RECEBIMENTO_FISCAL_FAIL` (da 016) | falha também no passo `associar` | igual à 016, citando o PC |

Invariantes:

1. Repetir o POST não associa, não conclui nem grava duas vezes.
2. Falha no fiscal (associar, editar, ignorar ou concluir) não grava nenhuma movimentação.
3. Item com vínculo do OMIE nunca recebe `IGNORAR`, salvo troca explícita pelo operador, em que é `ASSOCIAR-PEDIDO` ao novo PC.
4. O vínculo e o fiscal não são desfeitos pela rejeição do gestor.

## 4. `GET /fiscal` (estendida, gestor+)

Cada linha do ledger ganha `empresa` e `vinculos[]`: `{ nSequencia, pcNumero, origem, justificativa, status, confirmadoPor, confirmadoEm }`. Sem `erro_omie_*`, como na 016.

## 5. Avisos por e-mail

- **NF sem PC** (D6) para `STOCKBRIDGE_COMPRAS_EMAILS`, ou `STOCKBRIDGE_OPS_EMAIL` se vazio. Assunto: "NF <n> de <fornecedor> sem pedido de compra no OMIE". Corpo: itens (descrição, kg, preço unitário), PCs do fornecedor aguardando aprovação, se houver, e o modo (bloqueado ou recebido sem vínculo). Deduplicado por NF e motivo a cada 24 h (`stockbridge.nf_aviso_compras`).
- Layout e regras de `notificacao.service.ts` (`buildEmailLayout`, sem códigos OMIE), com prefixo `[UAT]` no UAT, como os demais.

## 6. Leitores da cópia de PCs (sem mudança de contrato)

Cockpit, pendências fiscais e trânsito passam a usar saldo (`nqtde − nqtderec`). O formato das respostas fica igual (D10).
