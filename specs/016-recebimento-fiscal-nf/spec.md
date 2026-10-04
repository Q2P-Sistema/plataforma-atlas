# Feature Specification: Recebimento Fiscal da NF Nacional pelo Atlas

**Feature Branch**: `016-recebimento-fiscal-nf`
**Created**: 2026-10-02
**Status**: Draft
**Input**: User description: "StockBridge — recebimento fiscal da NF nacional pelo Atlas via API OMIE (ACXEGDP-395): o Atlas conclui o recebimento fiscal no OMIE (sem movimentar estoque) no mesmo clique do recebimento físico; a fila passa a mostrar NFs ainda na etapa 40 além das já concluídas no fiscal."

## Contexto

A feature 015 (ACXEGDP-328) entregou o recebimento **físico** de compra nacional da Q2P a partir da NF: o operador escolhe a NF numa fila, confere os itens já preenchidos e dá entrada, e o Atlas lança a entrada de estoque no OMIE.

O recebimento **fiscal** continua sendo feito à mão, por uma pessoa, na caixa "Recebimento de NF-e" do OMIE, antes do físico. Isso causa dois problemas:

1. **A NF fica invisível até alguém agir no OMIE.** Uma NF que chega da SEFAZ fica na etapa "Faturado pelo Fornecedor" (etapa 40) e só passa a existir para o Atlas — e para a fila do operador — depois que o recebimento fiscal é concluído (etapa 60). Se ninguém concluir, o operador não tem o que receber.
2. **O recebimento feito no OMIE pode corromper a fila.** Quando a pessoa faz o fiscal **e o físico juntos** no OMIE, o item da NF é vinculado a um produto do catálogo e a descrição do item muda temporariamente. O Atlas grava a descrição alterada, deixa de reconhecer a NF como recebida, e ela volta à fila — com risco de entrada de estoque em dobro (caso real: NF 6495, ACXEGDP-394).

Esta feature move o recebimento fiscal para dentro do Atlas: no mesmo clique em que o operador confirma o recebimento físico, o Atlas conclui o fiscal no OMIE **sem movimentar estoque** (o estoque continua sendo lançado pelo recebimento físico do Atlas, que já trata 1 item da NF virando vários produtos). Ninguém mais precisa fazer o recebimento de compra nacional no OMIE.

O caminho técnico foi validado em produção em 02/10/2026 na NF 6842 (Replas): o fiscal concluído pelo Atlas ficou idêntico ao feito pela tela do OMIE, com conta a pagar gerada, sem movimento de estoque e com a descrição original do item preservada; a NF entrou na fila e foi recebida fisicamente sem problemas.

## Clarifications

### Session 2026-10-02

- Q: Como tirar da fila uma NF com fiscal pendente que nunca será recebida (emitida errada, mercadoria não veio, compra recusada)? → A: O gestor pode **dispensar** a NF da fila no Atlas, com motivo obrigatório e registro de quem e quando, sem nenhuma ação no OMIE; a dispensa pode ser desfeita.
- Q (análise de 02/10/2026): a dispensa vale só para NF "fiscal pendente", ou também para NF "fiscal já feito" que nunca será recebida fisicamente (ex.: fiscal concluído no OMIE, mas a carga nunca chega)? Sem isso, essa NF não tinha nenhuma saída — a baixa por recebimento externo não serve, porque ela declara uma entrada que não existe. → A: a dispensa vale para **qualquer NF que ainda não foi recebida fisicamente no Atlas**, independente da situação fiscal (pendente ou já feito). A diferença entre as duas é só se o fiscal foi ou não concluído pelo Atlas no momento da dispensa — a ação do gestor é idêntica nos dois casos.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Receber uma NF que ainda não teve o fiscal feito, num único clique (Priority: P1)

Uma NF de compra nacional chega da SEFAZ ao OMIE e fica aguardando o recebimento fiscal. Sem ninguém tocar no OMIE, ela aparece na fila de recebimento nacional do StockBridge, marcada como "fiscal pendente". O operador abre a NF, confere os itens (como já faz hoje), confirma o recebimento — e o Atlas conclui o recebimento fiscal no OMIE e lança a entrada de estoque, em sequência.

