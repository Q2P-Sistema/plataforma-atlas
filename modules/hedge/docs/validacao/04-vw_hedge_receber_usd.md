# Validação: vw_hedge_receber_usd

**View**: `public.vw_hedge_receber_usd`
**Usado em**: `vw_hedge_resumo` (componente `total_receber_usd`)
**BD consultado**: `pg-atlas-dev` (host `10.0.0.166`, DB `acxe_q2p`)
**Data**: 2026-04-14

---

## 0. Resumo didático

**O que essa view responde:** "Quanto a Q2P tem a receber de clientes, expresso em USD?"

**O problema de negócio**

O hedge cambial não olha só para o que vai sair (pagar fornecedores em USD) — olha também para o que vai entrar. A Q2P vende para clientes brasileiros em BRL, mas esse recebimento é a fonte de caixa que vai financiar os pagamentos em dólar. A view converte esse fluxo de entrada para USD para permitir a comparação direta: "tenho $X a pagar e $Y a receber — qual é minha posição líquida?"

**Por que só Q2P e não ACXE?**

A ACXE importa e vende para a Q2P (operação intercompany). A Q2P vende para os clientes finais. O fluxo de receita que chega ao grupo vem da Q2P — é ela que tem as duplicatas de clientes externos. As contas a receber da ACXE são majoritariamente intercompany (Q2P deve para ACXE), então incluí-las geraria dupla contagem.

**O que a view faz**

1. Pega as contas a receber em aberto da Q2P (`tbl_contasReceber_Q2P`)
2. Filtra só títulos ativos (`A VENCER`, `ATRASADO`, `VENCE HOJE`)
3. Aplica janela de 90 dias para trás (`data_vencimento >= hoje - 90d`) — captura atrasados recentes sem puxar histórico longo
4. Converte para USD usando PTAX atual
5. Gera `bucket_mes` para o gráfico mensal

---

## 1. Propósito

Representa o fluxo de entrada esperado (receitas a receber Q2P) convertido para USD. Serve como contrapartida ao `total_pagar_usd` no cálculo da posição de hedge:

```
posicao_liquida_usd = total_receber_usd - total_pagar_usd
```

---

## 2. Tabelas fonte

| Tabela OMIE | Papel |
|-------------|-------|
| `tbl_contasReceber_Q2P` | Duplicatas a receber de clientes (Q2P) |
| `tbl_cotacaoDolar` | PTAX atual para conversão USD |

**Tabelas existentes mas não usadas:**
- `tbl_contasReceber_ACXE` — contas a receber ACXE (intercompany, excluída intencionalmente)
- `tbl_contasReceber_Q2P_Filial` — filial Q2P (não inclusa — verificar se relevante)

---

## 3. Lógica SQL

```sql
WITH ptax_atual AS (
  SELECT cotacaoVenda AS ptax
  FROM tbl_cotacaoDolar
  ORDER BY dataCotacao DESC LIMIT 1
)
SELECT
  codigo_lancamento_omie AS omie_id,
  data_vencimento,
  valor_documento AS valor_brl,
  ROUND(valor_documento / ptax, 2) AS valor_usd,
  status_titulo,
  ptax AS ptax_ref,
  to_char(data_vencimento, 'Mon/YY') AS bucket_mes
FROM tbl_contasReceber_Q2P
  CROSS JOIN ptax_atual
WHERE status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE')
  AND data_vencimento >= CURRENT_DATE - INTERVAL '90 days'
```

### 3.1 Filtros aplicados

| Filtro | Razão |
|--------|-------|
| `status_titulo IN (...)` | Só títulos em aberto |
| `data_vencimento >= hoje - 90d` | Captura atrasados recentes; evita histórico infinito de inadimplência |

### 3.2 O que esta view NÃO filtra (diferente de pagar_usd)

| Ausente | Impacto |
|---------|---------|
| Sem filtro de cliente exterior | Inclui todos os clientes Q2P (domésticos) — correto, pois o recebimento é em BRL mesmo |
| Sem filtro de categoria | Captura todas as receitas Q2P, não só as ligadas a importações |
| Sem matching com pedidos | Mais simples — não há vínculo com FUP Comex pelo lado do recebível |

---

## 4. Valores atuais no BD dev (2026-04-14)

### 4.1 Agregado total

