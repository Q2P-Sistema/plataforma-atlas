# Feature Specification: Recebimento de NF de Importação com Múltiplos Produtos

**Feature Branch**: `013-importacao-multi-produto`  
**Created**: 2026-07-15  
**Status**: Draft  
**Jira**: ACXEGDP-115 (subtarefa de ACXEGDP-114) — reaberta em 15/07  
**Input**: User description: "vamos especificar o recebimento de mais do 1 produto na importação. abra no Jira a tarefa 115 para darmos continuidade nela"

## Resumo

O recebimento de importação do StockBridge hoje só aceita **NF de item único**. Uma NF de importação com mais de um produto é **bloqueada** (STK-10 / ACXEGDP-289): o sistema exibe mensagem ao operador e envia e-mail para a caixa de operações, e a NF tem de ser processada manualmente no OMIE. O bloqueio foi uma correção de robustez — antes dele, o sistema lia silenciosamente apenas o primeiro produto da NF (`det[0]`): esse produto entrava com o **valor total da NF** dividido pela sua quantidade (custo inflado) e os demais produtos **desapareciam sem qualquer registro**.

Essa limitação é operacionalmente relevante: nos últimos 12 meses, **30 das 962 NFs de entrada de importação da ACXE (3,1%) tiveram mais de um produto** — cerca de 2 a 3 por mês, com produtos distintos reais (ex.: uma NF com PEBD 101 + PEBD 323; outra com três PEBDs). Todas essas caem hoje no processo manual.

Esta feature remove o bloqueio e permite **receber, numa única operação, uma NF de importação com N produtos** — cada produto conferido, correlacionado com a Q2P, lançado no OMIE (ACXE + Q2P) e registrado como uma entrada de estoque independente, mantendo o mesmo controle de conferência física × fiscal que o recebimento de item único já oferece.

O fluxo de recebimento **nacional** já recebe múltiplos produtos por NF desde 09/05 — mas é um caminho distinto (compra não-espelhada, digitada, sem consulta à NF real e sem o par de ajustes ACXE→Q2P). Esta feature traz a capacidade multi-produto para o caminho de **importação**, reaproveitando do nacional o padrão de "N entradas independentes por NF" e do próprio recebimento de importação toda a mecânica de conferência, correlação e ajuste dual.

## Clarifications

### Session 2026-07-15

- Q: Como tratar divergência entre a quantidade física recebida e a quantidade da NF, por item? → A: **Por item, como hoje** — cada produto compara físico × fiscal; item dentro da tolerância entra direto, item divergente vai à aprovação do gestor (faltando/varredura), reaproveitando a máquina de divergência do recebimento de item único, aplicada a cada produto.
- Q: Quando um produto da NF multi-item não tem correlato na Q2P (ou é inválido), o que o sistema faz? → A: **Tudo-ou-nada** — valida todos os produtos antes de escrever qualquer coisa no OMIE; se **qualquer** produto não tem correlato Q2P (ou é inválido), a NF **inteira** é bloqueada com o produto problemático identificado, e nenhum recebimento parcial ocorre. O operador cadastra o produto na Q2P e recebe a NF de uma vez.
- Q: Como valorar cada produto, já que o `vNF` (com tributos) é do cabeçalho e não por item? → A: **Rateio do total da NF pelo valor comercial de cada item** (`valor unitário comercial × quantidade`), preservando a base de custo atual (com tributos embutidos) e distribuindo-a proporcionalmente entre os produtos — em vez de inflar o primeiro item com o total. É o análogo do rateio do fluxo nacional, mas com o peso vindo do próprio OMIE, não digitado. **Confirmado em 15/07: base com tributos, como hoje** (a alternativa sem tributos foi descartada).

> **Escopo de empresa**: como todo o recebimento de importação hoje, esta feature é **ACXE-only** (a NF é emitida pela ACXE e o ajuste dual move ACXE→Q2P). O contexto Q2P puro permanece como está.

