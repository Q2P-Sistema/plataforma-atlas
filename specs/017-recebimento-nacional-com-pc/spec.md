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

**O que o teste já mostrou e o que falta.** O teste controlado na NF 7813, em 21/10/2026, confirmou o caminho para o item que já chega vinculado: marcar "não movimentar estoque" mantém o vínculo, a conclusão gera a conta a pagar sem movimentar estoque, e o próprio OMIE registra a quantidade recebida no PC. Em 22/10/2026, o teste T033 com a NF 60199 da Zaraplast confirmou a gravação de um vínculo novo pela API (`ASSOCIAR-PEDIDO`), inclusive com PC de outro cadastro do mesmo fornecedor. Falta só a troca de um vínculo existente, para quando houver NF. A NF menor que o saldo do PC foi confirmada em 23/10/2026 pela NF 67988: o OMIE aceita, e o PC fica "recebido parcialmente", com o saldo em aberto (research D20).

**Estreia em PROD e o que ela mostrou (22/10/2026).** Depois do T033, a chave `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` foi religada em PROD (~14h50) e a NF 60199 foi a primeira recebida pelo Atlas com vínculo: fiscal concluído com os 4 vínculos mantidos, 3 entradas físicas, aprovadas. A estreia trouxe quatro ajustes, todos aprovados pelo usuário:

- **O OMIE baixa o PC na unidade da NF, sem converter.** A NF em toneladas baixou o PC 306, em kg, com 8,25 / 13,75 / 5,5 em vez de 8.250 / 13.750 / 5.500. O usuário corrigiu no portal. O Atlas passa a bloquear PC em unidade diferente da NF, e a conversão fica atrás de chave, a validar (FR-031).
- **O PC some da lista de pendentes** quando ganha item associado a um recebimento aberto, e o detalhe ficou sem número, sem saldo e sem candidato para os outros itens. O Atlas passa a guardar a última versão que viu de cada PC (FR-033).
- **O PC da matriz serve à NF da filial.** O Atlas passa a oferecer PC de outro cadastro com a mesma raiz de CNPJ (FR-002).
- **Escolher o PC item por item é repetitivo.** Na NF 60199 foram 3 confirmações e 3 justificativas iguais. A escolha passa a ser uma por nota (FR-032).

**Reversão no portal (25/10/2026).** O Atlas concluiu o fiscal da NF 19252 (Zaraplast × PC 308) às 17:02, e o usuário reverteu o recebimento no portal do OMIE às 17:13, depois de o gestor rejeitar a entrada física. O Atlas não percebeu: a fila seguiu mostrando "fiscal já feito", e o clique seguinte teria feito só o físico, deixando a NF na etapa 40, sem conta a pagar e sem baixa no PC. O Atlas passa a perceber a reversão (FR-035, research D21 da 017).

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

### Session 2026-10-23

- Q: Quando o peso conferido passa da NF, o PC deve ser baixado pelo peso da balança? → A: **Sim, só a mais e com teto no saldo do PC**, atrás de chave desligada, com o primeiro uso acompanhado (FR-034). Evidência: NF 67988 × PC 305, em que o OMIE baixou o PC pela NF e deixou 118 kg em aberto até o fiscal corrigir no portal.
- Q: O fiscal pode ir para depois da aprovação do gestor? → A: **Não.** O fiscal continua no clique do operador. Se o gestor rejeitar uma entrada cujo PC já foi baixado pelo peso conferido, compras é avisado por e-mail.

### Session 2026-10-22

Pedidos do usuário depois da estreia da NF 60199 (Zaraplast × PC 306) em PROD, todos aprovados:

- Q: O operador escolhe o PC item por item ou uma vez por NF? → A: **Uma vez por NF.** O servidor oferece os PCs que atendem a nota, com a atribuição item da NF → item do PC; a tela aplica a escolha em todos os itens, com uma confirmação e uma justificativa por nota. O POST continua por item (FR-032).
- Q: PC lançado em outro cadastro do mesmo fornecedor (matriz × filial) pode ser sugerido? → A: **Sim**, depois do T033, que mostrou o `ASSOCIAR-PEDIDO` aceito entre cadastros com a mesma raiz de CNPJ. Muda o FR-002 (a): "mesmo fornecedor" passa a incluir o outro cadastro com a mesma raiz.
- Q: Como tratar PC em unidade diferente da NF (toneladas × kg)? → A: **Bloquear por padrão**, com a conversão (`itensAjustes.nQtdeRecebida` na unidade do PC) atrás de chave, a ligar só depois de teste com NF real (FR-031). Evidência: o OMIE baixou o PC 306 com a quantidade na unidade da NF, e o usuário corrigiu no portal editando a quantidade recebida de cada item.
- Q: O que mostrar quando o PC sai da lista de pendentes por ter item associado a um recebimento aberto? → A: **O número e o saldo da última vez em que o Atlas viu o PC**, vindos de um cache (migration 0057), com alerta de que a confirmação confere o saldo ao vivo (FR-033). Ler o OMIE ao vivo no detalhe foi descartado (Princípio II).
- Q: Onde a compra nacional da ACXE dá entrada no estoque? (Fase 2, depois de ver os dados de PROD: de jul/2025 a out/2026, 50 NFs nacionais da ACXE entraram no 20.0.7 PRODUÇÃO, 1 no 20.0.5 PROCESSO, 3 no 21.2 e só 4, de 2025, no 21.1; o PC 580, primeiro PC nacional da ACXE, aponta para o 20.0.7) → A: **O operador escolhe, e o PC sugere.** A lista traz os locais que também são da Q2P (11.1, 12.1, 21.1, 31.1), com entrada na ACXE e na Q2P pelo mesmo valor, e os locais só da ACXE onde ela compra hoje (20.0.7 PRODUÇÃO, 20.0.5 PROCESSO, 21.2 EXTREMA NACIONAL), com entrada só na ACXE. O local do PC vem marcado. Substitui a decisão de 21/10 ("sempre nas duas empresas, nunca só na ACXE"), que tinha sido tomada sem compra nacional da ACXE à vista (FR-028 revisado, research D18).

### Session 2026-10-25

