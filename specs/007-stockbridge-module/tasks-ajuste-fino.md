# StockBridge — Ajuste Fino (pós-implementação)

Tarefas de melhoria identificadas após a implementação inicial do módulo.
Módulo funcionalmente completo, em validação paralela com o legado PHP.

---

## Área 1: Cockpit (`/stockbridge/cockpit`)

### Diretriz de produto — Cockpit executivo operacional

O Cockpit deve ser a tela única de leitura executiva do estoque físico:
mostrar disponibilidade, fluxo em trânsito, risco de ruptura/excesso e
pendências operacionais. Ele **não** deve assumir responsabilidade financeira,
contábil ou de valuation.

Pergunta que a tela precisa responder em até 30 segundos:

- Temos risco de ruptura onde?
- Temos excesso onde?
- O material está preso em qual estágio?
- Existe aprovação ou divergência parada?
- Qual família/galpão/CNPJ merece atenção agora?

Escopo explícito:

- **Inclui**: kg disponível, kg em trânsito, porto/DTA, provisório, cobertura em
  dias, lead time, criticidade, divergências, aprovações e filtros operacionais.
- **Não inclui**: exposição em BRL/USD, custo médio ponderado, PTAX, valuation
  de estoque ou qualquer métrica financeira. Esses temas ficam em Métricas,
  dashboard diretoria ou integrações futuras com Hedge/C-Level.

### A1.1 — Card "Divergências": remover interatividade
**Situação**: O card "Divergências" no resumo tem `onClick` que abre `ModalDivergencias.tsx`,
um placeholder vazio que só diz "será implementado em US3".
**Ação**: Remover o `onClick` do card — deixá-lo como contador simples (não clicável).
Deletar `apps/web/src/pages/stockbridge/gestor/ModalDivergencias.tsx`.
**Arquivos**:
- `apps/web/src/pages/stockbridge/gestor/CockpitPage.tsx`
- `apps/web/src/pages/stockbridge/gestor/ModalDivergencias.tsx` ← deletar

---

### A1.2 — Cards de SKU: adicionar célula Porto/DTA
**Situação**: Cada card de SKU tem uma grade 2×2 (Físico / Fiscal / Trânsito intl / Trânsito int.).
Porto/DTA aparece nos cards de resumo do topo mas está **ausente** na grade individual de cada SKU.
**Ação**: Adicionar célula "Porto / DTA" na grade dos cards de SKU.
**Arquivo**: `apps/web/src/pages/stockbridge/gestor/CockpitPage.tsx`

---

### A1.3 — Cards de SKU: adicionar célula Provisório
**Situação**: O volume provisório aparece só como badge inline (`+X kg prov`) quando > 0.
Não tem posição fixa na grade — some quando é zero, tornando a leitura inconsistente.
**Ação**: Adicionar célula "Provisório" na grade dos cards de SKU (com valor 0 kg quando vazio).
**Arquivo**: `apps/web/src/pages/stockbridge/gestor/CockpitPage.tsx`

---

### A1.4 — Posição Fiscal: implementar com fontes corretas por fluxo
**Situação atual**: `fiscalKg = fisicaKg` hardcoded no service — os dois sempre exibem
o mesmo número. Isso foi assumido incorretamente como "arquitetura híbrida".

**Realidade do negócio**: NF emitida no OMIE antes do recebimento físico no Atlas
(tanto importação quanto compra nacional). Durante esse gap, **fiscal > físico**.

**Dados disponíveis no banco** (sync prod → dev concluído):
- `public.tbl_nf_header_ACXE`, `tbl_nf_header_Q2P`, `tbl_nf_header_Q2P_Filial`
- `public.tbl_nf_itens_ACXE`, `tbl_nf_itens_Q2P`, `tbl_nf_itens_Q2P_Filial`
- Campo-chave: `n_id_receb` (0 = não recebida fisicamente; >0 = recebida)

**Achado durante investigação**: `n_id_receb` só é populado para **compras nacionais**
(CFOPs 1.xxx e 2.xxx). Para **importações** (CFOPs 3.xxx, ~93% das entradas ACXE),
`n_id_receb` permanece 0 — esse mecanismo OMIE não cobre importação.

