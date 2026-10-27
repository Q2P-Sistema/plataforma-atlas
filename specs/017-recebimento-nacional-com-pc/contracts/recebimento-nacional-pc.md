# Contract — Recebimento Nacional com Pedido de Compra (API)

**Feature**: `017-recebimento-nacional-com-pc`

Mesmo prefixo das features 015 e 016: `/api/v1/stockbridge/recebimento/nacional`, com `requireAuth`, `csrfProtection`, `requireModule('stockbridge')`, envelope `{ data, error }` e NF identificada pela **chave de acesso**. Esta feature **estende** a fila, o detalhe, o POST por-nf e o GET do ledger fiscal, e acrescenta uma rota: o aviso a compras sem o formulário (§3b, achado A1 da revisão de UI de 21/10/2026).

Chaves:

- `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` (a da 016). Desligada: sem sugestão, sem vínculo e sem fiscal pelo Atlas. **Continuam ativos** o PC vinculado à vista nas NFs com fiscal já feito (FR-021) e o bloqueio de estoque já lançado pelo OMIE (FR-021a).
- `STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC` (default `true`): regra para NF sem PC (D6).
- `STOCKBRIDGE_PC_UNIDADE_DIFERENTE` (default `bloquear`): PC em unidade diferente da NF (D15). `converter` validado em PROD em 25/10/2026 (T073).
- `STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO` (default `false`, D20): o peso conferido acima da NF vai como `itensAjustes.nQtdeRecebida` no `EDITAR`, com teto no saldo do PC; excedente acima de `STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT` (default 10%) da NF do item não vai (provável erro de digitação). O corpo e as respostas do POST não mudam. Rejeição do gestor depois disso avisa compras por e-mail.
- `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED` (default `false`): NFs da ACXE na fila (História 5, §8). Só vale com a chave da 016 e com `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE`; sem elas a ACXE fica de fora (log e health) e a fila da Q2P segue normal.
- `STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED` (default `true`, D21 da 017): o Atlas percebe o recebimento fiscal que ele concluiu e que foi revertido no portal do OMIE. Kill switch. Só vale com a chave da 016 ligada e com a migration 0060 aplicada; desligada (ou sem a 0060), fila, detalhe e POST se comportam como antes, com o ledger `concluido` como estado final.

Mensagens ao operador identificam a NF, o fornecedor e o PC pelo **número** (ex.: "PC 304"). Nunca mostram `nCodPed`, `nIdReceb` ou códigos de 10 dígitos (ACXEGDP-313).

---

## 1. `GET /fila` (estendida)

Cada NF ganha:

```json
{ "empresa": "q2p", "pcSituacao": "vinculado_omie", "estoqueLancadoPeloOmie": false, "fiscalRevertido": false }
```

- `pcSituacao` segue a regra do data-model §8. Vale `nao_aplicavel` com fiscal já feito ou com a chave da 016 desligada.
- `estoqueLancadoPeloOmie` é calculado com a chave em qualquer posição (D7).
- `fiscalRevertido` (D21 da 017): `true` quando o recebimento fiscal foi concluído (pelo Atlas ou no portal: ledger, nota de entrada ou recebimento `S` bastam como evidência) e o OMIE o mostra desfeito depois (revertido no portal). A NF volta como `fiscal: "pendente"`, servida pelo espelho de recebimentos (a fonte do espelho de NF e o ledger `concluido` deixam de valer para ela), com `fiscalConcluidoPeloAtlasEm: null`. Sempre `false` com a chave da 016 desligada, com `STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED=false` ou sem a migration 0060. NF revertida com a entrada física já lançada no Atlas para todos os itens não tem item pendente e não volta à fila: só o e-mail ao fiscal (§5). Numa NF parcial (entrada de um item rejeitada pelo gestor), o item sem entrada volta à fila como fiscal revertido, e o e-mail ao fiscal sai mesmo assim.
- A listagem também grava: para cada NF revertida da página cuja tentativa antiga ainda está `concluido` no ledger, marca a tentativa `revertido` (origem `espelho`, melhor esforço) antes do selo de PC, como a abertura do detalhe (§2).
- Com a chave da ACXE desligada, só aparecem NFs da Q2P e `empresa` é sempre `"q2p"`. Com ela ligada (§8), a fila une as duas empresas, aceita o filtro `?empresa=q2p|acxe` e o `meta` ganha `recebimentoNacionalAcxeHabilitado`.

## 2. `GET /fila/:chaveAcesso` (estendida)

O detalhe ganha `empresa`, `exigePc` e `estoqueLancadoPeloOmie`. Cada item agregado ganha `pc` (data-model §8):

```json
{ "indice": 0, "descricaoFornecedor": "SUCATA PLASTICO", "quantidadeNfKg": 18000, "sequenciasRecebimento": [1],
  "pc": {
    "vinculoOmie": { "pcNumero": "304", "nCodPed": <nCodPed>, "nCodItem": <nCodItem>, "produtoDescricao": "PS CRISTAL B",
                     "qtdPedidaKg": 18000, "saldoKg": 18000, "precoUnit": 11.30, "dtPrevisao": "2026-10-20",
                     "etapa": "15", "dentroTolerancia": true, "casaNumeroPedidoNf": true, "motivo": "Vínculo do OMIE",
                     "outroCadastro": false, "cnpjCadastro": "", "dadosEmCache": false, "unidade": "KG" },
    "vinculoOmieElegivel": true,
    "vinculosDivergentes": false,
    "alertaVinculoOmie": null,
    "candidatos": [],
    "outrosDoFornecedor": [],
    "aguardandoAprovacao": [],
    "unidadeIncompativel": [],
    "preSelecionado": { "nCodPed": <nCodPed>, "nCodItem": <nCodItem> },
    "semPcMotivo": null,
    "vinculadoNoOmie": null } }
```