**Why this priority**: é o objetivo da feature. Elimina a dependência de uma pessoa concluir o recebimento no OMIE antes de a mercadoria poder ser recebida, e elimina a origem do problema da NF 6495 (o recebimento físico feito pelo OMIE).

**Independent Test**: com uma NF de compra nacional elegível ainda aguardando o recebimento fiscal no OMIE, o operador a encontra na fila, confirma o recebimento, e ao final a NF está concluída no fiscal (com conta a pagar, sem movimento de estoque pelo fiscal) e a entrada de estoque foi lançada pelo Atlas.

**Acceptance Scenarios**:

1. **Given** uma NF de compra nacional elegível que chegou ao OMIE e ainda aguarda o recebimento fiscal, **When** o operador abre a fila de recebimento nacional, **Then** a NF aparece com número, data de emissão, fornecedor, quantidade de itens e valor total, e com a indicação "fiscal pendente".
2. **Given** essa NF aberta na tela de detalhe, **When** o operador vê os itens, **Then** a descrição, quantidade, unidade e valores são os da NF original emitida pelo fornecedor.
3. **Given** o operador confirma o recebimento da NF, **When** o Atlas processa, **Then** primeiro o recebimento fiscal é concluído no OMIE e depois a entrada de estoque é lançada, e o operador vê o resultado de cada etapa.
4. **Given** o recebimento concluído, **When** se consulta a NF no OMIE, **Then** ela está como recebida, com a conta a pagar gerada, sem movimento de estoque gerado pelo fiscal e com a descrição original dos itens.
5. **Given** o recebimento concluído, **When** a NF aparece depois no espelho como "fiscal concluído", **Then** ela **não** volta para a fila, porque já consta como recebida no Atlas.

---

### User Story 2 - Continuar recebendo NFs cujo fiscal já foi feito no OMIE (Priority: P1)

Há NFs que já tiveram o recebimento fiscal concluído no OMIE e ainda não foram recebidas fisicamente no Atlas — as que já estavam nessa situação quando a feature entrar, e as que alguém concluir no OMIE por engano depois. Elas continuam aparecendo na fila, marcadas como "fiscal já feito", e o recebimento faz só a entrada de estoque, como hoje.

**Why this priority**: a fila não pode perder nenhuma NF na transição. Voltar essas NFs para a etapa anterior no OMIE não é opção: desfaria a conta a pagar e a escrituração já feitas. Sem esta história, a entrada da feature esconderia NFs pendentes.

**Independent Test**: com uma NF cujo fiscal já foi concluído no OMIE e que ainda não foi recebida no Atlas, o operador a encontra na fila com a indicação "fiscal já feito", recebe, e o Atlas não tenta fazer o fiscal de novo.

**Acceptance Scenarios**:

1. **Given** uma NF com o fiscal já concluído no OMIE e sem recebimento físico no Atlas, **When** o operador abre a fila, **Then** a NF aparece com a indicação "fiscal já feito".
2. **Given** essa NF, **When** o operador confirma o recebimento, **Then** o Atlas lança só a entrada de estoque, sem nenhuma ação fiscal no OMIE.
3. **Given** a feature recém-ativada, **When** se compara a fila com a de antes, **Then** todas as NFs que estavam pendentes continuam nela.

---

### User Story 3 - Falhas, repetições e rejeições não deixam a NF em estado inconsistente (Priority: P2)

O mesmo clique passa a fazer duas gravações no OMIE (fiscal e estoque), e qualquer uma pode falhar — OMIE fora do ar, tempo esgotado, rejeição de regra. O operador também pode clicar duas vezes, e o gestor pode rejeitar um recebimento com divergência depois que o fiscal já foi feito. Em todos esses casos a NF tem de acabar num estado conhecido, que a fila mostra corretamente, e nada pode ser lançado em dobro.

