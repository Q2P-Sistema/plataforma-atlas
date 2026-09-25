# Quickstart — Validar o Recebimento Nacional por NF

**Feature**: `015-recebimento-nacional-nf` | **Jira**: ACXEGDP-328

---

## Pré-requisitos

```bash
pnpm install
pnpm --filter @atlas/db migrate      # aplica a 0052
pnpm dev                             # apps/api + apps/web
```

`MODULE_STOCKBRIDGE_ENABLED=true` no `.env`. O fluxo de leitura **não** precisa de credencial OMIE — a fila e o detalhe saem do espelho Postgres. Credencial só é exigida na aprovação do gestor, que dispara o ajuste (comportamento atual).

A migration **não é bloqueada** pelo passivo de dados: o índice de idempotência é sobre `nf_chave_acesso`, coluna que nasce nesta feature, então as 144 movimentações nacionais históricas (com o campo nulo) ficam fora dele.

> ⚠️ As ~40,7 t de excesso das NFs 66529, 66530 e 66604 continuam no estoque e no OMIE (research D13). O índice impede repetição, não corrige o histórico.

---

## Cenário 1 — Receber sem digitar quantidade nem valor (História 1, P1)

1. Entre como operador com armazém vinculado e abra `/stockbridge/fila` → aba **"Compra nacional"**.
2. A fila deve listar as NFs elegíveis emitidas a partir do corte fixo de 7 dias antes da virada — **2 NFs** na medição de 17/09/2026 (9 elegíveis na janela, das quais 7 já recebidas pelo fluxo manual e reconhecidas pela checagem de duas vias). Confira que cada linha traz número, data, **Fornecedor**, nº de itens e valor total.
3. Clique numa NF. O detalhe abre com cada item já preenchido: descrição do fornecedor, quantidade, unidade, valor unitário e valor total.
4. **Verifique o que não existe**: não deve haver campo editável de **valor** nem de **unidade**. A quantidade vem preenchida da NF e é editável — é onde entra o peso da balança (Cenário 2).
5. Escolha o estoque destino e envie.

**Esperado**: `201`, um item com `status: "aguardando_aprovacao"`, e uma movimentação + aprovação criadas por item.

```bash
psql "$DATABASE_URL" -c "
SELECT nota_fiscal, produto_codigo_q2p, quantidade_kg, custo_unitario_brl, subtipo
FROM stockbridge.movimentacao
WHERE subtipo='compra_nacional' ORDER BY created_at DESC LIMIT 3;"
```

Sem divergência, `quantidade_kg` e `quantidade_nf_kg` devem ser iguais e `quantidade_divergencia_kg` deve ser zero; `custo_unitario_brl × quantidade_kg` reproduz o `v_prod` do item (SC-001) — **não** o `v_tot_item`, que soma o IPI duas vezes (research D26). Numa NF com IPI, confira também contra o `<vNF>` do XML: a soma dos itens tem de bater.

---

## Cenário 2 — Peso conferido divergente da NF (História 2, P2)

1. Abra uma NF e altere a quantidade do item para um valor **maior** que o da NF (ex.: NF diz 13.160, informe 13.500 — o caso real da NF 66724).
2. Tente enviar sem preencher o motivo.

**Esperado**: recusa com `MOTIVO_DIVERGENCIA_OBRIGATORIO`.

3. Preencha o motivo e envie.

**Esperado**: `201`, item em `aguardando_aprovacao`, e o registro guardando os três números:

```bash
psql "$DATABASE_URL" -c "
SELECT nota_fiscal, quantidade_nf_kg, quantidade_kg, quantidade_divergencia_kg
FROM stockbridge.movimentacao
WHERE subtipo='compra_nacional' ORDER BY created_at DESC LIMIT 3;"
```

`quantidade_divergencia_kg` deve ser positiva (recebemos mais que a NF) — hoje esse caso não deixa rastro nenhum (SC-004).

