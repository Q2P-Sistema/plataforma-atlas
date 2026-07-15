# Resumo Executivo — Atividades de 01–14/06/2026

**Responsável:** Flavio Cicato Endo
**Área:** TI / Sistemas (Jira `ACXEGDP`)
**Período:** 01–14/06/2026
**Fonte:** Jira LiveMind — projeto *ACXE - Gestão dos projetos e dos Sistemas*

---

## Números do período

| Indicador | Valor |
|-----------|------:|
| Tarefas **concluídas** | **22** |
| Tarefas **abertas** no período | **25** (19 já concluídas dentro da própria janela, 3 em andamento, 3 em backlog) |
| Itens movimentados no total | 28 |

> Quinzena concentrada na **evolução do Cockpit StockBridge** e no **ensaio de UAT** do Atlas como ambiente de pré-produção — a maior parte das entregas de maio (CMC, trânsito, posição fiscal) amadureceu e foi validada nestes 14 dias.

---

## Principais entregas por frente

> Legenda de status: ✅ concluída · 🔄 em andamento · ⏳ em backlog

### 1. Cockpit StockBridge — visão executiva
Frente central da quinzena: transformar o cockpit em painel de decisão, com dados corretos e navegação por camadas de estoque.

- ✅ **ACXEGDP-145** — Cockpit: **filtros multi-select** + esteira visual + layout executivo.
- ✅ **ACXEGDP-146** — Cockpit: **whitelist de galpões físicos** + Comodato + leitura direta de `tbl_posicaoEstoque`.
- ✅ **ACXEGDP-155** — Refinamento do Cockpit: validação da fonte dos dados (Trânsito, Nacionalização, Disponível).
- ✅ **ACXEGDP-148** — **Trânsito por NF**: migration 0036 + coluna única Nacionalização + sync do MySQL legado.
- ✅ **ACXEGDP-159** — **Posição Fiscal** via mapa NF mãe/filhote (`stockbridge.nf_pedido_mapa`).
- ✅ **ACXEGDP-162** — Exportar mapa **NF mãe/filhote** da FUP para o Atlas (extensão do workflow FUP→BD).
- ⏳ **ACXEGDP-157** — Validar posição fiscal no cockpit StockBridge (backlog).

### 2. CMC por família e produto
Continuidade do relatório de CMC iniciado em maio, com correção de dados e de fuso horário.

- ✅ **ACXEGDP-149** — StockBridge: visão de **CMC por família e produto**.
- ✅ **ACXEGDP-141** — Relatório **CMC por família**, separando nacional e importado (trabalho aberto em maio, fechado nesta janela).
- ✅ **ACXEGDP-154** — Fix de **timezone da sessão Postgres** (America/Sao_Paulo) — corrigia falso "dado defasado" no CMC.
- ✅ **ACXEGDP-161** — Fix: workflow de **Histórico CMC Estoque** falhava com `NULL` em `codigo_produto`.

### 3. UAT — ensaio de produção do Atlas
Subida do Atlas em UAT como ensaio de produção, fechando lacunas antes do go-live.

- ✅ **ACXEGDP-153** — **UAT** — subir Atlas (StockBridge + Forecast/Hedge/BreakingPoint) como ensaio de produção.
- ✅ **ACXEGDP-147** — **Sync prod→dev**: FUP Comex + pedidos de compra + locais de estoque + refresh automático.
- ✅ **ACXEGDP-156** — Teste de **recebimento nacional e importado** em UAT com dados reais no OMIE.
- ✅ **ACXEGDP-158** — Fechar **3 gaps pré-produção**: migração MySQL, documentação, n8n.
- ⏳ **ACXEGDP-150** — StockBridge: **controle de inventário físico** (físico × sistema × fiscal) — backlog.

### 4. CRM (OrbitIA) — testes ⚠️ maior consumo de horas da quinzena
- ⏳ **ACXEGDP-163** — Testes da plataforma **CRM (OrbitIA)** — aberta em 10/06, ainda em backlog no board.

> O board mostra o card como "backlog", mas ele já concentra o **maior esforço em horas de todo o período**: **43 lançamentos de tempo** e **75 comentários**, somando **~51h de trabalho registradas** entre 10/06 e a data deste relatório (15/07). Dentro da própria janela 01–14/06 o registro de horas ainda era pequeno (~52min, nos dias 10 e 11/06) — o grosso da dedicação veio depois —, mas o volume acumulado já torna os testes do CRM a frente que mais consumiu tempo do responsável, desproporcional ao status "backlog" que aparece no board.

### 5. Automações n8n / infraestrutura
Manutenção e organização do ambiente de workflows.

