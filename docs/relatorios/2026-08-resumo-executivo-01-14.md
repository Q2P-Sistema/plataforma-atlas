# Resumo Executivo — Atividades de 01–14/08/2026

**Responsável:** Flavio Cicato Endo
**Área:** TI / Sistemas (Jira `ACXEGDP`)
**Período:** 01–14/08/2026
**Fonte:** Jira LiveMind — projeto *ACXE - Gestão dos projetos e dos Sistemas*

---

## Números do período

| Indicador | Valor |
|-----------|------:|
| Tarefas **concluídas** | **24** |
| Tarefas **abertas** no período | **13** (6 já concluídas dentro da própria janela, 7 em andamento/backlog) |
| Itens movimentados no total | 31 |

> Quinzena de duas naturezas distintas: uma grande **faxina de board** (18 cards de trabalho já entregue há semanas ou meses, finalmente fechados no Jira em duas sessões de organização — 04/08 e 08/08) e a resolução das **3 pendências sinalizadas no relatório anterior** (erro de emissão de NF por nova legislação SEFAZ, backup do banco quebrado, cálculo de impostos do OMIE). O trabalho realmente novo da quinzena girou em torno de um **bug crítico de sincronização de NF**, **dados corrompidos por entidades HTML** e o início do planejamento da migração para o **n8n 3.0**.

---

## Principais entregas por frente

> Legenda de status: ✅ concluída · 🔄 em andamento · ⏳ em backlog

### 1. Pendências do relatório anterior — todas fechadas
- ✅ **ACXEGDP-312** — Erro na emissão de NF e liquidação automática: pedidos rejeitados pelo SEFAZ por **nova legislação tributária** (regras de Triangular e Sucata).
- ✅ **ACXEGDP-317** — pgbackweb→Backblaze B2: causa raiz identificada (bug conhecido do SDK AWS Go v2 — checksums que o Backblaze não aceita); mitigado.
- ✅ **ACXEGDP-323** — OMIE `IncluirPedido`: confirmado que o bloco `det[].imposto` deve ser **omitido** para o OMIE calcular os impostos (os docs internos afirmavam o inverso).

### 2. Sync de NF — bug crítico + qualidade de dados
- ✅ **ACXEGDP-329** — Sync NF ACXE travava com `duplicate key`: a OMIE **troca o id interno (nIdNF)** da mesma NF, e o upsert não tratava a troca — nenhuma NF da ACXE sincronizava há horas. Hotfix + correção nos 5 fluxos com o mesmo padrão.
- ✅ **ACXEGDP-330** — Decodificação de **entidades HTML** do OMIE (`&amp;`, `&quot;`, `&apos;`) nas tabelas de NF — nomes de clientes apareciam corrompidos (ex.: "PCC Plastic &amp; Consultation Center").
- ✅ **ACXEGDP-331** — Mesma decodificação estendida a mais 10 tabelas (clientes, pedidos, comex, estoque, produtos, limites) — **~351 linhas** afetadas, incluindo um ciclo de "re-encoding" em fluxos que leem e regravam texto do OMIE.

### 3. StockBridge — próxima fronteira: recebimento nacional automático
- ⏳ **ACXEGDP-328** — Levantamento completo para eliminar a digitação manual no recebimento nacional (puxar itens/quantidades/valores direto da NF, como já existe na importação). Achado central: **só 4,3% dos itens têm código de produto na NF** — a correlação precisa ser assistida e memorizada por (fornecedor, descrição). Ainda em backlog — spec grande, decisões de escopo a fechar antes de especificar.
- 🔄 **ACXEGDP-332** — Investigação de NFs já recebidas que ainda aparecem como pendentes na listagem do recebimento internacional.

### 4. Infraestrutura
- ✅ **ACXEGDP-334** — Ativação da conta OMIE da **ACXE Filial**.
- 🔄 **ACXEGDP-340** — Exporta Estoque Planejador falhando com "tabela não pode se sobrepor" (13/08) — causa raiz no encadeamento de delete/create do Google Sheets sob rate limit; correção em andamento.
- ⏳ Preparação para o **n8n 3.0** (release out/2026): levantamento de impacto sobre 225 workflows (89 ativos) — a maioria já conforme; ✅ 2 subtarefas concluídas (trigger dos 6 sub-flows do Full Sync, workflow legado de snapshots migrado), 3 ainda pendentes (callers do Full Sync, revisão final do guia de breaking changes perto do release).