- Q: O Atlas deve perceber que o recebimento fiscal que ele concluiu foi revertido no portal do OMIE? → A: **Sim.** A NF volta à fila como "fiscal pendente", com o selo "Fiscal revertido no OMIE", e o clique do operador conclui o fiscal de novo, com o PC confirmado. O Atlas percebe pelo espelho de recebimentos (comparando horas de evento do OMIE) e, no clique, por uma leitura ao vivo do recebimento (FR-035). Evidência: NF 19252 × PC 308, concluída às 17:02 e revertida no portal às 17:13 de 25/10/2026, com a fila ainda mostrando "fiscal já feito".
- Q: E se a entrada física da NF já foi lançada no Atlas? → A: A NF não volta à fila (já foi recebida), e o **fiscal é avisado por e-mail** para concluir o recebimento de novo no portal, sem movimentar estoque (o estoque entra pela aprovação no Atlas) e conferindo o vínculo com o PC.
- Q: O Atlas passa a reverter o recebimento no OMIE? → A: **Não.** Reverter continua fora do escopo (016, decisão de 02/10/2026). O Atlas só detecta a reversão feita no portal e refaz a conclusão no clique do operador.
- Q: E o fiscal que reverte de propósito para corrigir a nota (reverter, editar, concluir, como na NF 60199)? → A: Enquanto ele edita, a NF aparece como "Fiscal revertido no OMIE", com o aviso de que, se a reversão foi feita para corrigir a nota, o operador deve falar com o fiscal antes de dar entrada. Quando o fiscal conclui de novo no portal, a NF volta a "fiscal já feito".
- Q: A rejeição do gestor também conta como reversão? → A: **Não** (FR-018). Só a reversão feita no OMIE marca a NF.
- Q: Chave própria? → A: Sim, além da chave da 016: `STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED`, ligada por padrão, para desligar o tratamento sem redeploy de código.

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
8. **Given** uma NF de vários itens cujo PC é um só (caso real: NF 60199, 4 itens, PC 306 com 3 itens), **When** o operador abre o detalhe, **Then** a tela lista os PCs que atendem a nota, com o item do PC atribuído a cada item da NF, e o operador escolhe o PC uma vez e informa uma só justificativa, quando exigida. Duas linhas da NF podem ficar no mesmo item do PC.
9. **Given** um PC lançado em outro cadastro do mesmo fornecedor, com a mesma raiz de CNPJ (caso real: NF 60199 da filial, PC 306 da matriz), **When** o operador abre o detalhe, **Then** o PC é oferecido, marcado como "outro cadastro do fornecedor" com o CNPJ do cadastro do PC.
10. **Given** o vínculo do OMIE aponta para um PC que saiu da lista de pendentes por ter item associado a um recebimento aberto, **When** o operador abre o detalhe, **Then** o PC aparece com o número e os dados da última sincronização em que foi visto, com o alerta de que a confirmação confere o saldo ao vivo, e os demais itens da NF continuam podendo escolhê-lo.

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
5. **Given** uma NF em toneladas e um único PC aprovado em kg, no modo `bloquear` (padrão), **When** o operador abre o detalhe, **Then** o PC aparece como "em unidade diferente da nota", não selecionável, e o item é tratado como sem PC possível. **When** ele tenta receber, **Then** o recebimento é recusado (`NF_SEM_PC`) e compras recebe o aviso com o quadro "Pedido em unidade diferente da nota", pedindo o pedido na unidade da nota.

---

### User Story 4 - Falhas, repetições e rejeições não deixam NF nem PC inconsistentes (Priority: P2)

O vínculo acrescenta escritas ao clique. Qualquer uma pode falhar, o operador pode clicar duas vezes, e o gestor pode rejeitar um recebimento com divergência depois de o fiscal e o vínculo já estarem feitos. O fiscal ainda pode reverter no portal o recebimento que o Atlas concluiu (NF 19252, 25/10/2026). Em todos os casos a NF e o PC precisam acabar num estado conhecido, e nada pode ser vinculado, recebido no PC ou lançado em estoque duas vezes.

**Why this priority**: mesmo motivo da História 3 da feature 016. Sem isto, um problema visível (PC aberto) vira um invisível (PC recebido duas vezes, ou fiscal concluído com o vínculo errado).

**Independent Test**: simular cada falha (vínculo recusado, conclusão recusada depois do vínculo, falha do estoque depois do fiscal, clique repetido, rejeição do gestor, reversão no portal) e verificar o estado da NF e do PC no OMIE e da NF no Atlas.

**Acceptance Scenarios**:

1. **Given** uma NF com fiscal pendente, **When** o vínculo ou a conclusão do fiscal falha, **Then** nenhuma entrada de estoque é lançada, o operador vê uma mensagem que identifica a NF, o fornecedor e o PC (nunca códigos internos do OMIE) e pode tentar de novo.
2. **Given** um vínculo já gravado no OMIE e a conclusão do fiscal ainda não feita, **When** o operador tenta de novo, **Then** o Atlas reconhece o vínculo existente, não o refaz e segue para a conclusão.
3. **Given** o fiscal concluído com vínculo e o estoque com falha, **When** a NF volta à fila, **Then** ela aparece como "fiscal já feito", com o PC vinculado à vista, e o novo recebimento faz só o estoque.
4. **Given** um recebimento com divergência de peso (fiscal e vínculo já feitos), **When** o gestor rejeita, **Then** o fiscal e o vínculo **não** são desfeitos, e a NF volta à fila como "fiscal já feito", como na 016.
5. **Given** o operador confirma duas vezes, **When** o Atlas processa, **Then** o vínculo, a conclusão do fiscal e o estoque acontecem uma única vez cada.
6. **Given** o fiscal concluído pelo Atlas e revertido depois no portal do OMIE (caso real: NF 19252 × PC 308, concluída às 17:02 e revertida às 17:13 de 25/10/2026), **When** o espelho de recebimentos mostra o recebimento pendente depois da conclusão, ou o operador tenta dar entrada antes disso, **Then** a NF volta à fila como "fiscal pendente", com o selo "Fiscal revertido no OMIE"; o clique antes de o espelho atualizar responde `409 RECEBIMENTO_FISCAL_REVERTIDO` sem gravar nada, e o recebimento seguinte conclui o fiscal de novo, com o PC confirmado (o OMIE manteve o vínculo, o "não movimentar estoque" e as quantidades; o PC volta a mostrar o recebido ao fim).
7. **Given** o fiscal revertido no portal e a entrada física da NF já lançada no Atlas (pendente de aprovação ou aprovada), **When** o Atlas percebe a reversão, **Then** a NF não volta à fila e o fiscal recebe um e-mail para concluir o recebimento de novo no portal, sem movimentar estoque; o Atlas não faz nenhuma escrita no OMIE.