`nCodPed` e `nCodItem` vão ao front só como identificadores de seleção, nunca como texto. A tela mostra `pcNumero`. (O exemplo usa `<nCodPed>` e `<nCodItem>` no lugar dos ids reais do OMIE.)

**Campos novos de `PcCandidato`** (data-model §8):

- `outroCadastro` e `cnpjCadastro` (D17): o PC está em outro cadastro do mesmo fornecedor, com a mesma raiz de CNPJ (matriz × filial). O motivo ganha o sufixo "em outro cadastro do fornecedor (CNPJ …)"; a tela formata o CNPJ.
- `dadosEmCache` (D16): os dados vêm do cache de PCs vistos, porque o PC saiu da lista de pendentes. Saldo e etapa são os da última vez em que foi visto. O vínculo do OMIE nesse caso traz `alertaVinculoOmie` ("saiu da lista de pedidos pendentes do OMIE; os dados mostrados são da última sincronização em que apareceu; a confirmação confere o saldo ao vivo").
- `unidade`: unidade do PC no OMIE, mostrada ao lado do saldo.

**`unidadeIncompativel`** (D15, modo `bloquear`): PCs do fornecedor, etapa 15 e com saldo, em unidade diferente da NF. A tela os mostra não selecionáveis, com o motivo nas duas unidades do PC ("PC em kg e nota em toneladas: o OMIE baixaria o pedido com 8,25 em vez de 8.250 kg"; "PC em toneladas e nota em kg: … com 8.250 em vez de 8,25 toneladas"). O vínculo do OMIE em unidade diferente fica com `vinculoOmieElegivel: false` e alerta (sem outro PC, o POST recusa a NF nos dois modos de `EXIGE_PC`, como o vínculo que não serve), e o item sem outro PC possível tem `semPcMotivo` próprio e `pcSituacao = sem_pc`. No modo `converter` a lista é sempre vazia.

**`pcsDaNf`** (D14): os PCs que atendem a nota, com a atribuição item da NF → item do PC. A tela deixa o operador escolher o PC uma vez e monta o `pc` de cada item do POST a partir da atribuição. Só entram os itens a receber (pendentes, com unidade convertida e sem baixa externa pedida); `{ "pcs": [], "preSelecionado": null }` fora do fluxo de PC ou com a cópia de PCs defasada. Exemplo ilustrativo (NF de 4 itens contra um PC de 3 itens, com as linhas 3 e 4 no mesmo item do PC):

```json
"pcsDaNf": {
  "pcs": [
    { "nCodPed": <nCodPed>, "pcNumero": "306", "outroCadastro": true, "cnpjCadastro": "61827663000179", "dadosEmCache": false,
      "cobreTodos": true, "dentroTolerancia": true, "vinculoOmie": false, "justificativaNecessaria": false,
      "itens": [
        { "indice": 0, "nCodItem": <nCodItem-1>, "produtoDescricao": "PEBD LD",     "origem": "sugestao", "dentroTolerancia": true, "justificativaNecessaria": false,
          "motivo": "Quantidade e preço compatíveis · em outro cadastro do fornecedor (CNPJ 61.827.663/0001-79)" },
        { "indice": 1, "nCodItem": <nCodItem-2>, "produtoDescricao": "PEAD ES",     "origem": "sugestao", "dentroTolerancia": true, "justificativaNecessaria": false, "motivo": "…" },
        { "indice": 2, "nCodItem": <nCodItem-3>, "produtoDescricao": "PELBD 07/21", "origem": "sugestao", "dentroTolerancia": true, "justificativaNecessaria": false, "motivo": "…" },
        { "indice": 3, "nCodItem": <nCodItem-3>, "produtoDescricao": "PELBD 07/21", "origem": "sugestao", "dentroTolerancia": true, "justificativaNecessaria": false, "motivo": "…" }
      ] }
  ],
  "preSelecionado": <nCodPed>
}
```

Ordem dos PCs: cobre todos os itens; vínculo do OMIE; atende mais itens; dentro da tolerância; número. `preSelecionado` só quando há uma resposta sem justificativa (o vínculo do OMIE que cobre todos, ou o único PC que cobre todos dentro da tolerância). A justificativa é uma só para a nota: `justificativaNecessaria` do PC é verdadeiro se qualquer atribuição exige.

**NF com fiscal já feito**: `pc.vinculadoNoOmie = { "pcNumero": "304" }` quando o recebimento concluído tem vínculo, e todas as listas ficam vazias.