### 5. Faxina de board — 18 cards antigos fechados
Duas sessões de organização (04/08 e 08/08) fecharam formalmente cards de trabalho já entregue há semanas ou meses — **as datas de conclusão no Jira não refletem quando o trabalho realmente aconteceu**:

- Rotina de verificação diária/semanal de BDs (ACXEGDP-1/3/6/7).
- Negociação com a OMIE sobre reajustes (ACXEGDP-193).
- Investigação completa do travamento do n8n por OOM em junho (ACXEGDP-170 a 175) — diagnóstico, causa raiz, fix imediato, refactor em sub-workflows e validação pós-fix (heap caiu de 1,53GB para 274MB, redução de 82%).
- Auditoria de idempotência do fluxo de baixa de estoque da Filial (ACXEGDP-221).
- Fix do backup de workflows no GitHub, publicado em 10/07 (ACXEGDP-304).

> Ainda pendente de fechamento no Jira: os 3 cards de hardening pré-deploy do go-live (**ACXEGDP-176, 183, 316**) seguem "Tarefas pendentes" apesar do código estar em produção desde julho — ver relatório de 15–31/07.

---

## Em aberto para o restante de agosto

- StockBridge: recebimento nacional automático via NF — spec grande, decisões de escopo a fechar (-328)
- Verificar NFs "fantasma" no recebimento internacional (-332)
- Exporta Estoque Planejador: correção do encadeamento delete/create ainda em andamento (-340)
- n8n 3.0: callers do Full Sync + revisão final do guia de breaking changes (-337/339)
- Cards de hardening do go-live ainda não fechados no Jira (-176/183/316)

---

## Anexo — 24 tarefas concluídas entre 01–14/08

| Data | Chave | Tarefa |
|------|-------|--------|
| 10/08 | ACXEGDP-338 | Migrar/arquivar workflow DigitalOcean Snapshots (nós removidos no n8n 3.0) |
| 10/08 | ACXEGDP-336 | Atualizar Execute Workflow Trigger v1→1.2 nos 6 sub-flows do Full Sync |
| 08/08 | ACXEGDP-175 | [PENDENTE→feito] Aumentar limite de heap do n8n-runner (NODE_OPTIONS) |
| 08/08 | ACXEGDP-174 | Validação pós-refactor do OOM: heap caiu 82% (1,53GB → 274MB) |
| 08/08 | ACXEGDP-173 | Refactor do workflow monolítico em orquestrador + 3 sub-workflows |
| 08/08 | ACXEGDP-172 | Fix imediato — restart do n8n-worker via Portainer |
| 08/08 | ACXEGDP-171 | Causa raiz do OOM — workflow semanal acumulando heap por 3 empresas |
| 08/08 | ACXEGDP-170 | Diagnóstico do travamento — logs do worker, runner e Redis |
| 06/08 | ACXEGDP-334 | OMIE: ativação da conta ACXE Filial |
| 04/08 | ACXEGDP-208 | n8n — alerta de retenção causado por execuções HITL em "waiting" |
| 04/08 | ACXEGDP-304 | Backup Workflows GitHub: falha 422 no GitHub_Cria_Arquivo |
| 04/08 | ACXEGDP-221 | Auditoria idempotência — Baixa de Estoques Filial |
| 04/08 | ACXEGDP-317 | pgbackweb→Backblaze B2: falha crônica de upload multipart |
| 04/08 | ACXEGDP-323 | OMIE IncluirPedido: omitir bloco det[].imposto para calcular impostos |
| 04/08 | ACXEGDP-329 | Sync NF ACXE trava com duplicate key (OMIE troca o nIdNF) |
| 04/08 | ACXEGDP-312 | Erro na emissão de NF e liquidação automática (SEFAZ) |
| 04/08 | ACXEGDP-193 | Negociação com a OMIE acerca dos aumentos |
| 04/08 | ACXEGDP-1 | Verificação diária da saúde dos Bancos de Dados |
| 04/08 | ACXEGDP-3 | Verificação semanal dos BDs |
| 04/08 | ACXEGDP-6 | Verificar n8n |
| 04/08 | ACXEGDP-7 | Verificar Portainer |
| 04/08 | ACXEGDP-330 | Sync NF: decodificar entidades HTML do OMIE (dest_razao/x_prod) |
| 04/08 | ACXEGDP-331 | Entidades HTML do OMIE nos demais syncs (~351 linhas) |
| 03/08 | ACXEGDP-315 | Reunião com LogComex |

---

*Gerado em 2026-08-19 a partir do Jira (`livemind.atlassian.net`).*
