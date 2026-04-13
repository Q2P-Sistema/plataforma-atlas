# Feature Specification: Hedge Engine

**Feature Branch**: `002-hedge-engine`
**Created**: 2026-04-12
**Status**: Draft
**Input**: Migrar o motor de hedge cambial (USD/BRL) do legado Node.js para o Atlas. Inclui buckets de exposicao, NDFs, mark-to-market, dashboard de posicoes, integracao com PTAX BCB e dados OMIE via banco.

## User Scenarios & Testing

### User Story 1 - Dashboard de Posicao Cambial (Priority: P1)

O operador/gestor abre o modulo Hedge e ve o dashboard consolidado da posicao cambial da empresa. Os 5 KPIs principais (exposicao total USD, cobertura %, NDF ativo USD, gap descoberto USD, PTAX atual) sao visiveis imediatamente. A tabela de buckets mensais mostra cada mes com exposicao, NDFs contratados, percentual de cobertura e status (ok/sub-hedged/over-hedged). Graficos mostram a evolucao da PTAX, composicao da cobertura (donut) e exposicao por mes (barras).

**Why this priority**: Sem visibilidade da posicao, nenhuma decisao de hedge pode ser tomada. E o ponto de entrada do modulo e a tela que o gestor consulta diariamente.

**Independent Test**: Abrir /hedge com dados de teste. Ver 5 KPIs com valores reais, tabela de buckets com pelo menos 6 meses, graficos renderizando. Filtrar por localidade e ver KPIs atualizarem.

**Acceptance Scenarios**:

1. **Given** dados OMIE sincronizados no banco e PTAX atualizada, **When** operador abre /hedge, **Then** dashboard carrega em menos de 2 segundos com 5 KPIs, tabela de buckets e graficos
2. **Given** multiplas localidades (depositos ACXE + Q2P), **When** operador filtra por localidade, **Then** KPIs e tabela recalculam para aquela localidade
3. **Given** bucket com cobertura < 60%, **When** dashboard carrega, **Then** bucket aparece com status "sub-hedged" e cor de alerta

---

### User Story 2 - Motor de Minima Variancia (Priority: P1)

O gestor acessa a tela do Motor MV para calcular a cobertura otima de hedge. O sistema calcula automaticamente 3 camadas: L1 (base automatica ~60%), L2 (tatica ajustavel por slider lambda 0-1), L3 (gap aberto intencional). O gestor ajusta o slider de aversao ao risco (lambda), ve em tempo real as recomendacoes por bucket (instrumento sugerido, notional, prazo), e pode aprovar a recomendacao para registro como NDF pendente.

**Why this priority**: E o core de valor do modulo — transforma exposicao bruta em recomendacoes acionaveis de hedge. Sem isso, o modulo e apenas um visualizador.

**Independent Test**: Abrir /hedge/motor com buckets existentes. Mover slider lambda de 0 a 1 e ver recomendacoes recalcularem. Aprovar uma recomendacao e verificar que NDF pendente foi criado.

**Acceptance Scenarios**:

1. **Given** buckets com exposicao aberta, **When** gestor abre tela do Motor, **Then** 3 camadas sao calculadas com percentuais que somam 100%
2. **Given** lambda = 0.5, **When** gestor muda lambda para 0.8, **Then** L2 aumenta, L3 diminui, recomendacoes atualizam em tempo real
3. **Given** bucket com vencimento em 45 dias, **When** motor calcula, **Then** instrumento sugerido e NDF 60d (conforme regra <=70d)
4. **Given** recomendacao aprovada pelo gestor, **When** clica "Aprovar", **Then** NDF e criado com status "pendente" e aparece na lista de NDFs

---

### User Story 3 - Gestao de NDFs e Contratos (Priority: P1)

O operador registra novos contratos NDF/Trava/ACC no sistema com notional USD, taxa NDF contratada, prazo e data de vencimento. O sistema calcula automaticamente o custo em BRL e associa o NDF ao bucket correspondente. NDFs seguem o ciclo de vida: pendente → ativo → liquidado/cancelado. Ao liquidar, o sistema calcula o resultado (P&L) comparando taxa contratada vs PTAX de liquidacao.

**Why this priority**: NDFs sao o instrumento central de hedge. Sem gestao de contratos, nao ha como medir cobertura nem resultado.

**Independent Test**: Criar NDF com notional 100k USD, taxa 5.50, prazo 90d. Ver NDF na lista com status pendente. Ativar. Liquidar com PTAX 5.60 e ver resultado calculado.

