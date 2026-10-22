---
description: "Task list — Recebimento Nacional com Pedido de Compra"
---

# Tasks: Recebimento Nacional com Pedido de Compra

**Input**: Design documents from `/specs/017-recebimento-nacional-com-pc/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md
**Jira**: ACXEGDP-437 (estende ACXEGDP-328/015 e ACXEGDP-395/016)

**Tests**: incluídos. O plano exige Vitest para:
- o cliente OMIE (`ASSOCIAR-PEDIDO`, parse do vínculo);
- a sugestão de PC (tolerâncias, ordenação, empates);
- o fiscal com vínculo (ordem dos passos, `IGNORAR` só sem PC, releitura);
- o portão 1 (`NF_SEM_PC`, estoque já lançado);
- a regressão da contenção (chave desligada) e da baixa da 344;
- a integração das triggers novas (Princípio IV).

O fluxo escreve em documento fiscal do OMIE, então não entra sem rede.

**Organization**: agrupadas por história de usuário, na ordem de prioridade da spec. A História 5 (ACXE) é a Fase 2 de entrega, atrás de chave própria.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos distintos, sem dependência pendente).
- **[Story]**:
  - US1: ver e confirmar o PC;
  - US2: fiscal com vínculo, sem estoque pelo OMIE;
  - US3: NF sem PC;
  - US4: falhas, repetições, rejeição e estoque já lançado;
  - US5: compra nacional pela ACXE.

## Path Conventions

Monorepo modular:
- `modules/stockbridge/src/`: backend;
- `apps/web/src/`: frontend;
- `packages/db/`: schema e migrations;
- `packages/integrations/omie/`: cliente OMIE;
- `packages/core/`: config.

Os workflows n8n vivem fora do repositório (`backup-workflow-n8n`), guiados por `contracts/espelhos-n8n.md`.

---

## Phase 1: Setup

**Purpose**: verificação do terreno; o projeto já existe.

- [X] T001 Confirmar que a branch `017-recebimento-nacional-com-pc` está sobre `origin/main` (`git merge-base --is-ancestor origin/main HEAD`) e que `pnpm install` roda limpo na raiz do repositório
- [X] T002 Confirmar a numeração da migration com `ls packages/db/migrations/ | tail -3`: as próximas livres devem ser `0056` e `0057` (última: `0055_stockbridge_movimentacao_nf_item_sequencias.sql`). Revisto em 22/10/2026: a `0057` ficou com o cache de PCs vistos (T066) e a Fase 2 (ACXE) passa a `0058`
- [ ] T003 [P] Acompanhar a entrega do contrato `specs/017-recebimento-nacional-com-pc/contracts/espelhos-n8n.md` §1, enviado em 21/10/2026 à sessão `backup-workflow-n8n-b3`. Conferir em PROD que `public."tbl_recebimentoNFe_itens_Q2P"` tem as 4 colunas e que a NF 7813 (recebimento 8517930857) está com `n_id_pedido = 8516905979` e `n_num_ped_compra = '304'`. Registrar a revisão do workflow na ACXEGDP-437. A US1 em UAT/PROD depende disso
- [X] T004 [P] Acrescentar em `.env.example` (raiz, dev), `deploy/portainer/atlas.env.example` e `deploy/portainer/atlas-uat.env.example` as variáveis `STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC=true`, `STOCKBRIDGE_PC_TOLERANCIA_QTD_PCT=2`, `STOCKBRIDGE_PC_TOLERANCIA_PRECO_PCT=1`, `STOCKBRIDGE_COMPRAS_EMAILS=` e `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED=false`, com comentário (data-model §10). No `.env` local de dev, também `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=true`

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: nenhuma história começa antes desta fase.

**Purpose**: migration 0056, schema, config, cliente OMIE e correção dos leitores da cópia de PCs, que as Histórias 1 a 4 consomem.

- [X] T005 Criar `packages/db/migrations/0056_stockbridge_recebimento_nacional_pc.sql`, com cabeçalho Antes/Agora/Porque (skill `stockbridge-migration`) e estas seções:
  1. `ALTER TABLE public."tbl_recebimentoNFe_itens_Q2P" ADD COLUMN IF NOT EXISTS` para `n_id_pedido bigint`, `n_id_it_pedido bigint`, `n_num_ped_compra varchar(15)` e `c_num_it_ped_compra integer`, com o mesmo texto de `contracts/espelhos-n8n.md` §1;
  2. em `stockbridge.recebimento_fiscal`: `ADD COLUMN empresa varchar(4) NOT NULL DEFAULT 'q2p' CHECK (empresa IN ('q2p','acxe'))`, `ADD COLUMN itens_vinculados integer`, e recriar `recebimento_fiscal_passo_falha_check` incluindo `'associar'`;
  3. `stockbridge.recebimento_fiscal_pc` conforme `data-model.md` §4: CHECKs de `origem` e `status`, coluna `dentro_tolerancia boolean NOT NULL` e CHECK de justificativa obrigatória quando `dentro_tolerancia = false` ou `n_cod_ped_omie_anterior IS NOT NULL` (matriz do `data-model.md` §4). Índice único parcial `(nf_chave_acesso, n_sequencia) WHERE status IN ('confirmado','associado','concluido')`, índice `(n_cod_item_ped, concluido_em)` e índice parcial `(n_cod_item_ped) WHERE status IN ('confirmado','associado')` para as reservas (research D4);
  4. `stockbridge.nf_aviso_compras` conforme `data-model.md` §5, com índice `(nf_chave_acesso, motivo, enviado_em)`
- [X] T006 Na mesma migration `packages/db/migrations/0056_stockbridge_recebimento_nacional_pc.sql`, adicionar `stockbridge.audit_recebimento_fiscal_pc()` + `trg_audit_sb_recebimento_fiscal_pc` e `stockbridge.audit_nf_aviso_compras()` + `trg_audit_sb_nf_aviso_compras` (AFTER INSERT OR UPDATE OR DELETE, padrão da 0053, linhas ~160-193)
- [X] T007 Monitorar a cópia de PCs (research D13, FR-030, Princípio II), depois da T010, no mesmo padrão do espelho de recebimentos da 016 (status `desligado` com `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` desligada):
  - em `modules/stockbridge/src/services/fila-nacional.service.ts`, ao lado de `idadeEspelhoRecebimentos()`, criar `idadeCopiaPcs()`: `now() − max(data_atualizacao)` de `public."tbl_pedidosCompras_Q2P"`, com o mesmo retorno (`status`, `idadeMin`, `limiteMin`), defasada acima de `STOCKBRIDGE_COPIA_PCS_MAX_MIN` ou com a tabela vazia ou inacessível. Exportar também `copiaPcsDefasada()` e fazer `statusHealthModulo` considerar a cópia;
  - em `modules/stockbridge/src/routes/stockbridge.routes.ts` (~l.44-49), expor `pedidosCompraCopiaIdadeMin` no `GET /api/v1/stockbridge/health` (autenticado), `degraded` com a cópia defasada;
  - em `modules/stockbridge/src/services/alerta-espelho-recebimentos.service.ts`, o cron existente (`5,35 * * * *`) passa a verificar também a cópia e alertar `STOCKBRIDGE_OPS_EMAIL`, com o mesmo reaviso de 6 h (`REALERTA_ESPELHO_MS`) e controle de reaviso separado do espelho;
  - `copiaPcsDefasada()` é usada no modo seguro pela sugestão (T018), pelo detalhe (T020) e pelo portão 1 (T034);
  - estender `modules/stockbridge/src/__tests__/alerta-espelho-recebimentos.test.ts` com cópia velha, vazia e em dia, e com a chave desligada.
  Substitui a antiga T007 (recriar a função de trânsito da 0037), tirada do escopo em 21/10/2026 (achado C2 do `/speckit-analyze`, research D10)
- [X] T008 Estender `packages/db/src/schemas/stockbridge.ts`:
  - em `recebimentoFiscal`, `empresa` (`$type<'q2p'|'acxe'>()`) e `itensVinculados`;
  - nova `recebimentoFiscalPc` (status `$type<'confirmado'|'associado'|'concluido'|'falha'>()`, origem `$type<'omie'|'sugestao'|'manual'>()`, `candidatos` jsonb tipado);
  - nova `nfAvisoCompras`.
  As colunas do espelho **não** entram no Drizzle
- [ ] T009 Aplicar a 0056 no banco de dev com `psql -1 -f packages/db/migrations/0056_stockbridge_recebimento_nacional_pc.sql` e conferir:
  - 4 colunas novas no espelho;
  - `recebimento_fiscal.empresa`;
  - 2 tabelas e 2 triggers novas (`pg_trigger`);
  - índices parciais (`pg_indexes`);
  - reaplicação sem erro onde houver `IF NOT EXISTS`
- [X] T010 [P] Adicionar ao schema Zod de `packages/core/src/config.ts`, com comentários:
  - `STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC` (enum `'true'|'false'|'1'|'0'|''`, default `'true'`, transform boolean);
  - `STOCKBRIDGE_PC_TOLERANCIA_QTD_PCT` e `STOCKBRIDGE_PC_TOLERANCIA_PRECO_PCT` (número ≥ 0, defaults 2 e 1);
  - `STOCKBRIDGE_COMPRAS_EMAILS` (CSV → `string[]` de e-mails, default vazio, mesmo padrão de `STOCKBRIDGE_FISCAL_EMAILS`);
  - `STOCKBRIDGE_COPIA_PCS_MAX_MIN` (`z.coerce.number().int().min(10).max(10080).default(120)`, mesmo padrão de `STOCKBRIDGE_ESPELHO_RECEBIMENTOS_MAX_MIN`), usada pela T007
- [X] T011 [P] Estender `packages/integrations/omie/src/stockbridge/recebimento-nfe.ts`:
  - `AcaoItemRecebimento` passa a ser `'EDITAR' | 'IGNORAR' | 'ASSOCIAR-PEDIDO'`, com `nIdPedidoExistente` e `nIdItPedidoExistente` obrigatórios no `ASSOCIAR-PEDIDO`;
  - `validarItensRecebimentoEditar` passa a recusar `itensAjustes` também nele e a exigir os dois ids;
  - declarar `itensInfoAdic` em `RawRecebimento`;
  - `parseRecebimentoNfeConsultado` lê `itensCabec.nIdPedido`, `itensCabec.nIdItPedido` (só quando `nIdPedido > 0`; senão `null`), `itensInfoAdic.nNumPedCompra` e `cNumItPedCompra`;
  - cabeçalho do arquivo cita a ação nova dentro da exceção ao Princípio II
- [X] T012 Estender `packages/integrations/omie/src/stockbridge/mock.ts`:
  - `mockAlterarRecebimentoNfeItens` aplica `ASSOCIAR-PEDIDO` (`cAssociarExistente = 'S'`, `nIdPedido`, `nIdItPedido`; substitui o vínculo anterior; fault se a etapa ≠ 40);
  - `mockConcluirRecebimentoNfe` incrementa `nQtdeRec` do item de PC injetado (`__injectMockPedidoCompra`) com a quantidade dos itens vinculados;
  - a sombra do modo leitura (`registrarSombraRecebimentoNfe`, `sombraPedidoCompra`) reflete as duas coisas
- [X] T013 [P] Estender os testes do cliente OMIE em `packages/integrations/omie/src/__tests__/`:
  - `packages/integrations/omie/src/__tests__/recebimento-nfe.test.ts`: parse com e sem vínculo, incluindo o caso da NF 7736 em que `nIdItPedido` repete `nIdItem` sem `nIdPedido`; `ASSOCIAR-PEDIDO` sem ids lança; `ASSOCIAR-PEDIDO` + `itensAjustes` lança;
  - `packages/integrations/omie/src/__tests__/mock.test.ts`: associação, seguida de `EDITAR`, preserva o vínculo; concluir atualiza `nQtdeRec`;
  - `packages/integrations/omie/src/__tests__/modo-leitura.test.ts`: `AlterarRecebimento` com `ASSOCIAR-PEDIDO` é simulado
- [X] T014 [P] Estender `specs/007-stockbridge-module/research.md` seção 2 (exceções ao Princípio II) com a ação `ASSOCIAR-PEDIDO` de `AlterarRecebimento` e as leituras ao vivo desta feature: `ConsultarPedCompra` na confirmação (D4) e `ConsultarRecebimento` por chave para NF "fiscal já feito" fora do espelho (D7), citando ACXEGDP-437. Os pontos do código que fazem essas leituras levam comentário apontando para essa seção (DEVE do Princípio II)
- [X] T015 [P] Corrigir os leitores da cópia de PCs em `modules/stockbridge/src/services/cockpit.service.ts` e `modules/stockbridge/src/services/pendencias-fiscais.service.ts` para usar o saldo (research D10), sem mudar o formato das respostas:
  - em `modules/stockbridge/src/services/cockpit.service.ts` (~l.370) e `modules/stockbridge/src/services/pendencias-fiscais.service.ts` (~l.164), `pc.nqtde > 0` → `(pc.nqtde - COALESCE(pc.nqtderec, 0)) > 0`, e quantidade = saldo;
  - criar `modules/stockbridge/src/__tests__/leitores-pc-saldo.test.ts`, com pool mockado e inspeção do SQL gerado como em `fila-nacional.test.ts`: as duas queries usam `nqtde - COALESCE(nqtderec, 0)`, e um PC da ACXE recebido em parte entra com o saldo, não com a quantidade cheia
- [X] T016 [P] Criar ou estender o teste de integração de auditoria (`ATLAS_DB_INTEGRATION=1`) em `modules/stockbridge/src/__tests__/auditoria-recebimento-fiscal.test.ts`: INSERT/UPDATE em `recebimento_fiscal_pc` e `nf_aviso_compras` gravam em `shared.audit_log`

**Checkpoint**: 0056 aplicada, cliente OMIE testado em mock, config disponível, cópia de PCs monitorada, leitores corrigidos. As histórias podem começar.

---

## Phase 3: User Story 1 — Ver o PC sugerido para cada item e confirmar o vínculo (Priority: P1) 🎯 MVP

**Goal**: ao abrir uma NF com fiscal pendente, cada item mostra o PC: o vínculo do OMIE, os candidatos dentro da tolerância, os outros do fornecedor ou os aguardando aprovação. O operador confirma ou troca, e a escolha vai no POST. Nas NFs com fiscal já feito, o PC vinculado aparece à vista (FR-021).

**Independent Test**: quickstart cenários 1 (passos 1-2), 2 (passos 1, 4, 5) e 3.
- NF 7813 (ou mock equivalente): o detalhe mostra o PC 304 como "vínculo do OMIE", pré-selecionado.
- Dois PCs iguais: nada vem pré-selecionado.
- Escolha fora da tolerância sem justificativa: `422 PC_JUSTIFICATIVA_OBRIGATORIA`.

- [X] T017 [US1] Estender `modules/stockbridge/src/services/fila-nacional.service.ts` para levar ao formato normalizado de linha:
  - na `fonteRecebSql` (~l.303): `n_id_pedido`, `n_id_it_pedido`, `n_num_ped_compra`, `c_associar_existente`, `c_ignorar_item`, `c_nao_gerar_mov_estoque`, `n_preco_unit` e `n_id_fornecedor` do espelho de recebimentos;
  - na `fonteNfSql` (~l.273): os mesmos campos de vínculo por LEFT JOIN no espelho de recebimentos (chave + sequência, como `sequenciaItemNfSql`), `v_un_com` como preço comercial, e o código do fornecedor via `tbl_cadastroFornecedoresClientes_Q2P` pela CNPJ.
  Manter `fornecedorNaoExcluidoSql` e o recorte de CFOP intactos
- [X] T018 [US1] Criar `modules/stockbridge/src/services/pc-sugestao.service.ts` com `sugerirPcPorItens(empresa, fornecedorCodigo, itens[])`, que devolve `PcDoItem` por item agregado (`data-model.md` §8):
  - lê `public."tbl_pedidosCompras_Q2P"` por `ncodfor` (`getPool()`, raw SQL) e calcula o saldo da cópia: `nqtde - COALESCE(nqtderec,0)`, menos os vínculos `concluido` de `recebimento_fiscal_pc` no mesmo item de PC com `concluido_em > data_atualizacao` da cópia (ela ainda não os viu), menos as reservas de outras NFs (`confirmado`/`associado` há menos de 15 min) (research D3, D4);
  - tolerâncias da config: `qtdKg ≤ saldoKg × (1 + tolQtd)` e `|preçoNfKg − preçoPcKg| ≤ preçoPcKg × tolPreço`. O preço da NF vai em duas bases (revisto em 22/10/2026, research D3): o comercial (`n_preco_unit` / `v_un_com`) e o valor do item com tributos (`v_total_item` / `v_prod`), por kg — vale a mais próxima do preço do PC. `preçoNfKg = Σ(preço comercial × qtd) ÷ Σ kg`, chamando `converterItemNfParaKg(qtd, unidade, preço comercial × qtd)` por linha, porque a função recebe o valor total. `preçoPcKg` = `nvalunit` em KG ou `nvalunit ÷ 1000` em T/TON; outra unidade deixa o PC fora, com motivo. Item com unidade não conversível fica sem sugestão (research D3);
  - com a cópia defasada (`copiaPcsDefasada()` da T007), não monta candidatos (D13);
  - ordenação (número do pedido na NF, menor diferença de preço, previsão, `ncodped`);
  - separa `candidatos`, `outrosDoFornecedor` (etapa 15 com saldo, fora da tolerância) e `aguardandoAprovacao` (etapa 10);
  - exclui PC de fornecedor ACXE com valor total < R$ 200, reconhecendo a ACXE pela CNPJ do fornecedor no cadastro, comparada sem máscara com `CNPJ_ACXE_NUMERICO` (`modules/stockbridge/src/types.ts`; `CNPJ_ACXE` é rótulo, não CNPJ);
  - monta `vinculoOmie` a partir das sequências, com `alertaVinculoOmie` quando o PC não serve ou quando as sequências apontam para itens diferentes;
  - `preSelecionado` = vínculo do OMIE válido ou candidato único pelo número do pedido;
  - `semPcMotivo`
- [X] T019 [P] [US1] Criar `modules/stockbridge/src/__tests__/pc-sugestao.test.ts`, com pool mockado como em `fila-nacional.test.ts`:
  - limite de 2% na quantidade e de 1% no preço;
  - PC etapa 10 em `aguardandoAprovacao`;
  - PC-espelho excluído;
  - empate 302/304 sem pré-seleção;
  - número do pedido na NF em primeiro;
  - vínculo do OMIE válido pré-selecionado;
  - vínculo do OMIE sem saldo com alerta;
  - sequências com vínculos divergentes → `escolha_necessaria`;
  - fornecedor sem PC → `semPcMotivo`
- [X] T020 [US1] Em `modules/stockbridge/src/services/fila-nacional.service.ts`:
  - `getDetalheNfNacional` (~l.661) anexa `pc` a cada `ItemNfNacional` quando a chave da 016 está ligada e o fiscal está pendente (chama `sugerirPcPorItens`). Com fiscal já feito, anexa só `vinculadoNoOmie` (FR-021, inclusive com a chave desligada);
  - acrescentar `empresa: 'q2p'`, `exigePc` e `copiaPcsDefasada` (T007);
  - `getFilaNacional` (~l.404) acrescenta `empresa` e `pcSituacao` (pior caso entre os itens, regra do `data-model.md` §8), calculado em TypeScript só para as NFs com fiscal pendente; as demais ficam `nao_aplicavel`
- [X] T021 [P] [US1] Estender `modules/stockbridge/src/__tests__/fila-nacional-unificada.test.ts`:
  - as colunas de vínculo chegam ao formato de linha nas duas fontes;
  - `pcSituacao` por NF;
  - `vinculadoNoOmie` em NF com fiscal já feito com a chave desligada;
  - sem `pc` com a chave desligada e o fiscal pendente;
  - NF recebida cujo item teve a descrição trocada pelo vínculo ("SUCATA PLASTICO" → "PS CRISTAL B") não volta à fila: a sequência ainda casa (FR-016, ACXEGDP-412)
- [X] T022 [US1] Em `modules/stockbridge/src/routes/recebimento-nacional.routes.ts` (~l.325-350), estender o schema `.strict()` do POST `/por-nf`: cada item de `itens[]` aceita `pc` opcional/nullable, `{ n_cod_ped: int>0, n_cod_item: int>0, justificativa?: string 1..500 | null, n_cod_item_omie_visto?: int>0 | null }`, também `.strict()`. Repassar ao service
- [X] T023 [US1] Em `modules/stockbridge/src/services/recebimento-nacional.service.ts`, no portão 1 de `processarRecebimentoNacionalPorNf` (~l.659), chamar `validarEscolhaPc` (novo, em `pc-sugestao.service.ts`):
  - o `pc` enviado tem que estar em `vinculoOmie`, `candidatos` ou `outrosDoFornecedor` do detalhe recalculado; senão `PcNaoElegivelError`;
  - item com PC possível (definição antes do FR-019 da spec) e sem `pc` → `PcNaoEscolhidoError` (422 `PC_NAO_ESCOLHIDO`), nos dois modos e sem aviso a compras;
  - justificativa conforme a matriz única do `data-model.md` §4: obrigatória com o PC fora da tolerância, de qualquer origem (inclusive o vínculo do OMIE mantido), e na troca do vínculo do OMIE; senão `PcJustificativaObrigatoriaError`. Calcular `dentro_tolerancia` para a T029.
  Criar as classes com `userMessage` citando o número da NF, o fornecedor, o PC e o item (ACXEGDP-313) e mapear 422 `PC_NAO_ELEGIVEL` / `PC_NAO_ESCOLHIDO` / `PC_JUSTIFICATIVA_OBRIGATORIA` em `responderErroFilaNacional` (`recebimento-nacional.routes.ts`, ~l.233)
- [X] T024 [P] [US1] Estender `modules/stockbridge/src/__tests__/recebimento-nacional-nf.routes.test.ts`: `itens[].pc` válido aceito; campo extra dentro de `pc` recusado (`.strict()`); `n_cod_ped` 0 recusado; mapeamento dos dois 422
- [X] T025 [US1] Em `apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx`:
  - **na fila** (`FilaSection`, ~l.312-336): selo por `pcSituacao` ("PC vinculado no OMIE", "PC sugerido", "Escolher PC", "PC aguardando aprovação", "Sem PC");
  - **no `ItemCard`** (~l.893), bloco "Pedido de compra":
    - vínculo do OMIE com selo;
    - candidatos como opções (número do PC, produto do PC, saldo em kg, preço, previsão e motivo);
    - "Outros PCs do fornecedor", recolhido, com campo de justificativa obrigatório ao escolher;
    - "Aguardando aprovação" desabilitados;
    - mensagem de sem PC;
    - pré-seleção;
    - justificativa pedida também para o vínculo do OMIE ou o candidato fora da tolerância (matriz do `data-model.md` §4);
  - **com a cópia de PCs defasada** (`copiaPcsDefasada`): aviso "lista de pedidos de compra desatualizada" no lugar da sugestão e recebimento desabilitado para NF com fiscal pendente;
  - **no envio** (`DetalheSection`, ~l.493): mandar `pc` por item, com `n_cod_item_omie_visto` (o vínculo do OMIE que a tela mostrou); botão de confirmar desabilitado enquanto faltar escolha num item com candidatos;
  - **com fiscal já feito**: mostrar "PC <n> vinculado no OMIE".
  Rodar o agente `frontend-design-reviewer` no componente alterado

**Checkpoint**: a escolha do PC é exibida, validada e enviada. Sem a US2, o POST ainda conclui o fiscal pela receita da 016. Por isso a chave da 016 só é religada depois da US2.

---

## Phase 4: User Story 2 — Concluir o fiscal com o item vinculado ao PC, sem estoque pelo OMIE (Priority: P1)

**Goal**: o fiscal mantém o vínculo do OMIE (`EDITAR` + `Concluir`) ou grava o vínculo escolhido (`ASSOCIAR-PEDIDO` + `EDITAR` + `Concluir`), nunca ignora item com PC, relê o recebimento e os PCs antes de escrever e registra cada vínculo.

**Independent Test**: quickstart cenários 1 (passos 3-5) e 2 (passos 2-3). Em mock:
- NF com vínculo do OMIE: `EDITAR` e `Concluir`, sem `IGNORAR`, sem `ASSOCIAR`, `recebimento_fiscal_pc` com `origem = 'omie'` e status `concluido`;
- NF sem vínculo: `ASSOCIAR-PEDIDO` antes do `EDITAR`, `nQtdeRec` do PC atualizado no mock;
- movimentação física gravada uma vez.

- [X] T026 [US2] Em `modules/stockbridge/src/services/pc-sugestao.service.ts`, criar `relerEReservarPcs(empresa, ledgerId, escolhas[])`, chamada depois da trava da NF (ledger da 016) e — revisto em 22/10/2026 — depois da `ConsultarRecebimento` (NF já concluída vai para `ja_concluido`/D7 sem releitura) e antes de qualquer escrita (research D4):
  - `consultarPedidoCompra` (do `@atlas/integration-omie`) por PC distinto, fora de transação;
  - numa transação com `pg_advisory_xact_lock` por `n_cod_item_ped`, em ordem crescente:
    - vínculo `concluido` em `recebimento_fiscal_pc` no mesmo item de PC há menos de 75 s → `PcRecemUsadoAguardeError` com `retryAfterSeconds`;
    - recusa (`PcVinculoInvalidoError`, com a situação atual na mensagem) se etapa ≠ '15', sem o item, outro fornecedor, ou saldo disponível insuficiente. Saldo disponível = `nQtde − nQtdeRec` lido ao vivo, **sem** descontar vínculos concluídos (o OMIE já os mostra), menos as reservas de outras NFs (`confirmado`/`associado` há menos de 15 min). A quantidade passa se estiver na tolerância ou se houver justificativa;
    - grava as linhas `confirmado` de `recebimento_fiscal_pc` (T029) com o saldo, o preço e a etapa lidos. É a **reserva**: vale para as outras NFs até a linha virar `concluido` ou `falha`
- [X] T027 [US2] Em `modules/stockbridge/src/services/recebimento-fiscal.service.ts`:
  - decidir a ação por item em `concluirRecebimentoFiscal` (~l.403):
    - **manter**: vínculo vivo no recebimento igual ao escolhido → só `EDITAR` se faltarem os ajustes;
    - **associar**: sem vínculo, ou troca → `ASSOCIAR-PEDIDO` (`nIdPedidoExistente`, `nIdItPedidoExistente`) e depois `EDITAR`;
    - **sem PC**: só no modo "receber sem vínculo" → `EDITAR` + `IGNORAR`;
  - `itensParaIgnorar` (~l.357) passa a excluir todo item com PC associado ou escolhido (FR-011a);
  - os `ASSOCIAR-PEDIDO` vão numa chamada `AlterarRecebimento` antes da chamada de `EDITAR`;
  - em fault no associar: `passo_falha = 'associar'` e o mesmo tratamento de reconsulta/70 s da 016. Em `adquirirLedger` (~l.205), a espera de 70 s depois de falha com escrita passa a listar `passo_falha IN ('associar','editar','ignorar','concluir')`;
  - item com vínculo do OMIE nunca vai para o `IGNORAR`: sem outro PC possível, a NF já foi recusada no portão 1 (FR-011a)
- [X] T028 [US2] Em `modules/stockbridge/src/services/recebimento-fiscal.service.ts`, em `recusaAntesDeEscrever` (~l.362): se o vínculo vivo de algum item for diferente do `n_cod_item_omie_visto` enviado pela tela **e** diferente do PC escolhido → `VinculoOmieMudouError` (409). Vínculo vivo igual ao escolhido nunca é conflito. Mapear em `responderErroFilaNacional` junto com `PC_VINCULO_INVALIDO` (409) e `PC_RECEM_USADO_AGUARDE` (409, com `retryAfterSeconds`)
- [X] T029 [US2] Gravar `stockbridge.recebimento_fiscal_pc` em `modules/stockbridge/src/services/recebimento-fiscal.service.ts`:
  - uma linha `confirmado` por item com PC, **antes** da primeira escrita no OMIE, gravada na transação da reserva da T026 (o ledger da 016 continua com o seu INSERT próprio, feito antes), com `origem`, `dentro_tolerancia`, PC escolhido, PC anterior do OMIE, justificativa, `candidatos` (retrato do detalhe), quantidade, preço da NF e o que foi relido;
  - transições: `associado` depois do `ASSOCIAR-PEDIDO`, ou direto quando o vínculo é mantido; `concluido` depois do `Concluir`; `falha` com `erro_omie_*`;
  - preencher `recebimento_fiscal.empresa` e `itens_vinculados`
- [X] T030 [US2] Em `modules/stockbridge/src/services/recebimento-nacional.service.ts`, na `executarFiscalSeNecessario` (~l.1010):
  - a ordem passa a ser: trava da NF (`adquirirLedger`, 016) → `relerEReservarPcs` (T026) → `ConsultarRecebimento` e escritas (T027). Como a reserva precisa do id do ledger, a releitura vai para dentro de `concluirRecebimentoFiscal`, logo depois de `adquirirLedger`. **Revisto em 22/10/2026** (revisão adversarial, achado fiscal-02): `ConsultarRecebimento` passou para antes da releitura — NF já concluída (portal, ou `Concluir` cuja resposta se perdeu) vai para `ja_concluido`/D7 sem reler o PC que ela mesma consumiu;
  - passar as escolhas e os vínculos do espelho ao fiscal;
  - acrescentar ao resultado `fiscal.vinculos[]` (`nSequencia`, `pcNumero`, `origem`, `status`), `fiscal.semVinculo[]` e `fiscal.avisoCompras`;
  - mensagem "…concluído no OMIE, vinculado ao PC <n>."
- [X] T031 [P] [US2] Criar `modules/stockbridge/src/__tests__/recebimento-fiscal-pc.test.ts`, com mocks do OMIE:
  - ordem `ASSOCIAR-PEDIDO` → `EDITAR` → `Concluir`;
  - vínculo do OMIE mantido sem `ASSOCIAR`;
  - `IGNORAR` nunca em item com PC;
  - NF mista (um item com PC e outro sem, no modo "receber sem vínculo");
  - `VINCULO_OMIE_MUDOU` só quando o vínculo vivo difere do visto e do escolhido;
  - `PC_VINCULO_INVALIDO` (saldo 0 e etapa 10);
  - `PC_RECEM_USADO_AGUARDE`;
  - releitura com o saldo ao vivo sem descontar vínculos concluídos (PC de 18.000 kg com uma NF de 9.000 já concluída aceita a segunda NF de 9.000);
  - reserva: duas NFs no mesmo item de PC, a segunda vê a reserva da primeira e é recusada quando o saldo não cobre as duas;
  - as linhas de `recebimento_fiscal_pc` em cada transição;
  - falha no associar sem nenhum INSERT em `movimentacao`
- [X] T032 [US2] Em `apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx` (~l.697-740):
  - o resultado mostra o PC de cada item;
  - mensagens dos 409 novos (`PC_VINCULO_INVALIDO` com "escolha outro PC" e recarga do detalhe; `VINCULO_OMIE_MUDOU` com recarga; `PC_RECEM_USADO_AGUARDE` com contagem por `retryAfterSeconds`, como `RECEBIMENTO_FISCAL_AGUARDE`)
- [X] T033 [US2] Teste controlado do vínculo novo (research D2), **com autorização do usuário**, com uma NF real da Q2P sem vínculo e PC compatível, num workflow n8n de teste nos moldes de `CA0PlrtFkzcdQlpM` (passo a passo, 70 s entre passos). **Feito e aprovado em 22/10/2026**: workflow n8n `4OnbxvfALn9OoXLH` ("Teste OMIE - ASSOCIAR-PEDIDO (NF 60199 Zaraplast x PC 306, Q2P) T033", pasta Em Desenvolvimento; hoje só com passos de leitura). A NF 60199 (cadastro da filial, 4 itens em TL, etapa 40, sem vínculo) contra o PC 306 (cadastro da matriz, 3 itens em kg, mesma raiz de CNPJ):
  - `ASSOCIAR-PEDIDO` aceito na etapa 40, inclusive com PC de outro cadastro do mesmo fornecedor;
  - o `EDITAR` seguinte preservou o vínculo; chamadas com vários itens numa só (3 associações, depois 3 `EDITAR`, no formato do Atlas) e duas linhas da NF (itens 3 e 4, 2,75 t cada) no mesmo item do PC foram aceitas; depois da associação a descrição do item passou a ser a do produto do PC;
  - durante o teste: PC sem baixa, estoque inalterado, nenhuma conta a pagar;
  - **não testados**: (c) troca de um vínculo existente e (d) NF menor que o saldo do PC (as quantidades batiam exatas): ver T075;
  - a chave `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` foi religada em PROD às ~14h50. A primeira NF recebida pelo Atlas (a própria 60199, 15h02) concluiu o fiscal com os 4 vínculos mantidos e 3 entradas físicas aprovadas, e revelou a unidade na baixa do PC (T059 a T063) e o PC fora da lista de pendentes (T066 e T067).
  Resultado registrado em `specs/017-recebimento-nacional-com-pc/research.md` (D2).

**Checkpoint**: Histórias 1 e 2 entregam o caminho normal. O T033 foi aprovado em 22/10/2026 e a contenção foi encerrada com a chave religada em PROD.

---

## Phase 5: User Story 3 — NF sem PC correspondente (Priority: P2)

**Goal**: NF com item sem PC possível é bloqueada (padrão) ou recebida sem vínculo, conforme a configuração, e compras é avisado uma vez por dia.

**Independent Test**: quickstart cenário 4.
- Com `EXIGE_PC=true`: `422 NF_SEM_PC`, nada gravado, um e-mail; a segunda tentativa no mesmo dia não manda outro.
- Com `EXIGE_PC=false`: fiscal concluído com `IGNORAR` só no item sem PC e aviso com motivo `recebida_sem_vinculo`.

- [X] T034 [US3] Em `modules/stockbridge/src/services/recebimento-nacional.service.ts`, no portão 1, com fiscal pendente e a chave da 016 ligada:
  - cópia de PCs defasada (`copiaPcsDefasada()` da T007) → `CopiaPcsDefasadaError` (503 `COPIA_PCS_DEFASADA`), sem gravar nada e sem aviso a compras (FR-030);
  - item a gravar **sem PC possível** (definição antes do FR-019 da spec): com `STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC = true` → `NfSemPcError` (422 `NF_SEM_PC`, mensagem com a NF, o fornecedor e a descrição do item); com `false` → seguir, marcando o item como "sem vínculo" para o fiscal. Item com vínculo do OMIE que não serve e sem outro PC possível é recusado nos dois modos (FR-011a).
  Item **com** PC possível e sem `pc` é tratado na T023 (`PC_NAO_ESCOLHIDO`). Mapear `NF_SEM_PC` (422) e `COPIA_PCS_DEFASADA` (503) em `responderErroFilaNacional`
- [X] T035 [US3] Em `modules/stockbridge/src/services/notificacao.service.ts`, criar `enviarAvisoComprasNfSemPc({ empresa, nf, fornecedor, itens, motivo, disparadoPor })`:
  - consulta `stockbridge.nf_aviso_compras` (NF + motivo, últimas 24 h), junta o `enviado_para` das linhas e envia só aos destinatários que ainda não constam, gravando só os entregues; sem pendentes = `deduplicado` (revisto em 22/10/2026: dedup por destinatário, numa transação com trava consultiva; no máximo 3 avisos simultâneos no processo);
  - destinatários: `STOCKBRIDGE_COMPRAS_EMAILS`, ou `STOCKBRIDGE_OPS_EMAIL` com log de aviso quando vazio;
  - layout `buildEmailLayout`, sem códigos OMIE, com prefixo `[UAT]` no UAT;
  - corpo com itens (descrição, kg, preço) e PCs aguardando aprovação, se houver;
  - grava a linha depois de enviar.
  Chamar a partir do portão 1 (`sem_pc`, `pc_aguardando_aprovacao`) e do fiscal no modo "receber sem vínculo" (`recebida_sem_vinculo`), sem bloquear a resposta (best-effort, erro só em log)
- [X] T036 [P] [US3] Criar `modules/stockbridge/src/__tests__/recebimento-nacional-pc.test.ts`:
  - `NF_SEM_PC` com `EXIGE_PC=true` sem nenhum INSERT em `movimentacao` ou `aprovacao` (só o aviso em `nf_aviso_compras`);
  - modo `false` seguindo sem vínculo;
  - deduplicação de 24 h;
  - fallback para `STOCKBRIDGE_OPS_EMAIL`;
  - item só com PC na etapa 10 → `NF_SEM_PC` com motivo `pc_aguardando_aprovacao`;
  - cópia de PCs defasada → `COPIA_PCS_DEFASADA`, sem aviso a compras e sem gravar nada;
  - item com PC possível e sem escolha → `PC_NAO_ESCOLHIDO`, sem aviso;
  - vínculo do OMIE que não serve, sem outro PC, no modo `false` → recusado (nunca ignorado)
- [X] T037 [US3] Em `apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx`:
  - estado "Aguardando PC de compras" no item e na NF;
  - mensagem do `422 NF_SEM_PC` informando que compras foi avisado;
  - com `exigePc = false`: aviso no item "será recebido sem vínculo com PC"

---

## Phase 6: User Story 4 — Falhas, repetições, rejeições e estoque já lançado (Priority: P2)

**Goal**: NF e PC sempre terminam em estado conhecido. Nada é vinculado, recebido no PC ou lançado em estoque duas vezes, e o estoque já lançado pelo OMIE bloqueia a entrada física, também com a chave desligada.

**Independent Test**: quickstart cenários 5 e 6, e a regressão do cenário 7.3.

- [X] T038 [US4] Retomada sem repetir passos em `modules/stockbridge/src/services/recebimento-fiscal.service.ts`:
  - numa nova tentativa, a consulta mostra o vínculo vivo igual ao escolhido → o item vai para `associado` sem nova chamada;
  - linha viva de `recebimento_fiscal_pc` de tentativa órfã (> 15 min) é reaproveitada, no padrão de `adquirirLedger`;
  - `ja_concluido` com vínculo igual → registros `concluido` sem escrita
- [X] T039 [US4] Estoque já lançado pelo OMIE (FR-021a, research D7), em `modules/stockbridge/src/services/fila-nacional.service.ts` e `modules/stockbridge/src/services/recebimento-nacional.service.ts`:
  - **detecção** em `modules/stockbridge/src/services/fila-nacional.service.ts`: `estoqueLancadoPeloOmie` na fila e no detalhe, a partir do espelho (`c_recebido='S'` e item `c_ignorar_item='N'` e `c_nao_gerar_mov_estoque='N'`);
  - **bloqueio** no portão 1 de `modules/stockbridge/src/services/recebimento-nacional.service.ts`: `EstoqueJaLancadoPeloOmieError` (409 `ESTOQUE_JA_LANCADO_PELO_OMIE`);
  - **leitura ao vivo** (`consultarRecebimentoNfe` por chave) quando a NF "fiscal já feito" não está no espelho de recebimentos, com comentário no código apontando para a seção 2 da 007 (exceção ao Princípio II, T014);
  - **no ramo `ja_concluido` e na reconsulta depois de falha** em `modules/stockbridge/src/services/recebimento-fiscal.service.ts` (~l.419): com os itens lidos ao vivo, item não ignorado e com `cNaoGerarMovEstoque = 'N'` → `EstoqueJaLancadoPeloOmieError` antes de seguir para o físico (research D7);
  - mapear `ESTOQUE_JA_LANCADO_PELO_OMIE` (409) em `responderErroFilaNacional` (`recebimento-nacional.routes.ts`, ~l.234);
  - vale com `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` desligada
- [X] T040 [US4] Rejeição do gestor: conferir em `modules/stockbridge/src/services/aprovacao.service.ts` que a rejeição de recebimento nacional não toca `recebimento_fiscal_pc` nem o OMIE e que a NF volta à fila como "fiscal já feito" com `vinculadoNoOmie`. Acrescentar o caso em `modules/stockbridge/src/__tests__/recebimento-nacional-fiscal.test.ts`
- [X] T041 [P] [US4] Estender `modules/stockbridge/src/__tests__/recebimento-nacional-flag-off.test.ts`, que cobre a contenção: com a chave desligada, fila, detalhe e POST como hoje, mais `vinculadoNoOmie` (FR-021) e `ESTOQUE_JA_LANCADO_PELO_OMIE` (FR-021a). Estender `modules/stockbridge/src/__tests__/recebimento-fiscal-pc.test.ts` com:
  - nova tentativa depois de associar sem repetir o `ASSOCIAR-PEDIDO`;
  - duplo clique (`RECEBIMENTO_FISCAL_EM_ANDAMENTO`);
  - órfã retomada;
  - NF que a tela mostrava com fiscal pendente e foi concluída no portal com estoque (`ja_concluido` com `cNaoGerarMovEstoque = 'N'`) → `ESTOQUE_JA_LANCADO_PELO_OMIE`, sem nenhum INSERT
- [X] T042 [US4] Em `modules/stockbridge/src/services/recebimento-fiscal.service.ts`, `listarLedgerFiscal` (~l.538) passa a devolver `empresa` e `vinculos[]` (`nSequencia`, `pcNumero`, `origem`, `justificativa`, `status`, `confirmadoPor`, `confirmadoEm`), sem `erro_omie_*`, para o GET `/fiscal` (`recebimento-nacional.routes.ts`, ~l.765). Estender o teste da rota
- [X] T043 [US4] Em `apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx`: aviso "O estoque desta NF já entrou pelo OMIE. Fale com o fiscal." no detalhe, com o botão de receber desabilitado, e selo na fila
- [X] T044 [US4] Em `modules/stockbridge/src/services/notificacao.service.ts`, `enviarAlertaNfDispensada` (~l.399) passa a citar o PC vinculado a cada item, quando houver (vínculo do OMIE no espelho ou linha `concluido` em `recebimento_fiscal_pc`), por exemplo "SUCATA PLASTICO: PC 304". Assim o fiscal sabe qual PC ficou com quantidade recebida no OMIE quando a NF dispensada já tinha o fiscal feito (caso de borda "Dispensa de NF" da spec). Estender `modules/stockbridge/src/__tests__/notificacao-nf-dispensada.test.ts`

**Checkpoint**: Fase 1 de entrega completa (Histórias 1 a 4). Seguir para a Phase 8 (polish) e o deploy antes de começar a US5.

---

## Phase 7: User Story 5 — Compra nacional pela ACXE, com estoque espelhado (Priority: P3) — Fase 2 de entrega

**Goal**: NF nacional da ACXE na mesma fila, fiscal com vínculo no OMIE da ACXE, entrada de estoque sempre nas duas empresas, no local espelhado escolhido (Extrema = 21.1), com o mesmo valor unitário, sem os 14,5% e sem baixa de PC na Q2P.

**Independent Test**: quickstart cenário 8.

- [ ] T045 [US5] Criar `packages/db/migrations/0058_stockbridge_recebimento_nacional_acxe.sql` (a `0057` ficou com o cache de PCs vistos, T066):
  - `CREATE TABLE IF NOT EXISTS public."tbl_recebimentoNFe_ACXE"` e `"tbl_recebimentoNFe_itens_ACXE"` com a DDL das tabelas da Q2P na 0053, mais as 4 colunas de pedido;
  - `stockbridge.fornecedor_exclusao`: `ADD COLUMN empresa varchar(4) NOT NULL DEFAULT 'q2p' CHECK (empresa IN ('q2p','acxe'))`, índice único incluindo `empresa`, e duas linhas com a Q2P como fornecedor excluído na ACXE: as CNPJs `27.019.059/0001-88` (matriz) e `27.019.059/0002-69` (filial), com máscara, como no cadastro da ACXE e como já está gravada a ACXE (`42.672.052/0001-54`), motivo "intercompany". Não há constante de CNPJ da Q2P: `CNPJ_Q2P_MATRIZ` em `types.ts` é rótulo.
  Estender `fornecedorExclusao` em `packages/db/src/schemas/stockbridge.ts` e `modules/stockbridge/src/services/fornecedor.service.ts` (listar, excluir e reincluir por CNPJ passam a considerar a empresa), e aplicar em dev (`psql -1 -f`)
- [ ] T046 [P] [US5] Adicionar `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED` (default `'false'`) em `packages/core/src/config.ts`
- [ ] T047 [US5] Parametrizar por empresa `modules/stockbridge/src/services/fila-nacional.service.ts`:
  - `fonteNfSql`/`fonteRecebSql` aceitam `'q2p'|'acxe'` (`tbl_nf_header_ACXE`/`tbl_nf_itens_ACXE`/`tbl_recebimentoNFe_ACXE`, cadastro ACXE);
  - `fornecedorNaoExcluidoSql` filtra por empresa;
  - a fila une as duas empresas quando a chave da ACXE está ligada;
  - `empresa` no formato de linha e nos tipos de resposta
- [ ] T048 [US5] Parametrizar por empresa `pc-sugestao.service.ts` (`tbl_pedidosCompras_ACXE`, cadastro ACXE) e `recebimento-fiscal.service.ts` (credencial `'acxe'` nas chamadas do cliente OMIE; `recebimento_fiscal.empresa` e `recebimento_fiscal_pc.empresa` preenchidos). A empresa vem da NF, nunca do corpo do POST
- [ ] T049 [US5] Entrada física da NF nacional da ACXE em `modules/stockbridge/src/services/recebimento-nacional.service.ts`:
  - locais oferecidos = `listarLocalidadesEspelhadas` (`localidade.service.ts`), com a correspondência em `localidade_correlacao`, incluindo o 21.1 EXTREMA;
  - criar em `modules/stockbridge/src/services/recebimento.service.ts` a função `executarEntradaNacionalDual` (ou equivalente), no modelo de `executarAjusteOmieDual` (~l.1217), mas com `ENT` nas duas empresas e **o mesmo valor unitário** (valor do item na NF por kg, sem o `× 1,145`);
  - `cod_int_ajuste` com sufixos `acxe-ent` / `q2p-ent` (`types.ts`);
  - falha só no lado da Q2P → `status_omie = 'pendente_q2p'`, reaproveitando o painel de retentativa;
  - **não** chamar a baixa de PC da 344
- [ ] T050 [US5] Em `apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx`: selo de empresa (ACXE/Q2P) na fila e no detalhe; seletor de local com a lista espelhada para NF da ACXE; texto "entrada na ACXE e na Q2P"
- [ ] T051 [P] [US5] Testes em `modules/stockbridge/src/__tests__/`:
  - fila com as duas empresas e a exclusão intercompany;
  - fiscal na ACXE com a credencial certa;
  - entrada dual com o mesmo valor, sem markup;
  - `pendente_q2p` em falha parcial;
  - nenhuma chamada da baixa da 344
- [ ] T052 [US5] Ativar o workflow n8n "ACXE - Exporta Recebimentos NF-e" (`contracts/espelhos-n8n.md` §2), aplicar a 0058 no UAT e validar o cenário 8 do quickstart antes de ligar `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED` em PROD

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T053 [P] Acrescentar as variáveis novas em `deploy/portainer/atlas.stack.yml`, no YAML do UAT (`uat-atlas - web e api.yaml`, na raiz do repositório) e no runbook. A stack lista variável por variável, então sem isso a config não chega
- [X] T054 [P] Registrar no `docs/prod-golive-runbook.md`, ou no runbook de deploy vigente, a ordem de ativação: **0056 → variáveis no Portainer → imagem com a 017** (chave da 016 ainda `false`) → conferir → T033 aprovado → `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=true` (as colunas do n8n já estão no ar desde 21/10/2026: pré-requisito, não passo). Revisto em 22/10/2026: a 0056 vem ANTES da imagem, como no runbook e no quickstart. Também o aviso de que religar a chave com imagem anterior volta o `IGNORAR`
- [X] T055 [P] Atualizar o bloco "StockBridge — status operacional (007)" em `CLAUDE.md` com a feature 017:
  - receita com vínculo;
  - `recebimento_fiscal_pc`;
  - NF sem PC configurável;
  - estoque já lançado bloqueado;
  - tolerâncias;
  - ACXE sempre espelhada, Extrema = 21.1, mesmo valor nas duas empresas
- [X] T056 Rodar `pnpm --filter @atlas/integration-omie test`, `pnpm --filter @atlas/stockbridge test` e `pnpm --filter @atlas/stockbridge typecheck` (envs dummy como no CI), mais `npm run lint`, e corrigir o que falhar
- [ ] T057 Validar os cenários 1 a 7, 9 e 10 do `specs/017-recebimento-nacional-com-pc/quickstart.md` no UAT (`OMIE_MODE=leitura`, escrita simulada na sombra) e registrar o resultado na ACXEGDP-437
- [X] T058 Abrir PR de `017-recebimento-nacional-com-pc` para `main` com o resumo das fases, as migrations (0056; 0057, cache de PCs vistos, na rodada de 22/10; 0058 só na Fase 2) e a ordem de ativação

---

## Phase 9: Ajustes pós-estreia (22/10/2026)

**Purpose**: o que a NF 60199 (Zaraplast × PC 306) mostrou em PROD no dia em que a chave foi religada: o OMIE baixa o PC na unidade da NF, o PC some da lista de pendentes, o PC da matriz serve à NF da filial e a escolha do PC por item é repetitiva. Pedidos do usuário, todos aprovados. Referências: research D14 a D17, spec FR-031 a FR-033 e Clarifications de 22/10/2026.

**Independent Test**: quickstart cenários 9 e 10.

- [X] T059 [P] [US2] Config da trava de unidade: `STOCKBRIDGE_PC_UNIDADE_DIFERENTE` (`bloquear` | `converter`, default `bloquear`) em `packages/core/src/config.ts` e nas stacks e exemplos (`.env.example`, `deploy/portainer/atlas.stack.yml`, `deploy/portainer/atlas.env.example`, `deploy/portainer/atlas-uat.env.example` e `uat-atlas - web e api.yaml`)
- [X] T060 [P] [US2] Cliente OMIE: `itensAjustes.nQtdeRecebida` em `packages/integrations/omie/src/stockbridge/recebimento-nfe.ts` (`AjustesItemRecebimento`, e `ItemRecebimentoNfe.nQtdeRecebida` no parser) e no mock (`mock.ts`), que grava o valor sem mexer em `nQtdeNFe`
- [X] T061 [US1] Trava de unidade na sugestão, em `pc-sugestao.service.ts` e `fila-nacional.service.ts`:
  - `modoUnidadeDiferentePc` e `opcoesPc`;
  - `ItemParaSugestao.unidadeNf` e `fatorUnidadeNf` (da conversão da 015);
  - `PcDoItem.unidadeIncompativel` e `PcCandidato.unidade`: PC em unidade diferente fora dos candidatos e dos "outros";
  - vínculo do OMIE em unidade diferente inelegível, com alerta;
  - motivo interno `unidade_pc` (situação `sem_pc`)
- [X] T062 [US2] Trava de unidade no POST e no fiscal:
  - `validarEscolhaPc` recusa o PC de `unidadeIncompativel` (`PC_NAO_ELEGIVEL` com texto de unidade);
  - `relerEReservarPcs` recusa PC em unidade diferente no modo `bloquear` (`409 PC_VINCULO_INVALIDO`) e, no `converter`, devolve `ReservaPc.nQtdeRecebida`;
  - `recebimento-fiscal.service.ts` manda `itensAjustes.nQtdeRecebida` no `EDITAR` e a confere em `ajustesJaAplicados`;
  - `recebimento-nacional.service.ts` repassa a unidade do item (`NF_SEM_PC` com texto próprio, `pcsUnidadeIncompativel` no aviso)
- [X] T063 [US3] Aviso a compras com o quadro "Pedido em unidade diferente da nota" em `notificacao.service.ts` (`unidadeIncompativel`), no lugar do quadro de outro cadastro (`pcsOutroCadastro` e `cnpjNf` removidos)
- [X] T064 [US1] PC de outro cadastro com a mesma raiz de CNPJ oferecido (D17): `carregarContextoPc` (`raizPorFornecedor`, `raizesDosCadastros`), `PcCandidato.outroCadastro` e `cnpjCadastro`, releitura ao vivo por raiz em `relerEReservarPcs`; remove o "só informativo" do motivo e do aviso a compras
- [X] T065 [US1] PC por NF (D14): `montarPcsDaNf` e os tipos `PcDaNf`, `PcDaNfItem` e `PcsDaNf` em `pc-sugestao.service.ts`; `DetalheNfNacional.pcsDaNf` em `fila-nacional.service.ts`. O POST continua por item
- [X] T066 Migration `packages/db/migrations/0057_stockbridge_pedido_compra_visto.sql` (cache de PCs vistos: tabela, índices e trigger de auditoria `trg_audit_sb_pedido_compra_visto`) e o schema Drizzle `pedidoCompraVisto` em `packages/db/src/schemas/stockbridge.ts`
- [X] T067 [US1] Cache de PCs vistos (D16): `modules/stockbridge/src/services/pc-visto.service.ts` (`registrarPcsVistos`, `registrarPcsVistosSeVencido`, `lerPcsVistos`), gravação no cron `5,35 * * * *` (`cron/index.ts`) e ao carregar o contexto da sugestão, leitura em `carregarContextoPc` (`fonte: 'cache'`, `dadosEmCache`, vínculo do OMIE com alerta) e `numerosDosPcs` com o cache como terceira fonte
- [ ] T068 [P] Testes (Vitest) da rodada, em `modules/stockbridge/src/__tests__/` e `packages/integrations/omie/src/__tests__/`:
  - `pc-sugestao.test.ts`: PC de outro cadastro (selo, sufixo no motivo, raiz de CNPJ);
  - `pc-por-nf.test.ts` (novo): `montarPcsDaNf`, incluindo o caso NF 60199 × PC 306;
  - `pc-unidade.test.ts` (novo): trava de unidade nos dois modos, da sugestão à releitura ao vivo;
  - `pc-reserva.test.ts`: releitura por raiz de CNPJ e unidade;
  - `recebimento-fiscal-pc.test.ts`: `nQtdeRecebida` no `EDITAR` (modo `converter`);
  - `pc-visto.test.ts` (a criar);
  - `notificacao-aviso-compras.test.ts`: quadro de unidade, sem o de outro cadastro (o teste antigo usava `pcsOutroCadastro`);
  - `recebimento-nfe.test.ts`: `nQtdeRecebida` no parser, no `EDITAR` e no mock;
  - auditoria (`ATLAS_DB_INTEGRATION=1`): trigger de `pedido_compra_visto`
- [ ] T069 [US1] Front, `apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx` e os tipos do web: escolha do PC uma vez por nota a partir de `pcsDaNf` (um `pc` por item no POST, mesma justificativa), marcação de outro cadastro (com o CNPJ formatado) e de dados em cache, `unidadeIncompativel` não selecionável com o motivo, e as mensagens dos erros de unidade
- [ ] T070 [P] Aplicar a 0057 no banco de dev (`psql -1 -f packages/db/migrations/0057_stockbridge_pedido_compra_visto.sql`) e conferir `to_regclass('stockbridge.pedido_compra_visto')` e o trigger; depois, UAT
- [ ] T071 Implantar a rodada em PROD pela ordem do runbook ("Ativação da feature 017", passo da 0057): **0057 → imagem seguinte à v1.1.20**, com `STOCKBRIDGE_PC_UNIDADE_DIFERENTE` em `bloquear`. Conferir o detalhe de uma NF com PC (número e saldo à vista) e o health
- [X] T072 [P] Documentação da rodada: research D14 a D17 (e D2, D3, D4, D8, D12), spec (Clarifications de 22/10, FR-002, FR-031 a FR-033), data-model §8 e §11, contrato (§2, §3, §5, §6), quickstart (cenários 9 e 10), plano, `CLAUDE.md` (parágrafo da 017), `docs/prod-golive-runbook.md` e a seção 2 de `specs/007-stockbridge-module/research.md`
- [ ] T073 [US2] Teste do modo `converter` com NF real (quickstart, cenário 10.6), **com autorização do usuário**: NF em toneladas contra PC em kg, `EDITAR` com `nQtdeRecebida` e `Concluir`, em workflow n8n de teste nos moldes do T033. Conferir `nQtdeRec` do PC na unidade do PC, `nQtdeNFe` da NF inalterada, um só título de conta a pagar e estoque sem movimento. Registrar em research D15
- [ ] T074 [US2] Decisão de ligar `STOCKBRIDGE_PC_UNIDADE_DIFERENTE=converter` em PROD, só depois do T073 aprovado. Até lá o padrão é `bloquear`
- [ ] T075 [US2] T033 (c) e (d) quando houver NF: (c) troca de um vínculo existente por `ASSOCIAR-PEDIDO` (inclusive entre cadastros) e (d) NF menor que o saldo do PC (o saldo fica aberto?). Registrar em research D2. Se o OMIE recusar a troca, vale o plano B da D2

**Checkpoint**: PC por NF, PC de outro cadastro, trava de unidade e cache de PCs vistos no ar; `converter` só depois do T073 e do T074.

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2 → histórias.** O T003 (n8n) corre em paralelo com tudo e só bloqueia a validação em UAT/PROD (T057). Em dev, o espelho é populado por linhas de teste.
- **US1 (Phase 3)** é o MVP e depende só da Phase 2.
- **US2 (Phase 4)** depende do T018 (sugestão) e do T023 (validação da escolha). O T033 (teste com NF real) pode rodar a qualquer momento depois da Phase 2, mas bloqueia a ativação.
- **US3 (Phase 5)** depende do T023 (portão 1) e do T027 (fiscal, para o modo "receber sem vínculo").
- **US4 (Phase 6)**: o T039 (estoque já lançado) depende só do T017 e pode ser feito logo após a Phase 2, porque protege a contenção atual. Os demais dependem da US2.
- **Phase 8** depois das Histórias 1 a 4 (Fase 1 de entrega).
- **US5 (Phase 7)** depois do deploy da Fase 1.
- **Phase 9 (ajustes pós-estreia)** sobre a Fase 1 já em PROD. T061 a T065 dependem do T018/T020 (sugestão e detalhe); T067 depende do T066; o front (T069) depende de T065 e T061; o deploy (T071) depende de T066, T068 e T069 e vem depois do T070; T074 depende do T073.

```
Phase 2 ──▶ US1 (T017–T025) ──▶ US2 (T026–T033) ──▶ US3 (T034–T037)
   │                                   └──────────▶ US4 (T038, T040–T044)
   └──▶ T039 (estoque já lançado — pode antecipar)