| Métrica | Valor |
|---------|-------|
| Total títulos | **2.243** |
| Total BRL | R$ 59.841.227,88 |
| Total USD | **$11.913.681,59** |
| Vencimento mais antigo | 2026-02-11 |
| Vencimento mais recente | 2026-07-02 |
| PTAX usada | R$ 5.0229 |

### 4.2 Por status

| Status | Qtd | Total USD |
|--------|-----|-----------|
| A VENCER | 2.224 | $11.658.166,93 |
| ATRASADO | 19 | $255.514,66 |

**Obs:** 12 títulos de Fev e Mar/26 ainda visíveis por causa da janela de 90 dias — são os ATRASADO mais antigos capturados.

### 4.3 Por bucket mensal

| Bucket | Qtd | USD |
|--------|-----|-----|
| Feb/26 | 5 | $16.596 |
| Mar/26 | 7 | $38.997 |
| Apr/26 | 1.181 | $5.750.097 |
| May/26 | 921 | $5.174.206 |
| Jun/26 | 127 | $915.885 |
| Jul/26 | 2 | $17.901 |

### 4.4 Validação contra vw_hedge_resumo

```sql
SELECT SUM(valor_usd) FROM vw_hedge_receber_usd  →  11.913.681,59
SELECT total_receber_usd FROM vw_hedge_resumo     →  11.913.681,59
Diferença: 0,00 ✓
```

---

## 5. Posição líquida

Com os dados do dev (2026-04-14):

| | USD |
|-|-----|
| A receber (Q2P) | +$11.913.682 |
| A pagar (ACXE exterior) | -$10.950.918 |
| **Posição líquida bruta** | **+$962.764** |

A Q2P está levemente positiva em termos de fluxo USD esperado. Isso muda conforme o câmbio (ambos os lados são recalculados pela PTAX atual).

---

## 6. Dúvidas abertas / GAPs

1. [X] **Q2P Filial ausente** — **AÇÃO PENDENTE**: adicionar `tbl_contasReceber_Q2P_Filial` à view. Os recebíveis da filial devem entrar no cálculo. Requer `UNION ALL` com a filial na view SQL.

2. [X] **Janela de 90 dias** — **RESOLVIDO**: escolha deliberada. O horizonte máximo de decisão de hedge é 90 dias — não faz sentido considerar recebíveis além desse prazo para travar câmbio. O filtro tem dupla função: (a) exclui inadimplência com mais de 90 dias (considera irrecuperável), (b) alinha com o horizonte operacional de hedge.

3. [ ] **Sem filtro de cliente exterior** — a view inclui todos os recebíveis Q2P independente do cliente ser nacional ou internacional. Como a Q2P vende em BRL, isso é correto. Mas se a Q2P tiver alguma venda em USD (exportação direta), não há tratamento específico.

4. [ ] **Sem filtro de categoria** — a view pega todos os recebíveis Q2P, incluindo eventuais recebíveis financeiros, juros, etc. A `vw_hedge_pagar_usd` filtra por categoria (`2.01.*`, `2.10.*`); o lado do recebível não tem filtro equivalente.

---

## 7. Pontos fortes / fracos

**Fortes:**
- ✓ **Precisão**: bate exato com `vw_hedge_resumo` ($11.913.681,59)
- ✓ **Design simples**: sem CTEs complexas, sem matching — leitura direta
- ✓ **Janela temporal**: evita inflar o recebível com inadimplência histórica irrecuperável
- ✓ **Escopo Q2P correto**: ACXE receivables são intercompany, excluir evita dupla contagem

**Fracos / GAPs:**
- ⚠ **Q2P Filial não inclusa**: deve entrar — requer UNION ALL com `tbl_contasReceber_Q2P_Filial` na view
- ⚠ **Sem filtro de categoria**: pode incluir recebíveis não operacionais no total

---

## 8. Arquivos relacionados

- View parent: `public.vw_hedge_resumo` (doc [01](01-exposicao-usd-total.md))
- Contraparte pagar: `vw_hedge_pagar_usd` (doc [02](02-vw_hedge_pagar_usd.md))
- Próxima view: `vw_hedge_importacoes` (doc [05](05-vw_hedge_importacoes.md))
- Consumidor backend: [posicao.service.ts](../../src/services/posicao.service.ts)
