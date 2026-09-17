# Resumo Executivo — Atividades de 01–14/09/2026

**Responsável:** Flavio Cicato Endo
**Área:** TI / Sistemas (Jira `ACXEGDP`)
**Período:** 01–14/09/2026
**Fonte:** Jira LiveMind — projeto *ACXE - Gestão dos projetos e dos Sistemas* + apontamento de horas (Tempo)

---

## Números do período

| Indicador | Valor |
|-----------|------:|
| Tarefas **concluídas** | **14** |
| Tarefas **abertas** no período | **24** (14 já concluídas dentro da própria janela, 10 em andamento/backlog) |
| Itens movimentados no total | 24 |

> Quinzena dominada por uma resposta rápida à **Reforma Tributária** (mudanças no CST do ICMS, código de benefício fiscal, bloco IBS/CBS) que já bateu no ajuste automático de PV via OMIE, encadeada com uma leva de bugs na **venda triangular** (CFOP, bypass indevido da análise de crédito, texto fiscal obrigatório) — praticamente tudo resolvido numa única sessão intensa em 01/09. Em paralelo, a migração completa do fluxo "Espelha PC COMEX" de MySQL para Postgres avançou 6 de 8 etapas, incluindo o cutover em produção. Como nas quinzenas anteriores, o **CRM em semi-produção** seguiu sendo a frente que mais consumiu tempo do responsável — e ganhou um desdobramento maior: a **Fase 2 do CRM**, que mira eliminar de vez o acesso dos vendedores ao OMIE.

---

## Principais entregas por frente

> Legenda de status: ✅ concluída · 🔄 em andamento · ⏳ em backlog

### 1. Reforma Tributária e venda triangular — sessão intensa de 01/09
- ✅ **ACXEGDP-354** — Reforma Tributária no ajuste automático de PV (1iPx): CST ICMS 41→50/51 e código de benefício fiscal por tipo de item.
- ✅ **ACXEGDP-356** — Venda triangular: texto fiscal obrigatório validado nas duas pernas do PV.
- ✅ **ACXEGDP-357** — Corrigido bug que reescrevia o CFOP interestadual (6.924) para interno (5.924) na auto-correção triangular.
- ✅ **ACXEGDP-358** — Corrigida classificação triangular que zeraria impostos de venda tributada indevidamente.
- ✅ **ACXEGDP-359** — Corrigido bug em que a baixa de estoque decidia só pelo primeiro item e ignorava a flag dos demais (3 fluxos ativos).
- ✅ **ACXEGDP-360** — Otimizada chamada redundante no fluxo de exportação de fornecedores/clientes, com retry-chain.
- ✅ **ACXEGDP-364** — O bypass triangular da análise de crédito agora exige o CFOP correto (5.924/6.924), não mais só uma flag isolada — fecha um risco de zerar impostos indevidamente.
- ⏳ **ACXEGDP-355** — Bloco IBS/CBS (imposto.reforma_tributaria) no PV OMIE ainda em definição — a reforma tributária segue com etapas pendentes.
- ⏳ **ACXEGDP-362 / 363 / 365 / 367** — Pendências do mesmo mergulho: replicar o "porteiro" (claim atômico) em mais 2 fluxos, um PV com sucata pulando a análise de crédito, a checagem da perna par do triangular antes do bypass (aguardando o CRM), e validar com o fiscal um CST/alíquota que sai errado do OMIE.

### 2. Anexo C / cobertura de NCM — ainda em andamento
- 🔄 **ACXEGDP-366** — Cadastro ACXE sem cobertura para 34 NCM, com a família PVC inteira ausente do Anexo C de produtos resultantes — foi o maior item de tempo da quinzena depois do CRM e da verificação diária, e segue em andamento.

### 3. Espelha PC COMEX — migração MySQL→Postgres (Rev 4.0)
- ✅ **ACXEGDP-369 a 372, 374, 376** — DDL e carga dos 164 registros do MySQL, conversão dos 8 nós MySQL→Postgres, resiliência com retry-chain no lugar do retry nativo, configuração centralizada, cutover em produção e gate de pedido internacional (absorve o antigo ACXEGDP-117) — 6 das 8 etapas da revisão já concluídas.
- ⏳ **ACXEGDP-373 / 375** — Faltam os testes completos em UAT e o desligamento da dupla escrita no MySQL legado pós-cutover.
- ⏳ **ACXEGDP-368** — Card-mãe da revisão segue aberto até essas duas etapas fecharem.

