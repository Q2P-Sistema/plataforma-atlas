# Feature Specification: Controle de Inventário Físico (Físico × Sistema × Fiscal)

**Feature Branch**: `009-stockbridge-inventario-fisico`
**Created**: 2026-06-08
**Status**: Draft — **4 de 6 regras de negócio já decididas** (P1-P4, sessão 2026-07-08); ver seção "Regras em Aberto" para o que falta antes do `/speckit.plan`
**Jira**: [ACXEGDP-150](https://livemind.atlassian.net/browse/ACXEGDP-150) — subtarefa de [ACXEGDP-114 — Desenvolvimento Módulo Stockbridge](https://livemind.atlassian.net/browse/ACXEGDP-114)
**Input**: User description: "quero colocar aqui no stockbridge uma maneira de controlarmos os inventários físicos × sistema × fiscal. Quero ter dois tipos de inventários: total e parcial. Para o parcial, quero que o sistema gere para mim uma listagem de produtos a serem contados fisicamente; entre um parcial e outro devemos evitar recontagem dos mesmos, a não ser que no último inventário parcial o produto tenha tido uma divergência superior a 1%."

> **Nota de processo**: este documento é o ponto de partida acordado com o usuário ("vamos iniciar deste ponto"). As regras marcadas como `[EM DEBATE]` e listadas na seção **Regras em Aberto** ainda serão discutidas antes de `/speckit.plan`. O núcleo (tipos total/parcial, geração da lista rotativa, regra de recontagem por divergência) já está definido pelo usuário.
>
> **Atualização 2026-07-08**: as perguntas P1-P4 registradas no Jira (ACXEGDP-150) foram respondidas — threshold de recontagem corrigido de 1% para **0,1%** (alinhado à meta de acurácia de 99,9%), priorização fixa dos critérios da lista parcial, tratamento pós-apuração (ajuste sob aprovação, cíclico e geral) e contagem dupla no geral (2 operadores independentes). Ver seção "Regras em Aberto" para o detalhe e o que ainda falta.

## Conceitos do Domínio

O StockBridge passa a reconciliar **três referências de quantidade** para cada produto em cada galpão físico:

- **Físico** — a quantidade real contada no galpão durante o inventário (medição humana).
- **Sistema** — o saldo gerencial registrado no Atlas (espelho do OMIE + camadas Atlas: trânsito, provisório). É o número que o Cockpit/StockBridge usa hoje. Fonte: `vw_posicaoEstoqueUnificadaFamilia` + camadas Atlas, sobre a *whitelist* de galpões físicos.
- **Fiscal** — a quantidade segundo a escrituração fiscal no OMIE (estoque/movimento fiscal, derivado de NFs). Pode divergir do Sistema por timing de emissão de NF, ajustes pendentes, etc.

**Divergência** é a diferença entre duas referências, expressa em quantidade (Kg na UI) e em percentual. O gatilho central da feature é: **divergência > 0,1%** força a recontagem do produto no próximo inventário parcial (threshold alinhado à meta de acurácia de 99,9% — decisão P1, 2026-07-08; substitui o ">1%" da formulação original do usuário).

**Tipos de inventário:**

- **Total** — conta *todos* os produtos de um escopo (galpão/empresa) numa única campanha. Tradicionalmente exige parada da operação.
- **Parcial (rotativo / cíclico)** — conta um *subconjunto* de produtos por sessão. Ao longo de várias sessões, cobre todo o catálogo **sem repetir** produtos já contados no ciclo corrente — **exceto** os que tiveram divergência > 0,1% na última contagem parcial, que são re-incluídos.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Gerar a lista de contagem de um inventário parcial (Priority: P1)

Como operador de estoque, ao iniciar um inventário **parcial** quero que o sistema **gere automaticamente a lista de produtos a contar fisicamente**, de modo que eu não precise decidir manualmente o que contar nem recontar o que já foi conferido neste ciclo.

A lista gerada deve:
- **Excluir** os produtos já contados em parciais anteriores do **ciclo corrente** (evitar recontagem).
- **Re-incluir** os produtos cuja **última** contagem parcial apresentou **divergência > 0,1%** (precisam ser reconferidos).

**Why this priority**: é o coração do pedido — o diferencial do inventário rotativo é justamente o sistema dizer "conte estes". Sem isto, não há feature.

**Independent Test**: iniciar um parcial num escopo onde alguns produtos já foram contados (uns dentro do limiar, um acima de 0,1%) e verificar que a lista omite os já-contados conformes e inclui o divergente.

**Acceptance Scenarios**:

1. **Given** um ciclo de rotativo em andamento com os produtos A e B já contados (ambos com divergência ≤ 0,1%), **When** o operador inicia um novo inventário parcial, **Then** A e B **não** aparecem na lista de contagem.
2. **Given** o produto C foi contado na última parcial com divergência de 3% (> 0,1%), **When** o operador inicia um novo inventário parcial, **Then** C **aparece** na lista para recontagem.
3. **Given** um produto D nunca contado no ciclo corrente, **When** o operador inicia um inventário parcial, **Then** D é elegível para a lista.
4. **Given** todos os produtos do escopo já foram cobertos no ciclo, **When** o operador inicia uma nova parcial, **Then** o sistema sinaliza que o ciclo foi concluído e inicia um novo ciclo. `[EM DEBATE: o que reinicia o ciclo]`

---

### User Story 2 - Registrar contagem física e apurar divergência Físico × Sistema × Fiscal (Priority: P1)

Como operador, para cada produto da lista quero **registrar a quantidade contada** e ver imediatamente a **divergência contra o Sistema e contra o Fiscal**, em Kg e em %, para saber onde há problema.

**Why this priority**: contar sem apurar divergência não entrega valor; a apuração das três referências é o objetivo declarado ("físico × sistema × fiscal").

**Independent Test**: registrar uma contagem física para um produto e conferir que o sistema exibe corretamente as divergências físico×sistema e físico×fiscal, com sinalização de quem ultrapassa 0,1%.

**Acceptance Scenarios**:

1. **Given** um item na lista com Sistema = 100 Kg e Fiscal = 98 Kg, **When** o operador registra Físico = 95 Kg, **Then** o sistema mostra divergência físico×sistema = −5 Kg (−5%) e físico×fiscal = −3 Kg (−3,06%).
2. **Given** uma contagem registrada com divergência > 0,1%, **When** o item é salvo, **Then** ele fica marcado para recontagem na próxima parcial (alimenta a regra da US1).
3. **Given** uma contagem dentro do limiar (≤ 0,1%), **When** salva, **Then** o item é considerado conferido no ciclo e não retorna na próxima parcial.

---

### User Story 3 - Realizar inventário total (Priority: P2)

Como gestor, quero abrir um inventário **total** que cubra todos os produtos do escopo de uma vez, registrar a **contagem dupla** exigida (2 operadores independentes, decisão P4 — 2026-07-08) e apurar todas as divergências — tipicamente em uma data de fechamento.

**Contagem dupla (P4)**: cada produto do inventário total é contado por **2 operadores independentes**, sem que um veja o resultado do outro antes de ambos registrarem. O sistema cruza os dois valores; se estiverem dentro de uma tolerância (a definir — ver Regras em Aberto), a contagem final segue para a apuração da US2. Se divergirem entre si além da tolerância, o item fica sinalizado para o gestor resolver (recontagem ou decisão manual) antes de apurar a divergência físico×sistema×fiscal.

**Why this priority**: complementa o rotativo; é o modo "tudo de uma vez" exigido periodicamente (auditoria/fiscal), com a garantia adicional da contagem dupla. Reaproveita a apuração de divergência da US2, mas a captura da contagem física é diferente (2 valores independentes, não 1).

**Independent Test**: abrir um total, ver que a lista contém 100% dos produtos do escopo, registrar as duas contagens independentes por item e apurar divergências de todos.

**Acceptance Scenarios**:

1. **Given** um escopo com N produtos, **When** o gestor abre um inventário total, **Then** a lista de contagem contém os N produtos (sem exclusão por contagem prévia).
2. **Given** um item do inventário total, **When** o operador A registra sua contagem, **Then** o operador B **não** vê o valor de A antes de registrar a própria contagem (independência).
3. **Given** as duas contagens registradas dentro da tolerância de cruzamento, **When** o sistema cruza os valores, **Then** o item segue para apuração de divergência (US2) com a contagem final resultante (regra de consolidação a definir — ver Regras em Aberto).
4. **Given** as duas contagens registradas fora da tolerância de cruzamento, **When** o sistema cruza os valores, **Then** o item fica sinalizado para o gestor resolver antes de prosseguir para a apuração.
5. **Given** um inventário total concluído, **When** ele é fechado, **Then** o ciclo de rotativo é reiniciado (todos passam a constar como recém-conferidos). `[EM DEBATE: relação total ↔ ciclo do rotativo]`

---

### User Story 4 - Conciliar a divergência (registrar / ajustar) (Priority: P2)

Como gestor, a partir das divergências apuradas quero **decidir o tratamento**: registrar a divergência para análise e/ou gerar o **ajuste de estoque** correspondente, respeitando a aprovação hierárquica e a idempotência de ajustes já existentes no StockBridge.

**Decisão P3 (2026-07-08)**: tanto o inventário **cíclico (parcial)** quanto o **geral (total)** podem gerar ajuste de estoque no OMIE **sob aprovação do gestor**, reaproveitando o fluxo hierárquico e a idempotência já existentes (`stockbridge.aprovacao`). Não há distinção por tipo de inventário — a escolha entre "apenas registrar" e "ajustar" é sempre do gestor, por item.

**Why this priority**: fecha o ciclo de valor (inventário que não corrige nada vira só relatório).

**Independent Test**: para um item divergente, acionar a conciliação e verificar que o caminho escolhido (registro e/ou ajuste) é executado e auditado.

**Acceptance Scenarios**:

1. **Given** um item com divergência apurada (cíclico ou geral), **When** o gestor confirma a conciliação como "apenas registrar", **Then** a divergência fica registrada e auditada, sem alterar saldo.
2. **Given** um item com divergência apurada (cíclico ou geral), **When** o gestor confirma a conciliação como "ajustar", **Then** um ajuste de estoque é gerado seguindo o fluxo de aprovação/idempotência existente (`stockbridge.aprovacao`).

---

### User Story 5 - Histórico, status do ciclo e auditoria (Priority: P3)

Como gestor, quero consultar inventários passados, ver o **status de cobertura do ciclo de rotativo** (quantos % do escopo já foi contado) e a **trilha de auditoria** (quem iniciou, quem contou, quem conciliou, valores antes/depois).

**Why this priority**: necessário para governança e para a validação paralela, mas não bloqueia o uso básico.

**Independent Test**: após algumas parciais, consultar o painel e verificar a % de cobertura do ciclo e a trilha de quem fez o quê.

**Acceptance Scenarios**:

1. **Given** 3 parciais realizadas cobrindo 40% do escopo, **When** o gestor abre o status do ciclo, **Then** vê "40% coberto" e a lista do que falta.
2. **Given** uma contagem registrada, **When** consultada no histórico, **Then** mostra responsável, data/hora, valores físico/sistema/fiscal e divergência.

### Edge Cases

- **Produto sem saldo de Sistema** (zerado) com físico positivo, ou vice-versa: a divergência percentual tende a ∞ — como sinalizar? (provável: tratar como divergência total / 100%).
- **Produto novo** sem histórico de contagem: elegível na próxima parcial.
- **Divergência exatamente = 0,1%**: o limiar é estritamente "> 0,1%" (0,1% exato **não** força recontagem) — confirmado na decisão P1 (2026-07-08).
- **Movimentação (recebimento/saída) entre a contagem e o fechamento do ciclo**: a contagem registrada continua válida? O Sistema usado na divergência é o snapshot do momento da contagem ou o atual? `[EM DEBATE]`
- **Inventário total iniciado no meio de um ciclo parcial**: reseta o ciclo? `[EM DEBATE]`
- **Recontagem persistente**: se um produto re-incluído continua > 0,1% após a recontagem, ele volta indefinidamente nas próximas parciais? Há limite/escalonamento? `[EM DEBATE]`
- **Contagem dupla fora da tolerância de cruzamento** (US3/P4): qual a tolerância entre as 2 contagens independentes, e o que acontece quando ela é excedida — 3ª contagem, decisão manual do gestor, ou outro critério de desempate? `[EM DEBATE]`
- **Produto em trânsito / provisório (camadas Atlas)**: entra na contagem física? Conta como Sistema? (provável: contagem física cobre apenas saldo realmente presente no galpão).
- **Escopo por galpão**: produto presente em mais de um galpão é contado por galpão (divergência por local), não agregado.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O sistema MUST permitir registrar dois tipos de inventário: **total** e **parcial**.
- **FR-002**: Para o inventário **parcial**, o sistema MUST **gerar automaticamente** a lista de produtos a serem contados fisicamente.
- **FR-003**: A lista do parcial MUST **excluir** produtos já contados em parciais anteriores do **ciclo corrente** (evitar recontagem).
- **FR-004**: A lista do parcial MUST **re-incluir** produtos cuja **última** contagem parcial teve **divergência > 0,1%** (decisão P1, 2026-07-08).
- **FR-005**: O sistema MUST permitir registrar, por item, a **quantidade física contada** (em Kg na UI).
- **FR-006**: O sistema MUST apurar e exibir, por item, a divergência **físico × sistema** e **físico × fiscal**, em quantidade e em percentual.
- **FR-007**: O sistema MUST persistir o **histórico de contagens** por produto e por inventário (ciclo, data/hora, responsável, valores das três referências, divergência resultante).
- **FR-008**: O sistema MUST controlar o **ciclo do rotativo** — saber quais produtos do escopo já foram cobertos e quando o ciclo se encerra/reinicia.
- **FR-009**: O sistema MUST registrar **trilha de auditoria** de quem iniciou, contou e conciliou cada inventário/contagem (Princípio IV — `shared.audit_log`).
- **FR-010**: O sistema MUST exibir quantidades em **Kg** na interface, mantendo a base em toneladas (convenção StockBridge).
- **FR-011**: O sistema MUST permitir definir o **escopo** do inventário (ao menos por galpão; possivelmente por família/empresa). `[EM DEBATE: granularidade do escopo]`
- **FR-012**: O sistema MUST permitir, a partir das divergências, **registrar** a divergência para análise **e/ou gerar ajuste de estoque no OMIE sob aprovação do gestor**, reaproveitando o fluxo hierárquico e a idempotência já existentes (`stockbridge.aprovacao`) — decisão P3 (2026-07-08), válida para inventário cíclico e geral.
- **FR-013**: A lista do parcial MUST ser selecionada pelos **4 critérios já definidos pelo inventariante** (divergência na última contagem, movimentação manual na semana anterior, saldo baixo, saldo alto), em **ordem de prioridade fixa** — divergência anterior → movimentação manual → saldo baixo → saldo alto — até o **cap de 150.000–200.000 kg** por sessão (decisão P2, 2026-07-08). `[EM DEBATE residual: critério de desempate dentro de um mesmo bucket, e se o cap pode ser ultrapassado para caber um produto inteiro do bucket de maior prioridade]`
- **FR-014**: A referência usada para o gatilho de **divergência > 0,1%** (threshold decidido em P1) MUST ser [NEEDS CLARIFICATION: físico×sistema, físico×fiscal, ou a maior das duas; e em quantidade ou em valor?].
- **FR-015**: O tratamento da divergência apurada MUST permitir **apenas registrar** OU **gerar ajuste no OMIE sob aprovação** (decisão P3, 2026-07-08 — resolvido para ambos os tipos de inventário). `[EM DEBATE residual: qual referência o ajuste corrige — o ajuste OMIE só reconcilia físico×sistema; uma divergência físico×fiscal pura não tem ajuste equivalente nesse fluxo, ver nuance técnica levantada na sessão 2026-07-08]`
- **FR-016**: O inventário **geral (total)** MUST exigir **contagem dupla por 2 operadores independentes** por item — o segundo operador não pode ver o valor do primeiro antes de registrar sua própria contagem, e o sistema MUST cruzar os dois valores antes de prosseguir para a apuração (decisão P4, 2026-07-08). `[EM DEBATE: tolerância de cruzamento entre as 2 contagens, e o desempate quando ela é excedida]`

### Key Entities *(include if feature involves data)*

- **Inventário (cabeçalho)** — representa uma campanha de contagem. Atributos: tipo (total/parcial), escopo (galpão/empresa/família), ciclo associado, status (aberto/em contagem/conciliação/fechado), datas, responsável.
- **Item de Inventário / Contagem** — uma linha por produto contado. Atributos: produto, quantidade física contada (1 valor no parcial; **2 valores independentes** — contagem1/contagem2 — no inventário geral, decisão P4), snapshot de quantidade Sistema, snapshot de quantidade Fiscal, divergências (qtd e %) por referência, flag "divergência > 0,1%", status do item.
- **Ciclo de Rotativo** — agrupa as parciais até cobrir o escopo. Controla quais produtos já foram contados e a % de cobertura; sabe quando reiniciar.
- **Divergência** — resultado por item: valor absoluto, percentual, referência comparada, classificação (dentro/fora do limiar).
- **Conciliação / Ajuste** — vínculo entre uma divergência e um ajuste de estoque no OMIE, sob aprovação do gestor (fluxo de aprovação + idempotência já existentes — `stockbridge.aprovacao`). Disponível para os dois tipos de inventário (decisão P3, 2026-07-08).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Ao iniciar um inventário parcial, o operador recebe a lista de produtos a contar em até 5 segundos.
- **SC-002**: Dentro de um mesmo ciclo de rotativo, **nenhum** produto é listado mais de uma vez, **exceto** os re-incluídos por divergência > 0,1% (0 recontagens indevidas em auditoria).
- **SC-003**: Ao fim de um ciclo de rotativo, **100%** dos produtos do escopo foram cobertos pelo menos uma vez.
- **SC-004**: Para **100%** dos itens contados, o sistema apresenta a divergência físico×sistema e físico×fiscal sem cálculo manual do operador.
- **SC-005**: O inventário rotativo permite cobrir todo o catálogo do escopo em múltiplas sessões **sem exigir parada total** da operação (diferente do inventário total).
- **SC-006**: **100%** das contagens e conciliações são auditáveis (quem, quando, valores antes/depois das três referências).
- **SC-007**: Produtos com divergência > 0,1% reaparecem na **próxima** parcial em 100% dos casos (regra de recontagem verificável).
- **SC-008**: Em 100% dos itens do inventário geral, o segundo operador registra sua contagem **sem visibilidade** do valor do primeiro (contagem dupla independente, decisão P4).

## Assumptions

- O escopo de contagem usa os **galpões físicos** já adotados no StockBridge (whitelist de códigos de estoque OMIE; exclui operacionais 10.x/20.x; trata 90.0.2 como Trânsito Interno e 90.0.1 como Comodato). Ver memória `codigos-estoque-omie`.
- **Sistema** = saldo gerencial do Atlas (espelho OMIE + camadas Atlas). **Fiscal** = estoque/movimento fiscal do OMIE.
- Quantidades exibidas em **Kg** na UI; base em toneladas (convenção `convencao-kg`).
- Papéis e permissões seguem o **modelo hierárquico existente** do StockBridge (operador / gestor / diretor); se a conciliação gerar ajuste, ele segue **aprovação + idempotência OMIE** já implementadas.
- Divergência percentual calculada como `|físico − referência| / referência`, por padrão em **quantidade**.
- Limiar de recontagem: **estritamente > 0,1%** (0,1% exato não força recontagem) — decisão P1, 2026-07-08.
- A feature respeita os princípios do StockBridge: leitura de saldo via OMIE/espelho PG; escrita fiscal no OMIE apenas via os caminhos já excepcionados (ajuste de estoque).
- **Nuance técnica a validar (decisão P3)**: o ajuste de estoque no OMIE só reconcilia **Físico × Sistema** (o "Sistema" é o espelho do saldo OMIE) — não corrige a escrituração **Fiscal** (derivada de NF, Princípio II). Uma divergência puramente Físico×Fiscal provavelmente só pode ser **registrada**, não ajustada por esse fluxo; confirmar antes do `/speckit.plan`.
- Não está em escopo (v1): contagem por leitor de código de barras / coletor móvel dedicado; reconciliação automática sem revisão humana; 3ª contagem automatizada para desempate da contagem dupla (v1 assume resolução manual pelo gestor).

## Regras em Aberto

### Resolvidas (sessão 2026-07-08 — respostas P1-P4 do Jira ACXEGDP-150)

1. ~~**Seleção/tamanho da lista parcial** (FR-013)~~ — **RESOLVIDO (P2)**: os 4 critérios já definidos pelo inventariante (divergência anterior, movimentação manual, saldo baixo, saldo alto), em **ordem de prioridade fixa** (nessa ordem), preenchendo até o cap de 150-200 mil kg. Resta apenas o desempate dentro de um mesmo bucket como detalhe técnico de implementação, não decisão de negócio.
2. ~~**Threshold da divergência de recontagem**~~ — **RESOLVIDO (P1)**: **0,1%**, alinhado à meta de acurácia de 99,9% (substitui o 1% original). A **referência** usada (sistema/fiscal/maior) permanece aberta — ver item 5 abaixo.
3. ~~**Tratamento da divergência** (FR-015)~~ — **RESOLVIDO (P3)**: ambos os tipos de inventário podem **gerar ajuste no OMIE sob aprovação do gestor**, reaproveitando `stockbridge.aprovacao`. Resta a nuance técnica de que o ajuste só reconcilia Físico×Sistema, não Fiscal (ver Assumptions).
4. ~~**Contagem dupla no geral**~~ — **RESOLVIDO (P4)**: 2 operadores independentes, sistema cruza os valores. A **tolerância** de cruzamento entre as 2 contagens permanece aberta — ver item 9 abaixo.

### Ainda em aberto (a debater antes do `/speckit.plan`)

5. **Referência da divergência de 0,1%** (FR-014): o gatilho de recontagem mede físico×**sistema**, físico×**fiscal**, ou a **maior** das duas? Em **quantidade** ou em **valor**? Proposta técnica caso o usuário não decida: `max` das duas (mais conservador).
6. **Definição e reinício do ciclo** (US1 cenário 4, US3 cenário 5): o que fecha/reinicia um ciclo de rotativo — cobertura de 100% do escopo, um **fechamento periódico** (mensal?), ou a realização de um **inventário total**?
7. **Snapshot vs. tempo real** (Edge case): a divergência usa o saldo de Sistema **no momento da contagem** (congelado) ou o **atual**? Movimentações entre a contagem e o fechamento invalidam a contagem?
8. **Recontagem persistente** (Edge case): se um produto re-incluído continua > 0,1%, há **limite** de repetições ou **escalonamento** (ex.: vira pendência para o gestor)?
9. **Tolerância de cruzamento da contagem dupla** (US3/P4): qual a diferença máxima aceitável entre as 2 contagens independentes antes de sinalizar para o gestor? Pode ser diferente do threshold de recontagem de 0,1% — um mede fidelidade entre 2 operadores, o outro mede fidelidade do Físico contra o Sistema/Fiscal.
10. **Granularidade do escopo** (FR-011): 1 galpão por inventário (mais simples, alinhado ao Edge Case "por galpão, não agregado"), ou múltiplos galpões de uma vez? Mais barato decidir agora do que depois de gerar dados/migration.
