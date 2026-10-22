# Contract — Recebimento Nacional com Pedido de Compra (API)

**Feature**: `017-recebimento-nacional-com-pc`

Mesmo prefixo das features 015 e 016: `/api/v1/stockbridge/recebimento/nacional`, com `requireAuth`, `csrfProtection`, `requireModule('stockbridge')`, envelope `{ data, error }` e NF identificada pela **chave de acesso**. Esta feature **estende** a fila, o detalhe, o POST por-nf e o GET do ledger fiscal, e acrescenta uma rota: o aviso a compras sem o formulário (§3b, achado A1 da revisão de UI de 21/10/2026).

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
    "vinculoOmieElegivel": true,
    "vinculosDivergentes": false,
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

**Preço comparado** (D3, revisto em 22/10/2026): cada `PcCandidato` traz `precoNfKgComparado`, o R$/kg da NF na base usada com aquele PC (comercial ou valor do item, a mais próxima).

**Itens que o Atlas não avalia** (`itensSemAvaliacaoPc`, revisão de 22/10/2026): itens pendentes com unidade não convertida para kg e sem PC vinculado no OMIE, que o fiscal da NF concluiria sem PC. Com `exigePc = true` a tela bloqueia o recebimento e orienta o fiscal (corrigir a unidade ou concluir o recebimento no OMIE, vinculando o pedido); com `exigePc = false` informa que o item será concluído sem vínculo. Lista vazia fora do fluxo de PC.

## 3. `POST /por-nf` (estendida)

Corpo: o da 015, com `itens[].pc` opcional (data-model §9), `.strict()` em todos os níveis.

**Ordem de execução** (estende a 016):

1. **Portão 1** (validação tudo-ou-nada, sem escrita), igual à 015, mais:
   - NF com dispensa ativa → `404 NF_DISPENSADA`, com a chave da 016 em **qualquer** posição (revisão de 22/10/2026: com a chave desligada — a contenção — as NFs dispensadas voltavam à fila); listar e desfazer dispensa também valem com a chave desligada; só criar exige a chave;
   - `estoqueLancadoPeloOmie` → `409 ESTOQUE_JA_LANCADO_PELO_OMIE`. NF "fiscal já feito" sem a conclusão confirmada localmente (fora do espelho de recebimentos, linha defasada com `c_recebido = 'N'` ou não casada, e sem o fiscal concluído pelo Atlas no ledger): uma `ConsultarRecebimento` por chave antes de decidir (D7);
   - fiscal pendente com a chave da 016 ligada:
     - a NF é recebida por inteiro (D27): item pendente com unidade convertida e sem baixa externa solicitada que não veio no corpo → `400 NF_INCOMPLETA` (o fiscal conclui a NF inteira e o item seria concluído sem avaliação de PC; a tela sempre manda todos);
     - fornecedor não cadastrado no OMIE (sem CNPJ no espelho ou `n_id_fornecedor` 0) → `422 RECEBIMENTO_FISCAL_SEM_FORNECEDOR`, **antes** das regras de PC e sem aviso a compras (o problema é o cadastro);
     - cópia de PCs defasada (D13) → `503 COPIA_PCS_DEFASADA`, sem aviso a compras;
     - item a gravar **sem PC possível** (definição antes do FR-019 da spec):
       - com `EXIGE_PC = true` → `422 NF_SEM_PC` (dispara o aviso a compras, deduplicado em 24 h);
       - com `EXIGE_PC = false` → segue sem vínculo nesse item (receita da 016);
     - item **com** PC possível e sem `pc` → `422 PC_NAO_ESCOLHIDO`, sem aviso;
     - item pendente que o Atlas não recebe (unidade) e sem PC no OMIE (`itensSemAvaliacaoPc`): com `EXIGE_PC = true` → `422 NF_SEM_PC` com a orientação ao fiscal, sem aviso a compras; com `EXIGE_PC = false` → segue sem vínculo (IGNORAR da 016) e entra no aviso `recebida_sem_vinculo`;
     - `pc` fora do vínculo do OMIE, dos candidatos e dos "outros do fornecedor" → `422 PC_NAO_ELEGIVEL`;
     - sem `justificativa` quando a matriz do data-model §4 exige (fora da tolerância, de qualquer origem, ou troca do vínculo do OMIE) → `422 PC_JUSTIFICATIVA_OBRIGATORIA`.
