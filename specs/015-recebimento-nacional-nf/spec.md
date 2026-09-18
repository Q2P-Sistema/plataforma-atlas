# Feature Specification: Recebimento Nacional a partir da NF do Fornecedor

**Feature Branch**: `015-recebimento-nacional-nf`
**Created**: 2026-09-17
**Status**: Draft
**Input**: User description: "StockBridge — recebimento nacional a partir da NF do fornecedor (ACXEGDP-328): operador escolhe a NF numa fila, confere itens já preenchidos pelo espelho Postgres, correlaciona a descrição do fornecedor ao produto cadastrado e dá entrada — sem digitar quantidade, unidade ou valor."

## User Scenarios & Testing *(mandatory)*

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just ONE of them,
  you should still have a viable MVP (Minimum Viable Product) that delivers value.

  Assign priorities (P1, P2, P3, etc.) to each story, where P1 is the most critical.
  Think of each story as a standalone slice of functionality that can be:
  - Developed independently
  - Tested independently
  - Deployed independently
  - Demonstrated to users independently
-->

### User Story 1 - Receber uma NF nacional sem redigitar os dados do documento (Priority: P1)

O operador do StockBridge, ao receber uma remessa de um fornecedor nacional (ex.: Zaraplast, Cata, ISOFORMA), abre a fila de NFs nacionais pendentes, escolhe a NF correspondente e vê os itens já preenchidos com descrição do fornecedor, quantidade, unidade, valor unitário e valor total — dados que hoje ele digita manualmente. Ele confirma o produto de cada item, escolhe o estoque destino e dá entrada. Valor e quantidade vêm do documento fiscal, não da memória do operador.

**Why this priority**: É o núcleo do pedido — elimina o risco de erro de quantidade e de valor na digitação, que hoje afeta NFs de alto valor unitário (R$ 18,5 mi só em NFs da Zaraplast no semestre). Sem esta história não há redução de digitação alguma.

**Independent Test**: com uma NF nacional elegível no espelho (CFOP de compra, fornecedor não excluído, ainda não recebida), o operador consegue abrir a fila, ver a NF, e completar o recebimento com todos os campos numéricos vindos do documento — mesmo que a correlação de produto seja refeita a cada vez nesta história.

**Acceptance Scenarios**:

1. **Given** uma NF nacional de fornecedor elegível, com CFOP de compra (1.101, 1.102, 2.101 ou 2.102), ainda não recebida, **When** o operador abre a fila de recebimento nacional, **Then** a NF aparece com número, data de emissão, fornecedor, quantidade de itens e valor total, sem que o operador digite o número da NF.
2. **Given** o operador seleciona uma NF da fila, **When** a tela de detalhe abre, **Then** cada item mostra descrição do fornecedor, quantidade, unidade original, valor unitário e valor total do item, e o cabeçalho mostra o valor total da NF.
3. **Given** um item com produto identificado, **When** o operador confirma e dá entrada, **Then** o sistema registra o recebimento com o valor do item igual ao valor discriminado na NF, sem rateio manual por peso.
4. **Given** uma NF com mais de um item, **When** o operador finaliza, **Then** a soma dos valores dos itens recebidos confere com o valor total exibido.

---

### User Story 2 - Registrar o peso conferido na balança quando difere da NF (Priority: P2)

A mercadoria chega pesada pelo fornecedor, mas a conferência na balança da empresa costuma dar diferente. O operador precisa entrar com **o que efetivamente recebeu**, não com o que a NF declara. O sistema pré-preenche a quantidade da NF, permite substituí-la pelo peso conferido, registra os dois valores e trata a diferença como divergência — com motivo obrigatório e aprovação do gestor, como já acontece no recebimento de importação.

**Why this priority**: sem esta história, a História 1 transformaria um erro visível (digitação) num erro invisível (peso da NF aceito como verdade). No levantamento de comparações inequívocas, **~32% dos recebimentos divergem** do peso da NF, quase sempre para mais — e hoje nada disso deixa rastro: existe só o número que o operador escolheu digitar.

