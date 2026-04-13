# Gap Analysis: Forecast Planner — Legado JSX vs Atlas

**Data**: 2026-04-13
**Ultima atualizacao**: 2026-04-13
**Escopo**: Comparacao do legado `forecast-planner.jsx` (2955 linhas) com o modulo Atlas `modules/forecast/`

---

## Resumo Executivo

O motor de forecast Atlas replica a **logica core** (simulacao 120d, ruptura, MOQ, compra local, sazonalidade). **COMPLETO.** Todos os calculos, gaps de UX e features avancadas foram implementados. 53 testes unitarios passando.

| Categoria | Total | Resolvido |
|-----------|-------|-----------|
| Calculos (CALC) | 3 | 3 |
| Gaps funcionalidade (GAP-F) | 6 | 6 |
| Testes unitarios | 5 | 5 |

---

## GAPS DE FUNCIONALIDADE

### ~~GAP-F1: Aba "Analise de Demanda" ausente~~ — RESOLVIDO

O legado tem uma aba completa (linhas 1096-1380) com:
- 3 meses fechados de vendas por familia (colunas: Mes1, Mes2, Mes3)
- Trimestre atual vs anterior com variacao YoY%
- Projecao de estoque futuro em 6 meses (saldo no dia 1 de cada mes)
- Sparkline de tendencia (24 meses historico + 6 meses projecao)
- Expansao por SKU com contribuicao % individual
- Cobertura em dias por SKU

**Atlas**: Nao tem esta aba. O ForecastDashboard mostra cobertura e vendas12m mas nao mostra historico mensal nem tendencia YoY.

**Impacto**: Comprador perde visao de tendencia de demanda — nao sabe se a demanda esta subindo ou caindo.

**Resolucao**: DemandAnalysisPage.tsx com vendas mensais 24m, YoY trimestral (seta colorida), sparkline recharts, expansao por SKU com contribuicao % e cobertura. Endpoint `GET /api/v1/forecast/demanda` via `demanda.service.ts`. 11 testes unitarios.

---

### ~~GAP-F2: Aba "Business Insights" ausente~~ — RESOLVIDO

O legado tem uma aba (linhas 2361-2807) com:
- **Tabela de LT por fornecedor**: Fornecedor, Pais, Familias, LT sugerido, override input, LT efetivo
- **Janela de compra otima**: Para cada familia, cruzamento do forecast com score COMEX mensal para achar o melhor mes de compra (custo+frete+volume historico)
- **Tabela de oportunidade**: 4 meses (agora, +1, +2, +3) comparando score, preco/kg, custo total, e indicador de economia
- **Score COMEX mensal**: Barra 0-100 por mes com classificacao (COMPRAR/BOM/NEUTRO/CAUTELA/EVITAR)
- **Dados de importacao**: Volume, FOB, frete, seguro, preco medio por mes (12 meses historico)

**Atlas**: Nao tem esta aba. Nao tem dados de COMEX score, fornecedores, nem janela de compra otima.

**Impacto**: Comprador perde inteligencia de timing de compra — nao sabe qual e o melhor mes pra comprar considerando frete/preco historico.

**Resolucao**: BusinessInsightsPage.tsx com tabela de fornecedores (nome, pais, familias, LT efetivo), score COMEX mensal (0-100, barras coloridas, 5 classificacoes), historico de importacao 12m (ComposedChart volume+preco). Endpoint `GET /api/v1/forecast/insights` via `insights.service.ts`. Dados da FUP Comex (227 importacoes, 22 fornecedores). 10 testes unitarios.

---

### ~~GAP-F3: Ajuste de demanda por SKU (botao +/- %)~~ — RESOLVIDO

O legado permite ajustar demanda individual por SKU com botoes +5%/-5% (linhas 646-658). O ajuste:
- Afeta a demanda diaria do SKU na simulacao
- Afeta a qtd proporcional sugerida por SKU
- E visual — nao persiste (state React)

**Resolucao**: Implementado em RollingForecastPage.tsx:
- State `ajustes: Record<string, number>` com funcao `adjustSku(codigo, delta)` em passos de +/-5%
- Botoes `-5` / `+5` por SKU na tabela, com indicador visual (highlight amarelo, valor colorido)
- Botao "Limpar ajustes" quando ha ajustes ativos
- `queryKey` inclui `ajustes` para re-fetch automatico ao mudar
- Envia `ajustes_demanda` no body do POST `/calcular`
- Backend aplica via `vendas12m += base * (1 + ajuste / 100)` por SKU (forecast.service.ts:109)

---

### ~~GAP-F4: Analise Claude AI na Shopping List~~ — RESOLVIDO

