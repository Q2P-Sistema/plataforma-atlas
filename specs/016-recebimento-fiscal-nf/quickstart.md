# Quickstart — Validar o Recebimento Fiscal pelo Atlas

**Feature**: `016-recebimento-fiscal-nf` | **Jira**: ACXEGDP-395

---

## Pré-requisitos

```bash
pnpm install
pnpm --filter @atlas/db migrate      # aplica a 0053 (espelho + ledger + dispensa)
pnpm dev                             # apps/api + apps/web
```

`.env`: `MODULE_STOCKBRIDGE_ENABLED=true`, `STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE=<data>`, **`STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=true`** (default é `false`); `STOCKBRIDGE_FISCAL_EMAILS` opcional (default: NFe ACXE, Mauricio Yared, Gustavo Dreer — em dev, aponte para a sua caixa para não disparar ao fiscal real). Em dev, `OMIE_MODE=mock`: o mock tem recebimentos na etapa 40 injetáveis por teste (`__injectMockRecebimentoNfe`). Em UAT, `OMIE_MODE=real` (atenção ao redeploy que reverte para mock — memória `uat-omie-mode-reverte-no-redeploy`).

**Espelho**: o workflow n8n "Q2P - Exporta Recebimentos NF-e" precisa estar ativo (contrato `contracts/espelho-recebimentos-n8n.md`) e, no UAT, a cópia `scripts/sync-omie-public-prod-to-uat.sh` precisa já incluir as tabelas (acontece sozinho quando existem em PROD e UAT). Sem espelho, a fila mostra só "fiscal já feito" — e isto é o Cenário 5.

> ⚠️ Toda NF usada nos cenários 1–3 sofre **escrita fiscal real no OMIE** (conta a pagar incluída). Combinar com o fiscal qual NF usar; a volta é `ReverterRecebimento` pela tela do OMIE.

---

## Cenário 1 — NF com fiscal pendente recebida num clique (História 1, P1)

1. Confirme que há uma NF de compra nacional elegível **na etapa 40** no OMIE (kanban "Faturado pelo Fornecedor") e que ela já está no espelho:
   ```sql
   SELECT c_numero_nfe, c_razao_social, c_etapa, c_recebido, d_emissao, synced_at
   FROM public."tbl_recebimentoNFe_Q2P" WHERE c_recebido='N' AND c_cancelada='N' ORDER BY d_emissao DESC;
   ```
2. Como operador, abra `/stockbridge/fila` → "Compra nacional". A NF aparece com o selo **"Fiscal pendente"**.
3. Abra a nota: itens com descrição original, quantidade, unidade e valor (= `v_total_item`). Banner: "O recebimento fiscal será concluído no OMIE ao confirmar".
4. Confirme o recebimento.

**Esperado**: `201` com `fiscal.status = "concluido"` e os produtos `aguardando_aprovacao`. No ledger:
```sql
SELECT nota_fiscal, status, etapa_antes, recebido_antes, itens_total, iniciado_em, finalizado_em
FROM stockbridge.recebimento_fiscal ORDER BY iniciado_em DESC LIMIT 3;
```
No OMIE (sonda `ConsultarRecebimento` ou tela): `cEtapa 60`, `cRecebido S`, `cUsuarioRec WEBSERVICE`, item `cIgnorarItem S`, `cNaoGerarMovEstoque S`, `nIdProduto 0`, descrição intacta, parcela com `nIdTitulo` (conta a pagar). Aprove no painel do gestor → ajuste de estoque OMIE como hoje. A NF **não** reaparece na fila após o próximo sync (SC-005).

## Cenário 2 — Falhas e repetições (História 3, P2)

a. **Duplo clique**: dispare o POST duas vezes em sequência. Esperado: uma resposta `201` e uma `409 RECEBIMENTO_FISCAL_EM_ANDAMENTO`; **uma** linha `concluido` no ledger; nenhuma movimentação em dobro.

