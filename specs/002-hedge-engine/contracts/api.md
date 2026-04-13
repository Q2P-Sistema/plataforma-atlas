# API Contracts: Hedge Engine

**Feature**: 002-hedge-engine
**Base URL**: `/api/v1/hedge`
**Auth**: Cookie `atlas_session` + header `x-csrf-token`
**Envelope**: `{ data: T | null, error: ErrorObj | null, meta?: {} }`

## Dashboard & Position

### GET /api/v1/hedge/posicao

Posicao consolidada com KPIs e buckets.

**Query params**: `?localidade=DEPOSITO_ACXE&empresa=acxe`

**Response 200**:
```json
{
  "data": {
    "kpis": {
      "exposure_usd": 2500000.00,
      "cobertura_pct": 72.5,
      "ndf_ativo_usd": 1812500.00,
      "gap_usd": 687500.00,
      "ptax_atual": { "venda": 5.45, "compra": 5.44, "data_ref": "2026-04-12", "atualizada": true }
    },
    "buckets": [
      {
        "id": "uuid", "mes_ref": "2026-05-01", "empresa": "acxe",
        "pagar_usd": 450000.00, "ndf_usd": 320000.00, "cobertura_pct": 71.1,
        "status": "ok"
      }
    ]
  },
  "error": null
}
```

### GET /api/v1/hedge/posicao/historico

Historico de snapshots para graficos.

**Query params**: `?dias=90`

**Response 200**:
```json
{
  "data": [
    { "data_ref": "2026-04-12", "exposure_usd": 2500000, "ndf_ativo_usd": 1812500, "gap_usd": 687500, "cobertura_pct": 72.5, "ptax_ref": 5.45 }
  ],
  "error": null
}
```

## NDFs / Contratos

### GET /api/v1/hedge/ndfs

Lista de NDFs com filtros.

**Query params**: `?status=ativo&empresa=acxe&limit=50&offset=0`

**Response 200**:
```json
{
  "data": [
    {
      "id": "uuid", "tipo": "ndf", "notional_usd": 100000, "taxa_ndf": 5.50,
      "ptax_contratacao": 5.40, "prazo_dias": 90, "data_contratacao": "2026-01-15",
      "data_vencimento": "2026-04-15", "custo_brl": 10000, "resultado_brl": null,
      "status": "ativo", "empresa": "acxe"
    }
  ],
  "error": null,
  "meta": { "total": 24, "limit": 50, "offset": 0 }
}
```

### POST /api/v1/hedge/ndfs

Criar novo NDF. Role: operador+

**Request**:
```json
{
  "tipo": "ndf",
  "notional_usd": 100000,
  "taxa_ndf": 5.50,
  "prazo_dias": 90,
  "data_vencimento": "2026-07-15",
  "empresa": "acxe",
  "observacao": "Cobertura bucket julho"
}
```

**Response 201**: NDF criado com custo_brl calculado.

### PATCH /api/v1/hedge/ndfs/:id/ativar

Ativar NDF pendente. Role: operador+

**Response 200**: `{ "data": { "status": "ativo" }, "error": null }`

### PATCH /api/v1/hedge/ndfs/:id/liquidar

Liquidar NDF ativo. Role: operador+

**Request**: `{ "ptax_liquidacao": 5.60 }`

**Response 200**: `{ "data": { "status": "liquidado", "resultado_brl": -10000 }, "error": null }`

### PATCH /api/v1/hedge/ndfs/:id/cancelar

Cancelar NDF. Role: operador+

**Response 200**: `{ "data": { "status": "cancelado" }, "error": null }`

## Motor de Minima Variancia

### POST /api/v1/hedge/motor/calcular

Calcula cobertura otima. Role: gestor+

**Request**:
```json
{
  "lambda": 0.7,
  "cambio_simulado": 5.50,
  "ndf_90d_taxa": 5.85,
  "pct_estoque_nao_pago": 0.55
}
```

**Response 200**:
```json
{
  "data": {
    "camadas": {
      "l1_pct": 68.0,
      "l2_pct": 17.5,
      "l3_pct": 14.5
    },
    "recomendacoes": [
      {
        "bucket_id": "uuid", "mes_ref": "2026-05-01",
        "instrumento": "NDF 60d", "notional_sugerido": 85000,
        "gap_atual": 130000, "cobertura_alvo": 85.5
      }
    ]
  },
  "error": null
}
```

### POST /api/v1/hedge/motor/aprovar

Aprovar recomendacao (cria NDF pendente). Role: gestor+

**Request**: `{ "recomendacao_index": 0, "bucket_id": "uuid" }`

**Response 201**: NDF pendente criado.

## Simulacao de Margem

### POST /api/v1/hedge/simulacao/margem

Simula margem por cenarios de cambio. Role: gestor+

**Request**:
```json
{
  "faturamento_brl": 5000000,
  "outros_custos_brl": 800000,
  "volume_usd": 500000
}
```

**Response 200**:
```json
{
  "data": {
    "cenarios": [
      { "cambio": 4.50, "custo_com_hedge": 2400000, "custo_sem_hedge": 2250000, "margem_pct": 33.2 },
      { "cambio": 4.75, "custo_com_hedge": 2420000, "custo_sem_hedge": 2375000, "margem_pct": 31.6 }
    ]
  },
  "error": null
}
```

## Estoque

### GET /api/v1/hedge/estoque

Estoque por localidade. Role: operador+

**Query params**: `?empresa=acxe`

**Response 200**:
```json
{
  "data": [
    { "localidade": "DEPOSITO_ACXE_SP", "empresa": "acxe", "valor_brl": 1200000, "custo_usd_estimado": 220000, "pago": false, "fase": "deposito" }
  ],
  "error": null
}
```

## PTAX

### GET /api/v1/hedge/ptax

PTAX atual e historico recente. Role: operador+

**Query params**: `?dias=30`

**Response 200**:
```json
{
  "data": {
    "atual": { "data_ref": "2026-04-12", "venda": 5.45, "compra": 5.44, "atualizada": true },
    "historico": [
      { "data_ref": "2026-04-11", "venda": 5.42, "compra": 5.41 }
    ]
  },
  "error": null
}
```

## Alertas

### GET /api/v1/hedge/alertas

Lista alertas. Role: operador+

**Query params**: `?resolvido=false&limit=50`

### PATCH /api/v1/hedge/alertas/:id/lido

Marcar como lido.

### PATCH /api/v1/hedge/alertas/:id/resolver

Resolver alerta.

## Configuracao

### GET /api/v1/hedge/config

Parametros do motor. Role: gestor+

### PATCH /api/v1/hedge/config

Atualizar parametros. Role: diretor

**Request**: `{ "chave": "lambda_default", "valor": 0.7 }`

### GET /api/v1/hedge/taxas-ndf

Taxas NDF de mercado.

### POST /api/v1/hedge/taxas-ndf

Inserir/atualizar taxa. Role: gestor+

**Request**: `{ "data_ref": "2026-04-12", "prazo_dias": 90, "taxa": 5.85 }`

## Frontend Routes

| Path | Component | Role |
|------|-----------|------|
| `/hedge` | PositionDashboard | operador+ |
| `/hedge/ndfs` | NDFListPage | operador+ |
| `/hedge/motor` | MotorMVPage | gestor+ |
| `/hedge/simulacao` | MarginSimulationPage | gestor+ |
| `/hedge/estoque` | InventoryPage | operador+ |
| `/hedge/alertas` | AlertsPage | operador+ |
| `/hedge/config` | ConfigPage | gestor+ |
