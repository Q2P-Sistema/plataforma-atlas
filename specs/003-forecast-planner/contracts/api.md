# API Contracts: Forecast Planner

All endpoints under `/api/v1/forecast/` require `requireAuth`.

## GET /api/v1/forecast/familias

Returns all product families with stock position and basic forecast data.

**Response**:
```json
{
  "data": [
    {
      "familia_id": "PP HOMO 25",
      "familia_nome": "PP HOMO 25",
      "is_internacional": true,
      "pool_disponivel": 320648,
      "pool_bloqueado": 0,
      "pool_transito": 0,
      "pool_total": 320648,
      "cmc_medio": 8.25,
      "vendas12m": 850000,
      "venda_diaria_media": 2329,
      "cobertura_dias": 137,
      "lt_efetivo": 55,
      "status": "ok",
      "skus_count": 5,
      "pedidos_em_rota": 0
    }
  ]
}
```

## POST /api/v1/forecast/calcular

Runs 120-day forecast for one or all families.

**Body** (all optional):
```json
{
  "familia_id": "PP HOMO 25",
  "variacao_anual_pct": 5,
  "buffer_dias": 10
}
```

If `familia_id` omitted, runs for all families.

**Response**:
```json
{
  "data": [
    {
      "familia_id": "PP HOMO 25",
      "familia_nome": "PP HOMO 25",
      "is_internacional": true,
      "lt_efetivo": 55,
      "pool_disponivel": 320648,
      "pool_bloqueado": 0,
      "pool_transito": 0,
      "pool_total": 320648,
      "cmc_medio": 8.25,
      "vendas12m": 850000,
      "venda_diaria_media": 2329,
      "venda_diaria_sazonalizada": 2515,
      "cobertura_dias": 127,
      "dia_ruptura": 127,
      "dia_pedido_ideal": 62,
      "prazo_perdido": false,
      "status": "ok",
      "qtd_bruta": 267900,
      "qtd_em_rota": 0,
      "qtd_liquida": 267900,
      "qtd_sugerida": 275000,
      "moq_ativo": 25000,
      "valor_brl": 2268750,
      "compra_local": null,
      "serie": [
        { "dia": 0, "data": "2026-04-13", "estoque": 320648, "chegada": 0, "zona": "ok", "venda_dia": 2515 }
      ],
      "skus": [
        { "codigo": "PP-098", "descricao": "PP HP401R", "disponivel": 100000, "bloqueado": 0, "transito": 0, "total": 100000, "cmc": 8.25, "venda_dia": 900, "cobertura": 111, "lt": 55 }
      ],
      "pedidos_em_rota": []
    }
  ]
}
```

## GET /api/v1/forecast/urgentes

Returns only families with `dia_pedido_ideal <= 15`.

**Response**: Same shape as `/calcular` but filtered and sorted by urgency.

## GET /api/v1/forecast/sazonalidade

Returns seasonality config for all families.

**Response**:
```json
{
  "data": [
    {
      "familia_id": "PP HOMO 25",
      "meses": [
        { "mes": 1, "fator_sugerido": 0.88, "fator_usuario": null, "fator_efetivo": 0.88 },
        { "mes": 2, "fator_sugerido": 0.90, "fator_usuario": null, "fator_efetivo": 0.90 }
      ]
    }
  ]
}
```

## PATCH /api/v1/forecast/sazonalidade

Updates seasonality factor for a family/month.

**Body**:
```json
{
  "familia_id": "PP HOMO 25",
  "mes": 6,
  "fator": 1.25
}
```

**Response**: `{ "data": { "familia_id": "PP HOMO 25", "mes": 6, "fator_anterior": 1.08, "fator_novo": 1.25 } }`

## GET /api/v1/forecast/config

Returns forecast parameters.

## PATCH /api/v1/forecast/config

Updates forecast parameter. Requires `requireRole('gestor', 'diretor')`.

**Body**: `{ "chave": "buffer_dias", "valor": 15 }`
