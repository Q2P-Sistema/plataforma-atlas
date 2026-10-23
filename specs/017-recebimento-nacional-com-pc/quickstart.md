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
   - **Migration `0057`** (cache de PCs vistos, rodada de 22/10/2026), também só o arquivo dela, com o mesmo comando e `-f packages/db/migrations/0057_stockbridge_pedido_compra_visto.sql`. É aditiva (`CREATE TABLE IF NOT EXISTS`, sem alterar tabela existente) e idempotente. Vai antes da imagem desta rodada: sem a tabela nada deixa de funcionar (a sugestão registra um aviso e segue só com a cópia), mas o detalhe perde o PC que sai da lista de pendentes e o número do PC das NFs com fiscal já feito. Conferência (somente leitura): `to_regclass` não nulo e `triggers = 1`.

     ```sql
     SELECT to_regclass('stockbridge.pedido_compra_visto'),
            (SELECT count(*) FROM pg_trigger
              WHERE tgname = 'trg_audit_sb_pedido_compra_visto' AND NOT tgisinternal) AS triggers;
     ```
2. Workflow "Q2P - Exporta Recebimentos NF-e" com as colunas de pedido (`contracts/espelhos-n8n.md` §1), validado na NF 7813.
3. Cópia de PCs na Rev 1.5 (`qPJFEIY1PQ2LDQG2`), no ar desde 21/10/2026.
4. Variáveis de ambiente:
   - `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=true`, **só** com a imagem que contém a 017;
   - `STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC=true`;
   - `STOCKBRIDGE_COMPRAS_EMAILS`, com os destinatários de compras, separados por vírgula (sem ponto e vírgula): valor inválido derruba a API no boot;
   - `STOCKBRIDGE_PC_UNIDADE_DIFERENTE` (default `bloquear`): PC em unidade diferente da NF (research D15). `converter` só depois do teste com NF real do cenário 10.
   - `STOCKBRIDGE_COPIA_PCS_MAX_MIN` (default 120), a idade máxima da cópia de PCs antes do alerta e do modo seguro (research D13). No UAT, calibrar pela frequência com que a cópia chega lá (o espelho de recebimentos usa 360): com o limite curto demais, o modo seguro recusa toda NF com fiscal pendente.
5. Teste do vínculo novo (research D2): **feito em 22/10/2026 (T033, NF 60199)** e aprovado, antes de religar a chave em PROD. Pendentes, para quando houver NF: troca de um vínculo existente e NF menor que o saldo do PC.
6. No UAT (`OMIE_MODE=leitura`): as escritas são simuladas. A sombra precisa refletir a associação e o `nQtdeRec` do PC.

> **Ordem de deploy em PROD**: 0056 → imagem com a 017 → teste D2 → religar `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED`. Em 22/10/2026 isso foi feito (0056, v1.1.20, T033, chave religada às ~14h50). A rodada de ajustes do mesmo dia acrescenta **0057 → imagem seguinte** (trava de unidade, cache de PCs vistos, PC por NF e PC de outro cadastro). A 0056 vem antes da imagem: é aditiva e convive com a imagem atual, e a 017 lê as colunas novas (sem elas, a fila responde 503). O n8n com as colunas está no ar desde 21/10/2026. Religar a chave com uma imagem anterior à 017 volta o `IGNORAR`, que é o problema original. Passo a passo em `docs/prod-golive-runbook.md`, seção "Ativação da feature 017".

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

## Cenário 8 — Compra nacional pela ACXE (História 5, fase 2; revisto em 22/10/2026, research D18)

Pré-requisitos: 0058, workflow "ACXE - Exporta Recebimentos NF-e" ativo (com histórico), `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=true`, `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE` e `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED=true`.

