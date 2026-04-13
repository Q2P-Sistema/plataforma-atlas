# Gap Analysis: Forecast Planner — Legado JSX vs Atlas

**Data**: 2026-04-13
**Escopo**: Comparacao do legado `forecast-planner.jsx` (2955 linhas) com o modulo Atlas `modules/forecast/`

---

## Resumo Executivo

O motor de forecast Atlas replica corretamente a **logica core** (simulacao 120d, ruptura, MOQ, compra local, sazonalidade). Porem faltam **6 funcionalidades significativas** e ha **3 diferencas de calculo** que afetam a fidelidade dos resultados.

---

## GAPS DE FUNCIONALIDADE

### GAP-F1: Aba "Analise de Demanda" ausente

O legado tem uma aba completa (linhas 1096-1380) com:
- 3 meses fechados de vendas por familia (colunas: Mes1, Mes2, Mes3)
- Trimestre atual vs anterior com variacao YoY%
- Projecao de estoque futuro em 6 meses (saldo no dia 1 de cada mes)
- Sparkline de tendencia (24 meses historico + 6 meses projecao)
- Expansao por SKU com contribuicao % individual
- Cobertura em dias por SKU

**Atlas**: Nao tem esta aba. O ForecastDashboard mostra cobertura e vendas12m mas nao mostra historico mensal nem tendencia YoY.

**Impacto**: Comprador perde visao de tendencia de demanda — nao sabe se a demanda esta subindo ou caindo.

**Correcao**: Criar componente AbaDemanda usando dados de `tbl_movimentacaoEstoqueHistorico_Q2P` agregados por mes.

---

### GAP-F2: Aba "Business Insights" ausente

O legado tem uma aba (linhas 2361-2807) com:
- **Tabela de LT por fornecedor**: Fornecedor, Pais, Familias, LT sugerido, override input, LT efetivo
- **Janela de compra otima**: Para cada familia, cruzamento do forecast com score COMEX mensal para achar o melhor mes de compra (custo+frete+volume historico)
- **Tabela de oportunidade**: 4 meses (agora, +1, +2, +3) comparando score, preco/kg, custo total, e indicador de economia
- **Score COMEX mensal**: Barra 0-100 por mes com classificacao (COMPRAR/BOM/NEUTRO/CAUTELA/EVITAR)
- **Dados de importacao**: Volume, FOB, frete, seguro, preco medio por mes (12 meses historico)

**Atlas**: Nao tem esta aba. Nao tem dados de COMEX score, fornecedores, nem janela de compra otima.

**Impacto**: Comprador perde inteligencia de timing de compra — nao sabe qual e o melhor mes pra comprar considerando frete/preco historico.

**Correcao**: Criar AbaInsights. Dados COMEX podem vir da planilha FUP (ja no repo) ou de tabela no BD. Fornecedores vem de `tbl_cadastroFornecedoresClientes_ACXE`.

---

### GAP-F3: Ajuste de demanda por SKU (botao +/- %)

O legado permite ajustar demanda individual por SKU com botoes +5%/-5% (linhas 646-658). O ajuste:
- Afeta a demanda diaria do SKU na simulacao
- Afeta a qtd proporcional sugerida por SKU
- E visual — nao persiste (state React)

**Atlas**: Nao tem ajuste por SKU. A demanda e fixa baseada no historico.

**Impacto**: Comprador nao pode ajustar para cenarios "e se demanda deste SKU subir 20%?".

**Correcao**: Adicionar state `ajustesDemanda` no frontend e enviar como parametro ao endpoint `/calcular`.

---

### GAP-F4: Analise Claude AI na Shopping List

O legado tem integracao com API Anthropic (linhas 2005-2073):
- Botao "Analisar com Claude" na shopping list
- Envia contexto completo (familias, qtds, scores, LTs, rupturas)
- Recebe: resumo executivo, prioridades, alertas, recomendacao por item (COMPRAR AGORA/AGUARDAR/REVISAR/OK)
- Exibe painel de avaliacao com justificativas por item