**Estratégia final de detecção do gap fiscal/físico**:

| Fluxo | Critério | Fonte |
|---|---|---|
| Compras nacionais | NF de entrada com `n_id_receb = 0` | `tbl_nf_header_*` + `tbl_nf_itens_*` filtrando `tp_nf=0` e CFOP iniciado por 1 ou 2 |
| Importações ACXE | NF de entrada cujo `n_nf` não tem correspondente em `stockbridge.movimentacao` com `subtipo='importacao'` e `ativo=true` | `tbl_nf_header_ACXE` + `tbl_nf_itens_ACXE` filtrando CFOP iniciado por 3 |
| Saídas | Não precisa rastrear gap | n/a — saída é instantânea no OMIE |

**Composição da posição fiscal por SKU**:
- `fisicaKg` (já existe) = saldo OMIE consolidado
- `fiscalPendenteNacionalKg` = soma de `q_com` em itens de NFs nacionais com `n_id_receb=0`
- `fiscalPendenteImportacaoKg` = soma de `q_com` em itens de NFs de importação não-reconciliadas com `movimentacao`
- `fiscalKg` (total) = `fisicaKg` + pendentes acima

**Ação de implementação**:
1. Estender a query do `cockpit.service.ts` com CTEs para os dois tipos de pendência fiscal.
2. Adicionar campos `fiscalPendenteNacionalKg` e `fiscalPendenteImportacaoKg` em `CockpitSku`.
3. Reformular o card "Posição Fiscal" no resumo + grade de SKU para mostrar o pendente
   separadamente do consolidado (ou combinado, conforme decisão de UX).

**Arquivos impactados**:
- `modules/stockbridge/src/services/cockpit.service.ts` (CTEs novos + tipos)
- `apps/web/src/pages/stockbridge/gestor/CockpitPage.tsx` (UI Fiscal)

---

### A1.5 — Escopo: não exibir BRL/USD no Cockpit
**Situação**: O campo `custo_brl_kg` existe no lote e a view OMIE retorna `valor_unitario`,
mas o Cockpit não exibe valores financeiros.
**Decisão**: Manter o Cockpit sem BRL/USD, custo médio, PTAX ou exposição cambial.
**Racional**: O Cockpit é uma tela de comando operacional. Colocar BRL/USD muda a
natureza da tela, exige precisão contábil e aproxima o módulo de uma função que
não é sua pretensão.
**Destino sugerido para financeiro**:
- Página `/stockbridge/metricas`
- Dashboard diretoria
- Integração futura com Hedge/C-Level
**Ação**: Remover A1.5 como item de implementação do Cockpit. Registrar esta
decisão para evitar reabertura ambígua no ajuste fino.

---

### A1.6 — Resumo executivo: reorganizar cards por saúde operacional
**Situação**: O resumo atual lista números corretos, mas ainda como métricas
soltas. Falta uma leitura executiva de saúde do estoque.
**Ação**: Reorganizar os cards do topo para responder "onde está o risco?".
**Cards sugeridos**:
- `Estoque disponível` — kg físico pronto.
- `Em trânsito` — soma de trânsito internacional + porto/DTA + trânsito interno.
- `Porto / DTA` — destacado como gargalo operacional.
- `Provisório` — recebido mas ainda não consolidado totalmente.
- `Ruptura` — quantidade de SKUs críticos.
- `Atenção` — quantidade de SKUs em alerta.
- `Excesso` — quantidade de SKUs classificados como excesso.
- `Pendências` — divergências abertas + aprovações pendentes.
**Observação**: manter os detalhes atuais disponíveis na tabela/esteira, mas usar
o topo para leitura rápida.
**Arquivo**: `apps/web/src/pages/stockbridge/gestor/CockpitPage.tsx`

---

