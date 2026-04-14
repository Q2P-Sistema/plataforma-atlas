# Validação: Exposição USD Total (ACXE)

**Módulo**: Hedge Engine
**Tela**: Dashboard (`/hedge`)
**Campo**: KPI "Exposição USD Total" badge ACXE
**Data da investigação**: 2026-04-13
**Status**: Em validação

---

## 1. Onde aparece

Frontend: [apps/web/src/pages/hedge/PositionDashboard.tsx:187](../../../apps/web/src/pages/hedge/PositionDashboard.tsx#L187)

```tsx
<KpiCard label="Exposicao USD Total" 
  value={fmtM(kpis.exposicao_usd_total)} 
  color="#0077cc" src="acxe" 
  sub="Titulos a pagar em aberto" />
```

Observação: o label "ACXE" é o `src="acxe"` (origem do dado), não um filtro. O número é **agregado ACXE + Q2P** sempre, independente do filtro de empresa.

---

## 2. Pipeline de dados (cima → baixo)

```
Frontend KpiCard
  └─ kpis.exposicao_usd_total
       └─ GET /api/v1/hedge/posicao
            └─ posicao.service.ts :: calcularPosicao()
                 └─ getResumoVPS()
                      └─ SELECT * FROM public.vw_hedge_resumo
                           └─ exposicao_usd_total (campo calculado na view)
```

### 2.1 Backend — posicao.service.ts

[modules/hedge/src/services/posicao.service.ts:49-78](../../src/services/posicao.service.ts#L49)

```ts
async function getResumoVPS(): Promise<ResumoVPS> {
  const pool = getPool();
  const { rows } = await pool.query('SELECT * FROM public.vw_hedge_resumo LIMIT 1');
  // ... mapeia campos
  return { exposicao_usd_total: Number(r.exposicao_usd_total ?? 0), ... };
}
```

O backend **não calcula** esse número — apenas lê da view SQL e retorna.

### 2.2 Route — hedge.routes.ts

[modules/hedge/src/routes/hedge.routes.ts:52-61](../../src/routes/hedge.routes.ts#L52)

```ts
sendSuccess(res, {
  kpis: {
    exposure_usd: result.kpis.exposure_usd,
    // ...
    ...result.kpis.resumo,  // ← spread inclui exposicao_usd_total
  },
  // ...
});
```

O campo `exposicao_usd_total` vem do `...result.kpis.resumo` (spread do resumo VPS), **não** do `exposure_usd` que é calculado separadamente (soma dos buckets).

**⚠️ Atenção**: existem 2 conceitos de "exposição" no sistema:
- `exposure_usd` = soma de `pagar_usd` dos buckets mensais + est_nao_pago distribuído
- `exposicao_usd_total` = `total_pagar_usd + est_nao_pago_usd` direto da view

Esta tela usa `exposicao_usd_total` (da view), não `exposure_usd` (dos buckets).

---

## 3. Fórmula de cálculo (SQL view)

Fonte: `public.vw_hedge_resumo` — definida no BD VPS.

### 3.1 Fórmula exata

```sql
exposicao_usd_total = round(
  total_pagar_usd 
  + est_importado_usd * LEAST(
      COALESCE(total_pagar_brl / NULLIF(est_importado_brl, 0), 0), 
      1
    ),
  2
)
```

Em linguagem natural:
```
exposicao_usd_total = total_pagar_usd + est_nao_pago_usd

onde:
  est_nao_pago_usd = est_importado_usd × pct_nao_pago_cap
  pct_nao_pago_cap = min(total_pagar_brl / est_importado_brl, 1.0)
```

### 3.2 Componentes

| Variável | Origem | Descrição |
|----------|--------|-----------|
| `total_pagar_usd` | `vw_hedge_pagar_usd` (SUM valor_usd) | Títulos a pagar em USD (exterior=S, status A VENCER/ATRASADO/VENCE HOJE) |
| `total_pagar_brl` | `vw_hedge_pagar_usd` (SUM valor_brl) | Mesmos títulos convertidos para BRL |
| `est_importado_usd` | `vw_hedge_estoque` (origem='importado_no_chao') | Estoque importado fisicamente na ACXE em USD |
| `est_importado_brl` | `vw_hedge_estoque` (origem='importado_no_chao') | Estoque importado em BRL |
| `pct_nao_pago_cap` | calculado | % do estoque importado que ainda não foi pago (capped 100%) |
| `est_nao_pago_usd` | calculado | Parcela USD do estoque importado que está sem pagamento |

### 3.3 Lógica de negócio

**Por que somar estoque não pago?** Em comércio exterior, quando você recebe uma mercadoria, ela entra no estoque **antes** de você pagar ao fornecedor. A exposição cambial real inclui:

1. Contas a pagar USD que estão abertas (você vai precisar de USD para pagar)
2. Estoque já recebido mas ainda **não pago** (você também vai precisar de USD)

Se já pagou 100% do estoque importado (`pct_nao_pago = 0`), a exposição é só `total_pagar_usd`.
Se há estoque importado totalmente não pago (`pct_nao_pago = 100`), a exposição é `total_pagar_usd + est_importado_usd`.

O cap em 100% evita que a fórmula exploda quando você tem mais contas a pagar que estoque (situação possível se há despesas de importação sem mercadoria ainda recebida).

---

## 4. Valores atuais no BD (2026-04-13)

**IMPORTANTE**: O Atlas em `atlas.q2p.com.br` aponta para o BD **dev** (`10.0.0.166`), não para prod (`10.0.0.143`). Os dois BDs tem valores diferentes.

### 4.1 BD de dev (fonte do Atlas)

**BD**: `acxe_q2p` em `10.0.0.166` (dev, user `postgres`) — é o que a aplicação está usando.

| Campo | Valor |
|-------|-------|
| `ptax` | R$ 5.0229 |
| `total_pagar_usd` | $10,950,917.70 |
| `total_pagar_brl` | R$ 55,005,364.91 |
| `est_importado_brl` | R$ 9,209,925.84 |
| `est_importado_usd` | $1,833,587.33 |
| `pct_nao_pago` | 100 (capped) |
| `est_nao_pago_usd` | $1,833,587.33 |
| **`exposicao_usd_total`** | **$12,784,505.03** ← bate com a tela ($12.78M) |

**Verificação manual**:
```
pct_nao_pago_cap = min(55,005,364.91 / 9,209,925.84, 1.0) = 1.0 (capped)
est_nao_pago_usd = 1,833,587.33 × 1.0 = 1,833,587.33 ✓
exposicao_usd_total = 10,950,917.70 + 1,833,587.33 = 12,784,505.03 ✓
```

### 4.2 BD de prod (referência)

**BD**: `acxe_q2p` em `10.0.0.143` (prod, user `claude_ro` read-only) — NÃO é o que o Atlas usa atualmente.

| Campo | Valor |
|-------|-------|
| `ptax` | R$ 5.0244 |
| `total_pagar_usd` | $12,200,430.52 |
| `est_importado_usd` | $1,956,220.99 |
| **`exposicao_usd_total`** | **$14,156,651.51** |

### 4.3 Divergência dev vs prod

Diferença de ~$1.4M entre dev e prod. Isso é esperado: o BD dev é uma cópia sanitizada/defasada do prod. O sync OMIE (n8n hourly) roda em ambos separadamente, mas não necessariamente no mesmo instante.

**Ponto a validar com Flavio**: o Atlas deve continuar apontando para dev durante a validação paralela (Princípio V). Quando for para prod, apontará para `10.0.0.143`.

---

## 5. Validação da divergência — RESOLVIDA

**Tela**: $12.78M
**BD dev** (fonte do Atlas): $12.78M ✓
**BD prod** (consulta inicial, erroneamente assumida como fonte): $14.16M

**Causa real**: o Atlas aponta para dev, não prod. A divergência inicial foi um erro de investigação — queriei prod sem confirmar qual BD a aplicação usa. Após consultar dev, o valor bate exatamente com a tela.

**Lição**: sempre confirmar qual BD a aplicação está consumindo antes de comparar valores.

---

## 6. Reprodução manual

Para reproduzir este número diretamente:

```sql
-- 1. Consultar o resumo atual
SELECT exposicao_usd_total FROM public.vw_hedge_resumo;

-- 2. Decompor os componentes
SELECT 
  total_pagar_usd,
  est_importado_usd,
  pct_nao_pago,
  est_nao_pago_usd,
  total_pagar_usd + est_nao_pago_usd AS exposicao_recalculada
FROM public.vw_hedge_resumo;

-- 3. Verificar fonte dos títulos a pagar
SELECT 
  COUNT(*) AS qtd_titulos,
  SUM(valor_usd) AS total_pagar_usd,
  SUM(valor_brl) AS total_pagar_brl
FROM public.vw_hedge_pagar_usd;

-- 4. Verificar fonte do estoque importado
SELECT 
  origem,
  SUM(valor_total_brl) AS valor_brl,
  SUM(valor_total_usd) AS valor_usd,
  COUNT(*) AS itens
FROM public.vw_hedge_estoque
WHERE origem = 'importado_no_chao'
GROUP BY origem;
```

---

## 7. Dúvidas

1. [X] ~~A tela mostra $12.78M mas BD tem $14.16M. É cache?~~ **Resolvido**: Atlas aponta para BD dev (10.0.0.166), valor bate. BD prod (10.0.0.143) tem valores diferentes pois é outra instância.
2. [ ] O filtro "Empresa" (ACXE/Q2P) no topo do dashboard **não afeta** este KPI — deveria? O campo `exposicao_usd_total` da view agrega ambas as empresas.
3. [ ] A view usa PTAX atual (`cotacaoVenda` mais recente) para converter `valor_documento` → `valor_usd`. Isso significa que valores em USD mudam conforme câmbio, mesmo sem alteração de títulos. Isso é desejável?
4. [ ] O estoque importado inclui 5 locais ACXE (validados em 2026-04-13). Se um local novo for criado no OMIE, a view **não inclui automaticamente**. Quem monitora isso?

---

## 8. Arquivos relevantes

- Frontend: [apps/web/src/pages/hedge/PositionDashboard.tsx](../../../apps/web/src/pages/hedge/PositionDashboard.tsx)
- Backend service: [modules/hedge/src/services/posicao.service.ts](../../src/services/posicao.service.ts)
- Backend route: [modules/hedge/src/routes/hedge.routes.ts](../../src/routes/hedge.routes.ts)
- View SQL: `public.vw_hedge_resumo` (no BD VPS, não versionada no repo)
- Gap analysis: [docs/gap-analysis-hedge-legacy-vs-atlas.md](../../../../docs/gap-analysis-hedge-legacy-vs-atlas.md) seção "Validação de Views SQL"