**Independent Test**: receber uma NF cuja quantidade conferida difira da declarada, verificar que o sistema exige motivo, cria a aprovação de gestor, e que o registro guarda a quantidade da NF **e** a quantidade conferida separadamente.

**Acceptance Scenarios**:

1. **Given** um item cuja quantidade conferida é igual à da NF (dentro da tolerância de 1 kg), **When** o operador dá entrada, **Then** o recebimento segue sem exigir motivo nem tratamento de divergência.
2. **Given** um item cuja quantidade conferida difere da NF em mais de 1 kg, **When** o operador tenta dar entrada sem motivo, **Then** o sistema recusa e exige a justificativa da diferença.
3. **Given** um item com divergência justificada, **When** o operador dá entrada, **Then** é criada uma aprovação de gestor e o registro preserva quantidade da NF, quantidade conferida e a diferença.
4. **Given** um item cujo peso conferido é **maior** que o da NF, **When** o operador justifica e dá entrada, **Then** o sistema aceita — diferente do recebimento de importação, que recusa receber acima da NF.

---

### User Story 3 - Reaproveitar a correlação produto↔descrição do fornecedor (Priority: P3)

Depois que o operador correlaciona pela primeira vez a descrição de um item do fornecedor (ex.: "PELMD 1018RA") a um produto do catálogo, a escolha fica memorizada. Em NFs seguintes do mesmo fornecedor com a mesma descrição, o produto já vem pré-selecionado.

**Why this priority**: a maior parte dos itens (95,7%) não tem código de produto na NF — só descrição livre. Sem memória, o operador refaz a mesma associação em toda NF recorrente, e 76,6% dos itens repetem um par (fornecedor, descrição) já visto.

**Independent Test**: correlacionar um item, receber, e abrir outra NF do mesmo fornecedor com descrição idêntica — o produto deve vir pré-selecionado sem nova busca.

**Acceptance Scenarios**:

1. **Given** um par (fornecedor, descrição normalizada) já correlacionado, **When** a NF entra na fila e o operador abre o detalhe, **Then** o produto vem pré-selecionado.
2. **Given** um par inédito, **When** o operador abre o detalhe, **Then** nada vem pré-selecionado e a entrada desse item exige correlação explícita.
3. **Given** o operador corrige uma sugestão, **When** confirma a entrada, **Then** a nova correlação passa a valer para as próximas NFs do mesmo par.

---

### User Story 4 - Classificar um item da NF em vários produtos de estoque (Priority: P4)

Sucata e material reciclado chegam como **uma única linha fiscal** (ex.: "SUCATA PSAI MOIDO MESCLADO GROSSO") e são classificados por grau na conferência física, virando dois ou mais produtos distintos no estoque. O operador distribui a quantidade conferida entre os produtos resultantes, e o valor do item é rateado entre eles proporcionalmente ao peso.

**Why this priority**: é operação real e recorrente — a NF 66461 da ISOFORMA tem 1 item de 13.541 kg que virou PS CRISTAL A, PS AI B e PS CRISTAL B. ISOFORMA é um dos fornecedores mais frequentes. Sem esta história, esse fornecedor inteiro fica fora da fila e volta ao formulário manual.

**Independent Test**: receber uma NF de item único distribuindo a quantidade entre 3 produtos e verificar que são criadas 3 movimentações, que a soma das quantidades fecha com o peso conferido, e que a soma dos valores fecha com o valor do item.

**Acceptance Scenarios**:

1. **Given** um item da NF, **When** o operador adiciona mais de um produto para esse item, **Then** o sistema exige que a soma das quantidades distribuídas seja igual à quantidade conferida do item.
2. **Given** um item distribuído entre N produtos, **When** o operador dá entrada, **Then** são criadas N movimentações, e o valor do item é rateado entre elas na proporção do peso de cada uma.
3. **Given** uma descrição de fornecedor já classificada antes em um conjunto de produtos, **When** ela reaparece numa NF nova, **Then** o sistema propõe o mesmo conjunto de produtos, cabendo ao operador ajustar as quantidades.

---

