# Data Model: Forecast Advanced Features

**Feature**: 005-forecast-advanced-features
**Date**: 2026-04-13

---

## Entidades (todas read-only de tabelas OMIE existentes)

Nenhuma tabela nova criada. Todos os dados sao lidos de tabelas OMIE ja sincronizadas.

### Vendas Mensais (query result, nao persistido)

Fonte: `tbl_movimentacaoEstoqueHistorico_Q2P` + `tbl_produtos_Q2P`

| Campo | Tipo | Descricao |
|-------|------|-----------|
| familia | string | descricao_familia do produto |
| mes | string | YYYY-MM |
| volume_kg | number | SUM(ABS(qtde)) do mes |
| valor_brl | number | SUM(ABS(valor)) do mes |
| skus | array | Breakdown por SKU (codigo, descricao, volume, % contribuicao) |

Agregacao: GROUP BY descricao_familia, TO_CHAR(dt_mov, 'YYYY-MM')
Filtros: des_origem = 'Venda de Produto', cancelamento != 'S', ultimos 24 meses

### YoY Trimestral (calculado em runtime)

| Campo | Tipo | Descricao |
|-------|------|-----------|
| familia | string | Nome da familia |
| trimestre_atual | number | Soma vendas dos ultimos 3 meses fechados |
| trimestre_anterior | number | Soma vendas dos mesmos 3 meses do ano anterior |
| variacao_yoy_pct | number | ((atual - anterior) / anterior) * 100 |
| tendencia | string | 'subindo' se > +10%, 'descendo' se < -10%, 'estavel' |

### Fornecedor (query result da FUP)

Fonte: `tbl_dadosPlanilhaFUPComex`

| Campo | Tipo | Descricao |
|-------|------|-----------|
| fornecedor | string | Nome do fornecedor |
| pais_origem | string | Pais de origem |
| familias | string[] | ARRAY_AGG(DISTINCT familia_produto) |
| lt_efetivo_dias | number | AVG(data_desembarque - data_proforma) |
| total_importacoes | number | COUNT(*) |
| ultimo_embarque | date | MAX(data_proforma) |

### Score COMEX Mensal (calculado em runtime)

| Campo | Tipo | Descricao |
|-------|------|-----------|
| mes | string | YYYY-MM |
| score | number | 0-100 (formula ponderada preco/volume/cambio) |
| classificacao | string | COMPRAR / BOM / NEUTRO / CAUTELA / EVITAR |
| preco_ton_usd | number | AVG(valor_total_tonelada_usd) do mes |
| volume_kg | number | SUM(volume_total_kg) do mes |
| taxa_dolar | number | AVG(taxa_dolar) do mes |

### Analise IA (transiente, nao persistido)

| Campo | Tipo | Descricao |
|-------|------|-----------|
| timestamp | string | ISO datetime da analise |
| resumo_executivo | string | Texto livre do LLM |
| alertas | string[] | Lista de alertas identificados |
| recomendacoes | array | { familia, acao, justificativa, prioridade } por item |

Acoes possiveis: COMPRAR AGORA, AGUARDAR, REVISAR, OK
