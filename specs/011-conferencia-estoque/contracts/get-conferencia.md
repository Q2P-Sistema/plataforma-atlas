# Contract: `GET /api/v1/stockbridge/conferencia`

Lista comparada ACXE × Q2P da posição mais recente, com resumo (KPIs). **Somente leitura.**

- **Auth**: `requireAuth` + `requireModule('stockbridge')` + `requireGestor` (gestor, diretor).
- **Envelope**: padrão StockBridge `{ data, error }`.

## Request — query params (todos opcionais; default = sem filtro)

| Param | Tipo | Valores | Efeito |
|---|---|---|---|
| `status` | enum | `divergente` \| `negativo` \| `problemas` \| `ok` | filtra por `statusGeral`. `problemas` = todos ≠ OK. `divergente` = `Divergente` + `Divergente e Negativo`. `negativo` = `statusSaldoNegativo ≠ OK` |
| `tipo` | enum | `ESPELHADO` \| `INDIVIDUAL` | filtra por tipo do local |
| `codigoEstoque` | string | ex. `11.1` | filtra um local |
| `busca` | string | texto livre | match em `produto` / `nomeEstoque` |

Zod (`.safeParse`); inválido → `400 { error: { code: 'INVALID_INPUT', message } }`.

> Filtragem aplicada **após** a engine (o `resumo` reflete sempre o universo completo da posição, não o subconjunto filtrado — KPIs são da posição inteira). Se for desejável KPIs do subconjunto, expor `escopoResumo=filtrado` (fora da v1).

## Response — `200`

```jsonc
{
  "data": {
    "resumo": {
      "totalSkusDivergentes": 16,
      "totalProblemas": 27,
      "totalQuebrasNegativas": 15,
      "somaDiferencaKg": -1234,
      "dataPosicaoAcxe": "2026-06-22",
      "dataPosicaoQ2p": "2026-06-22",
      "defasagemEntreEmpresas": false
    },
    "itens": [
      {
        "codigoEstoque": "11.1",
        "nomeEstoque": "SANTO ANDRÉ (IMPORTADO)",
        "tipoEstoque": "ESPELHADO",
        "produto": "PEBD 100",
        "saldoAcxeKg": -1500,
        "saldoQ2pKg": -1500,
        "diferencaKg": 0,
        "statusSaldoNegativo": "ACXE e Q2P negativos",
        "statusGeral": "Negativo"
      }
    ]
  },
  "error": null
}
```

- `itens` já vem **ordenado** (problemas no topo — ver data-model §3).
- Quantidades em **Kg** (inteiros, separador de milhar no front via `fmtKg`).

## Erros

| HTTP | code | Quando |
|---|---|---|
| 400 | `INVALID_INPUT` | query inválida |
| 401/403 | (middleware) | sem auth / sem papel / módulo off |
| 500 | `CONFERENCIA_FAIL` | falha na query/engine (logada via `createLogger`) |

## Casos de teste (Supertest + Vitest)

1. Sem filtro → `itens.length ≈ 6096` (paridade), primeiro item tem `statusGeral` de problema.
2. `?status=problemas` → `itens.length == resumo.totalProblemas` e todos ≠ `OK`.
3. `?tipo=INDIVIDUAL` → nenhum item com `statusGeral` em {Divergente, Divergente e Negativo}.
4. `?status=xpto` → 400 `INVALID_INPUT`.
5. Engine: caso PEBD 100 / 11.1 (ambos −1500) → `Negativo` (não `Divergente e Negativo`).