> **Fronteira de atomicidade**: "tudo-ou-nada" governa a **validação prévia** (correlação, produto, localidade) — nada é escrito no OMIE até todos os produtos passarem. Já uma **falha no OMIE durante a gravação** (ex.: ACXE de um produto entra, Q2P do mesmo produto falha) não é revertida entre produtos: cai no mecanismo de **pendência por item** que já existe hoje (`pendente_q2p`), com retry independente por produto. Ou seja: a NF nunca é recebida "pela metade" por produto **não cadastrado**, mas pode ficar com um produto **pendente de conclusão no OMIE** — estado já conhecido e recuperável do fluxo atual.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Receber uma NF de importação com vários produtos (Priority: P1)

Como operador de recebimento, ao buscar uma NF de importação que contém mais de um produto e cujas quantidades recebidas conferem com a nota, quero receber **todos os produtos de uma vez** — cada um entrando no estoque com sua própria quantidade e seu próprio valor — sem precisar recorrer ao processo manual no OMIE.

**Why this priority**: É o núcleo da feature e o que elimina o processo manual das ~2-3 NFs/mês que hoje são bloqueadas. Entrega valor sozinha: destrava o caso mais comum de multi-item (mercadoria que chega conforme faturada) e corrige a perda silenciosa de produtos que existia antes do bloqueio.

**Independent Test**: Buscar, no recebimento de importação, uma NF real com 2–3 produtos e quantidades iguais às da NF; confirmar o recebimento e verificar que **cada** produto gerou uma entrada de estoque independente em ACXE e Q2P, com a quantidade correta e o valor correspondente à sua própria linha da NF (sem o total da NF recair sobre um único item).

**Acceptance Scenarios**:

1. **Given** uma NF de importação com 3 produtos e quantidades físicas iguais às da NF, **When** o operador busca a NF, **Then** o sistema apresenta os 3 produtos (descrição, quantidade, unidade e valor de cada um) em vez de bloquear a nota.
2. **Given** os 3 produtos apresentados e todos com correlato na Q2P, **When** o operador confirma o recebimento, **Then** o sistema cria **3 entradas de estoque independentes** (uma por produto), cada uma lançada em ACXE (transferência) e Q2P (entrada), e informa sucesso.
3. **Given** a mesma NF já recebida, **When** o operador busca ou tenta receber a NF novamente, **Then** o sistema impede o reprocessamento e informa que a NF já foi processada (sem duplicar lançamentos no OMIE).
4. **Given** uma NF com 3 produtos, **When** o recebimento é concluído, **Then** o valor de cada produto reflete a sua própria linha da NF (o custo por quilo de um produto não é contaminado pelo valor dos outros), e a soma dos valores dos itens corresponde ao total da NF.

---

### User Story 2 - Conferência com divergência por produto (Priority: P2)

Como operador de recebimento, ao conferir fisicamente uma NF multi-produto, quando a quantidade recebida de **algum** produto é menor que a da NF, quero registrar a divergência **daquele produto** — encaminhando-o à aprovação do gestor — sem travar os demais produtos da mesma NF, que conferem e devem entrar normalmente.

**Why this priority**: A conferência física × fiscal é a razão de ser da tela de recebimento; sem ela, multi-item entraria "no escuro". Mantém para N produtos o mesmo controle (faltando/varredura + aprovação do gestor + destinação da diferença para estoque especial) que o recebimento de item único já exerce. É P2 porque a maioria das NFs chega conforme faturada (US1 cobre o volume), mas a divergência precisa existir para o recebimento ser confiável.

**Independent Test**: Receber uma NF com 2+ produtos em que um deles vem com quantidade menor que a NF (e os demais conferem); confirmar que o produto divergente é encaminhado para aprovação do gestor (com o motivo e a classificação faltando/varredura) enquanto os produtos que conferem entram no estoque de imediato.

**Acceptance Scenarios**:

1. **Given** uma NF com 3 produtos, sendo 1 com quantidade recebida menor que a NF (além da tolerância) e 2 conferindo, **When** o operador confirma o recebimento informando o motivo e a classificação do produto divergente, **Then** os 2 produtos que conferem entram no estoque de imediato e o produto divergente fica **aguardando aprovação do gestor**.
2. **Given** um produto de uma NF multi-item aguardando aprovação por divergência, **When** o gestor aprova, **Then** o produto é lançado no OMIE pela quantidade efetivamente recebida e a diferença (faltante) é destinada ao estoque especial correspondente (faltando ou varredura), sem afetar os demais produtos da NF.
3. **Given** uma NF multi-item, **When** o operador informa, para qualquer produto, uma quantidade recebida **maior** que a da NF, **Then** o sistema bloqueia a confirmação daquele produto e orienta a registrar o excedente separadamente (mesma regra do recebimento de item único).
4. **Given** um produto divergente encaminhado para aprovação, **When** a notificação é enviada ao gestor, **Then** ela identifica a NF e o produto específico (uma única mensagem consolidada quando há mais de um produto pendente na mesma NF).

---

### User Story 3 - Bloqueio tudo-ou-nada quando um produto não tem correlato (Priority: P3)

Como gestor do estoque, quero que uma NF multi-produto em que **algum** produto não está cadastrado/correlacionado na Q2P seja **bloqueada por inteiro**, com o produto problemático claramente identificado — em vez de receber uma parte e deixar o resto "solto" — para que a NF só entre quando estiver 100% correlacionável e o estoque não fique num estado parcial difícil de rastrear.

**Why this priority**: É uma regra de integridade que evita recebimento parcial e estado intermediário. P3 porque protege um caso de exceção (produto novo/não cadastrado), mas é decisão de política explícita (tudo-ou-nada) e precisa de comportamento observável definido.

**Independent Test**: Receber uma NF com 2+ produtos em que um deles não tem correlato na Q2P; confirmar que a NF inteira é bloqueada, que a mensagem nomeia o produto sem correlato, e que **nenhum** lançamento de estoque/OMIE foi feito para os outros produtos.

**Acceptance Scenarios**:

1. **Given** uma NF com 3 produtos, sendo 1 sem correlato na Q2P, **When** o operador tenta confirmar o recebimento, **Then** o sistema bloqueia a **NF inteira**, identifica o produto sem correlato (pela descrição, não por código interno) e orienta o cadastro na Q2P; nenhum dos 3 produtos é lançado.
2. **Given** o produto faltante cadastrado na Q2P com a descrição correta, **When** o operador repete o recebimento da mesma NF, **Then** os 3 produtos são recebidos normalmente (US1), sem duplicar nada do que quer que tenha sido tentado antes.
3. **Given** uma NF multi-item em que um produto é inválido (quantidade ou dado essencial ausente), **When** o operador tenta receber, **Then** o mesmo bloqueio total se aplica, com o produto problemático identificado.

---

### Edge Cases

