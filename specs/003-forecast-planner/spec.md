# Feature Specification: Forecast Planner

**Feature Branch**: `003-forecast-planner`  
**Created**: 2026-04-13  
**Status**: Draft  
**Input**: User description: "Planejador de compras de materia-prima (polimeros) com rolling forecast 120 dias, deteccao de ruptura, sugestao de quantidade MOQ, sazonalidade por familia, compra local emergencial, e shopping list com analise IA"

## User Scenarios & Testing

### User Story 1 - Visualizar posicao de estoque por familia de produto (Priority: P1)

O comprador abre o Forecast Planner e ve a posicao consolidada de estoque de todas as familias de polimeros (PP, PEAD, PEBD, PELBD, PS, ABS, PET, etc.). Para cada familia, ve: saldo disponivel (nsaldo - reservado), reservado (pedidos de clientes), em transito (compras nao chegadas), custo medio (CMC R$/kg), e cobertura em dias. Os dados vem diretamente do banco de dados OMIE (atualizados a cada hora).

**Why this priority**: Sem visibilidade do estoque atual, nenhuma decisao de compra e possivel. E o alicerce de todo o planejamento.

**Independent Test**: Acessar pagina Forecast, ver tabela de familias com dados reais do BD, expandir uma familia para ver SKUs individuais.

**Acceptance Scenarios**:

1. **Given** banco OMIE com estoque populado, **When** comprador acessa o Forecast Planner, **Then** ve lista de familias com saldo, reservado, transito, CMC e cobertura em dias
2. **Given** uma familia com 5 SKUs, **When** comprador expande a familia, **Then** ve cada SKU com seu saldo individual, local de estoque, e contribuicao percentual
3. **Given** estoque atualizado na ultima hora, **When** comprador carrega a pagina, **Then** ve dados com menos de 1h de atraso

---

### User Story 2 - Simulacao rolling forecast 120 dias com deteccao de ruptura (Priority: P1)

O sistema projeta o estoque de cada familia dia-a-dia por 120 dias, considerando demanda diaria sazonalizada e chegadas programadas. O grafico mostra zonas coloridas (ok/atencao/critico/ruptura). Quando o estoque atinge zero, o sistema identifica a data de ruptura e calcula o dia ideal para fazer o pedido (ruptura - lead time - buffer).

**Why this priority**: A simulacao e o produto principal — sem ela, o planejador e so uma tabela de estoque.

**Independent Test**: Selecionar uma familia, ver o grafico de 120 dias com zonas, verificar que a data de ruptura e o dia de pedido estao corretos.

**Acceptance Scenarios**:

1. **Given** uma familia com estoque para 45 dias e LT de 55 dias, **When** o forecast roda, **Then** mostra ruptura no dia ~45, dia ideal de pedido negativo (prazo perdido), e flag de compra local emergencial
2. **Given** uma familia com pedido de compra chegando no dia 30, **When** o forecast roda, **Then** o grafico mostra o estoque subindo na data de chegada e recalcula ruptura apos o recebimento
3. **Given** sazonalidade com indice 1.20 para o mes atual, **When** o forecast roda, **Then** a demanda diaria usada e 20% maior que a media anual
4. **Given** nenhum dado de vendas ainda carregado, **When** o forecast roda, **Then** exibe mensagem informativa e nao quebra

---

### User Story 3 - Sugestao de quantidade de compra com MOQ (Priority: P2)

Para cada familia com necessidade de compra, o sistema sugere uma quantidade arredondada pelo MOQ (25 toneladas para internacional, 12 toneladas para nacional). A quantidade bruta cobre LT + 60 dias de demanda sazonalizada. A quantidade liquida desconta pedidos ja aprovados em transito. O valor estimado e calculado usando o preco da ultima compra real (R$/kg).

**Why this priority**: Automatiza o calculo que hoje o comprador faz manualmente na planilha Excel.

**Independent Test**: Ver coluna "Qtd Sugerida" na tabela de forecast, verificar que respeita MOQ, verificar que desconta estoque em transito.

**Acceptance Scenarios**:

1. **Given** familia com necessidade liquida de 47t, **When** MOQ internacional (25t), **Then** sugere 50t (arredonda pra cima)
2. **Given** familia com 30t em transito e necessidade bruta de 50t, **When** calculo roda, **Then** necessidade liquida = 20t, sugere 25t (MOQ)
3. **Given** ultima compra internacional a R$5.71/kg e quantidade sugerida 50t, **When** valor estimado calculado, **Then** mostra R$ 285.500

---

### User Story 4 - Compra local emergencial (Priority: P2)

Quando o prazo para compra internacional ja passou (dia ideal de pedido < hoje), o sistema aciona automaticamente a logica de compra local emergencial. Mostra: dia para abrir pedido local, gap de dias sem estoque, custo de oportunidade (vendas perdidas), quantidade local sugerida (MOQ 12t), e valor estimado.

