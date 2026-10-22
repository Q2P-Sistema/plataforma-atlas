# Quickstart — Recebimento Nacional com Pedido de Compra

**Feature**: `017-recebimento-nacional-com-pc`

## Pré-requisitos

1. Migration `0056` aplicada, só o arquivo dela (o repo não usa o runner do drizzle-kit, e `scripts/apply-migrations-*.sh` reaplicam todas as migrations e não servem num banco em uso). Num banco de dev, `psql` local. No UAT vivo e em PROD, com o dono dos objetos `stockbridge.*`; o psql pede a senha:

   ```bash
   # UAT:  -h db.manager01.q2p.com.br -p 5437 -U postgres
   # PROD: -h db.manager01.q2p.com.br -p 5432 -U "$PROD_USER"   (o PROD_USER da janela de go-live; em 22/10/2026 o dono é `postgres`)
   PGOPTIONS='-c lock_timeout=5s' psql -h <host> -p <porta> -U <usuario> -d acxe_q2p \
     -1 -q -v ON_ERROR_STOP=1 -f packages/db/migrations/0056_stockbridge_recebimento_nacional_pc.sql
   echo "exit=$?"
   ```

   - Esperado: `exit=0` e nenhuma linha `ERROR`. `NOTICE` é normal: `trigger ... does not exist, skipping` na 1ª execução e, do bloco `DO` do começo da migration, `as 4 colunas de pedido do espelho ... já existem — tabela não alterada`. O bloco só faz o `ALTER` da tabela do espelho quando falta alguma das 4 colunas (em PROD já existem, e um `ALTER` mesmo sem efeito pediria `ACCESS EXCLUSIVE` na tabela que a fila lê ao vivo).
   - `exit=3` ou `ERROR: canceling statement due to lock timeout`: nada foi aplicado (`-1` = tudo ou nada; sem `ON_ERROR_STOP=1` o psql desfaria tudo e sairia com 0). Achar quem segura o lock em `pg_stat_activity`, esperar a transação terminar e repetir o mesmo comando: a migration é idempotente.
   - Conferir (somente leitura): os dois `to_regclass` não nulos, `colunas_ledger = 2`, `triggers = 2`.

     ```sql
     SELECT to_regclass('stockbridge.recebimento_fiscal_pc'),
            to_regclass('stockbridge.nf_aviso_compras'),
            (SELECT count(*) FROM information_schema.columns
              WHERE table_schema = 'stockbridge' AND table_name = 'recebimento_fiscal'
                AND column_name IN ('empresa', 'itens_vinculados')) AS colunas_ledger,
            (SELECT count(*) FROM pg_trigger
              WHERE tgname IN ('trg_audit_sb_recebimento_fiscal_pc', 'trg_audit_sb_nf_aviso_compras')
                AND NOT tgisinternal) AS triggers;
     ```

   - Em PROD, esta conferência vem antes de subir a imagem (`docs/prod-golive-runbook.md`, seção "Ativação da feature 017", passo 1).
2. Workflow "Q2P - Exporta Recebimentos NF-e" com as colunas de pedido (`contracts/espelhos-n8n.md` §1), validado na NF 7813.
3. Cópia de PCs na Rev 1.5 (`qPJFEIY1PQ2LDQG2`), no ar desde 21/10/2026.
4. Variáveis de ambiente:
   - `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=true`, **só** com a imagem que contém a 017;
   - `STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC=true`;
   - `STOCKBRIDGE_COMPRAS_EMAILS`, com os destinatários de compras, separados por vírgula (sem ponto e vírgula): valor inválido derruba a API no boot;
   - `STOCKBRIDGE_COPIA_PCS_MAX_MIN` (default 120), a idade máxima da cópia de PCs antes do alerta e do modo seguro (research D13). No UAT, calibrar pela frequência com que a cópia chega lá (o espelho de recebimentos usa 360): com o limite curto demais, o modo seguro recusa toda NF com fiscal pendente.
5. Teste do vínculo novo (research D2) feito com NF real e autorização do usuário **antes** de ligar a chave em PROD.
6. No UAT (`OMIE_MODE=leitura`): as escritas são simuladas. A sombra precisa refletir a associação e o `nQtdeRec` do PC.

> **Ordem de deploy em PROD**: 0056 → imagem com a 017 → teste D2 → religar `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED`. A 0056 vem antes da imagem: é aditiva e convive com a imagem atual, e a 017 lê as colunas novas (sem elas, a fila responde 503). O n8n com as colunas está no ar desde 21/10/2026. Religar a chave com uma imagem anterior à 017 volta o `IGNORAR`, que é o problema original. Passo a passo em `docs/prod-golive-runbook.md`, seção "Ativação da feature 017".

## Cenário 1 — Item com vínculo do OMIE (História 1 e 2, P1)

Base: uma NF de teste (UAT, sombra do modo leitura, ou mock) com o item já vinculado a um PC aprovado com saldo — o modelo é o caso da NF 7813 × PC 304, que em PROD já foi concluída no teste de 21/10/2026 e não serve mais como NF pendente.