### User Story 5 - Bloquear item com unidade não conversível para Kg (Priority: P5)

Quando um item vem numa unidade que o sistema não sabe converter para Kg (ex.: unidade, litro, peça), esse item é bloqueado com mensagem clara indicando a unidade não reconhecida — nunca convertido por aproximação.

**Why this priority**: evita que uma conversão errada produza movimentação com quantidade incorreta — risco silencioso e mais grave que a digitação que a feature elimina. É a última prioridade porque, no recorte desta fase, 99,6% dos itens já vêm em unidade conversível.

**Independent Test**: apresentar um item com unidade fora da tabela e verificar que fica bloqueado com mensagem, enquanto os demais itens da mesma NF seguem recebíveis.

**Acceptance Scenarios**:

1. **Given** um item em unidade conhecida (KG, TON, TL), **When** o operador dá entrada, **Then** a quantidade é convertida para Kg e a movimentação é registrada em Kg.
2. **Given** um item em unidade fora da tabela, **When** o operador abre o detalhe, **Then** o item aparece bloqueado com mensagem nomeando a unidade, sem conversão aproximada.
2b. **Given** um item cuja unidade declarada contradiz a quantidade (ex.: declarado em KG mas com preço por quilo de tonelada), **When** o operador abre o detalhe, **Then** o item aparece bloqueado mostrando as duas leituras possíveis, e o sistema **não** escolhe qual está correta.
2c. **Given** um item de material legitimamente barato (ex.: papelão a R$ 0,35/kg), **When** o operador abre o detalhe, **Then** o item **não** é bloqueado — preço baixo não é unidade errada.
3. **Given** uma NF com um item bloqueado e outros conversíveis, **When** o operador dá entrada, **Then** os conversíveis são recebidos e o bloqueado permanece pendente.

---

### User Story 6 - Dar baixa em NF que já entrou fora do Atlas (Priority: P2)

Por necessidade operacional, o recebimento às vezes é feito **direto no OMIE** — e a NF continua aparecendo como pendente na fila do StockBridge. O operador declara que aqueles itens já entraram fora do Atlas, com motivo; um gestor aprova; o item sai da fila **sem criar movimentação, sem mexer no estoque e sem chamar o OMIE**.

**Why this priority**: sem isso, há NFs que nunca saem da fila e outras que entram em duplicidade. A checagem automática de "já recebida" reconhece ~90% dos recebimentos feitos pelo formulário manual — os outros 10% (número que não existe no espelho, ou número ambíguo entre fornecedores) não têm como ser reconhecidos por dado nenhum. É também a única saída para o recebimento feito diretamente no ERP, que continuará existindo.

**Independent Test**: com uma NF na fila, declarar recebimento externo com motivo, aprovar como gestor, e verificar que o item sumiu da fila, que **nenhuma** movimentação foi criada e que o estoque não mudou.

**Acceptance Scenarios**:

1. **Given** uma NF pendente na fila, **When** o operador declara recebimento externo sem motivo, **Then** o sistema recusa e exige a justificativa.
2. **Given** a declaração feita com motivo, **When** o gestor aprova, **Then** o item sai da fila e nenhuma movimentação de estoque é criada.
3. **Given** uma declaração pendente de aprovação, **When** o gestor rejeita, **Then** o item volta a aparecer como pendente na fila.
4. **Given** uma NF com 3 itens, **When** o operador declara recebimento externo de apenas 1, **Then** os outros 2 continuam pendentes e recebíveis normalmente.
5. **Given** a funcionalidade desligada por configuração, **When** o operador abre a fila, **Then** a ação não aparece e a rota recusa a chamada.

---

### Edge Cases