**Why this priority**: sem isto a feature troca um problema visível por um invisível (fiscal concluído sem estoque, ou estoque lançado sem fiscal, ou fiscal tentado duas vezes). Vem depois das Histórias 1 e 2 porque elas definem o caminho normal; esta garante o caminho de exceção.

**Independent Test**: simular cada falha (fiscal recusado, falha do estoque depois do fiscal, clique repetido, rejeição do gestor) e verificar o estado da NF no OMIE, no Atlas e na fila depois de cada uma.

**Acceptance Scenarios**:

1. **Given** uma NF com fiscal pendente, **When** a conclusão do fiscal falha, **Then** nada é gravado (nem fiscal nem estoque), o operador vê uma mensagem clara e pode tentar de novo, e a NF continua na fila como "fiscal pendente".
2. **Given** uma NF cujo fiscal foi concluído no clique, **When** o lançamento de estoque falha em seguida, **Then** a NF continua na fila, agora como "fiscal já feito", e o novo recebimento faz só o estoque.
3. **Given** uma NF com fiscal pendente, **When** o operador confirma o recebimento duas vezes, ou repete depois de um tempo esgotado que na verdade chegou a gravar no OMIE, **Then** o fiscal é concluído uma única vez e o estoque é lançado uma única vez.
4. **Given** um recebimento com divergência de peso (fiscal já concluído no clique), **When** o gestor rejeita o recebimento, **Then** a NF volta à fila como "fiscal já feito" e o novo recebimento faz só o estoque.
5. **Given** uma NF com fiscal pendente, **When** o Atlas vai concluir o fiscal e verifica que o OMIE já o mostra como concluído, **Then** o Atlas não chama o fiscal de novo e segue para o estoque.

---

### Edge Cases

- **NF multi-item**: o fiscal é concluído para a NF inteira, de uma vez, antes do estoque. Se o estoque de algum item falhar, a NF fica como "fiscal já feito" com os itens que faltam, e o novo recebimento completa só esses (mesmo comportamento resumível da feature 015).
- **Divergência de peso**: o fiscal acontece no clique mesmo quando o item vai para aprovação do gestor — o fiscal registra a NF como emitida pelo fornecedor; a divergência é assunto do físico.
- **NF cancelada pelo fornecedor** enquanto aguardava o fiscal: deixa de aparecer na fila; se o operador já a tinha aberta, o recebimento é recusado com mensagem.
- **NF concluída por alguém no OMIE** enquanto o operador estava com ela aberta como "fiscal pendente": no clique o Atlas constata que o fiscal já foi feito, não o repete, e segue só com o estoque.
- **NF mista** (item de compra + item fora do recorte, ex.: consumo): o fiscal é concluído para a NF inteira e **todos** os itens são tratados do mesmo modo (ignorados, sem movimento de estoque, com conta a pagar) — é o que o "Ignorar" da tela faz; o Atlas só recebe fisicamente os itens do recorte, e os demais seguem como hoje (fora da fila).
- **Itens todos bloqueados por unidade** (nenhum produto pode ser gravado): o Atlas **não** conclui o fiscal — nada será recebido por ele. A NF continua na fila como "fiscal pendente" com o bloqueio visível; a saída é corrigir a unidade no OMIE, receber pelo formulário manual (com o fiscal concluído pelo fiscal no OMIE) ou dispensar.
- **Fornecedor não cadastrado no OMIE** (a NF chegou da SEFAZ sem contraparte reconhecida): a fila mostra "Fornecedor não identificado no OMIE"; ao confirmar, a conclusão fiscal é recusada pelo OMIE e o operador recebe a orientação de pedir ao fiscal o cadastro do fornecedor. Nada é gravado.
- **Fiscal concluído no OMIE com vínculo de produto** (o erro da NF 6495) continua possível se alguém fizer no OMIE por engano; nesse caso a NF aparece como "fiscal já feito". Esta feature não corrige a descrição alterada; se acontecer, a correção é pontual (ACXEGDP-394, encerrada em 02/10/2026 como erro operacional isolado, não padrão).
- **Espelho de NFs pendentes desatualizado**: uma NF concluída no OMIE ainda pode aparecer como "fiscal pendente" até a próxima atualização; o clique trata como no caso acima (verifica antes de concluir).
- **Baixa por recebimento externo**: continua disponível para NFs com fiscal já feito cuja mercadoria **entrou** fora do Atlas. Uma NF com fiscal pendente não tem por que receber baixa externa (se a mercadoria entrou fora do Atlas, o fiscal foi feito fora também). Mercadoria que **nunca vai chegar** não é caso de baixa externa — é caso de dispensa.
- **NF que nunca será recebida fisicamente** (emitida errada pelo fornecedor, mercadoria não veio, compra recusada), com fiscal pendente **ou** já feito: o gestor a dispensa da fila com motivo; o Atlas não faz nada no OMIE — cancelar, recusar, devolver ou estornar a conta a pagar continua com o fiscal, no OMIE. Se a dispensa for desfeita, a NF volta à fila como estava.
- **NF dispensada que depois é concluída no OMIE** por alguém: continua fora da fila (a dispensa vale para a NF, qualquer que seja a situação fiscal), até ser desfeita.
- **Recebimento fiscal desligado** (chave de operação desativada): a fila volta a mostrar só NFs com fiscal já feito, exatamente como antes da feature.

