# Validação: vw_hedge_importacoes

**View**: `public.vw_hedge_importacoes`
**Usado em**: `vw_hedge_resumo` (campos `importacoes_pendentes_usd`, `importacoes_pendentes_qtd`)
**BD consultado**: `pg-atlas-dev` (host `10.0.0.166`, DB `acxe_q2p`)
**Data**: 2026-04-14

---

## 0. Resumo didático

**O que essa view responde:** "Quais importações estão em andamento e qual é o valor comprometido em USD, pelo câmbio contratado?"

**O problema de negócio**

As outras três views (`pagar_usd`, `estoque`, `receber_usd`) trabalham com dados OMIE — faturas, posições de estoque, duplicatas. Mas há uma categoria de exposição que o OMIE não captura bem: **importações que ainda estão no pipeline Comex** — pedidos fechados com fornecedores, mercadoria ainda no navio ou no porto, sem nota fiscal emitida e sem entrada no estoque.

Esse pipeline é gerenciado pelo setor de Comex em uma planilha chamada FUP (Follow-Up de Importações). A view lê essa planilha diretamente via `tbl_dadosPlanilhaFUPComex`.

**O diferencial desta view: câmbio contratado, não PTAX**

As outras views convertem BRL → USD usando a PTAX do dia. Esta view é diferente: ela usa `taxa_dolar` da própria planilha FUP — o câmbio efetivamente **contratado** com o fornecedor no momento da compra. O `valor_total_usd` já vem pronto na planilha; não há divisão por PTAX aqui.

Isso significa que o valor USD desta view é mais preciso do que as outras para representar o compromisso real em dólar — é o dólar que vai sair do caixa, no câmbio que foi acordado.

**O que a view faz, passo a passo**

1. Lê todos os processos de importação da `tbl_dadosPlanilhaFUPComex`
2. Filtra apenas os processos **não recebidos** (`recebido_na_acxe <> 'true'`)
3. Deriva `status_hedge` via CASE: `nacionalizado`, `em_porto`, `em_transito` ou `aguardando_embarque`
4. Expõe campos relevantes para o dashboard: etapa, fornecedor, BL, DI, datas ETD/ETA, câmbio contratado

**Onde isso aparece na tela**

```
vw_hedge_importacoes
  └─ status_hedge <> 'nacionalizado'
       └─ SUM(valor_total_usd) = $6,974,198.75   ←── importacoes_pendentes_usd em vw_hedge_resumo
       └─ COUNT(*) = 55                           ←── importacoes_pendentes_qtd em vw_hedge_resumo
```

**Importante**: `importacoes_pendentes_usd` é um **campo informacional** em `vw_hedge_resumo` — ele **não entra** na fórmula `exposicao_usd_total`. A fórmula de exposição usa `total_pagar_usd + est_nao_pago_usd`. O FUP serve para visibilidade do pipeline, não para o KPI de exposição.

---

## 1. Propósito

Representa o pipeline de importações em andamento da ACXE, com status de cada processo e o valor comprometido em USD pelo câmbio contratado. Serve como:

- Campo informacional `importacoes_pendentes_usd` / `importacoes_pendentes_qtd` em `vw_hedge_resumo`
- Tabela de FUP Comex no dashboard (visibilidade operacional de cada processo)
- Fonte para análise de timing: quando cada lote vai chegar e gerar conta a pagar

---

## 2. Tabela fonte

| Tabela | Papel |
|--------|-------|
| `tbl_dadosPlanilhaFUPComex` | Planilha FUP Comex — processos de importação em andamento |

**Diferença crítica em relação às outras views**: esta tabela é **mantida manualmente** pelo setor Comex — não é sincronizada do OMIE. É uma planilha que o time atualiza conforme os processos avançam.

**Tabelas NÃO usadas:**
- `tbl_cotacaoDolar` — não há conversão PTAX; o câmbio está na própria planilha (`taxa_dolar`)

---

## 3. Lógica SQL

