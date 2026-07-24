# Feature Specification: Conferência de Estoque ACXE vs Q2P (StockBridge)

**Feature Branch**: `011-conferencia-estoque`
**Created**: 2026-06-22
**Status**: Draft
**Input**: User description: "Pegar o trabalho da planilha 'Conferência de Estoque ACXE e Q2P' e criar um menu dentro do StockBridge para eliminar o uso da planilha. Hoje o usuário abre a planilha diariamente, olha a coluna Status Geral e procura registros onde o estoque não está OK — ou seja, divergência entre o estoque espelhado ACXE e o Q2P (movimentação manual errada, falha do integrador). O menu deve permitir verificar os estoques com problema e exibir um alerta visual (bolinha vermelha com o número de divergências) ao estilo do alerta de aprovações pendentes."

## Contexto

Hoje a conferência de estoque entre as duas empresas (**ACXE** e **Q2P**) é feita por uma planilha Excel (`Planilha de Conferência de Estoque ACXE e Q2P`) que, via Power Query, cruza as posições físicas de estoque das duas origens com um mapa De→Para de locais, pivota o saldo por empresa e calcula um **Status Geral** por produto/local. O usuário responsável abre a planilha **todo dia**, percorre a coluna `Status Geral` e procura os registros que **não estão "OK"** — divergências entre o estoque espelhado ACXE e o Q2P, causadas por movimentação manual incorreta ou falha do integrador.

Esta feature traz esse trabalho para dentro do módulo **StockBridge** do Atlas, eliminando a planilha e adicionando um **alerta visual proativo** (badge) na navegação para que o usuário não precise abrir a tela diariamente só para descobrir se há algo a tratar.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ver as divergências de estoque numa tela (Priority: P1)

O usuário de logística abre o menu "Conferência de Estoque" dentro do StockBridge e vê, numa tabela, a posição comparada ACXE × Q2P por produto e local, **com os itens problemáticos no topo**. Ele identifica imediatamente quais produtos/locais estão divergentes ou negativos, sem precisar abrir uma planilha externa nem rolar milhares de linhas OK.

**Why this priority**: É o coração da feature e o substituto direto da planilha. Sozinha já entrega o valor principal (acabar com a varredura manual diária) e é um MVP viável.

**Independent Test**: Acessar o menu, confirmar que a tabela exibe as mesmas linhas/colunas e a mesma classificação de `Status Geral` que a planilha produziria para a posição do dia, ordenadas com os problemas primeiro.

**Acceptance Scenarios**:

1. **Given** existem posições de estoque do dia para ACXE e Q2P, **When** o usuário abre o menu "Conferência de Estoque", **Then** o sistema exibe uma linha por (data da posição, local, produto) com `Saldo ACXE`, `Saldo Q2P`, `Diferença`, `Saldo Negativo` e `Status Geral`.
2. **Given** a tabela carregada, **When** ela é exibida, **Then** os registros aparecem ordenados trazendo `Divergente e Negativo` e demais problemas para o topo, antes dos `OK`.
3. **Given** um produto existe no Q2P mas não tem contrapartida no ACXE (ou vice-versa), **When** a linha é calculada, **Then** o saldo ausente é tratado como `0` e a `Diferença` reflete isso.
4. **Given** um produto cujo código está na blacklist (`CONS_`, `PRD00001`, `SUC-`, `STRETCH`), **When** a posição é processada, **Then** esse produto **não** aparece na conferência.

---

### User Story 2 - Alerta visual de divergências na navegação (Priority: P1)

Enquanto navega pelo Atlas, o usuário vê na entrada de menu da Conferência de Estoque (e/ou no StockBridge) uma **bolinha vermelha com o número de divergências** existentes, no mesmo estilo do alerta de aprovações pendentes já usado no StockBridge. Assim ele sabe, sem abrir a tela, que há itens a tratar e quantos.

**Why this priority**: Foi um pedido explícito e é o que torna o processo **proativo** (hoje a planilha é puramente reativa — só sabe quem abre). Depende da US1 para ter onde clicar, mas o cálculo do contador é independente da renderização da tabela.

