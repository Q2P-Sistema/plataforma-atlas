# Validação: vw_hedge_pagar_usd

**View**: `public.vw_hedge_pagar_usd`
**Usado em**: `vw_hedge_resumo` (componente `total_pagar_usd` e `total_pagar_brl`)
**BD consultado**: `pg-atlas-dev` (host `10.0.0.166`, DB `acxe_q2p`)
**Data**: 2026-04-13

---

## 0. Resumo didático

**O que essa view responde:** "Quanto a ACXE deve pagar em dólares para fornecedores no exterior?"

**O problema de negócio**

A ACXE importa matéria-prima. Quando fecha uma compra com um fornecedor lá fora, o OMIE registra a conta a pagar **em BRL** (porque o sistema é brasileiro). Mas o dinheiro que vai sair do caixa para pagar é **em dólar** — então a empresa precisa saber: *qual é minha exposição em USD hoje?*

**O que a view faz, passo a passo**

1. **Pega as contas a pagar em aberto** do OMIE (`tbl_contasPagar_ACXE`) — só as que ainda não foram pagas (`A VENCER`, `ATRASADO`, `VENCE HOJE`)
2. **Filtra só fornecedores do exterior** (`exterior = 'S'`) — descarta tudo que é fornecedor nacional, porque esses são pagos em BRL e não geram exposição cambial
3. **Filtra só categorias de importação** — só contas classificadas como mercadoria (`2.01.*`) ou despesa de importação (`2.10.*`). Ignora outras contas a pagar que um fornecedor exterior poderia ter
4. **Converte para USD** dividindo o valor BRL pela PTAX do dia — `valor_usd = valor_brl / ptax_atual`
5. **Tenta vincular ao pedido Comex** — para cada conta a pagar, tenta achar o pedido de importação que originou aquela cobrança, fazendo matching por (fornecedor + data de vencimento + valor exato)

**O que sai dela**

Uma linha por título a pagar, com:
- Quem é o fornecedor, quando vence, quanto vale em BRL e em USD
- Qual categoria (mercadoria ou despesa de importação)
- Em qual mês vence (`bucket_mes` — para o gráfico de barras do dashboard)
- Qual pedido Comex gerou aquela compra (se encontrar)

**Onde isso aparece na tela**

```
vw_hedge_pagar_usd
  └─ SUM(valor_usd) = $10,95M  ←── "Contas a Pagar USD" no dashboard
  └─ agrupado por bucket_mes   ←── barras mensais do gráfico
  └─ alimenta vw_hedge_resumo  ←── que calcula a "Exposição USD Total"
```

**A limitação central**

O OMIE registra tudo em BRL. A view não sabe o dólar original do contrato — ela *estima* usando a PTAX de hoje. Se o dólar subiu desde que a compra foi fechada, o `valor_usd` aumenta sem que nenhum título tenha mudado. É uma fotografia cambial do momento, não o valor travado do contrato.

---

## 1. Propósito

Retorna todos os títulos a pagar em aberto **em moeda estrangeira** (com fornecedor exterior) das empresas ACXE, convertidos para USD pela PTAX atual. Serve como base para:
- KPI "Exposição USD Total" (exposição cambial)
- Tabela de buckets mensais no dashboard
- Motor MV (cálculo de cobertura por bucket)

---

## 2. Tabelas fonte

| Tabela OMIE | Papel |
|-------------|-------|
| `tbl_contasPagar_ACXE` | Títulos a pagar da ACXE |
| `tbl_cadastroFornecedoresClientes_ACXE` | Cadastro de fornecedores (filtro `exterior='S'`) |
| `tbl_pedidosComex` | Pedidos comex com até 9 parcelas (matching opcional) |
| `tbl_cotacaoDolar` | PTAX atual (mais recente) para conversão USD |

---

## 3. Lógica SQL (simplificada)

```sql
FROM tbl_contasPagar_ACXE cp
  JOIN tbl_cadastroFornecedoresClientes_ACXE fc ON fc.codigo_cliente_omie = cp.codigo_cliente_fornecedor
  CROSS JOIN ptax_atual pa
  LEFT JOIN match_pedido mp ON (cp.codigo_lancamento_omie = mp.codigo_lancamento_omie)
  LEFT JOIN categorias cat ON cat.cod = cp.codigo_categoria
WHERE cp.status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE')
  AND fc.exterior = 'S'
  AND (cp.codigo_categoria LIKE '2.01.%' OR cp.codigo_categoria LIKE '2.10.%')
```

### 3.1 Filtros aplicados

| Filtro | Razão |
|--------|-------|
| `status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE')` | Só títulos em aberto (exclui pagos, cancelados) |
| `fc.exterior = 'S'` | Só fornecedores internacionais (exposição cambial) |
| `codigo_categoria LIKE '2.01.%'` | Categorias de mercadoria (2.01.01 até 2.01.97) |
| `codigo_categoria LIKE '2.10.%'` | Categorias de despesa de importação (2.10.86 até 2.10.99) |

