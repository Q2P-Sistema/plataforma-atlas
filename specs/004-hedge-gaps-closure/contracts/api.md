# API Contracts: Hedge Gaps Closure

**Feature**: 004-hedge-gaps-closure
**Date**: 2026-04-13

---

## Endpoints Modificados

### GET /api/v1/hedge/posicao

**Mudanca**: O campo `kpis.exposure_usd` agora inclui `est_nao_pago_usd` distribuido proporcionalmente. Cada bucket no array `buckets` tambem reflete a exposicao ajustada.

**Response body** (campos novos/alterados marcados com *):

```json
{
  "data": {
    "kpis": {
      "exposure_usd": 12780000,       // * inclui est_nao_pago_usd
      "cobertura_pct": 45.2,
      "ndf_ativo_usd": 5780000,
      "gap_usd": 7000000,             // * ajustado com est_nao_pago
      "ptax_atual": { "dataRef": "2026-04-11", "venda": 5.82, "compra": 5.82, "atualizada": true },
      "variacao_30d_pct": -1.23,
      "est_nao_pago_usd": 1830000,    // * novo — valor global
      "total_pagar_usd": 10950000,
      "...": "demais campos do resumo VPS"
    },
    "buckets": [
      {
        "id": "uuid",
        "mes_ref": "2026-05-01",
        "empresa": "acxe",
        "pagar_usd": 2500000,
        "est_nao_pago_usd": 417000,   // * novo — parcela proporcional
        "exposicao_usd": 2917000,     // * novo — pagar + est_nao_pago
        "ndf_usd": 1200000,
        "cobertura_pct": 41.1,        // * recalculado sobre exposicao
        "status": "sub_hedged"
      }
    ]
  }
}
```

**Cache**: Response cacheada por 5 minutos (key `atlas:hedge:posicao:{empresa}`). Header `X-Cache: HIT` ou `X-Cache: MISS`.

---

### GET /api/v1/hedge/estoque

**Mudanca**: Response cacheada por 1 hora.

**Cache**: Key `atlas:hedge:estoque:{empresa}`. Header `X-Cache`.

---

### GET /api/v1/hedge/estoque/localidades

**Mudanca**: Response cacheada por 1 hora.

**Cache**: Key `atlas:hedge:localidades`. Header `X-Cache`.

---

### PUT /api/v1/hedge/estoque/localidades

**Mudanca**: Invalida cache `atlas:hedge:localidades` e `atlas:hedge:posicao:*`.

---

### POST /api/v1/hedge/ndfs

**Mudanca**: Invalida cache `atlas:hedge:posicao:*` apos criacao bem-sucedida.

---

### PATCH /api/v1/hedge/ndfs/:id/{ativar,liquidar,cancelar}

**Mudanca**: Invalida cache `atlas:hedge:posicao:*` apos transicao bem-sucedida.

---

## Endpoints Sem Mudanca

- `POST /api/v1/hedge/motor/calcular` — sem cache (calculo sempre fresco)
- `GET /api/v1/hedge/ptax` — cache ja existe no integration-bcb (15min)
- `GET /api/v1/hedge/alertas` — sem cache (lista deve ser sempre atualizada)
- `GET /api/v1/hedge/config` — sem cache (poucas leituras)
- `PATCH /api/v1/hedge/config` — sem cache
- `GET /api/v1/hedge/taxas-ndf` — sem cache
- `POST /api/v1/hedge/taxas-ndf` — sem cache
- `POST /api/v1/hedge/simulacao/margem` — sem cache (calculo on-demand)
