# Research — Recebimento Nacional com Pedido de Compra

**Feature**: `017-recebimento-nacional-com-pc` | **Data**: 2026-10-21 (revisto em 22/10/2026) | **Jira**: ACXEGDP-437

Evidências: leitura ao vivo no OMIE da Q2P (sonda `m8moZ1C9xWvwyjmj` e teste `CA0PlrtFkzcdQlpM`, 21/10/2026), teste do vínculo novo com a NF 60199 da Zaraplast (T033, n8n `4OnbxvfALn9OoXLH`, e primeira NF recebida pelo Atlas, 22/10/2026), espelhos `public.*` em PROD (pg-acxe), documentação da API OMIE (`produtos/recebimentonfe/`, `produtos/pedidocompra/`, `estoque/consulta/`) e o código das features 015, 016 e da ACXEGDP-344.

---

## D1. Item que já chega vinculado ao PC: `EDITAR` (não movimentar estoque) e depois `ConcluirRecebimento`. Nunca `IGNORAR`

**Decisão**: quando o recebimento traz o item associado a um item de PC (`itensCabec.cAssociarExistente = 'S'` e `nIdPedido > 0`) e o operador confirma esse mesmo PC, a receita é:

1. `AlterarRecebimento` com `itensRecebimentoEditar: [{ itensIde: { nSequencia, cAcao: 'EDITAR' }, itensAjustes: { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' } }]`, só nos itens que ainda não têm esses ajustes.
2. `ConcluirRecebimento { nIdReceb, cEtapa: '60' }`.

**Evidência**: teste controlado na NF 7813 da Replas, autorizado pelo usuário em 21/10/2026, das 18h10 às 18h16.

| Momento | Recebimento | PC 304 | Estoque PS CRISTAL B no local 8123584710 |
|---|---|---|---|
| Antes | etapa 40, item associado ao PC 304 (`nIdPedido 8516905979`, `nIdItPedido 8516907022`, `nNumPedCompra "304"`), `cNaoGerarMovEstoque = N` | etapa 15, `nQtdeRec` 0 | 13.500 kg |
| Depois do `EDITAR` | vínculo mantido, `cNaoGerarMovEstoque = S` | sem mudança | 13.500 kg |
| Depois do `Concluir` | etapa 60, `cRecebido = S`, vínculo mantido, conta a pagar gerada (título 8517008510) | **`nQtdeRec` 18.000**, etapa 15 | **13.500 kg** (`ListarMovimentoEstoque` sem movimento da NF) |

Efeito colateral esperado: a descrição do item no recebimento passou a ser a do produto do PC ("PS CRISTAL B" no lugar de "SUCATA PLASTICO"). Esse é o caso da ACXEGDP-412, já tratado pelo reconhecimento do item pela sequência.

**Por que não `IGNORAR`**: o `IGNORAR` da receita da 016 desfaz a associação. A NF 7736, concluída pelo Atlas com `IGNORAR` em 21/10, hoje está sem `nNumPedCompra` e com `cIgnorarItem = S`. A hipótese de que ela tinha vínculo com o PC 302 não foi comprovada, mas é o motivo de a regra existir.

**Alternativas**: concluir sem o `EDITAR` foi rejeitado, porque o recebimento chega com `cNaoGerarMovEstoque = N` e o OMIE lançaria o estoque.

## D2. Item sem vínculo: `ASSOCIAR-PEDIDO`, depois `EDITAR`, depois `ConcluirRecebimento`. Testado com NF real em 22/10/2026 (T033): aprovado

**Decisão**: para o item sem vínculo, ou com vínculo trocado pelo operador, o Atlas grava o vínculo antes de marcar os ajustes:

1. `AlterarRecebimento` com `itensIde: { nSequencia, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente, nIdItPedidoExistente }`.
2. `EDITAR` com os ajustes de D1.
3. `ConcluirRecebimento` na etapa 60.

**Rationale**: reproduz o estado que funcionou na NF 7813 (associação existente e depois `EDITAR`). As duas ações vão em chamadas separadas porque `itensAjustes` só é aceito com `cAcao = 'EDITAR'` (erro `SOAP-ENV:Client-151`, visto na 016).

**Resultado do teste T033** (22/10/2026, OMIE da Q2P em PROD, autorizado pelo usuário). Workflow n8n `4OnbxvfALn9OoXLH` ("Teste OMIE - ASSOCIAR-PEDIDO (NF 60199 Zaraplast x PC 306, Q2P) T033", pasta Em Desenvolvimento; hoje só tem passos de leitura). A NF 60199 da Zaraplast vem do cadastro da filial (CNPJ 61.827.663/0013-02), com 4 itens em toneladas (`TL`), na etapa 40 e sem vínculo. O PC 306 foi lançado por compras no cadastro da matriz (61.827.663/0001-79), com 3 itens em kg: PEBD LD (8.250), PEAD ES (13.750) e PELBD 07/21 (5.500). As quantidades da NF batiam exatamente com as do PC.

| Ponto | Resultado |
|---|---|
| (a) `ASSOCIAR-PEDIDO` na etapa 40 | **Aceito**, inclusive com PC de **outro cadastro** do mesmo fornecedor (mesma raiz de CNPJ: filial na NF, matriz no PC). Base de D17 |
| (b) `EDITAR` (`cNaoGerarMovEstoque = S`, `cNaoGerarFinanceiro = N`) depois da associação | **Preserva o vínculo.** Chamadas com vários itens numa só (3 `ASSOCIAR-PEDIDO`, depois 3 `EDITAR`, no formato do Atlas) foram aceitas, e duas linhas da NF (itens 3 e 4, 2,75 t cada) no mesmo item do PC também. Depois da associação, a descrição do item passa a ser a do produto do PC e o `nIdItem` do recebimento passa a ser o do item do PC |
| Durante o teste | PC sem baixa, estoque inalterado, nenhuma conta a pagar |
| (c) troca de um vínculo existente | **Não testada.** Vale o plano B abaixo |
| (d) NF menor que o saldo do PC | **Não testada** (as quantidades eram exatas). O fiscal falha fechado: se o OMIE recusar, o Atlas responde 502 e não grava nada no estoque |

**Primeira NF recebida pelo Atlas com a chave religada** (22/10/2026, 15h02, pelo usuário): a NF 60199 terminou com o fiscal `concluido` e os 4 vínculos mantidos (só `EDITAR` + `Concluir`, porque a associação do teste ainda valia), e 3 entradas físicas por ajuste de estoque, aprovadas. Foi nela que apareceram o problema da unidade na baixa do PC (D15) e a janela em que o PC some da lista de pendentes (D16).

**Plano B da troca de vínculo (c)**: se o OMIE recusar o `ASSOCIAR-PEDIDO` sobre um item que já tem vínculo, a troca deixa de ser oferecida na tela. O item mantém o vínculo do OMIE ou, se ele não servir, a NF é recusada com a orientação de pedir a troca ao fiscal no portal. Em nenhum caso o item é ignorado (FR-011a).

**Alternativas**: `EDITAR` antes de `ASSOCIAR-PEDIDO` era o plano B de ordem e foi descartado: o teste mostrou que a ordem `ASSOCIAR-PEDIDO` → `EDITAR` preserva a associação e os ajustes.