- **NF que passou de 1 para vários produtos** (ou vice-versa) entre uma tentativa e outra: a idempotência por NF impede reprocessar uma NF já recebida; a busca sempre reflete o estado atual da NF no OMIE.
- **Falha no OMIE no meio da NF**: se o lançamento de um produto conclui em ACXE mas falha em Q2P, aquele produto fica **pendente** (recuperável via o painel de operações pendentes, retry por produto), enquanto os demais produtos concluem normalmente. A NF não é revertida por inteiro (o OMIE não é transacional entre produtos).
- **Dois produtos idênticos na mesma NF** (mesma descrição/código repetida em duas linhas): cada linha é uma entrada; a idempotência por produto precisa distinguir as duas ocorrências para não colapsá-las nem duplicá-las.
- **Produtos da NF destinados a galpões diferentes**: cada produto pode ter sua própria localidade de destino; a conferência é por produto.
- **NF cancelada / não emitida pela ACXE**: as validações fiscais existentes (cancelada, emitente ACXE) continuam valendo e bloqueiam a NF antes da conferência por produto.
- **Tolerância de quantidade**: a mesma tolerância de conferência do item único (diferença desprezível entre físico e fiscal) se aplica a cada produto individualmente.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O sistema MUST apresentar, na busca de recebimento de importação, **todos os produtos** de uma NF com mais de um item — em vez de bloquear a nota —, exibindo por produto: descrição, quantidade, unidade e valor.
- **FR-002**: O sistema MUST permitir que o operador confira e receba, numa única operação, **N produtos** de uma mesma NF de importação.
- **FR-003**: O sistema MUST registrar cada produto como uma **entrada de estoque independente**, com sua própria quantidade, valor, localidade de destino, correlação ACXE↔Q2P e ajuste OMIE (ACXE transferência + Q2P entrada).
- **FR-004**: O sistema MUST valorar cada produto pela **sua própria linha da NF**, de modo que o custo por quilo de um produto não seja contaminado pelo valor dos demais, e que a soma dos valores dos produtos corresponda ao total da NF (dentro do arredondamento).
- **FR-005**: O sistema MUST conferir a quantidade física recebida contra a quantidade da NF **por produto**, aplicando a mesma tolerância do recebimento de item único.
- **FR-006**: Quando a quantidade recebida de um produto for menor que a da NF (além da tolerância), o sistema MUST encaminhar **aquele produto** à aprovação do gestor (com motivo obrigatório e classificação faltando/varredura), sem bloquear os produtos da mesma NF que conferem.
- **FR-007**: Na aprovação de um produto divergente, o sistema MUST lançar no OMIE a quantidade efetivamente recebida e destinar a diferença faltante ao estoque especial correspondente (faltando ou varredura), independentemente dos demais produtos da NF.
- **FR-008**: O sistema MUST recusar a confirmação de qualquer produto cuja quantidade recebida seja **maior** que a da NF, orientando a registrar o excedente separadamente (mesma regra do item único).
- **FR-009**: O sistema MUST **validar todos os produtos da NF antes de escrever qualquer coisa no OMIE** e, se **qualquer** produto não tiver correlato na Q2P ou for inválido, **bloquear a NF inteira** sem receber nenhum produto (política tudo-ou-nada).
- **FR-010**: A mensagem de bloqueio por falta de correlato MUST identificar o(s) produto(s) problemático(s) **pela descrição** (não por código interno do OMIE) e orientar o cadastro na Q2P.
- **FR-011**: O sistema MUST impedir o reprocessamento de uma NF já recebida (idempotência por NF), sem duplicar lançamentos no OMIE, mesmo que a NF tenha múltiplos produtos.
- **FR-012**: O sistema MUST tratar falha de OMIE em um produto (ex.: ACXE ok, Q2P falha) como **pendência daquele produto**, recuperável via retry independente, sem reverter os produtos que já concluíram nem bloquear os demais.
- **FR-013**: O sistema MUST distinguir duas linhas de produto na mesma NF (inclusive quando descrição/código coincidem) de forma que cada uma gere sua própria entrada, sem colapsar nem duplicar.
- **FR-014**: O sistema MUST manter, para NF multi-item, as validações fiscais já existentes no recebimento de importação (NF cancelada, NF não emitida pela ACXE), aplicadas à NF antes da conferência por produto.
- **FR-015**: Quando houver mais de um produto pendente de aprovação na mesma NF, o sistema MUST notificar o gestor de forma **consolidada** (uma mensagem identificando a NF e os produtos), evitando uma enxurrada de e-mails por NF.
- **FR-016**: O sistema MUST permitir que o operador informe, **por produto**, a quantidade física recebida e a localidade de destino, permitindo que produtos da mesma NF tenham destinos diferentes.

### Key Entities *(include if feature involves data)*

