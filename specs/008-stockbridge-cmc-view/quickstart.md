# Quickstart — StockBridge CMC View (008)

## Pré-requisitos de dados

A fonte `public.tbl_historico_cmc_estoque` precisa existir no ambiente:
- **prod / UAT**: já existe (UAT herda via sync full do `acxe_q2p`).
- **dev**: rodar o sync (a tabela já foi adicionada ao array `TABLES`):
  ```bash
  export BW_SESSION=$(bw unlock --raw)
  export PROD_USER=<seu-usuario-prod>
  scripts/sync-vendas-prod-to-dev.sh
  ```
  Validar:
  ```sql
  SELECT count(*), max(data_snapshot) FROM public.tbl_historico_cmc_estoque;
  ```

## Rodar local

```bash
pnpm install
pnpm --filter @atlas/api dev      # backend (apps/api)
pnpm --filter @atlas/web dev      # frontend (apps/web)
```
Garantir `MODULE_STOCKBRIDGE_ENABLED=true` no `.env`.

## Smoke test da API (logado como gestor/diretor)

```bash
# snapshot mais recente
curl -s --cookie "$COOKIE" http://localhost:3000/api/v1/stockbridge/cmc/snapshot | jq '.data.dataSnapshot, .data.resumo'

# filtrado por família + origem
curl -s --cookie "$COOKIE" "http://localhost:3000/api/v1/stockbridge/cmc/snapshot?familia=PP%20HOMO%2025&origem=NACIONAL" | jq '.data.familias[0]'

# tendência
curl -s --cookie "$COOKIE" "http://localhost:3000/api/v1/stockbridge/cmc/tendencia?familia=PP%20HOMO%2025" | jq '.data.series[0].pontos'

# operador deve receber 403
curl -s --cookie "$COOKIE_OPERADOR" http://localhost:3000/api/v1/stockbridge/cmc/snapshot | jq '.error.code'
```

## Validação manual na UI

1. Login como **gestor** → menu StockBridge tem **"Custos de Estoque"**. Login como **operador** → item **não** aparece e a rota redireciona.
2. Aba **Snapshot diário**: resumo global no topo (volume kg + valor R$, sem CMC global); lista de famílias recolhidas; clicar expande a árvore de produtos; soma dos produtos = total da família.
3. Filtros (família/produto multi-seleção, origem): lista e resumo recalculam; combo de produto respeita famílias selecionadas.
4. Aba **Tendência histórica**: gráfico da série; dia sem coleta aparece como lacuna.
5. Reconciliação: o CMC de uma família/origem bate com o Metabase (Dashboard 14) para a mesma data.

## Aceite (mapeado à spec)
- US1 → cenários 1–7 (snapshot + árvore + resumo + ponderação).
- US2 → cenários 1–2 (série + lacuna).
- US3 → cenários 1–4 (filtros + ordenação).
- FR-013 → operador 403; gestor/diretor ok.
- FR-005 → valores em kg/R$/kg sem conversão.
