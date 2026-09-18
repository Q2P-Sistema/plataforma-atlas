---
description: "Task list — Recebimento Nacional a partir da NF do Fornecedor"
---

# Tasks: Recebimento Nacional a partir da NF do Fornecedor

**Input**: Design documents from `/specs/015-recebimento-nacional-nf/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/
**Jira**: ACXEGDP-328

**Tests**: incluídos. A spec exige cobertura Vitest de normalização de unidade, match de correlação e idempotência (Critérios de Aceite), e o caminho nacional **não tem teste nenhum hoje** (research D16).

**Organization**: agrupadas por história de usuário, para implementação e entrega incrementais.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos distintos, sem dependência pendente)
- **[Story]**: história a que pertence (US1–US6)

## Path Conventions

Monorepo modular: `modules/stockbridge/src/` (backend), `apps/web/src/` (frontend), `packages/db/` (schema e migrations).

---

## Phase 1: Setup

**Purpose**: preparar o terreno; o projeto já existe, então isto é verificação, não inicialização.

- [x] T001 Confirmar que a branch `015-recebimento-nacional-nf` está atualizada com `uat` e que `pnpm install` roda limpo na raiz do repositório
- [x] T002 Confirmar a numeração da migration com `ls packages/db/migrations/ | tail -5` — a próxima livre deve ser `0052` (última aplicada: `0051_stockbridge_baixa_pedido_aguardando_vinculo.sql`)
- [x] T003 [P] Confirmar em UAT, por consulta, o passivo das NFs 66529/66530/66604 e anexar o resultado ao card ACXEGDP-328 (não a `research.md`, que é documento de decisão da Fase 0; não bloqueia a migration — ver plan.md, Complexity Tracking nota 1)

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: nenhuma história pode começar antes desta fase terminar.

**Purpose**: migration, schema e as duas peças de baixo nível que todas as histórias consomem.

### Migration e schema

- [x] T004 Editar `packages/db/src/schemas/stockbridge.ts` adicionando: a tabela `correlacaoProdutoFornecedor` (data-model.md §1); cinco colunas em `movimentacao` — `nfChaveAcesso` (`varchar(44)`), `nfItemDescricao` e `nfItemDescricaoNormalizada` (`varchar(500)`), `quantidadeNfKg` e `quantidadeDivergenciaKg` (`numeric(12,3)`); três colunas em `aprovacao` — `nfChaveAcesso`, `notaFiscal`, `nfItemDescricao`; e o novo valor `'recebimento_externo'` no union de `tipoAprovacao`
- [x] T005 Criar `packages/db/migrations/0052_stockbridge_recebimento_nacional_nf.sql` com cabeçalho Antes/Agora/Porque, contendo: (a) `CREATE TABLE stockbridge.correlacao_produto_fornecedor`, (b) `ALTER TABLE stockbridge.movimentacao` com as 5 colunas, (c) `ALTER TABLE stockbridge.aprovacao` com as 3 colunas, o CHECK de `tipo_aprovacao` estendido **e o relaxamento de `aprovacao_chk_lote_ou_sku`** para admitir `tipo_aprovacao = 'recebimento_externo' AND nf_chave_acesso IS NOT NULL` — sem isso todo INSERT de baixa externa falha com `23514` (data-model.md §5), (d) `CREATE EXTENSION IF NOT EXISTS unaccent` — a normalização de descrição roda em SQL na query da fila e a extensão **não está criada** no banco (disponível, porém ausente); sem ela a query falha e o degradê de T014 devolve fila vazia em silêncio, (e) índice único em `(fornecedor_cnpj, descricao_normalizada, produto_codigo_q2p) WHERE ativo = true`, (f) índice único `movimentacao_nf_nacional_idempotencia_idx` em `(nf_chave_acesso, nf_item_descricao_normalizada, produto_codigo_q2p) WHERE subtipo = 'compra_nacional' AND ativo = true AND nf_chave_acesso IS NOT NULL AND produto_codigo_q2p IS NOT NULL` — a descrição entra na chave para que duas linhas distintas da NF classificadas no mesmo produto não colidam e percam quantidade (research D20)
- [x] T006 Adicionar na mesma migration `0052` a trigger de auditoria obrigatória da tabela nova: função `stockbridge.audit_correlacao_produto_fornecedor()` + trigger `trg_audit_sb_correlacao_produto_fornecedor` cobrindo INSERT/UPDATE/DELETE, no padrão de `packages/db/migrations/0008_stockbridge_core.sql` (Princípio IV — sem isso a migration está incorreta)
- [x] T006a Semear na mesma migration `0052` as exclusões de fornecedor decididas em 17/09/2026 — PLASTFIX COMERCIAL LTDA (`29.654.678/0001-70`) e a contraparte intercompany ACXE (`42.672.052/0001-54`) — com `INSERT ... SELECT` resolvendo `excluido_por` (coluna `NOT NULL` → `atlas.users`) no padrão de `packages/db/migrations/0025_stockbridge_user_galpao_n2n.sql`, e `ON CONFLICT` com o predicado parcial de `fornecedor_exclusao_ativa_idx`. Sem isto a fila nasce com 77% de NFs que o usuário tirou do escopo
- [x] T006b [P] Cobrir o seed em `modules/stockbridge/src/__tests__/fila-nacional.test.ts`: após a `0052`, existe exclusão ativa para os dois CNPJs e a fila não devolve NF cujo `dest_cnpj_cpf` esteja entre eles
- [x] T006c [P] Criar `modules/stockbridge/src/__tests__/auditoria-correlacao.test.ts` com um teste de integração que confirma gravação em `shared.audit_log` após INSERT e UPDATE em `stockbridge.correlacao_produto_fornecedor` — gate explícito do Princípio IV, hoje verificado só manualmente — *pula sem `DATABASE_URL`; roda contra banco real com a 0052 aplicada*
- [ ] T007 Aplicar e validar localmente com `pnpm --filter @atlas/db migrate`, confirmando que os dois índices únicos foram criados, que a trigger grava em `shared.audit_log` e que as duas linhas de exclusão de fornecedor ficaram ativas em `stockbridge.fornecedor_exclusao`

- [x] T007a Adicionar em `packages/core/src/config.ts` a chave `STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE` (data ISO, **sem default silencioso** — ausente, a fila não sobe), origem do corte fixo de FR-023, e documentá-la em `.envrc.example`

### Peças de baixo nível

- [x] T008 [P] Criar `modules/stockbridge/src/services/unidade-nf.ts` com a tabela explícita de grafias da NF (`KG`→1, `TON`→1000, `TL`→1000) e função de conversão que devolve resultado tipado indicando **bloqueio** para unidade ausente — nunca `NaN`, nunca fator default (research D5, D15). NÃO reusar `normalizarUnidade` de `recebimento.service.ts`, que assume `kg` no default
- [x] T008a [P] Acrescentar em `modules/stockbridge/src/services/unidade-nf.ts` a **conferência de coerência** (FR-029, research D24): calcular o R$/kg pela unidade declarada e pela leitura alternativa; declarado plausível (R$ 0,10–100/kg) converte, declarado implausível com alternativo plausível **bloqueia por contradição**, nenhum plausível **bloqueia por inconclusivo**. Medido: 1.612 liberados, 14 bloqueados, 0 inconclusivos. **Não** usar faixa de preço absoluto — reprovaria 10 itens de papelão e sucata legitimamente baratos
- [x] T009 [P] Criar `modules/stockbridge/src/__tests__/unidade-nf.test.ts` cobrindo as 3 unidades conversíveis, o bloqueio por unidade desconhecida (`UN`), o **bloqueio por incoerência** (NF 58067: `q_com=1,375`, `u_com='KG'` → R$ 14.801/kg lido como KG, R$ 14,80/kg lido como tonelada) e a **não-regressão de material barato** (papelão a R$ 0,35/kg em KG e sucata a R$ 300/t em TON seguem liberados), caixa/espaços na grafia, e a ausência de conversão implícita em qualquer caminho
- [x] T010 Parametrizar `modules/stockbridge/src/services/fiscal-recebida-sql.ts`: `recebidaViaMovimentacaoSql` passa a aceitar o `subtipo` e a **coluna de produto** como parâmetros opcionais, com defaults `'importacao'` e `produto_codigo_acxe` — preservando byte a byte o SQL gerado hoje (research D11)
- [x] T011 Adicionar em `modules/stockbridge/src/services/fiscal-recebida-sql.ts` a checagem de "recebida" do caminho nacional em **duas vias** (data-model.md §3.1): por `nf_chave_acesso` + `nf_item_descricao_normalizada` para o que esta feature grava, **OU** por `subtipo = 'compra_nacional'` + número da NF sem zeros à esquerda + `empresa` para as linhas com `nf_chave_acesso IS NULL` — o filtro por subtipo **não é opcional**: sem ele o ramo casa com as saídas automáticas da Q2P, que também gravam `nota_fiscal` + `empresa` sem chave, e uma NF de compra pendente sumiria da fila — as 145 movimentações do formulário manual, que nunca terão chave. Incluir também os itens baixados por `recebimento_externo` aprovado
- [x] T011a [P] Cobrir a segunda via em `modules/stockbridge/src/__tests__/fiscal-recebida-nacional.test.ts`: NF recebida pelo formulário manual (sem chave) é reconhecida; saída automática com o mesmo número **não** é confundida com recebimento; item com baixa externa aprovada sai da fila
- [x] T012 Criar `modules/stockbridge/src/__tests__/fiscal-recebida-regressao.test.ts` provando, por inspeção do SQL gerado, que os 5 serviços consumidores (`cockpit`, `cockpit-executivo`, `pendencias-fiscais`, `nf-pedido-mapa`, `recebimento`) produzem SQL **idêntico** ao anterior à parametrização

**Checkpoint**: migration aplicada, conversão de unidade testada, `fiscal-recebida-sql` estendido sem regressão. As histórias podem começar.

---

## Phase 3: User Story 1 — Receber uma NF nacional sem redigitar o documento (P1) 🎯 MVP

**Goal**: o operador escolhe a NF numa fila, vê os itens preenchidos pelo espelho e dá entrada sem digitar valor nem unidade.

**Independent Test**: com uma NF elegível no espelho (CFOP do recorte, fornecedor não excluído, não recebida), completar o recebimento com todos os campos numéricos vindos do documento — correlacionando o produto manualmente a cada vez.

### Backend

- [x] T013 [US1] Criar `modules/stockbridge/src/services/fila-nacional.service.ts` com a query da fila sobre `public."tbl_nf_header_Q2P"` ⋈ `public."tbl_nf_itens_Q2P"`, aplicando: `tp_nf = 0`, CFOP em `('1.101','1.102','2.101','2.102')` (com ponto — research D6), `nfValidaSql` para cancelada/deletada — passando explicitamente `tbl_nf_header_Q2P` a `colunaCanceladaExiste`, cujo default é a tabela ACXE, corte **fixo** de 7 dias anteriores ao go-live, vindo de configuração e não de query string (research D23), exclusão por `stockbridge.fornecedor_exclusao` (research D4) e `HAVING` itens pendentes > 0
- [x] T014 [US1] Implementar em `fila-nacional.service.ts` o degradê de falha no padrão de `getFilaPendente`: erro de banco loga `warn` e devolve lista vazia, sem derrubar a tela
- [x] T015 [US1] Implementar em `fila-nacional.service.ts` o detalhe da NF por chave de acesso, devolvendo os itens com descrição, quantidade, unidade original, `quantidadeNfKg` convertida (via T008), `v_un_com` e `v_tot_item`, e o total derivado `SUM(v_tot_item)` (research D3 — o espelho não guarda total de cabeçalho)
- [x] T016 [US1] Agregar itens de mesma descrição dentro da NF antes de devolver o detalhe, em `modules/stockbridge/src/services/fila-nacional.service.ts` — a NF 58396 da Zaraplast tem 6 linhas para 4 descrições distintas (research D18)
- [x] T017 [US1] Estender `modules/stockbridge/src/services/recebimento-nacional.service.ts` com `processarRecebimentoNacionalPorNf`, que resolve quantidade e valor **no servidor** a partir do espelho (valor = `v_tot_item`, sem rateio por peso), grava `nf_chave_acesso`, `nf_item_descricao` e `nf_item_descricao_normalizada`, grava `nota_fiscal` **sem zeros à esquerda** (formato das 145 linhas históricas, exigido pela busca do painel de Movimentações), preenche `quantidade_nf_kg` e `quantidade_divergencia_kg` mesmo sem divergência, e cria 1 movimentação + 1 aprovação de gestor por produto. **Uma transação por produto**, não uma transação única para a NF: no Postgres a violação `23505` aborta a transação inteira, então o desfecho por item prometido pelo contrato (`ja_recebido` ao lado de `aguardando_aprovacao`) é impossível dentro do `db.transaction` único que o fluxo manual usa hoje em `recebimento-nacional.service.ts:283`. O caminho manual existente NÃO pode ser alterado
- [x] T018 [US1] Traduzir violação `23505` de `movimentacao_nf_nacional_idempotencia_idx` para `status: 'ja_recebido'` do produto em `modules/stockbridge/src/services/recebimento-nacional.service.ts`, em vez de erro da requisição (contrato §3)
- [x] T019 [US1] Adicionar em `modules/stockbridge/src/routes/recebimento-nacional.routes.ts` as rotas `GET /recebimento/nacional/fila` e `GET /recebimento/nacional/fila/:chaveAcesso` com `requireOperador` + `requireArmazemVinculado` e schemas Zod conforme contrato §1 e §2
- [x] T020 [US1] Adicionar a rota `POST /recebimento/nacional/por-nf` em `modules/stockbridge/src/routes/recebimento-nacional.routes.ts`, com Zod recusando explicitamente valor de item e valor total no payload, e devolvendo `201` com desfecho por produto (contrato §3)
- [x] T021 [US1] Garantir em `modules/stockbridge/src/routes/recebimento-nacional.routes.ts` e `modules/stockbridge/src/services/recebimento-nacional.service.ts` que toda mensagem de erro nomeia produto por **descrição** e local por **nome**, nunca por código OMIE (FR-015 / ACXEGDP-313)

### Frontend

- [x] T022 [P] [US1] Criar `apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx` com a lista da fila (número, data, Fornecedor, nº de itens, valor total) e aging visual, no padrão de `ImportacaoSection` em `FilaOmiePage.tsx`
- [x] T023 [US1] Implementar em `apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx` o detalhe da NF ao clicar, com os itens em modo leitura para valor e unidade, e seleção de produto e estoque destino por item
- [x] T024 [US1] Alterar `apps/web/src/pages/stockbridge/operador/FilaOmiePage.tsx` para que a aba "Compra nacional" alterne entre a fila nova e o formulário manual existente, sem remover o manual (FR-014)
- [x] T025 [US1] Rotular a contraparte como **"Fornecedor"** em `apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx`, na fila e no detalhe — nunca "Destinatário" (research D7)

### Testes

- [x] T026 [P] [US1] Criar `modules/stockbridge/src/__tests__/fila-nacional.test.ts` provando por inspeção do SQL gerado as exclusões obrigatórias: CFOP fora do recorte, cancelada/deletada, fornecedor excluído, fora da janela e NF já recebida
- [x] T027 [P] [US1] Criar `modules/stockbridge/src/__tests__/recebimento-nacional-nf.test.ts` cobrindo o caminho limpo: valor do item = `v_tot_item`, criação de 1 movimentação + 1 aprovação, e `nf_chave_acesso` gravada
- [x] T027a [P] [US1] Cobrir em `modules/stockbridge/src/__tests__/recebimento-nacional-nf.test.ts` a recusa de `localidade_id` espelhada no `POST /por-nf` (FR-011) — a garantia já existe em `resolverLocalidadesParaItens`, mas nenhum teste a fixa para o caminho novo
- [x] T027b [P] [US1] Cobrir em `modules/stockbridge/src/__tests__/fila-nacional.test.ts` que a fila não chama a API do OMIE (FR-016, Princípio II): espionar o cliente OMIE e assertar zero invocações durante `GET /fila` e `GET /fila/:chaveAcesso`
- [x] T028 [US1] Criar `modules/stockbridge/src/__tests__/recebimento-nacional-nf.routes.test.ts` com Supertest das 3 rotas novas, cobrindo roles, `400` de payload inválido e a recusa de valor enviado pelo cliente

**Checkpoint**: MVP entregável. O operador já recebe NF nacional sem redigitar valor nem unidade.

---

## Phase 4: User Story 2 — Registrar o peso conferido na balança (P2)

**Goal**: entrar com o que a balança mediu, não com o que a NF declara, deixando a diferença auditável.

**Independent Test**: receber uma NF com quantidade conferida diferente da declarada, verificar exigência de motivo, criação da aprovação e gravação dos três números.

- [x] T029 [US2] Estender `processarRecebimentoNacionalPorNf` em `recebimento-nacional.service.ts` para aceitar `quantidade_conferida_kg` por item, com fallback para a quantidade da NF quando ausente (FR-017)
- [x] T030 [US2] Calcular em `modules/stockbridge/src/services/recebimento-nacional.service.ts` a divergência como `quantidade_conferida_kg − quantidadeNfKg`, marcando divergência quando `|delta| > 1` — mesma tolerância da importação (FR-018)
- [x] T031 [US2] Exigir `motivo_divergencia` em `modules/stockbridge/src/services/recebimento-nacional.service.ts` quando houver divergência, recusando com `MOTIVO_DIVERGENCIA_OBRIGATORIO`; **aceitar delta positivo** (peso maior que a NF), diferente da importação que lança `QuantidadeExcedeNfError` (FR-019, research D17)
- [x] T032 [US2] Gravar `quantidade_kg` (conferida), `quantidade_nf_kg` e `quantidade_divergencia_kg` no insert de movimentação em `modules/stockbridge/src/services/recebimento-nacional.service.ts`, de modo que a diferença seja reconstituível depois (FR-020)
- [x] T033 [US2] Encaminhar item divergente para aprovação de gestor com o motivo no registro, em `modules/stockbridge/src/services/recebimento-nacional.service.ts`, reusando o fluxo de aprovação já existente
- [x] T034 [US2] Adicionar no painel `RecebimentoNacionalNfPanel.tsx` o campo de quantidade conferida (pré-preenchido com o valor da NF) e o campo de motivo, que aparece só quando a diferença ultrapassa a tolerância
- [x] T035 [US2] Exibir em `apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx` a diferença calculada em tempo real (NF × conferido × delta), para que o operador veja o que está declarando antes de enviar
- [x] T035a [US2] Preencher `aprovacao.quantidade_prevista_kg` (quantidade da NF) e `quantidade_recebida_kg` (conferida) em `modules/stockbridge/src/services/recebimento-nacional.service.ts` — sem esses campos a tela de aprovação não tem como montar o painel NF × conferido × diferença
- [ ] T035a2 [US2] Estender `listarPendencias` em `modules/stockbridge/src/services/aprovacao.service.ts` e a interface `PendenciaItem`: selecionar `produto_codigo_q2p`, fazer `LEFT JOIN public."tbl_produtos_Q2P"` (hoje só existe o JOIN com `tbl_produtos_ACXE`, nulo neste fluxo, caindo em `SKU 0`) e expor `nota_fiscal`, `nf_item_descricao`, `quantidade_prevista_kg` e `quantidade_recebida_kg`. Sem isto o dado não chega ao frontend e T035b não tem o que renderizar
- [ ] T035b [US2] Ajustar `apps/web/src/pages/stockbridge/gestor/AprovacoesPage.tsx` para resolver a descrição do produto pelo catálogo **Q2P** quando `produto_codigo_acxe` for nulo, e exibir NF, conferido e diferença nas aprovações de recebimento nacional (FR-028). Hoje a tela resolve produto só pelo cadastro ACXE, que é nulo neste fluxo — o gestor aprovaria a divergência sem ver a divergência
- [x] T036 [P] [US2] Criar `modules/stockbridge/src/__tests__/divergencia-nacional.test.ts` cobrindo: dentro da tolerância não exige motivo; acima exige; delta **positivo é aceito**; delta negativo é aceito; e os três campos são gravados corretamente — *coberto em `recebimento-nacional-nf.test.ts` (bloco "divergencia de peso")*

**Checkpoint**: os ~32% de recebimentos que divergem passam a deixar rastro — hoje nenhum deixa.

---

## Phase 5: User Story 3 — Reaproveitar a correlação produto↔descrição (P3)

**Goal**: correlacionar uma vez por par (fornecedor, descrição) e receber pré-selecionado nas próximas.

**Independent Test**: correlacionar um item, receber, abrir outra NF do mesmo fornecedor com descrição idêntica e ver o produto pré-selecionado.

- [ ] T037 [US3] Criar `modules/stockbridge/src/services/correlacao-produto.service.ts` com a normalização de descrição (trim, colapso de espaços, caixa alta, remoção de acentuação — data-model.md §1.1) aplicada tanto na gravação quanto na consulta
- [ ] T038 [US3] Implementar em `modules/stockbridge/src/services/correlacao-produto.service.ts` a consulta de sugestão: dado (fornecedor, descrição normalizada), devolver os produtos ativos ordenados por `vezes_usada DESC`
- [ ] T039 [US3] Implementar em `modules/stockbridge/src/services/correlacao-produto.service.ts` a gravação da correlação, incrementando `vezes_usada` e `ultima_vez_usada_em` quando a sugestão é aceita, e registrando `atualizado_por` na correção
- [ ] T040 [US3] Ligar a sugestão ao detalhe da NF em `fila-nacional.service.ts`, preenchendo `produtosSugeridos` por item e marcando `bloqueio: 'sem_correlacao'` quando o par é inédito (FR-005, FR-006)
- [ ] T041 [US3] Gravar a correlação automaticamente ao concluir o recebimento, em `modules/stockbridge/src/services/recebimento-nacional.service.ts`, para que a escolha do operador valha nas próximas NFs (FR-007)
- [ ] T042 [US3] Adicionar a rota `PUT /recebimento/nacional/correlacao` em `modules/stockbridge/src/routes/recebimento-nacional.routes.ts`, conforme contrato §4, com `requireOperador`
- [ ] T043 [US3] Pré-selecionar o produto sugerido em `apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx` e permitir a troca, mantendo o combobox existente de `/recebimento/nacional/produtos` como caminho de busca
- [ ] T044 [P] [US3] Criar `modules/stockbridge/src/__tests__/correlacao-produto.test.ts` cobrindo a normalização (incluindo os casos que fundem grafias — research D8), a sugestão de par conhecido, o par inédito sem sugestão, e a correção por UPDATE auditado

**Checkpoint**: NFs recorrentes passam a exigir só confirmação.

---

## Phase 6: User Story 4 — Classificar um item da NF em vários produtos (P4)

**Goal**: sucata entra como uma linha fiscal e vira N produtos de estoque, com o valor rateado por peso.

**Independent Test**: receber uma NF de item único distribuindo entre 3 produtos; conferir que a soma fecha com o peso conferido e a soma dos valores fecha com o valor do item.

- [x] T045 [US4] Estender o Zod de `POST /por-nf` em `modules/stockbridge/src/routes/recebimento-nacional.routes.ts` e a assinatura de `processarRecebimentoNacionalPorNf` em `modules/stockbridge/src/services/recebimento-nacional.service.ts` para aceitar `produtos[]` por item, cada um com produto, quantidade e localidade (contrato §3)
- [x] T046 [US4] Validar em `modules/stockbridge/src/services/recebimento-nacional.service.ts` que `Σ produtos[].quantidade_kg` é igual à **quantidade restante** do item (conferida menos o já recebido), não à conferida total — senão a retomada de um item parcialmente recebido pediria ao operador redistribuir peso que já entrou, recusando com `DISTRIBUICAO_NAO_FECHA` (FR-021)
- [x] T047 [US4] Ratear o valor do item entre os produtos em `modules/stockbridge/src/services/recebimento-nacional.service.ts`, com decimal.js, usando como denominador a **quantidade conferida do item inteiro** e nunca o `Σ` da submissão (data-model.md §6): `quantidade_nf_kg = quantidade_nf_do_item × (kg_produto / quantidade_conferida_do_item)`, `valor_produto = v_tot_item × (quantidade_nf_kg / quantidade_nf_do_item)` (FR-022). Com o `Σ` da submissão, uma NF recebida em duas levas grava o valor integral do item **em cada uma** — dobro do valor da NF no estoque
- [x] T048 [US4] Criar uma movimentação + aprovação **por produto** resultante, e não por item da NF, em `modules/stockbridge/src/services/recebimento-nacional.service.ts`
- [ ] T049 [US4] Estender `correlacao-produto.service.ts` para memorizar o **conjunto** de produtos por descrição, desativando (`ativo = false`, auditado) os que saírem do conjunto — nunca `DELETE`
- [ ] T050 [US4] Permitir em `apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx` adicionar e remover produtos de um item, com a distribuição de quantidade e um indicador de quanto falta para fechar
- [ ] T050a [US4] Manter o item na fila enquanto `quantidadeRestanteKg > 1` (tolerância de FR-018) em `modules/stockbridge/src/services/fila-nacional.service.ts`, com `quantidadeRestanteKg = quantidade_nf_do_item − Σ quantidade_nf_kg das movimentações ativas` — âncora no lado da **NF**, não na quantidade conferida, que não é persistida e prende o item na fila nas duas pontas da divergência (data-model.md §4.2). Exibir o que já entrou e o que falta (FR-030) — um `EXISTS` puro tiraria o item da fila com apenas 1 dos N produtos gravado, e o peso restante nunca entraria no estoque
- [x] T051 [P] [US4] Criar `modules/stockbridge/src/__tests__/distribuicao-nacional.test.ts` cobrindo: soma que não fecha é recusada; rateio por peso reproduz o `v_tot_item`; N movimentações criadas; o resíduo de arredondamento fica dentro da tolerância de centavos; a **retomada** de um item com 1 de 3 produtos já gravado pede apenas o restante; a **soma dos valores gravados em duas submissões parciais fecha em `v_tot_item`**, não no dobro; e item 1:1 com divergência negativa acima da tolerância **sai** da fila após recebido — *coberto em `recebimento-nacional-nf.test.ts` (bloco "distribuicao 1:N")*

**Checkpoint**: fornecedores de sucata (ISOFORMA) passam a caber na fila.

---

## Phase 7: User Story 5 — Bloquear item com unidade não conversível (P5)

**Goal**: unidade desconhecida bloqueia o item, com mensagem clara e sem conversão aproximada.

**Independent Test**: item em unidade fora da tabela fica bloqueado com mensagem nomeando a unidade, enquanto os demais itens da NF seguem recebíveis.

- [x] T052 [US5] Propagar o bloqueio de `unidade-nf.ts` para o detalhe da NF em `modules/stockbridge/src/services/fila-nacional.service.ts`: item com unidade desconhecida vem com `bloqueio: 'unidade_nao_conversivel'` e item com unidade incoerente com `bloqueio: 'unidade_incoerente'` — valores distintos, porque a causa e a mensagem são diferentes (FR-009, FR-029). Nos dois casos `quantidadeNfKg: null`
- [x] T053 [US5] Recusar qualquer item bloqueado por unidade em `modules/stockbridge/src/services/recebimento-nacional.service.ts` devolvendo o **status por produto** (`bloqueado_unidade` ou `bloqueado_unidade_incoerente`), nunca erro `422` da requisição — o contrato retirou `UNIDADE_NAO_CONVERSIVEL` como código de erro justamente porque os demais itens da NF precisam ser recebidos
- [x] T054 [US5] Permitir em `modules/stockbridge/src/services/recebimento-nacional.service.ts` que os demais itens da mesma NF sejam recebidos quando um item está bloqueado (edge case da spec)
- [x] T055 [US5] Exibir o item bloqueado em `apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx` com estado visual distinto e a mensagem da unidade, sem permitir seleção de produto
- [x] T056 [P] [US5] Estender `modules/stockbridge/src/__tests__/unidade-nf.test.ts` com o caso de NF mista — um item bloqueado e outros recebíveis na mesma nota — *coberto em `recebimento-nacional-nf.test.ts` ("NF mista")*

**Checkpoint**: História 5 entregue.

---

## Phase 8: User Story 6 — Dar baixa em NF que já entrou fora do Atlas (P2)

**Goal**: retirar da fila, com aprovação de gestor, itens que já entraram no estoque por fora do Atlas — sem criar movimentação nem tocar no OMIE.

**Independent Test**: declarar recebimento externo de uma NF da fila, aprovar como gestor, e verificar que o item sumiu da fila, que nenhuma movimentação foi criada e que o estoque não mudou.

- [ ] T064 [US6] Adicionar a flag `STOCKBRIDGE_RECEBIMENTO_EXTERNO_ENABLED` (default `true`) em `packages/core/src/config.ts`, no padrão de `STOCKBRIDGE_BAIXA_PEDIDO_Q2P_ENABLED`
- [ ] T065 [US6] Criar `modules/stockbridge/src/services/recebimento-externo.service.ts` que grava em `stockbridge.aprovacao` com `tipo_aprovacao='recebimento_externo'`, `precisa_nivel='gestor'`, `movimentacao_id` e `lote_id` nulos, e as colunas de NF (`nf_chave_acesso`, `nota_fiscal`, `nf_item_descricao`). Motivo obrigatório em `observacoes`
- [ ] T066 [US6] Garantir em `recebimento-externo.service.ts` que a aprovação **não** cria movimentação, **não** altera estoque e **não** chama o OMIE — é o invariante 9 do contrato e a única salvaguarda contra a ação virar um sumidouro de trabalho
- [ ] T067 [US6] Adicionar em `modules/stockbridge/src/services/aprovacao.service.ts` o ramo de `tipo_aprovacao='recebimento_externo'` na função `aprovar()`, que apenas muda o status — sem passar pelo caminho de ajuste OMIE de `aprovarEntradaNacional`
- [ ] T068 [US6] Adicionar a rota `POST /recebimento/nacional/recebimento-externo` em `modules/stockbridge/src/routes/recebimento-nacional.routes.ts` conforme contrato §5, recusando com `403 RECEBIMENTO_EXTERNO_DESABILITADO` quando a flag estiver desligada
- [ ] T069 [US6] Refletir a baixa na fila em `modules/stockbridge/src/services/fila-nacional.service.ts`: item com `recebimento_externo` **aprovado** sai da fila; com solicitação **pendente**, continua visível marcado como "baixa solicitada"; **rejeitada**, volta a pendente normal
- [ ] T069a [US6] Adicionar `'recebimento_externo'` ao mapa `TIPO_LABEL` de `apps/web/src/pages/stockbridge/gestor/AprovacoesPage.tsx` e renderizar o card com NF, descrição do item e motivo — sem produto e sem painel de divergência. Hoje o fallback imprime o identificador cru e o título cai em `SKU 0`, violando FR-015
- [ ] T070 [US6] Adicionar a ação na UI (`apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx`) com motivo obrigatório e atalho de "todos os itens pendentes", escondida quando a flag estiver desligada
- [ ] T071 [P] [US6] Criar `modules/stockbridge/src/__tests__/recebimento-externo.test.ts` cobrindo: motivo ausente recusa; aprovação retira da fila; **nenhuma movimentação criada**; rejeição devolve à fila; item já recebido recusa com `ITEM_JA_RECEBIDO`; flag desligada recusa a rota
- [ ] T071a [US6] Implementar a reversão em `modules/stockbridge/src/services/recebimento-externo.service.ts`: função que devolve uma aprovação `recebimento_externo` de `aprovada` para `pendente` com motivo, auditada. Hoje nada no código reverte uma aprovação já aprovada — `aprovacao.service.ts` não tem função que devolva status a `pendente`, e `listarPendencias` filtra `status = 'pendente'`, então a baixa aprovada nem aparece ao gestor (FR-031)
- [ ] T071b [US6] Expor a reversão em `modules/stockbridge/src/routes/aprovacao.routes.ts` (`POST /aprovacoes/:id/reverter`, gestor+) e listar as baixas externas aprovadas em `apps/web/src/pages/stockbridge/gestor/AprovacoesPage.tsx`, sem o que não há como acionar a reversão
- [ ] T072 [P] [US6] Cobrir em `modules/stockbridge/src/__tests__/recebimento-externo.test.ts` a reversão pelo gestor de uma baixa já aprovada, devolvendo o item à fila, com registro em `shared.audit_log`

**Checkpoint**: os ~10% de recebimentos manuais não reconhecíveis, e todo recebimento feito direto no OMIE, têm saída auditável.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T057 [P] Rodar `pnpm lint && pnpm typecheck` e corrigir violações, incluindo `eslint-plugin-boundaries` (gate bloqueante — Princípio I)
- [ ] T058 [P] Rodar a suíte completa `pnpm --filter @atlas/stockbridge test` e confirmar que nenhum teste existente do fluxo de importação quebrou
- [ ] T059 Executar o roteiro de `specs/015-recebimento-nacional-nf/quickstart.md`, cenários 1 a 8, contra o ambiente de desenvolvimento
- [ ] T060 [P] Revisar as mensagens de usuário de `apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx` e `modules/stockbridge/src/routes/recebimento-nacional.routes.ts` com o agente `frontend-design-reviewer`, conferindo tom institucional em pt-BR e ausência de código OMIE
- [ ] T061 [P] Atualizar a seção StockBridge de `CLAUDE.md` com um parágrafo sobre o recebimento nacional por NF: identidade por chave de acesso, divergência aceita nos dois sentidos, classificação 1:N e a janela temporal da fila
- [ ] T062 Conferir a fila contra PROD usando a query final de `quickstart.md` (corte de 7 dias) — espera-se ordem de **unidades** de NFs, não dezenas; na medição de 17/09/2026 foram 9 elegíveis, das quais 2 realmente pendentes
- [ ] T063 Registrar no Jira (ACXEGDP-328), com base em `specs/015-recebimento-nacional-nf/research.md` D13, o passivo das NFs 66529/66530/66604 como item separado, com os ~40,7 t de excesso já aplicados no OMIE — a feature impede repetição, não corrige o histórico

---

## Dependencies

```text
Phase 1 (Setup)
   └─> Phase 2 (Foundational) ── BLOQUEIA TUDO
          └─> Phase 3 (US1, P1) ── MVP
                 ├─> Phase 4 (US2, P2)  [precisa do caminho de entrada de US1]
                 ├─> Phase 8 (US6, P2)  [precisa da fila de US1]
                 ├─> Phase 5 (US3, P3)  [precisa do detalhe da NF de US1]
                 ├─> Phase 7 (US5, P5)  [precisa do detalhe da NF de US1]
                 │
                 └─> Phase 6 (US4, P4)  [precisa de US2 e US3, não só de US1]
                        └─> Phase 9 (Polish)
