# Feature Specification: Forecast Planner — Features Avancadas

**Feature Branch**: `005-forecast-advanced-features`
**Created**: 2026-04-13
**Status**: Draft
**Input**: Gaps pendentes documentados em `docs/gap-analysis-forecast-legacy-vs-atlas.md` (GAP-F1, GAP-F2, GAP-F4)

## Context

O modulo Forecast Planner esta funcional com o motor core completo (simulacao 120d, ruptura, MOQ, compra local, sazonalidade, ajuste por SKU). Faltam 3 features avancadas presentes no legado que enriquecem a experiencia do comprador: analise de tendencia de demanda, inteligencia de timing de compra (insights COMEX), e analise IA da shopping list.

## User Scenarios & Testing

### User Story 1 — Aba Analise de Demanda (Priority: P1)

O comprador precisa entender a tendencia de demanda antes de decidir volumes de compra. Hoje ele ve apenas "vendas 12 meses" como numero unico. Ele precisa ver como a demanda evoluiu mes a mes, se esta subindo ou caindo, e como cada SKU contribui para o total da familia.

**Why this priority**: Sem visao de tendencia, o comprador nao sabe se deve comprar mais ou menos que o sugerido pelo motor. A demanda historica mensal e o input mais importante para calibrar a decisao de compra.

**Independent Test**: Abrir a aba Demanda, selecionar uma familia, e verificar que mostra vendas dos ultimos 24 meses com tendencia visual e variacao YoY.

**Acceptance Scenarios**:

1. **Given** o comprador acessa o Forecast, **When** clica na aba "Demanda", **Then** ve uma tabela com familias mostrando vendas dos ultimos 3 meses fechados, variacao trimestral YoY%, e sparkline de tendencia (24 meses).
2. **Given** o comprador expande uma familia na aba Demanda, **When** clica na linha, **Then** ve os SKUs individuais com contribuicao percentual e cobertura em dias.
3. **Given** uma familia tem demanda crescente (YoY > +10%), **When** o comprador olha a coluna de tendencia, **Then** o indicador visual mostra seta para cima em verde com o percentual.
4. **Given** uma familia tem demanda decrescente (YoY < -10%), **When** o comprador olha, **Then** o indicador mostra seta para baixo em vermelho.

---

### User Story 2 — Aba Business Insights (Priority: P2)

O comprador internacional precisa saber qual e o melhor momento para comprar, considerando historico de precos, fretes e volume importado. O sistema deve cruzar dados de importacao com o forecast para sugerir a janela de compra otima nos proximos 4 meses.

**Why this priority**: Timing de compra impacta diretamente o custo. Comprar no mes errado pode custar 5-15% mais em frete/preco. O legado tinha essa funcionalidade e os compradores a usavam ativamente.

**Independent Test**: Abrir a aba Insights, verificar que mostra tabela de fornecedores com LT, score COMEX por mes, e indicacao de janela de compra otima.

**Acceptance Scenarios**:

1. **Given** o comprador acessa a aba Insights, **When** a pagina carrega, **Then** ve tabela de fornecedores (nome, pais, familias, LT efetivo) e score COMEX mensal (barra 0-100 com classificacao).
2. **Given** o mes atual tem score COMEX alto (>70), **When** o comprador olha a tabela de oportunidade, **Then** o indicador mostra "COMPRAR" ou "BOM" para o mes atual.
3. **Given** existe dados de importacao dos ultimos 12 meses, **When** o comprador acessa a secao de historico, **Then** ve volume, FOB, frete e preco medio por mes com grafico de tendencia.
4. **Given** uma familia tem ruptura prevista em 60 dias e o score COMEX do mes atual e favoravel, **When** o sistema calcula a janela otima, **Then** recomenda comprar agora com indicador de economia estimada vs esperar.

---

### User Story 3 — Analise IA na Shopping List (Priority: P3)

O comprador quer uma segunda opiniao inteligente sobre sua lista de compras antes de enviar ao executor. O sistema deve analisar o contexto completo (familias, quantidades, rupturas, scores, lead times) e retornar recomendacoes priorizadas por item.

**Why this priority**: Feature diferenciadora de UX. Nao bloqueia o uso da shopping list, mas agrega valor significativo para decisoes complexas com muitos itens.

**Independent Test**: Montar uma shopping list com 5+ itens, clicar "Analisar com IA", e verificar que retorna recomendacoes por item com justificativa.

**Acceptance Scenarios**:

1. **Given** o comprador tem uma shopping list com itens selecionados, **When** clica "Analisar com IA", **Then** o sistema envia o contexto e exibe um painel com: resumo executivo, prioridades, alertas e recomendacao por item (COMPRAR AGORA / AGUARDAR / REVISAR / OK) com justificativa.
2. **Given** a analise retorna recomendacao "AGUARDAR" para um item, **When** o comprador olha a justificativa, **Then** ve o motivo especifico (ex: "Estoque cobre 90 dias e preco spot esta acima da media").
3. **Given** o servico de IA esta indisponivel, **When** o comprador clica "Analisar", **Then** ve mensagem amigavel de indisponibilidade e pode continuar usando a shopping list normalmente.
4. **Given** a analise esta em andamento, **When** o usuario aguarda, **Then** ve indicador de loading e pode cancelar a qualquer momento.