- **NF de importação (multi-produto)**: documento fiscal emitido pela ACXE com N linhas de produto; cada linha traz produto, quantidade, unidade, valor comercial e local de estoque de origem (trânsito). O total da NF (com tributos) é do cabeçalho.
- **Produto recebido (item da NF)**: uma linha da NF em processo de recebimento — produto ACXE, quantidade física conferida, localidade de destino, correlato Q2P resolvido, valor rateado. Torna-se uma entrada de estoque independente.
- **Entrada de estoque (por produto)**: o registro que representa um produto recebido — sua movimentação em ACXE e Q2P, seu status de conclusão no OMIE, e o vínculo com a NF de origem (várias entradas compartilham a mesma NF).
- **Aprovação de divergência (por produto)**: pendência de aprovação do gestor para um produto cuja quantidade recebida divergiu da NF; carrega a classificação (faltando/varredura) e o motivo, e é independente por produto.
- **Correlação ACXE↔Q2P (por produto)**: o vínculo, por descrição textual, entre o produto ACXE da NF e o produto Q2P correspondente, mais o par de localidades; resolvido produto a produto e obrigatório para todos antes do recebimento.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% dos produtos de uma NF de importação multi-item recebida geram sua própria entrada de estoque em ACXE e Q2P — nenhum produto é perdido silenciosamente (elimina a perda de itens 2..n que existia antes do bloqueio).
- **SC-002**: As ~2 a 3 NFs de importação multi-produto por mês que hoje exigem processo manual no OMIE passam a ser recebidas **inteiramente pela plataforma**, sem intervenção manual no ERP.
- **SC-003**: O custo por quilo registrado para cada produto de uma NF multi-item corresponde à sua própria linha da NF (sem o valor total recair sobre o primeiro produto), e a soma dos valores dos produtos bate com o total da NF dentro do arredondamento.
- **SC-004**: Uma NF multi-item com um produto sem correlato na Q2P é bloqueada por inteiro, com o produto identificado, e produz **zero** movimentação de estoque — verificável por ausência de qualquer lançamento após a tentativa.
- **SC-005**: Numa NF multi-item com um produto divergente e os demais conferindo, os produtos que conferem entram no estoque enquanto apenas o divergente aguarda aprovação — a divergência de um produto não atrasa os demais.
- **SC-006**: Reprocessar uma NF multi-item já recebida não cria nenhum lançamento adicional no OMIE (idempotência preservada).

## Assumptions

- **Valoração por rateio**: mantém-se a base de custo atual (valor da NF com tributos embutidos). Como o valor com tributos existe só no total da NF, ele é rateado entre os produtos proporcionalmente ao valor comercial de cada um (valor unitário × quantidade). Alternativa considerada e descartada: usar o valor unitário comercial de cada item cru (sem tributos), o que reduziria a base de custo em relação ao praticado hoje. **Base de custo confirmada com o negócio em 15/07: com tributos, como hoje.** A fórmula de arredondamento/reconciliação de resíduo fica para a implementação.
- **ACXE-only**: a feature vale para o recebimento de importação (NF emitida pela ACXE, ajuste dual ACXE→Q2P). O recebimento nacional (multi-produto já existente) e o contexto Q2P puro não são alterados.
- **Reuso do fluxo de item único**: conferência (tolerância físico × fiscal), classificação de divergência (faltando/varredura), destinação da diferença a estoque especial, correlação por descrição textual, idempotência por NF e recuperação de pendência OMIE são **reaproveitados** do recebimento de importação atual, aplicados por produto — não reinventados.
- **Modelo de referência (nacional)**: o padrão de "N entradas + N aprovações independentes por NF, numa transação, com notificação consolidada ao gestor" e a UX de lista de itens (adicionar/remover/conferir por linha) seguem o recebimento nacional já em produção.
- **Origem dos dados da NF**: os N produtos, quantidades, unidades, valores e locais de origem vêm da consulta da NF ao OMIE (que já é feita hoje, hoje limitada ao primeiro produto). As validações fiscais (cancelada, emitente) continuam lendo do espelho sincronizado, como hoje.
- **Volume**: NFs multi-produto são ~3% das NFs de importação (baixo volume, alto valor de correção); a solução prioriza correção e rastreabilidade sobre otimização de throughput.

## Dependencies & Out of Scope

**Depende de**:
- Consulta de NF ao OMIE expondo todos os produtos da nota (hoje a integração lê a NF inteira mas descarta além do primeiro item).
- Cadastro/correlação dos produtos na Q2P (por descrição) — pré-condição operacional para receber (política tudo-ou-nada).

**Fora de escopo**:
- Recebimento parcial de NF (receber alguns produtos e deixar outros pendentes por falta de cadastro) — explicitamente descartado pela decisão tudo-ou-nada.
- Alterações no recebimento **nacional** (já multi-produto) ou no contexto Q2P puro.
- Tratamento de excedente (quantidade recebida maior que a NF) além do bloqueio já existente — permanece como registro separado manual.
- Multi-produto em outros fluxos (saída, comodato) — esta feature é sobre entrada por NF de importação.