```sql
SELECT id, pedido_acxe_omie, etapa, etapa_global, numero_bl, numero_di,
       eta, etd, taxa_dolar, valor_total_usd, valor_total_reais,
       fornecedor, data_desembaraco, despachante, recebido_na_acxe,
       CASE
         WHEN data_desembaraco IS NOT NULL THEN 'nacionalizado'
         WHEN eta IS NOT NULL AND eta <= CURRENT_DATE THEN 'em_porto'
         WHEN etd IS NOT NULL THEN 'em_transito'
         ELSE 'aguardando_embarque'
       END AS status_hedge
FROM tbl_dadosPlanilhaFUPComex fup
WHERE recebido_na_acxe <> 'true' OR recebido_na_acxe IS NULL
```

### 3.1 Filtro aplicado

| Filtro | Razão |
|--------|-------|
| `recebido_na_acxe <> 'true'` | Exclui processos já recebidos — mercadoria que entrou no galpão já está em `vw_hedge_estoque` |
| `OR recebido_na_acxe IS NULL` | Processos sem flag preenchida são conservados (não assumir recebido) |

### 3.2 Lógica do status_hedge

O `status_hedge` é derivado pelas datas disponíveis — priority order via CASE:

| Prioridade | Condição | Status | Significado |
|-----------|----------|--------|-------------|
| 1 | `data_desembaraco IS NOT NULL` | `nacionalizado` | Mercadoria desembaraçada — processo concluído |
| 2 | `eta IS NOT NULL AND eta <= CURRENT_DATE` | `em_porto` | ETA passou — navio chegou ao porto, aguardando desembaraço |
| 3 | `etd IS NOT NULL` | `em_transito` | Data de embarque definida — mercadoria no mar |
| 4 | *(else)* | `aguardando_embarque` | Sem ETD ainda — pedido fechado, embarque não confirmado |

**Observação**: processos com `etapa = '00 - CANCELADO'` não têm tratamento específico. Se não tiverem `data_desembaraco`, `eta` ou `etd`, caem em `aguardando_embarque` pelo ELSE — ver GAP §7.1.

### 3.3 Campos de etapa

A planilha FUP tem dois níveis de granularidade de etapa:

| Campo | Exemplo | Uso |
|-------|---------|-----|
| `etapa` | `10 - Aguardando Chegada do Navio` | Etapa operacional detalhada (9 valores distintos) |
| `etapa_global` | `02 - Em Águas` | Etapa resumida para o dashboard (5 fases: 00 CANCELADO, 01 Booking, 02 Em Águas, 03 Nacionalização, 04 Financeiro, 05 Encerrado) |

### 3.4 Câmbio: taxa_dolar vs PTAX

| Aspecto | `vw_hedge_importacoes` | Outras views |
|---------|----------------------|-------------|
| Câmbio usado | `taxa_dolar` da planilha FUP (contratado) | PTAX atual (`tbl_cotacaoDolar`) |
| Natureza | Câmbio fixo no momento da compra | Fotografia do câmbio de hoje |
| Variação no tempo | Não varia (é o contrato) | Varia conforme câmbio do dia |
| Precisão | Mais preciso para o compromisso real | Estimativa baseada em câmbio atual |

---

## 4. Valores atuais no BD dev (2026-04-14)

### 4.1 Agregado total (todos os status)

| Métrica | Valor |
|---------|-------|
| Total processos | **96** |
| Total USD | **$10,992,778.10** |
| Total BRL | R$ 59,399,398.97 |
| Taxa dólar média | R$ 5.4196 |
| Taxa mínima | R$ 5.1831 |
| Taxa máxima | R$ 5.9875 |
| Fornecedores distintos | 19 |

**Obs**: `taxa_dolar` média de R$ 5.42 vs PTAX atual R$ 5.0229 — as compras foram fechadas quando o dólar estava mais caro. O valor USD da FUP ($10,9M) se convertido pela PTAX atual geraria BRL diferente do que está na planilha.

### 4.2 Por status_hedge

