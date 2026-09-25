# Resumo Executivo — Atividades de 15–31/07/2026

**Responsável:** Flavio Cicato Endo
**Área:** TI / Sistemas (Jira `ACXEGDP`)
**Período:** 15–31/07/2026
**Fonte:** Jira LiveMind — projeto *ACXE - Gestão dos projetos e dos Sistemas*

---

## Números do período

| Indicador | Valor |
|-----------|------:|
| Tarefas **concluídas** | **19** |
| Tarefas **abertas** no período | **15** (4 já concluídas dentro da própria janela, 11 em andamento/backlog — incluindo o GMUD do próprio go-live) |
| Itens movimentados no total | 30 |

> Quinzena do **go-live de produção do Atlas**. A janela original de 24/07 foi **cancelada horas antes** por um bug de produção no StockBridge (NF presa em recebimento); replanejada para **31/07** com a versão **v1.1.9**, incluindo hardening de segurança pré-deploy. Volume de tickets baixo comparado às janelas anteriores — o esforço da quinzena foi concentrado em validação, artefatos de deploy e apagar incêndios, não em desenvolvimento de features novas.

---

## Principais entregas por frente

> Legenda de status: ✅ concluída · 🔄 em andamento · ⏳ em backlog · 🔥 incidente

### 1. Go-live de produção do Atlas — replanejamento e execução
- 🔥 **ACXEGDP-320** *(cancelado)* — Go-live PROD: planejamento original para **24/07** — cancelado horas antes da janela.
- 🔥 **ACXEGDP-324** — Causa do cancelamento: NF 5376 presa em "Aguardando recebimento" — aprovação de divergência não gravava o produto na movimentação (hotfix `0bfc3da` na tarde de 24/07; operação seguiu no UAT).
- 🔄 **ACXEGDP-321** — GMUD formal do go-live replanejado para **sexta 31/07, 17h30–21h00**, release **v1.1.9**; aprovado por Flavio Endo em 27/07. Card segue aberto — **PIR (revisão pós-implementação) a registrar após o go/no-go de segunda 03/08**.
- ⏳ **ACXEGDP-322** — Ativação da saída automática (n8n→Atlas) em produção — **adiada**, fora do escopo do go-live (decisão de 23/07).
- ⏳ **ACXEGDP-323** — OMIE `IncluirPedido`: omitir bloco de impostos para o OMIE calcular — ainda pendente, a revisar nos fluxos e na integração do CRM.

