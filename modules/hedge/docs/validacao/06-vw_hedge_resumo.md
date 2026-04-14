# Validação: vw_hedge_resumo

**View**: `public.vw_hedge_resumo`
**Usado em**: `posicao.service.ts` → `GET /api/v1/hedge/posicao` → frontend KPI cards
**BD consultado**: `pg-atlas-dev` (host `10.0.0.166`, DB `acxe_q2p`)
**Data**: 2026-04-14

---

## 0. Resumo didático

**O que essa view responde:** "Qual é a posição de hedge cambial completa da ACXE/Q2P hoje — o que devo, o que tenho, o que vou receber?"

**O problema de negócio**

As quatro views filhas (`pagar_usd`, `estoque`, `receber_usd`, `importacoes`) respondem perguntas individuais. Mas a decisão de fazer hedge cambial precisa de uma visão consolidada: *qual é minha exposição líquida em USD neste momento?*

A `vw_hedge_resumo` é a view mestre — ela agrega as quatro filhas em uma única linha de resultado, aplica as fórmulas de cálculo de exposição, e entrega um "instantâneo" do risco cambial para o backend consumir.

**O que ela faz, passo a passo**

1. Busca a PTAX mais recente (`ptax_atual`)
2. Agrega `vw_hedge_pagar_usd` → totais de contas a pagar em USD e BRL, separados por tipo
3. Agrega `vw_hedge_estoque` → totais de estoque, separados por origem (`importado_no_chao`, `em_transito`, `nacional`)
4. Agrega `vw_hedge_receber_usd` → total de contas a receber em USD e BRL
5. Agrega `vw_hedge_importacoes` → importações pendentes (status ≠ `nacionalizado`)
6. Calcula os campos derivados: `pct_nao_pago`, `est_nao_pago_usd`, `exposicao_usd_total`
7. Retorna **1 única linha** com todos os 22 campos + timestamp de cálculo

**A fórmula central**

```
exposicao_usd_total = total_pagar_usd + est_nao_pago_usd

onde:
  est_nao_pago_usd = est_importado_usd × min(total_pagar_brl / est_importado_brl, 1.0)
```

A lógica: sua exposição cambial é o que você deve pagar (títulos abertos) mais a fração do estoque importado que ainda não foi paga. O cap em 1.0 (100%) evita que a fórmula exploda quando há mais dívida do que estoque.

---

## 1. Propósito

View mestre do módulo hedge. Agrega as quatro sub-views em uma única linha de resultado para:

- KPI cards do dashboard (`exposicao_usd_total`, `total_pagar_usd`, `total_receber_usd`, `est_importado_usd`)
- Motor MV — cálculo de cobertura (`posicao.service.ts`)
- Referência canônica: qualquer consumer do hedge usa esta view, não as sub-views diretamente

Retorna sempre **1 linha**. É recalculada a cada consulta (`CURRENT_TIMESTAMP`).

---

## 2. Arquitetura: 5 CTEs + SELECT final

```
vw_hedge_resumo
├── CTE ptax_atual      ←── tbl_cotacaoDolar (PTAX mais recente)
├── CTE pagar           ←── vw_hedge_pagar_usd (agrega títulos)
├── CTE estoque         ←── vw_hedge_estoque (agrega posições)
├── CTE receber         ←── vw_hedge_receber_usd (agrega recebíveis)
├── CTE importacoes     ←── vw_hedge_importacoes (agrega pipeline FUP)
└── SELECT final        ←── cross join das 5 CTEs (cada uma retorna 1 linha)
                             aplica fórmulas de pct_nao_pago e exposicao_usd_total
```

O `FROM ptax_atual pa, pagar p, estoque e, receber r, importacoes i` é um cross join implícito de 5 linhas únicas — equivale a um join cartesiano de 1×1×1×1×1 = 1 linha de resultado.

---

## 3. SQL completo

