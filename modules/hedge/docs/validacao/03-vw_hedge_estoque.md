# Validação: vw_hedge_estoque

**View**: `public.vw_hedge_estoque`
**Usado em**: `vw_hedge_resumo` (componente `est_importado_usd`, `est_importado_brl`) e `estoque.service.ts` (tabela de estoque no dashboard)
**BD consultado**: `pg-atlas-dev` (host `10.0.0.166`, DB `acxe_q2p`)
**Data**: 2026-04-14

---

## 0. Resumo didático

**O que essa view responde:** "Qual é o estoque físico da ACXE e Q2P, classificado por origem, expresso em BRL e USD?"

**O problema de negócio**

A exposição cambial não é só o que você deve pagar — é também o que você já recebeu mas ainda não pagou. Em importações, a mercadoria chega antes do pagamento: ela entra no estoque antes de você transferir os dólares para o fornecedor. A view mapeia esse estoque e classifica cada local como `importado_no_chao` (recebido fisicamente), `em_transito` (a caminho) ou `nacional` (comprado no mercado interno).

**O que a view faz, passo a passo**

1. **UNION ALL ACXE + Q2P** — une posição de estoque das duas empresas em uma única view
2. **Filtra por locais hardcoded** — só inclui locais cujo `codigo_local_estoque` está na CTE `acxe_locais` ou `q2p_locais`. Locais não listados (PRODUÇÃO, PROCESSO, INATIVO etc.) são excluídos
3. **Classifica a origem** — cada local tem uma origem atribuída na CTE: `importado_no_chao`, `em_transito` ou `nacional`
4. **Converte para USD** — `valor_total_usd = ncmc × nsaldo / ptax_atual`
5. **Filtra saldo positivo** — `WHERE nsaldo > 0` (exclui zerados)

**Onde isso aparece na tela**

```
vw_hedge_estoque (origem='importado_no_chao')
  └─ SUM(valor_total_brl) = R$9,2M  ←── est_importado_brl em vw_hedge_resumo
  └─ SUM(valor_total_usd) = $1,83M  ←── est_importado_usd → entra na fórmula de exposição
  └─ tabela de estoque no dashboard  ←── estoque.service.ts lê com filtro de localidades_ativas
```

---

## 1. Propósito

Mapeia o estoque físico das empresas ACXE e Q2P, classificando cada local como:
- `importado_no_chao` — mercadoria importada fisicamente em armazém (já desembaraçada)
- `em_transito` — mercadoria ainda a caminho (no mar ou desembaraço)
- `nacional` — estoque comprado no mercado interno (sem exposição cambial direta)

Serve como base para:
- Cálculo do `est_nao_pago_usd` na fórmula de exposição (`vw_hedge_resumo`)
- Tabela de estoque por localidade no dashboard
- Filtro de localidades ativas (via `configMotor`)

---

## 2. Tabelas fonte

| Tabela OMIE | Papel |
|-------------|-------|
| `tbl_posicaoEstoque_ACXE` | Posição de estoque por produto e local (ACXE) |
| `tbl_posicaoEstoque_Q2P` | Posição de estoque por produto e local (Q2P) |
| `tbl_locaisEstoques_ACXE` | Descrição dos locais de estoque (ACXE) |
| `tbl_locaisEstoques_Q2P` | Descrição dos locais de estoque (Q2P) |
| `tbl_cotacaoDolar` | PTAX atual para conversão USD |

---

## 3. Lógica SQL (simplificada)

```sql
-- ACXE
SELECT 'acxe', produto, local, al.origem,
       ncmc * nsaldo AS valor_total_brl,
       ROUND(ncmc * nsaldo / ptax, 2) AS valor_total_usd
FROM tbl_posicaoEstoque_ACXE pe
  JOIN tbl_locaisEstoques_ACXE le ON le.codigo = pe.codigo_local_estoque
  JOIN acxe_locais al ON al.codigo = pe.codigo_local_estoque  -- filtro: só locais da CTE
  CROSS JOIN ptax_atual
WHERE pe.nsaldo > 0

UNION ALL

-- Q2P (mesma lógica, locais diferentes)
SELECT 'q2p', ...
FROM tbl_posicaoEstoque_Q2P pe
  JOIN q2p_locais ql ON ql.codigo = pe.codigo_local_estoque
  ...
WHERE pe.nsaldo > 0
```