```

**Dependências entre histórias**:

- **US1** é independente — só depende da Fase 2.
- **US2**, **US3**, **US5** e **US6** dependem de US1 (compartilham a fila e o caminho de entrada), mas são **independentes entre si** e podem ser feitas em qualquer ordem ou em paralelo.
- **US4** é a única com dependência dupla: precisa do peso conferido (US2) para distribuir, e da correlação (US3) para memorizar o conjunto. No grafo acima ela aparece sob US1 como as demais, mas **não pode começar** antes de US2 e US3 — uma versão anterior deste documento a mostrava pendurada direto na Fase 2, o que contradizia a própria anotação.

**Dentro da Fase 2**: T004→T005→T006→T007 é sequencial (mesma migration). T008/T009 e T010→T011→T012 são duas trilhas paralelas entre si e à migration.

---

## Parallel Execution Examples

**Fase 2** — três trilhas simultâneas:

```text
Trilha A: T004 → T005 → T006 → T007   (migration e schema)
Trilha B: T008 → T009                 (unidade-nf + teste)
Trilha C: T010 → T011 → T012          (fiscal-recebida-sql + regressão)
```

**Fase 3 (US1)** — backend e frontend em paralelo após T019/T020:

```text
Backend:  T013 → T014 → T015 → T016 → T017 → T018 → T019 → T020 → T021
Frontend: T022 → T023 → T024 → T025        (depende do contrato, não da implementação)
Testes:   T026 [P], T027 [P]               (arquivos distintos)
```

**Após US1 concluída** — três histórias em paralelo, se houver mais de uma pessoa:

```text
Pessoa 1: Phase 4 (US2) — T029..T036
Pessoa 2: Phase 5 (US3) — T037..T044
Pessoa 3: Phase 7 (US5) — T052..T056
```

**Fase 9** — T057, T058, T060, T061 são todas `[P]`.

---

## Implementation Strategy

### MVP — Fases 1 + 2 + 3 (US1)

Entrega o núcleo: o operador recebe NF nacional sem redigitar valor nem unidade, com idempotência garantida pela migration, o seed das exclusões aplicado e a checagem de "já recebida" em duas vias — sem a qual a fila mostraria como pendentes NFs que o formulário manual já recebeu.

Nesse recorte a quantidade fica travada na da NF. É aceitável como primeira fatia porque quem precisar registrar peso divergente usa o caminho manual, como hoje — mas é exatamente por isso que a Fase 4 vem logo em seguida.

### Incremento 2 — honestidade do peso (Fase 4, US2)

Passa a registrar os ~32% de recebimentos que divergem e que hoje não deixam rastro nenhum. Sem ele, o MVP troca um erro visível (digitação) por um invisível (peso da NF aceito como verdade). Inclui a correção da tela de aprovação, sem a qual o gestor aprovaria a divergência sem conseguir vê-la.

### Incremento 3 — a válvula (Fase 8, US6)

Também P2, e independente da Fase 4. Dá saída aos ~10% de recebimentos manuais que a checagem automática não reconhece, e ao recebimento feito direto no OMIE — que continuará existindo. Quanto mais tarde entrar, mais NFs ficam presas na fila sem solução.

### Incremento 4 — velocidade (Fase 5, US3)

Com 76,6% dos itens repetindo um par já visto, é o que transforma o fluxo de "funciona" em "rápido".

### Incremento 5 — cobertura de fornecedor (Fase 6, US4)

Traz ISOFORMA e os demais fornecedores de sucata para dentro da fila. Depende de US2 e US3.

### Incremento 6 — rede de segurança (Fase 7, US5)

Afeta 0,4% dos itens, mas evita o erro mais caro da lista (conversão silenciosa de 1000×).

### Ordem recomendada

1 → 2 → 3 (MVP, validar com operador) → 4 e 8 em paralelo → 5 → 6 → 7 → 9.

Cada fase de história é um checkpoint entregável: dá para parar em qualquer uma com o sistema funcionando e o caminho manual intacto.