**Fiscal revertido** (D21 da 017): o detalhe devolve `fiscal: "pendente"`, `fiscalRevertido: true` e `fiscalRevertidoEm` (ISO: a hora da alteração no OMIE que mostrou a reversão — a do espelho, quando posterior à conclusão, ou a que a marcação pelo espelho da reversão mais recente gravou no ledger; `null` quando só a leitura ao vivo do clique percebeu a reversão mais recente e o espelho ainda não trouxe a hora, mesmo com uma reversão anterior marcada pelo espelho: a hora do clique não é a da reversão). `pc` e `pcsDaNf` são calculados como em qualquer NF com fiscal pendente: o vínculo que o OMIE manteve na reversão vem como vínculo do OMIE, pré-selecionado, e o operador o confirma. `estoqueLancadoPeloOmie` ignora as linhas do espelho de uma NF revertida. A tela mostra: "O recebimento fiscal desta nota foi desfeito no OMIE em dd/mm às hh:mm depois de concluído. Ao dar entrada, o Atlas conclui o fiscal de novo, com o pedido de compra confirmado abaixo. Se a reversão foi feita para corrigir a nota no OMIE, fale com o fiscal antes de dar entrada." (hora de Brasília; sem a hora quando `fiscalRevertidoEm` é nulo; sem a frase "Ao dar entrada…" quando o recebimento está barrado por outro aviso, nem quando há item com PC a confirmar em "Ignorar" — aviso do item visível ou último erro `ITEM_IGNORADO_NO_OMIE`: esse aviso não desabilita o botão, mas a tela deixa de prometer o fiscal concluído com o PC). O detalhe também responde `fiscalRevertido: true` para a NF revertida sem item a receber (entrada física já lançada); nesse caso a tela mostra a primeira e a terceira frases do aviso (a segunda, "Ao dar entrada…", só aparece com item a receber e o recebimento não barrado), porque o fiscal precisa refazer o recebimento no portal.

**Estoque já lançado pelo OMIE**: `estoqueLancadoPeloOmie: true`. A tela mostra o aviso e não habilita o recebimento.

**Cópia de PCs defasada** (D13): `copiaPcsDefasada: true`. A tela mostra "lista de pedidos de compra desatualizada" no lugar da sugestão, e o recebimento de NF com fiscal pendente fica desabilitado até a cópia voltar.

**Preço comparado** (D3, revisto em 22/10/2026): cada `PcCandidato` traz `precoNfKgComparado`, o R$/kg da NF na base usada com aquele PC (comercial ou valor do item, a mais próxima).

**Itens que o Atlas não avalia** (`itensSemAvaliacaoPc`, revisão de 22/10/2026): itens pendentes com unidade não convertida para kg e sem PC vinculado no OMIE, que o fiscal da NF concluiria sem PC. Com `exigePc = true` a tela bloqueia o recebimento e orienta o fiscal (corrigir a unidade ou concluir o recebimento no OMIE, vinculando o pedido); com `exigePc = false` informa que o item será concluído sem vínculo. Lista vazia fora do fluxo de PC.

**Itens marcados como "Ignorar" no OMIE** (`itensIgnoradosNoOmie`, a partir da NF 19252, de 26/10/2026): itens pendentes com alguma linha marcada como "Ignorar" no espelho de recebimentos (`c_ignorar_item = 'S'`), mesmo formato de `itensSemAvaliacaoPc`. A tela mostra um aviso âmbar nos que têm PC a confirmar — com PC escolhido o POST é recusado com `409 ITEM_IGNORADO_NO_OMIE` —, sem desabilitar o botão: o espelho atualiza a cada 30 min, e quem decide é a consulta ao vivo do clique. Lista vazia fora do fluxo de PC e com o fiscal já feito. Com outro aviso barrando o botão, o aviso não promete "pode dar entrada" (diz que sai na próxima atualização do espelho, até cerca de 30 min). Enquanto o aviso do item (ou o último erro `ITEM_IGNORADO_NO_OMIE`) está na tela, somem as frases que prometem o fiscal concluído com o PC: "Ao dar entrada…" do aviso de fiscal revertido, o aviso do fiscal pendente ("O recebimento fiscal desta nota será concluído…") e o complemento do rodapé do botão. O botão aponta para o aviso por `aria-describedby`.

## 3. `POST /por-nf` (estendida)

Corpo: o da 015, com `itens[].pc` opcional (data-model §9), `.strict()` em todos os níveis.

**Ordem de execução** (estende a 016):

