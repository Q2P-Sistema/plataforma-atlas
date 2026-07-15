# Resumo Executivo — Atividades de 01–14/07/2026

**Responsável:** Flavio Cicato Endo
**Área:** TI / Sistemas (Jira `ACXEGDP`)
**Período:** 01–14/07/2026
**Fonte:** Jira LiveMind — projeto *ACXE - Gestão dos projetos e dos Sistemas*

---

## Números do período

| Indicador | Valor |
|-----------|------:|
| Tarefas **concluídas** | **71** |
| Tarefas **abertas** no período | **89** (64 já concluídas dentro da própria janela, 12 concluídas em 15/07 — dia seguinte ao corte, 13 em andamento/backlog) |
| Itens movimentados no total | 96 |

> Quinzena dominada por duas frentes de grande porte que convergiram no mesmo período: o fechamento de **+40 achados da Auditoria Completa da Plataforma Atlas** (segurança, módulos financeiros, StockBridge, pt-BR, e-mails, UI) e a virada de chave nas **correções do CRM (OrbitIA)**, resultado direto das ~51h de testes concluídas em junho. Some-se a isso uma sequência de incidentes operacionais pontuais, com destaque para um bug de 2FA que travava o login de qualquer gestor/diretor.

---

## Principais entregas por frente

> Legenda de status: ✅ concluída · 🔄 em andamento · ⏳ em backlog · 🔥 incidente

### 1. Auditoria completa da Plataforma Atlas (ACXEGDP-238)
Epic segue "em andamento" no board, mas nesta janela a grande maioria dos ~52 achados foi corrigida e verificada adversarialmente (multi-agente, jul/2026).

- ✅ **Segurança (SEG-01 a SEG-10 — 10 achados)**: reset de senha montado a partir do header `Origin` (account takeover), CORS refletindo qualquer origem com `credentials:true`, CSRF gerado mas nunca validado, headers de segurança ausentes, IDOR de escopo de galpão, sem rate limit em 2FA/reset de senha, lockout de login por IP+conta. **10/10 fechados** (8 nesta janela, 2 no dia seguinte, 15/07).
- ✅ **Módulos financeiros — Hedge/Forecast/Breaking Point/API (MOD-01 a MOD-25)**: motor de Hedge usava as taxas NDF **mais antigas** em vez das mais recentes, vendas de 12 meses contadas em dobro/quádruplo para produtos multi-local, títulos vencidos excluídos da projeção de caixa do Breaking Point. **Todos os grupos fechados** (7 nesta janela, 6 no dia seguinte).
- ✅ **StockBridge (STK-01 a STK-23)**: ajuste OMIE duplicado por corrida de `opId`, NF com divergência podia ser recebida duas vezes, retorno de comodato marcado como concluído com Q2P ainda pendente. **12 de 13 grupos fechados nesta janela** (+1 follow-up no dia seguinte); resta em backlog **STK-19a/19c** (wire do modo real do OMIE).
- ✅ **pt-BR (PTB-1 a PTB-5)**: acentuação e formatação de número/data corrigidas no Hedge, Forecast e StockBridge. **5/5 fechados**.
- ✅ **E-mails (EML-01 a EML-22, 7 grupos)**: acentuação ausente em quase todos os e-mails do sistema, template inconsistente entre módulos, texto livre interpolado no HTML sem escape. **7/7 grupos fechados** (4 nesta janela, 3 no dia seguinte).
- ✅ **UI/UX (UI-A a UI-F)**: tema dark sem variante em várias telas, paleta de cores duplicada, StockBridge com 17 subitens sem agrupamento, modais hand-rolled sem acessibilidade. **6/6 fechados**.

> 12 dos achados acima (2 de Segurança, 6 de Módulos, 3 de E-mails, 1 de StockBridge) foram encerrados formalmente em 15/07 — um dia após o corte deste relatório —, mas fazem parte da mesma leva de verificação desta janela.

### 2. Correções do CRM (OrbitIA)
Continuação direta das ~51h de testes concluídas em junho (ACXEGDP-163).