4. **Diferença deliberada com a importação**: o mesmo cenário no recebimento de importação é recusado com `QuantidadeExcedeNfError`. No nacional, é aceito. Ver research D17.
5. Repita com peso **menor** que o da NF — também deve ser aceito com motivo.
6. Informe uma quantidade dentro de 1 kg da NF: **não** deve exigir motivo.

---

## Cenário 3 — Classificar um item em vários produtos (História 4, P4)

Caso real: NF 66461 da ISOFORMA, 1 item de "SUCATA PSAI MOIDO MESCLADO GROSSO" (13.541 kg) recebido como PS CRISTAL A + PS AI B + PS CRISTAL B.

1. Abra uma NF de item único de fornecedor de sucata.
2. Adicione 3 produtos ao item, distribuindo o peso conferido entre eles.
3. Deixe a soma **diferente** do peso conferido e tente enviar.

**Esperado**: recusa com `DISTRIBUICAO_NAO_FECHA`.

4. Ajuste para fechar e envie.

**Esperado**: 3 movimentações, uma por produto. Confira que o valor do item foi rateado por peso:

```bash
psql "$DATABASE_URL" -c "
SELECT produto_codigo_q2p, quantidade_kg, custo_unitario_brl,
       round(quantidade_kg * custo_unitario_brl, 2) AS valor_produto
FROM stockbridge.movimentacao
WHERE subtipo='compra_nacional' AND nf_chave_acesso = '<chave>';"
```

A soma de `valor_produto` deve reproduzir o `v_prod` do item da NF (SC-006).

---

## Cenário 4 — Correlação memorizada (História 3, P3)

1. Na primeira NF de um fornecedor, um item sem histórico deve vir **sem** produto pré-selecionado e **não** deve permitir entrada até a escolha (FR-005).
2. Correlacione e receba.
3. Abra outra NF do **mesmo fornecedor** com um item de descrição idêntica.

**Esperado**: produto já pré-selecionado, sem busca.

```bash
psql "$DATABASE_URL" -c "
SELECT fornecedor_nome, descricao_nf, produto_descricao, vezes_usada
FROM stockbridge.correlacao_produto_fornecedor WHERE ativo ORDER BY updated_at DESC LIMIT 5;"
```

4. **Correção**: troque o produto sugerido por outro e receba. O produto antigo deve ficar `ativo = false` (auditado, nunca `DELETE`) e o novo entrar como linha nova — a chave única é `(fornecedor_cnpj, descricao_normalizada, produto_codigo_q2p)`, porque a correlação é 1:N (research D18).
5. **Conjunto**: para uma descrição já classificada em vários produtos, a sugestão deve trazer **todos** eles, ordenados por `vezes_usada`.

---

## Cenário 5 — Unidade não conversível bloqueia (História 5, P5)

NFs com unidade `UN` existem no recorte (6 itens em jan–jul/2026). Para achar uma:

```sql
SELECT h.n_nf, h.d_emi, h.dest_razao, i.x_prod, i.q_com, i.u_com
FROM public."tbl_nf_header_Q2P" h
JOIN public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf
WHERE h.tp_nf = 0 AND i.cfop IN ('1.101','1.102','2.101','2.102')
  AND i.u_com NOT IN ('KG','TON','TL')
ORDER BY h.d_emi DESC LIMIT 5;
```

**Esperado**: o item aparece bloqueado, com mensagem nomeando a unidade, `quantidadeKg: null` e nenhuma conversão aplicada. Numa NF mista, os demais itens continuam recebíveis (FR-009 + edge case).

---

## Cenário 6 — Idempotência (FR-013)

1. Receba uma NF de 1+ itens.
2. Reenvie exatamente o mesmo POST.

**Esperado**: `201` com todos os itens em `status: "ja_recebido"`, **sem** movimentação nova.

```bash
psql "$DATABASE_URL" -c "
SELECT nf_chave_acesso, produto_codigo_q2p, count(*)
FROM stockbridge.movimentacao
WHERE ativo AND subtipo='compra_nacional' AND nf_chave_acesso IS NOT NULL
GROUP BY 1,2 HAVING count(*) > 1;"
```