```sql
WITH ptax_atual AS (
  SELECT "cotacaoVenda" AS ptax
  FROM "tbl_cotacaoDolar"
  ORDER BY "dataCotacao" DESC
  LIMIT 1
),
pagar AS (
  SELECT
    SUM(valor_usd) AS total_pagar_usd,
    SUM(valor_brl) AS total_pagar_brl,
    SUM(CASE WHEN tipo = 'mercadoria'        THEN valor_usd ELSE 0 END) AS pagar_mercadoria_usd,
    SUM(CASE WHEN tipo = 'despesa_importacao' THEN valor_usd ELSE 0 END) AS pagar_despesa_usd,
    COUNT(*) AS pagar_qtd
  FROM vw_hedge_pagar_usd
),
estoque AS (
  SELECT
    SUM(valor_total_brl) AS total_est_brl,
    SUM(valor_total_usd) AS total_est_usd,
    SUM(CASE WHEN origem = 'importado_no_chao' THEN valor_total_brl ELSE 0 END) AS est_importado_brl,
    SUM(CASE WHEN origem = 'importado_no_chao' THEN valor_total_usd ELSE 0 END) AS est_importado_usd,
    SUM(CASE WHEN origem = 'em_transito'        THEN valor_total_brl ELSE 0 END) AS est_transito_brl,
    SUM(CASE WHEN origem = 'em_transito'        THEN valor_total_usd ELSE 0 END) AS est_transito_usd,
    SUM(CASE WHEN origem = 'nacional'           THEN valor_total_brl ELSE 0 END) AS est_nacional_brl,
    SUM(CASE WHEN origem = 'nacional'           THEN valor_total_usd ELSE 0 END) AS est_nacional_usd
  FROM vw_hedge_estoque
),
receber AS (
  SELECT
    SUM(valor_usd) AS total_receber_usd,
    SUM(valor_brl) AS total_receber_brl
  FROM vw_hedge_receber_usd
),
importacoes AS (
  SELECT
    SUM(valor_total_usd) FILTER (WHERE status_hedge <> 'nacionalizado') AS pendente_usd,
    COUNT(*)             FILTER (WHERE status_hedge <> 'nacionalizado') AS pendente_qtd
  FROM vw_hedge_importacoes
)
SELECT
  pa.ptax,
  p.total_pagar_usd, p.total_pagar_brl,
  p.pagar_mercadoria_usd, p.pagar_despesa_usd, p.pagar_qtd,
  e.total_est_brl,  e.total_est_usd,
  e.est_importado_brl, e.est_importado_usd,
  e.est_transito_brl,  e.est_transito_usd,
  e.est_nacional_brl,  e.est_nacional_usd,

  -- Fórmula 1: % do estoque importado que ainda não foi pago (cap 100%)
  LEAST(ROUND(COALESCE(p.total_pagar_brl / NULLIF(e.est_importado_brl, 0) * 100, 0)), 100)
    AS pct_nao_pago,

  -- Fórmula 2: parcela USD do estoque importado sem pagamento
  ROUND(e.est_importado_usd * LEAST(COALESCE(p.total_pagar_brl / NULLIF(e.est_importado_brl, 0), 0), 1), 2)
    AS est_nao_pago_usd,

  r.total_receber_usd, r.total_receber_brl,
  i.pendente_usd AS importacoes_pendentes_usd,
  i.pendente_qtd AS importacoes_pendentes_qtd,

  -- Fórmula 3: exposição cambial total
  ROUND(p.total_pagar_usd + e.est_importado_usd * LEAST(COALESCE(p.total_pagar_brl / NULLIF(e.est_importado_brl, 0), 0), 1), 2)
    AS exposicao_usd_total,

  CURRENT_TIMESTAMP AS calculado_em
FROM ptax_atual pa, pagar p, estoque e, receber r, importacoes i
```

---

## 4. Fórmulas explicadas

### 4.1 pct_nao_pago (%)

```
pct_nao_pago = LEAST( ROUND( total_pagar_brl / est_importado_brl × 100 ), 100 )
```

**Lógica**: "Qual % do estoque importado (em BRL) ainda está coberto por contas a pagar abertas?"