### 3.2 Campos calculados

- **`valor_usd`** = `round(valor_documento / ptax_atual, 2)` — usa PTAX mais recente (não PTAX do registro histórico)
- **`tipo`** = `'mercadoria'` se `2.01.%`, `'despesa_importacao'` se `2.10.%`, senão NULL
- **`bucket_mes`** = `to_char(data_vencimento, 'Mon/YY')` — agrupamento mensal em português
- **`pedido_comex`** = vínculo opcional via match de parcelas (CTE `parcelas_comex` + `match_pedido`)

### 3.3 Matching com pedidos Comex

A CTE `parcelas_comex` faz **UNION de 9 parcelas** (parcelas1_* até parcelas9_*) em `tbl_pedidosComex`.

Match em `match_pedido`:
```sql
JOIN parcelas_comex pc ON 
    pc.ncodfor = cp.codigo_cliente_fornecedor 
  AND pc.dvencto = cp.data_vencimento 
  AND pc.nvalor = cp.valor_documento
```

Match triplo: fornecedor + data vencimento + valor exato. Usa `row_number() OVER` para pegar só a 1ª parcela que dá match (se houver múltiplas).

**Limitação**: Pedidos Comex com mais de 9 parcelas não são cobertos.

### 3.4 Categorias hardcoded — GAP IDENTIFICADO

A CTE `categorias` define 26 descrições fixas na view:
- 12 categorias de mercadoria (`2.01.01` a `2.01.97`)
- 14 categorias de despesa (`2.10.86` a `2.10.99`)

**Problema confirmado (2026-04-14):** A tabela `public."tbl_categorias_ACXE"` já existe no BD e é sincronizada do OMIE. Ela contém **14 categorias em 2.01.\*** — 2 a mais que o hardcode atual:

| Código | Descrição | Status no hardcode |
|--------|-----------|-------------------|
| 2.01.98 | Compra de Material para Uso e Consumo | **AUSENTE** |
| 2.01.99 | Compra de Material para Embalagem | **AUSENTE** |

Títulos com `codigo_categoria IN ('2.01.98', '2.01.99')` exibem o código como descrição (fallback ativado) na view atual.

**Recomendação**: substituir a CTE `categorias` por um `LEFT JOIN` direto:

```sql
-- Antes (hardcoded CTE):
WITH categorias AS (
  SELECT '2.01.01' AS cod, 'Compras de Mercadorias para Revenda' AS descr
  UNION ALL ...  -- 26 linhas manuais
)

-- Depois (JOIN à tabela OMIE):
LEFT JOIN public."tbl_categorias_ACXE" cat 
  ON cat.codigo = cp.codigo_categoria
-- usar cat.descricao em vez de cat.descr
```

Benefício: auto-atualizado quando o OMIE criar novas categorias. Nenhuma mudança de lógica necessária.

---

## 4. Valores atuais no BD dev (2026-04-13)

### 4.1 Agregado total

| Métrica | Valor |
|---------|-------|
| Total títulos | **350** |
| Total BRL | R$ 55,005,364.91 |
| Total USD | **$10,950,917.70** |
| Vencimento mais antigo | 2026-04-10 |
| Vencimento mais recente | 2026-08-09 |
| PTAX usada | R$ 5.0229 |
| Fornecedores distintos | 20 |

### 4.2 Por tipo

| Tipo | Qtd | BRL | USD |
|------|-----|-----|-----|
| mercadoria | 138 | R$ 46,627,757.68 | $9,283,035.40 |
| despesa_importacao | 212 | R$ 8,377,607.23 | $1,667,882.30 |

### 4.3 Por status

| Status | Qtd | Total USD |
|--------|-----|-----------|
| A VENCER | 350 | $10,950,917.70 |
| ATRASADO | 0 | $0 |
| VENCE HOJE | 0 | $0 |

**Observação**: No dev, todos os títulos estão `A VENCER`. Nenhum atrasado nem vencendo hoje.

### 4.4 Matching com pedidos Comex

| Métrica | Valor |
|---------|-------|
| Total títulos | 350 |
| Com match | **350 (100%)** |
| Sem match | 0 |

Todos os títulos em USD no dev têm pedido Comex vinculado.

### 4.5 Top 5 títulos por valor

| Fornecedor | Vencimento | Valor BRL | Valor USD | Categoria |
|------------|-----------|-----------|-----------|-----------|
| PCC Plastic & Consultation Center | 2026-07-15 | R$ 2,006,647 | $399,499 | Financiamento FINIMP |
| ESENTTIA S.A. | 2026-06-09 | R$ 1,800,604 | $358,479 | Net 30/60/90 |
| SINOPEC CHEMICAL | 2026-08-05 | R$ 1,712,664 | $340,971 | Financiamento FINIMP |
| NCT Holland B.V. | 2026-07-11 | R$ 1,336,557 | $266,093 | Net 30/60/90 |
| Carmel Olefins LTD. | 2026-07-07 | R$ 1,168,003 | $232,536 | Net 30/60/90 |