- ✅ **Batch 1 completo (5/5)**: Metas, Carteira, Agenda, Cadastro de Cliente, Pedidos/Novo Pedido (Findings 1–12).
- 🔄 **Batch 2 em andamento (5/14 fechados)**: Autenticação (F13), Pedidos (F20), Agenda (F32/F36), Configurações de Usuários (F16), UX Global (F14/F34/F37).
- ⏳ **9 achados de Batch 2 ainda em backlog — incluindo 2 CRÍTICOS e 1 BLOQUEANTE**: Cadastro de Cliente (F30/F49, CRÍTICO), Configurações de Comissão (F39/F45/F31, CRÍTICO), Novo Pedido (F12/17-18/22-25/33/35/38/46, **BLOQUEANTE**), Metas (F15), Carteira (F19/21/26), Painel Diretor (F29/40-44/48), Estoque (F27) e melhoria de Config. de Metas (F47).

> O CRM não deve avançar para produção enquanto os achados críticos e o bloqueante de Novo Pedido não forem fechados.

### 3. Incidentes e operação
- 🔥 **ACXEGDP-307** — 2FA travava o login de **qualquer gestor/diretor** já configurado em "Carregando..." (`/login` e `/verify-2fa` não devolviam `totp_enabled`) — bug crítico de acesso, corrigido em 13/07.
- 🔥 **ACXEGDP-305/306** — banco do n8n inchou de 237MB para 4GB por `pg_dump` zumbi do pgbackweb (falha no upload ao Backblaze B2); `VACUUM FULL` + prevenções (role dedicada, timeouts, webhook de falha, watchdog).
- ✅ **ACXEGDP-222** — análise dos limites Modde zerados em massa (98,6% dos clientes).
- ✅ **ACXEGDP-291/292/293/310** — fluxo HITL de aprovação de PV à vista: pedido já faturado antes da decisão do Financeiro, URL de decisão errada no lembrete, retry-chain reenviando objeto de erro em vez do payload, wait de retry aumentado de 90s para 180s.
- 🔄 **ACXEGDP-312** — erro na emissão de NF e na liquidação automática — aberto em 14/07, ainda em investigação.
- ✅ **ACXEGDP-303** — investigação de NFs não sincronizadas (validação indeterminada em recebimentos).
- ✅ **ACXEGDP-297 / 300 / 302** — revisão da planilha de Seguro, suporte de importação (Gustavo), atualização da planilha de vendas de junho.
- ✅ **ACXEGDP-294 / 295 / 296 / 308 / 309** — padronização de e-mails dos 26 workflows ativos do n8n, FUP semanal FIDC, monitor de `execution_data` e de tendência de memória dos containers.
- ✅ **ACXEGDP-143** — check-list de faturamento (aberta em junho, fechada em 06/07).

---

## Em aberto para o restante de julho

- **CRM Batch 2 — 9 achados pendentes, incluindo 2 críticos e 1 bloqueante** (-224/225/226/227/228/230/233/235/236)
- StockBridge: wire do modo real do OMIE para `alterarPedidoCompra` (-299)
- Erro ativo na emissão de NF / liquidação automática (-312)
- Backup de workflows no GitHub: falha 422 no `GitHub_Cria_Arquivo` (-304)
- Auditoria completa (-238): epic-mãe ainda formalmente "em andamento" apesar dos achados fechados

---

## Anexo A — 28 tarefas de operação/CRM concluídas entre 01–14/07

