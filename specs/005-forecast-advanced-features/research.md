# Research: Forecast Advanced Features

**Feature**: 005-forecast-advanced-features
**Date**: 2026-04-13

---

## R1: Fonte de dados para vendas mensais (US1)

**Decision**: Usar `tbl_movimentacaoEstoqueHistorico_Q2P` com filtro `des_origem = 'Venda de Produto'`, agrupado por `descricao_familia` e `TO_CHAR(dt_mov, 'YYYY-MM')`.

**Rationale**: Tabela ja validada e usada pelo forecast engine para vendas12m. Tem 54 meses de historico (desde 2021-11), 15.516 registros. O servico `vendas.service.ts` ja faz query similar — o novo service agrega por mes em vez de por ano.

**Dados confirmados**:
- Primeiro registro: 2021-11-03
- Ultimo registro: 2026-04-10
- 54 meses distintos de dados
- Join com `tbl_produtos_Q2P` para resolver `descricao_familia` e `codigo`

**Alternatives considered**:
- Criar view SQL: Rejeitado — query raw e simples e nao precisa de view dedicada.
- Usar dados do forecast engine existente: Rejeitado — o engine retorna vendas12m (anual), nao mensal.

---

## R2: Score COMEX e dados de importacao (US2)

**Decision**: Calcular score COMEX a partir de `tbl_dadosPlanilhaFUPComex` usando media ponderada de: preco por tonelada USD (40%), volume total kg (30%), variacao cambial do periodo (30%). Score normalizado 0-100.

**Rationale**: A FUP tem 227 registros, 22 fornecedores, 42 familias, cobrindo fev/2025 a abr/2026 (~14 meses). Campos disponiveis: `volume_total_kg`, `valor_total_usd`, `valor_total_tonelada_usd`, `taxa_dolar`, `fornecedor`, `pais_origem`, `familia_produto`, `data_proforma`. Suficiente para calcular score historico e projetar janela otima.

**Dados confirmados**:
- Fornecedores na FUP: 22 (com nome e pais_origem)
- Familias: 42
- Campos financeiros: valor_total_usd, valor_total_tonelada_usd, volume_total_kg, taxa_dolar
- Datas: data_proforma (principal), etd, eta, data_desembarque

**Formula do score**:
```
Para cada mes dos ultimos 12:
  preco_score = 100 - (preco_ton_usd_mes / max_preco_12m * 100)  // menor preco = melhor
  volume_score = volume_kg_mes / max_volume_12m * 100              // mais volume = melhor
  cambio_score = 100 - (taxa_dolar_mes / max_taxa_12m * 100)      // menor cambio = melhor
  score = preco_score * 0.4 + volume_score * 0.3 + cambio_score * 0.3

Classificacao:
  >= 70: COMPRAR
  >= 55: BOM
  >= 40: NEUTRO
  >= 25: CAUTELA
  < 25: EVITAR
```

**Alternatives considered**:
- Score via API externa (COMEXSTAT): Rejeitado — adiciona dependencia externa, dados OMIE sao suficientes.
- Score fixo por mes (tabela manual): Rejeitado — nao escala, nao atualiza automaticamente.

---

## R3: Fornecedores e Lead Time (US2)

**Decision**: Cruzar `tbl_dadosPlanilhaFUPComex` (campo `fornecedor`, `pais_origem`) com historico de datas para calcular LT efetivo = media de `(data_desembarque - data_proforma)` por fornecedor. Listar familias atendidas via campo `familia_produto`.

**Rationale**: Os dados de fornecedor na FUP sao mais ricos que na tabela de cadastro ACXE (que e generica). A FUP tem fornecedor + pais + familia + datas reais de embarque/desembarque.

**Alternatives considered**:
- Usar tbl_cadastroFornecedoresClientes_ACXE: Rejeitado como fonte principal — nao tem pais_origem nem vinculo a familias. Pode servir de complemento.

---

## R4: Gateway LLM via n8n (US3)

**Decision**: O Atlas faz POST HTTP para webhook n8n com payload JSON contendo a shopping list + contexto (familias, qtds, rupturas, scores, LTs). O n8n encaminha ao provedor LLM e retorna resposta estruturada. O endpoint Atlas e `POST /api/v1/forecast/shopping-list/analyze`.

**Rationale**: Principio III — LLM gateway exclusivamente via n8n. O Atlas nao chama API Anthropic diretamente. Timeout de 30s. Fallback gracioso se n8n indisponivel.

**Payload enviado ao n8n**:
```json
{
  "itens": [
    { "familia": "...", "qtd_kg": 25000, "valor_brl": 375000, "ruptura_dias": 45, "lt_dias": 60, "cobertura_dias": 30, "is_local": false }
  ],
  "contexto": {
    "total_itens": 8,
    "total_valor_brl": 1200000,
    "data_analise": "2026-04-13"
  }
}
```

**Resposta esperada do n8n**:
```json
{
  "resumo_executivo": "...",
  "alertas": ["..."],
  "recomendacoes": [
    { "familia": "...", "acao": "COMPRAR AGORA", "justificativa": "...", "prioridade": 1 }
  ]
}
```

**Alternatives considered**:
- Chamar API LLM diretamente do backend: Rejeitado — viola Principio III.
- Fazer analise sem LLM (regras fixas): Possivel como fallback, mas perde a capacidade de analise contextual.
