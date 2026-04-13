# Quickstart: Hedge Gaps Closure

**Feature**: 004-hedge-gaps-closure
**Date**: 2026-04-13

---

## Cenarios de Validacao

### Cenario 1: Exposicao com estoque nao pago

1. Abrir o dashboard de hedge (`/hedge`)
2. Verificar que o KPI "Exposicao USD" inclui o `est_nao_pago_usd` (valor maior que apenas `total_pagar_usd`)
3. Expandir a tabela de buckets e verificar que cada bucket tem a coluna `Est. Nao Pago` com valor proporcional
4. Somar os valores de `est_nao_pago_usd` de todos os buckets — deve ser igual ao valor global do resumo

**Resultado esperado**: Exposicao total = pagar_usd + est_nao_pago_usd. Buckets refletem distribuicao proporcional.

### Cenario 2: Cache hit no dashboard

1. Abrir o dashboard de hedge (primeira vez — cold)
2. Observar o tempo de carregamento (2-5 segundos)
3. Recarregar a pagina (F5) dentro de 5 minutos
4. Observar que carrega em < 500ms
5. Verificar no DevTools que o header `X-Cache: HIT` esta presente

**Resultado esperado**: Segunda carga significativamente mais rapida. Header confirma cache hit.

### Cenario 3: Invalidacao de cache apos criar NDF

1. Abrir o dashboard de hedge (cache preenchido)
2. Ir para NDFs e criar um novo NDF
3. Voltar ao dashboard
4. Verificar que os dados refletem o novo NDF (coverage % mudou)
5. Verificar que `X-Cache: MISS` no header (cache foi invalidado)

**Resultado esperado**: Criar NDF invalida o cache. Dashboard mostra dados atualizados.

### Cenario 4: Parametros operacionais na Config

1. Ir para Config (`/hedge/config`)
2. Verificar que os 5 parametros novos aparecem com valores default:
   - desvio_padrao_brl = 3.76
   - custo_financiamento_pct = 5.5
   - prazo_recebimento = 38
   - transit_medio_dias = 80
   - giro_estoque_dias = 30
3. Alterar `custo_financiamento_pct` para 6.0
4. Recarregar a pagina
5. Verificar que o valor persiste como 6.0

**Resultado esperado**: Todos os parametros com valores default corretos. Alteracao persiste.

### Cenario 5: Graficos Motor MV com dados reais

1. Ir para Motor MV (`/hedge/motor`)
2. Ajustar o slider lambda
3. Verificar que os graficos "Custo vs Protecao" e "Simulacao Margem" atualizam com os dados da tabela de recomendacoes
4. Comparar valor de custo no grafico com valor na coluna "Custo BRL" da tabela — devem ser consistentes

**Resultado esperado**: Graficos usam os mesmos dados da tabela de recomendacoes, nao calculos locais aproximativos.