- ✅ **ACXEGDP-160** — Debug: **travamento do banco n8n** por crescimento da tabela `execution_data`.
- ✅ **ACXEGDP-166** — **Limpeza do n8n**: exclusão de 17 workflows arquivados.
- ✅ **ACXEGDP-164** — Workflow **Flow**: chaveamento por Business Unit + desenvolvimento do fluxo para a segunda BU.
- ✅ **ACXEGDP-165** — Macro **AlternarProtecao**: adição da aba "NF ENTRADA" às exceções de proteção.

### 6. Financeiro, seguro e suporte
- ✅ **ACXEGDP-142** — Correção de **problema na planilha de Seguros**.
- ✅ **ACXEGDP-152** — **Planejador** — revisão com Gabis.
- ✅ **ACXEGDP-118** — Baixa automática no módulo financeiro dos PV à vista (trabalho de maio, encerrado formalmente em 05/06).
- ✅ **ACXEGDP-129** — Resolução do problema do **OneDrive** da Milena e Rafaela (trabalho de maio, encerrado formalmente em 11/06).
- 🔄 **ACXEGDP-143** — Criar **check-list para o faturamento** (aberta 02/06, ainda em andamento).
- 🔄 **ACXEGDP-151** — Suporte à planilha de **conferência de estoques** — Gustavo (aberta 08/06, ainda em andamento).
- 🔄 **ACXEGDP-167** — Suporte para o **recebimento** — Gustavo Dreer (aberta 13/06, ainda em andamento).

---

## Em aberto para o restante de junho (destaques do backlog)

- Validar posição fiscal no cockpit StockBridge (-157)
- Controle de inventário físico do StockBridge (físico × sistema × fiscal) (-150)
- **Testes da plataforma CRM / OrbitIA (-163) — maior consumo de horas em aberto, ~51h já registradas**
- Check-list de faturamento, conferência de estoques e suporte de recebimento em andamento (-143/151/167)

---

## Anexo — 22 tarefas concluídas entre 01–14/06

| Data | Chave | Tarefa |
|------|-------|--------|
| 14/06 | ACXEGDP-166 | Limpeza n8n: exclusão dos 17 workflows arquivados |
| 12/06 | ACXEGDP-164 | Workflow Flow: chaveamento por BU e fluxo para segunda BU |
| 11/06 | ACXEGDP-129 | Resolução do problema do OneDrive da Milena e Rafaela |
| 11/06 | ACXEGDP-162 | Exportar mapa NF mãe/filhote da FUP para o Atlas |
| 11/06 | ACXEGDP-165 | Macro AlternarProtecao: aba "NF ENTRADA" nas exceções de proteção |
| 10/06 | ACXEGDP-159 | Posição Fiscal via mapa NF mãe/filhote (stockbridge.nf_pedido_mapa) |
| 10/06 | ACXEGDP-161 | Fix: Workflow Histórico CMC Estoque falha com NULL em codigo_produto |
| 10/06 | ACXEGDP-160 | Debug: travamento do banco n8n por crescimento da tabela execution_data |
| 09/06 | ACXEGDP-158 | Fechar 3 gaps pré-produção: migração MySQL, docs, n8n |
| 09/06 | ACXEGDP-153 | UAT — subir Atlas como ensaio de produção |
| 09/06 | ACXEGDP-155 | Refinamento do Cockpit: validar fonte dos dados |
| 09/06 | ACXEGDP-156 | Teste de recebimento nacional e importado em UAT com dados reais no OMIE |
| 09/06 | ACXEGDP-141 | Relatório CMC por família — nacional vs. importado |
| 08/06 | ACXEGDP-154 | Fix timezone da sessão Postgres — falso "dado defasado" no CMC |
| 08/06 | ACXEGDP-149 | StockBridge: visão de CMC por família e produto |
| 08/06 | ACXEGDP-152 | Planejador — revisão com Gabis |
| 05/06 | ACXEGDP-148 | Trânsito por NF: migration 0036 + Nacionalização + sync MySQL legado |
| 05/06 | ACXEGDP-147 | Sync prod→dev: FUP Comex + pedidos compra + locais de estoque |
| 05/06 | ACXEGDP-146 | Cockpit: whitelist de galpões físicos + Comodato |
| 05/06 | ACXEGDP-145 | Cockpit: filtros multi-select + esteira visual + layout executivo |
| 05/06 | ACXEGDP-118 * | Baixa automática no módulo financeiro dos pedidos à vista |
| 02/06 | ACXEGDP-142 | Problema na planilha de Seguros |

---

\* ACXEGDP-118: trabalho concluído em maio; card formalmente encerrado no Jira em 05/06/2026.

*Gerado em 2026-07-15 a partir do Jira (`livemind.atlassian.net`).*
