# Data Model — StockBridge CMC View (008)

Feature **somente leitura**. Não há entidade nova persistida; o modelo abaixo descreve (a) a **fonte** e (b) os **read models** retornados pela API.

## Fonte (read-only) — `public."tbl_historico_cmc_estoque"`

Banco `acxe_q2p`. Populada diariamente (08:30 BRT, inclusive fds) pelo workflow n8n `Plc4nZOU2HgxaWM8` (spec legado `002-historico-cmc-estoque`). **Não é gerida pelo Atlas** — não criar migration.

| Coluna | Tipo | Observação |
|---|---|---|
| `id` | integer (PK) | sequence própria |
| `data_snapshot` | date | data da foto (1/dia) |
| `codigo_produto` | varchar | PN |
| `descricao_produto` | varchar | nome do produto |
| `descricao_familia` | varchar (nullable) | família; NULL/'' em 3 linhas → "Sem família" |
| `origem` | varchar | `IMPORTADO` \| `NACIONAL` (maiúsculas) |
| `volume_total` | numeric | **kg** (sem conversão) |
| `valor_total_cmc` | numeric | **R$** (valor imobilizado da linha) |
| `media_cmc_ponderada` | numeric | **R$/kg** (= valor_total_cmc / volume_total) |
| `criado_em` | timestamptz | metadado de carga |

**Unicidade**: `(data_snapshot, codigo_produto, origem)` (unique `uq_historico_dia_produto`).
**Índices úteis**: `idx_hist_data` (data_snapshot), `idx_hist_familia`, `idx_hist_produto`.
**Volume**: ~3.850 linhas/snapshot; desde 2026-06-01.

## Regras de derivação (no `cmc.service.ts`)

- **CMC ponderado (qualquer nível)**: `SUM(valor_total_cmc) / NULLIF(SUM(volume_total), 0)`. Nunca média aritmética. NULL (volume 0) → exibir "—".
- **Família**: `COALESCE(NULLIF(descricao_familia,''), 'Sem família')` como chave de agrupamento.
- **Snapshot "atual"**: `data_snapshot = (SELECT MAX(data_snapshot) ...)` respeitando o filtro de data opcional.
- **Defasado**: `MAX(data_snapshot) <> CURRENT_DATE`.
- **Filtros**: família (IN, multi), produto (IN, multi), origem (IN/eq), data/período. Combo de produto restringe-se às famílias filtradas.

## Read Models (saída da API)

### `CmcResumo`
```
{ volumeTotalKg: number, valorTotal: number }   // sem CMC global (FR-018)
```

### `CmcProdutoNode` (folha da árvore)
```
{
  codigoProduto: string,
  descricaoProduto: string,
  origem: 'IMPORTADO' | 'NACIONAL',
  cmcPonderado: number | null,   // R$/kg; null se volume 0
  volumeKg: number,
  valor: number
}
```

### `CmcFamiliaNode`
```
{
  descricaoFamilia: string,      // "Sem família" quando ausente
  cmcPonderado: number | null,   // ponderado por volume
  volumeKg: number,
  valor: number,
  porOrigem: { importado: { cmcPonderado, volumeKg, valor },
               nacional:  { cmcPonderado, volumeKg, valor } },
  produtos: CmcProdutoNode[]     // folhas (por produto × origem)
}
```

### `CmcSnapshotResponse`
```
{
  dataSnapshot: string,          // ISO date do snapshot exibido
  defasado: boolean,
  resumo: CmcResumo,             // respeita filtros
  familias: CmcFamiliaNode[]     // ordenável por valor desc
}
```

### `CmcTendenciaResponse`
```
{
  datas: string[],               // eixo X (dias do período, ordenado)
  series: Array<{
    chave: string,               // família OU "produto·origem"
    label: string,
    pontos: Array<{ data: string, cmcPonderado: number | null,
                    volumeKg: number, valor: number } | null>  // null = dia sem coleta (lacuna)
  }>
}
```

### `CmcFiltrosResponse`
```
{
  familias: string[],                                   // do snapshot mais recente
  produtos: Array<{ codigo: string, descricao: string, familia: string }>  // filtrável por ?familia=
}
```