## D3. A sugestão vem de fontes locais (espelho, cópia de PCs e cache), sem chamar o OMIE ao abrir a tela

**Decisão**: a sugestão de cada item é montada só a partir de dados que já estão no Postgres:

1. **Vínculo do OMIE**, lido do espelho de recebimentos, que ganha colunas novas (D9): `n_id_pedido`, `n_id_it_pedido`, `n_num_ped_compra`, `c_num_it_ped_compra`, além dos já existentes `c_associar_existente`, `c_ignorar_item` e `c_nao_gerar_mov_estoque`. Quando presente, é a sugestão principal.
2. **Candidatos**, lidos de `public."tbl_pedidosCompras_<empresa>"`, a cópia local atualizada pela Rev 1.5 do n8n `qPJFEIY1PQ2LDQG2`: a cada aviso de PC, com agenda de 10 min, troca atômica e PCs recebidos parcialmente incluídos.
3. **PCs que a cópia não traz**, lidos do cache `stockbridge.pedido_compra_visto` (D16): o OMIE tira da lista de pendentes o PC com item associado a um recebimento aberto, e o cache guarda a última versão que o Atlas viu.

**Regra de candidato** (FR-002):

- mesmo fornecedor: o mesmo cadastro (`pc.ncodfor` = `nIdFornecedor` do recebimento) **ou outro cadastro com a mesma raiz de CNPJ**, que passou a ser oferecido depois do T033 (22/10/2026, D17: a NF 60199 vem do cadastro da filial e o PC 306 foi lançado no da matriz). A sugestão só existe com fiscal pendente, que vem do espelho de recebimentos; a fonte "fiscal já feito" não precisa do código. Um vínculo que o próprio OMIE fez com PC de outro fornecedor passa na releitura: o OMIE já o aceitou (D4);
- `cetapa = '15'`;
- mesma unidade da NF (D15), com `STOCKBRIDGE_PC_UNIDADE_DIFERENTE = 'bloquear'` (default): PC em unidade diferente da NF (kg × tonelada) vai para `unidadeIncompativel`, visível e não selecionável;
- quantidade do item, em kg, até 2% acima do saldo do PC: `qtdKg ≤ saldoKg × 1,02`. Na cópia local, o saldo é `nqtde − nqtderec`, menos os vínculos `concluido` do Atlas no mesmo item de PC depois de `data_atualizacao` da cópia (ela ainda não os viu) e menos as reservas em andamento de outras NFs (D4). A quantidade em kg usa a conversão de unidade da 015;
- preço da NF por kg até 1% diferente do preço do PC por kg, com o preço do PC como base: `|preçoNfKg − preçoPcKg| ≤ preçoPcKg × 0,01`. O preço da NF vai em **duas bases**, e vale a mais próxima do preço do PC (revisto em 22/10/2026): o **comercial**, sem tributos (`n_preco_unit` no espelho de recebimentos, `v_un_com` em `tbl_nf_itens_<empresa>`), e o **valor do item** por kg, com tributos (`v_total_item` / `v_prod`). A premissa anterior (só o comercial) caiu com o dado de PROD: o PC 306 da Zaraplast foi lançado com o preço com IPI (R$ 10,80/kg = valor do item ÷ kg da NF 60199, enquanto o comercial fica 2,7% a 4,8% abaixo). Nos recebimentos desde julho de 2026, os itens dos fornecedores com IPI (Zaraplast, Valgroup, Cata, Apta e outros) ficam fora de 1% numa das bases; nos sem IPI (Replas, Isoforma) as duas coincidem. Subir a tolerância não resolveria, porque abriria a folga também para quem lança sem IPI. Para o item agregado por descrição, `preçoNfKg = Σ(preço comercial × qtd) ÷ Σ kg` e `preçoItemKg = Σ valor do item ÷ Σ kg`, chamando `converterItemNfParaKg(qtd, unidade, preço comercial × qtd)` por linha, porque a função recebe o valor **total**. O preço do PC por kg é `nvalunit` com `cunidade = 'KG'` (todos os PCs hoje) ou `nvalunit ÷ 1000` com `'T'`/`'TON'`; outra unidade deixa o PC fora, com o motivo. Item com unidade não conversível fica sem sugestão (já é bloqueado na 015 e vai ao formulário manual);
- **nunca** PC de fornecedor ACXE com valor total abaixo de R$ 200 (PCs-espelho da importação). A ACXE é reconhecida pela CNPJ do fornecedor no cadastro, comparada sem máscara com `CNPJ_ACXE_NUMERICO` (`types.ts`); `CNPJ_ACXE` é um rótulo, não a CNPJ. A regra é defensiva: como o candidato precisa ser do fornecedor da NF e a ACXE já fica fora da fila da Q2P por `fornecedor_exclusao`, o caso só aparece num vínculo do OMIE que aponte para PC-espelho.

**Vínculo do OMIE = `n_id_pedido > 0`.** O `n_num_ped_compra` (`itensInfoAdic.nNumPedCompra`) é o pedido que o **fornecedor** informou no XML (xPed): vem também em NF sem PC ("0", ou o número do pedido do próprio fornecedor, ex.: "200001909863465" — sonda da sessão do n8n, 21/10/2026). Ele só ordena candidatos e nunca é mostrado como o PC vinculado.

**Ordenação**: (1) o número do pedido informado na NF (`n_num_ped_compra`) igual a `pc.cnumero`; (2) menor diferença de preço; (3) previsão de entrega mais antiga; (4) `ncodped`. Empates aparecem todos, e nada é pré-selecionado. Só o vínculo do OMIE, ou um único candidato que case pelo número do pedido, vem pré-selecionado. O operador confirma sempre (FR-007).

**Outros PCs do fornecedor** (FR-002a/b): os PCs da etapa 15 com saldo, mas fora da tolerância, aparecem numa lista à parte para escolha manual com justificativa. Os da etapa 10 aparecem como "PC aguardando aprovação" e não podem ser escolhidos.

**Evidência de volume**: em 21/10/2026, a Q2P tinha 3 PCs nacionais (302, 303 e 304) e a ACXE nenhum. A cópia local inteira tem cerca de 250 linhas, então a consulta por fornecedor é trivial.

**Alternativas**: `PesquisarPedCompra` ao vivo por fornecedor ao abrir o detalhe foi rejeitado pelo Princípio II e pelo custo de API. A cópia frequente da Rev 1.5 resolve a defasagem.

## D4. Na confirmação, o Atlas relê ao vivo o recebimento e cada PC

**Decisão**: no POST, depois da validação dos dados e antes de qualquer escrita, o Atlas:

1. lê o recebimento com `ConsultarRecebimento`, que já existe na 016;
2. lê cada PC escolhido com `ConsultarPedCompra`, cliente da ACXEGDP-344;
3. recusa o vínculo (`409 PC_VINCULO_INVALIDO`) se o PC não estiver na etapa 15, não tiver o item, for de outro fornecedor ou não tiver saldo disponível, se a quantidade passar da tolerância sem justificativa ou, no modo `bloquear`, se estiver em unidade diferente da NF (D15). "Outro fornecedor" é outro cadastro **sem** a mesma raiz de CNPJ (D17);
4. recusa com `409 VINCULO_OMIE_MUDOU` se o vínculo vivo no recebimento for diferente do que a tela mostrou (o corpo do POST leva `n_cod_item_omie_visto`) e diferente do PC escolhido. Vínculo vivo igual ao escolhido nunca é conflito, o que evita recusas em série enquanto o n8n ainda não preenche as colunas de pedido. Item com linhas ligadas a PCs diferentes no OMIE (`vinculosDivergentes`): a tela não tem um "visto" único, então a base de cada linha é o vínculo que o servidor leu no portão 1; qualquer escolha troca todas as linhas pelo PC escolhido (FR-002c, FR-007), registrando o PC anterior de cada linha (revisão de 22/10/2026 — antes toda escolha dava 409 e a NF ficava sem saída).

**Saldo disponível na releitura**: é o que o OMIE devolve (`nQtde − nQtdeRec`), **sem** descontar vínculos concluídos pelo Atlas, porque o OMIE atualiza `nQtdeRec` ao concluir (teste da NF 7813). Desconta só as **reservas em andamento** de outras NFs no mesmo item de PC: linhas de `recebimento_fiscal_pc` em `confirmado` ou `associado`, de outra NF, iniciadas há menos de 15 min.

**Cache e concorrência**: `ConsultarPedCompra` com corpo idêntico em menos de cerca de 1 min devolve resposta antiga (ACXEGDP-406). A ordem no POST é:

1. a trava da NF (ledger da 016);
2. `ConsultarRecebimento` por chave. Recebimento já concluído (`cRecebido = 'S'`: portal, ou um `Concluir` anterior cuja resposta se perdeu) vai direto para D7 ou `ja_concluido`, **sem** reler nem reservar o PC, porque a própria NF pode já ter consumido o saldo dele e a releitura recusaria com "sem saldo" (revisão de 22/10/2026; antes a releitura vinha primeiro). Depois, as recusas da 016 e o `409 VINCULO_OMIE_MUDOU`;
3. `ConsultarPedCompra` de cada PC escolhido, fora de transação;
4. numa transação com `pg_advisory_xact_lock` por item de PC (`n_cod_item_ped`), em ordem crescente para não travar em ciclo:
   - se houver vínculo `concluido` pelo Atlas no mesmo item de PC há menos de 75 s, `409 PC_RECEM_USADO_AGUARDE` com `retryAfterSeconds` (a leitura do passo 3 pode ter vindo do cache);
   - checa o saldo disponível;
   - grava as linhas `confirmado`, que são a **reserva**;
5. só então as escritas no OMIE.

No `ja_concluido` da primeira consulta o Atlas não relê nem reserva o PC, mas registra a escolha de cada sequência já no estado final em `recebimento_fiscal_pc`: `concluido` quando o vínculo vivo no OMIE é o escolhido, com `concluido_em` = data/hora da conclusão no OMIE (`dRec` + `hRec`, horário de Brasília, limitado a agora; nulo se o OMIE não informar), nunca o instante atual — que seria descontado outra vez do saldo de uma cópia que já viu a conclusão —; ou `falha` ("Fiscal concluído fora do Atlas sem este vínculo"). Antes do registro, as linhas `confirmado`/`associado` que sobraram de uma tentativa anterior morta da NF (de qualquer ledger) viram `falha`; sem escolha de PC, o fechamento dessas sobras acontece antes das escritas. A reconsulta depois de falha com escrita fecha as reservas desta tentativa por UPDATE (`concluido` com o instante atual: o `Concluir` foi desta tentativa).

**Isenção de fornecedor só com o vínculo vivo** (revisão de 22/10/2026): a escolha de origem `omie` escapa da checagem "é de outro fornecedor" só quando o vínculo **vivo** na `ConsultarRecebimento` desta tentativa já é o PC escolhido em todas as linhas da escolha — o OMIE já o aceitou, ainda que o PC não seja do mesmo fornecedor. PC de outro cadastro com a mesma raiz de CNPJ passa em qualquer origem (D17). Vínculo que sumiu, ou que não cobre todas as linhas, seria criado pelo Atlas com `ASSOCIAR-PEDIDO`: aí vale o FR-009.

A trava solta no fim da transação, mas a reserva continua valendo para as outras NFs até a linha virar `concluido` ou `falha`. Isso fecha a janela de duas NFs simultâneas no mesmo item de PC sem segurar a trava durante as chamadas ao OMIE.

**Tentativa anterior sem desfecho** (processo que morreu com o lock): como o lock da NF garante que nenhuma outra tentativa dela está viva, a mesma transação marca como `falha` as linhas `confirmado`/`associado` antigas desta NF antes de gravar as novas. A reserva antiga é substituída sem janela, e a nova tentativa relê o recebimento: se o `ASSOCIAR-PEDIDO` anterior já tinha passado, o vínculo vivo igual ao escolhido segue como "mantido", sem nova chamada.

**Alternativas**: confiar só na cópia local foi rejeitado, porque ela pode estar minutos atrás e outra NF pode ter consumido o PC.

## D5. Registro dos vínculos: tabela nova `stockbridge.recebimento_fiscal_pc`, filha do ledger da 016

**Decisão**: uma linha por item da NF e por tentativa, ligada à linha do ledger `stockbridge.recebimento_fiscal` daquela tentativa. Guarda:

- origem: `omie`, `sugestao` ou `manual`;
- o PC e o item de PC escolhidos, e o PC original do OMIE quando o operador troca;
- se o PC estava dentro da tolerância (`dentro_tolerancia`) e a justificativa, obrigatória fora dela ou na troca do vínculo do OMIE;
- o retrato dos candidatos oferecidos (`jsonb`);
- quantidade e preço da NF, saldo e preço do PC relidos;
- o passo e o resultado.

Status: `confirmado → associado → concluido | falha`. Há índice único parcial por `(nf_chave_acesso, n_sequencia)` para os status vivos, e índice parcial `(n_cod_item_ped) WHERE status IN ('confirmado','associado')` para as reservas de D4. Tem trigger de auditoria (Princípio IV).

O ledger da 016 ganha:

- `empresa` (`q2p` | `acxe`, default `q2p`);
- o passo `associar` no `CHECK` de `passo_falha`.

**Rationale**:

- FR-023 pede rastrear sugeridos, confirmado, quem e quando;
- FR-015 pede idempotência por item;
- o `409 PC_RECEM_USADO_AGUARDE` de D4 precisa consultar vínculos recentes por item de PC.

**Alternativas**: um `jsonb` no ledger foi rejeitado por dificultar a consulta "vínculos recentes no item de PC X" e a auditoria por item.

## D6. NF sem PC: regra configurável, bloquear por padrão, e aviso a compras com deduplicação

**Decisão**: a variável `STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC` (default `true`) define o modo.

