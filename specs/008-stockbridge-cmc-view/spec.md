# Feature Specification: StockBridge — Visão de CMC por Família e Produto

**Feature Branch**: `008-stockbridge-cmc-view`
**Created**: 2026-06-08
**Status**: Draft
**Input**: User description: "StockBridge: visao de CMC (custo medio ponderado) por familia e produto" (ref. memória `projeto-cmc-stockbridge.md`, card Jira ACXEGDP-149)

## User Scenarios & Testing *(mandatory)*

A visão de CMC (Custo Médio Contábil ponderado) já existe formatada no projeto de workflows (n8n) e alimenta um histórico diário de estoque por produto. Esta feature traz essa visão para dentro do StockBridge, onde o gestor e o diretor já operam o estoque físico — eliminando a necessidade de abrir outra ferramenta (Metabase) para enxergar o custo do que está em estoque.

**Estrutura de navegação:**
- Um **item de menu próprio** no StockBridge — rótulo proposto **"Custos de Estoque"** (ajustável; o conceito interno é CMC). Visível apenas para os papéis com acesso (ver FR-013).
- A página tem **duas abas**:
  - **Snapshot diário** — posição atual de CMC, com a lista de **famílias** e a árvore de **produtos** dentro de cada família (US1).
  - **Tendência histórica** — evolução do CMC ao longo do tempo a partir dos snapshots diários (US2).

### User Story 1 - Aba Snapshot diário: CMC por família com árvore de produtos (Priority: P1)

O gestor de supply chain (ou diretor) precisa enxergar, na posição de estoque mais recente, quanto vale em média o material que está parado em estoque. Na aba **Snapshot diário**, ele vê a **lista de famílias** — cada uma mostrando CMC médio ponderado (R$/kg), volume total (kg) e valor total imobilizado (R$), com a quebra entre **Importado** e **Nacional**. Ao **clicar numa família**, ela se **expande no lugar** revelando a **árvore de produtos (PN)** daquela família, no estilo de pastas do Windows Explorer (expande/recolhe), sem trocar de tela. Cada produto exibe o mesmo conjunto de métricas.

**Why this priority**: É o coração da feature e entrega valor sozinha — saber o custo médio do estoque por família/produto é o que motiva o pedido. Sem isso, nada mais importa. É independentemente testável e demonstrável com um único snapshot.

**Independent Test**: Pode ser testado abrindo a aba com pelo menos um dia de dados disponível e verificando que cada família exibe CMC ponderado, volume e valor corretos, que clicar na família expande a árvore de produtos, que a soma dos produtos reconcilia com o total da família, e que a quebra por origem bate com o total.

**Acceptance Scenarios**:

1. **Given** existe a posição de estoque do dia mais recente, **When** o usuário abre a aba Snapshot diário, **Then** cada família é listada (recolhida por padrão) com CMC médio ponderado (R$/kg), volume total (kg) e valor total (R$), além da quebra Importado vs. Nacional.
2. **Given** a aba Snapshot diário aberta, **When** o usuário a visualiza, **Then** no topo (abaixo dos filtros) aparece um resumo global com quantidade total em estoque (kg) e valor total do estoque (R$), respeitando os filtros aplicados, e **sem** um "CMC global".
3. **Given** uma família recolhida na lista, **When** o usuário clica na família, **Then** ela se expande no lugar mostrando a árvore de produtos (PN) daquela família — cada produto com seu CMC, volume e valor — e exibe um indicador visual de expandido/recolhido (estilo pasta).
4. **Given** uma família expandida, **When** o usuário clica novamente nela, **Then** a árvore de produtos recolhe e volta a exibir apenas a linha-resumo da família.
5. **Given** uma família expandida, **When** o usuário observa os produtos, **Then** a soma dos volumes e valores dos produtos reconcilia com o total da família.
6. **Given** um produto que existe tanto como Importado quanto Nacional, **When** o usuário visualiza esse produto na árvore, **Then** as duas origens aparecem separadas e o CMC ponderado de cada origem é calculado sobre o volume daquela origem.
7. **Given** que o cálculo do CMC ponderado é `Σ valor_total_cmc ÷ Σ volume_total`, **When** uma família agrega múltiplos produtos, **Then** o CMC da família é a média ponderada pelo volume (não a média aritmética dos CMCs dos produtos).

---

### User Story 2 - Aba Tendência histórica: evolução do CMC (Priority: P2)