1. **Portão 1** (validação tudo-ou-nada, sem escrita), igual à 015, mais:
   - NF com dispensa ativa → `404 NF_DISPENSADA`, com a chave da 016 em **qualquer** posição (revisão de 22/10/2026: com a chave desligada — a contenção — as NFs dispensadas voltavam à fila); listar e desfazer dispensa também valem com a chave desligada; só criar exige a chave;
   - `estoqueLancadoPeloOmie` → `409 ESTOQUE_JA_LANCADO_PELO_OMIE`. NF "fiscal já feito" sem a conclusão confirmada localmente (fora do espelho de recebimentos, linha defasada com `c_recebido = 'N'` ou não casada, e sem o fiscal concluído pelo Atlas no ledger): uma `ConsultarRecebimento` por chave antes de decidir (D7). Com o fiscal concluído pelo Atlas no ledger, a leitura ao vivo tem outro objetivo (próximo item);
   - **fiscal revertido** (D21 da 017; com a chave da 016, `STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED` e a 0060): NF `fiscal: "concluido"` cujo ledger tem o fiscal concluído pelo Atlas (`concluido`/`ja_concluido`) há pelo menos 75 s: uma `ConsultarRecebimento` por `nIdReceb`, no OMIE da empresa da NF, antes de pular o fiscal (sem retry quando só confere a reversão; com os retries de sempre quando a D7 também exige a leitura). `cRecebido = 'S'` → segue, e a mesma resposta serve à trava de estoque já lançado (D7). `cRecebido ≠ 'S'` e não cancelada → o ledger vira `revertido` (origem `omie_ao_vivo`, com o usuário do clique), nada é gravado em `movimentacao`/`aprovacao` nem escrito no OMIE, e a resposta é `409 RECEBIMENTO_FISCAL_REVERTIDO`; a tela recarrega e a NF volta como fiscal pendente. Leitura que falha: se a D7 já exigia a leitura, `502 VERIFICACAO_ESTOQUE_OMIE_FAIL`; senão o POST segue, com aviso no log, e a varredura do cron cobre depois. Sem ledger vigente e com o sinal ligado (outra requisição — o 2º clique de um duplo clique, outro operador, a abertura do detalhe, a listagem da fila ou a varredura — marcou a tentativa entre o retrato do detalhe lido pelo POST e esta conferência): o mesmo `409 RECEBIMENTO_FISCAL_REVERTIDO`, sem `ConsultarRecebimento` e sem gravar nada. NF com o fiscal concluído no portal (sem ledger) não ganha essa leitura: o espelho a cobre;
   - fiscal pendente com a chave da 016 ligada:
     - a NF é recebida por inteiro (D27): item pendente com unidade convertida e sem baixa externa solicitada que não veio no corpo → `400 NF_INCOMPLETA` (o fiscal conclui a NF inteira e o item seria concluído sem avaliação de PC; a tela sempre manda todos);
     - fornecedor não cadastrado no OMIE (sem CNPJ no espelho ou `n_id_fornecedor` 0) → `422 RECEBIMENTO_FISCAL_SEM_FORNECEDOR`, **antes** das regras de PC e sem aviso a compras (o problema é o cadastro);
     - cópia de PCs defasada (D13) → `503 COPIA_PCS_DEFASADA`, sem aviso a compras;
     - item a gravar **sem PC possível** (definição antes do FR-019 da spec):
       - com `EXIGE_PC = true` → `422 NF_SEM_PC` (dispara o aviso a compras, deduplicado em 24 h). No modo `bloquear`, o item cujo único PC está em unidade diferente da NF conta como sem PC possível (motivo interno `unidade_pc`), com texto próprio e o quadro de unidade no aviso (§5);
       - com `EXIGE_PC = false` → segue sem vínculo nesse item (receita da 016);
     - item **com** PC possível e sem `pc` → `422 PC_NAO_ESCOLHIDO`, sem aviso;
     - item pendente que o Atlas não recebe (unidade) e sem PC no OMIE (`itensSemAvaliacaoPc`): com `EXIGE_PC = true` → `422 NF_SEM_PC` com a orientação ao fiscal, sem aviso a compras; com `EXIGE_PC = false` → segue sem vínculo (IGNORAR da 016) e entra no aviso `recebida_sem_vinculo`;
     - `pc` fora do vínculo do OMIE, dos candidatos e dos "outros do fornecedor" → `422 PC_NAO_ELEGIVEL` (inclui o PC em unidade diferente da NF no modo `bloquear`, com a mensagem de unidade);
     - sem `justificativa` quando a matriz do data-model §4 exige (fora da tolerância, de qualquer origem, ou troca do vínculo do OMIE) → `422 PC_JUSTIFICATIVA_OBRIGATORIA`.
2. **Consulta do recebimento** (só com fiscal pendente), depois da trava da NF (ledger da 016; a trava marca `revertido` a linha viva `concluido`/`ja_concluido` de uma NF com o sinal de reversão do espelho ligado, com os vínculos de PC dela, e abre a trava nova, D21 da 017): `ConsultarRecebimento` por chave. Já concluído (`cRecebido = 'S'`) → item não ignorado e sem "não movimentar estoque" dá `409 ESTOQUE_JA_LANCADO_PELO_OMIE`; senão `ja_concluido`, **sem** releitura nem reserva do PC (a NF pode já ter consumido o saldo); a escolha de cada sequência vai direto ao estado final em `recebimento_fiscal_pc` (`concluido` com a data/hora da conclusão no OMIE, ou `falha`) e as sobras vivas de tentativas anteriores da NF viram `falha` (research D4). Aberto → recusas da 016 → item com PC escolhido marcado como "Ignorar" → `409 ITEM_IGNORADO_NO_OMIE` (NF 19252, 27/10/2026) → vínculo vivo diferente do visto (`n_cod_item_omie_visto`; no item com linhas ligadas a PCs diferentes, o vínculo de cada linha lido no portão 1) **e** diferente do escolhido → `409 VINCULO_OMIE_MUDOU` (vínculo vivo igual ao escolhido nunca é conflito). Ordem revista em 22/10/2026: antes a releitura do PC vinha primeiro.
3. **Releitura e reserva** (só com recebimento aberto e algum `pc`):
   - `ConsultarPedCompra` de cada PC, fora de transação;
   - numa transação com trava consultiva por item de PC (ordem crescente):
     - vínculo concluído pelo Atlas no mesmo item de PC há menos de 75 s → `409 PC_RECEM_USADO_AGUARDE` (`retryAfterSeconds`);
     - fora da etapa 15, sem o item, de outro fornecedor (cadastro sem a mesma raiz de CNPJ, D17), em unidade diferente da NF no modo `bloquear` (D15) ou sem saldo disponível → `409 PC_VINCULO_INVALIDO`, com a situação atual na mensagem. Saldo disponível = `nQtde − nQtdeRec` lido ao vivo, menos as reservas de outras NFs (linhas `confirmado`/`associado` há menos de 15 min). Vínculos concluídos não são descontados, porque o OMIE já os mostra;
     - grava as linhas `confirmado` de `recebimento_fiscal_pc`, que são a reserva. No modo `converter`, com a unidade do PC diferente da NF, a reserva também devolve a quantidade recebida de cada linha na unidade do PC (kg ÷ fator da unidade do PC), usada no `EDITAR`.
