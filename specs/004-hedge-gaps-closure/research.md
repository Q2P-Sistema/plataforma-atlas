# Research: Hedge Gaps Closure

**Feature**: 004-hedge-gaps-closure
**Date**: 2026-04-13

---

## R1: Distribuicao de estoque nao pago nos buckets (GAP-01)

**Decision**: Distribuir `est_nao_pago_usd` proporcionalmente ao `pagar_usd` de cada bucket. Buckets com pagar_usd=0 nao recebem parcela.

**Rationale**: O legado usa distribuicao proporcional (`estNaoPagoUSD * (bucket.pagarUsd / totalPagarUsd)`). E a unica abordagem que faz sentido economicamente — meses com mais exposicao recebem mais estoque nao pago. Distribuicao igual (flat) penalizaria meses pequenos.

**Alternatives considered**:
- Distribuicao flat (igual para todos os buckets): Rejeitada — nao reflete a exposicao real por mes.
- Ignorar (manter como esta): Rejeitada — subestima exposicao e gera recomendacoes de hedge insuficientes.

---

## R2: Estrategia de cache Redis (GAP-10)

**Decision**: Criar `cache.service.ts` com wrapper generico `cached<T>(key, ttl, fetchFn)` que tenta Redis primeiro e faz fallback para `fetchFn` se indisponivel. TTLs: posicao 300s (5min), estoque 3600s (1h), localidades 3600s (1h). Invalidacao explicita via `invalidate(pattern)` chamada nas rotas de mutacao (NDF create/ativar/liquidar/cancelar, recalcular buckets).

**Rationale**: O pattern `cache-aside` e o mais simples e adequado para o volume do Atlas (5 usuarios). PTAX ja usa esse pattern no `@atlas/integration-bcb`. Reutilizar `getRedis()` de `@atlas/core`.

**Alternatives considered**:
- Cache em memoria (Map): Rejeitado — nao sobrevive restart, nao compartilha entre workers.
- Cache na response HTTP (Cache-Control): Rejeitado — nao controla invalidacao granular.
- Sem cache: Rejeitado — dashboard demora 2-5s por query ao BD VPS.

---

## R3: Parametros operacionais extras (GAP-14)

**Decision**: Criar migration com seeds para 5 parametros novos em `hedge.config_motor`. Os parametros sao informativos nesta fase — o backend le e retorna, mas nao os usa em calculos alem de `camada1_*` e `threshold_*` que ja funcionam. Uso em calculos acessorios sera avaliado caso a caso em features futuras.

**Rationale**: O frontend ja exibe esses parametros na Config Page. Sem seeds, os valores apareciam como vazios ou undefined. Adicionar os seeds corrige a UX sem risco de quebrar calculos.

**Alternatives considered**:
- Remover os campos do frontend: Rejeitado — o usuario espera poder configurar.
- Usar em calculos imediatamente: Rejeitado — os calculos acessorios do legado que usavam esses params (desvio_padrao no calculo de VaR, custo_financiamento no calculo de carry) nao foram migrados e nao ha spec para eles.

---

## R4: Graficos Motor MV com dados reais (GAP-F6)

**Decision**: O MotorMVPage ja recebe `recomendacoes[]` com `taxa_ndf`, `custo_ndf_brl`, `notional_sugerido` do backend. Os graficos "Custo vs Protecao" e "Simulacao Margem" devem usar esses dados em vez de calculos locais com `spotRate` e `ndf90Rate` dos sliders.

**Rationale**: Dados do backend sao calculados com Decimal.js e taxas NDF reais do banco. Calculos locais usam aproximacoes (spotRate * %). A migracao e simples: substituir formulas locais por dados do `data.recomendacoes` ja disponivel no state.

**Alternatives considered**:
- Manter calculos locais: Rejeitado — inconsistencia entre tabela (dados reais) e graficos (aproximativos).
- Criar endpoint separado para graficos: Rejeitado — overhead desnecessario, os dados ja estao na resposta do motor.