## Requirements *(mandatory)*

### Functional Requirements

**Fila**

- **FR-001**: A fila de recebimento nacional MUST mostrar, além das NFs com fiscal já concluído (comportamento atual), as NFs de compra nacional que chegaram ao OMIE e ainda aguardam o recebimento fiscal.
- **FR-002**: As NFs com fiscal pendente MUST seguir os mesmos critérios de elegibilidade da fila atual: empresa Q2P, CFOP de compra (1.101, 1.102, 2.101, 2.102), fornecedores excluídos fora, NFs canceladas fora e data de emissão a partir da data de corte do recebimento nacional.
- **FR-003**: Cada NF na fila MUST indicar se o fiscal está "pendente" ou "já feito".
- **FR-004**: A lista de NFs com fiscal pendente MUST vir de uma cópia local mantida atualizada periodicamente, sem consultar o OMIE a cada abertura da fila (mesmo princípio da fila atual).
- **FR-005**: Uma NF MUST aparecer uma única vez na fila, mesmo que esteja momentaneamente nas duas fontes (por exemplo, concluída no OMIE e ainda não refletida na cópia local).
- **FR-006**: Uma NF já recebida no Atlas MUST NOT voltar para a fila quando passar a constar como "fiscal concluído".
- **FR-007**: O detalhe de uma NF com fiscal pendente MUST mostrar os itens com os dados originais da NF (descrição, quantidade, unidade, valor), como o detalhe atual.

**Recebimento fiscal**

- **FR-008**: Ao confirmar o recebimento de uma NF com fiscal pendente, o sistema MUST concluir o recebimento fiscal no OMIE **antes** de lançar qualquer entrada de estoque.
- **FR-009**: O recebimento fiscal concluído pelo Atlas MUST: gerar a conta a pagar da NF; NOT gerar movimento de estoque; NOT vincular os itens a produtos do catálogo (preservando a descrição original de cada item).
- **FR-010**: O recebimento fiscal MUST ser concluído para a NF inteira, com todos os seus itens, de uma vez.
- **FR-011**: Antes de concluir o fiscal, o sistema MUST verificar no OMIE se a NF já está com o fiscal concluído e, nesse caso, NOT repetir a conclusão e seguir para o estoque.
- **FR-012**: Se a conclusão do fiscal falhar, o sistema MUST NOT lançar nenhuma entrada de estoque daquela NF e MUST informar o operador com mensagem que identifique a NF e o fornecedor (ou "fornecedor não identificado no OMIE" quando ele não existir) — nunca códigos internos do OMIE (ACXEGDP-313).
- **FR-013**: Se o fiscal for concluído e o lançamento de estoque falhar, a NF MUST permanecer recebível na fila como "fiscal já feito", e o novo recebimento MUST fazer só o estoque.
- **FR-014**: Para NFs com fiscal já feito, o recebimento MUST lançar só a entrada de estoque, sem nenhuma ação fiscal no OMIE.
- **FR-015**: O recebimento físico (correlação item → produtos, divergência com motivo e aprovação do gestor, NF recebida por inteiro, entrada de estoque) MUST permanecer como na feature 015.
- **FR-016**: Com divergência de peso, o fiscal MUST ser concluído no clique do operador, independentemente da aprovação do gestor; a rejeição do gestor MUST devolver a NF à fila como "fiscal já feito".
- **FR-017**: Repetir o clique ou reenviar o recebimento MUST NOT concluir o fiscal mais de uma vez nem lançar estoque em dobro.