### 3.1 Locais hardcoded — ACXE

| Código | Descrição | Origem |
|--------|-----------|--------|
| 4498926061 | SANTO ANDRÉ (IMPORTADO) | `importado_no_chao` |
| 4498926337 | SANTO ANDRÉ (IMPORTADO) | `importado_no_chao` |
| 4776458297 | ARMAZÉM EXTERNO | `importado_no_chao` |
| 4004166399 | EXTREMA | `importado_no_chao` |
| 4503767789 | TRÂNSITO | `em_transito` |

**Obs:** dois códigos distintos para "SANTO ANDRÉ (IMPORTADO)" — são duas posições físicas separadas no OMIE (ex: câmara fria vs seco, ou por filial).

### 3.2 Locais hardcoded — Q2P

| Código | Descrição | Origem |
|--------|-----------|--------|
| 8123584710 | SANTO ANDRÉ (NACIONAL) | `nacional` |
| 8123584481 | SANTO ANDRÉ (NACIONAL) | `nacional` (sem saldo no dev) |

### 3.3 Espelhamento ACXE → Q2P

Os locais "IMPORTADO" da Q2P são **réplicas espelhadas** dos locais ACXE, criadas automaticamente pelo integrador OMIE a cada movimentação. São intencionalmente **excluídos** da view para evitar dupla contagem — o mesmo estoque físico existe nos dois CNPJs, mas o valor real é o da ACXE.

| ACXE (incluso na view) | Q2P (excluído — réplica) | Descrição |
|------------------------|--------------------------|-----------|
| 4498926061 | 8115873724 | SANTO ANDRÉ (IMPORTADO) |
| 4498926337 | 8115873874 | SANTO ANDRÉ (IMPORTADO) |
| 4776458297 | 8042180936 | ARMAZÉM EXTERNO |
| 4004166399 | 7960459966 | EXTREMA |
| 4503767789 | 8429029971 | TRÂNSITO |

### 3.4 Locais OMIE excluídos intencionalmente

| Local | Empresa | Motivo da exclusão |
|-------|---------|-------------------|
| PRODUÇÃO (4553940398) | ACXE | Em processo produtivo — não é estoque hedgeável |
| PROCESSO (4530985781) | ACXE | Em processo produtivo — não é estoque hedgeável |
| CONSUMO, VARREDURA, FALTANDO | ACXE | Operacionais/residuais |
| INATIVO 01 | ACXE | Inativo |
| IMPORTADO × 2, EXTREMA, ARMAZÉM EXTERNO | Q2P | Réplicas espelhadas da ACXE — ver §3.3 |
| INATIVO 01/02/03 | Q2P | Inativos |

---

## 4. Valores atuais no BD dev (2026-04-14)

### 4.1 Por local

| Empresa | Local | Origem | Itens | Qtd (kg) | BRL | USD |
|---------|-------|--------|-------|----------|-----|-----|
| acxe | TRÂNSITO | em_transito | 20 | 1.411.350 | R$ 9.748.650 | $1.940.841 |
| acxe | SANTO ANDRÉ (IMPORTADO) | importado_no_chao | 45 | 1.083.813 | R$ 7.454.769 | $1.484.156 |
| acxe | EXTREMA | importado_no_chao | 8 | 82.392 | R$ 1.688.872 | $336.234 |
| acxe | ARMAZÉM EXTERNO | importado_no_chao | 2 | 8.500 | R$ 66.285 | $13.196 |
| q2p | SANTO ANDRÉ (NACIONAL) | nacional | 31 | 459.690 | R$ 4.509.784 | $897.845 |

**PTAX usada**: R$ 5.0229

### 4.2 Aggregado por origem

| Origem | BRL | USD |
|--------|-----|-----|
| importado_no_chao | **R$ 9.209.926** | **$1.833.587** |
| em_transito | R$ 9.748.650 | $1.940.841 |
| nacional | R$ 4.509.784 | $897.845 |

### 4.3 Validação cruzada com vw_hedge_resumo