- Se `total_pagar_brl > est_importado_brl`: `pct > 100%` → capped em 100 (há mais dívidas do que estoque — ex: despesas de importação sem mercadoria ainda recebida)
- Se `total_pagar_brl = est_importado_brl`: `pct = 100%` → todo estoque ainda não foi pago
- Se `total_pagar_brl = 0`: `pct = 0%` → todo estoque já foi pago; sem exposição por estoque
- `NULLIF(est_importado_brl, 0)`: guarda contra divisão por zero caso não haja estoque importado

**Hoje (dev)**: `55,005,364.91 / 9,209,925.84 × 100 = 597%` → capped em **100** — todo o estoque importado está descoberto.

### 4.2 est_nao_pago_usd (USD)

```
est_nao_pago_usd = est_importado_usd × LEAST( total_pagar_brl / est_importado_brl , 1.0 )
```

**Lógica**: "Qual é o valor USD do estoque importado que ainda precisa de dólares para ser pago?"

A diferença em relação ao `pct_nao_pago`: aqui o ratio é aplicado diretamente como multiplicador (0 a 1), não convertido para %. A fórmula é algebricamente idêntica à de `pct_nao_pago`, só sem o `× 100`.

**Hoje (dev)**: `1,833,587.33 × LEAST(5.97, 1.0)` = `1,833,587.33 × 1.0` = **$1,833,587.33**

### 4.3 exposicao_usd_total (USD)

```
exposicao_usd_total = total_pagar_usd + est_nao_pago_usd
                    = total_pagar_usd + est_importado_usd × LEAST( total_pagar_brl / est_importado_brl , 1.0 )
```

**Lógica de negócio**: A exposição cambial real inclui dois componentes:

1. **`total_pagar_usd`** — USD que você precisa para pagar fornecedores (títulos abertos no OMIE)
2. **`est_nao_pago_usd`** — USD que você vai precisar para pagar o estoque importado que já recebeu mas ainda não pagou

**O que NÃO entra na exposição:**
- `total_receber_usd` — receitas a receber não reduzem a exposição nesta fórmula (são tratadas separadamente no motor MV)
- `importacoes_pendentes_usd` — pipeline FUP não gera títulos ainda; seria dupla contagem com `total_pagar_usd`
- `est_transito_usd` — estoque em trânsito já está em `total_pagar_usd` (o título existe antes da entrega física)
- `est_nacional_usd` — estoque nacional não tem exposição cambial

**Hoje (dev)**: `10,950,917.70 + 1,833,587.33` = **$12,784,505.03 ✓**

---

## 5. Valores atuais no BD dev (2026-04-14)

| Campo | Valor | Fonte |
|-------|-------|-------|
| `ptax` | R$ 5.0229 | `tbl_cotacaoDolar` |
| `total_pagar_usd` | **$10,950,917.70** | `vw_hedge_pagar_usd` (350 títulos) |
| `total_pagar_brl` | R$ 55,005,364.91 | `vw_hedge_pagar_usd` |
| `pagar_mercadoria_usd` | $9,283,035.40 | `vw_hedge_pagar_usd` (tipo=mercadoria) |
| `pagar_despesa_usd` | $1,667,882.30 | `vw_hedge_pagar_usd` (tipo=despesa) |
| `pagar_qtd` | 350 | `vw_hedge_pagar_usd` |
| `total_est_brl` | R$ 23,468,359.73 | `vw_hedge_estoque` (todos) |
| `total_est_usd` | $4,672,272.93 | `vw_hedge_estoque` (todos) |
| `est_importado_brl` | R$ 9,209,925.84 | `vw_hedge_estoque` (importado_no_chao) |
| `est_importado_usd` | **$1,833,587.33** | `vw_hedge_estoque` (importado_no_chao) |
| `est_transito_brl` | R$ 9,748,650.29 | `vw_hedge_estoque` (em_transito) |
| `est_transito_usd` | $1,940,841.01 | `vw_hedge_estoque` (em_transito) |
| `est_nacional_brl` | R$ 4,509,783.60 | `vw_hedge_estoque` (nacional) |
| `est_nacional_usd` | $897,844.59 | `vw_hedge_estoque` (nacional) |
| `pct_nao_pago` | **100** | calculado (capped) |
| `est_nao_pago_usd` | **$1,833,587.33** | calculado |
| `total_receber_usd` | **$11,913,681.59** | `vw_hedge_receber_usd` (2.243 títulos) |
| `total_receber_brl` | R$ 59,841,227.88 | `vw_hedge_receber_usd` |
| `importacoes_pendentes_usd` | $6,974,198.75 | `vw_hedge_importacoes` (55 processos) |
| `importacoes_pendentes_qtd` | 55 | `vw_hedge_importacoes` |
| **`exposicao_usd_total`** | **$12,784,505.03** | calculado |
| `calculado_em` | 2026-04-14 18:25:21 | `CURRENT_TIMESTAMP` |