- **`true` (bloquear)**: se algum item a gravar não tem PC possível (definição antes do FR-019 da spec), o POST responde `422 NF_SEM_PC` sem escrever nada, e a NF continua na fila como "aguardando PC de compras".
- **`false` (receber sem vínculo)**: os itens sem PC possível seguem a receita da 016 (`EDITAR` + `IGNORAR`), e os itens com PC seguem D1 ou D2. As duas receitas cabem na mesma NF, porque `AlterarRecebimento` aceita uma ação por item.
- **Item com PC possível e sem escolha**, nos dois modos: `422 PC_NAO_ESCOLHIDO` ("escolha o pedido de compra do item …"). Ele nunca vira "sem PC" nem gera aviso a compras. Item com vínculo do OMIE nunca segue o `IGNORAR` (FR-011a).

Nos dois modos, compras recebe um aviso com a NF, o fornecedor e os itens sem PC. O aviso vai para `STOCKBRIDGE_COMPRAS_EMAILS`; se a variável estiver vazia, vai para `STOCKBRIDGE_OPS_EMAIL` e fica registrado no log. Ele é deduplicado em `stockbridge.nf_aviso_compras`: no máximo um por NF, motivo e destinatário a cada 24 h, numa transação com trava consultiva por NF e motivo (duas chamadas simultâneas não enviam duas vezes); o destinatário cujo envio falhou fica pendente para a próxima tentativa (revisão de 22/10/2026). Com a cópia de PCs defasada (D13), a regra não é aplicada: o POST responde `503 COPIA_PCS_DEFASADA` e nada é avisado.

**A regra só vale quando o fiscal é feito pelo Atlas.** Com o fiscal já feito no portal, ou com a chave da 016 desligada (contenção), não há o que bloquear: o fiscal já existe, e o Atlas faz só o físico.

**Alternativas**: bloquear sem chave foi rejeitado, porque o usuário pediu para poder desligar o bloqueio.

## D7. Estoque já lançado pelo OMIE: o Atlas detecta e bloqueia a entrada física

**Decisão**: uma NF com o fiscal concluído fora do Atlas é marcada como `estoqueLancadoPeloOmie` quando algum item está recebido, não ignorado e sem "não movimentar estoque". No espelho de recebimentos, isso é `c_recebido = 'S'`, `c_ignorar_item = 'N'` e `c_nao_gerar_mov_estoque = 'N'`.

Com essa marca, o detalhe mostra o motivo e o POST responde `409 ESTOQUE_JA_LANCADO_PELO_OMIE` sem escrever nada. Quando a conclusão não está confirmada localmente, o POST de uma NF "fiscal já feito" lê o recebimento ao vivo uma vez (`ConsultarRecebimento` por chave) antes de gravar. Não confirmada = o espelho de recebimentos não tem a NF, está atrás (`c_recebido = 'N'` numa NF que o espelho de NF já mostra concluída: janela de até ~15 min a cada conclusão no portal, e linhas que ficam travadas por dias em PROD) ou a linha não casou com o item, e o ledger do Atlas não tem o fiscal da NF concluído. Antes da revisão de 22/10/2026 só a NF ausente do espelho disparava a leitura, e a linha defasada deixava o estoque entrar em dobro. Essa leitura é uma exceção ao Princípio II e fica documentada no comentário do código e na seção 2 da 007.

**Também no ramo `ja_concluido` e na reconsulta depois de falha.** Se a NF ainda aparecia com fiscal pendente e o fiscal foi concluído no portal entre a abertura da tela e a confirmação, a `ConsultarRecebimento` do fiscal (016) volta com `cRecebido = 'S'`. Antes de seguir para o físico, o Atlas aplica a mesma checagem aos itens lidos ao vivo: item não ignorado com `cNaoGerarMovEstoque = 'N'` dá `409 ESTOQUE_JA_LANCADO_PELO_OMIE`. O mesmo vale para a reconsulta depois de falha.

**Vale com a chave da 016 desligada.** É justamente o cenário da contenção, com o fiscal concluindo no portal.

**Rationale**: o estoque lançado duas vezes, uma pelo OMIE e outra pelo Atlas, é o pior desfecho possível (SC-009). A informação já está no espelho, e a leitura ao vivo só acontece quando ela falta.

**Alternativas**: só orientar o fiscal foi rejeitado pelo usuário.

## D8. A chave liga/desliga é a da 016

**Decisão**: `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED`. Desligada, vale a contenção de 21/10/2026: a fila mostra só as NFs com fiscal feito no portal e o Atlas faz o físico, mas com D7 (detecção de estoque) e FR-021 (PC vinculado à vista) ativos. Ligada **com esta feature implantada**, o Atlas conclui o fiscal mantendo ou gravando o vínculo.

**Risco de ativação**: religar a chave com uma imagem anterior à 017 volta a receita do `IGNORAR`, que é o problema original. O quickstart e o runbook de deploy registram que a chave só volta a `true` depois da versão com a 017 em PROD e do teste de D2.

**Estado em 22/10/2026**: a chave foi religada em PROD às ~14h50 (horário de Brasília), depois do T033, com a imagem v1.1.20 e a 0056 aplicada. A trava de unidade (D15), o cache de PCs vistos (D16, migration 0057), o PC por NF (D14) e o PC de outro cadastro (D17) são desta rodada de 22/10/2026 e entram numa imagem posterior à v1.1.20.

## D9. Espelhos de recebimento: colunas de pedido e espelho novo da ACXE, com DDL na migration e mudança no n8n

**Decisão**:

- a migration `0056` (Fase 1) acrescenta `n_id_pedido bigint`, `n_id_it_pedido bigint`, `n_num_ped_compra varchar(15)` e `c_num_it_ped_compra integer` em `public."tbl_recebimentoNFe_itens_Q2P"` (`ADD COLUMN IF NOT EXISTS`);
- a migration `0058` (Fase 2, História 5; a 0057 ficou com o cache de PCs vistos, D16) cria `public."tbl_recebimentoNFe_ACXE"` e `"_itens_ACXE"` com a mesma DDL (`IF NOT EXISTS`), já com essas colunas.

O workflow n8n "Q2P - Exporta Recebimentos NF-e" passa a gravar os quatro campos, que vêm de `itensCabec.nIdPedido` e `nIdItPedido` e de `itensInfoAdic.nNumPedCompra` e `cNumItPedCompra`. Um workflow novo, "ACXE - Exporta Recebimentos NF-e", copia o da Q2P com as chaves da ACXE.

O contrato para a sessão dos workflows está em `contracts/espelhos-n8n.md`.

**Rationale**: é o mesmo padrão da 016 (D4). A DDL canônica fica no repositório do Atlas, porque a fila e os testes dependem dela.

## D10. Leitores da cópia de PCs passam a descontar o recebido (menos a função de trânsito)

**Decisão**: `cockpit.service.ts` e `pendencias-fiscais.service.ts` trocam `pc.nqtde` por `pc.nqtde - COALESCE(pc.nqtderec, 0)` como saldo, e `pc.nqtde > 0` por saldo `> 0`.

**A função `stockbridge.refresh_lotes_em_transito_se_stale` (migration 0037) fica como está** (decisão do usuário em 21/10/2026, achado C2 do `/speckit-analyze`). Ela também usa `pc.nqtde`, mas é PL/pgSQL que faz UPSERT e soft-delete em `stockbridge.lote`, uma tabela de domínio. O Princípio III reserva essa escrita ao TypeScript, e reeditá-la nesta feature reforçaria o desvio herdado da 0037. Como hoje não existe PC de importação recebido em parte em nenhuma das empresas, a função não erra na prática. A limitação fica registrada para um card próprio: levar o refresh do trânsito para TypeScript, já com o saldo.