**Why this priority**: Evita ruptura de estoque quando a janela internacional fechou — decisao critica que hoje depende de intuicao do comprador.

**Independent Test**: Criar cenario onde estoque acaba em 20 dias e LT internacional e 55 dias. Verificar que aparece card de compra local.

**Acceptance Scenarios**:

1. **Given** ruptura em 20 dias e LT internacional 55 dias, **When** forecast detecta prazo perdido, **Then** mostra compra local com LT 7 dias e dia de abertura = dia 13
2. **Given** demanda diaria de 800kg e gap de 35 dias, **When** calculo de custo de oportunidade, **Then** mostra valor baseado no preco de estoque

---

### User Story 5 - Painel de compras urgentes 15 dias (Priority: P2)

Dashboard filtrado mostrando apenas familias que precisam de decisao de compra nos proximos 15 dias. Ordena por urgencia. Mostra status visual (critico/atencao/ok) e acao necessaria (compra intl/compra local/ok).

**Why this priority**: O comprador nao quer olhar 30+ familias todo dia — quer ver so o que precisa de acao imediata.

**Independent Test**: Acessar aba "Compras 15 Dias", ver apenas familias com diaPedidoIdeal <= 15.

**Acceptance Scenarios**:

1. **Given** 3 familias com pedido ideal em 5, 12 e 30 dias, **When** comprador abre aba urgente, **Then** ve apenas 2 familias (5 e 12 dias)
2. **Given** familia com compra local necessaria, **When** exibida no painel, **Then** aparece com badge "LOCAL" destacado

---

### User Story 6 - Configuracao de sazonalidade por familia (Priority: P3)

O comprador ajusta indices de sazonalidade por familia e por mes (12 meses). O sistema fornece indices sugeridos baseados em historico. O comprador pode sobrescrever com fatores customizados. Mudancas sao registradas em log.

**Why this priority**: Sazonalidade afeta a precisao do forecast. Sem ajuste, a demanda seria flat e geraria rupturas em meses de pico.

**Independent Test**: Alterar indice de sazonalidade de uma familia para um mes especifico, verificar que o forecast recalcula.

**Acceptance Scenarios**:

1. **Given** familia PP com indice padrao 1.08 em junho, **When** comprador muda para 1.25, **Then** demanda diaria de junho aumenta proporcionalmente
2. **Given** alteracao de sazonalidade, **When** salva, **Then** log registra data, familia, mes, valor anterior e novo

---

### User Story 7 - Shopping list editavel (Priority: P3)

O comprador gera uma lista de compras consolidada a partir das sugestoes do forecast. Pode editar quantidades (respeitando MOQ), adicionar observacoes, e marcar itens como aprovados. A lista pode ser copiada para o executor (clipboard formatado).

**Why this priority**: A lista de compras e o output final do planejamento — o que o comprador entrega para o time de execucao.

**Independent Test**: Gerar shopping list, editar quantidade de um item, copiar para clipboard.

**Acceptance Scenarios**:

1. **Given** 5 familias com necessidade de compra, **When** gerar shopping list, **Then** lista mostra todas com qtd, prazo, valor, score
2. **Given** item com qtd 50t, **When** comprador reduz para 25t, **Then** valor recalcula e MOQ e respeitado
3. **Given** lista pronta, **When** comprador clica "Copiar para Executor", **Then** conteudo formatado vai para clipboard

---

### Edge Cases

- Familia sem nenhum SKU com estoque (saldo zero em todos os locais) — deve aparecer com status "sem estoque" e sugestao de compra imediata
- SKU sem familia definida (codigo_familia null) — agrupar em familia "Outros"
- Lead time zero ou nao definido — usar fallback de 60 dias e marcar com aviso
- Demanda diaria zero (produto novo sem historico) — nao gerar forecast, mostrar como "sem historico"
- MOQ maior que necessidade bruta — sugerir MOQ minimo (1 container)
- Multiplas chegadas no mesmo dia — somar todas no estoque projetado
- Sazonalidade com fator zero — tratar como 0.01 para evitar demanda zero na projecao

## Requirements

### Functional Requirements

