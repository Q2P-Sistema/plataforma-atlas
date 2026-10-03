# Quickstart — Validar o Recebimento Fiscal pelo Atlas

**Feature**: `016-recebimento-fiscal-nf` | **Jira**: ACXEGDP-395

---

## Pré-requisitos

```bash
pnpm install
pnpm dev                             # apps/api + apps/web
```

A 0053 é aplicada com `psql` (o repo não usa o runner do drizzle-kit). Em dev, num banco local; **no UAT vivo, só o arquivo da 0053** — `scripts/apply-migrations-uat.sh` reaplica todas as migrations e não serve num banco em uso:

```bash
# o psql pede a senha (funciona em bash e zsh); lock_timeout evita ficar preso atrás de transação longa
PGOPTIONS='-c lock_timeout=5s' psql -h db.manager01.q2p.com.br -p 5437 -U postgres -d acxe_q2p \
  -1 -q -v ON_ERROR_STOP=1 -f packages/db/migrations/0053_stockbridge_recebimento_fiscal_nf.sql
```

Saída esperada: nenhum `ERROR`; na 1ª execução, só `NOTICE: trigger ... does not exist, skipping`. A migration é idempotente (pode rodar de novo). Depois, conferir (somente leitura): `SELECT to_regclass('stockbridge.recebimento_fiscal'), to_regclass('stockbridge.nf_dispensa'), to_regclass('public."tbl_recebimentoNFe_Q2P"')` sem nulos e `trg_audit_sb_recebimento_fiscal`/`trg_audit_sb_nf_dispensa` em `pg_trigger`.

⚠️ O teste de integração `auditoria-recebimento-fiscal.test.ts` (`ATLAS_DB_INTEGRATION=1`) faz INSERT/UPDATE/DELETE de verdade: rode só contra banco descartável, **nunca** contra o UAT.

**E-mails ao fiscal no UAT**: o UAT roda como produção (SendGrid ligado). Durante a validação, ponha `STOCKBRIDGE_FISCAL_EMAILS=<sua caixa>` na stack — os cenários 4 (dispensa e desfazer) mandam avisos ao fiscal. Vazio = lista padrão (fiscal real). **Alerta do espelho**: no UAT o espelho chega pela cópia PROD→UAT, mais lenta que o n8n — use `STOCKBRIDGE_ESPELHO_RECEBIMENTOS_MAX_MIN=360` (PROD: 120, o default).

**Ordem do deploy no UAT** (revisão pré-UAT): (1) DDL do espelho no PROD (DBeaver, bloco do contrato do espelho, literal); (2) 0053 no UAT; (3) workflow n8n testado e ativado; (4) imagem nova com a flag **desligada** e as duas variáveis novas acrescentadas ao YAML da stack (a stack lista cada variável — só preencher o env não basta); conferir `OMIE_MODE=real` antes do redeploy; (5) snapshot da fila; (6) flag ligada e conferência do snapshot (SC-006).

`.env`: `MODULE_STOCKBRIDGE_ENABLED=true`, `STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE=<data>`, **`STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=true`** (default é `false`); `STOCKBRIDGE_FISCAL_EMAILS` opcional (default: NFe ACXE, Mauricio Yared, Gustavo Dreer — em dev, aponte para a sua caixa para não disparar ao fiscal real). Em dev, `OMIE_MODE=mock`: o mock tem recebimentos na etapa 40 injetáveis por teste (`__injectMockRecebimentoNfe`). Em UAT, `OMIE_MODE=real` (atenção ao redeploy que reverte para mock — memória `uat-omie-mode-reverte-no-redeploy`).

**Espelho**: o workflow n8n "Q2P - Exporta Recebimentos NF-e" precisa estar ativo (contrato `contracts/espelho-recebimentos-n8n.md`) e, no UAT, a cópia `scripts/sync-omie-public-prod-to-uat.sh` precisa já incluir as tabelas (acontece sozinho quando existem em PROD e UAT). Sem espelho, a fila mostra só "fiscal já feito" — e isto é o Cenário 5.