- Item em unidade fora da tabela de conversão: bloqueia só esse item; os demais da NF seguem recebíveis.
- Par (fornecedor, descrição) inédito: nada pré-selecionado; a escolha do operador fica memorizada.
- Mesmo produto físico com grafias ligeiramente diferentes: tratados como pares distintos — a memória é por descrição normalizada exata.
- Peso conferido maior que o da NF: aceito, com motivo e aprovação (diferente da importação).
- Peso conferido muito acima da NF (ex.: o dobro): aceito pela regra, mas é o padrão exato das três NFs relançadas em produção — a aprovação do gestor é a barreira que hoje não existe.
- NF com o **mesmo número** de outro fornecedor: são documentos distintos e ambos podem ser recebidos; a identidade é a chave de acesso da NF, não o número.
- Soma dos valores dos itens não bate exatamente com o total por arredondamento fiscal: aceita dentro de tolerância de centavos.
- NF cancelada ou deletada no OMIE depois de entrar na fila: some da fila e não pode mais ser recebida por este caminho.
- NF parcialmente recebida: fila e detalhe mostram só os itens pendentes; reenviar não duplica o que já entrou.
- Fornecedor sem NF-e, ou NF fora do espelho / fora do recorte: segue pelo formulário manual existente.
- NF de fornecedor excluído do escopo: nunca aparece na fila.
- NF já recebida pelo formulário manual: não deve reaparecer na fila. Reconhecida pelo número + empresa, já que as entradas manuais não têm chave de acesso.
- NF recebida manualmente com número que não corresponde a nenhuma NF do espelho (ou ambíguo entre fornecedores): não é reconhecível automaticamente — resolve-se por recebimento externo (História 6).
- Duas linhas distintas da mesma NF classificadas no **mesmo** produto do catálogo: são recebimentos distintos e ambos devem somar ao estoque; nenhum pode ser descartado como duplicata.
- Recebimento interrompido no meio de uma NF: ao reabrir, a fila mostra apenas os itens que ainda faltam.

## Requirements *(mandatory)*

### Functional Requirements

**Fila e detalhe**

- **FR-001**: O sistema MUST listar, numa fila de recebimento nacional, as NFs de entrada da empresa Q2P com CFOP 1.101, 1.102, 2.101 ou 2.102, mostrando número, data de emissão, fornecedor, quantidade de itens e valor total — sem exigir digitação do número da NF.
- **FR-002**: O sistema MUST excluir da fila NFs canceladas ou deletadas, NFs de fornecedores marcados como excluídos, e NFs cujos itens já foram todos recebidos.
- **FR-003**: O sistema MUST exibir, no detalhe da NF, a descrição do fornecedor, quantidade, unidade original, valor unitário e valor total por item, e o valor total da NF no cabeçalho — todos originados do documento fiscal.
- **FR-004**: O sistema MUST rotular a contraparte da NF de entrada como **Fornecedor**, evitando rótulo que sugira que a Q2P é a emissora.
- **FR-016**: O sistema MUST obter todos os dados da NF por leitura do espelho já sincronizado, sem chamada de consulta ou escrita à API do OMIE.
- **FR-023**: O sistema MUST listar apenas NFs emitidas a partir de uma data de corte fixa, definida como 7 dias anteriores à entrada em operação; NFs anteriores ao corte nunca entram na fila. O corte governa apenas quanto de histórico entra: NF emitida depois dele permanece na fila até ser recebida ou baixada.
- **FR-024**: O sistema MUST reconhecer como já recebidos os itens registrados pelo formulário manual, que não possuem chave de acesso, casando pelo número da NF e empresa.
- **FR-025**: O sistema MUST registrar, em cada movimentação criada por este fluxo, qual item da NF a originou, de modo que a pendência de um item possa ser determinada sem depender da correlação de produto.

**Quantidade conferida e divergência**

- **FR-017**: O sistema MUST pré-preencher a quantidade de cada item com a quantidade da NF e MUST permitir que o operador a substitua pela quantidade conferida na balança.
- **FR-018**: O sistema MUST tratar diferença superior a 1 kg entre quantidade da NF e quantidade conferida como divergência, exigindo motivo e gerando aprovação de gestor.
- **FR-019**: O sistema MUST aceitar quantidade conferida **maior** que a da NF, mediante motivo e aprovação — comportamento deliberadamente distinto do recebimento de importação, que recusa.
- **FR-020**: O sistema MUST registrar, para cada item recebido, a quantidade declarada na NF e a quantidade conferida, de modo que a diferença seja auditável depois.
- **FR-010**: O sistema MUST usar o valor total do item conforme discriminado na NF como valor da movimentação, sem rateio manual por peso neste fluxo.

