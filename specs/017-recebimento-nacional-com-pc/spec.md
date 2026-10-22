# Feature Specification: Recebimento Nacional com Pedido de Compra

**Feature Branch**: `017-recebimento-nacional-com-pc`
**Created**: 2026-10-21
**Status**: Draft
**Input**: User description: "StockBridge: recebimento nacional com pedido de compra no OMIE (Q2P e ACXE), ACXEGDP-437. Compras passou a lançar pedido de compra (PC) no OMIE para a compra nacional. O Atlas sugere o PC de cada item da NF, o operador confirma, e o recebimento fiscal é concluído com o item vinculado ao PC, sem movimentar estoque no OMIE. O estoque continua entrando pelo Atlas depois da aprovação. Depois, a compra nacional pela ACXE, com estoque espelhado como na importação."

## Contexto

As features 015 (ACXEGDP-328) e 016 (ACXEGDP-395) levaram para o StockBridge o recebimento de compra nacional da Q2P a partir da NF. Na 015, o operador escolhe a NF numa fila, confere os itens e dá entrada no estoque. Na 016, o mesmo clique conclui antes o recebimento fiscal no OMIE. Esse desenho partia de um fato: a compra nacional **não tinha pedido de compra no OMIE**. Por isso o fiscal da 016 reproduz o "Ignorar" da tela, e o item da NF fica sem vínculo com produto ou pedido.

**O que mudou.** Desde 19 e 20/10/2026, compras lança PC no OMIE também para a compra nacional. Os primeiros na Q2P foram o PC 302 (Replas), o 303 (Isoforma) e o 304 (Replas). No portal do OMIE, o vínculo entre o item da NF de entrada e o item do PC é feito à mão, na tela de recebimento da NF-e. Concluído o recebimento com o vínculo, o PC registra a quantidade recebida.

**O problema.** O recebimento fiscal feito pelo Atlas conclui a NF sem vínculo, então o PC correspondente continua aberto como se nada tivesse chegado. Em 21/10/2026, o Atlas concluiu assim as NFs 7736 (Replas, 18.000 kg a R$ 11,30) e 67913 (Isoforma, 13.440 kg, mesmo valor do PC 303), e os PCs ficaram abertos. **Contenção**: no mesmo dia, o recebimento fiscal pelo Atlas foi desligado em PROD. O fiscal voltou a concluir no portal (vinculando o PC e marcando "não movimentar estoque"), e o Atlas faz só o recebimento físico, como na 015.

**O que esta feature entrega.** O Atlas passa a sugerir o PC de cada item da NF. O operador confirma, e o recebimento fiscal é concluído no OMIE com o item vinculado ao PC confirmado, ainda **sem movimentar estoque no OMIE**. O estoque continua entrando pelo recebimento físico do Atlas depois da aprovação, inclusive quando 1 item da NF vira vários produtos. Em fase posterior, a feature vale também para a compra nacional da **ACXE**: fiscal e PC na ACXE, com o material entrando no estoque espelhado (ACXE + Q2P), como na importação.

**O OMIE já pode trazer o vínculo pronto.** A leitura ao vivo da **NF 7813 da Replas** (18.000 kg a R$ 11,30, etapa 40, ainda não recebida), em 21/10/2026 às 18h, mostrou o item **já associado ao PC 304**: o recebimento indica o PC e o item do PC, o produto do PC (PS CRISTAL B) e o número do pedido "304" informado na NF. Ainda não se sabe se a associação foi automática (o OMIE casando o número do pedido que o fornecedor pôs na NF com o PC do mesmo fornecedor) ou feita à mão no portal. O mesmo recebimento estava com "não movimentar estoque" **desligado**, ou seja, concluído assim o OMIE lançaria estoque. A NF 7736 (também Replas, 18.000 kg a R$ 11,30), concluída pelo Atlas com "Ignorar", hoje não mostra pedido nenhum. A hipótese, ainda não comprovada, é que ela estava associada ao PC 302 e o "Ignorar" apagou o vínculo. Consequências:

- A fonte mais forte para o PC de um item é o vínculo que o próprio OMIE já traz no recebimento. A sugestão por fornecedor, preço e saldo é o caminho para quando a NF chega sem vínculo.
- O Atlas nunca pode "Ignorar" um item que já vem associado a um PC. Tem que preservar o vínculo e só garantir que o recebimento não movimente estoque.

**O que o teste já mostrou e o que falta.** O teste controlado na NF 7813, em 21/10/2026, confirmou o caminho para o item que já chega vinculado: marcar "não movimentar estoque" mantém o vínculo, a conclusão gera a conta a pagar sem movimentar estoque, e o próprio OMIE registra a quantidade recebida no PC. Falta testar a gravação de um vínculo novo pela API e a NF menor que o PC. Os requisitos que dependem disso estão marcados.

## Clarifications

### Session 2026-10-21