### 4. CRM (OrbitIA) — semi-produção segue como maior consumo de tempo + nova Fase 2
- ⏳ **ACXEGDP-325** — Semi-produção continua sendo, de longe, a frente que mais consumiu tempo do responsável na quinzena — superou até o volume da quinzena anterior.
- ⏳ **ACXEGDP-377** — Nova iniciativa aberta em 14/09: **Fase 2 do CRM**, com o objetivo de tornar o CRM autossuficiente e eliminar a necessidade de acesso ao OMIE na operação de vendas — próximo grande capítulo do projeto.

### 5. Operação e suporte
- 🔄 **ACXEGDP-333** — Verificação diária do sistema seguiu consumindo boa parte dos dias úteis, como de costume.
- ✅ **ACXEGDP-361** — Recriada a Data Table "Integração Bancos Crédito" que havia sido apagada, parando o fluxo do banco Flow/Modde.
- Itens pontuais de suporte e retomadas de backlog antigo (posição fiscal do cockpit, suporte ao Planejador) também tiveram pequenas doses de tempo na quinzena, sem gerar novidade relevante além do já reportado.

---

## Em aberto para o restante de setembro

- Reforma tributária: bloco IBS/CBS ainda em definição (-355); validar com o fiscal o CST/alíquota do CFOP 5.924 (-367)
- Triangular: replicar o "porteiro" em mais 2 fluxos (-362); PV com sucata pulando a análise de crédito (-363); checagem da perna par, aguardando o CRM (-365)
- Anexo C: cobertura de NCM / família PVC ainda em andamento (-366)
- Espelha PC COMEX: testes em UAT e desligamento da dupla escrita MySQL (-373/375/368)
- CRM Fase 2: eliminar o acesso ao OMIE na operação de vendas — kickoff (-377)
- CRM semi-produção segue como a frente que mais consome tempo do responsável (-325)

---

## Anexo — 14 tarefas concluídas entre 01–14/09

| Data | Chave | Tarefa |
|------|-------|--------|
| 11/09 | ACXEGDP-364 | Bypass triangular da análise de crédito passa a exigir CFOP 5.924/6.924 |
| 10/09 | ACXEGDP-376 | Gate de pedido internacional pelo país do fornecedor (absorve ACXEGDP-117) |
| 10/09 | ACXEGDP-374 | Cut-over PROD, sticky notes, spec e PR da Rev 4.0 |
| 10/09 | ACXEGDP-372 | Config centralizada, typeVersion atualizado e expressões .item nos loops |
| 10/09 | ACXEGDP-371 | Resiliência: retry-chain OMIE no lugar do retry nativo |
| 10/09 | ACXEGDP-370 | Conversão dos 8 nós MySQL para Postgres |
| 10/09 | ACXEGDP-369 | DDL Postgres da tabela de controle COMEX + carga dos 164 registros do MySQL |
| 03/09 | ACXEGDP-361 | Recriar Data Table "Integração Bancos Crédito" |
| 01/09 | ACXEGDP-360 | Exporta Lista Fornecedores/Clientes: chamada redundante + retry-chain |
| 01/09 | ACXEGDP-359 | BUG: baixa de estoque decidia por det[0] e ignorava os demais itens |
| 01/09 | ACXEGDP-358 | Classificação triangular que zeraria impostos indevidamente |
| 01/09 | ACXEGDP-357 | BUG: auto-correção triangular reescrevia CFOP interestadual para interno |
| 01/09 | ACXEGDP-356 | Venda triangular: texto fiscal obrigatório nas duas pernas do PV |
| 01/09 | ACXEGDP-354 | Reforma Tributária: CST ICMS 41→50/51 e código de benefício fiscal |

---

*Gerado em 2026-09-17 a partir do Jira (`livemind.atlassian.net`) e do apontamento de horas (Tempo).*
