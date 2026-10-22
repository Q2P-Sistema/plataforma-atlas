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

**Cópia de PCs defasada** (D13): `copiaPcsDefasada: true`. A tela mostra "lista de pedidos de compra desatualizada" no lugar da sugestão, e o recebimento de NF com fiscal pendente fica desabilitado até a cópia voltar.

## 3. `POST /por-nf` (estendida)

Corpo: o da 015, com `itens[].pc` opcional (data-model §9), `.strict()` em todos os níveis.

**Ordem de execução** (estende a 016):

1. **Portão 1** (validação tudo-ou-nada, sem escrita), igual à 015, mais:
   - `estoqueLancadoPeloOmie` → `409 ESTOQUE_JA_LANCADO_PELO_OMIE`. NF "fiscal já feito" que o espelho de recebimentos não tem: uma `ConsultarRecebimento` por chave antes de decidir (D7);
   - fiscal pendente com a chave da 016 ligada:
     - cópia de PCs defasada (D13) → `503 COPIA_PCS_DEFASADA`, sem aviso a compras;
     - item a gravar **sem PC possível** (definição antes do FR-019 da spec):
       - com `EXIGE_PC = true` → `422 NF_SEM_PC` (dispara o aviso a compras, deduplicado em 24 h);
       - com `EXIGE_PC = false` → segue sem vínculo nesse item (receita da 016);
     - item **com** PC possível e sem `pc` → `422 PC_NAO_ESCOLHIDO`, sem aviso;
     - `pc` fora do vínculo do OMIE, dos candidatos e dos "outros do fornecedor" → `422 PC_NAO_ELEGIVEL`;
     - sem `justificativa` quando a matriz do data-model §4 exige (fora da tolerância, de qualquer origem, ou troca do vínculo do OMIE) → `422 PC_JUSTIFICATIVA_OBRIGATORIA`.
2. **Releitura e reserva** (só com fiscal pendente e algum `pc`), depois da trava da NF (ledger da 016):
   - `ConsultarPedCompra` de cada PC, fora de transação;
   - numa transação com trava consultiva por item de PC (ordem crescente):
     - vínculo concluído pelo Atlas no mesmo item de PC há menos de 75 s → `409 PC_RECEM_USADO_AGUARDE` (`retryAfterSeconds`);
     - fora da etapa 15, sem o item, de outro fornecedor ou sem saldo disponível → `409 PC_VINCULO_INVALIDO`, com a situação atual na mensagem. Saldo disponível = `nQtde − nQtdeRec` lido ao vivo, menos as reservas de outras NFs (linhas `confirmado`/`associado` há menos de 15 min). Vínculos concluídos não são descontados, porque o OMIE já os mostra;
     - grava as linhas `confirmado` de `recebimento_fiscal_pc`, que são a reserva.