- Q: Quem escolhe o PC de cada item da NF? → A: **O Atlas sugere e o operador confirma.** Nada é vinculado sem a confirmação do operador.
- Q: Quem dá entrada no estoque quando a NF tem PC: o OMIE, ao concluir o recebimento com o vínculo, ou o Atlas? → A: **O Atlas, depois da aprovação, como hoje.** No OMIE, o recebimento com PC **não pode** movimentar estoque. Se o OMIE movimentasse, o estoque entraria em dobro, ou entraria antes de o gestor aprovar uma divergência.
- Q: O vínculo pode trocar a descrição do item da NF no OMIE (como na ACXEGDP-412, NF 36624). Isso é aceitável? → A: Sim. A troca de produto acontece só na entrada de estoque do Atlas, e no fiscal não se muda nada. A fila tem que reconhecer o item pela posição na NF (sequência, feature da ACXEGDP-412), não pela descrição.
- Q: E o caso de 1 item da NF virar vários produtos (sucata classificada por grau)? → A: Segue como já funciona. O vínculo com o PC é do **item fiscal**; os N produtos ficam só na entrada de estoque.
- Q: A compra nacional pela ACXE entra no escopo? → A: Sim. O Atlas recebe fiscalmente a NF e o PC dentro da ACXE, e o material entra no estoque espelhado (ACXE + Q2P), como os importados. É prioridade menor que a Q2P (User Story 5).
- Q: De onde vem a lista de PCs para sugerir? → A: Da cópia local dos PCs do OMIE (espelho), que passa a ser atualizada de hora em hora e a cada alteração de PC (trabalho separado no n8n). Na confirmação, o Atlas relê o PC no OMIE, porque o espelho pode estar alguns minutos atrás.
- Q (leitura ao vivo da NF 7813, 21/10 às 18h): e quando o recebimento já chega do OMIE com o item associado a um PC? → A: Esse vínculo é a sugestão principal. O operador confirma o PC que veio associado ou troca por outro. O Atlas nunca "ignora" um item que tem PC associado: preserva o vínculo e só garante "não movimentar estoque" antes de concluir. A sugestão por fornecedor, preço e saldo vale para itens que chegam sem vínculo.
- Q: Quais PCs nunca podem ser sugeridos? → A: Os de fornecedor **ACXE** com valor total abaixo de **R$ 200**. São os PCs-espelho da importação na Q2P ("Pedido original ACXE: N"), lançados a R$ 0,0001/kg; o PC 295, de 198.000 kg, vale R$ 19,80. Eles ficam na cópia local, porque a baixa do PC Q2P de importação (ACXEGDP-344) depende deles, mas nunca entram na sugestão.
- Q: NF de compra nacional com item sem PC correspondente: receber sem vínculo ou bloquear? → A: **Bloquear**, com a regra configurável por variável de ambiente: bloquear (padrão) ou receber sem vínculo, como na 016. Nos dois modos, compras é avisado.
- Q: Tolerância para o Atlas sugerir um PC? → A: **Quantidade da NF até 2% acima do saldo do PC e preço unitário até 1% de diferença.** Fora disso, o operador ainda pode escolher o PC à mão, com justificativa registrada.
- Q: Quais etapas de PC podem ser vinculadas? → A: **Só a 15 (aprovado).** PC na etapa 10 aparece como "PC aguardando aprovação" e não pode ser vinculado.
- Q: Um item da NF pode ser dividido entre dois PCs? → A: **Não.** Um item da NF casa com um único item de PC. Caso raro, o fiscal resolve no portal.
- Q: Fiscal concluído no portal sem "não movimentar estoque" (o OMIE já lançou o estoque): o Atlas detecta e bloqueia, ou só orienta o fiscal? → A: **Detecta e bloqueia a entrada física**, com mensagem ao operador.
- Q: Chave de liga/desliga própria ou a mesma da 016? → A: **A mesma da 016** (`STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED`). Religada depois da entrega desta feature, o Atlas passa a concluir o fiscal mantendo o vínculo com o PC.
- Q: Na compra nacional pela ACXE, vai existir PC correspondente na Q2P? → A: **Não.** O PC e a NF chegam só na ACXE, e o fiscal é feito na ACXE. O n8n que espelha PCs da ACXE na Q2P (`RDa9ilL3tbx5ETIk`) só copia PC de fornecedor estrangeiro (filtro da ACXEGDP-376) e ignora o nacional. Não há baixa de PC na Q2P. **O estoque segue a regra da importação:** no recebimento físico o Atlas oferece os mesmos locais da importação, todos espelhados, e a entrada é lançada na ACXE e na Q2P. Quando o material chega fisicamente a Extrema (sede da ACXE), o local é o **21.1 EXTREMA**, espelhado, para que vendas possa vender pela Q2P (correção do usuário, 21/10/2026: não há caso de entrada só na ACXE).
- Q: Valor da entrada espelhada na Q2P? → A: **O mesmo valor nas duas empresas** (o valor do item na NF). Sem o acréscimo interno de 14,5% que a importação aplica hoje na entrada da Q2P (correção do usuário, 21/10/2026).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ver o PC sugerido para cada item e confirmar o vínculo (Priority: P1)

O operador abre na fila uma NF nacional com fiscal pendente. Para cada item, o Atlas mostra o PC correspondente: número do PC, produto, quantidade pedida, saldo a receber, preço unitário e data. Se o item já veio do OMIE associado a um PC, é esse que aparece, marcado como "vínculo do OMIE". Se não, o Atlas sugere o PC do mesmo fornecedor que mais provavelmente corresponde ao item. O operador confere, troca por outro PC se for o caso, e confirma.

**Why this priority**: sem o PC certo, o fiscal não pode ser concluído com vínculo e o PC fica aberto, que é o problema de hoje. É também a decisão que o usuário pediu para ficar com o operador.

**Independent Test**: abrir a NF 7813 da Replas (item já associado no OMIE ao PC 304) e verificar que o detalhe mostra o PC 304 como vínculo do OMIE. Abrir uma NF de fornecedor com PC aberto compatível e sem vínculo, e verificar a sugestão. Nos dois casos, o operador confirma, a escolha fica registrada e nada é feito ainda no OMIE.

**Acceptance Scenarios**:

1. **Given** uma NF com fiscal pendente cujo item já veio do OMIE associado a um PC (caso real: NF 7813 → PC 304, item 1), **When** o operador abre o detalhe, **Then** o item mostra esse PC, marcado como "vínculo do OMIE", com número, produto, quantidade pedida, saldo a receber, preço unitário e data.
2. **Given** um item sem vínculo cujo fornecedor tem PC aberto com saldo e preço compatíveis, **When** o operador abre o detalhe, **Then** o item mostra o PC sugerido, com os mesmos dados.
3. **Given** um item sem vínculo e dois PCs igualmente compatíveis (caso real: PCs 302 e 304 da Replas, ambos de 18.000 kg a R$ 11,30), **When** o operador abre o detalhe, **Then** os dois aparecem como candidatos, sem que o sistema escolha um sozinho, e o operador precisa escolher.
4. **Given** um item sem vínculo cuja NF traz o número do pedido do comprador, **When** esse número corresponde a um PC aberto do fornecedor, **Then** esse PC aparece em primeiro lugar.
5. **Given** um fornecedor com PCs abertos, **When** a sugestão é montada, **Then** nenhum PC de fornecedor ACXE com valor total abaixo de R$ 200 aparece como candidato.
6. **Given** um item com vínculo do OMIE, **When** o operador troca por outro PC, **Then** a troca fica registrada com o PC original e o escolhido, e o vínculo gravado no OMIE passa a ser o escolhido.
7. **Given** o operador confirmou um PC, **When** ele finaliza o recebimento, **Then** o Atlas relê o PC e o recebimento no OMIE. Se o PC não estiver mais aberto, não tiver mais saldo para o item ou o vínculo no OMIE tiver mudado, o vínculo é recusado, com a situação atual à vista, e o operador escolhe de novo.

---

### User Story 2 - Concluir o fiscal com o item vinculado ao PC, sem estoque pelo OMIE (Priority: P1)

Com os PCs confirmados, o operador confirma o recebimento. O Atlas conclui o recebimento fiscal da NF no OMIE com cada item vinculado ao item de PC escolhido, sem gerar movimento de estoque no OMIE, e em seguida lança a entrada de estoque pelo caminho de hoje (correlação, divergência, aprovação do gestor).

**Why this priority**: é o objetivo da feature. Fecha o laço com compras (o PC passa a mostrar o que foi recebido) sem perder o controle do estoque pelo Atlas.

**Independent Test**: receber pelo Atlas uma NF com PC confirmado e verificar no OMIE que a NF está recebida, com conta a pagar, cada item vinculado ao PC escolhido, nenhum movimento de estoque gerado pelo fiscal e o PC mostrando a quantidade recebida. No Atlas, a entrada de estoque foi lançada uma vez e a NF não volta à fila.

**Acceptance Scenarios**:

1. **Given** uma NF com fiscal pendente e PC confirmado em todos os itens, **When** o operador confirma o recebimento, **Then** o fiscal é concluído no OMIE com os vínculos **antes** de qualquer entrada de estoque, e o operador vê o resultado de cada etapa.
2. **Given** um item que veio do OMIE associado a um PC e com "não movimentar estoque" desligado (caso real: NF 7813), **When** o Atlas conclui o fiscal, **Then** o vínculo é preservado (o item **não** é ignorado) e o recebimento é concluído **sem** movimento de estoque.
3. **Given** o fiscal concluído com vínculo, **When** se consulta a NF no OMIE, **Then** ela está recebida, com a conta a pagar gerada, cada item vinculado ao item de PC confirmado e **nenhum** movimento de estoque gerado pelo fiscal.
4. **Given** o fiscal concluído com vínculo, **When** se consulta o PC no OMIE, **Then** ele mostra a quantidade recebida desse item. [Confirmado no teste da NF 7813, em 21/10/2026: o próprio OMIE atualizou o `nQtdeRec` do PC 304 para 18.000 ao concluir. A etapa do PC continuou 15 logo depois da conclusão.]
5. **Given** o vínculo trocou a descrição do item no OMIE, **When** a NF passa a constar como "fiscal concluído" no espelho, **Then** ela **não** volta para a fila (o item é reconhecido pela sequência).
6. **Given** um item da NF de sucata que vira vários produtos no estoque, **When** o recebimento é concluído, **Then** o item fiscal fica vinculado a um único item de PC e a entrada de estoque reparte a quantidade entre os produtos, como hoje.

---

### User Story 3 - NF sem PC correspondente (Priority: P2)

Nem toda compra nacional terá PC, ao menos na transição: o fornecedor ainda não entrou no processo, compras esqueceu de lançar, ou o PC tem saldo ou preço incompatível. O operador precisa saber disso ao abrir a NF e ter um caminho definido.

**Why this priority**: sem um caminho para esses casos, a NF fica parada na fila ou é recebida sem vínculo por engano, e volta o problema do PC aberto. Vem depois das Histórias 1 e 2 porque elas cobrem o caminho normal.

**Independent Test**: abrir uma NF nacional de fornecedor sem PC aberto compatível e verificar que a tela diz que não há PC e aplica a regra definida para o caso.

**Acceptance Scenarios**:

1. **Given** uma NF com um item sem PC possível (definição antes do FR-019), **When** o operador abre o detalhe, **Then** o item mostra "nenhum PC encontrado" e o motivo (fornecedor sem PC aprovado com saldo, ou só PC aguardando aprovação). PC aprovado com saldo, mas fora da tolerância, não conta como "nenhum PC": aparece em "Outros PCs do fornecedor", para escolha com justificativa (FR-002a).
2. **Given** essa NF e a regra "bloquear" (padrão), **When** o operador tenta receber, **Then** o recebimento da NF inteira é recusado com a mensagem "aguardando PC de compras", a NF continua na fila e compras é avisado com a NF, o fornecedor e o item.
3. **Given** essa NF e a regra "receber sem vínculo", **When** o operador recebe, **Then** o fiscal é concluído como na 016 para os itens sem PC, os itens com PC mantêm o vínculo, e compras é avisado.
4. **Given** um item cujo único PC possível está na etapa 10, **When** o operador abre o detalhe, **Then** o item mostra "PC aguardando aprovação" e o PC não pode ser vinculado até chegar à etapa 15.

---

### User Story 4 - Falhas, repetições e rejeições não deixam NF nem PC inconsistentes (Priority: P2)