---

### User Story 5 - Compra nacional pela ACXE (Priority: P3)

A compra nacional também pode ser feita pela ACXE. A NF e o PC chegam só ao OMIE da ACXE, e o fiscal é feito na ACXE. O operador recebe essa NF pela mesma fila, com o mesmo fluxo de sugestão e confirmação do PC. No recebimento físico, o operador escolhe o local, com o local do PC já marcado: num local que também é da Q2P (11.1, 12.1, 21.1, 31.1) a entrada é lançada na ACXE e na Q2P, pelo mesmo valor; num local só da ACXE (20.0.7 PRODUÇÃO, 20.0.5 PROCESSO, 21.2 EXTREMA NACIONAL) a entrada é lançada só na ACXE. A matéria-prima de produção da ACXE (hoje quase toda no 20.0.7) não aparece no estoque de venda da Q2P. Quando o material chega a Extrema para venda, o local é o 21.1 EXTREMA, e o estoque também aparece na Q2P (revisão de 22/10/2026, research D18).

**Why this priority**: hoje ainda não há PC de fornecedor nacional na ACXE (21/10/2026), e as Histórias 1 a 4 resolvem o caso que já está acontecendo na Q2P. Fica para uma fase posterior.

**Independent Test**: receber pelo Atlas uma NF nacional da ACXE com PC da ACXE no local do PC (ex.: PC 580 → 20.0.7 PRODUÇÃO) e verificar: o fiscal foi concluído na ACXE com o vínculo e sem estoque pelo OMIE; na aprovação, a entrada foi lançada só na ACXE, no 20.0.7. Repetir num local que também é da Q2P (21.1 EXTREMA) e verificar a entrada nas duas empresas, nos locais 21.1 de cada uma, com o mesmo valor unitário, e nenhuma divergência nova na Conferência de Estoque ACXE×Q2P.

**Acceptance Scenarios**:

1. **Given** uma NF de compra nacional da ACXE com fiscal pendente, **When** o operador abre a fila, **Then** a NF aparece identificada como da ACXE, com o mesmo tratamento das NFs da Q2P.
2. **Given** essa NF com o PC da ACXE confirmado e um local que também é da Q2P escolhido, **When** o operador confirma o recebimento e o gestor aprova, **Then** o fiscal é concluído no OMIE da ACXE com o vínculo e sem movimento de estoque, e a entrada de estoque é lançada na ACXE e na Q2P, no par de locais correspondente, com o mesmo valor unitário.
2a. **Given** essa NF com o local do PC num local só da ACXE (20.0.7 PRODUÇÃO), **When** o operador confirma sem trocar o local e o gestor aprova, **Then** a entrada é lançada só na ACXE, no 20.0.7.
2b. **Given** um produto da ACXE sem produto de mesma descrição na Q2P, **When** o operador escolhe um local que também é da Q2P, **Then** a tela e o servidor recusam a combinação antes do fiscal e orientam a escolher um local só da ACXE ou pedir o cadastro do produto na Q2P.
3. **Given** essa NF com o material chegando a Extrema (local 21.1 EXTREMA), **When** o operador confirma o recebimento, **Then** a entrada de estoque é lançada no 21.1 da ACXE e no 21.1 da Q2P, e o produto fica disponível para venda pela Q2P.
4. **Given** uma NF emitida pela Q2P para a ACXE (intercompany), **When** a fila da ACXE é montada, **Then** essa NF não aparece, assim como a ACXE não aparece como fornecedor na fila da Q2P.
5. **Given** a compra nacional pela ACXE, **When** o recebimento é concluído, **Then** nenhuma baixa de PC é feita na Q2P. Não existe PC correspondente lá: o n8n de espelhamento só copia PC de fornecedor estrangeiro (ACXEGDP-376).

---

### Edge Cases