### 2. Correções pré-deploy (hardening de segurança e cauda da auditoria)
- ✅ **ACXEGDP-311, 275–280, 252, 254, 255, 246, 247** — últimos 12 achados da Auditoria Completa (ACXEGDP-238) fechados na manhã de 15/07, encerrando formalmente a leva de julho (ver relatório de 01–14/07).
- ✅ **ACXEGDP-313** — mensagens de erro exibiam códigos internos do OMIE em vez de descrição do produto/local — corrigido no mesmo dia em que foi aberto.
- 🔄 **ACXEGDP-316** — 2FA de gestor/diretor era barreira só *client-side* — corrigido no backend (PR #92) antes do deploy; **card ainda não fechado no Jira**.
- 🔄 **ACXEGDP-176** — e-mail de divergência de recebimento exibia "25.000 kg" em vez de "25 Kg" — corrigido (PR #93); **card ainda não fechado no Jira**.
- 🔄 **ACXEGDP-183** — posição fiscal: falso-positivo de importação por não considerar recebimento via legado — corrigido (PR #94); **card ainda não fechado no Jira**.

> Três correções pré-deploy (316, 176, 183) já estão mergeadas e em produção via UAT, mas os cards no Jira seguem em "Tarefas pendentes" — higiene de board a fazer.

### 3. StockBridge — funcionalidade e produção
- ✅ **ACXEGDP-115** — recebimento de NF com mais de um produto — card fechado em 17/07 (funcionalidade já implementada desde a feature 013/migration 0046; fechamento é organização de board).
- ✅ **ACXEGDP-177 / 178** — melhorias de distribuição de campos e rateio de valor/Kg no recebimento de NF nacional.
- 🔥 **ACXEGDP-324** — (ver seção 1) NF 5376 presa em produção — resolvido no mesmo dia.

### 4. CRM (OrbitIA) — nova fase: semi-produção
- ⏳ **ACXEGDP-325** — CRM em **semi-produção** com vendedores e gestor reais desde 22/07 — achados de uso real, ainda em backlog de triagem.

### 5. Infraestrutura — memory leak do n8n e backups
- 🔄 **ACXEGDP-326** — restart programado do `n8n_worker` por limiar de memória (2200MB) — mitigação paliativa; o leak (~142MB/dia) persiste desde a correção anterior (ACXEGDP-308).
- ⏳ **ACXEGDP-327** — causa raiz do leak ainda não identificada — próximo passo é heap snapshot diff.
- ⏳ **ACXEGDP-317** — pgbackweb→Backblaze B2: falha crônica de upload (a cada 1–4 dias) segue deixando `pg_dump` zumbi — backup automático do banco continua quebrado; **backup manual obrigatório na janela do go-live**.
- ✅ **ACXEGDP-318 / 319** — ajustes de resiliência: retry interno de 180s na Liquidação Automática de PV à Vista; correção de acks prematuros em consumidores RabbitMQ que matavam o redelivery.

### 6. Outras iniciativas
- ⏳ **ACXEGDP-314** — Cockpit Executivo v2 ("onde está o meu dinheiro") — nova visão em paralelo ao cockpit atual, ainda em backlog.
- 🔄 **ACXEGDP-315** — reunião com LogComex.

---

## Em aberto para o início de agosto

- **PIR do go-live a registrar após o go/no-go de segunda 03/08** (-321)
- CRM semi-produção — triagem dos achados de uso real (-325)
- Causa raiz do leak de memória do n8n_worker (-327)
- Backup automático do banco continua quebrado (-317)
- Cockpit Executivo v2 (-314)
- Fechar cards de hardening já entregue (-316/176/183) — pendência de higiene de board

---

## Anexo — 19 tarefas concluídas entre 15–31/07

| Data | Chave | Tarefa |
|------|-------|--------|
| 24/07 | ACXEGDP-324 | StockBridge: NF 5376 presa em "Aguardando recebimento" |
| 23/07 | ACXEGDP-178 | Recebimento NF Nacional: valor da NF total + rateio de Kg por produto |
| 23/07 | ACXEGDP-177 | Melhorar distribuição dos campos no Recebimento de Nacionais |
| 22/07 | ACXEGDP-319 | Corrigir waits parqueáveis em consumidores RabbitMQ (ack prematuro) |
| 22/07 | ACXEGDP-318 | Retry interno 180s no ExtraiCR_OMIE — Liquidação Automática PV à Vista |
| 17/07 | ACXEGDP-115 | Recebimento de NF com mais de um produto |
| 15/07 | ACXEGDP-313 | Mensagens de erro exibiam códigos internos do OMIE |
| 15/07 | ACXEGDP-255 | [EML-22] Workflow "Resumo Executivo de TI": destinatários hardcoded |
| 15/07 | ACXEGDP-254 | [EML-11/15-21] Ajustes finos de e-mail |
| 15/07 | ACXEGDP-252 | [EML-03/04/05/12/19] Dados errados e enums crus nos e-mails |
| 15/07 | ACXEGDP-247 | [SEG-09] Sem rate limit em forgot/reset-password |
| 15/07 | ACXEGDP-246 | [SEG-08] Integration key (n8n) sem comparação timing-safe |
| 15/07 | ACXEGDP-280 | [MOD-13/16] Routers montados após error handler; sem validação Zod |
| 15/07 | ACXEGDP-279 | [MOD-10/11/12] Forecast: cache/N+1, preço inflado, demanda duplicada |
| 15/07 | ACXEGDP-278 | [MOD-07/08/09/14/15] Hedge: filtro de status, datas UTC, custo NDF fictício |
| 15/07 | ACXEGDP-277 | [MOD-06] Hedge: salvarSnapshot nunca chamado (código morto) |
| 15/07 | ACXEGDP-276 | [MOD-05] Hedge: gerarAlertas sem dedup |
| 15/07 | ACXEGDP-275 | [MOD-04] Hedge: recalcularBuckets nunca zera buckets obsoletos |
| 15/07 | ACXEGDP-311 | [STK-01b] processarRecebimento: opId aleatório + OMIE pré-tx |

---

*Gerado em 2026-08-03 a partir do Jira (`livemind.atlassian.net`).*