2. **Consulta do recebimento** (só com fiscal pendente), depois da trava da NF (ledger da 016): `ConsultarRecebimento` por chave. Já concluído (`cRecebido = 'S'`) → item não ignorado e sem "não movimentar estoque" dá `409 ESTOQUE_JA_LANCADO_PELO_OMIE`; senão `ja_concluido`, **sem** releitura nem reserva do PC (a NF pode já ter consumido o saldo); a escolha de cada sequência vai direto ao estado final em `recebimento_fiscal_pc` (`concluido` com a data/hora da conclusão no OMIE, ou `falha`) e as sobras vivas de tentativas anteriores da NF viram `falha` (research D4). Aberto → recusas da 016 → vínculo vivo diferente do visto (`n_cod_item_omie_visto`; no item com linhas ligadas a PCs diferentes, o vínculo de cada linha lido no portão 1) **e** diferente do escolhido → `409 VINCULO_OMIE_MUDOU` (vínculo vivo igual ao escolhido nunca é conflito). Ordem revista em 22/10/2026: antes a releitura do PC vinha primeiro.
3. **Releitura e reserva** (só com recebimento aberto e algum `pc`):
   - `ConsultarPedCompra` de cada PC, fora de transação;
   - numa transação com trava consultiva por item de PC (ordem crescente):
     - vínculo concluído pelo Atlas no mesmo item de PC há menos de 75 s → `409 PC_RECEM_USADO_AGUARDE` (`retryAfterSeconds`);
     - fora da etapa 15, sem o item, de outro fornecedor ou sem saldo disponível → `409 PC_VINCULO_INVALIDO`, com a situação atual na mensagem. Saldo disponível = `nQtde − nQtdeRec` lido ao vivo, menos as reservas de outras NFs (linhas `confirmado`/`associado` há menos de 15 min). Vínculos concluídos não são descontados, porque o OMIE já os mostra;
     - grava as linhas `confirmado` de `recebimento_fiscal_pc`, que são a reserva.