O vínculo acrescenta escritas ao clique. Qualquer uma pode falhar, o operador pode clicar duas vezes, e o gestor pode rejeitar um recebimento com divergência depois de o fiscal e o vínculo já estarem feitos. Em todos os casos a NF e o PC precisam acabar num estado conhecido, e nada pode ser vinculado, recebido no PC ou lançado em estoque duas vezes.

**Why this priority**: mesmo motivo da História 3 da feature 016. Sem isto, um problema visível (PC aberto) vira um invisível (PC recebido duas vezes, ou fiscal concluído com o vínculo errado).

**Independent Test**: simular cada falha (vínculo recusado, conclusão recusada depois do vínculo, falha do estoque depois do fiscal, clique repetido, rejeição do gestor) e verificar o estado da NF e do PC no OMIE e da NF no Atlas.

**Acceptance Scenarios**:

1. **Given** uma NF com fiscal pendente, **When** o vínculo ou a conclusão do fiscal falha, **Then** nenhuma entrada de estoque é lançada, o operador vê uma mensagem que identifica a NF, o fornecedor e o PC (nunca códigos internos do OMIE) e pode tentar de novo.
2. **Given** um vínculo já gravado no OMIE e a conclusão do fiscal ainda não feita, **When** o operador tenta de novo, **Then** o Atlas reconhece o vínculo existente, não o refaz e segue para a conclusão.
3. **Given** o fiscal concluído com vínculo e o estoque com falha, **When** a NF volta à fila, **Then** ela aparece como "fiscal já feito", com o PC vinculado à vista, e o novo recebimento faz só o estoque.
4. **Given** um recebimento com divergência de peso (fiscal e vínculo já feitos), **When** o gestor rejeita, **Then** o fiscal e o vínculo **não** são desfeitos, e a NF volta à fila como "fiscal já feito", como na 016.
5. **Given** o operador confirma duas vezes, **When** o Atlas processa, **Then** o vínculo, a conclusão do fiscal e o estoque acontecem uma única vez cada.

---

### User Story 5 - Compra nacional pela ACXE, com estoque espelhado (Priority: P3)

A compra nacional também pode ser feita pela ACXE. A NF e o PC chegam só ao OMIE da ACXE, e o fiscal é feito na ACXE. O operador recebe essa NF pela mesma fila, com o mesmo fluxo de sugestão e confirmação do PC. No recebimento físico, o Atlas oferece os mesmos locais da importação, todos espelhados, e a entrada é lançada na ACXE e na Q2P. Quando o material chega fisicamente a Extrema, sede da ACXE, o local é o 21.1 EXTREMA, e o estoque também aparece na Q2P para vendas.

**Why this priority**: hoje ainda não há PC de fornecedor nacional na ACXE (21/10/2026), e as Histórias 1 a 4 resolvem o caso que já está acontecendo na Q2P. Fica para uma fase posterior.

**Independent Test**: receber pelo Atlas uma NF nacional da ACXE com PC da ACXE num local espelhado e verificar: o fiscal foi concluído na ACXE com o vínculo e sem estoque pelo OMIE; a entrada de estoque foi lançada nas duas empresas; e não há divergência na Conferência de Estoque ACXE×Q2P. Repetir no 21.1 EXTREMA e verificar a entrada nas duas empresas, nos locais 21.1 de cada uma.

**Acceptance Scenarios**:

1. **Given** uma NF de compra nacional da ACXE com fiscal pendente, **When** o operador abre a fila, **Then** a NF aparece identificada como da ACXE, com o mesmo tratamento das NFs da Q2P.
2. **Given** essa NF com o PC da ACXE confirmado e um local espelhado escolhido, **When** o operador confirma o recebimento, **Then** o fiscal é concluído no OMIE da ACXE com o vínculo e sem movimento de estoque, e a entrada de estoque é lançada na ACXE e na Q2P, no par espelhado.
3. **Given** essa NF com o material chegando a Extrema (local 21.1 EXTREMA), **When** o operador confirma o recebimento, **Then** a entrada de estoque é lançada no 21.1 da ACXE e no 21.1 da Q2P, e o produto fica disponível para venda pela Q2P.
4. **Given** uma NF emitida pela Q2P para a ACXE (intercompany), **When** a fila da ACXE é montada, **Then** essa NF não aparece, assim como a ACXE não aparece como fornecedor na fila da Q2P.
5. **Given** a compra nacional pela ACXE, **When** o recebimento é concluído, **Then** nenhuma baixa de PC é feita na Q2P. Não existe PC correspondente lá: o n8n de espelhamento só copia PC de fornecedor estrangeiro (ACXEGDP-376).

---

### Edge Cases

