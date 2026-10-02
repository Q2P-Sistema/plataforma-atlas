# Contract — Espelho dos Recebimentos de NF-e (n8n → Postgres)

**Feature**: `016-recebimento-fiscal-nf` | **Dependência**: workflow n8n **novo** "Q2P - Exporta Recebimentos NF-e - Rev 1.0", a ser criado e documentado no repositório `backup-workflow-n8n` (specs/<id>/spec.md, padrão do `qw7QTeHv3LCVag0s`).

Este documento é o contrato entre o Atlas (leitor) e o n8n (escritor). Serve também de prompt para o agente que mantém os workflows.

---

## 1. Tabelas (DDL canônica — a mesma da migration Atlas `0053`)

Escritas **só** pelo n8n. Lidas pelo Atlas via `getPool()`. Dono: `postgres` (mesmo das demais `tbl_*_Q2P`). No PROD, enquanto o Atlas não roda migrations (go-live pendente), criar com esta DDL via DBeaver, como `tbl_sync_debounce`.

```sql
CREATE TABLE IF NOT EXISTS public."tbl_recebimentoNFe_Q2P" (
  n_id_receb           BIGINT PRIMARY KEY,
  c_chave_nfe          VARCHAR(44) NOT NULL,
  c_numero_nfe         VARCHAR(20),
  c_serie_nfe          VARCHAR(5),
  c_modelo_nfe         VARCHAR(3),
  d_emissao            DATE,
  n_id_fornecedor      BIGINT,
  c_cnpj_cpf           VARCHAR(20),
  c_razao_social       VARCHAR(255),
  c_nome               VARCHAR(255),
  c_natureza_operacao  VARCHAR(60),
  n_valor_nfe          NUMERIC(14,2),
  c_etapa              VARCHAR(2),
  c_recebido           CHAR(1),
  c_cancelada          CHAR(1),
  c_faturado           CHAR(1),
  c_bloqueado          CHAR(1),
  c_devolvido          CHAR(1),
  d_inc DATE, h_inc VARCHAR(8),
  d_alt DATE, h_alt VARCHAR(8),
  d_rec DATE, h_rec VARCHAR(8), c_usuario_rec VARCHAR(30),
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "tbl_recebimentoNFe_Q2P_chave_idx" ON public."tbl_recebimentoNFe_Q2P" (c_chave_nfe);
CREATE INDEX IF NOT EXISTS "tbl_recebimentoNFe_Q2P_pendente_idx" ON public."tbl_recebimentoNFe_Q2P" (c_recebido, c_cancelada);
CREATE INDEX IF NOT EXISTS "tbl_recebimentoNFe_Q2P_emissao_idx" ON public."tbl_recebimentoNFe_Q2P" (d_emissao);

CREATE TABLE IF NOT EXISTS public."tbl_recebimentoNFe_itens_Q2P" (
  n_id_receb               BIGINT NOT NULL REFERENCES public."tbl_recebimentoNFe_Q2P"(n_id_receb) ON DELETE CASCADE,
  n_sequencia              INTEGER NOT NULL,
  c_descricao_produto      VARCHAR(500),
  c_codigo_produto         VARCHAR(60),
  c_ncm                    VARCHAR(10),
  c_cfop                   VARCHAR(10),
  c_cfop_entrada           VARCHAR(10),
  n_qtde_nfe               NUMERIC(14,4),
  c_unidade_nfe            VARCHAR(10),
  n_preco_unit             NUMERIC(18,6),
  v_total_item             NUMERIC(14,2),
  v_desconto               NUMERIC(14,2),
  c_ignorar_item           CHAR(1),
  c_associar_existente     CHAR(1),
  c_adicionar_novo         CHAR(1),
  n_id_item                BIGINT,
  n_id_produto             BIGINT,
  c_nao_gerar_mov_estoque  CHAR(1),
  c_nao_gerar_financeiro   CHAR(1),
  n_qtde_recebida          NUMERIC(14,4),
  codigo_local_estoque     BIGINT,
  synced_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (n_id_receb, n_sequencia)
);
```

## 2. Fonte OMIE

Endpoint `https://app.omie.com.br/api/v1/produtos/recebimentonfe/`, método `ListarRecebimentos`, credencial "Omie Q2P" (`1BKrU6xm8F94LUXo`). **Sempre** `cExibirDetalhes: "S"` — sem ele não vêm `itensRecebimento` nem `infoCadastro` (verificado em 02/10/2026).

Resposta: `{ nPagina, nTotalPaginas, nRegistros, nTotalRegistros, recebimentos: [ { cabec, infoCadastro, itensRecebimento[], parcelas, totais, transporte, infoAdicionais } ] }`.

Mapeamento cabeçalho: `cabec.nIdReceb → n_id_receb`, `cabec.cChaveNFe → c_chave_nfe` (atenção: **F maiúsculo**), `cabec.cNumeroNFe`, `cSerieNFe`, `cModeloNFe`, `dEmissaoNFe` (dd/mm/aaaa → ISO), `nIdFornecedor`, `cCNPJ_CPF`, `cRazaoSocial`, `cNome`, `cNaturezaOperacao`, `nValorNFe`, `cEtapa`; `infoCadastro.cRecebido/cCancelada/cFaturado/cBloqueado/cDevolvido/dInc/hInc/dAlt/hAlt/dRec/hRec/cUsuarioRec`. Campos ausentes → `NULL` (fornecedor pode faltar).

