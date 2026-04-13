# API Contracts: Forecast Advanced Features

**Feature**: 005-forecast-advanced-features
**Date**: 2026-04-13

---

## Novos Endpoints

### GET /api/v1/forecast/demanda

Retorna vendas mensais por familia dos ultimos 24 meses, com YoY trimestral e sparkline data.

**Query params**: nenhum

**Response body**:
```json
{
  "data": [
    {
      "familia": "PROTEINA ISOLADA",
      "meses": [
        { "mes": "2024-04", "volume_kg": 12500, "valor_brl": 187500 },
        { "mes": "2024-05", "volume_kg": 14200, "valor_brl": 213000 }
      ],
      "ultimos_3m": [
        { "mes": "2026-01", "volume_kg": 15800 },
        { "mes": "2026-02", "volume_kg": 16200 },
        { "mes": "2026-03", "volume_kg": 17100 }
      ],
      "yoy": {
        "trimestre_atual": 49100,
        "trimestre_anterior": 42300,
        "variacao_pct": 16.08,
        "tendencia": "subindo"
      },
      "sparkline": [12500, 14200, 13800, 15000, ...],
      "skus": [
        { "codigo": "SKU-001", "descricao": "Prot Isol 25kg", "volume_24m": 180000, "contribuicao_pct": 62.3, "cobertura_dias": 45 },
        { "codigo": "SKU-002", "descricao": "Prot Isol 10kg", "volume_24m": 109000, "contribuicao_pct": 37.7, "cobertura_dias": 38 }
      ]
    }
  ]
}
```

---

### GET /api/v1/forecast/insights

Retorna fornecedores com LT, score COMEX mensal, historico de importacao, e janela de compra otima.

**Query params**: nenhum

**Response body**:
```json
{
  "data": {
    "fornecedores": [
      {
        "fornecedor": "SUPPLIER CO LTD",
        "pais_origem": "China",
        "familias": ["PROTEINA ISOLADA", "COLLAGEN"],
        "lt_efetivo_dias": 72,
        "total_importacoes": 18,
        "ultimo_embarque": "2026-03-15"
      }
    ],
    "score_comex": [
      { "mes": "2026-04", "score": 72, "classificacao": "COMPRAR", "preco_ton_usd": 2850, "volume_kg": 125000, "taxa_dolar": 5.82 },
      { "mes": "2026-05", "score": 58, "classificacao": "BOM", "preco_ton_usd": 2920, "volume_kg": 98000, "taxa_dolar": 5.90 },
      { "mes": "2026-06", "score": 43, "classificacao": "NEUTRO", "preco_ton_usd": 3100, "volume_kg": 85000, "taxa_dolar": 6.05 },
      { "mes": "2026-07", "score": 35, "classificacao": "CAUTELA", "preco_ton_usd": 3200, "volume_kg": 72000, "taxa_dolar": 6.15 }
    ],
    "historico_importacao": [
      { "mes": "2025-04", "volume_kg": 95000, "valor_usd": 285000, "preco_ton_usd": 3000, "taxa_dolar": 5.15 }
    ]
  }
}
```

---

### POST /api/v1/forecast/shopping-list/analyze

Envia shopping list para analise IA via gateway n8n.

**Request body**:
```json
{
  "itens": [
    {
      "familia": "PROTEINA ISOLADA",
      "qtd_kg": 25000,
      "valor_brl": 375000,
      "ruptura_dias": 45,
      "lt_dias": 60,
      "cobertura_dias": 30,
      "is_local": false
    }
  ]
}
```

**Response body (sucesso)**:
```json
{
  "data": {
    "resumo_executivo": "Lista com 5 itens, 3 urgentes. Recomendo priorizar Proteina Isolada e Collagen.",
    "alertas": [
      "2 familias com ruptura prevista em menos de 30 dias",
      "Score COMEX favoravel para compra este mes"
    ],
    "recomendacoes": [
      { "familia": "PROTEINA ISOLADA", "acao": "COMPRAR AGORA", "justificativa": "Ruptura em 45 dias, LT 60 dias — janela ja passou.", "prioridade": 1 },
      { "familia": "COLLAGEN", "acao": "AGUARDAR", "justificativa": "Estoque cobre 90 dias, preco spot acima da media 12m.", "prioridade": 3 }
    ]
  }
}
```

**Response body (LLM indisponivel)**:
```json
{
  "data": null,
  "error": { "code": "LLM_UNAVAILABLE", "message": "Servico de analise temporariamente indisponivel. Tente novamente em alguns minutos." }
}
```

**Timeout**: 30 segundos

---

## Endpoints Existentes (sem mudanca)

- `GET /api/v1/forecast/familias` — sem alteracao
- `POST /api/v1/forecast/calcular` — sem alteracao
- `GET /api/v1/forecast/urgentes` — sem alteracao
- `GET /api/v1/forecast/sazonalidade` — sem alteracao
- `PATCH /api/v1/forecast/sazonalidade` — sem alteracao
- `GET /api/v1/forecast/config` — sem alteracao
- `PATCH /api/v1/forecast/config` — sem alteracao

## Frontend Routes (novos)

| Path | Page | Sidebar |
|------|------|---------|
| `/forecast/demanda` | DemandAnalysisPage | "Demanda" (icon: BarChart3) |
| `/forecast/insights` | BusinessInsightsPage | "Insights" (icon: Lightbulb) |