1. A NF da ACXE aparece na fila com o selo "ACXE" (filtro Todas/ACXE/Q2P). A NF da Q2P para a ACXE (intercompany) não aparece. NF da ACXE emitida antes do corte da ACXE também não. Com a chave da ACXE ligada sem a da 016 ou sem o corte, a ACXE fica fora (log e health) e a fila da Q2P segue normal.
2. Detalhe: o PC da ACXE sugerido como na Q2P; o produto sugerido é o do catálogo da ACXE (o que o OMIE associou ao item, ou o do PC); o local vem marcado pelo PC (PC 580 → 20.0.7 PRODUÇÃO), com a dica "Estoque sugerido pelo pedido de compra — pode trocar". O select de estoque tem dois grupos: "Entra na ACXE e na Q2P" (11.1, 12.1, 21.1, 31.1) e "Entra só na ACXE" (20.0.5, 20.0.7, 21.2). Sem TRÂNSITO, sem código do OMIE.
3. Fiscal com vínculo no OMIE da ACXE (mesma receita). A trava de estoque já lançado consulta o OMIE da ACXE.
4. Local só da ACXE (20.0.7): na aprovação, `ENT/INI` só na ACXE (`nacional-acxe`), com o valor do item na NF por kg.
5. Local que também é da Q2P (21.1): na aprovação, `ENT/INI` na ACXE e depois na Q2P (`nacional-q2p`), com **o mesmo valor unitário**, sem os 14,5%, e sem divergência nova na Conferência de Estoque. O produto aparece disponível para venda na Q2P.
6. Produto da ACXE sem produto de mesma descrição na Q2P (ex.: SUCATA DE PLÁSTICO da Replas): a tela marca "Sem correspondente na Q2P" e desabilita os locais que entram nas duas; o POST recusa a combinação com `422 PRODUTO_SEM_CORRELATO_Q2P` antes do fiscal. Produto da ACXE fora de KG (cabo, cimento…) não aparece na lista; enviado à força, `422 PRODUTO_UNIDADE_NAO_KG`.
7. Falha da perna Q2P na aprovação (mock): a aprovação fica aprovada, a movimentação `pendente_q2p` com a perna da ACXE gravada, alerta ao ops; "Retentar Q2P" em Movimentações conclui com o mesmo valor. Falha da perna ACXE: nada gravado, a aprovação continua pendente.
8. Nenhuma baixa de PC na Q2P (344) em nenhum caminho.

## Cenário 9 — PC por NF, PC de outro cadastro e PC fora da lista de pendentes (rodada de 22/10/2026)

Base: uma NF de 4 itens contra um PC de 3 itens do mesmo fornecedor, lançado em outro cadastro com a mesma raiz de CNPJ, com duas linhas da NF no mesmo item do PC. O modelo é a NF 60199 (Zaraplast, cadastro da filial) × PC 306 (cadastro da matriz).

1. O detalhe lista o PC uma vez para a nota (`pcsDaNf`), marcado como de outro cadastro do fornecedor, com o CNPJ do cadastro do PC, atendendo todos os itens e pré-selecionado, com a atribuição item a item. As linhas 3 e 4 ficam no mesmo item do PC.
2. Confirmar com **uma** escolha: o POST leva um `pc` por item, todos com o mesmo `n_cod_ped`, sem justificativa (dentro da tolerância). Nenhuma confirmação por item.
3. Quantidade 4% acima do saldo: **uma** justificativa para a nota, repetida no `pc.justificativa` de cada item. Sem ela, `422 PC_JUSTIFICATIVA_OBRIGATORIA`.
4. PC que não atende um dos itens: o item fica sem opção naquele PC (o PC não "atende todos"); sem outro PC possível para ele, vale `NF_SEM_PC`.
5. Dois PCs que atendem a nota: a lista mostra os dois e nada vem pré-selecionado.
6. Releitura ao vivo: o PC de outro cadastro com a mesma raiz de CNPJ é aceito; PC de cadastro com raiz diferente dá `409 PC_VINCULO_INVALIDO` ("é de outro fornecedor").
7. PC fora da lista de pendentes (PC 306 entre a associação e a conclusão): com o PC já registrado no cache (abrir a NF ou esperar o cron `5,35`), retirar o PC da cópia de teste. O detalhe mantém o número do PC e o saldo, com o alerta "saiu da lista de pedidos pendentes", os outros itens ainda oferecem o PC (`dadosEmCache`) e a confirmação confere o saldo ao vivo. Numa NF com fiscal já feito, o número do PC aparece pelo cache.
8. Auditoria: em `shared.audit_log`, `pedido_compra_visto` só registra quando o PC muda (saldo, etapa, preço), não a cada sincronização.
9. Sem a tabela do cache (0057 não aplicada): a sugestão segue só com a cópia, com aviso no log, e responde normalmente.