| Status | Qtd | Total USD | Total BRL |
|--------|-----|-----------|-----------|
| `nacionalizado` | 41 | $4,018,579.35 | R$ 22,001,453.33 |
| `em_transito` | 27 | $2,900,836.25 | R$ 15,536,346.05 |
| `aguardando_embarque` | 16 | $2,776,500.00 | R$ 14,739,815.16 |
| `em_porto` | 12 | $1,296,862.50 | R$ 7,121,784.43 |

### 4.3 Por etapa operacional (top 9)

| Etapa | Etapa Global | Qtd | USD |
|-------|-------------|-----|-----|
| 01 - Aguardando Embarque | 01 - Aguardando Booking | 18 | $3,130,795 |
| 10 - Aguardando Chegada do Navio | 02 - Em Águas | 27 | $2,736,336 |
| 40 - Operacional Finalizado | 04 - Aguardando Finalização Financeiro | 18 | $1,726,577 |
| 50 - Processo Encerrado | 05 - Encerrado | 11 | $966,877 |
| 22 - Aguardando Recebimento no Galpão | 03 - Nacionalização | 8 | $900,413 |
| 21 - Aguardando Exoneração de ICMS | 03 - Nacionalização | 7 | $699,273 |
| **00 - CANCELADO** | **00 - CANCELADO** | **4** | **$597,140** |
| 50 - PROCESSO ENCERRADO | 05 - Encerrado | 2 | $182,000 |
| 23 - Aguardando Devolução dos Containers | 03 - Nacionalização | 1 | $53,367 |

### 4.4 Top 8 fornecedores

| Fornecedor | Pedidos | Total USD |
|------------|---------|-----------|
| XIANGYU | 16 | $1,457,018 |
| PCC | 9 | $1,183,470 |
| BRIDGE | 8 | $978,912 |
| EPIMON | 6 | $821,340 |
| TRICON | 9 | $805,028 |
| ESENTTIA | 6 | $804,303 |
| BASELL | 6 | $779,020 |
| CARMEL | 3 | $632,655 |

### 4.5 Validação contra vw_hedge_resumo

```sql
-- Pendentes = status_hedge <> 'nacionalizado'
em_transito (27) + aguardando_embarque (16) + em_porto (12) = 55 ✓
$2,900,836.25 + $2,776,500.00 + $1,296,862.50 = $6,974,198.75 ✓

SELECT importacoes_pendentes_qtd FROM vw_hedge_resumo  →  55
SELECT importacoes_pendentes_usd FROM vw_hedge_resumo  →  6,974,198.75
Diferença: 0,00 ✓
```

**`vw_hedge_resumo` usa `status_hedge <> 'nacionalizado'` para definir "pendente".**

### 4.6 Posição desta view na fórmula de exposição

```
exposicao_usd_total = total_pagar_usd + est_nao_pago_usd
                    = $10,950,917.70 + $1,833,587.33
                    = $12,784,505.03

importacoes_pendentes_usd ($6,974,198.75) → NÃO entra na fórmula
```

As importações pendentes são **informacionais** — visibilidade do pipeline, não componente do KPI de exposição.

---

## 5. Design: por que importacoes não entra na exposição?

A `exposicao_usd_total` mede o quanto a ACXE precisa de dólares **nos próximos 90 dias** para honrar compromissos já registrados no OMIE. As importações pendentes da FUP são contratos em andamento, mas o título a pagar no OMIE só aparece quando a nota fiscal chega — e a nota só chega quando a mercadoria desembarca. Até lá, o compromisso existe, mas o sistema financeiro (OMIE) ainda não o registrou.

Incluir importações pendentes na exposição geraria dupla contagem nos processos mais avançados (etapa 40/50), onde já existe título a pagar em `vw_hedge_pagar_usd` **e** o processo ainda aparece na FUP como não-recebido.

A separação é intencional: `importacoes_pendentes` é o pipeline futuro; `total_pagar_usd` é o compromisso financeiro atual.

---

## 6. Design: por que usar taxa_dolar e não PTAX?

Esta view é a única que tem acesso ao câmbio real do contrato. Nas outras views, o OMIE registra tudo em BRL e perdemos o câmbio original — só resta usar a PTAX atual como estimativa. Aqui, a planilha FUP registra o câmbio contratado com cada fornecedor no momento do fechamento da compra.