**Acceptance Scenarios**:

1. **Given** operador na tela de NDFs, **When** cria NDF com notional, taxa e prazo, **Then** sistema calcula custo BRL e associa ao bucket do mes de vencimento
2. **Given** NDF com status pendente, **When** operador ativa, **Then** status muda para ativo e cobertura do bucket atualiza
3. **Given** NDF ativo, **When** operador liquida informando PTAX de liquidacao, **Then** resultado BRL e calculado como `notional × (taxa_ndf - ptax_liquidacao)` e status muda para liquidado
4. **Given** NDF ativo, **When** operador cancela, **Then** status muda para cancelado e cobertura do bucket recalcula

---

### User Story 4 - Integracao PTAX BCB (Priority: P2)

O sistema busca automaticamente a cotacao PTAX (USD/BRL) do Banco Central via API publica. A PTAX e usada como referencia em todos os calculos do motor, dashboard e avaliacao de NDFs. Em caso de indisponibilidade da API BCB, o sistema usa a ultima cotacao valida e exibe aviso.

**Why this priority**: PTAX e o input critico para todos os calculos. Sem ela, nenhum KPI e confiavel.

**Independent Test**: Verificar que PTAX do dia aparece no dashboard. Simular falha da API BCB e verificar que ultima cotacao valida e usada com aviso visivel.

**Acceptance Scenarios**:

1. **Given** dia util, **When** sistema busca PTAX, **Then** cotacao de venda e compra sao armazenadas e disponiveis para calculos
2. **Given** PTAX fora da faixa de sanidade (< 3.00 ou > 10.00), **When** sistema recebe cotacao, **Then** cotacao e rejeitada e alerta e gerado
3. **Given** API BCB indisponivel, **When** sistema tenta buscar PTAX, **Then** usa ultima cotacao valida e exibe indicador visual "PTAX desatualizada"

---

### User Story 5 - Simulacao de Margem por Cenario (Priority: P2)

O gestor simula o impacto de diferentes cenarios de cambio (4.50 a 7.50 BRL/USD) sobre a margem bruta da operacao. A simulacao mostra, para cada cenario, o custo com e sem hedge, a margem resultante, e o ganho/perda da cobertura. Isso permite ao gestor decidir se aumenta ou diminui a cobertura antes de um evento de mercado.

**Why this priority**: Complementa o motor MV com analise what-if. Essencial para decisoes taticas em momentos de volatilidade.

**Independent Test**: Abrir simulador com dados reais. Ver grid de cenarios com margens calculadas. Alterar parametros (faturamento, custos) e ver grid recalcular.

**Acceptance Scenarios**:

1. **Given** dados de exposicao e NDFs ativos, **When** gestor abre simulador, **Then** grid mostra margem calculada para cada cenario de 4.50 a 7.50 com step de 0.25
2. **Given** cenario de cambio 6.50, **When** simulador calcula, **Then** mostra custo_com_hedge, custo_sem_hedge e diferenca percentual

---

### User Story 6 - Estoque Importado por Localidade (Priority: P2)

O operador visualiza o estoque importado por localidade (depositos ACXE e Q2P). Cada localidade mostra valor BRL, custo USD estimado, status de pagamento (pago/a pagar), e fase logistica (maritimo/alfandega/deposito). Os dados vem do OMIE via banco sincronizado pelo n8n.

**Why this priority**: Estoque nao-pago e input para o calculo da camada L1 do motor (estoque > 50% da exposicao eleva cobertura base).

**Independent Test**: Abrir /hedge/estoque. Ver localidades com valores, filtrar por empresa (ACXE/Q2P), verificar totais.

**Acceptance Scenarios**:

1. **Given** dados de estoque sincronizados, **When** operador abre tela, **Then** localidades aparecem com valor BRL, custo USD e % pago
2. **Given** filtro por empresa ACXE, **When** aplicado, **Then** so localidades ACXE aparecem com totais recalculados

---

### User Story 7 - Sistema de Alertas (Priority: P3)

O sistema gera alertas automaticos baseados em thresholds de gap de cobertura: critico (gap >= USD 1M), alta (500K-1M), media (> 0). Alertas aparecem como notificacoes com opcao de marcar como lido e resolver. Historico de alertas e mantido para auditoria.

**Why this priority**: Alertas sao passivos — complementam o dashboard mas nao bloqueiam uso do modulo.

