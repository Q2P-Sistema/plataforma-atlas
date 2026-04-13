# Research: Forecast Planner

**Date**: 2026-04-13

## Decision 1: Data source for stock 3-layer model

**Decision**: Read directly from OMIE tables via SQL pool (same pattern as hedge module).

**Rationale**: Tables `tbl_posicaoEstoque_Q2P` and `tbl_produtos_Q2P` are already synced hourly by n8n. No need for OMIE API calls. Using `getPool()` for raw SQL like the hedge module does.

**Alternatives considered**: OMIE API direct calls — rejected due to rate limits, latency, and Principle II (Atlas reads from Postgres).

**Key mappings validated via MCP queries (2026-04-13)**:
- `disponivel = nsaldo - reservado` (integers, kg)
- `bloqueado = reservado` (sales reservations)
- `transito = npendente` (purchased not arrived)
- `CMC = ncmc` (R$/kg, numeric)
- `familia = descricao_familia` from tbl_produtos_Q2P (~30 real families)
- `internacional = marca='IMPACXE'` in tbl_produtos_Q2P

## Decision 2: Data source for vendas12m (annual sales by SKU)

**Decision**: Query `tbl_movimentacaoEstoqueHistorico_Q2P` filtering `des_origem='Venda de Produto'`, summing `ABS(qtde)` by `id_prod` for last 365 days.

**Rationale**: Table already exists with data from 2021. 15,516 sales records available. `qtde` is negative for outflows, so use ABS(). No need for OMIE API `movestoque` endpoint.

**Alternatives considered**: OMIE API `ListarMovEstoque` — rejected, data already in BD. Manual input per family — rejected, data exists.

## Decision 3: Data source for purchase orders in pipeline (chegadas programadas)

**Decision**: Query `tbl_pedidosCompras_ACXE` with `cetapa IN ('10','20')` (open/approved), using `ddtprevisao` as arrival date and `nqtde` as quantity.

**Rationale**: Verified 3 real open orders (PEBD, PEAD) with ddtprevisao=2026-06-01, quantities 27t-81t. Join to Q2P products via shared `codigo` field.

**Key finding**: Products map between ACXE and Q2P via `tbl_produtos_ACXE.codigo = tbl_produtos_Q2P.codigo`. Same code, different descriptions (ACXE uses supplier names, Q2P uses commercial names).

**Etapa codes**: 10=aberto, 15=faturado/confirmado, 20=aprovado. For pipeline, use 10+20 (open + approved, not yet received). Exclude 15 (already received/invoiced).

## Decision 4: Product mapping ACXE to Q2P

**Decision**: Join on `tbl_produtos_ACXE.descricao = tbl_produtos_Q2P.descricao`. Product descriptions are identical between the two companies, but product codes are DIFFERENT.

**Rationale**: Validated via MCP query — PP HP401R is PP-011 in ACXE but PP-098 in Q2P. Same product, different codes. Description is the reliable join key.

**Implication**: To link Acxe purchase orders to Q2P stock: `pedidosCompras.ncodprod → tbl_produtos_ACXE.codigo_produto → tbl_produtos_ACXE.descricao = tbl_produtos_Q2P.descricao → Q2P stock`.

## Decision 5: Forecast engine placement

**Decision**: Backend computation in `modules/forecast/src/services/forecast.service.ts`. The 120-day simulation runs server-side and returns the full series to the frontend.

**Rationale**: The legacy ran 100% in the browser (2955 lines JSX). But with ~30 families and ~100+ SKUs, computing server-side avoids shipping all raw data to the client and keeps the engine testable with Vitest.

**Alternatives considered**: Client-side computation like legacy — rejected for testability (Principle III: financial logic in TypeScript with tests) and data volume.

## Decision 6: Seasonality storage

**Decision**: Store in a `forecast.config_sazonalidade` table (familia_id, mes 1-12, fator). Seed with defaults from legacy. User overrides persist immediately.

**Rationale**: Must survive browser reload (spec US6 requires log of changes). Config table pattern used by hedge module already.

## Decision 7: Shopping list persistence

**Decision**: Session-only in MVP (React state). No server persistence for v1.

**Rationale**: Shopping list is a transient working artifact — comprador generates, reviews, copies to executor, and discards. Persistence adds complexity (multi-user access, conflict resolution) without clear MVP value.

## Decision 8: Validacao por comparacao com planilha

**Decision**: Usar a planilha "Planejador de Compras - Rev Latest.xlsm" (legacy/vibecodes/forecast/) como fonte de comparacao para validar os calculos do forecast engine.

**Rationale**: A planilha e o instrumento real usado pela equipe de compras hoje. Comparar os resultados do engine (ruptura, qtd sugerida, cobertura) com os da planilha e o metodo mais confiavel de validacao. Se os numeros baterem, o engine esta correto. Divergencias devem ser investigadas.

**Implication**: Durante a implementacao, o comprador pode abrir a planilha e o Atlas lado a lado e comparar familias criticas.