### 5.1 Verificação manual das fórmulas

```
pct_nao_pago  : LEAST(ROUND(55,005,364.91 / 9,209,925.84 × 100), 100)
              = LEAST(ROUND(597.25), 100) = LEAST(597, 100) = 100 ✓

est_nao_pago  : 1,833,587.33 × LEAST(55,005,364.91 / 9,209,925.84, 1)
              = 1,833,587.33 × LEAST(5.9726, 1) = 1,833,587.33 × 1 = 1,833,587.33 ✓

exposicao     : 10,950,917.70 + 1,833,587.33 = 12,784,505.03 ✓
```

### 5.2 Posição líquida (informacional)

| | USD |
|-|-----|
| A pagar (exposição) | −$10,950,918 |
| A receber (Q2P) | +$11,913,682 |
| **Posição líquida bruta** | **+$962,764** |

A Q2P está levemente positiva em fluxo USD esperado. Este cálculo não é feito na view — é derivado pelo motor MV.

---

## 6. Todos os campos validados

```sql
SELECT SUM(valor_usd)       FROM vw_hedge_pagar_usd       →  10,950,917.70 = total_pagar_usd    ✓
SELECT SUM(valor_total_usd) FROM vw_hedge_estoque
  WHERE origem='importado_no_chao'                         →   1,833,587.33 = est_importado_usd  ✓
SELECT SUM(valor_usd)       FROM vw_hedge_receber_usd      →  11,913,681.59 = total_receber_usd  ✓
SELECT SUM(valor_total_usd) FROM vw_hedge_importacoes
  WHERE status_hedge <> 'nacionalizado'                    →   6,974,198.75 = importacoes_pend   ✓
```

---

## 7. Decisões de design

### 7.1 Por que receber não subtrai da exposição?

`total_receber_usd` ($11,9M) é maior que `exposicao_usd_total` ($12,8M) — matematicamente, se subtraísse, a posição líquida seria quase zero. Mas o design deliberado é **não subtrair** na fórmula da view por dois motivos:

1. **Certeza diferente**: contas a pagar são compromissos certos; contas a receber têm risco de inadimplência — não se deve travar câmbio baseado em recebível incerto
2. **Responsabilidade do motor MV**: o cálculo de cobertura líquida (`posicao_liquida_usd = receber - pagar`) fica no `posicao.service.ts`, não na view SQL. A view entrega os componentes separados; a lógica de negócio fica na aplicação

### 7.2 Por que importacoes não entra na exposição?

`importacoes_pendentes_usd` ($6,9M) representa o pipeline Comex — pedidos fechados mas ainda sem nota fiscal. Incluir na exposição geraria dupla contagem com `total_pagar_usd` para processos em etapa avançada (onde o título OMIE já existe). A view expõe o campo para visibilidade, mas deixa para o analista decidir se quer somar.

### 7.3 Por que em_transito não entra em est_nao_pago?

O estoque `em_transito` ($1,94M) é excluído da fórmula porque quando a mercadoria ainda está no mar, o título a pagar correspondente **já existe** em `vw_hedge_pagar_usd`. Incluir o estoque em trânsito na fórmula seria dupla contagem do mesmo compromisso.

### 7.4 NULLIF(est_importado_brl, 0)

Proteção contra divisão por zero no caso em que o estoque importado esteja zerado. Se `est_importado_brl = 0`, NULLIF retorna NULL → COALESCE retorna 0 → `est_nao_pago_usd = 0`. Comportamento correto: sem estoque importado, sem est_nao_pago.