**Independent Test**: Criar bucket com gap > 1M USD. Verificar alerta critico gerado. Marcar como lido. Resolver. Ver no historico.

**Acceptance Scenarios**:

1. **Given** bucket com gap >= USD 1M, **When** calculo de posicao roda, **Then** alerta com severidade "critico" e gerado
2. **Given** alerta nao lido, **When** operador marca como lido, **Then** alerta sai da lista principal mas permanece no historico
3. **Given** alerta lido, **When** operador resolve (gap foi fechado), **Then** alerta muda para status resolvido com timestamp

---

### User Story 8 - Configuracao e Taxas NDF (Priority: P3)

O diretor/gestor configura parametros operacionais do motor: lambda default, localidades ativas, thresholds de alerta. Tambem gerencia a tabela de taxas NDF de mercado por prazo (30/60/90/120/180 dias) que alimenta o calculo de custo dos contratos. Configuracoes sao armazenadas no banco (nao em arquivo JSON).

**Why this priority**: Configuracao e feita raramente e tem valores default razoaveis.

**Independent Test**: Abrir /hedge/config. Editar lambda default. Salvar. Reabrir e verificar que valor persiste. Editar taxa NDF 90d. Verificar que novo calculo de custo usa taxa atualizada.

**Acceptance Scenarios**:

1. **Given** diretor na tela de config, **When** altera lambda default de 0.5 para 0.7, **Then** valor persiste no banco e motor usa novo valor
2. **Given** gestor na tela de taxas, **When** insere taxa NDF 90d = 5.85 para data de hoje, **Then** taxa e usada no proximo calculo de custo de NDF 90d

---

### Edge Cases

- O que acontece quando PTAX nao e publicada (feriado/fim de semana)? Usa ultimo dia util.
- O que acontece quando titulo OMIE desaparece do sync? Soft-archive: marca como arquivado, nao deleta. Preserva historico.
- O que acontece quando NDF e liquidado com PTAX menor que taxa contratada? Resultado e positivo (ganho no hedge). Sistema deve mostrar ganho/perda com sinal correto.
- O que acontece quando bucket tem cobertura > 100%? Status "over-hedged", alerta de severidade media.
- O que acontece quando lambda = 0? L2 = 0%, cobertura e so L1 base (60%). L3 abre 40% intencional.

## Requirements

### Functional Requirements

- **FR-001**: Sistema DEVE calcular posicao cambial consolidada agregando titulos a pagar USD (OMIE) e NDFs ativos, particionados por bucket mensal
- **FR-002**: Sistema DEVE implementar motor de minima variancia com 3 camadas (L1 base, L2 tatica, L3 aberta) que somam 100%
- **FR-003**: Sistema DEVE selecionar instrumento de hedge por prazo ate vencimento: <=15d Trava, <=35d NDF 30d, <=70d NDF 60d, <=100d NDF 90d, <=150d NDF 120d, >150d NDF 180d
- **FR-004**: Sistema DEVE buscar PTAX diaria da API BCB com cache de 15 minutos e validacao de sanidade (3.00-10.00)
- **FR-005**: Sistema DEVE suportar ciclo de vida completo de NDFs: pendente → ativo → liquidado/cancelado
- **FR-006**: Sistema DEVE calcular custo NDF como `notional_usd × (taxa_ndf - ptax_spot)` usando aritmetica decimal (sem ponto flutuante)
- **FR-007**: Sistema DEVE calcular resultado de liquidacao como `notional_usd × (taxa_ndf - ptax_liquidacao)`
- **FR-008**: Sistema DEVE exibir dashboard com 5 KPIs, tabela de buckets, e graficos (donut cobertura, barras exposicao, linha PTAX)
- **FR-009**: Sistema DEVE permitir filtro por localidade (deposito) em dashboard e estoque
- **FR-010**: Sistema DEVE gerar alertas automaticos por threshold de gap: critico (>=1M), alta (500K-1M), media (>0)
- **FR-011**: Sistema DEVE implementar simulacao de margem para cenarios de cambio de 4.50 a 7.50 com step 0.25
- **FR-012**: Sistema DEVE ler dados OMIE do Postgres local (sincronizado pelo n8n), nunca da API OMIE diretamente
- **FR-013**: Sistema DEVE armazenar configuracoes (lambda, localidades, thresholds) em tabela no banco, nao em arquivo
- **FR-014**: Sistema DEVE fazer soft-archive de titulos OMIE que desaparecem do sync (marcar como arquivado, nao deletar)
- **FR-015**: Sistema DEVE registrar todas as mutacoes (NDFs, config, alertas) no audit log via triggers PL/pgSQL
- **FR-016**: Sistema DEVE usar calculo financeiro exclusivamente em TypeScript, nunca em n8n ou banco
- **FR-017**: Sistema DEVE respeitar RBAC: operador visualiza e registra NDFs, gestor aprova recomendacoes e configura motor, diretor acessa tudo
- **FR-018**: Sistema DEVE exibir estoque importado por localidade com valor BRL, custo USD estimado e status de pagamento