- **FR-001**: Sistema MUST consolidar estoque de todas as familias de polimeros do BD OMIE em 3 camadas: disponivel (nsaldo - reservado), reservado, transito (npendente)
- **FR-002**: Sistema MUST projetar estoque dia-a-dia por 120 dias aplicando demanda sazonalizada e chegadas programadas (fonte: tbl_pedidosCompras_ACXE com ddtprevisao por produto)
- **FR-003**: Sistema MUST detectar data de ruptura (estoque = 0) e calcular dia ideal de pedido (ruptura - LT - buffer)
- **FR-004**: Sistema MUST sugerir quantidade de compra arredondada por MOQ (25t intl / 12t nacional) descontando pipeline em transito
- **FR-005**: Sistema MUST acionar logica de compra local emergencial quando prazo internacional esta perdido
- **FR-006**: Sistema MUST aplicar indices de sazonalidade por familia e por mes na projecao de demanda
- **FR-007**: Sistema MUST classificar familias por status (critico/atencao/ok) baseado em proximidade da ruptura
- **FR-008**: Sistema MUST gerar shopping list consolidada com qtd, prazo, valor estimado, e score de urgencia
- **FR-009**: Sistema MUST permitir configuracao de lead time por SKU e override por pais de origem
- **FR-010**: Sistema MUST exibir painel filtrado de compras urgentes (decisao necessaria em 15 dias)
- **FR-011**: Sistema MUST calcular valor estimado de compra usando preco da ultima compra real (R$/kg), com fallback para CMC

### Key Entities

- **Familia**: Agrupamento de SKUs por tipo de polimero (PP HOMO 25, PEAD FILME, etc.). Cada familia tem sazonalidade propria e e a unidade de planejamento
- **SKU (Produto)**: Item individual com codigo, descricao, pais de origem, lead time, preco CMC. Pertence a uma familia
- **Estoque 3 Camadas**: Estado atual do produto: disponivel (livre pra venda), reservado (pedidos clientes), transito (comprado nao chegou)
- **Forecast Serie**: Projecao dia-a-dia de estoque por 120 dias com zona (ok/atencao/critico/ruptura) e chegadas
- **Sugestao de Compra**: Quantidade sugerida (MOQ-rounded), valor estimado, instrumento (intl/local), prazo
- **Compra Local Emergencial**: Acionada quando janela intl fechou. Tem dia de abertura, gap, custo de oportunidade
- **Sazonalidade**: Indices mensais (0.1-3.0) por familia. Afetam demanda diaria projetada
- **Shopping List Item**: Item editavel com qtd, prazo, fornecedor, score, observacoes, status de aprovacao

## Success Criteria

### Measurable Outcomes

- **SC-001**: Comprador consegue identificar todas as familias que precisam de compra nos proximos 15 dias em menos de 30 segundos
- **SC-002**: Tempo para gerar uma lista de compras completa cai de 2+ horas (planilha manual) para menos de 5 minutos
- **SC-003**: Dados de estoque exibidos tem no maximo 1 hora de atraso em relacao ao OMIE
- **SC-004**: 100% das familias com ruptura prevista sao sinalizadas com antecedencia minima de LT + buffer dias
- **SC-005**: Sugestoes de compra respeitam MOQ em 100% dos casos

## Clarifications

### Session 2026-04-13

- Q: Fonte das chegadas programadas (pedidos em rota) para o forecast? → A: Usar tbl_pedidosCompras_ACXE (ddtprevisao + quantidade por ncodprod)
- Q: Como distinguir familia internacional vs nacional? → A: Coluna "marca" em tbl_produtos_Q2P — marca='IMPACXE' = importado Acxe (internacional). Demais = nacional. Produto importado pode eventualmente ser comprado no mercado nacional (compra local emergencial).
- Q: Fonte de vendas12m por SKU? → A: Tabela tbl_movimentacaoEstoqueHistorico_Q2P ja existe com dados desde 2021. Filtrar des_origem='Venda de Produto', somar ABS(qtde) por id_prod nos ultimos 365 dias. Nao precisa de OMIE API — dados ja estao no BD.

## Assumptions

- Dados de estoque (tbl_posicaoEstoque_Q2P) sao atualizados a cada hora via n8n/RabbitMQ
- Familias de produto vem da coluna descricao_familia em tbl_produtos_Q2P (~30 familias reais)
- Lead time por SKU ja existe no campo lead_time de tbl_produtos_Q2P
- vendas12m calculado a partir de tbl_movimentacaoEstoqueHistorico_Q2P (des_origem='Venda de Produto', ABS(qtde), ultimos 365 dias por id_prod). Dados disponiveis desde 2021
- Origem internacional/nacional inferida pela coluna "marca" em tbl_produtos_Q2P: marca='IMPACXE' = importado pela Acxe (internacional, MOQ 25t). Produtos IMPACXE podem eventualmente ser comprados no mercado nacional quando prazo internacional esta perdido (compra local emergencial, MOQ 12t)
- Unidades sao em kg no BD (nsaldo, reservado, npendente sao integers em kg)
- O modulo roda dentro do Atlas monolito, usando o mesmo BD compartilhado
- Autenticacao via sistema Atlas existente (requireAuth)
- Cambio USD/BRL para estimativas vem da integration-bcb (mesma do hedge)