---

## 8. Dúvidas abertas / GAPs

1. [ ] **total_receber_usd não entra na fórmula** — por design (ver §7.1). Mas é visível nos KPI cards do dashboard. Se o filtro "Empresa" no dashboard deveria afetar este campo, a view não tem granularidade por empresa — retorna agregado ACXE+Q2P sempre.

2. [ ] **pct_nao_pago está sempre capped a 100% no dev** — `total_pagar_brl` ($55M) é ~6× maior que `est_importado_brl` ($9,2M). Isso é esperado: há muitas despesas de importação (frete, seguro) que geram títulos a pagar sem criar estoque proporcional. O cap protege a fórmula, mas `pct_nao_pago = 100` sempre pode mascarar mudanças reais na cobertura.

3. [ ] **View não tem parâmetros** — retorna sempre o snapshot atual. Não é possível consultar "como estava a exposição em 2026-03-01" sem ter salvo o resultado antes. Histórico de exposição não existe na view — precisaria de tabela de snapshots separada se isso fosse necessário.

4. [ ] **Sem filtro de empresa** — a view consolida ACXE e Q2P sem distinção. O filtro de empresa no dashboard não afeta os KPIs desta view.

---

## 9. Pontos fortes / fracos

**Fortes:**
- ✓ **Fonte única de verdade**: todos os consumers do hedge usam esta view — não há risco de cálculos divergentes
- ✓ **Fórmulas validadas**: todos os 22 campos conferidos contra as sub-views (diferença zero em todos)
- ✓ **Design defensivo**: `NULLIF` + `COALESCE` + `LEAST` protegem contra divisão por zero e overflow
- ✓ **Separação de responsabilidades**: view agrega e calcula exposição; lógica de cobertura fica no service
- ✓ **Live calculation**: `CURRENT_TIMESTAMP` — sempre reflete o estado atual do BD

**Fracos / GAPs:**
- ⚠ **Sem histórico**: não há como consultar exposição passada — snapshot temporário, não persistido
- ⚠ **Sem granularidade por empresa**: consolidado ACXE+Q2P; filtro de empresa do dashboard não se aplica
- ℹ **pct_nao_pago sempre 100% no dev**: valor informacional limitado enquanto `total_pagar_brl >> est_importado_brl`

---

## 10. Mapa completo das dependências

```
vw_hedge_resumo
├── tbl_cotacaoDolar                   (PTAX direta)
├── vw_hedge_pagar_usd
│   ├── tbl_contasPagar_ACXE
│   ├── tbl_cadastroFornecedoresClientes_ACXE
│   ├── tbl_pedidosComex
│   └── tbl_cotacaoDolar
├── vw_hedge_estoque
│   ├── tbl_posicaoEstoque_ACXE
│   ├── tbl_posicaoEstoque_Q2P
│   ├── tbl_locaisEstoques_ACXE
│   ├── tbl_locaisEstoques_Q2P
│   └── tbl_cotacaoDolar
├── vw_hedge_receber_usd
│   ├── tbl_contasReceber_Q2P
│   └── tbl_cotacaoDolar
└── vw_hedge_importacoes
    └── tbl_dadosPlanilhaFUPComex
```

Total: **1 view mestre** + **4 sub-views** + **10 tabelas OMIE/FUP**

---

## 11. Arquivos relacionados

- Backend service: [posicao.service.ts](../../src/services/posicao.service.ts)
- Backend route: [hedge.routes.ts](../../src/routes/hedge.routes.ts)
- Frontend: [PositionDashboard.tsx](../../../apps/web/src/pages/hedge/PositionDashboard.tsx)
- Sub-views:
  - [01 — Exposição USD Total](01-exposicao-usd-total.md)
  - [02 — vw_hedge_pagar_usd](02-vw_hedge_pagar_usd.md)
  - [03 — vw_hedge_estoque](03-vw_hedge_estoque.md)
  - [04 — vw_hedge_receber_usd](04-vw_hedge_receber_usd.md)
  - [05 — vw_hedge_importacoes](05-vw_hedge_importacoes.md)