Mapeamento item (`itensRecebimento[i]`): `itensCabec.nSequencia`, `cDescricaoProduto`, `cCodigoProduto`, `cNCM`, `cCFOP`, `nQtdeNFe`, `cUnidadeNfe`, `nPrecoUnit`, `vTotalItem`, `vDesconto`, `cIgnorarItem`, `cAssociarExistente`, `cAdicionarNovo`, `nIdItem`, `nIdProduto`; `itensAjustes.cCFOPEntrada`, `cNaoGerarMovEstoque`, `cNaoGerarFinanceiro`, `nQtdeRecebida`, `codigo_local_estoque`.

Decodificar entidades HTML/XML em `c_razao_social`, `c_nome`, `c_descricao_produto` (mesmo `decodeEnt` do Achata da Rev 1.8 — ACXEGDP-330).

## 3. Rodada (a cada 30 min)

Cron `0 23,53 * * * *` (minutos :23 e :53 — fora de :08/:38 do sync de NF, :13 da FUP e :20 do cron do Atlas). Trava em `public.tbl_sync_debounce`, chave `receb_q2p_incremental` (claim atômico, expira em 90 min; pular a rodada se o FullSync de NF `nf_q2p_fullsync` estiver ativo — mesmo SQL do `Tenta_Claim` da Rev 1.8). `errorWorkflow` `5gZ5lxxMUFeLMoCs`. Retry-chain nas HTTPs (`onError=continueRegularOutput → IF(!!$json.error) → Wait 90 s → Retry → IF → Wait 300 s → Retry2`), `retryOnFail` desligado.

**Duas passagens por rodada** (research D5):

| Passagem | Parâmetros | Para quê |
|---|---|---|
| A — alterados | `dtAltDe = TO_CHAR(COALESCE(MAX(synced_at), now()-'3 days')::date - 2, 'DD/MM/YYYY')`, `dtAltAte = hoje`, `cExibirDetalhes: "S"`, `nRegistrosPorPagina: 100`, paginar por `nTotalPaginas` | conclusões, cancelamentos, mudanças de etapa |
| B — pendentes | `cEtapa: "40"`, `cExibirDetalhes: "S"`, `nRegistrosPorPagina: 100`, sem data | NF recém-chegada da SEFAZ (pode não ter `dAlt`); ~8 registros em 60 dias |

Passagem A primeiro, B depois (B sobrescreve com o estado mais recente para as pendentes). Upsert de cabeçalho **antes** dos itens (FK). Reconciliação antes do upsert do cabeçalho:

```sql
DELETE FROM public."tbl_recebimentoNFe_Q2P" r USING (VALUES …) AS v(n_id_receb, c_chave_nfe)
 WHERE r.c_chave_nfe = v.c_chave_nfe AND r.n_id_receb <> v.n_id_receb;
```

`ON CONFLICT (n_id_receb) DO UPDATE SET … , synced_at = now()`; itens `ON CONFLICT (n_id_receb, n_sequencia) DO UPDATE`. Dedupe defensivo de itens por `(n_id_receb, n_sequencia)` antes de montar o SQL.

Duração esperada: 2–4 chamadas OMIE, < 30 s sem o Wait do padrão antigo (não é necessário Wait fixo de 60 s aqui; se adotado por paridade, manter < 65 s — ACXEGDP-319).

## 4. O que o Atlas assume

1. `c_recebido = 'N' AND c_cancelada = 'N'` ⇔ fiscal pendente.
2. `c_chave_nfe` única e preenchida (44 dígitos) em toda linha.
3. `v_total_item` = valor do item com tributos uma vez (equivale a `v_prod` do espelho de NF — não há campo com IPI em dobro nesta fonte).
4. `c_cfop_entrada` é o CFOP de entrada (recorte 1.101/1.102/2.101/2.102); `c_cfop` é o do fornecedor e **não** é usado.
5. Latência máxima de 30 min entre a mudança no OMIE e o espelho (PROD). No UAT a latência é a do `sync-omie-public-prod-to-uat.sh`.
6. O espelho nunca é fonte de verdade de "já recebido fisicamente" — isso é do Atlas (`stockbridge.movimentacao`).

## 5. Validação de aceite do workflow

- Primeira rodada: `SELECT c_etapa, c_recebido, c_cancelada, count(*) FROM public."tbl_recebimentoNFe_Q2P" GROUP BY 1,2,3` traz as 8 linhas na etapa 40 da sonda de 02/10/2026 (ou o estado atual) e as alteradas na janela.
- Após concluir um fiscal pelo Atlas: na rodada seguinte, a linha da NF passa a `c_recebido = 'S'`, `c_etapa = '60'`, `c_usuario_rec = 'WEBSERVICE'`, itens com `c_ignorar_item = 'S'` e `c_nao_gerar_mov_estoque = 'S'`.
- Nenhuma linha com `c_chave_nfe` nula; nenhuma chave duplicada.
- Spec do workflow no `backup-workflow-n8n` com: motivo (ACXEGDP-395), DDL, mapeamento, cron, trava, e a nota de que `dtAlt` pode não alcançar recém-criados (razão da passagem B).