## Cenário 10 — PC em unidade diferente da NF (trava de unidade, rodada de 22/10/2026)

**Modo `bloquear` (padrão)**:

1. NF em toneladas (`TL`) e PC em kg: o PC aparece como não selecionável, com o motivo de unidade (`unidadeIncompativel`), e o item é tratado como sem PC possível.
2. O POST responde `422 NF_SEM_PC` com o texto de unidade, nada é gravado, e compras recebe o e-mail com o quadro "Pedido em unidade diferente da nota". Uma segunda tentativa no dia não manda outro e-mail.
3. Vínculo do OMIE em PC de unidade diferente: aparece com alerta e não pode ser mantido. Escolhê-lo no POST dá `422 PC_NAO_ELEGIVEL` (mensagem de unidade); sem outro PC, `NF_SEM_PC`. Com a releitura ao vivo devolvendo o PC em unidade diferente (mock), `409 PC_VINCULO_INVALIDO`.
4. Sem trava: NF em kg × PC em kg, e NF em `TL` × PC em `TON` (T, TON e TL contam como a mesma unidade).

**Modo `converter`** (`STOCKBRIDGE_PC_UNIDADE_DIFERENTE=converter`):

5. O PC em kg é oferecido normalmente para a NF em toneladas. O `EDITAR` sai com `itensAjustes.nQtdeRecebida` = kg da linha na unidade do PC (8250 para 8,25 t), e o `ConsultarRecebimento` do mock devolve o valor. Depois de uma falha, a retomada só refaz o `EDITAR` se `nQtdeRecebida` do item difere.
6. **A validar com NF real antes de ligar `converter` em PROD** (n8n de teste, passo a passo, com autorização do usuário): NF em toneladas contra PC em kg, `EDITAR` com `nQtdeRecebida` e `Concluir`. Conferir o `nQtdeRec` do PC na unidade do PC (8250 etc.), a `nQtdeNFe` da NF inalterada, um só título de conta a pagar e nenhum movimento de estoque. Registrar o resultado em research D15 e na ACXEGDP-437.

## Testes automatizados