| Data | Chave | Tarefa |
|------|-------|--------|
| 14/07 | ACXEGDP-310 | Liquidação Automática PV à Vista: wait de retry de 90s para 180s |
| 14/07 | ACXEGDP-308 | manager-01: memória em tendência de esgotamento (88%) |
| 14/07 | ACXEGDP-309 | n8n: monitor de tendência de memória dos containers |
| 13/07 | ACXEGDP-307 | 2FA: login de gestor/diretor travava em "Carregando..." |
| 11/07 | ACXEGDP-306 | Prevenções anti-zumbi de backup (role, timeouts, webhook, watchdog) |
| 11/07 | ACXEGDP-305 | execution_data: bloat 237MB→4GB por pg_dump zumbi do pgbackweb |
| 07/07 | ACXEGDP-232 | [CRM] Correções Batch 2 — UX Global (F14, F34, F37) |
| 07/07 | ACXEGDP-234 | [CRM] Correções Batch 2 — Configurações Usuários (F16) |
| 07/07 | ACXEGDP-189 | [CRM] Correções Batch 1 — Pedidos e Novo Pedido (Findings 10-12) |
| 07/07 | ACXEGDP-229 | [CRM] Correções Batch 2 — Agenda (F32, F36) |
| 07/07 | ACXEGDP-231 | [CRM] Correções Batch 2 — Pedidos (F20) |
| 07/07 | ACXEGDP-186 | [CRM] Correções Batch 1 — Cadastro de Cliente (Findings 5-7) |
| 07/07 | ACXEGDP-223 | [CRM] Correções Batch 2 — Autenticação (F13) |
| 06/07 | ACXEGDP-303 | Investigar NFs não sincronizadas |
| 06/07 | ACXEGDP-302 | Atualizar planilha com dados de vendas de junho |
| 06/07 | ACXEGDP-300 | Suporte Gustavo — Importação |
| 06/07 | ACXEGDP-143 | Check-list para o faturamento |
| 06/07 | ACXEGDP-297 | Revisão Planilha Seguro |
| 05/07 | ACXEGDP-296 | Monitor execution_data: idade por retenção real + execuções em espera |
| 03/07 | ACXEGDP-295 | FUP semanal FIDC (Flow/Modde) |
| 02/07 | ACXEGDP-294 | Padronização de e-mails dos 26 workflows ativos do n8n |
| 02/07 | ACXEGDP-293 | Retry-chain OMIE reenvia objeto de erro em vez do payload |
| 02/07 | ACXEGDP-292 | Lembrete HITL PV à Vista com URL de decisão errada |
| 02/07 | ACXEGDP-291 | HITL Aprovação PV à Vista: pedido já faturado antes da decisão |
| 02/07 | ACXEGDP-222 | Análise: limites Modde zerados em massa (98,6% dos clientes) |
| 01/07 | ACXEGDP-188 | [CRM] Correções Batch 1 — Agenda (Finding 9) |
| 01/07 | ACXEGDP-187 | [CRM] Correções Batch 1 — Carteira (Finding 8) |
| 01/07 | ACXEGDP-185 | [CRM] Correções Batch 1 — Metas (Findings 1-4) |

## Anexo B — 43 achados da Auditoria Completa (ACXEGDP-238) concluídos nesta janela

| Frente | Achados | Chaves | Data |
|--------|--------:|--------|------|
| Segurança | 8 | ACXEGDP-239, 240, 241, 242, 243, 244, 245, 248 | 14/07 |
| Módulos financeiros (Hedge/Forecast/BP/API) | 7 | ACXEGDP-269, 270, 271, 272, 273, 274, 298 | 14/07 |
| StockBridge | 12 | ACXEGDP-267, 268, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290 | 14/07 |
| pt-BR | 5 | ACXEGDP-256, 257, 258, 259, 260 | 14/07 |
| E-mails | 4 | ACXEGDP-249, 250, 251, 253 | 14/07 |
| UI/UX | 6 | ACXEGDP-261, 262, 263, 264, 265, 266 | 14/07 |
| Diversos (teste OMIE mock) | 1 | ACXEGDP-301 | 14/07 |

\* Mais 12 achados (SEG-08/09, MOD-04 a MOD-16, EML-03/04/05/12/19/11/15-21/22, STK-01b) foram formalmente fechados em **15/07**, um dia após o corte — não contam no total de 71 concluídas desta janela.

---

*Gerado em 2026-07-15 a partir do Jira (`livemind.atlassian.net`).*