4. **Fiscal** (016 estendida): `ASSOCIAR-PEDIDO` nos itens com vínculo novo ou trocado → `EDITAR` nos itens sem os ajustes (no modo `converter`, com a unidade do PC diferente da NF, o `EDITAR` leva `itensAjustes.nQtdeRecebida` na unidade do PC, e os ajustes só contam como aplicados com esse valor) → `IGNORAR` **só** nos itens sem PC possível (modo "receber sem vínculo") → `Concluir`. As linhas de `recebimento_fiscal_pc` já existem desde o passo 3, gravadas **antes** da primeira escrita. Na reconsulta depois de falha com escrita, `cRecebido = 'S'` com item não ignorado e sem "não movimentar estoque" também dá `409 ESTOQUE_JA_LANCADO_PELO_OMIE`. Fiscal refeito de NF revertida (D21 da 017): o OMIE manteve o vínculo, o "não movimentar estoque" e as quantidades em kg, então o vínculo mantido igual ao escolhido vira só o que falta no `EDITAR` e o `Concluir`. A `ConsultarRecebimento` repetida com o mesmo corpo em menos de ~1 min devolve cache: a leitura ao vivo do clique usa `{ nIdReceb }` e o fiscal, `{ cChaveNfe }`.
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
| 422 | `NF_SEM_PC` | modo bloquear, item sem PC possível; ou, nos dois modos, item com vínculo do OMIE que não serve (inclusive linhas ligadas a PCs diferentes) e sem outro PC (FR-011a); ou, modo bloquear, item pendente que o Atlas não recebe (unidade) e sem PC no OMIE | "A NF 7813 (REPLAS COMERCIAL LTDA) tem item sem pedido de compra no OMIE (SUCATA PLASTICO). A equipe de Compras foi avisada. A NF fica na fila até o PC ser lançado e aprovado." · item de unidade: "… tem item que o Atlas não recebe (unidade não convertida para kg) e sem pedido de compra vinculado no OMIE (TAMPA). Peça ao fiscal para corrigir a unidade ou concluir o recebimento desta NF no OMIE, vinculando o pedido." (sem aviso a compras) · só há PC em unidade diferente da NF (modo `bloquear`): "A NF 60199 (ZARAPLAST) tem item cujo pedido de compra está em unidade diferente da nota (MC PEAD ES): o OMIE baixaria o pedido na unidade da nota, sem converter. A equipe de Compras foi avisada para lançar o pedido na unidade da nota; a NF fica na fila até o ajuste." |
| 400 | `NF_INCOMPLETA` | fiscal pelo Atlas e um item pendente da NF não veio no corpo (D27: a NF é recebida por inteiro) | "A NF 7813 é recebida por inteiro: informe também o item \"SUCATA PP\". Recarregue a nota e confira todos os itens." |
| 422 | `PC_NAO_ESCOLHIDO` | item com PC possível e sem `pc` no corpo | "Escolha o pedido de compra do item SUCATA PLASTICO da NF 7813 (REPLAS COMERCIAL LTDA)." |
| 503 | `COPIA_PCS_DEFASADA` | cópia local de PCs mais velha que `STOCKBRIDGE_COPIA_PCS_MAX_MIN` (D13); nada é gravado nem avisado | "A lista de pedidos de compra está desatualizada. Nada foi registrado. Tente de novo em alguns minutos; se persistir, avise o suporte." |
| 422 | `PC_NAO_ELEGIVEL` | PC enviado que não é do fornecedor, não está na etapa 15, não tem saldo ou está em unidade diferente da NF (modo `bloquear`), segundo a cópia local | "O PC 305 não pode ser vinculado à NF 7813: está aguardando aprovação." · unidade: "O PC 306 não pode ser vinculado ao item MC PEAD ES da NF 60199: está em kg e a nota em toneladas (o OMIE baixaria o pedido na unidade da nota)." |
| 422 | `PC_JUSTIFICATIVA_OBRIGATORIA` | PC fora da tolerância, de qualquer origem (inclusive vínculo do OMIE mantido), ou troca do vínculo do OMIE, sem justificativa (matriz do data-model §4) | "Informe por que o PC 302 foi escolhido para o item SUCATA PLASTICO (quantidade 4% acima do saldo)." |
| 409 | `PC_VINCULO_INVALIDO` | a releitura ao vivo do PC recusa. O corpo leva `error.pc = { nCodPed, nCodItem }`, o item de PC recusado, só para a tela desmarcar a escolha (nunca exibido) | "O PC 304 não pode ser vinculado à NF 7813: não tem saldo disponível (saldo atual: 0 kg). Escolha outro PC." · unidade (PC lido ao vivo, inclusive o vínculo que o OMIE já fez): "O PC 306 não pode ser vinculado à NF 60199: está em kg e a nota em toneladas — o OMIE baixaria o pedido na unidade da nota, sem converter. Escolha outro PC." |
| 409 | `VINCULO_OMIE_MUDOU` | o vínculo vivo no recebimento é diferente do que a tela mostrou (`n_cod_item_omie_visto`) e diferente do PC escolhido | "O vínculo da NF 7813 com pedido de compra mudou no OMIE. Recarregue a nota." |
| 409 | `ITEM_IGNORADO_NO_OMIE` | item com PC escolhido marcado como "Ignorar" no recebimento do OMIE (NF 19252, 26/10/2026). Checado na consulta, antes do `VINCULO_OMIE_MUDOU`: o IGNORAR desfaz o vínculo e o Atlas não desfaz a marcação. Ledger em `falha` no passo `consultar`, nada escrito no OMIE, sem `retryAfterSeconds`; a tela recarrega a nota e mostra na caixa âmbar a mensagem do servidor, que nomeia os itens lidos ao vivo (o aviso do espelho sai enquanto ela está na tela; se a nota recarregada deixa de ser fiscal pendente, a caixa sai sozinha). Item ignorado sem PC escolhido não é recusado | "O item "LDPE 923.270 DB + AX" da NF 19252 (ZARAPLAST S/A) está marcado como "Ignorar" no recebimento do OMIE, e com essa marcação o pedido de compra não pode ser vinculado. Nada foi registrado. Peça ao fiscal para desmarcar "Ignorar" nesse item no OMIE e tente de novo." |
| 409 | `PC_RECEM_USADO_AGUARDE` | o mesmo item de PC foi usado pelo Atlas há menos de 75 s | "O PC 304 acabou de ser usado em outro recebimento. Aguarde cerca de N segundos e tente de novo." |
| 502 | `RECEBIMENTO_FISCAL_FAIL` (da 016) | falha também no passo `associar` (ou na leitura ao vivo do PC, passo `consultar_pc`) | igual à 016, citando o PC: "Não foi possível concluir o recebimento fiscal da NF 7813 (REPLAS COMERCIAL LTDA), com o vínculo ao PC 304, no OMIE. Nada foi registrado no estoque — tente novamente em 1 minuto. Se persistir, avise o fiscal." |
| 502 | `VERIFICACAO_ESTOQUE_OMIE_FAIL` | a leitura ao vivo do recebimento de uma NF "fiscal já feito" cuja conclusão o espelho de recebimentos não confirma (NF ausente, linha defasada com `c_recebido = 'N'` ou não casada com o item) e sem o fiscal concluído pelo Atlas no ledger falhou (D7) — sem saber se o estoque entrou, nada é gravado | "Não foi possível conferir no OMIE se o estoque da NF 7813 já entrou pelo recebimento fiscal. Nada foi registrado. Tente de novo em instantes; se persistir, avise o fiscal." |
| 409 | `RECEBIMENTO_FISCAL_REVERTIDO` | NF "fiscal já feito" cujo fiscal o Atlas concluiu e que a leitura ao vivo do clique mostra não recebido no OMIE (D21 da 017). No caminho da leitura ao vivo, **grava só o ledger** (`revertido`, origem `omie_ao_vivo`) e os vínculos de PC dele; nenhuma movimentação, aprovação ou escrita no OMIE. 2º gatilho: sem ledger vigente (outro clique, a abertura do detalhe, a listagem da fila ou a varredura marcou a tentativa entre o retrato do detalhe lido pelo POST e a conferência) e com o sinal ligado, o mesmo 409 sai sem `ConsultarRecebimento` e sem gravar nada. Sem `retryAfterSeconds`: a tela recarrega a nota, que volta como fiscal pendente | "O recebimento fiscal da NF 19252 (ZARAPLAST) foi desfeito no OMIE depois de concluído. A nota voltou para fiscal pendente: confira o pedido de compra e dê entrada de novo, e o Atlas conclui o fiscal junto." (o "fale com o fiscal" fica no aviso da nota recarregada) |