O gestor/diretor precisa entender se o custo médio do estoque está subindo ou caindo ao longo do tempo, para apoiar decisões de compra e precificação. Na aba **Tendência histórica**, usando o histórico diário, ele seleciona um período e vê a evolução do CMC ponderado de uma família (e, opcionalmente, de um produto), podendo comparar origens.

**Why this priority**: Agrega muito valor analítico, mas depende da existência da visão atual (US1) e de histórico acumulado. Não é necessária para o primeiro valor entregável.

**Independent Test**: Pode ser testado com vários dias de snapshots, selecionando um período e verificando que a série temporal do CMC de uma família reflete os valores diários registrados.

**Acceptance Scenarios**:

1. **Given** existem snapshots de vários dias, **When** o usuário seleciona um período e uma família, **Then** o sistema mostra a evolução do CMC ponderado dessa família ao longo dos dias do período.
2. **Given** um dia sem snapshot registrado (ex.: falha no job de coleta), **When** a série é exibida, **Then** o dia aparece como lacuna (sem valor interpolado), deixando claro que não houve coleta.

---

### User Story 3 - Filtros por família e produto (multi-seleção) nas duas abas (Priority: P3)

O usuário precisa focar a análise: filtrar por **família** e por **produto**, ambos via **combo box com multi-seleção**, disponíveis nas **duas abas** (Snapshot diário e Tendência histórica). Complementarmente, filtrar por origem (Importado/Nacional) e ordenar por valor imobilizado para identificar onde está concentrado o custo. O combo de produtos deve respeitar as famílias já selecionadas (mostra os produtos das famílias filtradas).

**Why this priority**: Melhora a usabilidade da análise, mas a visão entrega valor mesmo sem filtros avançados.

**Independent Test**: Pode ser testado aplicando cada filtro isoladamente, em cada aba, e verificando que a lista, a árvore/série e os totais refletem apenas os itens filtrados.

**Acceptance Scenarios**:

1. **Given** qualquer uma das abas aberta, **When** o usuário seleciona uma ou mais famílias no combo de família, **Then** apenas essas famílias (e seus produtos) são consideradas e os totais/série são recalculados.
2. **Given** qualquer uma das abas aberta, **When** o usuário seleciona um ou mais produtos no combo de produto, **Then** apenas esses produtos são considerados, e o combo de produto reflete as famílias eventualmente já filtradas.
3. **Given** a aba Snapshot diário, **When** o usuário filtra por origem Importado, **Then** apenas o volume/valor/CMC de material importado é considerado (inclusive no resumo global).
4. **Given** a lista de famílias na aba Snapshot diário, **When** o usuário ordena por valor total imobilizado, **Then** as famílias com maior valor em estoque aparecem primeiro.

---

### Edge Cases