1. Abrir a fila: a NF aparece com o selo "PC vinculado no OMIE".
2. Abrir o detalhe: o item mostra o PC 304 como vínculo do OMIE e pré-selecionado.
3. Confirmar, com a correlação do produto e o local.
4. Conferir no OMIE:
   - recebimento na etapa 60, com o item vinculado ao PC 304 e "não movimentar estoque";
   - conta a pagar gerada;
   - PC 304 com o `nQtdeRec` atualizado;
   - nenhum movimento de estoque da NF em `ListarMovimentoEstoque`.
5. No Atlas: uma movimentação por produto e uma linha `concluido` em `recebimento_fiscal_pc` com `origem = 'omie'`. A NF não volta à fila depois do sync (descrição trocada, reconhecida pela sequência).

## Cenário 2 — Item sem vínculo, com candidato (História 1 e 2, P1)

1. NF de fornecedor com um PC na etapa 15, quantidade dentro de 2% do saldo e preço dentro de 1%. O detalhe mostra o PC como sugestão.
2. Confirmar. O Atlas faz `ASSOCIAR-PEDIDO` → `EDITAR` → `Concluir`.
3. Conferir como no cenário 1, com `origem = 'sugestao'`.
4. Com dois PCs iguais (como o 302 e o 304): os dois aparecem e nada vem pré-selecionado. Sem escolha, o botão fica desabilitado.
5. Com o número do pedido na NF: o PC correspondente aparece em primeiro.

## Cenário 3 — Escolha manual e troca do vínculo do OMIE (FR-002a, FR-007)

1. NF 4% acima do saldo do único PC: o PC aparece em "Outros PCs do fornecedor". Escolher sem justificativa → `422 PC_JUSTIFICATIVA_OBRIGATORIA`. Com justificativa → `origem = 'manual'`, com a justificativa gravada.
2. Item com vínculo do OMIE trocado para outro PC: justificativa obrigatória. `n_cod_ped_omie_anterior` fica gravado e o OMIE termina vinculado ao PC escolhido.
3. Item com vínculo do OMIE fora da tolerância (quantidade ou preço) e mantido pelo operador: sem justificativa → `422 PC_JUSTIFICATIVA_OBRIGATORIA`; com justificativa, gravado com `origem = 'omie'` e `dentro_tolerancia = false` (matriz do `data-model.md` §4).

## Cenário 4 — NF sem PC (História 3)

1. `EXIGE_PC=true` e fornecedor sem PC na etapa 15:
   - o detalhe mostra "nenhum PC encontrado" e o motivo;
   - o POST responde `422 NF_SEM_PC`;
   - nada é gravado;
   - compras recebe um e-mail;
   - uma segunda tentativa no mesmo dia não manda outro e-mail.
2. PC do fornecedor só na etapa 10: o item mostra "PC aguardando aprovação" e não pode ser selecionado.
3. `EXIGE_PC=false`: o recebimento conclui o fiscal com `IGNORAR` só nesse item, os itens com PC mantêm o vínculo, e compras é avisado com o motivo `recebida_sem_vinculo`.
4. Item com PC possível (vínculo do OMIE, candidato ou outro PC do fornecedor) enviado sem escolha: `422 PC_NAO_ESCOLHIDO` nos dois modos de `EXIGE_PC`, sem gravar nada e sem e-mail a compras.

## Cenário 5 — Estoque já lançado pelo OMIE (FR-021a, vale com a chave desligada)

1. Desligar `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` (contenção).
2. Usar uma NF concluída no portal **sem** "não movimentar estoque". No UAT, injetar no espelho `c_recebido='S'`, `c_ignorar_item='N'`, `c_nao_gerar_mov_estoque='N'`.
3. O detalhe mostra o aviso, e o POST responde `409 ESTOQUE_JA_LANCADO_PELO_OMIE` sem gravar nada.
4. NF concluída no portal **com** "não movimentar estoque" e vínculo: o detalhe mostra o selo de PC vinculado no OMIE — com o número quando o PC ainda está na cópia ou foi vinculado pelo Atlas; a NF 7813 mostra "PC vinculado no OMIE" sem número, porque o PC 304 já saiu da cópia — e o recebimento faz só o estoque.
5. Com a chave ligada: NF que a tela mostrava com fiscal pendente e foi concluída no portal **sem** "não movimentar estoque" antes da confirmação (no UAT, mock de `ConsultarRecebimento` com `cRecebido='S'` e o item sem "não movimentar estoque"): o POST responde `409 ESTOQUE_JA_LANCADO_PELO_OMIE` sem gravar nada (ramo `ja_concluido`, research D7).

## Cenário 6 — Falhas e repetições (História 4)