Invariantes:

1. Repetir o POST não associa, não conclui nem grava duas vezes.
2. Falha no fiscal (associar, editar, ignorar ou concluir) não grava nenhuma movimentação.
3. Item com vínculo do OMIE nunca recebe `IGNORAR`. A troca explícita pelo operador é `ASSOCIAR-PEDIDO` ao novo PC; sem outro PC possível, a NF é recusada nos dois modos.
4. O vínculo e o fiscal não são desfeitos pela rejeição do gestor.
5. Fiscal concluído pelo Atlas e revertido no portal não é tratado como concluído (D21 da 017). O Atlas nunca reverte no OMIE: só detecta e refaz a conclusão, no clique do operador. NF com a entrada física ativa para todos os itens não volta à fila, e o fiscal é avisado por e-mail; numa NF parcial (entrada de um item rejeitada), o item sem entrada volta à fila como fiscal revertido, e o e-mail sai mesmo assim. O invariante 4 continua valendo: a rejeição do gestor não marca `revertido`; só a reversão no OMIE marca.

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

D21 da 017: o filtro `status` aceita também `revertido` (a 016 lista `concluido|ja_concluido|falha|em_andamento`), e cada linha ganha `revertidoEm`, `revertidoOrigem` (`espelho` | `omie_ao_vivo`) e `revertidoOmieEm` (ISO; só quando o espelho traz a hora da alteração). Os vínculos de uma tentativa revertida saem com `status: "revertido"`.

## 5. Avisos por e-mail