**Dispensa de NF**

- **FR-021**: O gestor MUST poder dispensar da fila qualquer NF ainda não recebida fisicamente no Atlas — com fiscal pendente ou já feito —, informando um motivo obrigatório; a NF deixa de aparecer na fila de recebimento. A dispensa MUST registrar a situação fiscal da NF no momento em que foi feita.
- **FR-022**: A dispensa MUST NOT executar nenhuma ação no OMIE (não cancela, não recusa, não devolve, não conclui o fiscal).
- **FR-023**: O gestor MUST poder desfazer uma dispensa; a NF volta à fila na situação fiscal em que estiver.
- **FR-024**: Dispensa e reversão MUST ser auditáveis (quem, quando, motivo) e MUST ser consultáveis pelo gestor numa lista de NFs dispensadas.
- **FR-025**: O operador MUST NOT poder dispensar NFs.
- **FR-026**: Ao dispensar uma NF, o sistema MUST avisar o fiscal por e-mail, dizendo quem dispensou, o motivo e **o que fica pendente no OMIE**: com fiscal pendente, "recebimento aguardando manifestação ou cancelamento"; com fiscal já feito, "conta a pagar de R$ N a estornar ou manter". Os destinatários MUST ser configuráveis por ambiente (lista de e-mails), com os destinatários atuais do fiscal como padrão. O Atlas não executa essa pendência (FR-022) — só a comunica. (Decisão de 02/10/2026: fechar o laço com o fiscal por comunicação, não por automação; `ReverterRecebimento`/`ExcluirRecebimento` ficam como evolução futura, só com dado real de uso.)

**Rastreabilidade e controle**

- **FR-018**: O sistema MUST registrar, para cada NF cujo fiscal foi concluído pelo Atlas, quem confirmou, quando, e o resultado (concluído, já estava concluído, falhou com qual motivo), de forma auditável.
- **FR-019**: Falhas na conclusão do fiscal MUST ficar registradas para a equipe técnica, com detalhe suficiente para diagnóstico.
- **FR-020**: O recebimento fiscal pelo Atlas MUST poder ser desligado por configuração; desligado, a fila mostra só NFs com fiscal já feito, o recebimento faz só o estoque e a dispensa de NF fica indisponível — exatamente o comportamento anterior à feature.

### Key Entities