---

### Edge Cases

- O que acontece se uma familia nao tem historico de vendas (nova)? O sistema mostra "Sem historico" em vez de sparkline vazio.
- O que acontece se nao existem dados de importacao para calcular score COMEX? A aba Insights mostra mensagem "Dados de importacao nao disponiveis" e oculta a secao de score.
- O que acontece se a shopping list esta vazia quando o usuario clica "Analisar com IA"? O botao deve estar desabilitado quando nao ha itens selecionados.
- O que acontece se o gateway LLM retorna resposta malformada? O sistema mostra erro generico e nao quebra a interface.
- O que acontece se o comprador altera a shopping list apos a analise? A analise anterior e descartada e o botao fica disponivel para nova analise.

## Requirements

### Functional Requirements

- **FR-001**: O sistema DEVE exibir vendas mensais por familia dos ultimos 24 meses em formato tabular, com colunas para os 3 meses mais recentes fechados.
- **FR-002**: O sistema DEVE calcular e exibir variacao trimestral YoY (trimestre atual vs mesmo trimestre do ano anterior) por familia.
- **FR-003**: O sistema DEVE exibir sparkline de tendencia de demanda (24 meses historico) por familia na aba Demanda.
- **FR-004**: O sistema DEVE permitir expandir uma familia para ver SKUs individuais com contribuicao percentual e cobertura em dias.
- **FR-005**: O sistema DEVE exibir tabela de fornecedores com nome, pais, familias atendidas e lead time efetivo.
- **FR-006**: O sistema DEVE calcular e exibir score COMEX mensal (0-100) por mes para os proximos 4 meses, com classificacao textual (COMPRAR/BOM/NEUTRO/CAUTELA/EVITAR).
- **FR-007**: O sistema DEVE exibir dados de importacao historicos (12 meses): volume, FOB, frete, seguro, preco medio por mes.
- **FR-008**: O sistema DEVE indicar a janela de compra otima cruzando ruptura prevista com score COMEX.
- **FR-009**: O sistema DEVE enviar o contexto da shopping list para analise via gateway LLM e exibir recomendacoes por item (COMPRAR AGORA / AGUARDAR / REVISAR / OK) com justificativa.
- **FR-010**: O sistema DEVE tratar indisponibilidade do gateway LLM com fallback gracioso (mensagem amigavel, shopping list funcional).

### Key Entities

- **Vendas Mensais**: Historico de vendas por familia/SKU agregado por mes (24 meses). Atributos: familia, mes, volume_kg, valor_brl.
- **Fornecedor**: Dados cadastrais do fornecedor. Atributos: codigo, nome, pais, familias_atendidas, lead_time.
- **Score COMEX**: Indice mensal de favorabilidade para compra internacional. Atributos: mes, score (0-100), classificacao, fatores (volume, fob, frete, cambio).
- **Analise IA**: Resultado da analise da shopping list. Atributos: timestamp, itens analisados, resumo executivo, recomendacoes por item (acao, justificativa, prioridade).

## Success Criteria

### Measurable Outcomes

- **SC-001**: O comprador consegue identificar tendencia de demanda (subindo/descendo) para qualquer familia em menos de 10 segundos na aba Demanda.
- **SC-002**: O comprador consegue identificar o melhor mes para compra internacional em menos de 30 segundos usando score COMEX e tabela de oportunidade.
- **SC-003**: A analise IA da shopping list retorna resultado em menos de 15 segundos para listas de ate 20 itens.
- **SC-004**: 100% das familias com historico de vendas mostram sparkline e variacao YoY corretamente.
- **SC-005**: O sistema continua funcional mesmo se o gateway LLM estiver indisponivel.

## Assumptions

- Dados de vendas mensais estao disponiveis em `tbl_movimentacaoEstoqueHistorico_Q2P` com pelo menos 12 meses de historico.
- Dados de fornecedores estao em `tbl_cadastroFornecedoresClientes_ACXE` com campo pais e vinculo a familias de produto.
- Dados de importacao (FUP) estao em `tbl_dadosPlanilhaFUPComex` ou similar, com volume, FOB, frete por embarque.
- O score COMEX sera calculado com base em dados historicos de importacao (media ponderada de volume, preco, frete) — nao depende de fonte externa.
- O gateway LLM sera o n8n (conforme Principio III), chamado via webhook HTTP do backend Atlas. A configuracao do workflow n8n esta fora do escopo desta feature — o Atlas so precisa chamar o endpoint.
- A aba Demanda e a feature mais critica (P1) e pode ser entregue como MVP isolado.
