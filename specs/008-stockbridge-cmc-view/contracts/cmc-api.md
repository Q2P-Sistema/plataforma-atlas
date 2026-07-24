# API Contract — StockBridge CMC View (008)

Todas as rotas:
- Prefixo `/api/v1/stockbridge` (já protegido por `requireAuth` + `requireModule('stockbridge')` no router agregador).
- Acesso: **`requireGestor`** (gestor + diretor; operador → 403). Ver D2 no research.
- Envelope padrão do módulo: `{ data, error }`. Erro: `{ data: null, error: { code, message } }`.
- Validação de query via Zod; query inválida → `400 INVALID_INPUT`.
- Leitura apenas (GET). Sem CSRF necessário para GET, mas o frontend envia `x-csrf-token` por consistência.

Convenções de filtro (compartilhadas):
- `familia` — repetível ou CSV (multi). Match exato; "Sem família" é valor válido.
- `produto` — repetível ou CSV (multi), por `codigo_produto`.
- `origem` — `IMPORTADO` | `NACIONAL` (omisso = ambas).

---

## GET /api/v1/stockbridge/cmc/snapshot

Posição de CMC do snapshot mais recente (ou de `data`), agrupada por família com produtos.

**Query**:
| param | tipo | default | nota |
|---|---|---|---|
| `data` | ISO date | MAX(data_snapshot) | sem UI na v1 (Snapshot sempre no mais recente — FR-009/U1); param mantido para uso futuro |
| `familia` | string[] | — | multi |
| `produto` | string[] | — | multi |
| `origem` | enum | ambas | IMPORTADO/NACIONAL |

**200** → `{ data: CmcSnapshotResponse, error: null }`
```jsonc
{
  "data": {
    "dataSnapshot": "2026-06-08",
    "defasado": false,
    "resumo": { "volumeTotalKg": 2923754, "valorTotal": 23224405.27 },
    "familias": [
      {
        "descricaoFamilia": "PP HOMO 25",
        "cmcPonderado": 7.81, "volumeKg": 567473, "valor": 4404550.72,
        "porOrigem": {
          "importado": { "cmcPonderado": null, "volumeKg": 0, "valor": 0 },
          "nacional":  { "cmcPonderado": 7.81, "volumeKg": 567473, "valor": 4404550.72 }
        },
        "produtos": [
          { "codigoProduto": "PP-146", "descricaoProduto": "...", "origem": "NACIONAL",
            "cmcPonderado": 7.2661, "volumeKg": 414523, "valor": 3011949.69 }
        ]
      }
    ]
  },
  "error": null
}
```
Regras: `cmcPonderado = SUM(valor)/NULLIF(SUM(volume),0)`; volume 0 → `null`. `resumo` **não** traz CMC global (FR-018). Famílias sem `descricao_familia` → `"Sem família"`.

---

## GET /api/v1/stockbridge/cmc/tendencia

Série diária do CMC ponderado no período, com lacunas para dias sem coleta.

**Query**:
| param | tipo | default | nota |
|---|---|---|---|
| `de` | ISO date | MIN(data_snapshot) | início |
| `ate` | ISO date | MAX(data_snapshot) | fim |
| `familia` | string[] | — | define as séries (1 por família) |
| `produto` | string[] | — | se presente, séries por produto·origem |
| `origem` | enum | ambas | |

**200** → `{ data: CmcTendenciaResponse, error: null }`
```jsonc
{
  "data": {
    "datas": ["2026-06-01", "2026-06-02", "2026-06-03"],
    "series": [
      { "chave": "PP HOMO 25", "label": "PP HOMO 25",
        "pontos": [
          { "data": "2026-06-01", "cmcPonderado": 7.79, "volumeKg": 560000, "valor": 4362400 },
          null,
          { "data": "2026-06-03", "cmcPonderado": 7.81, "volumeKg": 567473, "valor": 4434463 }
        ] }
    ]
  },
  "error": null
}
```
Regra: `pontos[i] === null` quando não há `data_snapshot` naquele dia (sem interpolar). Sem filtro de família/produto → série única agregada de tudo (ou top-N por valor; ver tasks).

---

## GET /api/v1/stockbridge/cmc/filtros

Opções para os combos multi-seleção. Famílias e produtos do snapshot mais recente.

**Query**:
| param | tipo | nota |
|---|---|---|
| `familia` | string[] | restringe `produtos` às famílias dadas |

**200** → `{ data: CmcFiltrosResponse, error: null }`
```jsonc
{
  "data": {
    "familias": ["PP HOMO 25", "PEAD FILME", "Sem família"],
    "produtos": [{ "codigo": "PP-146", "descricao": "...", "familia": "PP HOMO 25" }]
  },
  "error": null
}
```

---

## Erros comuns
| code | HTTP | quando |
|---|---|---|
| `INVALID_INPUT` | 400 | query falha no Zod (data inválida, origem fora do enum) |
| (auth) | 401/403 | sem login / role insuficiente (operador) / módulo desabilitado |
| `CMC_FAIL` | 500 | erro inesperado na query |