- **Dois PCs iguais do mesmo fornecedor** (PCs 302 e 304: mesma quantidade e preço): o sistema mostra os dois e não escolhe sozinho. O número do pedido na NF, quando vier, desempata.
- **PC lançado em outro cadastro do mesmo fornecedor** (caso real de 22/10/2026: NF 60199 da Zaraplast emitida pela filial, PC 306 lançado no cadastro da matriz): o PC é oferecido, com a marcação "outro cadastro do fornecedor" e o CNPJ do cadastro do PC, porque o T033 mostrou o `ASSOCIAR-PEDIDO` aceito entre cadastros com a mesma raiz de CNPJ (FR-002). PC de cadastro com raiz diferente é de outro fornecedor e não é oferecido. A troca de um vínculo existente entre cadastros não foi testada.
- **PC lançado com o preço com IPI** (PC 306: R$ 10,80/kg, igual ao valor do item com IPI por kg da NF 60199): a tolerância de preço compara o PC com o preço da NF com e sem tributos, e vale o mais próximo.
- **Item que o Atlas não recebe por unidade** (unidade não convertida para kg) **e sem PC no OMIE**, numa NF com outros itens a receber: como o recebimento fiscal é da NF inteira, no modo bloquear a NF é recusada com orientação ao fiscal (corrigir a unidade ou concluir no portal, vinculando o pedido); no modo "receber sem vínculo" o item é concluído sem PC e compras é avisado.
- **NF menor que o PC** (NF 67913: 13.440 kg de um PC de 13.500 kg): o PC fica com saldo de 60 kg. [Confirmado em 23/10/2026 pela NF 67988 contra o PC 305 (13.382 kg de um PC de 13.500 kg): o OMIE aceita, e o PC continua aberto, "recebido parcialmente" na etapa 15, com o saldo.] O PC com saldo continua elegível para a próxima NF enquanto o saldo for compatível.
- **NF maior que o saldo do PC**: até 2% acima do saldo, o PC é sugerido normalmente. Acima disso, o PC não é sugerido; o operador ainda pode escolhê-lo à mão, com justificativa (FR-002a). Se nenhum PC puder ser escolhido, vale a regra de NF sem PC (User Story 3).
- **NF com itens de PCs diferentes, ou um PC com vários itens**: cada item da NF é vinculado a um único item de PC. Com um PC só (NF 60199 × PC 306), o operador o escolhe uma vez para a nota (FR-032), e duas linhas da NF podem ficar no mesmo item do PC. Itens que não cabem no mesmo PC são resolvidos um a um. Um item da NF **não** pode ser dividido entre dois PCs; esse caso raro o fiscal resolve no portal.
- **PC ainda não aprovado**: só PC na etapa 15 (aprovado) pode ser vinculado. PC na etapa 10 aparece como "PC aguardando aprovação". O PC 304 estava na etapa 10 no espelho das 04:30 de 21/10 e na 15 ao vivo às 18h, por isso a situação relida ao vivo na confirmação prevalece sobre a cópia local.
- **Vínculo do OMIE com PC que não serve** (PC sem saldo, fora da etapa 15, cancelado ou excluído, PC-espelho da importação, ou PC em unidade diferente da NF no modo `bloquear`): o detalhe mostra o vínculo com o alerta do motivo, e o operador troca por outro PC possível. Sem outro PC possível, o recebimento da NF é recusado nos dois modos da regra de NF sem PC: item que veio vinculado no OMIE nunca é ignorado (FR-011a). Alerta de etapa ou de saldo não impede a confirmação, porque a cópia local pode estar atrás (PC 304: etapa 10 no espelho, 15 ao vivo); quem decide é a releitura ao vivo (FR-009).
- **NF com vínculo apagado antes da feature**: a hipótese é que o "Ignorar" da 016 apagou o vínculo da NF 7736 com o PC 302 (não comprovado). Corrigir essas NFs está fora do escopo (ver Out of Scope).
- **PC consumido entre a sugestão e a confirmação** (outra NF vinculada, PC cancelado ou excluído): a releitura ao vivo na confirmação recusa o vínculo e mostra a situação atual. O operador escolhe outro PC ou cai na regra da User Story 3.
- **PC saiu da lista de pendentes** (caso real de 22/10/2026: PC 306 entre a associação e a conclusão da NF 60199): o OMIE tira da lista o PC com item associado a um recebimento aberto, e o PC volta depois, como recebido parcial. Nessa janela o Atlas usa o cache de PCs vistos (FR-033): o vínculo do OMIE mostra o número e os dados da última sincronização, com alerta, e os outros itens da NF ainda podem escolher o PC. Se o PC nunca passou pela cópia (criado e associado entre duas sincronizações), cai no caso de vínculo sem dados locais: manter exige justificativa, e a releitura ao vivo decide.
- **PC em unidade diferente da NF** (NF 60199 em toneladas × PC 306 em kg): o OMIE grava no PC a quantidade recebida na unidade da NF, sem converter (8,25 em vez de 8.250 kg). No modo `bloquear` (padrão), o PC não é oferecido, o vínculo do OMIE nesse caso não pode ser mantido e, sem outro PC, a NF é recusada com aviso a compras (FR-031). No modo `converter`, o Atlas manda a quantidade recebida já na unidade do PC. T, TON e TL contam como a mesma unidade.
- **PC criado depois que a NF chegou**: aparece na sugestão assim que a cópia local de PCs for atualizada (até 1 hora, ou minutos pelo aviso de alteração).
- **Fiscal concluído no portal com vínculo** (o caminho da contenção, ou alguém concluindo por engano): a NF aparece como "fiscal já feito", com o PC vinculado à vista, e o recebimento faz só o estoque. O recebimento associado ao PC chega com "não movimentar estoque" desligado (NF 7813). Se o fiscal concluir no portal sem marcar essa opção, o OMIE lança estoque, e receber pelo Atlas lançaria o estoque em dobro. O Atlas detecta esse caso e bloqueia a entrada física da NF, com mensagem ao operador (FR-021a).
- **Descrição do item trocada pelo vínculo**: não devolve a NF à fila (reconhecimento pela sequência, ACXEGDP-412).
- **PCs-espelho da importação** (fornecedor ACXE, valor abaixo de R$ 200): nunca aparecem na sugestão. A baixa do PC Q2P de importação (ACXEGDP-344) continua igual.
- **Divergência de peso**: o fiscal e o vínculo acontecem no clique, como na 016. A divergência é assunto do físico e da aprovação do gestor.
- **Dispensa de NF** (016): continua valendo. A dispensa não desfaz vínculo nem fiscal no OMIE, e o aviso ao fiscal passa a citar o PC vinculado, quando houver. A dispensa ativa continua tirando a NF da fila mesmo revertida, e o fiscal não recebe o aviso de reversão de NF dispensada (o e-mail da dispensa já o mandou tratar a nota).
- **Fiscal revertido no portal depois de concluído pelo Atlas** (caso real de 25/10/2026: NF 19252 × PC 308, concluída às 17:02 e revertida às 17:13): a reversão devolve o recebimento à etapa 40, desfaz a conta a pagar e o recebido do PC, e mantém o vínculo, o "não movimentar estoque" e as quantidades dos itens. O Atlas compara as horas de evento do OMIE (nunca as de sincronização) e, quando a pendência é posterior à conclusão, a NF volta como "fiscal pendente", com o selo e o aviso (FR-035). O espelho de recebimentos leva até ~30 min para refletir a reversão: nessa janela, o clique de NF cujo fiscal o Atlas concluiu (há pelo menos 75 s) lê o recebimento ao vivo e responde `409 RECEBIMENTO_FISCAL_REVERTIDO`, sem gravar nada. Se a entrada física já foi lançada, a NF não volta à fila e o fiscal é avisado por e-mail. Se o fiscal concluir de novo no portal, a conclusão mais nova desliga o sinal e a NF volta a "fiscal já feito"; sem marcar "não movimentar estoque", vale a trava de estoque já lançado (FR-021a). A nota de entrada no espelho de NF não serve de sinal: o espelho nunca a marca como excluída.
- **Correção do fiscal no portal (reverter, editar, concluir)**, como na NF 60199 (research D15): entre a reversão e a nova conclusão a NF aparece como "Fiscal revertido no OMIE", e o aviso da tela manda o operador falar com o fiscal antes de dar entrada, porque um clique nessa janela faria o Atlas concluir o fiscal em paralelo à correção.
- **Chave de operação desligada**: comportamento da contenção. A fila mostra só NFs com fiscal já feito, e o Atlas faz só o físico. O tratamento do fiscal revertido (FR-035) vale só com a chave ligada, com `STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED` e com a migration 0060; sem isso o ledger `concluido` é final, como na 016.