**Rationale**: com a Rev 1.5, um PC recebido em parte passa a ficar na cópia local; sem a correção, ele seria contado pela quantidade cheia. Hoje não existe nenhum caso nas duas empresas, então a correção é preventiva. A baixa da ACXEGDP-344 não é afetada: ela só usa PCs com "Pedido original ACXE" casando com a NF filhote.

## D11. Compra nacional pela ACXE (User Story 5): mesma fila, empresa como dimensão, estoque pela regra da importação

**Decisão**:

- a fila e o detalhe ganham `empresa` (`q2p` | `acxe`) nas duas fontes, com os espelhos da ACXE (`tbl_nf_header_ACXE` e `tbl_nf_itens_ACXE`, que já existem, e o espelho de recebimentos novo de D9);
- `stockbridge.fornecedor_exclusao` ganha `empresa`. Na ACXE ficam excluídas as duas CNPJs da Q2P no cadastro da ACXE, `27.019.059/0001-88` (matriz) e `27.019.059/0002-69` (filial), gravadas com máscara como o caso inverso (`42.672.052/0001-54`). Não há constante de CNPJ da Q2P em `types.ts`: `CNPJ_Q2P_MATRIZ` é um rótulo. `fornecedor.service.ts`, que lista, exclui e reinclui por CNPJ, passa a considerar a empresa;
- o fiscal e o vínculo usam `callOmie('acxe', …)`, com a mesma receita de D1 e D2;
- **não há PC na Q2P.** O n8n `RDa9ilL3tbx5ETIk` só espelha PC de fornecedor estrangeiro (gate `gate_internacional_ativo`, ACXEGDP-376; o nacional cai em `Pedido_Nacional_Ignorado`). Logo, não há baixa de PC na Q2P (FR-029);
- **estoque** (*revisto em 22/10/2026 por D18: o operador escolhe entre os locais que também são da Q2P e os só da ACXE, com o local do PC marcado; o texto a seguir é a decisão original*): o operador escolhe o local entre os mesmos oferecidos na importação. Os locais espelhados vêm de `listarLocalidadesEspelhadas` (`localidade.service.ts`, a mesma lista do `ConferenciaModal` da importação), com a correspondência ACXE↔Q2P em `stockbridge.localidade_correlacao`. A entrada é sempre nas duas empresas: no local escolhido da ACXE e no local correlato da Q2P. **Não há entrada só na ACXE.** Não há trânsito: o lado da ACXE é `ENT`, e não `TRF`. Os sufixos de idempotência ficam `acxe-ent` e `q2p-ent`; falha só no lado da Q2P reaproveita `pendente_q2p` e o painel de retentativa;
- **valor**: o mesmo valor unitário nas duas empresas, o do item na NF por kg, **sem** o acréscimo de 14,5% que a importação aplica na entrada da Q2P (`ceil(vNF / kg × 1,145)` em `executarAjusteOmieDual`). Decisão do usuário em 21/10/2026;
- é entregue numa fase separada, atrás de `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED` (default `false`), com migration própria (`0058`).

**Extrema (decidido em 21/10/2026; o 21.2 passou a ser oferecido em D18)**: quando o material chega fisicamente a Extrema (sede da ACXE), o local é o **21.1 EXTREMA**, espelhado (ACXE 4004166399 ↔ Q2P 7960459966, já correlacionados em `stockbridge.localidade_correlacao`). Assim o estoque aparece na Q2P e vendas pode vender. O 21.2 "EXTREMA (NACIONAL)" da ACXE (4452867179, só ACXE) **não** é usado por esta feature. Vale notar que, no OMIE da ACXE, o 21.1 está descrito como "EXTREMA (IMPORTADO)": a descrição não reflete o uso para compra nacional, mas não afeta o recebimento.

## D12. Cliente OMIE: uma ação nova em `recebimento-nfe.ts`, leitura de PC reaproveitada

**Decisão**:

- `alterarRecebimentoNfeItens` passa a aceitar `cAcao: 'ASSOCIAR-PEDIDO'` com `nIdPedidoExistente` e `nIdItPedidoExistente`;
- o parser de `ConsultarRecebimento` (`parseRecebimentoNfeConsultado`) passa a ler `itensCabec.nIdPedido` e `nIdItPedido` e o bloco `itensInfoAdic` (`nNumPedCompra`, `cNumItPedCompra`), que hoje nem é declarado no tipo `RawRecebimento`;
- `validarItensRecebimentoEditar` continua recusando `itensAjustes` fora de `EDITAR`, agora também com `ASSOCIAR-PEDIDO`;
- `AjustesItemRecebimento` ganha `nQtdeRecebida` (`itensAjustes.nQtdeRecebida`, só com `EDITAR`): a quantidade recebida do item **na unidade do PC**, usada no modo `converter` da trava de unidade (D15). O parser lê o mesmo campo de `ConsultarRecebimento` (`ItemRecebimentoNfe.nQtdeRecebida`, nulo se o OMIE não informa) e o mock o grava sem mexer em `nQtdeNFe`;
- o mock ganha associação com estado (a sombra do modo leitura também), e `nQtdeRec` do PC atualiza ao concluir;
- `consultarPedidoCompra` (344) é reaproveitado sem mudança, com `retries 2` na leitura;
- a escrita continua sem retry (STK-23);
- `ASSOCIAR-PEDIDO` entra na lista de escritas bloqueadas em `OMIE_MODE=leitura` (ACXEGDP-405), porque não está em `METODOS_LEITURA`: o método é `AlterarRecebimento`, já bloqueado.

**Exceção ao Princípio II**: a escrita em `produtos/recebimentonfe/` já é exceção documentada (016). A ação `ASSOCIAR-PEDIDO` é acrescentada ao texto da seção 2 de `specs/007-stockbridge-module/research.md`, junto com as leituras ao vivo desta feature: `ConsultarPedCompra` na confirmação (D4) e `ConsultarRecebimento` por chave para NF "fiscal já feito" cuja conclusão o espelho de recebimentos não confirma (NF ausente, linha defasada com `c_recebido = 'N'` ou não casada com o item) e sem o fiscal concluído pelo Atlas no ledger (D7).

## D13. Frescor da cópia de PCs: monitorada, e defasada não decide nada

**Decisão**: com esta feature, a cópia `tbl_pedidosCompras_<empresa>` passa a decidir a sugestão, o bloqueio de NF sem PC e o aviso a compras, e vira tabela crítica para o Princípio II ("Monitoramento DEVE alertar se MAX(dDtAlt) das tabelas críticas ficar defasado"). Então:

- **idade** da cópia = `now() − max(data_atualizacao)` (a Rev 1.5 grava o início do sync em todas as linhas, na troca atômica);
- **health** do módulo ganha `pedidosCompraCopiaIdadeMin`, `degraded` acima de `STOCKBRIDGE_COPIA_PCS_MAX_MIN` (default 120: com aviso por evento e agenda de 10 min, passar de 2 h significa pipeline quebrado);
- **alerta** no cron que já vigia o espelho de recebimentos (`alerta-espelho-recebimentos.service.ts`), para `STOCKBRIDGE_OPS_EMAIL`, com o mesmo reaviso;
- **modo seguro**: com a cópia defasada, o detalhe mostra "lista de pedidos de compra desatualizada" e o POST com fiscal pendente responde `503 COPIA_PCS_DEFASADA`, sem gravar nada, sem aplicar `NF_SEM_PC` e sem avisar compras. NF com fiscal já feito não depende da cópia e segue normal;
- na Fase 2, o mesmo para a cópia da ACXE e o espelho de recebimentos da ACXE.

**Alternativas**: tratar cópia defasada como "sem PC" foi rejeitado, porque bloquearia NFs e mandaria avisos falsos a compras justamente quando o problema é do pipeline.

## D14. PC por NF: o operador escolhe o pedido uma vez por nota, o servidor deriva a atribuição item a item (22/10/2026)

**Problema**: na NF 60199 o PC era um só (306), mas a tela pedia a escolha e a justificativa item por item: 3 confirmações do mesmo PC e 3 justificativas iguais (relato do usuário, 22/10/2026).

**Decisão**: o detalhe ganha `pcsDaNf` (`PcsDaNf`: `pcs[]` e `preSelecionado`), montado por `montarPcsDaNf` a partir das listas de cada item. Entram só os itens a receber (pendentes, com unidade convertida, sem baixa externa pedida e com quantidade em kg). Vazio fora do fluxo de PC e com a cópia de PCs defasada.

- **Quais PCs**: todo PC que aparece em algum item como vínculo do OMIE elegível, candidato ou "outro do fornecedor".
- **Atribuição item da NF → item do PC**: gulosa, do item maior para o menor. Cada item fica com a primeira opção daquele PC (na ordem do próprio item) cujo saldo restante ainda cabe, com a tolerância de quantidade. Se nenhuma cabe, fica com a primeira, e o POST decide com o saldo ao vivo. Duas linhas da NF podem apontar para o mesmo item do PC (itens 3 e 4 da NF 60199 → PELBD 07/21), e o saldo restante é consumido na ordem.
- **Por PC** (`PcDaNf`): `itens[]` (um `PcDaNfItem` por item atendido, com `origem` omie/sugestao/manual, `dentroTolerancia` e `justificativaNecessaria`), `cobreTodos` (nenhum item sem PC possível e o PC atende todos), `dentroTolerancia`, `vinculoOmie` e `justificativaNecessaria`.
- **Ordem dos PCs**: cobre todos os itens; vínculo do OMIE; atende mais itens; dentro da tolerância; número.
- **Pré-seleção da nota**: o vínculo do OMIE que cobre todos sem justificativa; senão o único PC que cobre todos dentro da tolerância e sem justificativa; senão nenhum (o operador escolhe).
- **Justificativa**: uma só para a nota, pedida quando qualquer atribuição exige (fora da tolerância, escolha manual, troca do vínculo do OMIE ou vínculo sem dados locais). A tela a copia para o `pc.justificativa` de cada item.

O **POST continua por item** (`itens[].pc`): a tela aplica a escolha da nota em cada item, e o portão 1, a matriz de justificativa (data-model §4), a releitura ao vivo e a reserva (D4) não mudam. Um PC que não atende algum item deixa esse item sem opção naquele PC; o operador resolve o item à parte.

**Alternativa não adotada**: mudar o POST para um `pc` por nota. O item é a unidade do vínculo (FR-002c) e o contrato por item é o que a 017 já testa.

## D15. Trava de unidade: PC em unidade diferente da NF é bloqueado por padrão; converter fica atrás de chave, a validar (22/10/2026)

**Descoberta**: na conclusão do recebimento, o OMIE grava em `nQtdeRec` do PC a quantidade recebida do item **na unidade da NF**, sem converter. A NF 60199 (toneladas) baixou o PC 306 (kg) com 8,25 / 13,75 / 5,5 em vez de 8.250 / 13.750 / 5.500.

**Correção validada no portal** (22/10/2026, 15h23, pelo usuário): reverteu o recebimento, editou a "quantidade recebida" de cada item para o valor na unidade do PC (8250 etc.) e concluiu de novo. Resultado: PC 306 recebido por inteiro; `nQtdeNFe` da NF inalterado (8,25); um só título de conta a pagar (R$ 292.737,65, vencimento 04/11/2026); estoque sem movimento novo. O campo editado é o `itensAjustes.nQtdeRecebida` do `AlterarRecebimento` `EDITAR`. A etapa do PC continuou 15 mesmo recebido por inteiro: o OMIE não a muda (igual ao PC 304).

**Decisão**: a variável `STOCKBRIDGE_PC_UNIDADE_DIFERENTE` (`bloquear` | `converter`, default `bloquear`) define o que fazer. **Unidade diferente** = fator para kg diferente (KG × T/TON/TL; T, TON e TL contam como a mesma unidade). PC em unidade que não é KG, T, TON nem TL já ficava fora da sugestão.

- **`bloquear` (default)**:
  - o PC em unidade diferente vai para `pc.unidadeIncompativel` (visível, não selecionável), em vez de candidatos e "outros";
  - o vínculo do OMIE nesse caso fica inelegível (`vinculoOmieElegivel = false`) e o alerta orienta compras e o fiscal; sem outro PC, a NF é recusada no portão 1 **nos dois modos** de `STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC` (como o vínculo que não serve, FR-011a): "seguir sem vínculo" ignoraria um item com vínculo vivo no OMIE, e o fiscal só barraria depois com um `VINCULO_OMIE_MUDOU` enganoso;
  - o motivo da trava mostra as duas quantidades na unidade do PC: "com 8,25 em vez de 8.250 kg" (nota em toneladas, PC em kg) e "com 8.250 em vez de 8,25 toneladas" (nota em kg, PC em toneladas);
  - sem outro PC possível, o motivo interno é `unidade_pc` e a situação, `sem_pc`: `422 NF_SEM_PC` com texto próprio e aviso a compras com o quadro "Pedido em unidade diferente da nota" (gravado em `nf_aviso_compras` com o motivo `sem_pc`, que o CHECK já aceita). PC aguardando aprovação tem precedência na mensagem;
  - `pc` do corpo que é um `unidadeIncompativel` → `422 PC_NAO_ELEGIVEL`;
  - releitura ao vivo com PC em unidade diferente (inclusive o vínculo que o OMIE já fez) → `409 PC_VINCULO_INVALIDO`.
- **`converter`**: o PC em unidade diferente é oferecido normalmente, e o `EDITAR` manda `itensAjustes.nQtdeRecebida` = kg da linha ÷ fator da unidade do PC (arredondado em 6 casas): 8.250 kg → 8250 em PC de KG; 8,25 em PC de TON. A reserva devolve o valor (`ReservaPc.nQtdeRecebida`, nulo se a unidade é a mesma), `ajustesJaAplicados` confere também esse valor (a retomada só refaz o `EDITAR` se a quantidade difere), e o saldo do PC continua comparado em kg.

