# Data Model: Forecast Planner

## Source Tables (read-only, public schema — OMIE sync)

### tbl_produtos_Q2P
Products catalog. Join key to all other tables.

| Field | Type | Forecast use |
|-------|------|-------------|
| codigo | varchar | Product code (DIFFERENT from ACXE — join by descricao) |
| codigo_produto | bigint | OMIE internal ID |
| descricao | text | Product name |
| codigo_familia | bigint | Family group ID |
| descricao_familia | varchar | Family name (PP HOMO 25, PEAD FILME, etc.) |
| marca | varchar | Brand — 'IMPACXE' = imported by Acxe |
| lead_time | integer | Days (supplier to warehouse) |
| unidade | varchar | Unit of measure (KG) |

### tbl_posicaoEstoque_Q2P
Current stock position per SKU per location.

| Field | Type | Forecast use |
|-------|------|-------------|
| ccodigo | varchar | Product code (FK to tbl_produtos_Q2P.codigo) |
| codigo_local_estoque | bigint | Warehouse location |
| nsaldo | integer | Physical balance (kg) |
| reservado | integer | Sales reservations (kg) |
| npendente | integer | Purchased not arrived (kg) |
| ncmc | numeric | Weighted average cost (R$/kg) |

**Derived fields**:
- `disponivel = nsaldo - reservado`
- `bloqueado = reservado`
- `transito = npendente`

### tbl_pedidosCompras_ACXE
Purchase orders from Acxe (importer). Source for arrival dates.

| Field | Type | Forecast use |
|-------|------|-------------|
| ncodprod | bigint | Product ID (FK via tbl_produtos_ACXE.codigo_produto) |
| nqtde | numeric | Ordered quantity (kg) |
| nqtderec | numeric | Already received (kg) |
| ddtprevisao | date | Expected arrival date |
| cetapa | varchar | Status: 10=open, 20=approved, 15=invoiced |
| nvaltot | numeric | Total value BRL |

**Pipeline filter**: `cetapa IN ('10','20')` AND `nqtderec < nqtde` (not fully received)

### tbl_produtos_ACXE
Product catalog Acxe side. Links to Q2P via `codigo`.

| Field | Type | Forecast use |
|-------|------|-------------|
| codigo | varchar | Product code (DIFFERENT from Q2P — do NOT join by codigo) |
| codigo_produto | bigint | OMIE internal ID (= pedidosCompras.ncodprod) |
| descricao | text | Product name (**= tbl_produtos_Q2P.descricao — JOIN KEY**) |

### tbl_movimentacaoEstoqueHistorico_Q2P
Stock movement history. Source for vendas12m.

| Field | Type | Forecast use |
|-------|------|-------------|
| id_prod | bigint | Product ID |
| qtde | integer | Quantity (negative for outflows) |
| dt_mov | date | Movement date |
| des_origem | varchar | Type: 'Venda de Produto' for sales |
| cancelamento | char | 'S' if cancelled |

**vendas12m query**: `SUM(ABS(qtde)) WHERE des_origem='Venda de Produto' AND cancelamento != 'S' AND dt_mov >= CURRENT_DATE - 365 GROUP BY id_prod`
**Join**: `id_prod = tbl_produtos_Q2P.codigo_produto` (validated — both are bigint OMIE IDs)

## Forecast Schema Tables (hedge schema pattern — forecast.*)

### forecast.config_sazonalidade
Seasonality factors per family per month. User-editable.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| familia_id | varchar(100) | descricao_familia from produtos |
| mes | integer | 1-12 |
| fator_sugerido | numeric(4,2) | System default (from legacy data) |
| fator_usuario | numeric(4,2) | User override (null = use sugerido) |
| updated_at | timestamptz | |

**Unique**: (familia_id, mes)
**Effective factor**: `COALESCE(fator_usuario, fator_sugerido)`

### forecast.config_forecast
General forecast parameters. Same pattern as hedge.config_motor.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| chave | varchar(100) | PK | Parameter key |
| valor | jsonb | | Parameter value |
| descricao | text | | Description |

**Seeds**:
- `variacao_anual_pct` = 5 (annual demand growth %)
- `buffer_dias` = 10 (safety buffer days)
- `lead_time_local` = 7 (emergency local LT days)
- `moq_internacional` = 25000 (kg, 25t)
- `moq_nacional` = 12000 (kg, 12t)
- `horizonte_dias` = 120 (forecast horizon)
- `horizonte_cobertura` = 60 (days beyond LT to cover)

### forecast.sazonalidade_log
Audit trail for seasonality changes.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| familia_id | varchar(100) | |
| mes | integer | 1-12 |
| fator_anterior | numeric(4,2) | |
| fator_novo | numeric(4,2) | |
| usuario | varchar(100) | Who changed |
| created_at | timestamptz | |

## Computed Structures (not persisted — returned by API)

### FamiliaForecast (per-family output)
```
{
  familia_id, familia_nome,
  is_internacional, lt_efetivo,
  
  // Stock
  pool_disponivel, pool_bloqueado, pool_transito, pool_total,
  cmc_medio,
  
  // Demand
  vendas12m, venda_diaria_media, venda_diaria_sazonalizada,
  cobertura_dias,
  
  // Forecast
  dia_ruptura, dia_pedido_ideal, prazo_perdido,
  status: 'critico' | 'atencao' | 'ok',
  
  // Suggestion
  qtd_bruta, qtd_em_rota, qtd_liquida, qtd_sugerida,
  moq_ativo, valor_brl,
  
  // Emergency
  compra_local: null | { dia_abrir, lt_local, gap_dias, custo_oportunidade, qtd_local, valor_local },
  
  // 120-day series
  serie: [{ dia, data, estoque, chegada, zona, venda_dia }],
  
  // SKU breakdown
  skus: [{ codigo, descricao, disponivel, bloqueado, transito, total, cmc, venda_dia, cobertura, lt }],
  
  // Pipeline
  pedidos_em_rota: [{ codigo, qtd_pendente, data_chegada, valor_brl }]
}
```