```sql
-- doc 01 registrou:
est_importado_brl = R$ 9.209.925,84  →  bate com SUM(importado_no_chao BRL) ✓
est_importado_usd = $1.833.587,33    →  bate com SUM(importado_no_chao USD) ✓
```

**Perfeito.** A view `vw_hedge_resumo` usa `WHERE origem = 'importado_no_chao'` — exclui `em_transito` e `nacional` da fórmula de exposição.

---

## 5. Design: por que PRODUÇÃO e PROCESSO são excluídos?

Faz sentido de negócio: quando a mercadoria entra em produção, ela deixa de ser "estoque importado aguardando pagamento" e passa a ser custo de produção já consumido. O hedge só é relevante enquanto a mercadoria está **parada em armazém** (importado_no_chao) ou **a caminho** (em_transito). Uma vez em produção, o risco cambial teórico foi assumido.

---

## 6. Design: por que em_transito não entra na fórmula de exposição?

A fórmula em `vw_hedge_resumo` usa apenas `importado_no_chao`:

```sql
est_importado_usd = SUM(valor_total_usd) WHERE origem = 'importado_no_chao'
```

O estoque `em_transito` (R$9,7M / $1,9M) é excluído porque o pagamento geralmente ocorre **depois** da entrega física. Enquanto está em trânsito, o título a pagar já está capturado em `vw_hedge_pagar_usd`. Incluir também o em_transito no estoque seria dupla contagem.

---

## 7. Dúvidas abertas / GAPs

1. [X] **Locais Q2P importados excluídos** — **RESOLVIDO**. Os locais Q2P "IMPORTADO" são réplicas espelhadas criadas pelo integrador OMIE. Excluí-los é correto — evita dupla contagem. Ver mapeamento em §3.3.

2. [ ] **Locais hardcoded por código numérico** — ao contrário das categorias (que usam LIKE com padrão), aqui o filtro é por código exato. Se um novo armazém for criado no OMIE para ACXE ou Q2P, ele fica fora da view até alguém editar a CTE manualmente. Não há fallback parcial como nas categorias.

3. [ ] **Dois códigos para "SANTO ANDRÉ (IMPORTADO)" ACXE** — 4498926061 e 4498926337 têm o mesmo nome no OMIE. Isso é intencional (ex: posições físicas separadas) ou é um duplicado histórico? Agregar os dois na tabela do dashboard pode confundir.

4. [ ] **Custo médio vs preço unitário** — a view usa `ncmc` (custo médio) para calcular o valor total, ignorando `nprecounitario`. Para conversão USD, o custo médio BRL dividido pela PTAX atual pode divergir do dólar original da compra. É a melhor aproximação disponível sem acesso ao DI/DUIMP.

5. [ ] **em_transito não entra na exposição** — confirmado como design correto (§6), mas vale registrar: se o timing entre chegada física e pagamento mudar (ex: fornecedor cobra antes da entrega), isso pode subestimar a exposição.

---

## 8. Pontos fortes / fracos

**Fortes:**
- ✓ **Precisão**: valores de `importado_no_chao` batem exato com `vw_hedge_resumo` (doc 01)
- ✓ **Separação de origens**: lógica clara entre `importado_no_chao`, `em_transito` e `nacional`
- ✓ **Exclusão de PRODUÇÃO/PROCESSO**: correto do ponto de vista de negócio
- ✓ **Cobre ambas empresas**: ACXE + Q2P em uma view unificada

**Fracos / GAPs:**
- ✓ **Locais Q2P importados corretamente excluídos**: são réplicas espelhadas do integrador OMIE — excluir evita dupla contagem
- ⚠ **Locais hardcoded por código**: criação de novo armazém no OMIE não aparece automaticamente
- ℹ **Custo médio como proxy USD**: melhor aproximação disponível sem DI/DUIMP, mas é estimativa

---

## 9. Arquivos relacionados

- View parent: `public.vw_hedge_resumo` (doc [01](01-exposicao-usd-total.md))
- View anterior: `vw_hedge_pagar_usd` (doc [02](02-vw_hedge_pagar_usd.md))
- Próxima view: `vw_hedge_receber_usd` (doc 04, a ser criado)
- Consumidor backend: [estoque.service.ts](../../src/services/estoque.service.ts)