**Independent Test**: Forçar uma posição com N itens problemáticos e verificar que o badge mostra N; zerar os problemas e verificar que o badge some.

**Acceptance Scenarios**:

1. **Given** existem divergências na posição mais recente, **When** o usuário visualiza a navegação, **Then** um badge vermelho com a contagem de divergências aparece na entrada do menu.
2. **Given** não há nenhuma divergência, **When** o usuário visualiza a navegação, **Then** nenhum badge é exibido (ou ele aparece zerado/neutro, conforme o padrão do badge de aprovações).
3. **Given** o badge está visível, **When** o usuário clica nele/na entrada de menu, **Then** ele é levado à tela de conferência já priorizando os itens problemáticos.
4. **Given** o badge de aprovações pendentes coexiste na mesma navegação, **When** ambos têm contagem, **Then** os dois alertas são exibidos de forma consistente e distinguível.

---

### User Story 3 - Foco rápido nos problemas (filtros, cores e KPIs) (Priority: P2)

O usuário quer ir direto ao que importa: aplicar filtros de um clique (apenas divergentes, apenas negativos, ignorar OK), ver as linhas coloridas por severidade e ter um resumo no topo (quantos SKUs divergentes, total da diferença, quantas quebras de negativo).

**Why this priority**: Melhora muito a eficiência e replica recursos que o usuário tem na planilha (filtros/auto-filtro), mas a US1 já é utilizável sem isso.

**Independent Test**: Com dados contendo mix de status, aplicar cada chip de filtro e conferir que a tabela e os KPIs refletem o subconjunto correto.

**Acceptance Scenarios**:

1. **Given** a tabela carregada, **When** o usuário aciona o filtro "Apenas divergentes", **Then** somente linhas com `Status Geral` de divergência permanecem visíveis.
2. **Given** a tabela carregada, **When** ela é exibida, **Then** linhas `Divergente e Negativo` recebem destaque crítico (vermelho), `Divergente`/`Negativo` recebem destaque de atenção, e `OK` ficam neutras.
3. **Given** a tela aberta, **When** o usuário olha o topo, **Then** vê KPIs com: total de SKUs com divergência, total quantitativo da diferença e total de quebras (negativos).

---

### User Story 4 - Saber se os dados estão atualizados (Priority: P2)

Antes de confiar no que vê, o usuário precisa saber de quando é a posição exibida — a planilha hoje controla isso por empresa (`tbl_controleAtualizacao` com a `dDataPosicao` de ACXE e de Q2P).

**Why this priority**: Sem indicação de frescor, o usuário pode tratar (ou ignorar) divergências com base em dados velhos. Não bloqueia o MVP de visualização, mas é importante para confiança.

**Independent Test**: Exibir a data da posição de cada empresa e verificar que reflete a última posição disponível; simular ACXE e Q2P com datas diferentes e confirmar que ambas são mostradas.

**Acceptance Scenarios**:

1. **Given** a tela aberta, **When** ela carrega, **Then** mostra a data da posição vigente para ACXE e para Q2P.
2. **Given** as datas de posição de ACXE e Q2P diferem, **When** a tela é exibida, **Then** o usuário é avisado da defasagem entre as duas origens.

---

### Edge Cases

- **Local órfão / sem mapeamento**: posição cujo local não existe no mapa De→Para (sem `Empresa` ou sem classificação) é descartada da conferência (não vira linha nem entra no contador).
- **Produto só em uma origem**: saldo ausente do outro lado é tratado como `0`; pode gerar `Diferença` ≠ 0 e, se for local `ESPELHADO`, vira `Divergente`.
- **Sem posição do dia**: se uma das origens não tem posição recente (sync atrasado), a tela deve deixar claro que os dados estão incompletos em vez de mostrar tudo como "OK".
- **Negativo sem divergência**: ACXE e Q2P ambos negativos mas iguais (`Diferença = 0`) → `Status Geral = "Negativo"` (não "Divergente e Negativo"), conforme prioridade das regras.
- **Local INDIVIDUAL divergente**: locais não-espelhados nunca são marcados como `Divergente` (só podem ser `Negativo` ou `OK`), pois não há contrapartida esperada entre empresas.
- **Volume**: a base é da ordem de milhares de linhas/dia (~6 mil hoje); a tela e o contador precisam responder bem nessa escala.