3. **Fiscal** (016 estendida): `ConsultarRecebimento` → recusas da 016 → vínculo vivo diferente do visto (`n_cod_item_omie_visto`) **e** diferente do escolhido → `409 VINCULO_OMIE_MUDOU` (vínculo vivo igual ao escolhido nunca é conflito) → recebimento já concluído no portal (`ja_concluido`) com item não ignorado e sem "não movimentar estoque" → `409 ESTOQUE_JA_LANCADO_PELO_OMIE` (vale também na reconsulta depois de falha) → `ASSOCIAR-PEDIDO` nos itens com vínculo novo ou trocado → `EDITAR` nos itens sem os ajustes → `IGNORAR` **só** nos itens sem PC possível (modo "receber sem vínculo") → `Concluir`. As linhas de `recebimento_fiscal_pc` já existem desde o passo 2, gravadas **antes** da primeira escrita.
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
| 409 | `ESTOQUE_JA_LANCADO_PELO_OMIE` | o fiscal foi concluído fora do Atlas com movimento de estoque (pelo espelho, pela leitura ao vivo da NF fora do espelho, ou no ramo `ja_concluido` do fiscal) | "O estoque da NF 7813 (REPLAS COMERCIAL LTDA) já entrou pelo OMIE no recebimento fiscal. Para não lançar em dobro, o recebimento físico foi bloqueado. Fale com o fiscal." |
| 422 | `NF_SEM_PC` | modo bloquear, item sem PC possível | "A NF 7813 tem item sem pedido de compra no OMIE (SUCATA PLASTICO). Compras foi avisado. A NF fica na fila até o PC ser lançado e aprovado." |
| 422 | `PC_NAO_ESCOLHIDO` | item com PC possível e sem `pc` no corpo | "Escolha o pedido de compra do item SUCATA PLASTICO da NF 7813 (REPLAS COMERCIAL LTDA)." |
| 503 | `COPIA_PCS_DEFASADA` | cópia local de PCs mais velha que `STOCKBRIDGE_COPIA_PCS_MAX_MIN` (D13); nada é gravado nem avisado | "A lista de pedidos de compra está desatualizada. Nada foi registrado. Tente de novo em alguns minutos; se persistir, avise o suporte." |
| 422 | `PC_NAO_ELEGIVEL` | PC enviado que não é do fornecedor, não está na etapa 15 ou não tem saldo, segundo a cópia local | "O PC 305 não pode ser vinculado à NF 7813: está aguardando aprovação." |
| 422 | `PC_JUSTIFICATIVA_OBRIGATORIA` | PC fora da tolerância, de qualquer origem (inclusive vínculo do OMIE mantido), ou troca do vínculo do OMIE, sem justificativa (matriz do data-model §4) | "Informe por que o PC 302 foi escolhido para o item SUCATA PLASTICO (quantidade 4% acima do saldo)." |
| 409 | `PC_VINCULO_INVALIDO` | a releitura ao vivo do PC recusa | "O PC 304 já não tem saldo para a NF 7813 (saldo atual: 0 kg). Escolha outro PC." |
| 409 | `VINCULO_OMIE_MUDOU` | o vínculo vivo no recebimento é diferente do que a tela mostrou (`n_cod_item_omie_visto`) e diferente do PC escolhido | "O vínculo da NF 7813 com pedido de compra mudou no OMIE. Recarregue a nota." |
| 409 | `PC_RECEM_USADO_AGUARDE` | o mesmo item de PC foi usado pelo Atlas há menos de 75 s | "O PC 304 acabou de ser usado em outro recebimento. Aguarde cerca de N segundos e tente de novo." |
| 502 | `RECEBIMENTO_FISCAL_FAIL` (da 016) | falha também no passo `associar` | igual à 016, citando o PC |

Invariantes:

1. Repetir o POST não associa, não conclui nem grava duas vezes.
2. Falha no fiscal (associar, editar, ignorar ou concluir) não grava nenhuma movimentação.
3. Item com vínculo do OMIE nunca recebe `IGNORAR`. A troca explícita pelo operador é `ASSOCIAR-PEDIDO` ao novo PC; sem outro PC possível, a NF é recusada nos dois modos.
4. O vínculo e o fiscal não são desfeitos pela rejeição do gestor.

## 4. `GET /fiscal` (estendida, gestor+)

Cada linha do ledger ganha `empresa` e `vinculos[]`: `{ nSequencia, pcNumero, origem, justificativa, status, confirmadoPor, confirmadoEm }`. Sem `erro_omie_*`, como na 016.

## 5. Avisos por e-mail

- **NF sem PC** (D6) para `STOCKBRIDGE_COMPRAS_EMAILS`, ou `STOCKBRIDGE_OPS_EMAIL` se vazio. Assunto: "NF <n> de <fornecedor> sem pedido de compra no OMIE". Corpo: itens (descrição, kg, preço unitário), PCs do fornecedor aguardando aprovação, se houver, e o modo (bloqueado ou recebido sem vínculo). Deduplicado por NF e motivo a cada 24 h (`stockbridge.nf_aviso_compras`).
- Layout e regras de `notificacao.service.ts` (`buildEmailLayout`, sem códigos OMIE), com prefixo `[UAT]` no UAT, como os demais.

## 6. Leitores da cópia de PCs (sem mudança de contrato)

Cockpit e pendências fiscais passam a usar saldo (`nqtde − nqtderec`). O formato das respostas fica igual. A função de trânsito da 0037 não muda (D10).

## 7. Health e alerta da cópia de PCs (D13)

- `GET /api/v1/health` do módulo ganha `pedidosCompraCopiaIdadeMin`, `degraded` acima de `STOCKBRIDGE_COPIA_PCS_MAX_MIN` (default 120). Na Fase 2, também a cópia e o espelho de recebimentos da ACXE.
- O cron que já alerta o espelho de recebimentos (`alerta-espelho-recebimentos.service.ts`) alerta também a cópia de PCs, para `STOCKBRIDGE_OPS_EMAIL`, com o mesmo reaviso.
