# Resumo Executivo — Atividades de 15–31/08/2026

**Responsável:** Flavio Cicato Endo
**Área:** TI / Sistemas (Jira `ACXEGDP`)
**Período:** 15–31/08/2026
**Fonte:** Jira LiveMind — projeto *ACXE - Gestão dos projetos e dos Sistemas* + apontamento de horas (Tempo)

---

## Números do período

| Indicador | Valor |
|-----------|------:|
| Tarefas **concluídas** | **12** |
| Tarefas **abertas** no período | **13** (10 já concluídas dentro da própria janela, 3 em backlog) |
| Itens movimentados no total | 15 |

> Quinzena com poucos tickets, mas com boa parte da dedicação concentrada em duas frentes que quase não geram "concluídas" no board: **CRM em semi-produção** (achados de uso real, ainda em triagem) e a **verificação diária do sistema** — juntas responderam pela maior fatia do tempo do período, mesmo sem fechar cards. Do lado dos tickets fechados, destaque para o encerramento definitivo de duas sagas: a **baixa de pedido de compra Q2P** (ACXEGDP-344, gap aberto desde junho) e o **bloat do banco do n8n** (ACXEGDP-305, "resolvido" duas vezes antes, agora com fix definitivo).

---

## Principais entregas por frente

> Legenda de status: ✅ concluída · 🔄 em andamento · ⏳ em backlog

### 1. CRM (OrbitIA) — maior consumo de tempo da quinzena
- ⏳ **ACXEGDP-325** — Semi-produção: achados de uso real (vendedores + gestor) — segue em triagem; foi a frente que mais consumiu tempo do responsável no período, de longe.
- ✅ **ACXEGDP-349** — Auditoria de telas estratégicas do gestor (28/08) — concluída em 31/08.
- ✅ **ACXEGDP-345** — Reunião de alinhamento com a OrbitIA (26/08).

### 2. Operação diária do sistema
- 🔄 **ACXEGDP-333** — Verificação diária do sistema (BD, Portainer, n8n, e-mails) — rotina que ocupou boa parte de quase todos os dias úteis; tarefa recorrente, segue "em andamento" por natureza (não é um item que "fecha").

### 3. StockBridge — fecha o gap da baixa de pedido de compra Q2P
- ✅ **ACXEGDP-344** — Recebimento não dava baixa no pedido de compra Q2P no OMIE (`AlteraPedCompra` nunca era chamado) — **CONCLUÍDA em 31/08** após validação ponta a ponta em UAT (fluxo contínuo em 3s, cron de vínculo em 21s). Backfill de 154 NFs aplicado (1 sem saldo, resolvido por carta de correção da Comex); decisão de negócio: **sem FIFO**, baixa só no pedido Q2P vinculado à NF via mapa NF↔pedido. PR #98 aberto para `main`, merge previsto junto do próximo go-live.
- ✅ **ACXEGDP-342** — Recebimento de NF Importada: erro na NF 5541.

### 4. Infraestrutura — upgrades e efeitos colaterais
- ✅ **ACXEGDP-305** — execution_data (bloat 237MB→4GB): **fix definitivo** com watchdog auto-kill multi-instância + troca de `TRUNCATE` por `DELETE` — encerra a saga aberta desde 11/07 (relatórios anteriores já haviam classificado como "resolvido" duas vezes). ⏳ Segue aberto o follow-up **ACXEGDP-351** (aplicar o mesmo endurecimento aos outros 9 fluxos de staging).
- ✅ **ACXEGDP-347** — Upgrade n8n 2.26.7 → 2.36.8 (editor, worker, webhook, mcp_api, runners).
- ⏳ **ACXEGDP-348** — Upgrade do PostgreSQL 16→17 do banco do n8n — ainda pendente (n8n 2.36.8 já avisa "compatibility support only" na versão atual).
- ✅ **ACXEGDP-352** — Efeito colateral do upgrade do n8n: processo de Sucata Parte 2 quebrou por expressão `$item()` legada — corrigido no mesmo dia. ⏳ Ação preventiva aberta: **ACXEGDP-353** — migrar `$item()` legado para `$('Node')` em 29 fluxos ativos, para não repetir o problema.
- ✅ **ACXEGDP-340** — Exporta Estoque Planejador (pendência do relatório anterior) — corrigido em 19/08.

### 5. Suporte e ajustes pontuais
- ✅ **ACXEGDP-341** — Verifica PV Faturamento: falha ao notificar reprovação (vendedor sem e-mail, SendGrid 400) — pedido 19118.
- ✅ **ACXEGDP-343** — Revisão da Planilha de Seguro.
- ✅ **ACXEGDP-350** — Novo fluxo para atualizar o BD quando cliente Q2P é criado/atualizado/excluído.
- ✅ **ACXEGDP-346** — "Banco do dia" no PV: pré-aplicar CC e flags de boleto na reprovação de crédito + rede de segurança para PVs liberados manualmente pela gerência.

---

## Em aberto para setembro

- CRM semi-produção: triagem segue aberta, foi a frente que mais consumiu tempo no mês (-325)
- Endurecer os 9 fluxos de staging restantes contra `pg_dump` zumbi (-351)
- Migração preventiva de `$item()` legado em 29 fluxos ativos (-353)
- Upgrade do PostgreSQL do n8n (16→17) (-348)
- PR #98 (baixa de pedido Q2P) aguardando merge para `main` no próximo go-live
- Migração n8n 3.0: callers do Full Sync + revisão final do guia de breaking changes (-335/337)

---

## Anexo — 12 tarefas concluídas entre 15–31/08

| Data | Chave | Tarefa |
|------|-------|--------|
| 31/08 | ACXEGDP-346 | Banco do dia no PV: CC e flags de boleto na reprovação de crédito |
| 31/08 | ACXEGDP-352 | Sucata Parte 2: falha pós-upgrade n8n ($item() legado) |
| 31/08 | ACXEGDP-344 | StockBridge: baixa de pedido de compra Q2P |
| 31/08 | ACXEGDP-305 | execution_data: bloat 237MB→4GB — fix definitivo |
| 31/08 | ACXEGDP-349 | CRM — Auditoria de telas estratégicas do gestor |
| 29/08 | ACXEGDP-350 | Fluxo de atualização do BD quando cliente Q2P é criado/alterado/excluído |
| 28/08 | ACXEGDP-347 | Upgrade n8n 2.26.7 → 2.36.8 |
| 26/08 | ACXEGDP-345 | CRM — Reunião de alinhamento com OrbitIA |
| 21/08 | ACXEGDP-343 | Revisão Planilha Seguro |
| 21/08 | ACXEGDP-342 | Recebimento de NF Importada — erro NF 5541 |
| 19/08 | ACXEGDP-340 | Exporta Estoque Planejador: falha "tabela não pode se sobrepor" |
| 19/08 | ACXEGDP-341 | Verifica PV Faturamento: falha ao notificar reprovação (SendGrid 400) |

---

*Gerado em 2026-09-01 a partir do Jira (`livemind.atlassian.net`) e do apontamento de horas (Tempo).*
