# Feature Specification: Controle de Inventário Físico (Físico × Sistema × Fiscal)

**Feature Branch**: `009-stockbridge-inventario-fisico`
**Created**: 2026-06-08
**Status**: Draft — **regras de negócio em debate** (ponto de partida; ver seção "Regras em Aberto")
**Jira**: [ACXEGDP-150](https://livemind.atlassian.net/browse/ACXEGDP-150) — subtarefa de [ACXEGDP-114 — Desenvolvimento Módulo Stockbridge](https://livemind.atlassian.net/browse/ACXEGDP-114)
**Input**: User description: "quero colocar aqui no stockbridge uma maneira de controlarmos os inventários físicos × sistema × fiscal. Quero ter dois tipos de inventários: total e parcial. Para o parcial, quero que o sistema gere para mim uma listagem de produtos a serem contados fisicamente; entre um parcial e outro devemos evitar recontagem dos mesmos, a não ser que no último inventário parcial o produto tenha tido uma divergência superior a 1%."

> **Nota de processo**: este documento é o ponto de partida acordado com o usuário ("vamos iniciar deste ponto"). As regras marcadas como `[EM DEBATE]` e listadas na seção **Regras em Aberto** ainda serão discutidas antes de `/speckit.plan`. O núcleo (tipos total/parcial, geração da lista rotativa, regra de recontagem por divergência > 1%) já está definido pelo usuário.

## Conceitos do Domínio

O StockBridge passa a reconciliar **três referências de quantidade** para cada produto em cada galpão físico:

- **Físico** — a quantidade real contada no galpão durante o inventário (medição humana).
- **Sistema** — o saldo gerencial registrado no Atlas (espelho do OMIE + camadas Atlas: trânsito, provisório). É o número que o Cockpit/StockBridge usa hoje. Fonte: `vw_posicaoEstoqueUnificadaFamilia` + camadas Atlas, sobre a *whitelist* de galpões físicos.
- **Fiscal** — a quantidade segundo a escrituração fiscal no OMIE (estoque/movimento fiscal, derivado de NFs). Pode divergir do Sistema por timing de emissão de NF, ajustes pendentes, etc.

**Divergência** é a diferença entre duas referências, expressa em quantidade (Kg na UI) e em percentual. O gatilho central da feature é: **divergência > 1%** força a recontagem do produto no próximo inventário parcial.

**Tipos de inventário:**

- **Total** — conta *todos* os produtos de um escopo (galpão/empresa) numa única campanha. Tradicionalmente exige parada da operação.
- **Parcial (rotativo / cíclico)** — conta um *subconjunto* de produtos por sessão. Ao longo de várias sessões, cobre todo o catálogo **sem repetir** produtos já contados no ciclo corrente — **exceto** os que tiveram divergência > 1% na última contagem parcial, que são re-incluídos.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Gerar a lista de contagem de um inventário parcial (Priority: P1)

Como operador de estoque, ao iniciar um inventário **parcial** quero que o sistema **gere automaticamente a lista de produtos a contar fisicamente**, de modo que eu não precise decidir manualmente o que contar nem recontar o que já foi conferido neste ciclo.

A lista gerada deve:
- **Excluir** os produtos já contados em parciais anteriores do **ciclo corrente** (evitar recontagem).
- **Re-incluir** os produtos cuja **última** contagem parcial apresentou **divergência > 1%** (precisam ser reconferidos).

**Why this priority**: é o coração do pedido — o diferencial do inventário rotativo é justamente o sistema dizer "conte estes". Sem isto, não há feature.

**Independent Test**: iniciar um parcial num escopo onde alguns produtos já foram contados (uns dentro do limiar, um acima de 1%) e verificar que a lista omite os já-contados conformes e inclui o divergente.

**Acceptance Scenarios**:

1. **Given** um ciclo de rotativo em andamento com os produtos A e B já contados (ambos com divergência ≤ 1%), **When** o operador inicia um novo inventário parcial, **Then** A e B **não** aparecem na lista de contagem.
2. **Given** o produto C foi contado na última parcial com divergência de 3% (> 1%), **When** o operador inicia um novo inventário parcial, **Then** C **aparece** na lista para recontagem.
3. **Given** um produto D nunca contado no ciclo corrente, **When** o operador inicia um inventário parcial, **Then** D é elegível para a lista.
4. **Given** todos os produtos do escopo já foram cobertos no ciclo, **When** o operador inicia uma nova parcial, **Then** o sistema sinaliza que o ciclo foi concluído e inicia um novo ciclo. `[EM DEBATE: o que reinicia o ciclo]`

---

### User Story 2 - Registrar contagem física e apurar divergência Físico × Sistema × Fiscal (Priority: P1)

Como operador, para cada produto da lista quero **registrar a quantidade contada** e ver imediatamente a **divergência contra o Sistema e contra o Fiscal**, em Kg e em %, para saber onde há problema.

**Why this priority**: contar sem apurar divergência não entrega valor; a apuração das três referências é o objetivo declarado ("físico × sistema × fiscal").

**Independent Test**: registrar uma contagem física para um produto e conferir que o sistema exibe corretamente as divergências físico×sistema e físico×fiscal, com sinalização de quem ultrapassa 1%.

**Acceptance Scenarios**:

1. **Given** um item na lista com Sistema = 100 Kg e Fiscal = 98 Kg, **When** o operador registra Físico = 95 Kg, **Then** o sistema mostra divergência físico×sistema = −5 Kg (−5%) e físico×fiscal = −3 Kg (−3,06%).
2. **Given** uma contagem registrada com divergência > 1%, **When** o item é salvo, **Then** ele fica marcado para recontagem na próxima parcial (alimenta a regra da US1).
3. **Given** uma contagem dentro do limiar (≤ 1%), **When** salva, **Then** o item é considerado conferido no ciclo e não retorna na próxima parcial.

---

### User Story 3 - Realizar inventário total (Priority: P2)

Como gestor, quero abrir um inventário **total** que cubra todos os produtos do escopo de uma vez, registrar todas as contagens e apurar todas as divergências — tipicamente em uma data de fechamento.

**Why this priority**: complementa o rotativo; é o modo "tudo de uma vez" exigido periodicamente (auditoria/fiscal). Reaproveita a contagem e a apuração de divergência da US2.

**Independent Test**: abrir um total, ver que a lista contém 100% dos produtos do escopo, registrar contagens e apurar divergências de todos.

**Acceptance Scenarios**:

1. **Given** um escopo com N produtos, **When** o gestor abre um inventário total, **Then** a lista de contagem contém os N produtos (sem exclusão por contagem prévia).
2. **Given** um inventário total concluído, **When** ele é fechado, **Then** o ciclo de rotativo é reiniciado (todos passam a constar como recém-conferidos). `[EM DEBATE: relação total ↔ ciclo do rotativo]`

---

### User Story 4 - Conciliar a divergência (registrar / ajustar) (Priority: P2)

Como gestor, a partir das divergências apuradas quero **decidir o tratamento**: registrar a divergência para análise e/ou gerar o **ajuste de estoque** correspondente, respeitando a aprovação hierárquica e a idempotência de ajustes já existentes no StockBridge.

**Why this priority**: fecha o ciclo de valor (inventário que não corrige nada vira só relatório). Depende de definição de negócio (ver Regras em Aberto).

**Independent Test**: para um item divergente, acionar a conciliação e verificar que o caminho escolhido (registro e/ou ajuste) é executado e auditado.

**Acceptance Scenarios**:

1. **Given** um item com divergência apurada, **When** o gestor confirma a conciliação como "apenas registrar", **Then** a divergência fica registrada e auditada, sem alterar saldo.
2. **Given** um item com divergência apurada, **When** o gestor confirma a conciliação como "ajustar", **Then** um ajuste de estoque é gerado seguindo o fluxo de aprovação/idempotência existente. `[EM DEBATE: se/como o inventário gera ajuste no ERP]`

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
- **Divergência exatamente = 1%**: o limiar é estritamente "> 1%" (1% exato **não** força recontagem). Confirmar inclusividade.
- **Movimentação (recebimento/saída) entre a contagem e o fechamento do ciclo**: a contagem registrada continua válida? O Sistema usado na divergência é o snapshot do momento da contagem ou o atual? `[EM DEBATE]`
- **Inventário total iniciado no meio de um ciclo parcial**: reseta o ciclo? `[EM DEBATE]`
- **Recontagem persistente**: se um produto re-incluído continua > 1% após a recontagem, ele volta indefinidamente nas próximas parciais? Há limite/escalonamento?
- **Produto em trânsito / provisório (camadas Atlas)**: entra na contagem física? Conta como Sistema? (provável: contagem física cobre apenas saldo realmente presente no galpão).
- **Escopo por galpão**: produto presente em mais de um galpão é contado por galpão (divergência por local), não agregado.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O sistema MUST permitir registrar dois tipos de inventário: **total** e **parcial**.
- **FR-002**: Para o inventário **parcial**, o sistema MUST **gerar automaticamente** a lista de produtos a serem contados fisicamente.
- **FR-003**: A lista do parcial MUST **excluir** produtos já contados em parciais anteriores do **ciclo corrente** (evitar recontagem).
- **FR-004**: A lista do parcial MUST **re-incluir** produtos cuja **última** contagem parcial teve **divergência > 1%**.
- **FR-005**: O sistema MUST permitir registrar, por item, a **quantidade física contada** (em Kg na UI).
- **FR-006**: O sistema MUST apurar e exibir, por item, a divergência **físico × sistema** e **físico × fiscal**, em quantidade e em percentual.
- **FR-007**: O sistema MUST persistir o **histórico de contagens** por produto e por inventário (ciclo, data/hora, responsável, valores das três referências, divergência resultante).
- **FR-008**: O sistema MUST controlar o **ciclo do rotativo** — saber quais produtos do escopo já foram cobertos e quando o ciclo se encerra/reinicia.
- **FR-009**: O sistema MUST registrar **trilha de auditoria** de quem iniciou, contou e conciliou cada inventário/contagem (Princípio IV — `shared.audit_log`).
- **FR-010**: O sistema MUST exibir quantidades em **Kg** na interface, mantendo a base em toneladas (convenção StockBridge).
- **FR-011**: O sistema MUST permitir definir o **escopo** do inventário (ao menos por galpão; possivelmente por família/empresa). `[EM DEBATE: granularidade do escopo]`
- **FR-012**: O sistema MUST permitir, a partir das divergências, ao menos **registrar** a divergência para análise; o **ajuste de estoque** decorrente é `[EM DEBATE]` (ver Regras em Aberto).
- **FR-013**: O critério de **seleção/tamanho** da lista parcial (quantos e quais produtos por sessão) MUST seguir [NEEDS CLARIFICATION: estratégia de seleção — todos os não-contados do escopo? lote de tamanho fixo? curva ABC por valor? por família? meta de cobertura por período?].
- **FR-014**: A referência usada para o gatilho de **divergência > 1%** MUST ser [NEEDS CLARIFICATION: físico×sistema, físico×fiscal, ou a maior das duas; e em quantidade ou em valor?].
- **FR-015**: O tratamento da divergência apurada MUST [NEEDS CLARIFICATION: apenas registrar; ou gerar ajuste no ERP (qual referência ajusta — sistema, fiscal ou ambas) sob aprovação/idempotência existentes?].

### Key Entities *(include if feature involves data)*

- **Inventário (cabeçalho)** — representa uma campanha de contagem. Atributos: tipo (total/parcial), escopo (galpão/empresa/família), ciclo associado, status (aberto/em contagem/conciliação/fechado), datas, responsável.
- **Item de Inventário / Contagem** — uma linha por produto contado. Atributos: produto, quantidade física contada, snapshot de quantidade Sistema, snapshot de quantidade Fiscal, divergências (qtd e %) por referência, flag "divergência > 1%", status do item.
- **Ciclo de Rotativo** — agrupa as parciais até cobrir o escopo. Controla quais produtos já foram contados e a % de cobertura; sabe quando reiniciar.
- **Divergência** — resultado por item: valor absoluto, percentual, referência comparada, classificação (dentro/fora do limiar).
- **Conciliação / Ajuste** *(escopo condicional)* — vínculo opcional entre uma divergência e um ajuste de estoque (fluxo de aprovação + idempotência OMIE existentes). `[EM DEBATE]`

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Ao iniciar um inventário parcial, o operador recebe a lista de produtos a contar em até 5 segundos.
- **SC-002**: Dentro de um mesmo ciclo de rotativo, **nenhum** produto é listado mais de uma vez, **exceto** os re-incluídos por divergência > 1% (0 recontagens indevidas em auditoria).
- **SC-003**: Ao fim de um ciclo de rotativo, **100%** dos produtos do escopo foram cobertos pelo menos uma vez.
- **SC-004**: Para **100%** dos itens contados, o sistema apresenta a divergência físico×sistema e físico×fiscal sem cálculo manual do operador.
- **SC-005**: O inventário rotativo permite cobrir todo o catálogo do escopo em múltiplas sessões **sem exigir parada total** da operação (diferente do inventário total).
- **SC-006**: **100%** das contagens e conciliações são auditáveis (quem, quando, valores antes/depois das três referências).
- **SC-007**: Produtos com divergência > 1% reaparecem na **próxima** parcial em 100% dos casos (regra de recontagem verificável).

## Assumptions

- O escopo de contagem usa os **galpões físicos** já adotados no StockBridge (whitelist de códigos de estoque OMIE; exclui operacionais 10.x/20.x; trata 90.0.2 como Trânsito Interno e 90.0.1 como Comodato). Ver memória `codigos-estoque-omie`.
- **Sistema** = saldo gerencial do Atlas (espelho OMIE + camadas Atlas). **Fiscal** = estoque/movimento fiscal do OMIE.
- Quantidades exibidas em **Kg** na UI; base em toneladas (convenção `convencao-kg`).
- Papéis e permissões seguem o **modelo hierárquico existente** do StockBridge (operador / gestor / diretor); se a conciliação gerar ajuste, ele segue **aprovação + idempotência OMIE** já implementadas.
- Divergência percentual calculada como `|físico − referência| / referência`, por padrão em **quantidade**.
- Limiar de recontagem: **estritamente > 1%** (1% exato não força recontagem).
- A feature respeita os princípios do StockBridge: leitura de saldo via OMIE/espelho PG; escrita fiscal no OMIE apenas via os caminhos já excepcionados (ajuste de estoque).
- Não está em escopo (v1): contagem por leitor de código de barras / coletor móvel dedicado; reconciliação automática sem revisão humana.

## Regras em Aberto (a debater antes do `/speckit.plan`)

Itens que o usuário sinalizou que ainda vai debater. São decisões de **negócio**, não técnicas:

1. **Seleção/tamanho da lista parcial** (FR-013): o sistema oferece *todos* os não-contados do escopo, um **lote de tamanho fixo**, ou prioriza por **curva ABC/valor**, por **família**, por **antiguidade da última contagem**, ou por **meta de cobertura** (ex.: "cobrir 100% a cada 90 dias")?
2. **Referência da divergência de 1%** (FR-014): o gatilho de recontagem mede físico×**sistema**, físico×**fiscal**, ou a **maior** das duas? Em **quantidade** ou em **valor**?
3. **Tratamento da divergência** (FR-015): o inventário **apenas registra** a divergência, ou **gera ajuste** no ERP? Se ajusta, qual referência ele corrige — **sistema**, **fiscal** ou **ambas** — e sob qual aprovação?
4. **Definição e reinício do ciclo** (US1 cenário 4, US3 cenário 2): o que fecha/reinicia um ciclo de rotativo — cobertura de 100% do escopo, um **fechamento periódico** (mensal?), ou a realização de um **inventário total**?
5. **Snapshot vs. tempo real** (Edge case): a divergência usa o saldo de Sistema **no momento da contagem** (congelado) ou o **atual**? Movimentações entre a contagem e o fechamento invalidam a contagem?
6. **Recontagem persistente** (Edge case): se um produto re-incluído continua > 1%, há **limite** de repetições ou **escalonamento** (ex.: vira pendência para o gestor)?