US1–US4 ──▶ Phase 8 (T053–T058) ──▶ deploy Fase 1 ──▶ Phase 9 (T059–T075) ──▶ US5 (T045–T052)
T003 (n8n) ───────────────────────────────▶ validações em UAT/PROD
```

## Parallel Execution Examples

- **Phase 2**: T010 (config) → T007 (monitoramento da cópia de PCs), T011 → T013 (cliente OMIE e testes), T014 (doc 007), T015 (leitores) e T016 (auditoria, depois do T009) em paralelo com T005, T006, T008 e T009 (migration e schema).
- **US1**: T019 (testes da sugestão) em paralelo com T020 depois do T018; T021 e T024 em paralelo; T025 (UI) em paralelo com T022–T023 depois de fixado o formato.
- **US3 ∥ US4**: frentes independentes depois da US2. Uma no portão 1 e na notificação, a outra na retomada, na rejeição e na UI de estoque já lançado.
- **Phase 8**: T053, T054 e T055 em paralelo.

## Implementation Strategy

1. **Proteção imediata**: o T039 (estoque já lançado), logo depois da Phase 2, já protege a contenção atual (fiscal concluído no portal), com a chave desligada.
2. **MVP = Phase 1 + 2 + US1 + US2**: sugestão, confirmação e fiscal com vínculo. Demonstrável em dev (mock) e em UAT (sombra do modo leitura).
3. **US3 e US4** completam a Fase 1: regra de NF sem PC, avisos e robustez.
4. **Ativação da Fase 1**: o deploy segue a ordem do T054 e o T033 aprovado é pré-requisito. Religar a chave primeiro no UAT, observar algumas NFs reais em PROD com a chave ligada e encerrar a contenção (SC-007).
5. **Ajustes pós-estreia (Phase 9)**: a Fase 1 entrou em PROD em 22/10/2026 e a NF 60199 pediu os quatro ajustes. A 0057 vai antes da imagem; `converter` só depois do teste com NF real.
6. **Fase 2 (US5)**: só depois da Fase 1 estável em PROD e de existirem PCs nacionais na ACXE.

## Format Validation

Todas as tarefas seguem `- [ ] T### [P?] [US?] descrição com caminho de arquivo`. Setup, Foundational e Polish não têm rótulo de história; US1 a US5 têm. O T003, o T033, o T052, o T057, o T070, o T071, o T073, o T074 e o T075 são tarefas operacionais (n8n, teste com NF real, deploy, validação em UAT) e citam os artefatos onde o resultado é registrado.

Total: **75 tarefas**:

| Fase | Tarefas |
|---|---|
| Setup | 4 |
| Foundational | 12 |
| US1 | 9 |
| US2 | 8 |
| US3 | 4 |
| US4 | 7 |
| US5 | 8 |
| Polish | 6 |
| Ajustes pós-estreia (22/10/2026) | 17 |