O legado tem integracao com API Anthropic (linhas 2005-2073):
- Botao "Analisar com Claude" na shopping list
- Envia contexto completo (familias, qtds, scores, LTs, rupturas)
- Recebe: resumo executivo, prioridades, alertas, recomendacao por item (COMPRAR AGORA/AGUARDAR/REVISAR/OK)
- Exibe painel de avaliacao com justificativas por item

**Atlas**: Nao tem integracao IA na shopping list.

**Impacto**: Feature diferenciadora de UX. Nao bloqueia uso, mas e um "nice-to-have" forte.

**Resolucao**: Botao "Analisar com IA" na ShoppingListPage com painel de resultados (resumo executivo, alertas, recomendacoes por item com badge COMPRAR AGORA/AGUARDAR/REVISAR/OK + justificativa). Endpoint `POST /api/v1/forecast/shopping-list/analyze` via `ai-analysis.service.ts` que chama n8n webhook (env `N8N_FORECAST_ANALYZE_URL`). Fallback gracioso se LLM indisponivel. Timeout 30s.

---

### ~~GAP-F5: Secao "Definicoes/Metodologia" recolhivel~~ — RESOLVIDO

O legado tem em cada aba um bloco recolhivel (linhas 472-540) com definicoes de termos.

**Resolucao**: Componente `DefinitionsPanel` adicionado ao ForecastDashboard.tsx. Painel recolhivel com definicoes de:
- Pool de Estoque (3 camadas: disponivel, bloqueado, transito)
- Cobertura (dias)
- Sazonalidade (fator mensal)
- Qtd Sugerida (net-of-pipeline, MOQ)
- Compra Local Emergencial
- Status (critico/atencao/ok)

---

### ~~GAP-F6: Painel de urgentes separado em 3 categorias~~ — RESOLVIDO

O legado divide o painel de urgentes (linhas 712-971) em 3 secoes distintas:
1. **Internacional** — familias com pedido nos proximos 15d
2. **Local emergencial** — familias com prazo perdido (tabela separada roxa)
3. **Nacional** — familias sem pipeline internacional mas com ruptura (tabela separada azul)

**Resolucao**: Implementado no commit `a631cac`. O ForecastDashboard.tsx agora:
- Separa `urgentes` em 3 arrays via `useMemo`: `intl`, `local`, `nacional` (linhas 59-69)
- Renderiza 3 `<UrgentSection>` com cores distintas: vermelho (intl), roxo (local), ciano (nacional) (linhas 196-220)
- Cada secao tem titulo, subtitulo, e tabela com colunas contextuais (Ruptura vs Cobertura, Gap vs Qtd Sugerida)
- KPI cards atualizados: "Compra Intl." e "Compra Local" como cards separados (linhas 110-111)

---

## DIFERENCAS DE CALCULO

### ~~CALC-1: Preco da sugestao usa CMC em vez de preco real~~ — RESOLVIDO (parcial)

| Item | Legado | Atlas (antes) | Atlas (agora) |
|------|--------|---------------|---------------|
| Preco/kg para valor estimado | `totalBRLPedidos / totalKgPedidos` | `cmc_medio` fixo | `totalBrlPedidos / totalKgPedidos`, fallback CMC |

**Resolucao**: A logica foi corrigida em forecast.service.ts (linhas 220-223):
```typescript
const precoPorKg = totalKgPedidos > 0 ? totalBrlPedidos / totalKgPedidos : familia.cmc_medio;
const valorBrl = Math.round(qtdSugerida * precoPorKg);
```

**Nota**: A query de `pedidos.service.ts` extrai `pc.nvaltot` como `valor_brl`. O `getChegadasPorProduto()` agora propaga `valor_brl` para o forecast engine, que usa o preco real dos pedidos em rota para calcular `precoPorKg`. Fallback para `familia.cmc_medio` quando nao ha pedidos.

---

### ~~CALC-2: qtdBruta so calcula se diaRuptura >= 0~~ — RESOLVIDO

O legado (linhas 239-242) so calcula necessidade bruta se houver ruptura.

**Resolucao**: Corrigido em forecast.service.ts (linhas 206-215). Comentario inline: `// CALC-2 fix: legado so calcula se diaRuptura >= 0`.
```typescript
if (diaRuptura >= 0) {
  for (let d = 0; d < familia.lt_efetivo + config.horizonte_cobertura; d++) { ... }
}
```
Familias sem ruptura agora tem `qtdSugerida = 0` corretamente.

---

### ~~CALC-3: vendaDiaria30d nao calculada~~ — RESOLVIDO

O legado calcula a media da demanda diaria sazonalizada dos proximos 30 dias.