4. **Fiscal** (016 estendida): `ASSOCIAR-PEDIDO` nos itens com vínculo novo ou trocado → `EDITAR` nos itens sem os ajustes → `IGNORAR` **só** nos itens sem PC possível (modo "receber sem vínculo") → `Concluir`. As linhas de `recebimento_fiscal_pc` já existem desde o passo 3, gravadas **antes** da primeira escrita. Na reconsulta depois de falha com escrita, `cRecebido = 'S'` com item não ignorado e sem "não movimentar estoque" também dá `409 ESTOQUE_JA_LANCADO_PELO_OMIE`.
5. **Portão 2** (gravação física), igual à 015.

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
| 409 | `ESTOQUE_JA_LANCADO_PELO_OMIE` | o fiscal foi concluído fora do Atlas com movimento de estoque (pelo espelho, pela leitura ao vivo quando o espelho não confirma a conclusão, ou no ramo `ja_concluido` do fiscal) | "O estoque da NF 7813 (REPLAS COMERCIAL LTDA) já entrou pelo OMIE no recebimento fiscal. Para não lançar em dobro, o recebimento físico foi bloqueado. Fale com o fiscal." |
| 422 | `NF_SEM_PC` | modo bloquear, item sem PC possível; ou, nos dois modos, item com vínculo do OMIE que não serve (inclusive linhas ligadas a PCs diferentes) e sem outro PC (FR-011a); ou, modo bloquear, item pendente que o Atlas não recebe (unidade) e sem PC no OMIE | "A NF 7813 (REPLAS COMERCIAL LTDA) tem item sem pedido de compra no OMIE (SUCATA PLASTICO). A equipe de Compras foi avisada. A NF fica na fila até o PC ser lançado e aprovado." · item de unidade: "… tem item que o Atlas não recebe (unidade não convertida para kg) e sem pedido de compra vinculado no OMIE (TAMPA). Peça ao fiscal para corrigir a unidade ou concluir o recebimento desta NF no OMIE, vinculando o pedido." (sem aviso a compras) · item com PC em outro cadastro do mesmo fornecedor: "… tem item sem pedido de compra no cadastro do fornecedor da nota (MC PEAD ES), mas há o PC 306 lançado em outro cadastro do mesmo fornecedor (CNPJ 61.827.663/0001-79). A equipe de Compras foi avisada para ajustar o fornecedor do pedido; a NF fica na fila até o ajuste." |
| 400 | `NF_INCOMPLETA` | fiscal pelo Atlas e um item pendente da NF não veio no corpo (D27: a NF é recebida por inteiro) | "A NF 7813 é recebida por inteiro: informe também o item \"SUCATA PP\". Recarregue a nota e confira todos os itens." |
| 422 | `PC_NAO_ESCOLHIDO` | item com PC possível e sem `pc` no corpo | "Escolha o pedido de compra do item SUCATA PLASTICO da NF 7813 (REPLAS COMERCIAL LTDA)." |
| 503 | `COPIA_PCS_DEFASADA` | cópia local de PCs mais velha que `STOCKBRIDGE_COPIA_PCS_MAX_MIN` (D13); nada é gravado nem avisado | "A lista de pedidos de compra está desatualizada. Nada foi registrado. Tente de novo em alguns minutos; se persistir, avise o suporte." |
| 422 | `PC_NAO_ELEGIVEL` | PC enviado que não é do fornecedor, não está na etapa 15 ou não tem saldo, segundo a cópia local | "O PC 305 não pode ser vinculado à NF 7813: está aguardando aprovação." |
| 422 | `PC_JUSTIFICATIVA_OBRIGATORIA` | PC fora da tolerância, de qualquer origem (inclusive vínculo do OMIE mantido), ou troca do vínculo do OMIE, sem justificativa (matriz do data-model §4) | "Informe por que o PC 302 foi escolhido para o item SUCATA PLASTICO (quantidade 4% acima do saldo)." |
| 409 | `PC_VINCULO_INVALIDO` | a releitura ao vivo do PC recusa. O corpo leva `error.pc = { nCodPed, nCodItem }`, o item de PC recusado, só para a tela desmarcar a escolha (nunca exibido) | "O PC 304 não pode ser vinculado à NF 7813: não tem saldo disponível (saldo atual: 0 kg). Escolha outro PC." |
| 409 | `VINCULO_OMIE_MUDOU` | o vínculo vivo no recebimento é diferente do que a tela mostrou (`n_cod_item_omie_visto`) e diferente do PC escolhido | "O vínculo da NF 7813 com pedido de compra mudou no OMIE. Recarregue a nota." |
| 409 | `PC_RECEM_USADO_AGUARDE` | o mesmo item de PC foi usado pelo Atlas há menos de 75 s | "O PC 304 acabou de ser usado em outro recebimento. Aguarde cerca de N segundos e tente de novo." |
| 502 | `RECEBIMENTO_FISCAL_FAIL` (da 016) | falha também no passo `associar` (ou na leitura ao vivo do PC, passo `consultar_pc`) | igual à 016, citando o PC: "Não foi possível concluir o recebimento fiscal da NF 7813 (REPLAS COMERCIAL LTDA), com o vínculo ao PC 304, no OMIE. Nada foi registrado no estoque — tente novamente em 1 minuto. Se persistir, avise o fiscal." |
| 502 | `VERIFICACAO_ESTOQUE_OMIE_FAIL` | a leitura ao vivo do recebimento de uma NF "fiscal já feito" cuja conclusão o espelho de recebimentos não confirma (NF ausente, linha defasada com `c_recebido = 'N'` ou não casada com o item) e sem o fiscal concluído pelo Atlas no ledger falhou (D7) — sem saber se o estoque entrou, nada é gravado | "Não foi possível conferir no OMIE se o estoque da NF 7813 já entrou pelo recebimento fiscal. Nada foi registrado. Tente de novo em instantes; se persistir, avise o fiscal." |

Invariantes:

1. Repetir o POST não associa, não conclui nem grava duas vezes.
2. Falha no fiscal (associar, editar, ignorar ou concluir) não grava nenhuma movimentação.
3. Item com vínculo do OMIE nunca recebe `IGNORAR`. A troca explícita pelo operador é `ASSOCIAR-PEDIDO` ao novo PC; sem outro PC possível, a NF é recusada nos dois modos.
4. O vínculo e o fiscal não são desfeitos pela rejeição do gestor.