b. **Fiscal falhando** (UAT com `OMIE_MODE=real`): troque temporariamente `OMIE_Q2P_SECRET` por um valor inválido e confirme uma NF pendente. Esperado: `502 RECEBIMENTO_FISCAL_FAIL`, mensagem com NF e fornecedor, **zero** `INSERT` em `movimentacao`/`aprovacao`, linha `falha` no ledger com `passo_falha='editar'` e `erro_omie_*` preenchidos. Restaure o secret; repita: `201`.

c. **Fiscal ok, físico falhou**: em dev/mock, force falha no `INSERT` (ex.: mock de `db.transaction`) após o fiscal. Esperado: ledger `concluido`, nenhuma movimentação; a NF volta à fila como **"Fiscal já feito"** (pelo ledger, antes mesmo do sync); novo POST → `fiscal.status = "nao_aplicavel"` e produtos gravados.

d. **Já concluído no OMIE no meio do caminho**: conclua o fiscal pela tela do OMIE **depois** de abrir a NF no Atlas como "fiscal pendente" e **antes** de confirmar. Esperado: `fiscal.status = "ja_concluido"`, produtos gravados, nada escrito no OMIE pelo Atlas.

## Cenário 3 — Rejeição do gestor (História 3, cenário 4)

Receba uma NF pendente **com divergência de peso** (motivo obrigatório). Esperado: fiscal concluído no clique (`ledger concluido`), aprovação pendente. Gestor **rejeita**. Esperado: movimentação `ativo=false`, NF volta à fila como **"Fiscal já feito"**; novo recebimento faz só o físico (`fiscal.status = "nao_aplicavel"`).

## Cenário 4 — Dispensa pelo gestor (clarificação de 02/10/2026)

1. Como gestor, numa NF "Fiscal pendente", clique **"Dispensar da fila"** → motivo obrigatório → confirme. A NF some da fila; o operador não vê o botão.
2. Em Aprovações → seção **"NFs dispensadas"**: a linha aparece com motivo, quem e quando. O fiscal recebe e-mail "NF dispensada da fila" com a pendência do OMIE (etapa 40 → "aguardando manifestação ou cancelamento"; fiscal já feito → "conta a pagar de R$ N a estornar ou manter").
3. **Desfazer**: motivo → a NF volta à fila como estava.
4. Dispense também uma NF "Fiscal já feito" sem recebimento físico: aceita, e a lista mostra "havia conta a pagar no OMIE". Tente dispensar uma NF já recebida no Atlas: `422 NF_NAO_DISPENSAVEL`.

```sql
SELECT nota_fiscal, motivo, dispensado_em, revertido_em FROM stockbridge.nf_dispensa ORDER BY dispensado_em DESC;
SELECT operation, table_name, count(*) FROM shared.audit_log WHERE table_name IN ('nf_dispensa','recebimento_fiscal') GROUP BY 1,2;
```

## Cenário 5 — Flag desligada / sem espelho (FR-020, História 2)

`STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=false` (ou espelho vazio): a fila lista exatamente as NFs da 015 (todas "Fiscal já feito", sem selo de pendente), o POST devolve `fiscal.status = "desligado"` e não toca o OMIE; `POST …/dispensar` → `403`. Compare a lista com um snapshot tirado antes de ligar a flag (SC-006).

## Cenário 6 — Edge cases rápidos

- NF pendente **cancelada** no OMIE depois de aparecer: após o sync, some da fila; se já aberta, o POST devolve `422 NF_CANCELADA`.
- NF pendente **sem fornecedor cadastrado**: aparece como "Fornecedor não identificado no OMIE"; o POST devolve `422 RECEBIMENTO_FISCAL_SEM_FORNECEDOR` (confirmar o fault real — research pendente 3).
- Itens **todos bloqueados por unidade**: o POST não dispara o fiscal (`nao_aplicavel`), a NF segue "Fiscal pendente".

## Testes automatizados

```bash
pnpm --filter @atlas/integration-omie test     # recebimento-nfe (mock com estado)
pnpm --filter @atlas/stockbridge test          # recebimento-fiscal, fila-unificada, nf-dispensa, regressão 015
ATLAS_DB_INTEGRATION=1 pnpm --filter @atlas/stockbridge test -- audit   # trigger de auditoria das 2 tabelas novas
```