- **Dois PCs iguais do mesmo fornecedor** (PCs 302 e 304: mesma quantidade e preço): o sistema mostra os dois e não escolhe sozinho. O número do pedido na NF, quando vier, desempata.
- **NF menor que o PC** (NF 67913: 13.440 kg de um PC de 13.500 kg): o PC fica com saldo de 60 kg. [Ainda a confirmar: o teste da NF 7813 recebeu a quantidade cheia do PC, então não respondeu se o PC continua aberto com o saldo ou se o OMIE o encerra.] O PC com saldo continua elegível para a próxima NF enquanto o saldo for compatível.
- **NF maior que o saldo do PC**: até 2% acima do saldo, o PC é sugerido normalmente. Acima disso, o PC não é sugerido; o operador ainda pode escolhê-lo à mão, com justificativa (FR-002a). Se nenhum PC puder ser escolhido, vale a regra de NF sem PC (User Story 3).
- **NF com itens de PCs diferentes, ou um PC com vários itens**: cada item da NF é vinculado a um único item de PC, escolhido separadamente. Um item da NF **não** pode ser dividido entre dois PCs; esse caso raro o fiscal resolve no portal.
- **PC ainda não aprovado**: só PC na etapa 15 (aprovado) pode ser vinculado. PC na etapa 10 aparece como "PC aguardando aprovação". O PC 304 estava na etapa 10 no espelho das 04:30 de 21/10 e na 15 ao vivo às 18h, por isso a situação relida ao vivo na confirmação prevalece sobre a cópia local.
- **Vínculo do OMIE com PC que não serve** (PC sem saldo, fora da etapa 15, cancelado ou excluído, ou PC-espelho da importação): o detalhe mostra o vínculo com o alerta do motivo, e o operador troca por outro PC possível. Sem outro PC possível, o recebimento da NF é recusado nos dois modos da regra de NF sem PC: item que veio vinculado no OMIE nunca é ignorado (FR-011a). Alerta de etapa ou de saldo não impede a confirmação, porque a cópia local pode estar atrás (PC 304: etapa 10 no espelho, 15 ao vivo); quem decide é a releitura ao vivo (FR-009).
- **NF com vínculo apagado antes da feature**: a hipótese é que o "Ignorar" da 016 apagou o vínculo da NF 7736 com o PC 302 (não comprovado). Corrigir essas NFs está fora do escopo (ver Out of Scope).
- **PC consumido entre a sugestão e a confirmação** (outra NF vinculada, PC cancelado ou excluído): a releitura ao vivo na confirmação recusa o vínculo e mostra a situação atual. O operador escolhe outro PC ou cai na regra da User Story 3.
- **PC criado depois que a NF chegou**: aparece na sugestão assim que a cópia local de PCs for atualizada (até 1 hora, ou minutos pelo aviso de alteração).
- **Fiscal concluído no portal com vínculo** (o caminho da contenção, ou alguém concluindo por engano): a NF aparece como "fiscal já feito", com o PC vinculado à vista, e o recebimento faz só o estoque. O recebimento associado ao PC chega com "não movimentar estoque" desligado (NF 7813). Se o fiscal concluir no portal sem marcar essa opção, o OMIE lança estoque, e receber pelo Atlas lançaria o estoque em dobro. O Atlas detecta esse caso e bloqueia a entrada física da NF, com mensagem ao operador (FR-021a).
- **Descrição do item trocada pelo vínculo**: não devolve a NF à fila (reconhecimento pela sequência, ACXEGDP-412).
- **PCs-espelho da importação** (fornecedor ACXE, valor abaixo de R$ 200): nunca aparecem na sugestão. A baixa do PC Q2P de importação (ACXEGDP-344) continua igual.
- **Divergência de peso**: o fiscal e o vínculo acontecem no clique, como na 016. A divergência é assunto do físico e da aprovação do gestor.
- **Dispensa de NF** (016): continua valendo. A dispensa não desfaz vínculo nem fiscal no OMIE, e o aviso ao fiscal passa a citar o PC vinculado, quando houver.
- **Chave de operação desligada**: comportamento da contenção. A fila mostra só NFs com fiscal já feito, e o Atlas faz só o físico.

## Requirements *(mandatory)*

### Functional Requirements

**Sugestão do PC**

- **FR-000**: Quando o item já vier do OMIE associado a um PC (no recebimento da NF-e), o sistema MUST mostrar esse PC como a sugestão do item, identificado como "vínculo do OMIE", com os mesmos dados de qualquer candidato.
- **FR-001**: Para cada item **sem vínculo** de uma NF nacional com fiscal pendente, o sistema MUST sugerir os PCs abertos do mesmo fornecedor, na mesma empresa da NF, que possam corresponder ao item.
- **FR-002**: Um PC só é candidato para um item sem vínculo se: (a) for do mesmo fornecedor da NF; (b) estiver na etapa 15 (aprovado); (c) a quantidade do item não passar de 2% acima do saldo a receber do PC (pedido menos recebido); (d) o preço unitário da NF diferir no máximo 1% do preço unitário do PC.
- **FR-002a**: Fora da tolerância do FR-002, o operador MAY escolher à mão um PC aberto do mesmo fornecedor, na etapa 15 e com saldo, informando uma justificativa, que MUST ficar registrada junto com o vínculo.
- **FR-002b**: Um PC do fornecedor na etapa 10 MUST aparecer como "PC aguardando aprovação" e MUST NOT poder ser vinculado.
- **FR-002c**: Cada item da NF MUST ser vinculado a um único item de PC. Dividir um item da NF entre dois PCs não é permitido.
- **FR-003**: Quando um item sem vínculo trouxer o número do pedido do comprador informado pelo fornecedor na NF e ele corresponder a um PC candidato, esse PC MUST aparecer em primeiro lugar.
- **FR-004**: A sugestão MUST NOT usar a descrição do item. A NF descreve o material como o fornecedor emite ("SUCATA PLASTICO") e o PC, como o produto do catálogo ("PS CRISTAL B").
- **FR-005**: O sistema MUST NOT sugerir PC de fornecedor ACXE com valor total abaixo de R$ 200 (os PCs-espelho da importação na Q2P).
- **FR-006**: Quando houver mais de um candidato igualmente compatível, o sistema MUST mostrar todos e MUST NOT escolher um sozinho.
- **FR-007**: O operador MUST confirmar o PC de cada item antes da conclusão do fiscal, inclusive o que veio do OMIE, podendo trocá-lo por outro candidato. Nenhum vínculo é gravado nem mantido sem confirmação, e a troca de um vínculo do OMIE MUST ficar registrada com o PC original e o escolhido. A justificativa MUST ser exigida quando o PC confirmado estiver fora da tolerância do FR-002, qualquer que seja a origem (vínculo do OMIE, candidato ou escolha manual), e quando o operador trocar o vínculo do OMIE.
- **FR-008**: A lista de candidatos MUST vir da cópia local dos PCs do OMIE, sem consultar o OMIE a cada abertura da fila ou do detalhe (mesmo princípio da fila atual).
- **FR-009**: Na confirmação, o sistema MUST reler no OMIE cada PC escolhido e o recebimento da NF. MUST recusar o vínculo, mostrando a situação atual, se o PC não estiver mais na etapa 15, não tiver o item, for de outro fornecedor ou não tiver saldo para o item, descontadas as reservas de outras NFs em andamento. MUST recusar também quando o vínculo vivo no recebimento for diferente do que a tela mostrou (informado na confirmação) e diferente do PC escolhido. Vínculo vivo igual ao PC escolhido nunca é conflito.