## 3b. `POST /aviso-compras` (nova)

Avisa a equipe de Compras que a NF está aguardando pedido de compra, sem exigir o formulário do recebimento (produto, estoque, peso). Antes o aviso só saía no `POST /por-nf`, que valida o formulário inteiro antes de chegar ao `NF_SEM_PC`. Corpo `{ "nf_chave_acesso": "…" }`, `.strict()`, operador+ com armazém vinculado.

Mesma regra do portão 1: chave da 016 ligada, fiscal pendente, fornecedor cadastrado no OMIE, cópia de PCs em dia, item a receber (pendente e com unidade convertida) sem PC possível, e modo bloquear (ou vínculo do OMIE que não serve, nos dois modos). Deduplicado por NF, motivo e destinatário em 24 h (`stockbridge.nf_aviso_compras`): `enviado` = ao menos um destinatário ainda não avisado recebeu agora (inclui o reenvio a quem falhou antes); `deduplicado` = todos os destinatários já foram avisados.

**200**: `{ "status": "enviado" | "deduplicado", "motivo": "sem_pc" | "pc_aguardando_aprovacao", "itens": ["SUCATA PLASTICO"], "mensagem": "A equipe de Compras foi avisada de que a NF 7813 está aguardando pedido de compra." }`

| HTTP | code | Quando |
|---|---|---|
| 422 | `AVISO_COMPRAS_NAO_APLICAVEL` | a nota não está aguardando pedido de compra (chave desligada, fiscal já feito, fornecedor não cadastrado no OMIE, todos os itens com PC possível, ou modo "receber sem vínculo" sem vínculo inválido) |
| 503 | `COPIA_PCS_DEFASADA` | cópia de PCs defasada (D13) |
| 502 | `AVISO_COMPRAS_FALHOU` | nenhum destinatário pendente recebeu (falha de envio — com limite de 20 s por chamada ao SendGrid —, espera da trava acima de 10 s ou erro de banco; `retryAfterSeconds` 0); nada é registrado e uma nova tentativa reenvia |

## 4. `GET /fiscal` (estendida, gestor+)

Cada linha do ledger ganha `empresa` e `vinculos[]`: `{ nSequencia, pcNumero, origem, justificativa, status, confirmadoPor, confirmadoEm }`. Sem `erro_omie_*`, como na 016.

## 5. Avisos por e-mail

- **NF sem PC** (D6) para `STOCKBRIDGE_COMPRAS_EMAILS`, ou `STOCKBRIDGE_OPS_EMAIL` se vazio. Assunto: "NF <n> de <fornecedor> sem pedido de compra no OMIE". Corpo: itens (descrição, kg, preço unitário), PCs do fornecedor aguardando aprovação, se houver, e o modo (bloqueado ou recebido sem vínculo). Deduplicado por NF, motivo e destinatário a cada 24 h (`stockbridge.nf_aviso_compras`); destinatário com falha de envio fica pendente. Com PC aprovado e com saldo lançado em outro cadastro do mesmo fornecedor (filial × matriz), o corpo cita o PC e os dois CNPJs e pede para ajustar o fornecedor do pedido em vez de lançar um novo.
- Layout e regras de `notificacao.service.ts` (`buildEmailLayout`, sem códigos OMIE), com prefixo `[UAT]` no UAT, como os demais.

## 6. Leitores da cópia de PCs (sem mudança de contrato)

Cockpit e pendências fiscais passam a usar saldo (`nqtde − nqtderec`). O formato das respostas fica igual. A função de trânsito da 0037 não muda (D10).

## 7. Health e alerta da cópia de PCs (D13)

- `GET /api/v1/stockbridge/health` (autenticado) ganha `pedidosCompraCopiaIdadeMin`, `degraded` acima de `STOCKBRIDGE_COPIA_PCS_MAX_MIN` (default 120). Na Fase 2, também a cópia e o espelho de recebimentos da ACXE.
- O cron que já alerta o espelho de recebimentos (`alerta-espelho-recebimentos.service.ts`) alerta também a cópia de PCs, para `STOCKBRIDGE_OPS_EMAIL`, com o mesmo reaviso.
