# Resumo Executivo — Atividades de Maio/2026

**Responsável:** Flavio Cicato Endo
**Área:** TI / Sistemas (Jira `ACXEGDP`)
**Período:** 01–31/05/2026
**Fonte:** Jira LiveMind — projeto *ACXE - Gestão dos projetos e dos Sistemas*

---

## Números do mês

| Indicador | Valor |
|-----------|------:|
| Tarefas **concluídas** | **29** |
| Tarefas **abertas** no mês | **43** (25 já concluídas, 4 em andamento, 14 em backlog) |
| Itens movimentados no total | 51 |

> Mês de **alta vazão operacional**: a maioria das demandas foi aberta **e** resolvida dentro do próprio mês — resposta rápida a incidentes e pedidos do negócio.

---

## Principais entregas por frente

> Legenda de status: ✅ concluída · 🔄 em andamento · ⏳ em backlog

### 1. Pedido de Venda à vista (PV à vista) — automação financeira
Frente central do mês: estruturar e estabilizar o processamento automático dos pedidos de venda à vista, do lançamento à baixa financeira.

- ✅ **ACXEGDP-102** — Desenvolvimento do **novo fluxo de PV à vista** de ponta a ponta (base do processo automatizado).
- ✅ **ACXEGDP-111** — Implementação do fluxo de **edição de Centro de Custo (CC)** no PV à vista.
- ✅ **ACXEGDP-140** — Correção do erro no fluxo de **liquidação automática** do PV à vista (fluxo `ROJwOePZNXLiZ8cC`).
- ✅ **ACXEGDP-107** — Investigação e correção de PV que disparou o **e-mail de validação em duplicidade** (caso Cláudio).
- ✅ **ACXEGDP-118** — **Baixa automática** no módulo financeiro dos pedidos à vista.

### 2. Seguro de Crédito / Allianz
Saneamento da integração com a seguradora, eliminando divergências que afetavam a aprovação de pedidos.

- ✅ **ACXEGDP-128** — **Ressincronização** da planilha de Seguro-Crédito após clientes receberem nova *tag*.
- ✅ **ACXEGDP-127** — Correção de **clientes sem CNPJ** na tabela da Allianz.
- ✅ **ACXEGDP-135** — Correção da **variação indevida de limite** de crédito de alguns clientes.
- ✅ **ACXEGDP-109** — **Migração** da planilha de Seguro-Crédito para a nova versão (remoção do arredondamento de 0,01).
- ⏳ **ACXEGDP-110** — Ajuste do fluxo de integração **Flow ↔ Allianz** (backlog).

### 3. Confiabilidade das automações (n8n / OMIE)
Redução de falhas e de carga desnecessária na API do OMIE, deixando os workflows mais resilientes.

- ✅ **ACXEGDP-121** — Correção do **worker n8n** que falhava ao disparar o fluxo de exportação de materiais para o Planejador.
- ✅ **ACXEGDP-126** — **Eliminação de chamadas redundantes** ao OMIE `ConsultarPedido` entre os workflows que consomem o evento `VendaProduto.Faturada`.
- ✅ **ACXEGDP-104** — Correção de erro na **automação do iPack**.
- ✅ **ACXEGDP-103** — Correção de erro na **automação do WAMC → FUP**.
- ⏳ **ACXEGDP-131/132/136/137** — Revisão de fluxos para adicionar **retries na API do OMIE** (resiliência a falhas transitórias — backlog iniciado).

### 4. Infraestrutura
Organização e tuning do ambiente de execução dos serviços.

- ✅ **ACXEGDP-123** — **Rebalanceamento do Docker Swarm**: redistribuição de stacks entre nós e ajuste de recursos.
- ⏳ **ACXEGDP-125** — *Handoff*: conversão das stacks do **Portainer** para o padrão `${VAR}` (parametrização).
- ⏳ **ACXEGDP-124** — Criação de **repositório no GitHub** para versionar as stacks de infraestrutura.

### 5. Dados & Relatórios
Ampliação da base de dados analítica e novos relatórios para o negócio.

- ✅ **ACXEGDP-105** — Implementação da **coleta de NFs** da ACXE e Q2P para o banco de dados.
- ✅ **ACXEGDP-134** — **Relatório de movimentação** de entrada de Pedidos Comex.
- ✅ **ACXEGDP-130** — Desenvolvimento da **coleta de parcelas descontadas**.
- ✅ **ACXEGDP-133** — Alteração do **horário de fechamento** do ciclo de faturamento para as 9h.
- 🔄 **ACXEGDP-141** — Relatório **CMC por família**, separando nacional e importado.
- ⏳ **ACXEGDP-138** — Coleta de **carteira descontada** para Itaú e Bradesco (backlog).

### 6. Plataforma ATLAS / StockBridge & CRM
Evolução dos produtos internos de médio/longo prazo.