**Estado**: default `bloquear`. O modo `converter` **não foi testado pela API**: o campo foi validado só pelo portal. Ligar em PROD depende de um teste com NF real em toneladas contra PC em kg (quickstart, cenário 10). No UAT (`OMIE_MODE=leitura`) as escritas são simuladas, então o modo pode ser exercitado lá, mas isso não prova o comportamento do OMIE.

**Alternativas**: converter sempre foi descartado por não ter sido testado pela API; o bloqueio é o modo seguro. Corrigir no portal depois da conclusão (o que o usuário fez em 22/10) funciona, mas é trabalho manual por NF e deixa o PC errado até lá.

## D16. Cache de PCs vistos: o PC some da lista de pendentes quando ganha item associado a um recebimento aberto (22/10/2026)

**Problema**: o PC 306 sumiu da cópia local `tbl_pedidosCompras_Q2P` (n8n `qPJFEIY1PQ2LDQG2`, `PesquisarPedCompra` com `lExibirPedidosRecParciais = 'T'`) entre a associação (13h) e a conclusão (15h) da NF 60199, e voltou depois como recebido parcial. O OMIE tira da lista de pendentes o PC com item associado a um recebimento aberto. Na janela, o detalhe mostrava o vínculo do OMIE "sem número, sem saldo, exige justificativa" e os outros itens da mesma NF ficavam sem candidato (`NF_SEM_PC` com o PC existindo e com saldo).

**Decisão**: tabela `stockbridge.pedido_compra_visto` (migration `0057`, data-model §11) com a última versão de cada item de PC que passou pela cópia (chave: empresa + item do PC).

- **Quem grava**: `registrarPcsVistos(empresa)` (`pc-visto.service.ts`), no cron `5,35 * * * *` (Q2P) e ao carregar o contexto da sugestão (`registrarPcsVistosSeVencido`, no máximo 1× a cada 5 min por processo). O upsert só grava a linha que **mudou** (`IS DISTINCT FROM`), então a trigger de auditoria registra o histórico real do PC (saldo, etapa, preço) e não o ruído de cada sincronização. Por isso `visto_em` é o momento em que o Atlas viu os dados atuais do item, e só se atualiza quando algo muda.
- **Quem lê**: `carregarContextoPc` lê o cache (`lerPcsVistos`) para os fornecedores da NF, as raízes de CNPJ (D17) e os PCs de vínculo do OMIE, e inclui com `fonte: 'cache'` (`PcCandidato.dadosEmCache`) **só** os itens que a cópia não trouxe. Número, produto, saldo e etapa são os da última vez em que o PC foi visto.
- **Vínculo do OMIE em PC só no cache**: elegível, com alerta ("saiu da lista de pedidos pendentes do OMIE; os dados são da última sincronização em que apareceu; a confirmação confere o saldo ao vivo"). `numerosDosPcs` (número do PC nas NFs com fiscal já feito) ganha o cache como 3ª fonte, depois da cópia e do ledger.
- **A confirmação continua conferindo ao vivo** (D4, FR-009): o cache nunca decide sozinho.
- **Best-effort**: falha ao ler ou gravar o cache vira aviso no log e a sugestão segue só com a cópia (comportamento anterior). A tabela ausente, porém, derruba a query única de `numerosDosPcs`, que perde também os números vindos da cópia e do ledger ("PC vinculado no OMIE" sem número). Por isso a 0057 vai antes da imagem, ainda que nada deixe de funcionar sem ela.
- **Validade**: como candidato (por fornecedor ou raiz de CNPJ) o item do cache vale 7 dias (`CACHE_PC_VALIDADE_DIAS`): o PC que saiu da lista por recebimento total no portal, cancelamento ou exclusão ficaria aqui com o último saldo visto e seria oferecido (e até pré-selecionado) até a releitura recusar no POST; a janela que o cache resolve dura horas ou dias. O PC apontado por um vínculo do OMIE entra sempre.
- **Linha repetida na cópia**: a leitura usa `DISTINCT ON (ncoditem)` (mais recente por `data_atualizacao`); sem isso um `ncoditem` repetido derrubaria o upsert inteiro (SQLSTATE 21000) e entraria duas vezes no valor total do PC.
- **Limites**: só a Q2P (o cron chama `registrarPcsVistos('q2p')`; o código já aceita a ACXE na Fase 2). Um PC criado e associado entre duas sincronizações nunca passou pela cópia, então o cache não o conhece: cai no caso anterior (vínculo sem dados locais, e a releitura decide).

**Alternativa descartada**: ler o PC ao vivo (`ConsultarPedCompra` ou `PesquisarPedCompra`) no GET do detalhe. Fere o Princípio II (a leitura ao vivo é só no POST, imediatamente antes de escrever) e custaria uma chamada de API a cada abertura de NF.

## D17. PC de outro cadastro com a mesma raiz de CNPJ passa a ser oferecido; FR-002 revisado (22/10/2026)

**Evidência**: o T033 mostrou o `ASSOCIAR-PEDIDO` aceito com PC de outro cadastro do mesmo fornecedor (NF 60199 da filial × PC 306 da matriz). A Zaraplast fatura sempre por filial, e compras lança o PC no cadastro da matriz. A decisão anterior (21/10 e primeira revisão de 22/10) era não oferecer, "até o T033 testar".

**Decisão**: "mesmo fornecedor" (FR-002 a) passa a ser o mesmo cadastro **ou** outro cadastro com a mesma raiz de CNPJ (8 primeiros dígitos, ambos com CNPJ de 14 dígitos). CPF ou cadastro sem CNPJ não tem raiz: só vale o mesmo cadastro.

- **Carga**: `carregarContextoPc` busca os PCs do cadastro da NF, os dos vínculos do OMIE e os dos cadastros com a mesma raiz (`raizPorFornecedor`).
- **Marcação**: `PcCandidato.outroCadastro` (o cadastro do PC difere do fornecedor da NF) e `cnpjCadastro` (só dígitos; a tela formata). O motivo ganha o sufixo "em outro cadastro do fornecedor (CNPJ …)".
- **Releitura ao vivo**: o PC é do mesmo fornecedor se o cadastro ao vivo é o mesmo ou tem a mesma raiz. A consulta ao cadastro só acontece quando algum PC está em outro cadastro, sem custo extra no caso comum. Continua valendo a isenção do vínculo vivo = escolhido (D4).
- **Removido**: o "só informativo" (`pcsOutroCadastro`) do motivo do item e o quadro "PC em outro cadastro" do aviso a compras, que pedia para ajustar o fornecedor do pedido.

**Pendente**: a troca de um vínculo existente entre cadastros não foi testada (T033 c).

## D18. Compra nacional da ACXE: o operador escolhe o local, o PC sugere; entrada nas duas empresas ou só na ACXE (22/10/2026)