---

## 5. Validação contra vw_hedge_resumo

```sql
SELECT SUM(valor_usd) FROM vw_hedge_pagar_usd  →  10,950,917.70
SELECT total_pagar_usd FROM vw_hedge_resumo    →  10,950,917.70
Diferença: 0.00 ✓
```

**Bate exato.** A view `vw_hedge_resumo` usa `SUM(valor_usd)` direto da `vw_hedge_pagar_usd`, sem transformações adicionais.

---

## 6. Reprodução manual

Para auditar um título específico:

```sql
-- Pegar um título e conferir conversão
SELECT 
  omie_id,
  data_vencimento,
  valor_brl,
  valor_usd,
  valor_brl / ptax_ref AS usd_recalculado,
  ptax_ref,
  fornecedor,
  codigo_categoria,
  tipo,
  pedido_comex
FROM vw_hedge_pagar_usd
WHERE omie_id = '4795481414';

-- Conferir categorias não mapeadas
SELECT codigo_categoria, descricao_categoria, COUNT(*)
FROM vw_hedge_pagar_usd
WHERE descricao_categoria = codigo_categoria  -- fallback ativou
GROUP BY codigo_categoria, descricao_categoria;

-- Títulos sem match com pedido Comex
SELECT omie_id, fornecedor, valor_usd, codigo_categoria
FROM vw_hedge_pagar_usd
WHERE pedido_comex IS NULL;
```

---

## 7. Dúvidas abertas

1. [ ] **Conversão USD usa PTAX atual** — se a PTAX mudar hoje, todos os `valor_usd` mudam mesmo sem alteração nos títulos. É o comportamento desejado ou deveria usar PTAX histórica (da data de emissão/vencimento)?

2. [ ] **Limite de 9 parcelas** — a CTE `parcelas_comex` faz UNION de `parcelas1_*` até `parcelas9_*`. Pedidos Comex com 10+ parcelas ficariam sem match. Hoje no dev 100% dos títulos fazem match, mas e no futuro?

3. [X] **Categorias hardcoded** — **RESOLVIDO**. Existe `public."tbl_categorias_ACXE"` com 28 categorias relevantes (sync OMIE). O hardcode atual tem 26 e está faltando `2.01.98` e `2.01.99`. Recomendação: trocar CTE hardcoded por `LEFT JOIN tbl_categorias_ACXE`. Ver §3.4 para detalhe.

4. [ ] **Fornecedores Q2P** — a view usa apenas `tbl_contasPagar_ACXE` e `tbl_cadastroFornecedoresClientes_ACXE`. E se a Q2P tiver contas a pagar em USD? Não é coberto.

5. [ ] **Título duplicado em múltiplas parcelas de pedido** — `row_number() OVER (PARTITION BY cp.codigo_lancamento_omie ORDER BY pc.nparcela)` garante 1 match por título. Mas se um título bater com 2 parcelas diferentes do mesmo pedido (fornecedor + data + valor iguais), pega só a 1ª. Isso é comum?

6. [ ] **Filtro `exterior='S'`** — é baseado no cadastro do fornecedor, não no código de moeda do título. Se um fornecedor marcado como exterior emitir um título em BRL (hipótese rara), entraria na view. OK?

---

## 8. Pontos fortes / fracos

**Fortes:**
- ✓ **Precisão**: agregado bate exato com `vw_hedge_resumo`
- ✓ **Cobertura de matching**: 100% no dev (350/350)
- ✓ **Filtros corretos**: só títulos ativos, só exterior, só categorias comex
- ✓ **Separação tipo**: mercadoria vs despesa_importacao é clara
- ✓ **Conversão USD**: PTAX atual (fotografia do momento) — comportamento desejado confirmado

**Fracos / GAPs:**
- ⚠ **Categorias hardcoded incompletas**: faltam `2.01.98` e `2.01.99` vs tabela OMIE real. Trocar por JOIN.
- ⚠ **Limite 9 parcelas**: aceito como limitação OMIE, monitorar se algum pedido tiver 10+
- ℹ **Escopo só ACXE**: contas a pagar Q2P em USD não entram (confirmado como OK pelo negócio)

---

## 9. Arquivos relacionados

- View parent: `public.vw_hedge_resumo` (doc [01](01-exposicao-usd-total.md))
- Próxima view: `vw_hedge_estoque` (doc 03, a ser criado)
- Consumidor backend: [posicao.service.ts](../../src/services/posicao.service.ts)