- **NF aguardando recebimento fiscal**: NF de compra emitida pelo fornecedor que chegou ao OMIE e ainda não teve o recebimento fiscal concluído. Atributos: número, chave de acesso, fornecedor, data de emissão, valor total, itens (descrição, quantidade, unidade, valor), situação no OMIE. Fonte: cópia local atualizada periodicamente a partir do OMIE.
- **Situação fiscal da NF na fila**: "pendente" ou "já feito"; determina se o recebimento inclui o fiscal.
- **Registro da conclusão fiscal**: por NF, quem confirmou, quando, resultado e motivo de falha; liga a NF ao recebimento físico correspondente.
- **Dispensa de NF**: decisão do gestor de tirar da fila uma NF que não será recebida fisicamente, com fiscal pendente ou já feito. Atributos: NF (chave de acesso), situação fiscal no momento da dispensa, motivo, quem dispensou e quando, quem desfez e quando (se desfeita).
- **Recebimento físico** (existente, feature 015): movimentação de estoque por item → produto(s), com aprovação quando há divergência.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% das NFs de compra nacional elegíveis aparecem na fila sem que ninguém precise concluir o recebimento no OMIE.
- **SC-002**: Em produção, uma NF que chega da SEFAZ ao OMIE aparece na fila em até 30 minutos (no UAT a latência é a da cópia PROD→UAT).
- **SC-003**: O operador conclui fiscal e físico de uma NF com um único clique de confirmação, sem sair do StockBridge.
- **SC-004**: Zero NFs com estoque lançado em dobro ou fiscal concluído em dobro por causa de clique repetido, falha ou reenvio.
- **SC-005**: Zero NFs recebidas pelo Atlas que reaparecem na fila depois de concluídas (o problema da NF 6495).
- **SC-006**: Toda NF que estava pendente na fila no momento da ativação continua recebível depois dela.
- **SC-007**: Em 100% dos recebimentos fiscais feitos pelo Atlas, o OMIE mostra a NF com conta a pagar gerada, sem movimento de estoque pelo fiscal e com a descrição original dos itens.
- **SC-008**: Após a ativação, o número de recebimentos de compra nacional concluídos manualmente no OMIE cai a zero, salvo exceções registradas.
- **SC-009**: Toda NF com fiscal pendente sai da fila por um destes caminhos: recebida, concluída no OMIE e recebida, cancelada pelo fornecedor ou dispensada pelo gestor com motivo — nenhuma fica indefinidamente na fila sem decisão registrada.

## Assumptions

- Escopo apenas Q2P e os mesmos CFOPs e filtros da feature 015; ACXE e importação ficam fora.
- O caminho de conclusão fiscal sem movimento de estoque e sem vínculo de produto foi validado em produção (NF 6842, 02/10/2026) e reproduz exatamente o "Ignorar" feito pela tela do OMIE.
- A escrita no OMIE para concluir o recebimento fiscal entra na exceção documentada ao Princípio II que o StockBridge já tem para escrita no OMIE (ajuste de estoque, pedido de compra).
- A cópia local das NFs aguardando fiscal será mantida por um fluxo do n8n, no mesmo padrão das demais cópias do OMIE (ver Dependências); a cadência de atualização será de no máximo 30 minutos, como o sync de NFs atual.
- A conta a pagar e os demais efeitos fiscais seguem os padrões que o OMIE aplica no recebimento pela tela (categoria, conta corrente, parcelas); o Atlas não altera esses dados.
- O operador que hoje faz o recebimento físico é quem passa a disparar o fiscal; não há novo papel de usuário.
- As NFs que já estão com fiscal concluído não serão revertidas no OMIE.
- O processo operacional muda: a equipe deixa de fazer o recebimento de compra nacional no OMIE. A comunicação dessa mudança à equipe está fora do escopo do sistema, mas é pré-requisito da ativação.

## Dependencies

- **Monitoramento da cópia local**: a defasagem do espelho de recebimentos (idade do último sync) MUST ser visível e alertar quando passar de 2 horas — hoje a fila degrada em silêncio quando o sync para.
- **Cópia local dos recebimentos pendentes do OMIE**: fluxo novo no n8n que lista as NFs aguardando recebimento fiscal da Q2P e as grava no banco, com a cadência de atualização da fila.
- **Feature 015 (ACXEGDP-328)**: fila, detalhe, correlação de produtos, divergência e recebimento físico, que esta feature estende.
- **ACXEGDP-394**: encerrada em 02/10/2026. O caso da NF 6495 foi erro operacional isolado; não haverá correção estrutural da identidade do item.

## Out of Scope

- Alterar o recebimento físico do Atlas.
- Recebimento de importação e ACXE.
- Reverter no OMIE NFs que já tiveram o fiscal concluído.
- Corrigir NFs cuja descrição foi alterada por recebimento feito no OMIE (caso isolado, correção pontual; ACXEGDP-394 encerrada).