## Requirements *(mandatory)*

### Functional Requirements

**Sugestão do PC**

- **FR-000**: Quando o item já vier do OMIE associado a um PC (no recebimento da NF-e), o sistema MUST mostrar esse PC como a sugestão do item, identificado como "vínculo do OMIE", com os mesmos dados de qualquer candidato.
- **FR-001**: Para cada item **sem vínculo** de uma NF nacional com fiscal pendente, o sistema MUST sugerir os PCs abertos do mesmo fornecedor, na mesma empresa da NF, que possam corresponder ao item.
- **FR-002**: Um PC só é candidato para um item sem vínculo se: (a) for do mesmo fornecedor da NF, isto é, do mesmo cadastro do OMIE **ou de outro cadastro com a mesma raiz de CNPJ** (matriz × filial; revisto em 22/10/2026, após o T033); (b) estiver na etapa 15 (aprovado); (c) a quantidade do item não passar de 2% acima do saldo a receber do PC (pedido menos recebido); (d) o preço unitário da NF diferir no máximo 1% do preço unitário do PC; (e) estiver na mesma unidade da NF, no modo `bloquear` (FR-031).
- **FR-002a**: Fora da tolerância do FR-002, o operador MAY escolher à mão um PC aberto do mesmo fornecedor, na etapa 15 e com saldo, informando uma justificativa, que MUST ficar registrada junto com o vínculo.
- **FR-002b**: Um PC do fornecedor na etapa 10 MUST aparecer como "PC aguardando aprovação" e MUST NOT poder ser vinculado.
- **FR-002c**: Cada item da NF MUST ser vinculado a um único item de PC. Dividir um item da NF entre dois PCs não é permitido.
- **FR-003**: Quando um item sem vínculo trouxer o número do pedido do comprador informado pelo fornecedor na NF e ele corresponder a um PC candidato, esse PC MUST aparecer em primeiro lugar.
- **FR-004**: A sugestão MUST NOT usar a descrição do item. A NF descreve o material como o fornecedor emite ("SUCATA PLASTICO") e o PC, como o produto do catálogo ("PS CRISTAL B").
- **FR-005**: O sistema MUST NOT sugerir PC de fornecedor ACXE com valor total abaixo de R$ 200 (os PCs-espelho da importação na Q2P).
- **FR-006**: Quando houver mais de um candidato igualmente compatível, o sistema MUST mostrar todos e MUST NOT escolher um sozinho.
- **FR-007**: O operador MUST confirmar o PC de cada item antes da conclusão do fiscal, inclusive o que veio do OMIE, podendo trocá-lo por outro candidato. Nenhum vínculo é gravado nem mantido sem confirmação, e a troca de um vínculo do OMIE MUST ficar registrada com o PC original e o escolhido. A justificativa MUST ser exigida quando o PC confirmado estiver fora da tolerância do FR-002, qualquer que seja a origem (vínculo do OMIE, candidato ou escolha manual), e quando o operador trocar o vínculo do OMIE.
- **FR-008**: A lista de candidatos MUST vir da cópia local dos PCs do OMIE (e, para o PC que saiu dela, do cache de PCs vistos, FR-033), sem consultar o OMIE a cada abertura da fila ou do detalhe (mesmo princípio da fila atual).
- **FR-009**: Na confirmação, o sistema MUST reler no OMIE cada PC escolhido e o recebimento da NF. MUST recusar o vínculo, mostrando a situação atual, se o PC não estiver mais na etapa 15, não tiver o item, for de outro fornecedor (cadastro sem a mesma raiz de CNPJ), estiver em unidade diferente da NF (no modo `bloquear`, FR-031) ou não tiver saldo para o item, descontadas as reservas de outras NFs em andamento. MUST recusar também quando o vínculo vivo no recebimento for diferente do que a tela mostrou (informado na confirmação) e diferente do PC escolhido. Vínculo vivo igual ao PC escolhido nunca é conflito.

**Recebimento fiscal com vínculo**