- **Produto sem família**: existem produtos sem `descricao_familia` na origem. Devem ser agrupados em um grupo explícito "Sem família" — nunca silenciosamente omitidos.
- **Volume zero / sem estoque**: quando o volume total é zero, o CMC não pode ser dividido por zero; deve ser exibido como "—" (sem valor) em vez de erro ou zero enganoso.
- **Dia sem snapshot**: se o histórico não tem registro para um dia, a série temporal mostra lacuna, sem interpolar.
- **Defasagem do dado**: a visão deve indicar a data do snapshot exibido ("posição em DD/MM"), para o usuário saber se o dado está atualizado.
- **Dupla contagem**: o valor imobilizado não pode contar duas vezes estoque que está em trânsito/provisório no Atlas e que já foi consolidado na posição física — a visão reflete a posição física consolidada da fonte.
- **Unidade**: a fonte `tbl_historico_cmc_estoque` já está em **kg** (`volume_total`) e **R$/kg** (`media_cmc_ponderada`) — verificado em prod. Esta visão **NÃO** converte toneladas→kg. Atenção: outras telas do StockBridge usam fonte em toneladas; **não** aplicar o mesmo fator de conversão aqui.
- **Sem resultados / sem histórico**: quando os filtros não retornam nenhum item, ou ainda não existe snapshot algum, a visão MUST exibir um **estado vazio explícito** (mensagem), sem tabela/gráfico em branco nem erro.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O sistema MUST exibir, para a posição de estoque mais recente, o CMC médio ponderado (R$/kg), o volume total (kg) e o valor total (R$) agrupados por **família**.
- **FR-002**: O sistema MUST permitir expandir uma família para ver o detalhe por **produto (PN)**, com CMC, volume e valor de cada produto.
- **FR-003**: O CMC ponderado MUST ser calculado como `Σ valor_total_cmc ÷ Σ volume_total` (R$/kg); a agregação por família MUST ser ponderada por volume, não média aritmética dos CMCs.
- **FR-004**: O sistema MUST separar e permitir consolidar as origens **Importado** e **Nacional** em ambos os níveis (família e produto).
- **FR-005**: O sistema MUST exibir quantidades em **Kg** e CMC em **R$/kg**. A fonte `tbl_historico_cmc_estoque` já está nessas unidades (verificado em prod) — **não** há conversão de toneladas nesta visão.
- **FR-006**: O sistema MUST agrupar produtos sem família em um grupo explícito "Sem família".
- **FR-007**: O sistema MUST indicar a data do snapshot exibido (posição em DD/MM) e **sinalizar visualmente quando o dado estiver defasado** — defasado = o snapshot mais recente disponível **não é do dia corrente** (o job de coleta roda diariamente, inclusive fins de semana).
- **FR-008**: O sistema MUST tratar volume zero exibindo o CMC como ausente ("—"), sem divisão por zero.
- **FR-009**: As duas abas MUST oferecer filtros por **família** e por **produto**, ambos via **combo box com multi-seleção**; o combo de produto MUST refletir as famílias selecionadas. Complementarmente MUST haver filtro por origem (Importado/Nacional). Na aba **Snapshot** a posição é sempre a do snapshot **mais recente** (sem seletor de data na v1); na aba **Tendência** há seletor de **período** (intervalo).
- **FR-010**: Os cards/totais de "posição atual" MUST refletir o snapshot mais recente disponível (a aba Snapshot não tem seletor de data na v1).
- **FR-011**: O sistema MUST exibir a evolução histórica do CMC ponderado por família (e opcionalmente por produto) ao longo de um período selecionado, mostrando dias sem coleta como lacuna. Granularidade **diária** na v1 (período padrão: todo o histórico disponível, com seletor para restringir); agregações semana/mês ficam **fora da v1**. *(suporta US2)*
- **FR-012**: O valor total imobilizado MUST refletir a posição física consolidada, sem dupla contagem de estoque em trânsito/provisório já consolidado.
- **FR-013**: O acesso à visão de CMC MUST ser restrito aos papéis **Gestor e Diretor** (perfis acima de Operador; o Atlas não possui papel "Administrador" — `diretor` é o topo da hierarquia). O **Operador NÃO** tem acesso (custo é dado sensível, alinhado ao padrão gestor+ do painel de operações pendentes).
- **FR-014**: A entrega (v1) MUST incluir tanto a posição atual (US1/US3) quanto a **tendência histórica** do CMC (US2/FR-011) — o histórico diário já existe na fonte.
- **FR-015**: O StockBridge MUST oferecer um **item de menu próprio** para a visão de custo (rótulo "Custos de Estoque", ajustável), visível apenas para os papéis autorizados (FR-013).
- **FR-016**: A página MUST ser organizada em **duas abas**: "Snapshot diário" (posição atual — US1) e "Tendência histórica" (série temporal — US2), com a aba Snapshot diário como padrão ao abrir.
- **FR-017**: Na aba Snapshot diário, a lista de famílias MUST permitir **expandir/recolher cada família no lugar** (estilo árvore/pastas do Windows Explorer), revelando os produtos (PN) da família sem navegar para outra tela, com indicador visual de estado expandido/recolhido. Famílias MUST iniciar recolhidas.
- **FR-018**: Na aba Snapshot diário, no topo (abaixo dos filtros), o sistema MUST exibir um **resumo global** com a **quantidade total em estoque** (kg) e o **valor total do estoque** (R$), respeitando os filtros aplicados. O resumo MUST **NÃO** exibir um "CMC global" (não é métrica significativa agregada).

### Key Entities *(include if feature involves data)*