## Requirements *(mandatory)*

### Funcionais — Pipeline de dados (paridade com a planilha)

- **FR-001**: O sistema MUST excluir da conferência todo produto cujo código inicie com os prefixos de blacklist: `CONS_`, `PRD00001`, `SUC-`, `STRETCH`.
- **FR-002**: O sistema MUST normalizar o produto por uma chave textual padronizada (descrição em maiúsculas e sem espaços nas extremidades) para agrupar ACXE e Q2P do mesmo produto.
- **FR-003**: O sistema MUST relacionar cada posição de estoque ao seu local via o mapa De→Para de locais, e MUST descartar registros sem mapeamento válido (local sem `Empresa`/classificação).
- **FR-004**: O sistema MUST agrupar por (data da posição, código do local, nome do local, tipo do local, produto normalizado) e pivotar o saldo físico por empresa, produzindo `Saldo ACXE` e `Saldo Q2P`; valores ausentes MUST ser consolidados como `0`.
- **FR-005**: O sistema MUST calcular `Diferença = Saldo ACXE − Saldo Q2P`.
- **FR-006**: O sistema MUST classificar o `Saldo Negativo` em: `"ACXE e Q2P negativos"`, `"ACXE negativo"`, `"Q2P negativo"` ou `"OK"`.
- **FR-007**: O sistema MUST calcular o `Status Geral` na exata ordem de prioridade: (1) `ESPELHADO` + `Diferença ≠ 0` + saldo negativo ≠ OK → `"Divergente e Negativo"`; (2) `ESPELHADO` + `Diferença ≠ 0` → `"Divergente"`; (3) saldo negativo ≠ OK → `"Negativo"`; (4) senão → `"OK"`.
- **FR-008**: O sistema MUST tratar a flag `ESPELHADO` do local como condição necessária para classificar uma linha como divergente (locais `INDIVIDUAL` nunca são `Divergente`).

### Funcionais — Tela de conferência

- **FR-009**: O StockBridge MUST oferecer uma entrada de menu de navegação "Conferência de Estoque" que leva à tela de reconciliação.
- **FR-010**: A tela MUST exibir, por linha: data da posição, código do local, nome do local, tipo do local, produto, `Saldo Q2P`, `Saldo ACXE`, `Diferença`, `Saldo Negativo` e `Status Geral`.
- **FR-011**: A tela MUST ordenar por padrão trazendo os problemas primeiro: `Status Geral` (prioridade de problema desc), tipo do local, nome do local, produto, data da posição.
- **FR-012**: A tela MUST permitir filtros rápidos de um clique: "Apenas divergentes", "Estoque negativo" e "Ignorar status OK".
- **FR-013**: A tela MUST aplicar codificação por cores por severidade: crítico para `Divergente e Negativo`, atenção para `Divergente`/`Negativo`, neutro para `OK`.
- **FR-014**: A tela MUST exibir KPIs resumidos: total de SKUs com divergência, total quantitativo da `Diferença` e total de quebras (negativos).
- **FR-015**: A tela MUST exibir a data da posição vigente para ACXE e para Q2P e MUST sinalizar quando as duas origens estiverem defasadas entre si.
- **FR-016**: As quantidades MUST ser exibidas na convenção de unidade adotada na UI do StockBridge (Kg), independentemente da unidade de armazenamento interna.

### Funcionais — Alerta visual (badge)

- **FR-017**: A navegação MUST exibir um badge vermelho com a contagem de divergências na entrada da Conferência de Estoque, no mesmo padrão visual do alerta de aprovações pendentes do StockBridge.
- **FR-018**: O badge MUST refletir a posição mais recente disponível e MUST desaparecer (ou ficar neutro) quando a contagem for zero.
- **FR-019**: O badge MUST contar **todos os itens com `Status Geral ≠ OK`** da posição mais recente — ou seja, `Divergente`, `Divergente e Negativo` **e** `Negativo` puro (decisão: o usuário quer ser alertado de qualquer estoque que "não esteja OK", não só das divergências de espelhamento).
- **FR-020**: Clicar no badge/entrada de menu MUST abrir a tela já priorizando os itens problemáticos.