**Recebimento fiscal com vínculo**

- **FR-010**: Ao confirmar o recebimento de uma NF com fiscal pendente e PC confirmado, o sistema MUST concluir o recebimento fiscal no OMIE com cada item vinculado ao item de PC confirmado, **antes** de lançar qualquer entrada de estoque (mesma ordem da 016).
- **FR-011**: O recebimento fiscal com vínculo MUST: gerar a conta a pagar da NF; deixar cada item vinculado ao item de PC confirmado; NOT gerar movimento de estoque no OMIE, mesmo que o recebimento tenha chegado com "não movimentar estoque" desligado (caso da NF 7813). [Confirmado no teste da NF 7813, em 21/10/2026, para o vínculo que já veio do OMIE: `AlterarRecebimento` `EDITAR` com `itensAjustes {cNaoGerarMovEstoque:'S', cNaoGerarFinanceiro:'N'}` manteve o vínculo, e o `ConcluirRecebimento` `cEtapa '60'` concluiu sem movimentar estoque (saldo do produto no local ficou igual) e gerou a conta a pagar. Falta testar a gravação de um vínculo novo (`ASSOCIAR-PEDIDO`) junto com o "não movimentar estoque". Efeito colateral esperado: a descrição do item passou a ser a do produto do PC ("PS CRISTAL B" no lugar de "SUCATA PLASTICO").]
- **FR-011a**: O sistema MUST NOT ignorar (desfazer o vínculo de) um item que tem PC associado no OMIE. Se o operador escolher outro PC, o vínculo MUST ser trocado pelo novo (FR-007), nunca desfeito. Se o vínculo do OMIE não servir e não houver outro PC possível, o recebimento da NF MUST ser recusado, nos dois modos do FR-020. A receita da feature 016 ("Ignorar") continua valendo só para itens sem PC possível, no modo "receber sem vínculo".
- **FR-012**: Depois da conclusão, o PC MUST refletir a quantidade recebida do item. [Confirmado no teste da NF 7813, em 21/10/2026: o OMIE faz isso sozinho ao concluir (`nQtdeRec` 0 → 18.000 no PC 304), e o Atlas não precisa ajustar a quantidade do PC. A etapa do PC não mudou na hora (continuou 15).]
- **FR-013**: Antes de concluir, o sistema MUST verificar no OMIE se a NF já está com o fiscal concluído ou com o vínculo feito, e MUST NOT repetir o que já foi feito (estende o FR-011 da 016).
- **FR-014**: Se o vínculo ou a conclusão falhar, o sistema MUST NOT lançar entrada de estoque daquela NF e MUST informar o operador com mensagem que identifique a NF, o fornecedor e o PC, sem códigos internos do OMIE (ACXEGDP-313).
- **FR-015**: Repetir o clique ou reenviar o recebimento MUST NOT vincular, concluir o fiscal, registrar recebimento no PC nem lançar estoque mais de uma vez.
- **FR-016**: A troca da descrição do item no OMIE depois do vínculo MUST NOT devolver à fila uma NF já recebida. O item é reconhecido pela sequência na NF (ACXEGDP-412).
- **FR-017**: O recebimento físico (correlação item → produtos, 1 item → N produtos, divergência com motivo e aprovação do gestor, NF recebida por inteiro, entrada de estoque) MUST permanecer como nas features 015 e 016. O produto do PC pode ser mostrado como referência, mas não substitui a correlação.
- **FR-018**: A rejeição do gestor MUST NOT desfazer o fiscal nem o vínculo. A NF volta à fila como "fiscal já feito", como na 016.

**NF sem PC e NF com fiscal já feito**

**PC possível** de um item é: o vínculo do OMIE, exceto quando aponta para PC-espelho da importação ou para PC cancelado ou excluído (alerta de etapa ou de saldo não o exclui; a releitura decide); um candidato dentro da tolerância (FR-002); ou outro PC do mesmo fornecedor na etapa 15 e com saldo, por escolha manual com justificativa (FR-002a). PC na etapa 10 não é possível (FR-002b), nem PC-espelho da importação (FR-005).

- **FR-019**: Quando um item não tiver PC possível, o detalhe MUST dizer isso e o motivo (fornecedor sem PC aprovado com saldo, ou só PC aguardando aprovação).
- **FR-020**: A regra para NF com item sem PC possível MUST ser configurável por variável de ambiente, com dois modos, e só vale quando o fiscal é feito pelo Atlas (chave da 016 ligada e fiscal pendente). **Bloquear (padrão):** o recebimento da NF inteira é recusado com "aguardando PC de compras", e a NF continua na fila. **Receber sem vínculo:** os itens sem PC possível seguem a receita da 016 ("Ignorar"). Nos dois modos, compras MUST ser avisado com a NF, o fornecedor e o item. Item **com** PC possível e sem PC escolhido MUST ser recusado pedindo a escolha; ele nunca é tratado como "sem PC".
- **FR-021**: Para NFs com fiscal já feito no portal, o detalhe MUST mostrar o PC vinculado a cada item, quando houver, e o recebimento MUST fazer só a entrada de estoque.
- **FR-021a**: Quando o fiscal tiver sido concluído fora do Atlas com movimento de estoque no OMIE (item recebido, não ignorado e sem "não movimentar estoque"), o sistema MUST bloquear a entrada física da NF e MUST mostrar ao operador que o estoque já entrou pelo OMIE e que o fiscal precisa ser acionado. A informação vem da cópia local dos recebimentos de NF-e e, quando ela não tem a NF ou está atrás, da leitura ao vivo do recebimento. Isso inclui a NF que a tela mostrava com fiscal pendente e que o fiscal concluiu no portal antes da confirmação.