**Atlas**: Nao tem integracao IA na shopping list.

**Impacto**: Feature diferenciadora de UX. Nao bloqueia uso, mas e um "nice-to-have" forte.

**Correcao**: Integrar via n8n como gateway LLM (Principio III — nao chamar API diretamente do frontend). Endpoint `POST /api/v1/forecast/shopping-list/analyze` que chama n8n webhook.

---

### GAP-F5: Secao "Definicoes/Metodologia" recolhivel

O legado tem em cada aba um bloco recolhivel (linhas 472-540) com definicoes de termos:
- Pool de estoque 3 camadas
- Sazonalidade
- Qtd Sugerida (net-of-pipeline)
- MOQ
- Compra Local Emergencial

**Atlas**: Nao tem secao de definicoes.

**Impacto**: Baixo — documentacao inline para usuario. Facil de adicionar.

---

### GAP-F6: Painel de urgentes separado em 3 categorias

O legado divide o painel de urgentes (linhas 712-971) em 3 secoes distintas:
1. **Internacional** — familias com pedido nos proximos 15d
2. **Local emergencial** — familias com prazo perdido (tabela separada roxa)
3. **Nacional** — familias sem pipeline internacional mas com ruptura (tabela separada azul)

**Atlas**: O painel de urgentes e uma lista unica filtrada. Nao separa por tipo de compra.

**Impacto**: Medio — a separacao visual ajuda o comprador a priorizar acoes diferentes.

**Correcao**: Dividir o resultado de `/urgentes` em 3 grupos no frontend.

---

## DIFERENCAS DE CALCULO

### CALC-1: Preco da sugestao usa CMC em vez de preco real de ultima compra

| Item | Legado | Atlas |
|------|--------|-------|
| Preco/kg para valor estimado | `totalBRLPedidos / totalKgPedidos` (preco real dos pedidos em rota) | `cmc_medio` (custo medio do estoque) |
| Fallback | CMC ponderado por vendas12m | Sem fallback (so CMC) |

**Legado (linhas 252-257)**:
```
precoPorKgIntl = totalKgPedidos > 0
  ? totalBRLPedidos / totalKgPedidos   // preco real NF
  : media ponderada precoBRL por vendas12m  // fallback CMC
```

**Atlas (forecast.service.ts)**:
```
valorBrl = qtdSugerida * familia.cmc_medio
```

**Impacto**: O valor estimado pode divergir significativamente. O preco da ultima compra real (NF) e mais preciso que o CMC do estoque (que mistura compras antigas).

**Correcao**: No `forecast.service.ts`, buscar valor total e quantidade dos pedidos em rota (`pedidosEmRota`) e calcular preco real. Fallback para CMC se nao houver pedidos.

---

### CALC-2: qtdBruta so calcula se diaRuptura >= 0

O legado (linhas 239-242) so calcula necessidade bruta se houver ruptura:
```
if(diaRuptura >= 0) {
  for(let d=0; d<lt+60; d++) qtdBruta += demandaDia(d);
}
```

**Atlas**: Calcula qtdBruta sempre (independente de ruptura), somando demanda para LT+60 dias.

**Impacto**: No Atlas, familias sem ruptura prevista podem ter `qtdSugerida > 0` (sugestao desnecessaria). No legado, essas familias teriam `qtdSugerida = 0`.

**Correcao**: Adicionar condicao `if (diaRuptura >= 0)` antes do loop de qtdBruta no `forecast.service.ts`.

---

### CALC-3: vendaDiaria30d nao calculada

O legado calcula a media da demanda diaria sazonalizada dos proximos 30 dias (linha 231):
```
vendaDiaria30d = Array.from({length:30}, (_, i) => demandaDia(i)).reduce((a,b) => a+b, 0) / 30
```