### Key Entities

- **Bucket Mensal**: Agregacao de exposicao USD por mes-calendario. Attributes: mes_ref, pagar_usd, ndf_usd, cobertura_pct, status, empresa
- **NDF/Contrato**: Instrumento de hedge cambial. Attributes: notional_usd, taxa_ndf, ptax_contratacao, prazo_dias, data_vencimento, custo_brl, resultado_brl, status (pendente/ativo/liquidado/cancelado), tipo (NDF/Trava/ACC)
- **Titulo a Pagar**: Obrigacao USD vinda do OMIE. Attributes: omie_id, valor_usd, vencimento, bucket_mes, ptax_nf, status (aberto/liquidado/arquivado), empresa
- **PTAX Historico**: Cotacao oficial BCB por dia. Attributes: data_ref, venda, compra
- **Taxa NDF Mercado**: Taxa de mercado por prazo. Attributes: data_ref, prazo_dias (30/60/90/120/180), taxa
- **Posicao Snapshot**: Foto diaria da posicao consolidada. Attributes: data_ref, exposure_usd, ndf_ativo_usd, gap_usd, cobertura_pct, ptax_ref
- **Estoque Snapshot**: Estoque importado por localidade. Attributes: empresa, localidade, valor_brl, custo_usd_estimado, pago
- **Alerta**: Notificacao gerada pelo sistema. Attributes: tipo, severidade (critico/alta/media), mensagem, bucket_ref, lido, resolvido
- **Config Motor**: Parametros operacionais. Attributes: chave, valor, descricao

## Success Criteria

### Measurable Outcomes

- **SC-001**: Dashboard de posicao carrega em menos de 2 segundos com dados reais (6+ meses de buckets)
- **SC-002**: Motor de MV recalcula em tempo real (< 500ms) ao mover slider lambda
- **SC-003**: Calculo de custo/resultado NDF e identico ao legacy (diferenca < R$ 0.01 em 100% dos casos de teste)
- **SC-004**: PTAX atualiza automaticamente todo dia util sem intervencao manual
- **SC-005**: 100% das mutacoes (criar/editar/liquidar NDF, alterar config) geram registro no audit log
- **SC-006**: Operador consegue registrar um NDF em menos de 1 minuto
- **SC-007**: Simulacao de margem calcula 13 cenarios (4.50-7.50 step 0.25) em menos de 1 segundo
- **SC-008**: Alertas criticos sao gerados em ate 1 minuto apos calculo de posicao detectar gap >= USD 1M
- **SC-009**: Sistema funciona com PTAX desatualizada (feriado/falha BCB) usando ultima cotacao valida
- **SC-010**: Dados OMIE refletem no Atlas em ate 15 minutos apos sync do n8n (latencia do pipeline, nao do modulo)

## Assumptions

- Dados OMIE ja estao sincronizados no Postgres local pelo n8n (pipeline ja em producao). O modulo Hedge nao e responsavel pelo sync.
- A API BCB PTAX e publica e nao requer autenticacao. Rate limit e suficiente para 1 request a cada 15 minutos.
- Calculo financeiro usa aritmetica decimal (biblioteca como decimal.js ou similar). Nunca IEEE 754 float.
- O modulo Hedge opera com schema proprio `hedge.*` no Postgres. Dados compartilhados com outros modulos (C-Level, Breaking Point) serao expostos via views no schema `shared`.
- O sync OMIE → Postgres e a responsabilidade do n8n. O Hedge apenas le os dados sincronizados.
- As 5 telas do frontend sao implementadas como paginas React dentro do shell Atlas existente (/hedge/*), usando os componentes do design system (@atlas/ui).
- RBAC usa os 3 perfis existentes do Atlas (operador/gestor/diretor). Nao ha perfis especificos do Hedge.
- O legado nunca rodou em producao com dados reais. A migracao e de logica, nao de dados historicos.