### A1.7 — Esteira operacional de estoque
**Situação**: Os estágios aparecem como cards separados, dificultando a leitura do
fluxo físico do material.
**Ação**: Criar uma faixa visual de estágios:
`Disponível → Trânsito internacional → Porto/DTA → Trânsito interno → Provisório`.
**Objetivo**: Mostrar rapidamente onde o volume está concentrado e onde pode estar
preso.
**Dados necessários**: já existem no payload atual (`totalFisicoKg`,
`transitoIntlKg`, `portoDtaKg`, `transitoInternoKg`, `provisorioKg`).
**Arquivo**: `apps/web/src/pages/stockbridge/gestor/CockpitPage.tsx`

---

### A1.8 — Visão principal por SKU: tabela executiva densa
**Situação**: A visão atual usa cards por SKU. É visualmente simples, mas ruim para
comparar muitos produtos, ordenar riscos e escanear famílias.
**Ação**: Trocar a visão principal para uma tabela executiva densa.
**Colunas sugeridas**:
- Produto
- Família
- Físico kg
- Trânsito intl
- Porto/DTA
- Trânsito interno
- Provisório
- Consumo diário
- Cobertura dias
- Lead time
- Status
- Pendências
**Ordenação padrão**:
1. `critico`
2. `alerta`
3. `excesso`
4. `ok`
5. menor cobertura em dias
**Opcional**: manter cards como alternância futura de visualização, mas a tabela
deve ser a leitura principal do Cockpit.
**Arquivos**:
- `apps/web/src/pages/stockbridge/gestor/CockpitPage.tsx`
- `modules/stockbridge/src/services/cockpit.service.ts` (apenas se for necessário
  acrescentar campos derivados)

---

### A1.9 — Bloco "Top riscos"
**Situação**: O usuário precisa procurar manualmente os problemas dentro da lista.
**Ação**: Adicionar um bloco curto antes da tabela com rankings executivos.
**Rankings sugeridos**:
- `Top 5 risco de ruptura`
- `Top 5 maior excesso`
- `Top 5 presos em Porto/DTA`
- `Top 5 com pendências`
**Objetivo**: Fazer a tela entregar o problema, não apenas listar dados.
**Arquivo**: `apps/web/src/pages/stockbridge/gestor/CockpitPage.tsx`

---

### A1.10 — Filtros executivos
**Situação**: A tela já filtra por CNPJ, galpão e criticidade. O backend já aceita
`familia`, mas a UI ainda não expõe esse filtro.
**Ação**: Ampliar filtros para gestão diária.
**Filtros sugeridos**:
- Família (`PP`, `PE`, `PS` etc.)
- CNPJ (`ACXE`, `Q2P`, `Ambos`)
- Galpão/localidade
- Status (`Crítico`, `Alerta`, `OK`, `Excesso`)
- Pendência (`com divergência`, `com aprovação`, `com provisório`)
- Estágio (`com trânsito intl`, `com Porto/DTA`, `com trânsito interno`)
**Observação**: Começar por família + pendência já entrega bastante valor.
**Arquivos**:
- `apps/web/src/pages/stockbridge/gestor/CockpitPage.tsx`
- `modules/stockbridge/src/routes/cockpit.routes.ts` (se novos query params forem
  filtrados no backend)
- `modules/stockbridge/src/services/cockpit.service.ts`

---

### A1.11 — Linguagem executiva dos status
**Situação**: Os status existem, mas a tela ainda não explica bem a leitura para
gestão.
**Ação**: Padronizar labels e microcopy.
**Labels**:
- `Crítico` — risco real de ruptura.
- `Alerta` — abaixo do alvo.
- `OK` — dentro da faixa.
- `Excesso` — acima do alvo.
**Microcopy sugerida**: "Cobertura calculada por consumo médio diário vs lead time."
**Arquivo**: `apps/web/src/pages/stockbridge/gestor/CockpitPage.tsx`

---

## Área 2: Nova página de Divergências

Decisão tomada: divergências ganham uma página dedicada no menu lateral,
acessível por gestor e diretor. O cockpit fica com contador simples.