1. Falha no `ASSOCIAR-PEDIDO` (mock): `502`, nada gravado, linha de `recebimento_fiscal_pc` em `falha`. Nova tentativa depois de 70 s conclui.
2. Associação feita e conclusão com falha: a nova tentativa reconhece o vínculo e não repete o `ASSOCIAR-PEDIDO`.
3. Duplo clique: `409 RECEBIMENTO_FISCAL_EM_ANDAMENTO`, como na 016.
4. Duas NFs no mesmo item de PC em menos de 75 s: a segunda recebe `409 PC_RECEM_USADO_AGUARDE`.
5. PC consumido entre abrir a tela e confirmar (mock de `ConsultarPedCompra` com saldo 0): `409 PC_VINCULO_INVALIDO`.
6. Vínculo mudado no OMIE entre abrir e confirmar: `409 VINCULO_OMIE_MUDOU`.
7. Rejeição do gestor por divergência: o fiscal e o vínculo continuam, e a NF volta como "fiscal já feito".
8. Cópia de PCs defasada (mais velha que `STOCKBRIDGE_COPIA_PCS_MAX_MIN`, ou vazia): o health do módulo fica `degraded` com `pedidosCompraCopiaIdadeMin`, o cron alerta `STOCKBRIDGE_OPS_EMAIL`, o detalhe mostra "lista de pedidos de compra desatualizada" sem sugestão, e o POST de NF com fiscal pendente responde `503 COPIA_PCS_DEFASADA`, sem gravar nada e sem e-mail a compras.
9. Duas NFs confirmadas ao mesmo tempo no mesmo item de PC, com saldo que não cobre as duas: a segunda vê a reserva da primeira e recebe `409 PC_VINCULO_INVALIDO`. Com saldo para as duas, as duas concluem.

## Cenário 7 — Regressões

1. Baixa do PC Q2P da importação (ACXEGDP-344): receber uma NF filhote em UAT e conferir a baixa no PC-espelho certo. Nenhum PC nacional pode aparecer como candidato.
2. PC-espelho de importação (fornecedor ACXE, abaixo de R$ 200) nunca aparece na sugestão.
3. Com a chave da 016 desligada, a fila, o detalhe e o POST se comportam como na contenção, mais os cenários 5.1 e 5.4.
4. Cockpit e pendências fiscais: com um PC da ACXE recebido em parte injetado na cópia, contam o saldo e não a quantidade cheia. O trânsito (função `refresh_lotes_em_transito_se_stale` da 0037) não muda nesta feature e segue contando a quantidade cheia (limitação registrada em research D10).

## Cenário 8 — Compra nacional pela ACXE (História 5, fase 2)

Pré-requisitos: 0057, workflow "ACXE - Exporta Recebimentos NF-e" e `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED=true`.

1. A NF da ACXE aparece na fila identificada pela empresa. A NF Q2P→ACXE não aparece.
2. Fiscal com vínculo no OMIE da ACXE (mesma receita).
3. Local espelhado: a entrada é lançada na ACXE e na Q2P com **o mesmo valor unitário**, sem os 14,5%, e sem divergência nova na Conferência de Estoque.
4. Material chegando a Extrema: local 21.1 EXTREMA. A entrada vai para o 21.1 da ACXE e o 21.1 da Q2P, e o produto aparece disponível para venda na Q2P.
5. Nenhuma baixa de PC na Q2P.

## Testes automatizados

- `packages/integrations/omie/src/__tests__/recebimento-nfe.test.ts`: `ASSOCIAR-PEDIDO`, parse de `nIdPedido`/`itensInfoAdic`, mock com associação e `nQtdeRec`.
- `modules/stockbridge/src/__tests__/`:
  - `pc-sugestao.test.ts` (novo): tolerâncias, ordenação, empates, número do pedido, PC-espelho, etapa 10, vínculos divergentes por sequência;
  - `recebimento-fiscal-pc.test.ts` (novo): receitas D1/D2, `IGNORAR` só em item sem PC, idempotência, releitura com o saldo ao vivo, reserva entre duas NFs, "PC recém-usado", `VINCULO_OMIE_MUDOU` só quando o vivo difere do visto e do escolhido, `ESTOQUE_JA_LANCADO_PELO_OMIE` no ramo `ja_concluido`;
  - `recebimento-nacional-pc.test.ts` (novo): portão 1 com `NF_SEM_PC` nos dois modos, `PC_NAO_ESCOLHIDO`, `COPIA_PCS_DEFASADA`, estoque já lançado, aviso deduplicado;
  - `alerta-espelho-recebimentos.test.ts` (estender): cópia de PCs velha, vazia e em dia;
  - `recebimento-nacional-nf.routes.test.ts` (estender): o schema `.strict()` aceita `itens[].pc` e recusa campos extras;
  - `fila-nacional-unificada.test.ts` (estender): `pcSituacao`, `estoqueLancadoPeloOmie`;
  - `recebimento-nacional-flag-off.test.ts` (estender): contenção + FR-021/021a;
  - auditoria (integração, `ATLAS_DB_INTEGRATION=1`): triggers de `recebimento_fiscal_pc` e `nf_aviso_compras`;
  - `cockpit`/`pendencias-fiscais` (estender): saldo com `nqtderec`.