- **NF sem PC** (D6) para `STOCKBRIDGE_COMPRAS_EMAILS`, ou `STOCKBRIDGE_OPS_EMAIL` se vazio. Assunto: "NF <n> de <fornecedor> sem pedido de compra no OMIE". Corpo: itens (descrição, kg, preço unitário), PCs do fornecedor aguardando aprovação, se houver, e o modo (bloqueado ou recebido sem vínculo). Deduplicado por NF, motivo e destinatário a cada 24 h (`stockbridge.nf_aviso_compras`); destinatário com falha de envio fica pendente. Com PC do fornecedor em unidade diferente da NF (trava de unidade, D15), o corpo ganha o quadro "Pedido em unidade diferente da nota": a nota está em toneladas e o pedido em outra unidade, o OMIE grava no pedido a quantidade na unidade da nota sem converter (8,25 em vez de 8.250), e compras deve lançar ou ajustar o pedido na mesma unidade da nota; o "O que fazer" manda seguir essa orientação, e o motivo é gravado como `sem_pc`. Não há mais o quadro "PC em outro cadastro": o PC de outro cadastro com a mesma raiz de CNPJ é oferecido na tela (D17).
- **Fiscal desfeito no OMIE com a entrada física lançada** (D21 da 017) para `STOCKBRIDGE_FISCAL_EMAILS` (a lista da dispensa, da 016; não para compras), um e-mail por destinatário. Assunto: "Recebimento fiscal desfeito no OMIE — NF <n> (<fornecedor>)" ("… no OMIE da ACXE" para NF da ACXE). Corpo: quando o Atlas concluiu o fiscal e desde quando ele aparece desfeito — com o ledger `ja_concluido` (o fiscal concluiu no portal e o Atlas só viu), que o recebimento fiscal "estava concluído no OMIE quando o Atlas o conferiu, em <data>", com o rótulo "Visto concluído pelo Atlas em" na tabela em vez de "Concluído pelo Atlas em"; que a entrada de estoque já foi lançada pelo Atlas (aguardando aprovação do gestor, ou aprovada em <data>), que os itens lançados não voltam à fila e que o recebimento fiscal precisa ser refeito no OMIE; e o que fazer: concluir o recebimento de novo no portal, conferindo em cada item a opção "Não gerar movimento de estoque" (o estoque desta nota entra pela aprovação no Atlas; sem ela entraria em dobro) e o vínculo com o PC <número>. Uma vez por NF (`aviso_fiscal_em` do ledger); sem nenhum destinatário (defensivo: a variável vazia cai na lista padrão do fiscal) = aviso no log e nada marcado; falha de envio = nova tentativa na rodada seguinte do cron; sem aviso para NF com dispensa ativa.
- Layout e regras de `notificacao.service.ts` (`buildEmailLayout`, sem códigos OMIE), com prefixo `[UAT]` no UAT, como os demais.

## 6. Leitores da cópia de PCs e cache de PCs vistos

Cockpit e pendências fiscais passam a usar saldo (`nqtde − nqtderec`). O formato das respostas fica igual. A função de trânsito da 0037 não muda (D10).

**Fonte dos PCs no detalhe e no portão 1** (D16): a cópia `tbl_pedidosCompras_<empresa>` e, para os itens que ela não traz (PC que saiu da lista de pendentes por ter item associado a um recebimento aberto), o cache `stockbridge.pedido_compra_visto` (data-model §11). O item vem com `dadosEmCache: true`. O número do PC das NFs com fiscal já feito (`vinculadoNoOmie.pcNumero`) vem da cópia, do ledger e do cache, nessa ordem. O cache só informa a tela: a confirmação confere o PC ao vivo (§3, passo 3).

## 7. Health e alerta da cópia de PCs (D13)

- `GET /api/v1/stockbridge/health` (autenticado) ganha `pedidosCompraCopiaIdadeMin`, `degraded` acima de `STOCKBRIDGE_COPIA_PCS_MAX_MIN` (default 120). Na Fase 2, também a cópia e o espelho de recebimentos da ACXE.
- O cron que já alerta o espelho de recebimentos (`alerta-espelho-recebimentos.service.ts`) alerta também a cópia de PCs, para `STOCKBRIDGE_OPS_EMAIL`, com o mesmo reaviso.
- O mesmo cron (`5,35 * * * *`) atualiza o cache de PCs vistos da Q2P (`registrarPcsVistos`), sem alertar: falha vira aviso no log e a sugestão segue só com a cópia.
- O mesmo cron roda a varredura do fiscal revertido (D21 da 017, `fiscal-revertido-varredura.service.ts`): marca como `revertido` os ledgers concluídos nos últimos 14 dias com o sinal ligado e avisa o fiscal (§5). Só Postgres, sem chamar o OMIE; falha vira log e não quebra o cron. Depende do frescor do espelho de recebimentos (o alerta que já existe vigia isso).

## 8. Compra nacional da ACXE (História 5, research D18)

Valem as rotas acima, com a empresa vinda **da NF** (espelho), nunca do corpo.

**Fiscal revertido** (D21 da 017) vale por empresa: o sinal lê `tbl_recebimentoNFe_ACXE` e `tbl_nf_header_ACXE`, o ledger tem `empresa` e a leitura ao vivo do clique usa o OMIE da empresa da NF. A varredura do cron cuida da ACXE só com `recebimentoNacionalAcxeHabilitado()`. Depende do espelho de recebimentos da ACXE e do histórico `c_recebido = 'S'` (`contracts/espelhos-n8n.md` §2).