### Funcionais — Acesso e escopo

- **FR-021**: O acesso à Conferência de Estoque MUST respeitar os papéis já existentes do StockBridge (assunção: visível a operador+; ver Assumptions).
- **FR-022**: Na v1 a conferência é **somente leitura**: o usuário MUST poder visualizar, filtrar e ordenar (e, opcionalmente, exportar) os dados, mas **não** há registro de tratativa (marcar como revisada/resolvida). Consequentemente, o badge sempre reflete os problemas da posição atual, sem desconto de itens "tratados".
- **FR-023**: Registro de tratativa de divergências (marcar revisada/resolvida com responsável, nota e data, e descontar do badge) está **fora do escopo da v1** — fica como fast-follow caso o uso justifique.

### Key Entities *(include if feature involves data)*

- **Posição de Estoque (ACXE / Q2P)**: saldo físico por local, produto e data de referência (origem das quantidades comparadas). Atributos relevantes: código do produto, código do local, data da posição, saldo físico, empresa de origem.
- **Local de Estoque (mapa De→Para)**: classifica e roteia cada local. Atributos: identificador do local, código textual, descrição, nome para comparação, **Tipo** (`ESPELHADO` | `INDIVIDUAL`) e **Empresa** (`ACXE` | `Q2P`). Hoje são 24 locais; os pares importados 11.x/12.x são `ESPELHADO`.
- **Linha de Reconciliação (saída)**: resultado por (data, local, produto normalizado) com `Saldo ACXE`, `Saldo Q2P`, `Diferença`, `Saldo Negativo` e `Status Geral`.
- **Controle de Atualização**: data da última posição por empresa, usada para indicar frescor e defasagem.
- **Tratativa de Divergência** *(fora do escopo da v1 — ver FR-023)*: eventual registro de que uma divergência foi revisada/resolvida (responsável, data, observação).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A planilha externa de conferência deixa de ser usada na rotina diária (0 aberturas pelos usuários do processo após adoção).
- **SC-002**: O usuário consegue identificar todos os itens problemáticos do dia em menos de 30 segundos a partir da abertura do menu (vs. varredura manual da planilha hoje).
- **SC-003**: A classificação de `Status Geral` da tela é idêntica à da planilha para a mesma posição de entrada em 100% das linhas (paridade verificada na validação paralela).
- **SC-004**: O badge informa corretamente a existência e a contagem de itens a tratar sem o usuário precisar abrir a tela, refletindo a posição mais recente.
- **SC-005**: A tela carrega e responde de forma fluida no volume atual (~6 mil linhas/dia), com os problemas (dezenas de linhas) imediatamente visíveis no topo.

## Assumptions

- **Fonte de dados já no Atlas**: as posições físicas de estoque de ACXE e Q2P já estão disponíveis no espelho de leitura do Atlas/OMIE (ex.: visão unificada de posição por família/local), dispensando importação manual da planilha. A correção do mapeamento de locais segue a whitelist de galpões físicos já adotada no módulo.
- **Mapa De→Para como configuração**: a classificação de locais (`ESPELHADO`/`INDIVIDUAL`, empresa) é tratada como configuração mantida no Atlas (não recriada manualmente a cada uso). Mudanças de locais são raras.
- **Convenção de unidade**: quantidades exibidas em Kg na UI, mantendo a base interna em toneladas (padrão do StockBridge).
- **Frequência**: a conferência reflete a posição mais recente sincronizada; não há requisito de tempo real — atualização diária/por sync é suficiente, como na planilha.
- **Papéis**: reaproveita o modelo de acesso existente do StockBridge; ajuste fino de quem vê o badge segue o padrão de notificação por papel já adotado.
- **Escopo v1**: foco em visualização, priorização e alerta. Correção automática da divergência (ajuste de estoque via OMIE) está fora do escopo desta feature.