**Importação e rastreabilidade**

- **FR-022**: A feature MUST NOT alterar a baixa do PC Q2P de importação (ACXEGDP-344) nem os PCs-espelho da importação.
- **FR-023**: O sistema MUST registrar, por item de NF, os PCs sugeridos, o PC confirmado, quem confirmou e quando, e o resultado do vínculo e da conclusão, de forma auditável.
- **FR-024**: O recebimento fiscal com vínculo MUST poder ser desligado por configuração. Desligado, vale o comportamento da contenção: a fila mostra só NFs com fiscal já feito e o Atlas faz só o físico. A chave é a mesma da feature 016 (`STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED`).

**Frescor da cópia local de PCs**

- **FR-030**: O sistema MUST alertar a operação quando a cópia local de PCs estiver defasada além do limite configurado. Defasada, ela MUST NOT ser usada para recusar NF por falta de PC nem para avisar compras: o recebimento com fiscal pendente MUST ser recusado com "lista de pedidos de compra desatualizada", sem gravar nada (Princípio II, monitoramento das tabelas críticas).

**Compra nacional pela ACXE (User Story 5)**

- **FR-025**: A fila de recebimento nacional MUST incluir as NFs de compra nacional da ACXE, com fiscal pendente e já feito, identificadas pela empresa, com os mesmos critérios de elegibilidade da Q2P.
- **FR-026**: As NFs emitidas pela Q2P para a ACXE (intercompany) MUST NOT aparecer na fila da ACXE.
- **FR-027**: O fiscal e o vínculo com o PC de uma NF da ACXE MUST seguir os FR-001 a FR-018 no OMIE da ACXE.
- **FR-028**: No recebimento físico de uma NF nacional da ACXE, o sistema MUST oferecer os mesmos locais do recebimento de importação (todos espelhados, inclusive o 21.1 EXTREMA), com a mesma aprovação de divergência, e a entrada MUST ser lançada na ACXE e no local correlato da Q2P. Não há entrada só na ACXE. A entrada MUST usar o mesmo valor nas duas empresas: o valor do item na NF. Ela MUST NOT aplicar o acréscimo interno de 14,5% que a importação usa hoje na entrada da Q2P (`ceil(vNF / kg × 1,145)`). Como a compra nacional não tem trânsito, o lado ACXE é uma entrada, não uma transferência.
- **FR-029**: A compra nacional pela ACXE MUST NOT gerar baixa de PC na Q2P. Não existe PC correspondente lá, porque o n8n de espelhamento de PCs (`RDa9ilL3tbx5ETIk`, filtro da ACXEGDP-376) só copia PC de fornecedor estrangeiro. A baixa da ACXEGDP-344 continua só para a importação.

### Key Entities

- **PC aberto (cópia local)**: pedido de compra do OMIE com saldo a receber. Atributos: empresa, número, fornecedor, etapa, itens (produto, quantidade pedida, quantidade recebida, preço unitário), data e atualização. Fonte: cópia local mantida pelo n8n, atualizada de hora em hora e a cada alteração de PC.
- **Vínculo do OMIE**: associação item de NF → item de PC que o recebimento da NF-e já traz do OMIE, junto com o número do pedido informado na NF. É a sugestão principal do item. Fonte: cópia local dos recebimentos de NF-e, que ainda precisa ganhar essas colunas.
- **Sugestão de PC por item**: para um item de NF, o vínculo do OMIE, ou, sem ele, os PCs candidatos em ordem, com o motivo de cada um (número do pedido na NF, quantidade e preço compatíveis) ou o motivo de não haver candidato.
- **Vínculo confirmado**: item de NF (chave de acesso + sequência) → item de PC, com quem confirmou, quando, a situação do PC relida na confirmação e o resultado no OMIE.
- **Registro da conclusão fiscal** (existente, 016): estendido para indicar o vínculo com PC.
- **Recebimento físico** (existente, 015/016): movimentação de estoque por item → produto(s), com aprovação quando há divergência. Na compra pela ACXE, lançada nas duas empresas, no local espelhado escolhido.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% das NFs nacionais com PC recebidas pelo Atlas terminam com o item vinculado ao PC no OMIE e com o PC mostrando a quantidade recebida. Nenhum PC fica aberto por recebimento feito pelo Atlas.
- **SC-002**: Zero movimentos de estoque gerados pelo fiscal com vínculo. O estoque dessas NFs entra uma única vez, pelo Atlas.
- **SC-003**: Em pelo menos 90% dos itens com PC, o PC confirmado pelo operador é o primeiro da sugestão (vínculo do OMIE ou primeiro candidato).
- **SC-003a**: Zero itens com PC associado no OMIE que o Atlas conclui sem vínculo.
- **SC-004**: O operador conclui sugestão, vínculo, fiscal e físico de uma NF sem sair do StockBridge.
- **SC-005**: Zero PCs-espelho da importação sugeridos, e nenhuma regressão na baixa do PC Q2P de importação (nenhum "sem saldo" atribuível à feature).
- **SC-006**: Zero NFs recebidas pelo Atlas que voltam à fila por troca de descrição depois do vínculo.
- **SC-007**: Depois da ativação, o fiscal deixa de concluir no portal as NFs nacionais com PC, salvo exceções registradas. A contenção de 21/10/2026 pode ser encerrada.
- **SC-008** (User Story 5): toda NF nacional da ACXE recebida pelo Atlas gera entrada nas duas empresas, no mesmo local espelhado, sem divergência nova na Conferência de Estoque ACXE×Q2P.
- **SC-009**: Zero NFs com estoque lançado duas vezes (pelo OMIE no portal e pelo Atlas).