Essa metrica e usada para:
- Calculo de `qtdGapBruta` na compra local: `Math.max(vendaGap, vendaDiaria30d * ltLocal)`

**Atlas**: Usa `vendaDiariaSaz` (sazonalidade do mes atual) para a compra local, nao a media dos proximos 30d.

**Impacto**: Se a virada de mes estiver proxima, a sazonalidade do mes atual pode nao representar bem os proximos 30 dias (parte pode ser do mes seguinte com indice diferente).

**Correcao**: Calcular media sazonalizada dos proximos 30 dias em vez de usar fator do mes atual.

---

## DIFERENCAS MENORES (nao bloqueiam)

| Item | Legado | Atlas | Impacto |
|------|--------|-------|---------|
| Nacional vs Internacional | Detecta por `PEDIDOS_COMPRA.length === 0` | Detecta por `marca === 'IMPACXE'` | Atlas e mais correto — usa dado cadastral |
| Chart rolling 120d | SVG custom renderizado manualmente | recharts AreaChart | Atlas e melhor (responsivo, tooltip nativo) |
| Qtd proporcional por SKU | `arredMOQ(qtdSugerida * sku.share, moqAtivo)` | Nao calcula proporcao por SKU | Menor — so UI detail |
| Flags de urgencia | `precisaComprarEm15d`, `necessitaCompraLocal` como campos | Inferido do `dia_pedido_ideal` | Equivalente |
| Demanda com ajuste % | `vendas12m * (1 + ajuste/100)` por SKU | Nao tem ajuste | Ver GAP-F3 |

---

## COMPARACAO COM PLANILHA

A planilha "Planejador de Compras - Rev Latest.xlsm" deve ser usada para validar:

1. **Estoque total por familia** — Atlas le de `tbl_posicaoEstoque_Q2P`, planilha pode ter snapshot diferente. Diferenca aceitavel se dados sao de horarios diferentes.

2. **Cobertura em dias** — Depende de `vendas12m` e sazonalidade. Se a planilha usa indice sazonal diferente, os dias vao divergir. Comparar com tolerancia de +/-5 dias.

3. **Qtd sugerida** — Ambos devem respeitar MOQ. Se a planilha usa preco diferente do CMC, o valor estimado vai divergir mas a quantidade nao.

4. **Data de ruptura** — Deve ser muito proxima se os inputs sao os mesmos (estoque, demanda, chegadas). Divergencia > 5 dias indica problema no motor.

**Pendencia**: Nao consigo ler o conteudo da planilha .xlsm programaticamente. A validacao precisa ser feita manualmente por voce abrindo ambos lado a lado.

---

## PLANO DE PRIORIZACAO

### Prioridade 1 — Corrigir calculos (afetam numeros)

| # | Item | Esforco |
|---|------|---------|
| 1 | CALC-2: qtdBruta so se diaRuptura >= 0 | 10 min |
| 2 | CALC-1: Preco real dos pedidos em rota em vez de CMC | 30 min |
| 3 | CALC-3: vendaDiaria30d media dos proximos 30d | 20 min |

### Prioridade 2 — Funcionalidades de UX (melhoram experiencia)

| # | Item | Esforco |
|---|------|---------|
| 4 | GAP-F6: Separar urgentes em 3 categorias (intl/local/nacional) | 1h |
| 5 | GAP-F3: Ajuste demanda por SKU (+/- %) | 1h |
| 6 | GAP-F5: Secao de definicoes recolhivel | 30 min |

### Prioridade 3 — Features avancadas

| # | Item | Esforco |
|---|------|---------|
| 7 | GAP-F1: Aba Analise de Demanda (historico mensal + YoY + sparkline) | 4h |
| 8 | GAP-F2: Aba Business Insights (fornecedores + score COMEX + janela de compra) | 6h |
| 9 | GAP-F4: Integracao Claude AI na Shopping List via n8n | 3h |
