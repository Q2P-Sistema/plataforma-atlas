# Resumo Executivo — 2ª Quinzena de Junho/2026 (15–30/06)

**Responsável:** Flavio Cicato Endo
**Área:** TI / Sistemas (Jira `ACXEGDP`)
**Período:** 15 a 30 de junho de 2026
**Fonte:** Jira — projeto ACXEGDP (issues sob responsabilidade de Flavio)

---

## Números do período

| Indicador | Valor |
|-----------|------:|
| Issues **movimentadas** no período | **58** |
| **Concluídas** | **40** (69%) |
| Em andamento | 6 |
| Pendentes / a iniciar | 12 |
| Issues **abertas** no próprio período | 54 |

> **Destaque da quinzena:** período dominado pela **estabilização da plataforma de automação (n8n/OMIE)** — diagnóstico e correção do incidente de OOM de 14/06, refatoração dos syncs monolíticos em sub-workflows por empresa e **retry resiliente aplicado a 18 fluxos** de integração com o OMIE. Em paralelo, avançaram as correções pré-produção do **StockBridge** (conferência de estoque, filtros de NF no recebimento de importados, notificação ao Comex) e o **CRM (OrbitIA)**. Alta vazão: 40 das 58 issues movimentadas foram concluídas, com 54 novas abertas — muitas resolvidas no mesmo ciclo.

---

## Principais entregas por frente

> Legenda: ✅ concluída · 🔄 em andamento · ⏳ pendente / a iniciar

### 1. Resiliência das integrações OMIE (n8n)
- ✅ **ACXEGDP-210** — Correção do bug de *retry-chain* do OMIE (o IF de detecção de erro quebrava com `$json.error` como objeto) — **aplicada em 18 fluxos**.
- ✅ **ACXEGDP-214** — Dispatcher OMIE Faturamento: retry + Wait 90s + errorWorkflow.
- ✅ **ACXEGDP-211 / 212 / 213 / 215 / 216 / 217 / 218 / 219 / 220 / 132 / 136 / 137** — Retry resiliente nas chamadas à API OMIE (NF Itens ACXE/Q2P, Materiais a chegar, Estoque Atual, Liquidação à vista, HITL PV à vista, Verifica PV — Campos/Seguradora/Sucata, Contas a Receber, Contas a Pagar, Lista de Produtos).
- ✅ **ACXEGDP-199** — Correção da deriva de +1h/dia nos lembretes HITL de PV à vista.
- ✅ **ACXEGDP-209** — Checagem do payload Flow/Modde e da planilha de seguro.

### 2. Infraestrutura n8n (incidente OOM 14/06 + saúde da plataforma)
- ✅ **ACXEGDP-169** — Incidente n8n 14/06: diagnóstico, causa raiz e refactor do Sync Contas a Receber.
- ✅ **ACXEGDP-168** — Refactor do Sync CR Full em sub-workflows por empresa (anti-OOM).
- ✅ **ACXEGDP-180** — Split do Full Sync Contas a Pagar em sub-workflows (anti-OOM).
- ✅ **ACXEGDP-206** — Ajuste dos *task runners* (Offer expired / churn de runners).
- ✅ **ACXEGDP-191** — Atualização do n8n: 2.20.9 → 2.26.7.
- ✅ **ACXEGDP-192** — Avaliação do crescimento da tabela `execution_data`.
- ✅ **ACXEGDP-184** — Detecção de NFs canceladas no OMIE no sync de NF (ACXE, Q2P, Q2P Filial).

### 3. StockBridge / Atlas
- ✅ **ACXEGDP-198** — Conferência de Estoque ACXE × Q2P (substitui a planilha + alerta de divergências).
- ✅ **ACXEGDP-205** — Recebimento de importados: filtrar apenas NFs **emitidas pela ACXE** (evita colisão de numeração).
- ✅ **ACXEGDP-204** — Recebimento de importados: ignorar NFs **canceladas** na busca por número (`consultarNF`).
- ✅ **ACXEGDP-202** — Notificação ao Comex no recebimento de importados (e-mail de recebimento + cópia na divergência aprovada).
- ✅ **ACXEGDP-181** — Sync seletivo PROD→UAT do espelho OMIE (`public.*`) sem sobrescrever os schemas Atlas.