### A2.1 — Backend: endpoint de listagem de divergências
**Endpoint**: `GET /api/v1/stockbridge/divergencias`
**Auth**: `requireGestor`
**Query params**: `?status=aberta|regularizada|descartada` (default: `aberta`), `?tipo=faltando|varredura|cruzada|fiscal_pendente`, `?produto_codigo_acxe=<n>`
**Dados retornados** (JOIN divergencia + lote + movimentacao + produto):
- id, tipo, status, quantidade_delta_kg, valor_usd
- produto: nome, família, código ACXE
- lote: cnpj, localidade
- movimentacao: nota_fiscal, tipo_saida, created_at
- observacoes, created_at, regularizada_em
**Arquivos a criar**:
- `modules/stockbridge/src/services/divergencia.service.ts`
- `modules/stockbridge/src/routes/divergencia.routes.ts`
- Registrar em `modules/stockbridge/src/routes/stockbridge.routes.ts`

---

### A2.2 — Frontend: página DivergenciasPage
**Rota**: `/stockbridge/divergencias`
**Roles**: gestor, diretor
**Conteúdo**:
- Filtros: status (aberta/regularizada/descartada), tipo (faltando/varredura/cruzada/fiscal_pendente)
- Tabela/lista com: produto, tipo de divergência, quantidade delta (kg), empresa/CNPJ, NF de origem, data, status
- Badge de cor por tipo (vermelho=faltando, amarelo=varredura, azul=cruzada, cinza=fiscal_pendente)
- Ação rápida de descarte para divergências abertas (opcional — avaliar na hora da impl.)
**Arquivo a criar**: `apps/web/src/pages/stockbridge/gestor/DivergenciasPage.tsx`

---

### A2.3 — Menu lateral + rota
**Ação**:
- Adicionar item `sb-divergencias` em `STOCKBRIDGE_SUB_ITEMS` no `App.tsx`
  - label: "Divergências", path: `/stockbridge/divergencias`, roles: `['gestor', 'diretor']`
  - ícone sugerido: `AlertTriangle` (lucide-react)
  - badge dinâmico: contagem de divergências abertas (reusar padrão dos outros itens com badge)
- Adicionar `<Route path="divergencias" element={<DivergenciasPage />} />` no router
**Arquivo**: `apps/web/src/App.tsx`

---

## Área 3: Pendências herdadas do tasks.md original

Tarefas ainda abertas do backlog original que ainda precisam acontecer antes do go-live:

| ID | Descrição | Fase |
|---|---|---|
| T113 | Script `migrate-from-mysql.ts` com dry-run e mapeamento completo | Phase 12 |
| T114 | Adicionar script `migrate-from-mysql` no package.json do módulo | Phase 12 |
| T115 | Testar migração em staging com dump de produção | Phase 12 |
| T118 | Executar validação paralela em staging (2 semanas) | Phase 13 |
| T119 | Relatório diário de divergências durante validação paralela | Phase 13 |
| T120 | Decisão explícita de cutover registrada em ADR | Phase 13 |
| T121 | Dashboard Grafana `stockbridge-operacional` | Phase 14 |
| T122 | Dashboard Grafana `stockbridge-gestao` | Phase 14 |
| T123 | Dashboard Grafana `stockbridge-diretoria` | Phase 14 |
| T124 | Alertas Grafana (OMIE >10s, recebimento falho, divergência >7 dias) | Phase 14 |
| T125 | Feature flag no `useFeatureFlags.ts` para ocultar menu quando desabilitado | Phase 14 |
| T129 | Performance smoke: SC-001 (<2min recebimento), SC-002 (<3s cockpit) | Phase 14 |
| T130 | Checklist completo do `quickstart.md` em staging antes do cutover | Phase 14 |

---

## Ordem de execução sugerida

1. **A1.1** — remover modal (5 min, zero risco)
2. **A1.4 + A1.5** — remover "Posição Fiscal" do topo e registrar que BRL/USD
   fica fora do Cockpit
3. **A1.2 + A1.3** — grade dos cards de SKU enquanto a tabela não entra
4. **A1.6 + A1.7** — reorganizar resumo e criar esteira operacional
5. **A1.8** — trocar visão principal para tabela executiva densa
6. **A1.9** — adicionar "Top riscos"
7. **A1.10 + A1.11** — filtros executivos e linguagem dos status
8. **A2.1** — endpoint divergências (backend)
9. **A2.2 + A2.3** — página + menu (frontend, após backend)
10. Área 3 — seguir cronograma de go-live