- ✅ **ACXEGDP-89** — Continuidade do **desenvolvimento da plataforma ATLAS**.
- ✅ **ACXEGDP-120** — Criação do **banco de UAT** para o novo CRM.
- 🔄 **ACXEGDP-114** — Desenvolvimento do **módulo StockBridge** (gestão de estoque/recebimento).
- 🔄 **ACXEGDP-119** — Iniciativa de **CRM**.
- ⏳ **ACXEGDP-115** — Suporte a **recebimento de NF com mais de um produto** no StockBridge (backlog).

### 7. Suporte e acessos (TI ops)
Atendimento ao dia a dia de usuários, acessos e incidentes pontuais.

- ✅ **ACXEGDP-139** — Criação de **acesso no OMIE** para nova funcionária.
- ✅ **ACXEGDP-112** — Ajuste de **acesso do Gustavo Dreer** na ACXE.
- ✅ **ACXEGDP-72** — **Suporte à FUP**: ajustes para a nova requisição da Rachel.
- ✅ **ACXEGDP-101** — Investigação de **problema de estoque** com o PN PP HPRF550.
- ✅ **ACXEGDP-113** — Ajuste de **pedidos de Comex** alterados que não refletiram na Q2P.
- ✅ **ACXEGDP-100** — Investigação de PV do cliente Mariol **aprovado apesar de falta de seguro**.
- 🔄 **ACXEGDP-129** — Resolução do problema do **OneDrive** da Milena e Rafaela.

---

## Em aberto para junho (destaques do backlog)

- Revisão dos fluxos OMIE com *retries* (-131/132/136/137)
- Padronização de stacks Portainer + repositório de Infra (-124/125)
- Sistema de resumo de ofertas do WhatsApp (-116)
- CRM (-119)
- Relatório CMC por família — nacional vs. importado (-141)

---

## Anexo — 29 tarefas concluídas em maio

| Data | Chave | Tarefa |
|------|-------|--------|
| mai/26 * | ACXEGDP-118 | Baixa automática no módulo financeiro dos pedidos à vista |
| 28/05 | ACXEGDP-140 | Erro no fluxo de liquidação automática de PV à vista |
| 28/05 | ACXEGDP-134 | Relatório de movimentação de entrada de Pedidos Comex |
| 28/05 | ACXEGDP-139 | Acesso no OMIE para nova funcionária |
| 28/05 | ACXEGDP-135 | Seguro e crédito — variação indevida de limites |
| 27/05 | ACXEGDP-130 | Coleta dos dados de parcelas descontadas |
| 27/05 | ACXEGDP-133 | Fechamento do ciclo de faturamento às 9h |
| 25/05 | ACXEGDP-121 | n8n worker falhando no fluxo de exportar materiais p/ planejador |
| 20/05 | ACXEGDP-128 | Planilha de Seguro-Crédito dessincronizada |
| 20/05 | ACXEGDP-127 | Clientes sem CNPJ na tabela da Allianz |
| 19/05 | ACXEGDP-126 | Eliminar chamadas redundantes ao OMIE ConsultarPedido |
| 18/05 | ACXEGDP-123 | Rebalanceamento do Docker Swarm |
| 14/05 | ACXEGDP-120 | Criar o BD de UAT para CRM |
| 14/05 | ACXEGDP-33  | Reunião Semanal TI |
| 14/05 | ACXEGDP-72  | Suporte com a FUP — requisição da Rachel |
| 14/05 | ACXEGDP-89  | Desenvolvimento do ATLAS |
| 14/05 | ACXEGDP-105 | Coleta de NFs da ACXE e Q2P para BD |
| 14/05 | ACXEGDP-111 | Fluxo de edição de CC no PV à vista |
| 14/05 | ACXEGDP-113 | Ajustar pedidos de Comex não refletidos na Q2P |
| 14/05 | ACXEGDP-112 | Ajustar acesso Gustavo Dreer na ACXE |
| 12/05 | ACXEGDP-109 | Planilha do Seguro-Crédito — nova versão sem 0,01 |
| 11/05 | ACXEGDP-102 | Novo fluxo para PV à vista |
| 11/05 | ACXEGDP-107 | PV do Cláudio emitiu duas vezes e-mail de validação |
| 11/05 | ACXEGDP-104 | Erro na automação do iPack |
| 11/05 | ACXEGDP-103 | Erro na automação do WAMC para FUP |
| 07/05 | ACXEGDP-101 | Problema de estoque com o PN PP HPRF550 |
| 07/05 | ACXEGDP-100 | PV do cliente Mariol aprovado sem seguro |
| 04/05 | ACXEGDP-98  | Nova funcionalidade de validação dos Pedidos de Vendas |
| 04/05 | ACXEGDP-99  | Atualizar vendas no Planejador |

---

\* ACXEGDP-118: trabalho concluído em maio; card formalmente encerrado no Jira em 05/06/2026.

*Gerado em 2026-06-05 a partir do Jira (`livemind.atlassian.net`).*