- **FR-010**: Ao confirmar o recebimento de uma NF com fiscal pendente e PC confirmado, o sistema MUST concluir o recebimento fiscal no OMIE com cada item vinculado ao item de PC confirmado, **antes** de lançar qualquer entrada de estoque (mesma ordem da 016).
- **FR-011**: O recebimento fiscal com vínculo MUST: gerar a conta a pagar da NF; deixar cada item vinculado ao item de PC confirmado; NOT gerar movimento de estoque no OMIE, mesmo que o recebimento tenha chegado com "não movimentar estoque" desligado (caso da NF 7813). [Confirmado no teste da NF 7813, em 21/10/2026, para o vínculo que já veio do OMIE: `AlterarRecebimento` `EDITAR` com `itensAjustes {cNaoGerarMovEstoque:'S', cNaoGerarFinanceiro:'N'}` manteve o vínculo, e o `ConcluirRecebimento` `cEtapa '60'` concluiu sem movimentar estoque (saldo do produto no local ficou igual) e gerou a conta a pagar. A gravação de um vínculo novo (`ASSOCIAR-PEDIDO`) seguida do `EDITAR` com "não movimentar estoque" foi confirmada no T033, em 22/10/2026, na NF 60199 (inclusive com PC de outro cadastro do mesmo fornecedor). Efeito colateral esperado: a descrição do item passou a ser a do produto do PC ("PS CRISTAL B" no lugar de "SUCATA PLASTICO").]
- **FR-011a**: O sistema MUST NOT ignorar (desfazer o vínculo de) um item que tem PC associado no OMIE. Se o operador escolher outro PC, o vínculo MUST ser trocado pelo novo (FR-007), nunca desfeito. Se o vínculo do OMIE não servir e não houver outro PC possível, o recebimento da NF MUST ser recusado, nos dois modos do FR-020. A receita da feature 016 ("Ignorar") continua valendo só para itens sem PC possível, no modo "receber sem vínculo".
- **FR-012**: Depois da conclusão, o PC MUST refletir a quantidade recebida do item. [Confirmado no teste da NF 7813, em 21/10/2026: o OMIE faz isso sozinho ao concluir (`nQtdeRec` 0 → 18.000 no PC 304), e o Atlas não precisa ajustar a quantidade do PC. A etapa do PC não mudou na hora (continuou 15).]
- **FR-013**: Antes de concluir, o sistema MUST verificar no OMIE se a NF já está com o fiscal concluído ou com o vínculo feito, e MUST NOT repetir o que já foi feito (estende o FR-011 da 016).
- **FR-014**: Se o vínculo ou a conclusão falhar, o sistema MUST NOT lançar entrada de estoque daquela NF e MUST informar o operador com mensagem que identifique a NF, o fornecedor e o PC, sem códigos internos do OMIE (ACXEGDP-313).
- **FR-015**: Repetir o clique ou reenviar o recebimento MUST NOT vincular, concluir o fiscal, registrar recebimento no PC nem lançar estoque mais de uma vez.
- **FR-016**: A troca da descrição do item no OMIE depois do vínculo MUST NOT devolver à fila uma NF já recebida. O item é reconhecido pela sequência na NF (ACXEGDP-412).
- **FR-017**: O recebimento físico (correlação item → produtos, 1 item → N produtos, divergência com motivo e aprovação do gestor, NF recebida por inteiro, entrada de estoque) MUST permanecer como nas features 015 e 016. O produto do PC pode ser mostrado como referência, mas não substitui a correlação.
- **FR-018**: A rejeição do gestor MUST NOT desfazer o fiscal nem o vínculo. A NF volta à fila como "fiscal já feito", como na 016. A reversão feita **no portal do OMIE** é outra coisa e é tratada no FR-035.

**NF sem PC e NF com fiscal já feito**

**PC possível** de um item é: o vínculo do OMIE, exceto quando aponta para PC-espelho da importação, para PC cancelado ou excluído ou, no modo `bloquear`, para PC em unidade diferente da NF (alerta de etapa ou de saldo não o exclui; a releitura decide); um candidato dentro da tolerância (FR-002); ou outro PC do mesmo fornecedor na etapa 15, com saldo e na mesma unidade da NF, por escolha manual com justificativa (FR-002a). PC na etapa 10 não é possível (FR-002b), nem PC-espelho da importação (FR-005).

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

**Ajustes pós-estreia (22/10/2026)**

- **FR-031** (trava de unidade): com `STOCKBRIDGE_PC_UNIDADE_DIFERENTE = bloquear` (padrão), o sistema MUST NOT oferecer nem manter o vínculo de um item da NF com PC em unidade diferente da NF (kg × tonelada; T, TON e TL são a mesma unidade): o PC aparece como "em unidade diferente da nota", não selecionável; o vínculo do OMIE nesse caso não pode ser mantido (e, sem outro PC, a NF é recusada nos dois modos do FR-020, como qualquer vínculo que não serve); e a releitura ao vivo recusa. Sem outro PC possível, a NF é recusada como sem PC (FR-020), e compras MUST ser avisado com a orientação de lançar o pedido na unidade da nota. Com `converter`, o sistema MUST gravar no `EDITAR` a quantidade recebida do item já na unidade do PC (`itensAjustes.nQtdeRecebida`); esse modo só é ligado depois de teste com NF real.
- **FR-032** (PC por NF): o detalhe MUST oferecer os PCs que atendem a nota com a atribuição item da NF → item do PC, e a tela MUST permitir escolher o PC uma única vez para a nota inteira, com uma confirmação e, quando exigida, uma só justificativa. O recebimento (POST) MUST continuar por item, com a validação de cada item (FR-007, FR-009) inalterada.
- **FR-034** (baixa do PC pelo peso conferido, research D20): com `STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO` ligada, quando o peso conferido de um item vinculado a PC passar da NF acima da tolerância de 1 kg, o sistema MUST mandar no `EDITAR` do fiscal a quantidade recebida igual ao peso conferido, limitada ao saldo disponível do PC (nunca acima dele; NF que já passa do saldo não leva excedente) e só quando o excedente não passar de `STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT` (padrão 10%) da NF do item. Peso a menos MUST NOT ser mandado. As reservas entre NFs MUST contar o que cada vínculo baixa do PC. Numa nova tentativa da mesma NF, a quantidade que o Atlas mandou antes e que não vale mais MUST voltar à da NF. Se o gestor rejeitar a entrada de um item cujo PC foi baixado acima da nota, o sistema MUST avisar compras por e-mail, deduplicado por item, e MUST tentar de novo se o envio falhar. Com a chave desligada (padrão), o Atlas não manda ao PC quantidade acima da NF; o registro do que o OMIE baixou (`ja_concluido`), a devolução da quantidade da NF na retomada e o aviso na rejeição não dependem da chave.
- **FR-033** (PC fora da lista de pendentes): o sistema MUST guardar a última versão vista de cada item de PC (cache, atualizado só quando algo muda) e, quando a cópia local não trouxer o PC, MUST usar o cache para mostrar o número, o produto e o saldo do vínculo do OMIE e para oferecer o PC aos demais itens, com alerta de que os dados são da última sincronização. Como candidato, o PC do cache vale 7 dias (o PC que saiu da lista por recebimento total, cancelamento ou exclusão não volta); o PC do vínculo do OMIE é lido sempre. A confirmação MUST continuar conferindo o saldo ao vivo (FR-009), sem consulta ao OMIE na abertura do detalhe (FR-008).

**Fiscal revertido no OMIE (25/10/2026, research D21 da 017)**