- **Snapshot diário de CMC de estoque**: foto diária da posição de estoque no nível produto (PN), contendo data da foto, produto, família embutida, origem (Importado/Nacional), volume total (kg), valor total (R$) e CMC médio ponderado (R$/kg). Unicidade por (data, produto, origem).
- **Família**: agrupamento de produtos; usada como nível de consolidação derivado em consulta a partir do nível produto — não é armazenada em duplicidade.
- **Produto (PN)**: item de estoque, com código e descrição, pertencente a uma família e com uma ou mais origens.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: O gestor consegue identificar o CMC médio ponderado de qualquer família e o valor total imobilizado em até 30 segundos, sem sair do StockBridge.
- **SC-002**: 100% das famílias e produtos com estoque na posição mais recente aparecem na visão (incluindo os sem família, no grupo "Sem família").
- **SC-003**: A soma dos valores e volumes dos produtos reconcilia com o total da família e com o total geral (diferença = 0, respeitando arredondamento de exibição).
- **SC-004**: O CMC ponderado exibido reconcilia com a fonte de histórico (mesmo valor para a mesma data/família/origem), eliminando a necessidade de abrir o Metabase para a consulta do dia a dia.
- **SC-005**: A visão de tendência permite identificar a direção (alta/baixa) do CMC de uma família em um período sem cálculo manual.

## Assumptions

- A feature **consome a fonte de dados já existente** (histórico diário de CMC por produto/origem, populado pelo workflow n8n, e a posição física de estoque) — não recria nem duplica o cálculo de CMC.
- A visão é **somente leitura**; não há edição de custos pelo StockBridge.
- Estoque em **trânsito/provisório** sem custo realizado fica **fora** do CMC (o CMC reflete material consolidado em estoque físico).
- **Landed cost / `cmc_import_real`** (rateio de despesas de importação) e cálculo de **margem** estão **fora de escopo** — são conceito distinto do CMC ponderado e não devem ser confundidos.
- **Export (Excel/CSV) está fora de escopo da v1** — a visão é de consulta; exportação pode ser adicionada depois. (O Metabase e a planilha do workflow n8n seguem disponíveis como saída externa, se necessário.)
- A granularidade base do histórico é o **snapshot diário**; agregações semana/mês são derivadas e dependem de histórico acumulado.
- Decisão de arquitetura (consumir a fonte diretamente vs. espelhar/sincronizar para o schema do StockBridge) será resolvida no `/speckit.plan`; não altera o escopo funcional desta spec.
- **Disponibilidade do dado por ambiente**: a fonte `public.tbl_historico_cmc_estoque` já existe em **prod** e **UAT** (criada pelo workflow n8n — spec legado `002-historico-cmc-estoque`, **não** é migration do Atlas). Em **dev** faltava; foi adicionada ao `scripts/sync-vendas-prod-to-dev.sh` para ser puxada de prod. Não criar migration para essa tabela.
- Os papéis do StockBridge seguem a hierarquia existente: Operador → Gestor → Diretor. O Atlas não possui papel "Administrador" distinto — `diretor` é o topo.

## Clarifications

### Session 2026-06-08

- Q: Quais papéis podem ver o CMC? → A: **Gestor e Diretor** (Operador sem acesso — custo é dado sensível, padrão gestor+). O Atlas não tem papel "Administrador" distinto; `diretor` é o topo. Reflete em FR-013.
- Q: A tendência histórica entra na v1 ou fica para depois? → A: **Entra na v1** (US1+US2+US3) — histórico diário já existe na fonte. Reflete em FR-014.
- Q: Como apresentar a visão na UI? → A: **Item de menu próprio** ("Custos de Estoque") com **duas abas** — "Snapshot diário" e "Tendência histórica". Na aba Snapshot, **lista de famílias** que **expandem no lugar** em árvore de produtos, estilo pastas do Windows Explorer. Reflete em FR-015, FR-016 e FR-017.
- Q: Filtros e resumo? → A: Filtros de **família** e **produto** via **combo box multi-seleção** nas **duas abas** (FR-009). Na aba Snapshot, **resumo global** no topo (abaixo dos filtros) com **quantidade em estoque** e **valor total** — **sem CMC global**, que não é métrica agregada significativa (FR-018).
- Q: Unidade da fonte (kg ou toneladas)? → A: **kg e R$/kg** — verificado em prod (`volume_total`/`media_cmc_ponderada`). Sem conversão nesta visão. Corrige FR-005 e o edge case "Unidade".
- Q: Export (Excel/CSV) entra na v1? → A: **Não** — fora de escopo da v1; a visão é só de consulta. Registrado em Assumptions.
- Q: (analyze U1) A aba Snapshot tem seletor de data? → A: **Não na v1** — Snapshot fixo no mais recente; inspeção histórica fica na aba Tendência. Reflete em FR-009/FR-010.