Usar `taxa_dolar` da FUP dá o **valor comprometido real em USD** — o dólar que vai sair do caixa para pagar aquele lote, independente de como o câmbio se mover até lá. Isso é mais preciso para o propósito do hedge do que uma reconversão pela PTAX atual.

---

## 7. Dúvidas abertas / GAPs

1. [ ] **CANCELADO cai em aguardando_embarque** — 4 processos com `etapa = '00 - CANCELADO'` ($597,140 USD) provavelmente não têm ETD/ETA/data_desembaraco, então caem no `ELSE` da CASE como `aguardando_embarque`. Esses processos entram nos `importacoes_pendentes` do resumo. Solução: adicionar uma condição explícita para CANCELADO na CASE ou adicionar filtro `AND etapa_global <> '00 - CANCELADO'` no WHERE.

2. [ ] **Dados manuais sem auditoria** — a `tbl_dadosPlanilhaFUPComex` é mantida manualmente. Não há garantia de que todos os processos em andamento estejam registrados, ou que `recebido_na_acxe` seja atualizado pontualmente quando a mercadoria chega. Atraso nessa atualização subestima `importacoes_pendentes` (processos já recebidos que ainda aparecem como pendentes são excluídos pelo filtro).

3. [ ] **Dois valores de "Processo Encerrado"** — etapas `50 - Processo Encerrado` e `50 - PROCESSO ENCERRADO` (caixa vs uppercase) existem como valores distintos. Inconsistência de preenchimento na planilha. Não afeta a lógica da view (ambos ficam em `nacionalizado` ou `aguardando_embarque` dependendo das datas), mas dificulta filtros por etapa no dashboard.

4. [ ] **taxa_dolar varia por processo** — R$ 5.18 a R$ 5.99. Processos mais antigos têm câmbio contratado mais alto (dólar estava mais caro quando foram fechados). A conversão para BRL (`valor_total_reais`) usa esse câmbio histórico, enquanto as outras views usam PTAX atual. Isso torna comparações diretas entre views imprecisas.

5. [ ] **pedido_acxe_omie** — a view expõe o número do pedido OMIE, mas não faz JOIN com `tbl_contasPagar_ACXE`. Não há vínculo automático entre o processo FUP e os títulos a pagar correspondentes em `vw_hedge_pagar_usd`. O matching é visual (um analista olha o pedido comex e o título), não sistemático.

---

## 8. Pontos fortes / fracos

**Fortes:**
- ✓ **Câmbio contratado**: único caso no hedge engine onde o valor USD é o real do contrato, não estimativa PTAX
- ✓ **Validação perfeita**: `importacoes_pendentes_qtd` e `importacoes_pendentes_usd` batem exato com `vw_hedge_resumo`
- ✓ **status_hedge derivado**: lógica clara para classificar o avanço de cada processo
- ✓ **Dois níveis de etapa**: `etapa` operacional detalhada + `etapa_global` para dashboard

**Fracos / GAPs:**
- ⚠ **CANCELADO não filtrado**: 4 processos ($597,140) entram nos pendentes indevidamente — requer filtro adicional
- ⚠ **Fonte manual**: sem garantia de completude ou pontualidade; depende de disciplina do time Comex
- ⚠ **Dupla contagem potencial**: processos em etapa 40-50 podem ter título a pagar em `vw_hedge_pagar_usd` E aparecer como pendentes aqui — por design, mas pode confundir se somados
- ℹ **Inconsistência de capitalização**: "50 - Processo Encerrado" vs "50 - PROCESSO ENCERRADO"

---

## 9. Arquivos relacionados

- View parent: `public.vw_hedge_resumo` (doc [01](01-exposicao-usd-total.md))
- View anterior: `vw_hedge_receber_usd` (doc [04](04-vw_hedge_receber_usd.md))
- Próxima: `vw_hedge_resumo` (doc [06](06-vw_hedge_resumo.md))
- Consumidor backend: [posicao.service.ts](../../src/services/posicao.service.ts)