**`GET /fila`**: `data[].empresa` (`q2p` | `acxe`); query `empresa` opcional; `meta.recebimentoNacionalAcxeHabilitado`. Qualquer falha da consulta com a ACXE (espelho ausente, corte inválido, outro erro) refaz a consulta só com a Q2P: a ACXE nunca derruba a fila nem o detalhe da Q2P. O corte da ACXE precisa ser data de calendário válida; inválido vale como ausente. NF da ACXE entra com as três condições (chave da ACXE, chave da 016, corte da ACXE) e fica de fora se for da Q2P (intercompany: `fornecedor_exclusao` com `empresa = 'acxe'`). A exclusão de fornecedor vale por empresa nas duas consultas.

**`GET /fila/:chave`**: `empresa`; para NF da ACXE, `itens[].produtosSugeridos[]` do catálogo da ACXE (produto que o OMIE associou ao item e produto do item do PC), com `semCorrelatoQ2p`; candidatos de PC (`PcCandidato`) e `pcsDaNf.pcs[].itens[]` com `localidadeId` e `localDescricao` ("20.0.7 · PRODUÇÃO"), resolvidos no servidor a partir do local do item do PC (nulos na NF da Q2P, em local virtual ou desconhecido).

**`GET /localidades?empresa=acxe&destino=nf`** (nova variação): destinos da entrada por NF da ACXE, `[{ id, codigo, nome, tipo, entradaEm }]`, sem código do OMIE. `entradaEm = ['acxe','q2p']` para 11.1, 12.1, 21.1 e 31.1 (vêm primeiro) e `['acxe']` para 20.0.5, 20.0.7 e 21.2; sem locais virtuais nem só da Q2P. Com `empresa=q2p&destino=nf`, a lista de hoje (11.2, 12.2) com `entradaEm = ['q2p']`. Sem `destino`, a lista do formulário manual, inalterada.

**`GET /produtos?empresa=acxe`**: só produtos ativos **em KG** (o catálogo da ACXE tem 259 de 475 ativos em outras unidades); cada um ganha `semCorrelatoQ2p` (não há produto **ativo e em KG** da Q2P com a mesma descrição). As sugestões do detalhe seguem a mesma regra.

**`POST /por-nf`**: cada `itens[].produtos[]` leva exatamente um de `produto_codigo_q2p` | `produto_codigo_acxe`, o da empresa da NF. Respostas novas, todas no portão 1 (antes do fiscal, nada gravado):

| Status | `code` | Quando |
|---|---|---|
| 400 | `PRODUTO_EMPRESA_INCOMPATIVEL` | o campo de produto não é o da empresa da NF |
| 400 | `LOCALIDADE_NAO_ELEGIVEL` | (já existia) o estoque não está entre os destinos da empresa da NF |
| 404 | `PRODUTO_NAO_ENCONTRADO` | (já existia) produto fora do catálogo da ACXE ou inativo |
| 422 | `PRODUTO_SEM_CORRELATO_Q2P` | estoque que entra nas duas empresas com produto sem produto ativo de mesma descrição na Q2P |
| 422 | `PRODUTO_CORRELATO_Q2P_REPETIDO` | dois produtos da mesma linha da NF com o mesmo correspondente na Q2P, os dois em estoque que entra nas duas |
| 422 | `PRODUTO_UNIDADE_NAO_KG` | produto da ACXE controlado em outra unidade (metro, unidade, caixa…): o recebimento lança em kg |

O fiscal e a trava de estoque já lançado usam o OMIE da ACXE. Cada produto do resultado ganha `produtoCodigoAcxe` (NF da ACXE), `produtoCodigoQ2p` (na ACXE, o correspondente quando entra nas duas, senão `null`) e `entradaEm` (ausente nos produtos barrados antes da validação do estoque). Sem memória fornecedor × descrição e sem baixa de PC na Q2P.

**`PUT /correlacao`**: NF da ACXE → `422 CORRELACAO_SO_Q2P` (a memória guarda produtos da Q2P).

**Aprovação** (`GET /api/v1/stockbridge/aprovacoes`, `POST …/:id/aprovar`): cada pendência ganha `entradaEm` (`[]` fora da entrada nacional). Aprovar uma entrada da ACXE lança `ENT/INI` na ACXE (`nacional-acxe`) e, quando entra nas duas, na Q2P em seguida (`nacional-q2p`), com o mesmo valor unitário e a mesma data. Respostas: `200` (com `pendenciaOmie: { lado: 'q2p', opId, movimentacaoId, mensagem }` quando só a Q2P falhou: aprovação registrada, movimentação `pendente_q2p`); `502 OMIE_ACXE_FAIL` (a ACXE falhou: nada gravado, a aprovação continua pendente); `422 ENTRADA_NACIONAL_INCONSISTENTE` (sem custo da NF gravado, ou o estoque deixou de ser das duas empresas desde o POST).

**Retentativa** (`GET /api/v1/stockbridge/movimentacoes`, `POST /api/v1/stockbridge/operacoes-pendentes/:id/retentar`): cada movimentação ganha `retentavelQ2p` — só a entrada nacional da ACXE nas duas empresas em `pendente_q2p` sem aprovação pendente (importação e saída manual continuam sem o botão). Os erros da rota trazem `userMessage`. A retentativa da entrada nas duas empresas refaz só a perna da Q2P, com o mesmo valor e a data da perna da ACXE: `200`; `502 OMIE_Q2P_FAIL`; `409 RETENTATIVA_INVALIDA` quando uma guarda recusa antes do OMIE (entrada só de uma empresa, aprovação não concluída, perna da ACXE não feita, perna da Q2P já feita, dado persistido faltando).