> ⚠️ Toda NF usada nos cenários 1–3 sofre **escrita fiscal real no OMIE** (conta a pagar incluída). Use NFs que vão **mesmo** ser recebidas, combinadas com o fiscal. Reverter no OMIE (`ReverterRecebimento`) um fiscal concluído pelo Atlas deixa o Atlas mostrando "fiscal já feito" para sempre (ledger terminal — research, "Limitações conhecidas"): o fiscal precisa reconcluir no portal. Não use a reversão como "volta" de teste.

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

a. **Duplo clique**: dispare dois POSTs concorrentes. Aceitos: `409 RECEBIMENTO_FISCAL_EM_ANDAMENTO` (o segundo caiu durante as chamadas ao OMIE), `409 NF_JA_PROCESSADA` (caiu depois da gravação) ou `201` com `fiscal.status = "ja_concluido"` e produtos `ja_recebido` — desde que haja **uma** linha `concluido` no ledger e nenhuma movimentação em dobro.

b. **Fiscal falhando** (UAT com `OMIE_MODE=real`): troque temporariamente `OMIE_Q2P_SECRET` por um valor inválido e confirme uma NF pendente. Esperado: `502 RECEBIMENTO_FISCAL_FAIL`, mensagem com NF e fornecedor, **zero** `INSERT` em `movimentacao`/`aprovacao`, linha `falha` no ledger com `passo_falha='consultar'` (a primeira chamada a falhar é a `ConsultarRecebimento`) e `erro_omie_*` preenchidos. Restaure o secret; repita: `201`. Falha **depois** de uma escrita (EDITAR/IGNORAR/Concluir) faz a próxima tentativa responder `409 RECEBIMENTO_FISCAL_AGUARDE` por até 70 s — a tela mostra "Tentar novamente em N s".

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

- **Flag desligada** (`STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=false`): a fila lista exatamente as NFs da 015, sem selo; o POST devolve `fiscal.status = "desligado"` e não toca o OMIE; `POST …/dispensar`, `GET …/dispensas` e `GET …/fiscal` → `403`.
- **Flag ligada, espelho vazio**: a fila lista as mesmas NFs, agora com o selo "Fiscal já feito"; o POST devolve `fiscal.status = "nao_aplicavel"`; a dispensa funciona; o health do módulo fica `degraded` (`recebimentoNfeEspelho.status = "sem_dados"`).

Compare a lista com um snapshot tirado antes de ligar a flag (SC-006).

## Cenário 6 — Edge cases rápidos

- NF pendente **cancelada** no OMIE depois de aparecer: após o sync, some da fila; se já aberta, o POST devolve `422 NF_CANCELADA`.
- NF pendente **sem fornecedor cadastrado** (caso real: NF 1257, chave `31261038467346000258550010000012571279398231`): aparece como "Fornecedor não identificado no OMIE", a tela avisa e o botão de confirmar fica desabilitado; um POST direto devolve `422 RECEBIMENTO_FISCAL_SEM_FORNECEDOR` sem abrir ledger nem chamar o OMIE. O OMIE manda `nIdFornecedor: 0` (não nulo) nesse caso.
- NF pendente em **outra etapa, bloqueada ou devolvida**: não aparece como pendente; se o estado mudar com a nota aberta, o POST devolve `422 RECEBIMENTO_FISCAL_ETAPA_INESPERADA` sem escrever no OMIE.
- **Baixa por recebimento externo** em NF com fiscal pendente: o link não aparece; um POST direto devolve `409 BAIXA_EXTERNA_FISCAL_PENDENTE`.
- Itens **todos bloqueados por unidade**: o POST não dispara o fiscal (`nao_aplicavel`), a NF segue "Fiscal pendente".

## Testes automatizados

```bash
pnpm --filter @atlas/integration-omie test     # recebimento-nfe (mock com estado)
pnpm --filter @atlas/stockbridge test          # recebimento-fiscal, fila-unificada, nf-dispensa, regressão 015
ATLAS_DB_INTEGRATION=1 pnpm --filter @atlas/stockbridge test -- audit   # trigger de auditoria das 2 tabelas novas
```