**Evidência** (espelho do OMIE da ACXE em PROD, 22/10/2026): de jul/2025 a out/2026, as NFs de compra nacional da ACXE (CFOP 2.101/2.102) entraram no **20.0.7 PRODUÇÃO** (50 NFs: Solutec PP PRETO Q35, 692 t; Tritec PP; Replas sucata; GGA stretch; e 12 de STRETCH da própria Q2P, intercompany), no 20.0.5 PROCESSO (1), no 21.2 EXTREMA (NACIONAL) (3, Solutec ABS/PS) e no 21.1 (4, todas de 2025). O primeiro PC nacional da ACXE (PC 580, Solutec, 26.000 kg de PP PRETO Q35, 21/10/2026) aponta para o 20.0.7. A decisão de D11 ("sempre nas duas empresas, nunca só na ACXE") foi tomada em 21/10 sem compra nacional da ACXE à vista e poria matéria-prima de produção no estoque de venda da Q2P.

**Decisão do usuário**: o operador escolhe o local, com o local do PC pré-selecionado. A lista da NF da ACXE traz:

- os locais que **também são da Q2P** (correlação com os dois códigos, tipo não virtual: 11.1, 12.1, 21.1, 31.1): entrada na ACXE e na Q2P, com o **mesmo valor unitário** (valor do item na NF por kg, sem o × 1,145 da importação);
- os locais **só da ACXE** (21.2 EXTREMA NACIONAL e os novos 20.0.5 PROCESSO e 20.0.7 PRODUÇÃO): entrada só na ACXE.

**Desenho**:

- **Entrada na aprovação do gestor**, como na Q2P: o POST grava uma movimentação e uma aprovação por produto (`entrada_manual`/`compra_nacional`, empresa `acxe`); a aprovação faz `ENT/INI` na ACXE e, no local que também é da Q2P, `ENT/INI` na Q2P em seguida, com o mesmo número de `custo_unitario_brl` (sufixos `nacional-acxe` e `nacional-q2p`, os mesmos de hoje, agora em `COD_INT_AJUSTE_SUFIXO`). Falha na ACXE: nada é gravado e a aprovação fica pendente. Falha só na Q2P: aprovação `aprovada`, movimentação `pendente_q2p` com a perna da ACXE gravada, alerta e retentativa (função própria em `operacoes-pendentes`, botão "Retentar Q2P" em Movimentações). Nunca há baixa de PC na Q2P (FR-029).
- **Entrada nas duas empresas** é derivada, sem coluna nova: `subtipo = 'compra_nacional'`, `empresa = 'acxe'`, `nf_chave_acesso` e `produto_codigo_q2p` preenchidos.
- **Produto**: do catálogo da ACXE. A sugestão vem do produto que o OMIE já associou ao item da NF e do produto do item do PC; a memória fornecedor × descrição (`correlacao_produto_fornecedor`) continua só da Q2P nesta fase. Para entrar nas duas empresas, o produto precisa do "gêmeo" na Q2P: produto **ativo** de mesma descrição (regra de `getCorrelacao`). Sem gêmeo, a combinação é recusada no portão 1, antes do fiscal (só 189 de 475 produtos ativos da ACXE têm gêmeo; a sucata da Replas não tem). O gêmeo vai gravado em `produto_codigo_q2p`: aprovação e retry não refazem a correspondência.
- **Locais 20.0.5/20.0.7**: cadastrados pela 0058 com o tipo novo `operacional` e `galpao`/`cnpj` nulos, só com o código do OMIE da ACXE. Ficam fora de Meu Estoque, saída manual e transferências, como os outros códigos operacionais 20.x.
- **Fila**: a NF da ACXE só entra com a chave `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED`, a chave do fiscal da 016 e o corte próprio `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE` (13 NFs da ACXE emitidas desde o corte da Q2P, 11/09/2026, já foram recebidas no portal com estoque). A Q2P (matriz e filial) fica fora da fila da ACXE por `fornecedor_exclusao.empresa`. Sem o espelho de recebimentos da ACXE (n8n inativo), não há "fiscal pendente" da ACXE.
- **Idempotência**: índice novo por linha da NF e produto da ACXE (`movimentacao_nf_nacional_acxe_idempotencia_idx`); o da 0052 continua valendo para a linha que leva `produto_codigo_q2p`, por isso dois produtos da ACXE da mesma linha não podem cair no mesmo gêmeo (recusado no portão 1).

**Revisão adversarial (23/10/2026)**, achados corrigidos: produto da ACXE só em **KG** (lista, sugestão e portão 1 — `422 PRODUTO_UNIDADE_NAO_KG`; o gêmeo da Q2P também em KG); corte da ACXE validado como data de calendário e **qualquer** falha da consulta com a ACXE refeita só com a Q2P; o índice da 0052 restrito à Q2P; a exclusão de fornecedor filtrada por empresa também na consulta só da Q2P; "Retentar Q2P" só na entrada da ACXE nas duas empresas, com `409 RETENTATIVA_INVALIDA` nas guardas e `userMessage` nos erros; o aviso de dispensa ao fiscal com a empresa da NF; saúde do espelho da ACXE pelo batimento do n8n (`tbl_sync_debounce`, chave `receb_acxe`) além de `MAX(synced_at)` — com poucas NFs, o espelho para de andar sem falha do n8n.

**Efeitos colaterais conhecidos (fora do escopo)**: a entrada nacional nas duas empresas em 11.1/12.1/21.1/31.1 conta como `importado_no_chao` em `vw_hedge_estoque`; o mapa da Conferência de Estoque ainda chama o 21.2 da ACXE de "INATIVO 01".

**Alternativas descartadas**: sempre nas duas empresas (D11 original: matéria-prima de produção apareceria para venda na Q2P); só na ACXE, no local do PC, sem escolha (não cobre material de venda chegando a Extrema).

---

## Pendências de pesquisa (não bloqueiam o plano)

1. ~~**Teste de D2** com NF real sem vínculo~~: **feito em 22/10/2026 (T033)** e aprovado (D2). Restam (c) a troca de um vínculo existente e (d) a NF menor que o saldo do PC, para quando houver NF. Não bloqueiam.
2. ~~**Se a etapa do PC muda depois** do recebimento total~~: resolvido. O PC 306, recebido por inteiro, continuou na etapa 15, como o 304 (D15). A elegibilidade usa o saldo (`nqtde − nqtderec`) além da etapa.
3. **Como o OMIE associa sozinho.** Na NF 7813, o recebimento foi incluído por `cUsuarioInc = P000548700` já com o vínculo. Ainda não se sabe se foi automático (pelo `xPed` do XML) ou manual. Não afeta o desenho: o vínculo existente é sempre a sugestão principal.
4. ~~Local da ACXE em Extrema~~: resolvido em D18 (22/10/2026): o operador escolhe; 21.1 EXTREMA entra nas duas empresas, 21.2 e os locais de produção entram só na ACXE.
6. **Primeira escrita na ACXE pelo Atlas** (D18): o fiscal com vínculo de PC no OMIE da ACXE e o `ENT/INI` na ACXE (20.0.7, 21.2) e no par 21.1 nunca rodaram em escrita real (o UAT simula as escritas). Teste controlado em PROD antes de ligar a chave da ACXE, no modelo do T033: próxima NF da Solutec contra o PC 580.
5. **Modo `converter` da trava de unidade** (D15): testar com NF real em toneladas contra PC em kg, pela API, antes de ligar em PROD. Enquanto isso o default é `bloquear`.
