# Contract — Espelhos de recebimentos de NF-e (n8n)

**Feature**: `017-recebimento-nacional-com-pc` | **Repositório dos workflows**: `backup-workflow-n8n`

Este documento é o prompt para a sessão dos workflows. A DDL canônica está nas migrations `0056` (Q2P) e `0058` (ACXE, Fase 2) do Atlas (`ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`). O n8n pode aplicá-la antes, porque o texto é o mesmo.

## 1. "Q2P - Exporta Recebimentos NF-e": gravar o vínculo com o PC (Histórias 1 a 4)

Workflow existente da feature 016 (`ListarRecebimentos` com `cExibirDetalhes = 'S'`, duas passagens: por `dtAlt` e por `cEtapa = 40`). Nova revisão:

1. **DDL** (idempotente):
   ```sql
   ALTER TABLE public."tbl_recebimentoNFe_itens_Q2P"
     ADD COLUMN IF NOT EXISTS n_id_pedido bigint,
     ADD COLUMN IF NOT EXISTS n_id_it_pedido bigint,
     ADD COLUMN IF NOT EXISTS n_num_ped_compra varchar(15),
     ADD COLUMN IF NOT EXISTS c_num_it_ped_compra integer;
   ```
2. **Mapeamento por item** (`itensRecebimento[]`):
   - `n_id_pedido` ← `itensCabec.nIdPedido` quando `> 0`, senão `NULL`;
   - `n_id_it_pedido` ← `itensCabec.nIdItPedido` **só quando** `nIdPedido > 0`. Sem vínculo, o OMIE repete o `nIdItem` nesse campo (NF 7736), então gravar `NULL`;
   - `n_num_ped_compra` ← `itensInfoAdic.nNumPedCompra` (texto, `trim`; vazio → `NULL`);
   - `c_num_it_ped_compra` ← `itensInfoAdic.cNumItPedCompra` (inteiro; ausente → `NULL`).
3. **Upsert**: as quatro colunas entram no `ON CONFLICT … DO UPDATE` como as demais, para que um vínculo feito ou desfeito depois chegue à cópia.
4. **Validação**: a NF 7813 da Replas (recebimento 8517930857) deve ficar com `n_id_pedido` 8516905979, `n_id_it_pedido` 8516907022, `n_num_ped_compra` '304' e `c_num_it_ped_compra` 1, mesmo concluída (o `dtAlt` de 21/10 traz a linha).
5. Sticky note com referência à ACXEGDP-437.
6. **Sinal do fiscal revertido (D21 da 017)**: o Atlas compara `c_recebido` e `d_alt`/`h_alt` (hora do evento no OMIE, Brasília) do recebimento com a conclusão do fiscal, e usa `d_rec`/`h_rec` do recebimento `S` como hora de conclusão (concluir no portal não mexe em `d_alt`). Nenhuma mudança de workflow, mas o upsert precisa continuar gravando essas colunas a cada rodada, **sem** `WHERE … IS DISTINCT FROM` em `c_recebido`, `d_alt`, `h_alt`, `d_rec` ou `h_rec` (a 016 já exige o mesmo para `synced_at`), e é a passagem A (`dtAlt` até 2 dias atrás) que traz a NF revertida. Validação: a NF 19252 (Zaraplast), revertida no portal em 25/10/2026 às 17:13:36, aparece com `c_etapa = '40'`, `c_recebido = 'N'` e `d_alt`/`h_alt` = a hora da reversão (a rodada de 17:23 já a trouxe), com os 4 itens mantendo `c_nao_gerar_mov_estoque = 'S'` e o vínculo de pedido.

## 2. "ACXE - Exporta Recebimentos NF-e" (novo, História 5)

Cópia do workflow da Q2P, com:

- credencial **Omie ACXE**;
- tabelas `public."tbl_recebimentoNFe_ACXE"` e `"_itens_ACXE"` (DDL da 0058: a mesma das tabelas da Q2P, já com as colunas do §1);
- chave própria em `tbl_sync_debounce` e o mesmo padrão de retentativa;
- mesmos horários da Q2P, defasados alguns minutos para não somar chamadas ao mesmo tempo;
- **batimento a cada rodada** (revisão da Fase 2, 23/10/2026): ao fim de toda execução, mesmo sem linha nova, gravar `public.tbl_sync_debounce` com `chave = 'receb_acxe'` e `ultima_execucao_inicio = now()` (upsert pela chave). Com poucas NFs na ACXE, `MAX(synced_at)` do espelho para de andar sem falha do n8n (ele só regrava as linhas que a rodada trouxe); o health do Atlas usa o mais recente dos dois sinais, e sem o batimento o espelho da ACXE apareceria defasado em período calmo (health `degraded` e aviso ao ops a cada 6 h);
- **histórico**: sincronizar também os recebimentos já concluídos (`c_recebido = 'S'`), como a Q2P — é o que permite ao Atlas reconhecer NF recebida no portal com estoque. A D21 da 017 usa o mesmo histórico como evidência de conclusão (`c_recebido = 'S'` com `d_alt`/`h_alt`), e vale para o workflow da ACXE o cuidado do §1, item 6, de gravar `c_recebido`, `d_alt` e `h_alt` a cada rodada.

Só ativar quando a História 5 for implantada. Até lá, a tabela pode existir vazia.

## 3. Cópia de PCs (já entregue)

A Rev 1.5 do `qPJFEIY1PQ2LDQG2` está no ar desde 21/10/2026. Esta feature depende dela e não pede mudança.

## 4. Espelho de itens de NF: uma linha por linha da NF (T102, entregue em 27/10/2026)

O OMIE dá o mesmo `nCodItem` às linhas da NF ligadas ao mesmo item de pedido de compra, e a NF com PC é o caso desta feature. O espelho `tbl_nf_itens_Q2P` / `_ACXE` / `_Q2P_Filial` guarda cada linha:

- chave `(n_id_nf, n_item)`, com `n_item` = posição da linha no `det[]` do `ListarNF` (1..N); `(n_id_nf, n_cod_item)` é índice não único;
- gravação por NF num só comando: `DELETE` das posições acima do total e `INSERT ... ON CONFLICT (n_id_nf, n_item) DO UPDATE`;
- o `det[]` vem em ordem crescente de `nCodItem`, não na sequência do XML. Quem liga a linha da NF à sequência do recebimento usa o `nCodItem` (`n_id_item` do recebimento concluído) e, quando ele se repete, a ordem dentro do mesmo código (`sequenciaItemNfSql`).

Fluxos, DDL e validação no repositório dos fluxos (`specs/437-espelho-itens-nf/`, `docs/migration-nf-itens-posicao-2026-10-27.sql`). O UAT precisa do mesmo DDL antes de receber dados do PROD (o sync só copia dados).