- **FR-035**: Quando o recebimento fiscal que o Atlas concluiu for revertido no portal do OMIE, o sistema MUST tratá-lo como pendente e MUST NOT desfazer nada no OMIE. (a) A NF MUST voltar à fila como "fiscal pendente", com o selo "Fiscal revertido no OMIE" e, no detalhe, o aviso com a hora da reversão; o clique do operador MUST concluir o fiscal de novo, com o PC confirmado (FR-007, FR-009). (b) A reversão MUST ser percebida comparando horas de evento do OMIE (alteração do recebimento e da nota de entrada, em horário de Brasília) com a conclusão, com margem de 2 minutos para a pendência vinda do espelho; horas de sincronização (`synced_at`) e a presença da nota de entrada no espelho de NF MUST NOT servir de sinal. (c) O clique de NF cujo fiscal o Atlas concluiu há pelo menos 75 s MUST ler o recebimento no OMIE antes de pular o fiscal e, se ele não estiver recebido, MUST marcar a reversão, recusar com `409 RECEBIMENTO_FISCAL_REVERTIDO` e não gravar movimentação, aprovação nem escrita no OMIE. (d) A reversão MUST deixar rastro auditável (ledger `revertido`, com a origem, espelho ou OMIE ao vivo, quando e, na leitura ao vivo, quem), e os vínculos de PC da tentativa revertida MUST sair do saldo e da reserva do PC. (e) A NF revertida com a entrada física já lançada para todos os itens MUST NOT voltar à fila; o fiscal MUST ser avisado por e-mail (uma vez por NF, e não quando há dispensa ativa) para concluir de novo no portal, sem movimentar estoque. Numa NF parcial (entrada de um item rejeitada pelo gestor), o item sem entrada volta à fila como fiscal revertido, e o aviso ao fiscal sai mesmo assim. (f) A rejeição do gestor MUST NOT marcar a reversão (FR-018). (g) O tratamento MUST valer só com a chave da 016 ligada e MUST poder ser desligado por `STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED`, voltando ao comportamento anterior.

**Compra nacional pela ACXE (User Story 5)**

- **FR-025**: A fila de recebimento nacional MUST incluir as NFs de compra nacional da ACXE, com fiscal pendente e já feito, identificadas pela empresa, com os mesmos critérios de elegibilidade da Q2P.
- **FR-026**: As NFs emitidas pela Q2P para a ACXE (intercompany) MUST NOT aparecer na fila da ACXE.
- **FR-027**: O fiscal e o vínculo com o PC de uma NF da ACXE MUST seguir os FR-001 a FR-018 no OMIE da ACXE.
- **FR-028** (revisado em 22/10/2026, research D18): No recebimento físico de uma NF nacional da ACXE, o sistema MUST oferecer como destino (a) os locais que também são da Q2P (11.1, 12.1, 21.1, 31.1), com entrada na ACXE e no local correspondente da Q2P, e (b) os locais só da ACXE onde ela compra (20.0.7 PRODUÇÃO, 20.0.5 PROCESSO, 21.2 EXTREMA NACIONAL), com entrada só na ACXE, com a mesma aprovação de divergência, e MUST pré-selecionar o local do PC. Na entrada nas duas empresas, o sistema MUST usar o mesmo valor unitário nas duas: o valor do item na NF. Ela MUST NOT aplicar o acréscimo interno de 14,5% que a importação usa hoje na entrada da Q2P (`ceil(vNF / kg × 1,145)`). Como a compra nacional não tem trânsito, o lado ACXE é uma entrada, não uma transferência. O produto da entrada é o do catálogo da ACXE; a entrada nas duas empresas MUST exigir o produto da Q2P de mesma descrição (ativo), verificado antes do fiscal.
- **FR-029**: A compra nacional pela ACXE MUST NOT gerar baixa de PC na Q2P. Não existe PC correspondente lá, porque o n8n de espelhamento de PCs (`RDa9ilL3tbx5ETIk`, filtro da ACXEGDP-376) só copia PC de fornecedor estrangeiro. A baixa da ACXEGDP-344 continua só para a importação.

### Key Entities

- **PC aberto (cópia local)**: pedido de compra do OMIE com saldo a receber. Atributos: empresa, número, fornecedor, etapa, itens (produto, quantidade pedida, quantidade recebida, preço unitário), data e atualização. Fonte: cópia local mantida pelo n8n, atualizada de hora em hora e a cada alteração de PC.
- **Cache de PCs vistos** (0057): última versão de cada item de PC que passou pela cópia local (empresa, item do PC, número, produto, unidade, quantidades, preço, etapa), gravada só quando muda e auditada. Cobre o PC que sai da lista de pendentes por ter item associado a um recebimento aberto (FR-033).
- **Vínculo do OMIE**: associação item de NF → item de PC que o recebimento da NF-e já traz do OMIE, junto com o número do pedido informado na NF. É a sugestão principal do item. Fonte: cópia local dos recebimentos de NF-e, que ainda precisa ganhar essas colunas.
- **Sugestão de PC por item**: para um item de NF, o vínculo do OMIE, ou, sem ele, os PCs candidatos em ordem, com o motivo de cada um (número do pedido na NF, quantidade e preço compatíveis) ou o motivo de não haver candidato.
- **Vínculo confirmado**: item de NF (chave de acesso + sequência) → item de PC, com quem confirmou, quando, a situação do PC relida na confirmação e o resultado no OMIE.
- **Registro da conclusão fiscal** (existente, 016): estendido para indicar o vínculo com PC e a reversão no portal (status `revertido`, com a origem, espelho ou leitura ao vivo, e o aviso ao fiscal).
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
- **SC-008** (User Story 5, revisado em 22/10/2026): toda NF nacional da ACXE recebida pelo Atlas gera entrada no local escolhido: nas duas empresas, no par de locais correspondente e com o mesmo valor, sem divergência nova na Conferência de Estoque ACXE×Q2P; ou só na ACXE, nos locais só da ACXE.
- **SC-009**: Zero NFs com estoque lançado duas vezes (pelo OMIE no portal e pelo Atlas).
- **SC-010**: Zero PCs baixados em unidade diferente da NF (kg × tonelada) por recebimento feito pelo Atlas.
- **SC-011**: Uma confirmação e uma justificativa por nota quando um único PC atende todos os itens (NF 60199: eram 3 de cada).
- **SC-012**: Zero NFs paradas na etapa 40 do OMIE por fiscal revertido no portal depois de concluído pelo Atlas (caso da NF 19252): a NF volta a "fiscal pendente" em até uma rodada do espelho ou no clique, e nenhum falso positivo entre os recebimentos já concluídos (validação em PROD em 25/10/2026: 1 de 4.289 recebimentos da Q2P marcado, a própria 19252, e 0 de 346 da ACXE).