**Correlação de produto**

- **FR-005**: O sistema MUST exigir correlação explícita entre a descrição do item e um produto cadastrado antes de permitir a entrada, quando não houver correlação memorizada.
- **FR-006**: O sistema MUST pré-selecionar o produto de itens cujo par (fornecedor, descrição normalizada) já foi correlacionado antes.
- **FR-007**: O sistema MUST memorizar toda correlação criada ou corrigida pelo operador, para reaproveitamento nas NFs seguintes do mesmo fornecedor.
- **FR-021**: O sistema MUST permitir que um item da NF seja distribuído entre vários produtos de estoque, exigindo que a soma das quantidades distribuídas seja igual à quantidade conferida do item.
- **FR-022**: O sistema MUST ratear o valor do item entre os produtos resultantes proporcionalmente ao peso atribuído a cada um.

**Conversão de unidade**

- **FR-008**: O sistema MUST converter a quantidade para Kg usando tabela explícita de unidades (cobrindo ao menos KG, TON e TL), sem heurística nem aproximação.
- **FR-009**: O sistema MUST bloquear a entrada de item cuja unidade não esteja na tabela, exibindo mensagem que identifica a unidade, sem conversão implícita.
- **FR-029**: O sistema MUST conferir a unidade declarada comparando o preço por quilo que ela produz com o preço por quilo da leitura alternativa, e MUST bloquear o item quando a unidade declarada for implausível — exibindo as duas leituras, sem escolher qual está certa. A conferência MUST distinguir unidade incoerente de unidade desconhecida, e material legitimamente barato MUST NOT ser bloqueado por preço baixo.

**Controle e integridade**

- **FR-011**: O sistema MUST exigir que o operador escolha o estoque destino entre locais não espelhados, mantendo a restrição vigente.
- **FR-012**: O sistema MUST manter o controle de entrada já existente: uma movimentação e uma aprovação de gestor por produto recebido, com ajuste no OMIE na aprovação.
- **FR-013**: O sistema MUST impedir recebimento em duplicidade do mesmo produto **do mesmo item** de um documento fiscal, identificando o documento pela **chave de acesso da NF** (não pelo número, que se repete entre fornecedores) e o item pela descrição do fornecedor. Duas linhas distintas da mesma NF classificadas no mesmo produto são recebimentos distintos e ambos MUST somar ao estoque.
- **FR-030**: O sistema MUST manter na fila o item que foi recebido apenas em parte, mostrando o que já entrou e o quanto falta, até que a quantidade conferida esteja integralmente registrada.
- **FR-031**: O sistema MUST permitir que um gestor reverta uma baixa por recebimento externo já aprovada, devolvendo o item à fila, com registro do motivo.
- **FR-014**: O sistema MUST manter disponível o formulário de recebimento nacional manual, para NFs fora do espelho ou fornecedores sem NF-e.
- **FR-015**: O sistema MUST identificar produtos por descrição e locais por nome em toda mensagem de erro, status ou notificação — nunca por código interno do OMIE.
- **FR-026**: O sistema MUST permitir que o operador declare que os itens de uma NF já entraram no estoque fora do Atlas, com motivo obrigatório e aprovação de gestor, retirando o item da fila **sem** criar movimentação, alterar estoque ou chamar o OMIE.
- **FR-027**: O sistema MUST permitir desligar a declaração de recebimento externo por configuração, sem alteração de banco.
- **FR-028**: O sistema MUST apresentar ao gestor, na aprovação de um recebimento com divergência, a quantidade declarada na NF, a quantidade conferida e a diferença entre elas, além do produto identificado por descrição.

### Key Entities *(include if feature involves data)*