### 4. Bancos / Seguro / Faturamento
- ✅ **ACXEGDP-203** — Bradesco: redução do limite operacional de faturamento (R$ 17M → R$ 7M).
- ✅ **ACXEGDP-195** — Banco Flow: falha no envio de dados — validação junto ao fornecedor.
- ✅ **ACXEGDP-207** — Modde enviando dados incorretos — reunião com a equipe técnica deles.
- ✅ **ACXEGDP-196 / ACXEGDP-197** — Remoção de e-mail indevido nos fluxos de Verifica PV (Ajusta Seguradora/Fintech e Sucata/Fintechs).

### 5. Site ACXE
- ✅ **ACXEGDP-179** — Fix: homepage exibindo apenas "Homepage 2026" (template PHP não aplicado).
- ✅ **ACXEGDP-182** — Criação e configuração do favicon em acxe-polimeros.com.br.
- ✅ **ACXEGDP-32** — Ajustes gerais no site da ACXE.

### 6. Suporte / Operação
- ✅ **ACXEGDP-151** — Suporte à planilha de conferência de estoques (Gustavo).
- ✅ **ACXEGDP-167** — Suporte ao recebimento (Gustavo Dreer).
- ✅ **ACXEGDP-190** — Suporte OMIE (Milena) — ajuste de permissão.
- ✅ **ACXEGDP-194** — Reunião com Gustavo e Gabis para alinhar o fluxo de informação Comex/Logística.

---

## Em andamento
- 🔄 **ACXEGDP-119** — CRM (contínuo).
- 🔄 **ACXEGDP-193** — Negociação com a OMIE sobre os reajustes.
- 🔄 **ACXEGDP-1** — Verificação diária da saúde dos bancos de dados (rotina).
- 🔄 **ACXEGDP-3** — Verificação semanal dos BDs (rotina).
- 🔄 **ACXEGDP-6** — Verificar n8n (rotina).
- 🔄 **ACXEGDP-7** — Verificar Portainer (rotina).

## Pendentes / a iniciar
- ⏳ **ACXEGDP-183** — Posição Fiscal: corrigir falso-positivo de importação (Parte A — mapa NF mãe/filhote).
- ⏳ **ACXEGDP-178** — Recebimento de NF Nacional: valor total da NF + balanceamento de R$/Kg por produto.
- ⏳ **ACXEGDP-177** — Melhorar a distribuição dos campos no Recebimento de Nacionais.
- ⏳ **ACXEGDP-176** — Corrigir e-mail de aprovação: 25 Kg aparecendo como 25.000 kg.
- ⏳ **ACXEGDP-221** — Auditoria de idempotência: Baixa de Estoques Filial (retry nativo em criação sem chave).
- ⏳ **ACXEGDP-208** — n8n: alerta de retenção (`execution_data`) por execuções HITL em estado "waiting".
- ⏳ **ACXEGDP-175** — Aumentar limite de heap do n8n-runner (`NODE_OPTIONS`).
- ⏳ **ACXEGDP-174** — Validação e métricas de memória pós-refactor.
- ⏳ **ACXEGDP-173** — Refactor do workflow monolítico em orquestrador + 3 sub-workflows por empresa.
- ⏳ **ACXEGDP-172** — Restart do container n8n-worker via Portainer.
- ⏳ **ACXEGDP-171** — Identificação da causa raiz do OOM no JS Runner (workflow semanal).
- ⏳ **ACXEGDP-170** — Diagnóstico do travamento (logs do worker, runner e Redis).

---

## Anexo — 40 entregas concluídas no período