## Assumptions

- Até a ativação vale a contenção de 21/10/2026: recebimento fiscal pelo Atlas desligado em PROD, fiscal concluindo no portal (vinculando o PC e marcando "não movimentar estoque") e o Atlas fazendo só o físico.
- O vínculo de item da NF a item de PC existe na API do OMIE. O teste controlado da NF 7813 da Replas (21/10/2026) validou o caminho para o vínculo que já vem do OMIE. A gravação de um vínculo novo (`ASSOCIAR-PEDIDO`) ainda precisa de teste com uma NF real sem vínculo.
- O OMIE pode trazer o item já associado ao PC no recebimento da NF-e (NF 7813 → PC 304). Ainda não se sabe se faz isso sozinho, pelo número do pedido que o fornecedor informa na NF, ou se alguém associou no portal. Em qualquer caso, o vínculo existente é tratado como sugestão principal (FR-000).
- A etapa do PC não pode ser alterada pela API do OMIE. Não é preciso: o OMIE registra sozinho a quantidade recebida no PC ao concluir (teste da NF 7813).
- A escrita no OMIE para o vínculo entra na exceção ao Princípio II já documentada para o recebimento de NF-e (feature 016); a ação nova é documentada no plano.
- Cada item da NF corresponde a um único item de PC.
- Os PCs nacionais são lançados por compras na empresa que compra (Q2P ou ACXE) e não têm a observação "Pedido original ACXE", que marca os PCs-espelho da importação.
- O operador que hoje faz o recebimento confirma o PC; não há novo papel de usuário.
- As Histórias 1 a 4 (Q2P) vêm antes da História 5 (ACXE), que pode ser entregue numa fase separada.

## Dependencies

- **Cópia local de PCs com atualização frequente**: Rev 1.5 do n8n "ACXE e Q2P - Exporta Dados de Materiais a chegar" (`qPJFEIY1PQ2LDQG2`), **no ar desde 21/10/2026 às 18h05**. A troca é atômica, num statement só (não troca se a carga vier vazia, abaixo de 50% da atual ou mais velha que a da tabela). Entram os PCs pendentes e os recebidos parcialmente, sem filtro de valor. A cópia atualiza a cada aviso `CompraProduto.*` das duas empresas (filas `acxe_matriz_compras_03` e `q2p_matriz_compras_01`), e uma agenda de 10 em 10 min sincroniza se houver aviso pendente ou se passar 55 min sem sync. Há uma trava em `tbl_sync_debounce`, com 90 s entre o fim de um sync e o início do próximo. PC recebido por inteiro sai da cópia; PC recebido em parte fica com `nqtderec > 0`.
- **Leitores da cópia de PCs que usam a quantidade cheia** (`nqtde` em vez de `nqtde - nqtderec`), todos sobre `tbl_pedidosCompras_ACXE`. Hoje não há PC recebido em parte em nenhuma das empresas, mas com a Rev 1.5 um parcial passa a ficar na cópia e seria contado cheio. `cockpit.service.ts` e `pendencias-fiscais.service.ts` são corrigidos nesta feature. A função `refresh_lotes_em_transito_se_stale` (migration 0037, trânsito por FUP) também usa `nqtde`, mas fica como está: ela é PL/pgSQL que escreve em `stockbridge.lote`, e reeditá-la reforçaria um desvio ao Princípio III. A limitação fica registrada para um card próprio, que leva o trânsito para TypeScript. A baixa da ACXEGDP-344 não é afetada: ela só usa PCs com "Pedido original ACXE" casando com a NF.
- **Colunas de pedido na cópia local dos recebimentos de NF-e** (n8n "Q2P - Exporta Recebimentos NF-e", tabela `tbl_recebimentoNFe_itens_Q2P`): PC e item do PC associados ao item, se o item está associado, e número e item do pedido informados na NF. Hoje a cópia não traz nada disso, e é pré-requisito do FR-000, do FR-003, do FR-011a, do FR-013 e do FR-021.
- **Teste controlado na NF 7813 da Replas**: feito em 21/10/2026 (n8n `CA0PlrtFkzcdQlpM`), validou FR-011 e FR-012 para o vínculo que vem do OMIE. Falta um teste com NF sem vínculo (gravar o vínculo pela API) e um com NF menor que o PC.
- **Features 015, 016 e ACXEGDP-412**: fila, detalhe, recebimento físico, recebimento fiscal, dispensa e reconhecimento do item pela sequência, que esta feature estende.
- **ACXEGDP-344**: baixa do PC Q2P de importação, que não pode ser afetada.
- **User Story 5**: cópias locais de NF e de recebimentos de NF-e da ACXE (n8n novo, no padrão das da Q2P) e o mapa de locais espelhados da Conferência de Estoque (feature 011).

## Out of Scope

- Corrigir as NFs já concluídas sem vínculo antes da feature (7614, 7633, 7736, 67913 e outras). É tratamento operacional caso a caso, com compras e o fiscal. Situação dos PCs em 21/10/2026 à noite: o 302 e o 303 estão "Encerrados" (sem recebimento), e o 304 está "Recebido", pelo teste da NF 7813.
- Alterar a etapa do PC pelo Atlas.
- Criar ou alterar PC pelo Atlas, além do registro de quantidade recebida (FR-012), se o teste mostrar que ele é necessário.
- Mudar a baixa do PC Q2P de importação (ACXEGDP-344).
- Recebimento de importação.
- A atualização frequente da cópia local de PCs, que é trabalho do n8n listado em Dependências.