**Resolucao**: Implementado em forecast.service.ts (linhas 196-203):
```typescript
let soma30d = 0;
for (let d = 0; d < 30; d++) {
  const sazD = sazFactors.get(mesD) ?? 1.0;
  soma30d += vendaDiariaMedia * (1 + config.variacao_anual_pct / 100) * sazD;
}
const vendaDiaria30d = soma30d / 30;
```
Usada na compra local (linha 235): `Math.max(vendaGap, Math.round(vendaDiaria30d * config.lead_time_local))`.

---

## DIFERENCAS MENORES (nao bloqueiam)

| Item | Legado | Atlas | Impacto |
|------|--------|-------|---------|
| Nacional vs Internacional | Detecta por `PEDIDOS_COMPRA.length === 0` | Detecta por `is_internacional` (marca cadastral) | Atlas e mais correto — usa dado cadastral |
| Chart rolling 120d | SVG custom renderizado manualmente | recharts AreaChart | Atlas e melhor (responsivo, tooltip nativo) |
| Qtd proporcional por SKU | `arredMOQ(qtdSugerida * sku.share, moqAtivo)` | Nao calcula proporcao por SKU | Menor — so UI detail |
| Flags de urgencia | `precisaComprarEm15d`, `necessitaCompraLocal` como campos | Inferido do `dia_pedido_ideal` | Equivalente |
| ~~Demanda com ajuste %~~ | `vendas12m * (1 + ajuste/100)` por SKU | Backend + frontend (+/-5% por SKU) | Resolvido — ver GAP-F3 |
| ~~valor_brl nos pedidos_em_rota~~ | Extraido da NF do pedido | Propagado de `pc.nvaltot` via chegadasMap | Resolvido — ver CALC-1 |

---

## COMPARACAO COM PLANILHA

A planilha "Planejador de Compras - Rev Latest.xlsm" deve ser usada para validar:

1. **Estoque total por familia** — Atlas le de `tbl_posicaoEstoque_Q2P`, planilha pode ter snapshot diferente. Diferenca aceitavel se dados sao de horarios diferentes.

2. **Cobertura em dias** — Depende de `vendas12m` e sazonalidade. Se a planilha usa indice sazonal diferente, os dias vao divergir. Comparar com tolerancia de +/-5 dias.

3. **Qtd sugerida** — Ambos devem respeitar MOQ. Se a planilha usa preco diferente do CMC, o valor estimado vai divergir mas a quantidade nao.

4. **Data de ruptura** — Deve ser muito proxima se os inputs sao os mesmos (estoque, demanda, chegadas). Divergencia > 5 dias indica problema no motor.

**Pendencia**: Nao consigo ler o conteudo da planilha .xlsm programaticamente. A validacao precisa ser feita manualmente abrindo ambos lado a lado.

---

## PLANO DE PRIORIZACAO (atualizado)

### Prioridade 1 — Corrigir calculos (afetam numeros) — CONCLUIDO

| # | Item | Status |
|---|------|--------|
| 1 | ~~CALC-2: qtdBruta so se diaRuptura >= 0~~ | RESOLVIDO |
| 2 | ~~CALC-1: Preco real dos pedidos em rota~~ | RESOLVIDO (logica ok, falta popular valor_brl em pedidos.service.ts) |
| 3 | ~~CALC-3: vendaDiaria30d media dos proximos 30d~~ | RESOLVIDO |

### Prioridade 2 — Funcionalidades de UX (melhoram experiencia) — CONCLUIDO

| # | Item | Status |
|---|------|--------|
| 4 | ~~GAP-F6: Separar urgentes em 3 categorias~~ | RESOLVIDO |
| 5 | ~~GAP-F3: Ajuste demanda por SKU (+/- %)~~ | RESOLVIDO (backend + frontend) |
| 6 | ~~GAP-F5: Secao de definicoes recolhivel~~ | RESOLVIDO |

### Prioridade 3 — Features avancadas (pendentes)

| # | Item | Status | Esforco |
|---|------|--------|---------|
| 7 | GAP-F1: Aba Analise de Demanda (historico mensal + YoY + sparkline) | PENDENTE | 4h |
| 8 | GAP-F2: Aba Business Insights (fornecedores + score COMEX + janela de compra) | PENDENTE | 6h |
| 9 | GAP-F4: Integracao Claude AI na Shopping List via n8n | PENDENTE | 3h |

### Testes unitarios — CONCLUIDO

| # | Arquivo | Testes |
|---|---------|--------|
| 10 | familia.test.ts | 9 testes — agrupamento, CMC ponderado, intl detection, LT efetivo |
| 11 | forecast.test.ts | 18 testes — ruptura, MOQ, CALC-2, compra local, sazonalidade, ajuste demanda |
| 12 | sazonalidade.test.ts | 5 testes — fallback _DEFAULT, override, fator_usuario precedencia |