| Data | Chave | Entrega |
|------|-------|---------|
| 30/06 | ACXEGDP-220 | Verifica PV Sucata/Fintechs: robustecer retry OMIE (Wait 60→90s) |
| 30/06 | ACXEGDP-219 | Verifica PV Ajusta Seguradora/Fintech: retry resiliente OMIE |
| 30/06 | ACXEGDP-218 | HITL Aprovação PV à vista: retry resiliente OMIE |
| 30/06 | ACXEGDP-217 | Verifica PV Campos Faturamento: retry resiliente OMIE |
| 30/06 | ACXEGDP-216 | Liquidação à vista: robustecer retry OMIE (Wait 60→90s) |
| 30/06 | ACXEGDP-215 | Estoque Atual: robustecer retry OMIE (Wait 60→90s) |
| 30/06 | ACXEGDP-214 | Dispatcher OMIE Faturamento: retry + Wait 90s + errorWorkflow |
| 30/06 | ACXEGDP-213 | Materiais a chegar: retry resiliente OMIE |
| 30/06 | ACXEGDP-212 | NF Itens Q2P: retry resiliente OMIE |
| 30/06 | ACXEGDP-211 | NF Itens ACXE: retry resiliente OMIE |
| 30/06 | ACXEGDP-210 | Bug retry-chain OMIE (IF quebrava com objeto) — corrigido em 18 fluxos |
| 30/06 | ACXEGDP-136 | Lista de Produtos: retry resiliente OMIE |
| 30/06 | ACXEGDP-132 | Contas a Receber: retry resiliente OMIE |
| 30/06 | ACXEGDP-137 | Contas a Pagar: retry resiliente OMIE |
| 30/06 | ACXEGDP-209 | Checagem do payload Flow/Modde e da planilha de seguro |
| 26/06 | ACXEGDP-207 | Modde enviando dados incorretos — reunião técnica |
| 25/06 | ACXEGDP-206 | n8n: diagnóstico e ajuste dos task runners (Offer expired / churn) |
| 24/06 | ACXEGDP-198 | StockBridge: Conferência de Estoque ACXE × Q2P |
| 24/06 | ACXEGDP-205 | Recebimento de importados: filtrar só NFs emitidas pela ACXE |
| 24/06 | ACXEGDP-204 | Recebimento de importados: ignorar NFs canceladas (consultarNF) |
| 23/06 | ACXEGDP-203 | Bradesco: limite de faturamento R$ 17M → R$ 7M |
| 23/06 | ACXEGDP-202 | StockBridge: notificar Comex no recebimento de importados |
| 23/06 | ACXEGDP-199 | Correção da deriva de +1h/dia nos lembretes HITL à vista |
| 22/06 | ACXEGDP-151 | Suporte à planilha de conferência de estoques (Gustavo) |
| 22/06 | ACXEGDP-197 | Remover e-mail indevido do fluxo Verifica PV Sucata/Fintechs |
| 22/06 | ACXEGDP-196 | Remover e-mail indevido do fluxo Verifica PV Seguradora/Fintech |
| 19/06 | ACXEGDP-195 | Banco Flow falhou no envio de dados — validação com o fornecedor |
| 19/06 | ACXEGDP-194 | Reunião com Gustavo e Gabis — fluxo de informação Comex/Logística |
| 18/06 | ACXEGDP-184 | Detectar NFs canceladas no OMIE no sync de NF (ACXE, Q2P, Filial) |
| 18/06 | ACXEGDP-192 | Avaliação do crescimento da tabela execution_data (n8n) |
| 18/06 | ACXEGDP-191 | Atualização do n8n: 2.20.9 → 2.26.7 |
| 18/06 | ACXEGDP-190 | Suporte OMIE para Milena — ajuste de permissão |
| 15/06 | ACXEGDP-179 | Fix: homepage exibindo só "Homepage 2026" (template PHP) |
| 15/06 | ACXEGDP-181 | Sync seletivo PROD→UAT do espelho OMIE sem sobrescrever Atlas |
| 15/06 | ACXEGDP-182 | Favicon do site acxe-polimeros.com.br |
| 15/06 | ACXEGDP-180 | Split Full Sync Contas a Pagar em sub-workflows (anti-OOM) |
| 15/06 | ACXEGDP-168 | Refactor Sync CR Full em sub-workflows por empresa (anti-OOM) |
| 15/06 | ACXEGDP-169 | Incidente n8n 14/06: diagnóstico, causa raiz e refactor Sync CR |
| 15/06 | ACXEGDP-32 | Ajustes gerais no site da ACXE |
| 15/06 | ACXEGDP-167 | Suporte ao recebimento (Gustavo Dreer) |

---

*Gerado em 01/07/2026 — dados extraídos do Jira (projeto ACXEGDP), período 15–30/06/2026.*
