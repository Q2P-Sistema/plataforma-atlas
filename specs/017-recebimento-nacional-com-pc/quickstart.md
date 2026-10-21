# Quickstart — Recebimento Nacional com Pedido de Compra

**Feature**: `017-recebimento-nacional-com-pc`

## Pré-requisitos

1. Migration `0056` aplicada. No UAT vivo vai por `psql -1 -f`, como a 0053.
2. Workflow "Q2P - Exporta Recebimentos NF-e" com as colunas de pedido (`contracts/espelhos-n8n.md` §1), validado na NF 7813.
3. Cópia de PCs na Rev 1.5 (`qPJFEIY1PQ2LDQG2`), no ar desde 21/10/2026.
4. Variáveis de ambiente:
   - `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=true`, **só** com a imagem que contém a 017;
   - `STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC=true`;
   - `STOCKBRIDGE_COMPRAS_EMAILS`, com os destinatários de compras.
5. Teste do vínculo novo (research D2) feito com NF real e autorização do usuário **antes** de ligar a chave em PROD.
6. No UAT (`OMIE_MODE=leitura`): as escritas são simuladas. A sombra precisa refletir a associação e o `nQtdeRec` do PC.

> **Ordem de deploy em PROD**: imagem com a 017 → 0056 → n8n com as colunas → teste D2 → religar `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED`. Religar a chave com uma imagem anterior à 017 volta o `IGNORAR`, que é o problema original.

## Cenário 1 — Item com vínculo do OMIE (História 1 e 2, P1)

Base: o caso da NF 7813 × PC 304.

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

## Cenário 4 — NF sem PC (História 3)

1. `EXIGE_PC=true` e fornecedor sem PC na etapa 15:
   - o detalhe mostra "nenhum PC encontrado" e o motivo;
   - o POST responde `422 NF_SEM_PC`;
   - nada é gravado;
   - compras recebe um e-mail;
   - uma segunda tentativa no mesmo dia não manda outro e-mail.
2. PC do fornecedor só na etapa 10: o item mostra "PC aguardando aprovação" e não pode ser selecionado.
3. `EXIGE_PC=false`: o recebimento conclui o fiscal com `IGNORAR` só nesse item, os itens com PC mantêm o vínculo, e compras é avisado com o motivo `recebida_sem_vinculo`.

## Cenário 5 — Estoque já lançado pelo OMIE (FR-021a, vale com a chave desligada)

1. Desligar `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` (contenção).
2. Usar uma NF concluída no portal **sem** "não movimentar estoque". No UAT, injetar no espelho `c_recebido='S'`, `c_ignorar_item='N'`, `c_nao_gerar_mov_estoque='N'`.
3. O detalhe mostra o aviso, e o POST responde `409 ESTOQUE_JA_LANCADO_PELO_OMIE` sem gravar nada.
4. NF concluída no portal **com** "não movimentar estoque" e vínculo: o detalhe mostra "PC 304 vinculado no OMIE" e o recebimento faz só o estoque.

## Cenário 6 — Falhas e repetições (História 4)

1. Falha no `ASSOCIAR-PEDIDO` (mock): `502`, nada gravado, linha de `recebimento_fiscal_pc` em `falha`. Nova tentativa depois de 70 s conclui.
2. Associação feita e conclusão com falha: a nova tentativa reconhece o vínculo e não repete o `ASSOCIAR-PEDIDO`.
3. Duplo clique: `409 RECEBIMENTO_FISCAL_EM_ANDAMENTO`, como na 016.
4. Duas NFs no mesmo item de PC em menos de 75 s: a segunda recebe `409 PC_RECEM_USADO_AGUARDE`.
5. PC consumido entre abrir a tela e confirmar (mock de `ConsultarPedCompra` com saldo 0): `409 PC_VINCULO_INVALIDO`.
6. Vínculo mudado no OMIE entre abrir e confirmar: `409 VINCULO_OMIE_MUDOU`.
7. Rejeição do gestor por divergência: o fiscal e o vínculo continuam, e a NF volta como "fiscal já feito".

## Cenário 7 — Regressões

1. Baixa do PC Q2P da importação (ACXEGDP-344): receber uma NF filhote em UAT e conferir a baixa no PC-espelho certo. Nenhum PC nacional pode aparecer como candidato.
2. PC-espelho de importação (fornecedor ACXE, abaixo de R$ 200) nunca aparece na sugestão.
3. Com a chave da 016 desligada, a fila, o detalhe e o POST se comportam como na contenção, mais os cenários 5.1 e 5.4.
4. Cockpit, pendências fiscais e trânsito: com um PC da ACXE recebido em parte injetado na cópia, contam o saldo e não a quantidade cheia.

## Cenário 8 — Compra nacional pela ACXE (História 5, fase 2)

Pré-requisitos: 0057, workflow "ACXE - Exporta Recebimentos NF-e" e `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED=true`.

1. A NF da ACXE aparece na fila identificada pela empresa. A NF Q2P→ACXE não aparece.
2. Fiscal com vínculo no OMIE da ACXE (mesma receita).
3. Local espelhado: a entrada é lançada na ACXE e na Q2P com **o mesmo valor unitário**, sem os 14,5%, e sem divergência nova na Conferência de Estoque.
4. Local só da ACXE (21.2 EXTREMA (NACIONAL)): a entrada é só na ACXE.
5. Nenhuma baixa de PC na Q2P.

## Testes automatizados

- `packages/integrations/omie/src/__tests__/recebimento-nfe.test.ts`: `ASSOCIAR-PEDIDO`, parse de `nIdPedido`/`itensInfoAdic`, mock com associação e `nQtdeRec`.
- `modules/stockbridge/src/__tests__/`:
  - `pc-sugestao.test.ts` (novo): tolerâncias, ordenação, empates, número do pedido, PC-espelho, etapa 10, vínculos divergentes por sequência;
  - `recebimento-fiscal-pc.test.ts` (novo): receitas D1/D2, `IGNORAR` só em item sem PC, idempotência, releitura, "PC recém-usado", `VINCULO_OMIE_MUDOU`;
  - `recebimento-nacional-pc.test.ts` (novo): portão 1 com `NF_SEM_PC` nos dois modos, estoque já lançado, aviso deduplicado;
  - `recebimento-nacional-nf.routes.test.ts` (estender): o schema `.strict()` aceita `itens[].pc` e recusa campos extras;
  - `fila-nacional-unificada.test.ts` (estender): `pcSituacao`, `estoqueLancadoPeloOmie`;
  - `recebimento-nacional-flag-off.test.ts` (estender): contenção + FR-021/021a;
  - auditoria (integração, `ATLAS_DB_INTEGRATION=1`): triggers de `recebimento_fiscal_pc` e `nf_aviso_compras`;
  - `cockpit`/`pendencias-fiscais` (estender): saldo com `nqtderec`.