- **NF Nacional (cabeçalho)**: documento fiscal de entrada da Q2P — chave de acesso (identidade), número, data de emissão, CFOP, fornecedor e valor total.
- **Item da NF**: linha do documento — descrição do fornecedor, quantidade declarada, unidade, valor unitário e valor total.
- **Correlação Fornecedor→Produtos**: associação memorizada entre (fornecedor, descrição normalizada) e **um ou mais** produtos do catálogo, criada pelo operador e reaproveitada depois.
- **Tabela de Conversão de Unidade**: mapeamento explícito das unidades do fornecedor para Kg; unidade ausente bloqueia o item.
- **Movimentação de Recebimento**: registro de entrada por produto, agora com quantidade declarada na NF, quantidade conferida e a diferença entre elas.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: O operador completa o recebimento de uma NF nacional sem digitar valor de item, valor total nem unidade; a quantidade vem preenchida e só é alterada quando a conferência física diverge.
- **SC-002**: Para todo par (fornecedor, descrição) já correlacionado, o produto aparece pré-selecionado sem nova busca.
- **SC-003**: Nenhum item com unidade não conversível é recebido com conversão implícita — 100% ficam bloqueados até tratamento explícito.
- **SC-004**: Em 100% dos recebimentos com divergência, o registro permite reconstituir quantidade da NF, quantidade conferida, diferença e motivo — hoje nenhum desses casos deixa rastro.
- **SC-005**: Nenhum produto do mesmo item de um documento fiscal é recebido em duplicidade; NFs de fornecedores diferentes que compartilham o mesmo número, e linhas distintas da mesma NF que apontam para o mesmo produto, são recebidas normalmente.
- **SC-006**: Em item classificado em vários produtos, a soma das quantidades fecha com a quantidade conferida e a soma dos valores fecha com o valor do item.
- **SC-007**: Após 30 dias de uso, ao menos 80% dos itens de fornecedores recorrentes chegam ao detalhe já com produto pré-selecionado.
- **SC-008**: Nenhuma NF já recebida pelo formulário manual reaparece na fila como pendente.
- **SC-009**: Todo item retirado da fila por recebimento externo tem motivo, autor e aprovador registrados, e não produziu nenhuma movimentação de estoque.
- **SC-010**: Nenhum item cuja unidade declarada contradiga o preço implícito é recebido — 100% ficam bloqueados para conferência humana.
- **SC-011**: Nenhum item parcialmente recebido sai da fila antes de a quantidade conferida estar integralmente registrada.

## Assumptions

- Esta fase cobre apenas a empresa Q2P; ACXE fica para iteração futura, e a filial Q2P está fora (sem NF de entrada desde 13/01/2026).
- CFOPs elegíveis: 1.101, 1.102, 2.101 e 2.102. Outros CFOPs de entrada (devolução, consumo, retorno de depósito) ficam fora até haver demanda.
- PLASTFIX e a contraparte intercompany ACXE ficam fora da fila nesta fase — a segunda por já ser coberta pelo fluxo dual de importação.
- O galpão de destino continua sendo escolha do operador a cada recebimento; o código de estoque da NF é genérico por empresa e não identifica o galpão real.
- A tolerância de 1 kg para caracterizar divergência é a mesma já usada no recebimento de importação, para que os dois fluxos tratem o conceito com o mesmo limiar.
- A normalização de descrição trata variações de caixa, acentuação e espaçamento como equivalentes; variações de conteúdo são descrições distintas nesta fase.
- O espelho das NFs é mantido por rotina de sincronização existente; esta feature apenas o consome.
- A fila considera apenas NFs emitidas a partir de um corte fixo de 7 dias antes da entrada em operação. O valor vem da medição do prazo real entre emissão e recebimento: 94% dos recebimentos ocorrem em até 7 dias, então NF mais antiga que isso quase certamente já foi tratada pelo fluxo manual.
- O formulário manual continua criando registros sem chave de acesso, porque atende justamente NFs fora do espelho. A checagem por número não é medida transitória de migração: é permanente.
- A declaração de recebimento externo é reconhecidamente um risco — permite retirar trabalho da fila sem contrapartida em estoque. Ela existe enquanto o recebimento direto no OMIE for possível, e é desligável por configuração quando o módulo estiver validado.