## Assumptions

- Até a ativação valeu a contenção de 21/10/2026: recebimento fiscal pelo Atlas desligado em PROD, fiscal concluindo no portal (vinculando o PC e marcando "não movimentar estoque") e o Atlas fazendo só o físico. A chave foi religada em PROD em 22/10/2026, depois do T033.
- O vínculo de item da NF a item de PC existe na API do OMIE. O teste controlado da NF 7813 da Replas (21/10/2026) validou o caminho para o vínculo que já vem do OMIE, e o T033 (NF 60199 da Zaraplast, 22/10/2026) validou a gravação de um vínculo novo (`ASSOCIAR-PEDIDO`), inclusive com PC de outro cadastro do mesmo fornecedor. Falta a troca de um vínculo existente; a NF menor que o saldo do PC foi confirmada em 23/10/2026 (NF 67988, research D20).
- O OMIE pode trazer o item já associado ao PC no recebimento da NF-e (NF 7813 → PC 304). Ainda não se sabe se faz isso sozinho, pelo número do pedido que o fornecedor informa na NF, ou se alguém associou no portal. Em qualquer caso, o vínculo existente é tratado como sugestão principal (FR-000).
- A etapa do PC não pode ser alterada pela API do OMIE. Não é preciso: o OMIE registra sozinho a quantidade recebida no PC ao concluir (teste da NF 7813).
- A escrita no OMIE para o vínculo entra na exceção ao Princípio II já documentada para o recebimento de NF-e (feature 016); a ação nova é documentada no plano.
- Cada item da NF corresponde a um único item de PC.
- Ao concluir o recebimento, o OMIE grava no PC a quantidade recebida do item na unidade da NF, sem converter (NF 60199 × PC 306, 22/10/2026). A quantidade recebida editável do item (`itensAjustes.nQtdeRecebida`) corrige isso e foi validada no portal; pela API, ainda não.
- Os PCs nacionais são lançados por compras na empresa que compra (Q2P ou ACXE) e não têm a observação "Pedido original ACXE", que marca os PCs-espelho da importação.
- O operador que hoje faz o recebimento confirma o PC; não há novo papel de usuário.
- As Histórias 1 a 4 (Q2P) vêm antes da História 5 (ACXE), que pode ser entregue numa fase separada.
- `d_alt` e `h_alt` do espelho refletem o evento no OMIE em horário de Brasília, e o espelho de recebimentos chega em até ~30 min. A reversão do recebimento no portal devolve a etapa 40, mantém o vínculo, o "não movimentar estoque" e as quantidades dos itens, e devolve o saldo do PC (NF 19252, 25/10/2026).

## Dependencies

- **Cópia local de PCs com atualização frequente**: Rev 1.5 do n8n "ACXE e Q2P - Espelho de Pedidos de Compra (Materiais a chegar)" (`qPJFEIY1PQ2LDQG2`, antes "Exporta Dados de Materiais a chegar"), **no ar desde 21/10/2026 às 18h05**. A troca é atômica, num statement só (não troca se a carga vier vazia, abaixo de 50% da atual ou mais velha que a da tabela). Entram os PCs pendentes e os recebidos parcialmente, sem filtro de valor. A cópia atualiza a cada aviso `CompraProduto.*` das duas empresas (filas `acxe_matriz_compras_03` e `q2p_matriz_compras_01`), e uma agenda de 10 em 10 min sincroniza se houver aviso pendente ou se passar 55 min sem sync. Há uma trava em `tbl_sync_debounce`, com 90 s entre o fim de um sync e o início do próximo. PC recebido por inteiro sai da cópia; PC recebido em parte fica com `nqtderec > 0`. O OMIE também tira da lista o PC com item associado a um recebimento aberto (PC 306, 22/10/2026), daí o cache de PCs vistos (FR-033).
- **Leitores da cópia de PCs que usam a quantidade cheia** (`nqtde` em vez de `nqtde - nqtderec`), todos sobre `tbl_pedidosCompras_ACXE`. Hoje não há PC recebido em parte em nenhuma das empresas, mas com a Rev 1.5 um parcial passa a ficar na cópia e seria contado cheio. `cockpit.service.ts` e `pendencias-fiscais.service.ts` são corrigidos nesta feature. A função `refresh_lotes_em_transito_se_stale` (migration 0037, trânsito por FUP) também usa `nqtde`, mas fica como está: ela é PL/pgSQL que escreve em `stockbridge.lote`, e reeditá-la reforçaria um desvio ao Princípio III. A limitação fica registrada para um card próprio, que leva o trânsito para TypeScript. A baixa da ACXEGDP-344 não é afetada: ela só usa PCs com "Pedido original ACXE" casando com a NF.
- **Colunas de pedido na cópia local dos recebimentos de NF-e** (n8n "Q2P - Exporta Recebimentos NF-e", tabela `tbl_recebimentoNFe_itens_Q2P`): PC e item do PC associados ao item, se o item está associado, e número e item do pedido informados na NF. Hoje a cópia não traz nada disso, e é pré-requisito do FR-000, do FR-003, do FR-011a, do FR-013 e do FR-021.
- **Teste controlado na NF 7813 da Replas**: feito em 21/10/2026 (n8n `CA0PlrtFkzcdQlpM`), validou FR-011 e FR-012 para o vínculo que vem do OMIE. O T033 (22/10/2026, n8n `4OnbxvfALn9OoXLH`, NF 60199 da Zaraplast) fez o teste com NF sem vínculo (gravar o vínculo pela API) e aprovou. Falta um teste com troca de vínculo existente. A NF menor que o PC foi confirmada em 23/10/2026 (NF 67988, research D20).
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
- Reverter ou desfazer o fiscal no OMIE pelo Atlas: a D21 da 017 só detecta a reversão feita no portal e refaz a conclusão no clique do operador (FR-035). Refazer só o fiscal de NF com a entrada física já lançada também fica fora: o fiscal conclui no portal, avisado por e-mail.