- `packages/integrations/omie/src/__tests__/recebimento-nfe.test.ts`: `ASSOCIAR-PEDIDO`, parse de `nIdPedido`/`itensInfoAdic`, mock com associação e `nQtdeRec`; rodada de 22/10: `itensAjustes.nQtdeRecebida` no `EDITAR`, no parser e no mock.
- `modules/stockbridge/src/__tests__/`:
  - `pc-sugestao.test.ts` (novo): tolerâncias, ordenação, empates, número do pedido, PC-espelho, etapa 10, vínculos divergentes por sequência; rodada de 22/10: PC de outro cadastro (selo, sufixo no motivo, raiz de CNPJ);
  - `pc-por-nf.test.ts` (novo, 22/10): `montarPcsDaNf` (atribuição gulosa, `cobreTodos`, pré-selecionado, justificativa única, ordem dos PCs) e o caso NF 60199 × PC 306;
  - `pc-unidade.test.ts` (novo, 22/10): trava de unidade nos dois modos — sugestão, motivo nas duas unidades do PC, `validarEscolhaPc`, `NfSemPcError` com `unidade_pc` e `relerEReservarPcs` (`409` no `bloquear`, `nQtdeRecebida` no `converter`);
  - `pc-reserva.test.ts` (estender, 22/10): reserva com a releitura por raiz de CNPJ e a unidade;
  - `recebimento-fiscal-pc.test.ts` (novo): receitas D1/D2, `IGNORAR` só em item sem PC, idempotência, releitura com o saldo ao vivo, reserva entre duas NFs, "PC recém-usado", `VINCULO_OMIE_MUDOU` só quando o vivo difere do visto e do escolhido, `ESTOQUE_JA_LANCADO_PELO_OMIE` no ramo `ja_concluido`; rodada de 22/10: `nQtdeRecebida` no modo `converter`, `409` de unidade no modo `bloquear`;
  - `pc-visto.test.ts` (novo, 22/10): upsert só do que mudou e com `DISTINCT ON` (item repetido na cópia), leitura só do que a cópia não trouxe com validade de 7 dias (vínculo sempre), limite de 5 min, falha de banco sem exceção, cron e fiação com `carregarContextoPc`;
  - `notificacao-aviso-compras.test.ts` (estender): quadro "Pedido em unidade diferente da nota", sem o quadro de outro cadastro;
  - `recebimento-nacional-pc.test.ts` (novo): portão 1 com `NF_SEM_PC` nos dois modos, vínculo do OMIE em unidade diferente recusado nos dois modos, `PC_NAO_ESCOLHIDO`, `COPIA_PCS_DEFASADA`, estoque já lançado, aviso deduplicado;
  - `alerta-espelho-recebimentos.test.ts` (estender): cópia de PCs velha, vazia e em dia;
  - `recebimento-nacional-nf.routes.test.ts` (estender): o schema `.strict()` aceita `itens[].pc` e recusa campos extras;
  - `fila-nacional-unificada.test.ts` (estender): `pcSituacao`, `estoqueLancadoPeloOmie`;
  - `recebimento-nacional-flag-off.test.ts` (estender): contenção + FR-021/021a;
  - auditoria (integração, `ATLAS_DB_INTEGRATION=1`): triggers de `recebimento_fiscal_pc`, `nf_aviso_compras` e `pedido_compra_visto` (22/10; `auditoria-pedido-compra-visto.test.ts` cobre também o upsert real, a linha repetida na cópia e a validade — roda num Postgres com `shared.audit_log` e a 0057, sem as tabelas do n8n);
  - `cockpit`/`pendencias-fiscais` (estender): saldo com `nqtderec`.
  - Fase 2 (ACXE, 23/10/2026): `empresa-nacional`, `fila-nacional-acxe`, `fila-nacional-q2p-golden` (o SQL da Q2P igual ao de antes da Fase 2, exceto o filtro de empresa da exclusão de fornecedor; regenerar com `UPDATE_GOLDEN=1` só de propósito), `detalhe-nacional-acxe`, `fiscal-recebida-acxe`, `pc-sugestao-acxe`, `pc-visto-acxe`, `saude-nacional-acxe`, `alerta-espelho-acxe`, `cron-acxe`, `produto-gemeo-q2p`, `recebimento-nacional-acxe*`, `localidades-destino-acxe`, `aprovacao-entrada-nacional-acxe*`, `aprovacao-nacional-acxe-cenarios`, `operacoes-pendentes-*-acxe*`, `movimentacao-retentavel-q2p`, `fornecedor-*empresa`, `nf-dispensa-acxe`, `recebimento-externo-acxe`, `notificacao-*-acxe`;
  - Fase 2 com Postgres real (opt-in, um arquivo por vez, banco descartável com as migrations até a 0058): `ATLAS_DB_INTEGRATION=1 DATABASE_URL=<descartável> … vitest run src/__tests__/auditoria-recebimento-nacional-acxe.test.ts` e o mesmo para `fila-nacional-acxe-db.test.ts` (os dois criam tabelas públicas de teste com DDL diferente: juntos, um se pula).
