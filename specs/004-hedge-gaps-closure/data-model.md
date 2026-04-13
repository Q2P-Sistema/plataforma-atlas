# Data Model: Hedge Gaps Closure

**Feature**: 004-hedge-gaps-closure
**Date**: 2026-04-13

---

## Entities Modified

### bucket_mensal (existing — schema `hedge`)

Nenhum campo novo adicionado ao schema Drizzle. O valor de `est_nao_pago_usd` e calculado em runtime e somado ao `pagar_usd` no service, nao persistido no bucket. Isso mantém a tabela como reflexo direto da view OMIE, e o enriquecimento acontece na camada de calculo.

**Campos existentes relevantes**:
- `id` (UUID PK)
- `mes_ref` (varchar — "YYYY-MM-01")
- `empresa` (varchar — "acxe" | "q2p")
- `pagar_usd` (numeric — contas a pagar em USD do mes)
- `ndf_usd` (numeric — NDFs ativos cobrindo este mes)
- `cobertura_pct` (numeric — ndf_usd/pagar_usd*100)
- `status` (varchar — "ok" | "sub_hedged" | "over_hedged")

**Calculo em runtime**: `exposicao_bucket = pagar_usd + (est_nao_pago_usd * pagar_usd / total_pagar_usd)`

### config_motor (existing — schema `hedge`)

5 novas chaves adicionadas via migration seed. Schema Drizzle nao muda (chave/valor generico).

| Chave | Valor Default | Tipo | Descricao |
|-------|--------------|------|-----------|
| `desvio_padrao_brl` | 3.76 | number | Desvio padrao mensal BRL/USD (pp) |
| `custo_financiamento_pct` | 5.5 | number | Custo de financiamento anual (% a.a.) |
| `prazo_recebimento` | 38 | number | Prazo medio de recebimento (dias) |
| `transit_medio_dias` | 80 | number | Tempo medio de transito maritimo (dias) |
| `giro_estoque_dias` | 30 | number | Giro medio de estoque importado (dias) |

## New Entities

### Cache (ephemeral — Redis)

Nao e uma entidade persistida. Armazenamento temporario em Redis com TTL.

| Key Pattern | TTL | Conteudo |
|-------------|-----|----------|
| `atlas:hedge:posicao:{empresa}` | 300s | JSON serializado de PosicaoResult |
| `atlas:hedge:estoque:{empresa}` | 3600s | JSON serializado de EstoqueAgregado[] |
| `atlas:hedge:localidades` | 3600s | JSON serializado de LocalidadeInfo[] |

**Invalidacao**: Chamada explicita a `invalidate('atlas:hedge:posicao:*')` nas rotas de mutacao.

## Views SQL (nenhuma modificacao)

- `vw_hedge_resumo` — ja retorna `est_nao_pago_usd`. Validada em 2026-04-13.
- `vw_hedge_pagar_usd` — sem alteracao.
- `vw_hedge_estoque` — sem alteracao.