Vazio = idempotência funcionando. A NF também deve ter sumido da fila (FR-002 / SC-005).

3. **Retomada**: numa NF de 2+ itens, receba só um. A NF deve continuar na fila mostrando apenas o item pendente.
4. **Colisão de número** (FR-013): receba duas NFs de **fornecedores diferentes** que compartilhem o mesmo número e o mesmo produto. Ambas devem ser aceitas — a identidade é a chave de acesso, não o número. Para achar um par:

```sql
SELECT ltrim(n_nf,'0') AS nf, count(DISTINCT dest_cnpj_cpf) AS fornecedores
FROM public."tbl_nf_header_Q2P" WHERE tp_nf = 0
GROUP BY 1 HAVING count(DISTINCT dest_cnpj_cpf) > 1 LIMIT 5;
```

---

## Cenário 7 — O caminho manual não regrediu (FR-014)

Na mesma aba, alterne para o formulário manual e registre uma NF que **não** está no espelho. Deve funcionar exatamente como antes, inclusive o rateio por peso (ACXEGDP-178) e o preview "Valor do item".

---

## Cenário 8 — Recebimento externo (História 6, P2)

1. Na fila, escolha uma NF e acione **"Já recebida fora do Atlas"** sem preencher motivo.

**Esperado**: recusa com `MOTIVO_OBRIGATORIO`.

2. Preencha o motivo e envie. Entre como gestor e aprove.

**Esperado**: o item sai da fila e **nenhuma movimentação é criada**:

```bash
psql "$DATABASE_URL" -c "
SELECT count(*) AS movimentacoes_criadas
FROM stockbridge.movimentacao
WHERE subtipo='compra_nacional' AND nf_chave_acesso = '<chave>';"
```

Deve ser `0`. E a aprovação deve existir com o motivo:

```bash
psql "$DATABASE_URL" -c "
SELECT tipo_aprovacao, status, nota_fiscal, left(observacoes,60) AS motivo
FROM stockbridge.aprovacao WHERE tipo_aprovacao='recebimento_externo'
ORDER BY lancado_em DESC LIMIT 3;"
```

3. **Rejeição**: rejeite uma solicitação como gestor — o item deve voltar a aparecer como pendente.
4. **Parcial**: numa NF de 3 itens, baixe só 1 — os outros 2 continuam recebíveis.
5. **Flag**: com `STOCKBRIDGE_RECEBIMENTO_EXTERNO_ENABLED=false`, a ação some da tela e a rota devolve `403`.

---

## Testes automatizados

```bash
pnpm --filter @atlas/stockbridge test          # inclui os arquivos novos
pnpm --filter @atlas/stockbridge test unidade-nf
pnpm lint && pnpm typecheck
```

Cobertura esperada pela spec: normalização de unidade (**incluindo o caso de bloqueio**, que hoje não existe nem para `converterParaKg`), match de correlação 1:N, cálculo de divergência, rateio por peso dentro do item, idempotência por chave de acesso, e a guarda de regressão de `fiscal-recebida-sql.ts` — os 6 pontos do fluxo de importação devem produzir resultado idêntico ao de hoje.

---

## Conferência contra a realidade

O banco DEV é sanitizado e tem OMIE defasado. Para validar a fila contra o que a Comex enxerga, use PROD em leitura:

```sql
-- NFs elegíveis emitidas a partir do corte de 7 dias (antes de descontar as já recebidas)
SELECT count(DISTINCT h.n_id_nf)
FROM public."tbl_nf_header_Q2P" h
JOIN public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf
WHERE h.tp_nf = 0 AND i.cfop IN ('1.101','1.102','2.101','2.102')
  AND COALESCE(h.cancelada,false) = false AND COALESCE(h.deletada,false) = false
  AND h.dest_razao NOT ILIKE '%PLASTFIX%' AND h.dest_razao NOT ILIKE 'ACXE IMPORTACAO%'
  AND h.d_emi >= CURRENT_DATE - 7;
```
