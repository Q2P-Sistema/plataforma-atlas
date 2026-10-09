---
description: "Task list — Recebimento Fiscal da NF Nacional pelo Atlas"
---

# Tasks: Recebimento Fiscal da NF Nacional pelo Atlas

**Input**: Design documents from `/specs/016-recebimento-fiscal-nf/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md
**Jira**: ACXEGDP-395 (relacionadas: ACXEGDP-394, ACXEGDP-328)

**Tests**: incluídos. O plano exige Vitest para o cliente OMIE novo, o service do fiscal (ordem dos passos, lock, falha sem escrita), a fila unificada (SQL gerado, precedência, dispensa), a dispensa e a **regressão da 015 com a flag desligada**; e teste de integração das duas triggers de auditoria (Princípio IV). O fluxo escreve em documento fiscal do OMIE — não entra sem rede.

**Organization**: agrupadas por história de usuário. A dispensa de NF (clarificação de 02/10/2026, FR-021..025) não é história numerada na spec; aqui é a **US4**.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos distintos, sem dependência pendente)
- **[Story]**: US1 (fiscal pendente num clique), US2 (fiscal já feito continua), US3 (falhas/repetições/rejeição), US4 (dispensa pelo gestor)

## Path Conventions

Monorepo modular: `modules/stockbridge/src/` (backend), `apps/web/src/` (frontend), `packages/db/` (schema e migrations), `packages/integrations/omie/` (cliente OMIE), `packages/core/` (config). O workflow n8n vive fora do repo (`backup-workflow-n8n`), guiado por `contracts/espelho-recebimentos-n8n.md`.

---

## Phase 1: Setup

**Purpose**: verificação do terreno; o projeto já existe.

- [X] T001 Confirmar que a branch `016-recebimento-fiscal-nf` está em cima de `origin/uat` (`git log --oneline -1 origin/uat` deve ser ancestral de HEAD) e que `pnpm install` roda limpo
- [X] T002 Confirmar a numeração da migration com `ls packages/db/migrations/ | tail -3` — a próxima livre deve ser `0053` (última: `0052_stockbridge_recebimento_nacional_nf.sql`)
- [X] T003 [P] Enviar ao agente dos workflows n8n o contrato `specs/016-recebimento-fiscal-nf/contracts/espelho-recebimentos-n8n.md` (DDL + duas passagens + cron `0 23,53 * * * *` + trava `receb_q2p_incremental`) e registrar no card ACXEGDP-395 o id do workflow criado — a US1 em UAT depende do espelho estar populado
- [X] T004 [P] Adicionar `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=false` e `STOCKBRIDGE_FISCAL_EMAILS=` (comentário com o default) com comentário em `.env.example` (ou o arquivo de exemplo de env vigente na raiz) e `=true` no `.env` local de dev

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: nenhuma história começa antes desta fase.

**Purpose**: migration, schema, flag e cliente OMIE — tudo que as quatro histórias consomem.

- [X] T005 Criar `packages/db/migrations/0053_stockbridge_recebimento_fiscal_nf.sql` com cabeçalho Antes/Agora/Porque (skill `stockbridge-migration`) e as seções: (1) `CREATE TABLE IF NOT EXISTS public."tbl_recebimentoNFe_Q2P"` e `public."tbl_recebimentoNFe_itens_Q2P"` **exatamente** com a DDL de `contracts/espelho-recebimentos-n8n.md` §1 (índices únicos/parciais inclusos, `COMMENT ON TABLE` dizendo que o escritor é o n8n); (2) `stockbridge.recebimento_fiscal` conforme `data-model.md` §3, com `CHECK (status IN ('em_andamento','concluido','ja_concluido','falha'))` e índice único parcial `(nf_chave_acesso) WHERE status IN ('em_andamento','concluido','ja_concluido')`; (3) `stockbridge.nf_dispensa` conforme `data-model.md` §4 (inclui `situacao_fiscal_na_dispensa` com `CHECK IN ('pendente','concluido')`), com índice único parcial `(nf_chave_acesso) WHERE revertido_em IS NULL` e índice `(revertido_em, dispensado_em)`
- [X] T006 Na mesma migration `0053`, adicionar `stockbridge.audit_recebimento_fiscal()` + `trg_audit_sb_recebimento_fiscal` e `stockbridge.audit_nf_dispensa()` + `trg_audit_sb_nf_dispensa` (AFTER INSERT OR UPDATE OR DELETE, padrão de `0008_stockbridge_core.sql`)
- [X] T007 Estender `packages/db/src/schemas/stockbridge.ts` com `recebimentoFiscal` (status tipado via `$type<'em_andamento'|'concluido'|'ja_concluido'|'falha'>()`) e `nfDispensa`, FKs para `users`; as tabelas-espelho **não** entram no Drizzle (lidas por raw SQL)
- [X] T008 Aplicar a migration (o repo não usa o runner do drizzle-kit: `psql -1 -f` do arquivo — no UAT vivo, só a 0053, comando no quickstart) e conferir: 4 tabelas criadas, 2 triggers em `pg_trigger`, índices parciais em `pg_indexes`; `CREATE TABLE IF NOT EXISTS` reaplicável sem erro
  - Feito (07/10/2026): 0053 aplicada no UAT em 04/10 (DBeaver, por ser UAT vivo) e em PROD na janela do go-live (GMUD ACXEGDP-321). As 4 tabelas existem nos dois ambientes (espelho conferido coluna a coluna no comentário 15226 do card) e os 2 triggers estão gravando em PROD: `shared.audit_log` tem 4 INSERT + 4 UPDATE de `recebimento_fiscal` e 3 INSERT de `nf_dispensa`.
- [X] T009 [P] Adicionar `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` em `packages/core/src/config.ts` (enum `'true'|'false'|'1'|'0'|''`, **default `'false'`**, transform para boolean), com comentário explicando por que o default é desligado (research D12) e o que a flag gate (fonte "fiscal pendente", escrita OMIE, rotas de dispensa); e `STOCKBRIDGE_FISCAL_EMAILS` (string, default `'nfe@acxe-polimeros.com.br,mauricio@acxe-polimeros.com.br,gustavo.dreer@acxe-polimeros.com.br'`, transform: split por vírgula, trim, descartar vazios, validar cada um com `z.string().email()`) — destinatários do e-mail de dispensa (FR-026)
- [X] T010 [P] Criar `packages/integrations/omie/src/stockbridge/recebimento-nfe.ts` com: tipos `RecebimentoNfeConsultado` (cabec: `nIdReceb`, `cChaveNFe`, `cNumeroNFe`, `cEtapa`, `cRazaoSocial`, `cCNPJ_CPF`, `nValorNFe`; infoCadastro: `cRecebido`, `cCancelada`, `cUsuarioRec`, `dRec`, `hRec`; itens: `nSequencia`, `cDescricaoProduto`, `cIgnorarItem`, `cAssociarExistente`, `nIdProduto`, `cNaoGerarMovEstoque`, `cNaoGerarFinanceiro`), `consultarRecebimentoNfe(cnpj, { nIdReceb } | { cChaveNfe })` (`callOmie` com `retries: 2`), `alterarRecebimentoNfeItens(cnpj, { nIdReceb, itens: Array<{ nSequencia, cAcao: 'EDITAR'|'IGNORAR', itensAjustes? }> })` (sem retry; lançar `Error` local se algum item `IGNORAR` vier com `itensAjustes` — erro 151 do OMIE, research D1) e `concluirRecebimentoNfe(cnpj, { nIdReceb, cEtapa: '60' })` (sem retry). Cabeçalho do arquivo documenta a exceção ao Princípio II (`produtos/recebimentonfe/`)
- [X] T011 Estender `packages/integrations/omie/src/stockbridge/mock.ts`: mapa em memória de recebimentos por `nIdReceb`/`cChaveNFe` com `cEtapa`, `cRecebido`, itens; `mockConsultarRecebimentoNfe`, `mockAlterarRecebimentoNfeItens` (aplica `cIgnorarItem`/`cNaoGerarMovEstoque`; fault 151 se IGNORAR+ajustes; fault se recebimento `cRecebido='S'`), `mockConcluirRecebimentoNfe` (40→60, `cRecebido='S'`, `cUsuarioRec='WEBSERVICE'`; fault se já concluído); `__injectMockRecebimentoNfe`; incluir o mapa no `__resetMockState`
- [X] T012 Exportar as três funções, tipos e `__injectMockRecebimentoNfe` em `packages/integrations/omie/src/index.ts`
- [X] T013 [P] Criar `packages/integrations/omie/src/__tests__/recebimento-nfe.test.ts` (modo mock): consulta por `nIdReceb` e por `cChaveNfe`; EDITAR aplica ajustes; IGNORAR+ajustes lança antes de chamar; sequência EDITAR→IGNORAR→Concluir leva a `cEtapa 60`/`cRecebido S`; Concluir em já concluído lança; `__resetMockState` limpa
- [X] T014 [P] Estender `specs/007-stockbridge-module/research.md` seção 2 (exceções ao Princípio II) com `produtos/recebimentonfe/` — `ConsultarRecebimento` (leitura imediatamente antes da escrita) e `AlterarRecebimento`/`ConcluirRecebimento` (escrita) — citando ACXEGDP-395 e a flag

**Checkpoint**: migration aplicada, cliente OMIE testado em mock, flag disponível. Histórias podem começar.

---

## Phase 3: User Story 1 — NF com fiscal pendente recebida num único clique (Priority: P1) 🎯 MVP

**Goal**: NF na etapa 40 aparece na fila como "fiscal pendente" sem ninguém tocar no OMIE; ao confirmar, o Atlas conclui o fiscal (EDITAR→IGNORAR→Concluir) e grava o recebimento físico.

**Independent Test**: com uma NF elegível em `tbl_recebimentoNFe_Q2P` (`c_recebido='N'`) e a flag ligada, a fila a lista com `fiscal: 'pendente'`, o detalhe traz os itens, e o POST devolve `fiscal.status: 'concluido'` + produtos `aguardando_aprovacao`; no OMIE (mock ou real) a NF fica `cEtapa 60`, itens ignorados, sem movimento de estoque (quickstart cenário 1).

### Fila e detalhe com duas fontes

- [X] T015 [US1] Em `modules/stockbridge/src/services/fila-nacional.service.ts`, adicionar `recebimentoFiscalHabilitado()` (lê a flag) e os tipos `SituacaoFiscal = 'pendente'|'concluido'`; estender `FilaNacionalItem` com `fiscal`, `fiscalConcluidoPeloAtlasEm: string|null`, `fornecedorCnpj: string|null`; estender `DetalheNfNacional` com `fiscal`, `nIdReceb: number|null`, `dispensavel: boolean` (data-model §6)
- [X] T016 [US1] No mesmo arquivo, criar os fragmentos SQL das CTEs `nf_unificada` e `itens_unificados`: fonte (a) = query atual sobre `tbl_nf_header_Q2P ⋈ tbl_nf_itens_Q2P` com `fiscal_pendente = false`; fonte (b) = `tbl_recebimentoNFe_Q2P r ⋈ tbl_recebimentoNFe_itens_Q2P ri` com `r.c_recebido = 'N' AND r.c_cancelada = 'N'`, mapeando `c_numero_nfe→n_nf`, `c_razao_social→dest_razao`, `c_cnpj_cpf→dest_cnpj_cpf`, `d_emissao→d_emi`, `n_sequencia→n_cod_item`, `c_descricao_produto→x_prod`, `c_cfop_entrada→cfop`, `n_qtde_nfe→q_com`, `c_unidade_nfe→u_com`, `v_total_item→valor_item`, `fiscal_pendente = NOT EXISTS (ledger concluido/ja_concluido)`; (b) só entra quando a flag está ligada **e** a chave não existe na fonte (a) (research D8). Aplicar nas duas fontes: CFOP do recorte, corte de data, fornecedor não excluído, **não dispensada** (`NOT EXISTS stockbridge.nf_dispensa … revertido_em IS NULL`)
- [X] T017 [US1] Reescrever `getFilaNacional` sobre as CTEs: `fiscal` = `CASE WHEN bool_and(fiscal_pendente) THEN 'pendente' ELSE 'concluido'`, `fiscalConcluidoPeloAtlasEm` = `finalizado_em` do ledger `concluido` (ou null); `fornecedorNome` = `COALESCE(dest_razao, 'Fornecedor não identificado no OMIE')`; manter ordenação e o `HAVING` de pendência por item; manter o degrade para lista vazia só em falha de banco
- [X] T018 [US1] Reescrever `getDetalheNfNacional` sobre as CTEs: resolver a NF pela chave em qualquer das fontes; `fiscal`, `nIdReceb` (da fonte b ou de `tbl_nf_header_Q2P.n_id_receb`), `dispensavel = flag && !dispensaAtiva && itens.some(pendente)` (qualquer situação fiscal — decisão de 02/10/2026); NF só existente com dispensa ativa → `NfNacionalNaoEncontradaError` com a mensagem do contrato §2 ("foi dispensada da fila pelo gestor em <data>…"); `linhasForaDoRecorte` conta por `c_cfop_entrada`; itens, conversão de unidade, sugestão de correlação e flags "já recebido" inalterados
- [X] T019 [P] [US1] Criar `modules/stockbridge/src/__tests__/fila-nacional-unificada.test.ts` (inspeção do SQL gerado, padrão `fila-pendente.test.ts`, com `getPool` mockado): com flag ligada o SQL contém `tbl_recebimentoNFe_Q2P` e a cláusula de precedência (chave NOT IN fonte a); com flag desligada **não** contém; a cláusula de dispensa está nas duas fontes; `fiscal_pendente` consulta o ledger; mapeamento de colunas da fonte (b) presente (`v_total_item`, `c_cfop_entrada`, `c_descricao_produto`)

### Service do fiscal

- [X] T020 [US1] Criar `modules/stockbridge/src/services/recebimento-fiscal.service.ts` com `concluirRecebimentoFiscal(input: { nfChaveAcesso, nIdReceb: number|null, notaFiscal, fornecedorNome, itensSequencias: number[], userId })` → `{ status: 'concluido'|'ja_concluido', concluidoEm, ledgerId }`: (1) `INSERT` no ledger com `status='em_andamento'` (lock — research D6; violação do índice único → ver US3); (2) `consultarRecebimentoNfe('q2p', { cChaveNfe })` — se `cRecebido==='S'` → ledger `ja_concluido`, retorna; gravar `etapa_antes`/`recebido_antes`; resolver `nIdReceb` da resposta se nulo; (3) `alterarRecebimentoNfeItens` com `cAcao:'EDITAR'` + `itensAjustes {cNaoGerarMovEstoque:'S', cNaoGerarFinanceiro:'N'}` para todos os itens (`nSequencia` da resposta da consulta, não do espelho); (4) `alterarRecebimentoNfeItens` com `cAcao:'IGNORAR'` sem ajustes; (5) `concluirRecebimentoNfe` `cEtapa:'60'`; (6) ledger `concluido` + `finalizado_em` + `itens_total`. Erros: `RecebimentoFiscalError` (mensagem do contrato §3 com NF + fornecedor, sem código OMIE; guarda `passo` e o `OmieApiError` em `cause`), `RecebimentoFiscalEmAndamentoError`, `RecebimentoFiscalSemFornecedorError`
- [X] T021 [US1] Em `modules/stockbridge/src/services/recebimento-nacional.service.ts`, estender `ProcessarRecebimentoPorNfResult` com `fiscal: { status: 'concluido'|'ja_concluido'|'nao_aplicavel'|'desligado', concluidoEm: string|null, mensagem: string }` (data-model §7) e inserir o passo fiscal **entre o portão 1 e o portão 2** (research D10): se `detalhe.fiscal === 'pendente'` e `preparados.length > 0` e flag ligada → `concluirRecebimentoFiscal(...)`; `RecebimentoFiscalError` propaga **antes** de qualquer `INSERT`; `ja_concluido`/`concluido` seguem; `nao_aplicavel` quando o fiscal já estava feito ou nada será gravado; `desligado` quando a flag está `false`. `montarResultado` recebe o bloco fiscal
- [X] T022 [P] [US1] Criar `modules/stockbridge/src/__tests__/recebimento-fiscal.test.ts` (OMIE em mock, `getDb` mockado): caminho feliz grava ledger `em_andamento` **antes** da primeira chamada OMIE e `concluido` depois, com `itens_total` = nº de itens da consulta; ordem das chamadas é Consultar → EDITAR → IGNORAR → Concluir; EDITAR envia `cNaoGerarMovEstoque 'S'` e `cNaoGerarFinanceiro 'N'`; IGNORAR vai sem `itensAjustes`; mensagens de erro contêm NF e fornecedor e **não** contêm `nIdReceb` nem faultcode
- [X] T023 [P] [US1] Criar `modules/stockbridge/src/__tests__/recebimento-nacional-fiscal.test.ts`: `processarRecebimentoNacionalPorNf` chama o fiscal só quando `fiscal==='pendente'`, há preparados e flag ligada; resultado traz `fiscal.status`; com todos os itens bloqueados por unidade → `nao_aplicavel` e nenhuma chamada OMIE; `RecebimentoFiscalError` antes de qualquer `insert`

### Rotas e UI

- [X] T024 [US1] Em `modules/stockbridge/src/routes/recebimento-nacional.routes.ts`: `GET …/fila/:chaveAcesso` devolve também `recebimentoFiscalHabilitado`; `POST …/por-nf` mapeia `RecebimentoFiscalError` → `502 RECEBIMENTO_FISCAL_FAIL`, `RecebimentoFiscalEmAndamentoError` → `409 RECEBIMENTO_FISCAL_EM_ANDAMENTO`, `RecebimentoFiscalSemFornecedorError` → `422 RECEBIMENTO_FISCAL_SEM_FORNECEDOR` (contrato §3), sempre com `userMessage` (os gatilhos de 409/422 só são implementados na US3 — T033/T034; aqui as classes já existem desde T020)
- [X] T025 [US1] Em `apps/web/src/pages/stockbridge/operador/RecebimentoNacionalNfPanel.tsx`: tipos `FilaNacionalItem`/`DetalheNf`/`ResultadoPorNf` ganham `fiscal`, `fiscalConcluidoPeloAtlasEm`, `nIdReceb`, `recebimentoFiscalHabilitado`, `dispensavel`, `fiscal: {status, mensagem}`; selo na linha da fila ("Fiscal pendente" âmbar / "Fiscal já feito" cinza — só mostrar o selo quando `recebimentoFiscalHabilitado`); banner no detalhe quando pendente ("O recebimento fiscal será concluído no OMIE ao confirmar — a conta a pagar é gerada e nenhum estoque é movimentado por ele"); fornecedor nulo exibe "Fornecedor não identificado no OMIE"; linha de desfecho fiscal no resultado (`concluido`/`ja_concluido`/`nao_aplicavel`); erros 502/409/422 do fiscal exibidos com o `userMessage`
- [X] T026 [US1] Validar o espelho n8n contra `contracts/espelho-recebimentos-n8n.md` §5 em UAT antes de qualquer cenário real: `SELECT c_etapa, c_recebido, c_cancelada, count(*) … GROUP BY 1,2,3`; nenhuma `c_chave_nfe` nula ou duplicada; `v_total_item` de uma NF com IPI igual ao `v_prod` do espelho de NF; após o Atlas concluir um fiscal, a rodada seguinte vira `c_recebido='S'`/`c_usuario_rec='WEBSERVICE'` — anexar ao card ACXEGDP-395
- [X] T027 [US1] Validar o cenário 1 do quickstart em dev com `OMIE_MODE=mock` (`__injectMockRecebimentoNfe` via um seed de teste ou linha manual no espelho) e registrar no card ACXEGDP-395
  - Superado (07/10/2026): o cenário 1 rodou 4× com OMIE real e ficou registrado no card — 414436 (04/10, 1 item, 5,6 s), 414435 (06/10, **2 itens**, 7,4 s), 414437 e 36624 (06/10), todas com ledger `concluido`, etapa 40→60 e nenhuma falha. A validação com fixture sintética não acrescenta cobertura sobre isso.

**Checkpoint**: fiscal pendente → um clique → fiscal concluído + físico gravado (MVP).

---

## Phase 4: User Story 2 — NFs com fiscal já feito continuam na fila (Priority: P1)

**Goal**: nada se perde na transição; NF concluída no OMIE (antes ou por engano depois) aparece como "fiscal já feito" e é recebida só no estoque; com a flag desligada, comportamento idêntico à 015.

**Independent Test**: snapshot da fila antes de ligar a flag = conjunto das NFs `fiscal: 'concluido'` depois de ligar (SC-006); POST em NF "já feito" devolve `fiscal.status: 'nao_aplicavel'` e nenhuma chamada OMIE (quickstart cenário 5 e História 2).

- [X] T028 [US2] Garantir em `fila-nacional.service.ts` que a fonte (a) nunca é filtrada pela flag e que uma chave presente nas duas fontes sai **uma vez** com `fiscal: 'concluido'` (precedência — FR-005/FR-006); NF recebida pelo Atlas e depois concluída no espelho continua fora pela checagem "já recebida" existente
- [X] T029 [P] [US2] Criar `modules/stockbridge/src/__tests__/recebimento-nacional-flag-off.test.ts` (regressão): com `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=false`, o SQL da fila é **idêntico** ao da 015 exceto pelas colunas novas constantes (`fiscal='concluido'`), o POST devolve `fiscal.status='desligado'`, nenhuma função de `recebimento-nfe.ts` é chamada e o shape do resultado da 015 permanece inteiro
- [X] T030 [P] [US2] Estender `fila-nacional-unificada.test.ts`: chave nas duas fontes → uma linha, `fiscal='concluido'`; chave só na fonte (b) com ledger `concluido` → `fiscal='concluido'` e `fiscalConcluidoPeloAtlasEm` preenchido; chave só na fonte (b) sem ledger → `pendente`
- [X] T031 [US2] Em `RecebimentoNacionalNfPanel.tsx`, texto explicativo da fila atualizado: "A lista traz as notas de compra que chegaram ao OMIE. As marcadas como **fiscal pendente** terão o recebimento fiscal concluído ao confirmar; as demais já tiveram o fiscal feito e recebem só o estoque." (só quando a flag está ligada; com a flag desligada, texto atual)
- [X] T032 [US2] Validar em UAT, antes de ligar a flag, o snapshot da fila (`GET …/fila` → salvar JSON) e, depois de ligar, conferir que todas as chaves do snapshot aparecem com `fiscal: 'concluido'` (SC-006); anexar ao card
  - Feito (04/10/2026, comentário 15255): ao ligar a flag a fila tinha 14 NFs — as 10 anteriores todas como "Fiscal já feito", com a mesma assinatura de conteúdo antes e depois, mais 3 VALGROUP pendentes e a 1257 sem fornecedor. Nenhuma chave do snapshot se perdeu.

**Checkpoint**: transição sem perda; flag desligada = 015.

---

## Phase 5: User Story 3 — Falhas, repetições e rejeições não deixam estado inconsistente (Priority: P2)

**Goal**: toda falha termina num estado conhecido que a fila mostra corretamente; nada em dobro.

**Independent Test**: cenários 2 (a–d) e 3 do quickstart — duplo clique → um `201` e um `409`; fiscal falhando → `502`, zero `INSERT`, ledger `falha`; fiscal ok + físico falhou → NF volta como "fiscal já feito"; concluído no OMIE no meio → `ja_concluido`; rejeição do gestor → NF volta como "fiscal já feito".

- [X] T033 [US3] Em `recebimento-fiscal.service.ts`, tratar a violação do índice único do ledger no `INSERT`: linha `em_andamento` com `iniciado_em` há **menos** de 5 min → `RecebimentoFiscalEmAndamentoError`; há **mais** de 5 min (órfã) → `UPDATE` retomando (`confirmado_por`, `iniciado_em = now()`) e seguir; linha `concluido`/`ja_concluido` → retornar `ja_concluido` sem chamar o OMIE
- [X] T034 [US3] Em `recebimento-fiscal.service.ts`, tratar fault/timeout em EDITAR, IGNORAR ou Concluir (research D2/D3): reconsultar com **corpo alternativo** (`nIdReceb` se a primeira foi por `cChaveNfe`) — se `cRecebido==='S'` → ledger `ja_concluido` e retorno; senão ledger `falha` com `passo_falha`, `erro_omie_codigo`, `erro_omie_mensagem`, `finalizado_em` e lançar `RecebimentoFiscalError`; fault cujo `faultstring` indique fornecedor não cadastrado (regex a calibrar; research pendência 3) → `RecebimentoFiscalSemFornecedorError`
- [X] T035 [US3] Em `recebimento-fiscal.service.ts`, criar `listarLedgerFiscal({ status?, limit })` → itens do contrato §7 (`notaFiscal`, `fornecedorNome`, `status`, `passoFalha`, `confirmadoPor {id,nome}` via `atlas.users`, `iniciadoEm`, `finalizadoEm`) — **sem** `erro_omie_*`
- [X] T036 [US3] Em `recebimento-nacional.routes.ts`, adicionar `GET /api/v1/stockbridge/recebimento/nacional/fiscal` (`requireGestor`, query Zod `status?`, `limit? 1..200`)
- [X] T037 [P] [US3] Estender `recebimento-fiscal.test.ts`: duplo clique concorrente → segunda chamada lança `EmAndamento` sem chamar OMIE; linha órfã (> 5 min) é retomada; fault em EDITAR + reconsulta `cRecebido 'S'` → `ja_concluido` e **zero** escrita; fault em Concluir + reconsulta `'N'` → ledger `falha` com `passo_falha='concluir'` e `erro_omie_*`; reconsulta usa corpo diferente da primeira consulta; nova tentativa após `falha` cria linha nova `em_andamento`
- [X] T038 [P] [US3] Estender `recebimento-nacional-fiscal.test.ts`: fiscal lança → nenhum `insert` em `movimentacao`/`aprovacao`; fiscal `concluido` + falha no `insert` de todos os produtos → resultado com `fiscal.status='concluido'` e produtos `falha`, e o ledger permanece `concluido` (a fila passa a mostrar "fiscal já feito" pelo ledger)
- [X] T039 [US3] Confirmar em `aprovacao.service.ts` (`rejeitar`) que a rejeição de `entrada_manual` com `movimentacaoId` desativa a movimentação (`ativo=false`, já existente) e **não** toca no ledger fiscal nem no OMIE — adicionar comentário referenciando FR-016/ACXEGDP-395; se faltar cobertura, adicionar caso em `modules/stockbridge/src/__tests__/` (rejeição de entrada nacional → movimentação inativa → `itemNacionalRecebidoSql` deixa de casar)
- [X] T040 [US3] Em `RecebimentoNacionalNfPanel.tsx`, tratar `409 RECEBIMENTO_FISCAL_EM_ANDAMENTO` com botão "Recarregar nota" (refetch do detalhe) e `502 RECEBIMENTO_FISCAL_FAIL` com "Tentar novamente"; no resultado com `fiscal.status='concluido'` e produtos `falha`, mostrar aviso "O fiscal foi concluído no OMIE; o estoque não foi registrado — a nota continua na fila como fiscal já feito"
- [X] T041 [US3] Validar em UAT (`OMIE_MODE=real`) os cenários 2b (secret inválido → `502`, zero `INSERT`, ledger `falha`) e 2d (concluir pela tela do OMIE com a nota aberta no Atlas → `ja_concluido`) e registrar o `faultstring` real observado no card ACXEGDP-395 (research pendência 1)
  - Feito (09/10/2026, comentário 15312): cenário 2b reproduzido pelo caminho real — `ConsultarRecebimento` é leitura (`METODOS_LEITURA`) e vai ao OMIE de verdade mesmo em `OMIE_MODE=leitura`; linha sintética no espelho do UAT com `n_id_receb` inexistente (NF 999999999, fornecedor fictício) → clique no Atlas → ledger `em_andamento` → timeout real do OMIE (91 s) → ledger `falha`/`passo_falha='consultar'`/`erro_omie_mensagem` preenchido; tela mostrou a mensagem e o botão "Tentar novamente" documentados; zero `movimentacao`/`aprovacao`. Achado no caminho: a flag estava desligada no UAT desde o religamento pós-405 (07/10) — corrigida antes do teste. Primeira linha `falha` do ledger em qualquer ambiente. 2d (concluir pela tela do OMIE com a nota aberta no Atlas) não reproduzido — depende de ação manual simultânea, não é um gate de encerramento da feature.

**Checkpoint**: falhas e repetições com estado conhecido e sem duplicidade.

---

## Phase 6: User Story 4 — Dispensa de NF pelo gestor (Clarificação 02/10/2026, FR-021..025)

**Goal**: NF com fiscal pendente que nunca será recebida sai da fila por decisão auditável do gestor, sem ação no OMIE, e pode voltar.

**Independent Test**: quickstart cenário 4 — gestor dispensa com motivo → NF some para todos; aparece em "NFs dispensadas"; desfazer → volta; operador não vê o botão e recebe `403` na rota; NF "fiscal já feito" → `422 NF_NAO_DISPENSAVEL`.

- [X] T042 [US4] Criar `modules/stockbridge/src/services/nf-dispensa.service.ts`: `dispensarNf({ nfChaveAcesso, motivo, userId, perfilUsuario })` (gestor/diretor; motivo obrigatório; `getDetalheNfNacional` para resolver NF/fornecedor e exigir ao menos um item pendente → senão `NfNaoDispensavelError` ("já foi recebida no Atlas"); gravar `situacao_fiscal_na_dispensa` = `detalhe.fiscal`; `INSERT` em `nf_dispensa`; violação do índice único → `NfJaDispensadaError`), `listarDispensas({ incluirRevertidas })` com nomes via `atlas.users`, `reverterDispensa({ id, motivo, userId, perfilUsuario })` (`UPDATE revertido_*`; inexistente/já revertida → `DispensaNaoEncontradaError`); `MotivoObrigatorioError` reaproveitado de `recebimento-externo.service.ts`; tudo recusado com `RecebimentoFiscalDesabilitadoError` quando a flag está `false`
- [X] T043 [US4] Em `recebimento-nacional.routes.ts`, adicionar `POST …/nacional/dispensar` (`requireGestor`, body `.strict()` `{ nf_chave_acesso, motivo }` → `201`), `GET …/nacional/dispensas` (`requireGestor`, `incluirRevertidas?`), `POST …/nacional/dispensas/:id/reverter` (`requireGestor`, `{ motivo }` → `200`), com os códigos do contrato §4–6 (`403 RECEBIMENTO_FISCAL_DESABILITADO` com a flag desligada, antes de validar o corpo)
- [X] T044 [US4] Em `modules/stockbridge/src/services/notificacao.service.ts`, criar `enviarAlertaNfDispensada({ notaFiscal, fornecedorNome, situacaoFiscalNaDispensa, valorNfBrl, motivo, dispensadoPorNome })` para os destinatários de `STOCKBRIDGE_FISCAL_EMAILS` (helper `getFiscalEmails(): string[]` ao lado de `getComexEmail()`; 1 e-mail por destinatário, como `enviarAlertaRecebimentoNacionalLote`, para não vazar a lista no To), assunto "StockBridge — NF <n> (<fornecedor>) dispensada da fila", corpo com motivo, quem/quando e a pendência no OMIE: `pendente` → "recebimento na etapa 40 aguardando manifestação ou cancelamento"; `concluido` → "conta a pagar de R$ N a estornar ou manter"; sem código OMIE; chamada best-effort (`void …catch(log)`) a partir de `dispensarNf` (FR-026)
- [X] T045 [P] [US4] Criar `modules/stockbridge/src/__tests__/notificacao-nf-dispensada.test.ts` (padrão `notificacao-recebimento-nacional-nf.test.ts`): assunto com NF e fornecedor; corpo com o texto da pendência correto para cada situação fiscal; 1 e-mail por destinatário configurado; lista vazia → nenhum envio e `warn`; falha do `sendEmail` não propaga
- [X] T046 [P] [US4] Criar `modules/stockbridge/src/__tests__/nf-dispensa.test.ts`: motivo vazio → erro; NF sem item pendente → `NfNaoDispensavel`; NF `fiscal='concluido'` com item pendente → dispensa aceita com `situacao_fiscal_na_dispensa='concluido'`; NF `fiscal='pendente'` → aceita com `'pendente'`; segunda dispensa da mesma chave → `NfJaDispensada`; reverter inexistente → `DispensaNaoEncontrada`; operador → recusado; flag desligada → `Desabilitado`
- [X] T047 [P] [US4] Criar `modules/stockbridge/src/__tests__/rotas-dispensa.test.ts` (Supertest, padrão das rotas da 015): operador → `403` nas três rotas; gestor → `201`/`200`/`200`; corpo com campo extra → `400` (`.strict()`); flag desligada → `403 RECEBIMENTO_FISCAL_DESABILITADO`
- [X] T048 [US4] Em `RecebimentoNacionalNfPanel.tsx`: botão "Dispensar da fila" no detalhe quando `dispensavel` **e** `useAuthStore((s)=>s.user?.role)` ∈ {gestor, diretor}; modal (`@atlas/ui` `Modal`) com motivo obrigatório e texto "Isso não altera nada no OMIE — cancelar, recusar ou devolver a NF continua com o fiscal"; sucesso invalida `['sb','rec-nacional','fila']` e volta à lista
- [X] T049 [US4] Em `apps/web/src/pages/stockbridge/gestor/AprovacoesPage.tsx`: seção `NfsDispensadasSection` ao lado de `BaixasExternasSection` — lista (`GET …/nacional/dispensas`) com NF, fornecedor, situação fiscal na dispensa (selo "havia conta a pagar no OMIE" quando `concluido`), motivo, quem/quando; ação "Desfazer" com motivo (modal) → `POST …/dispensas/:id/reverter`; esconder a seção inteira quando a rota devolve `403` (flag desligada)
- [X] T050 [US4] Validar o cenário 4 do quickstart em UAT (dispensar NF pendente e NF já feita, listar, desfazer, tentar em NF já recebida) e registrar no card
  - Feito (07–09/10/2026, comentários 15303/15304/15306): dispensar NF pendente/já feita, auditoria e e-mail ao fiscal exercitados em PROD pelo próprio fiscal (3 dispensas reais, 6936/6937/1257); desfazer dispensa testado (reversão da 1257, `revertido_em`/`motivo_reversao`/`revertido_por` corretos, zero chamada OMIE); `STOCKBRIDGE_FISCAL_EMAILS` corrigido (estava na caixa de validação, não na do fiscal). `422 NF_NAO_DISPENSAVEL` coberto por teste automatizado (T046) — não repetido manualmente, risco baixo.

**Checkpoint**: fila nunca retém NF sem decisão registrada (SC-009).

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T051 [P] Expor a defasagem do espelho de recebimentos no healthcheck do módulo: em `modules/stockbridge/src/routes/stockbridge.routes.ts` (ou no provedor de health já usado pelo `/api/health`), adicionar `recebimentoNfeEspelhoIdadeMin = now() − max(synced_at)` de `public."tbl_recebimentoNFe_Q2P"` com status `degraded` acima de 120 min quando a flag está ligada; logar `warn` na fila quando a idade passar de 120 min (gate 3 do Princípio II; a fila hoje degrada em silêncio). Alinhar com o agente n8n se o alerta deve também sair pelo `errorWorkflow`
- [X] T052 [P] Criar teste de integração (gate `ATLAS_DB_INTEGRATION=1`, padrão do teste de auditoria existente em `modules/stockbridge/src/__tests__/`) que insere/atualiza em `stockbridge.recebimento_fiscal` e `stockbridge.nf_dispensa` e verifica linhas `INSERT`/`UPDATE` em `shared.audit_log` (Princípio IV)
- [X] T053 [P] Atualizar `CLAUDE.md` (bloco StockBridge): parágrafo da feature 016 — espelho `tbl_recebimentoNFe_Q2P` (n8n), fila com duas fontes e precedência, receita EDITAR→IGNORAR→Concluir, ledger `recebimento_fiscal` (lock/idempotência), dispensa `nf_dispensa`, flag default `false`, exceção `produtos/recebimentonfe/`, gotcha do cache de ~1 min do `ConsultarRecebimento`
- [X] T054 Conferir `pnpm --filter @atlas/stockbridge exec tsc --noEmit`, `pnpm --filter @atlas/web exec tsc --noEmit`, `pnpm --filter @atlas/integration-omie test`, `pnpm --filter @atlas/stockbridge test` e lint (`eslint-plugin-boundaries`) limpos
- [ ] T055 Rodar o quickstart completo em UAT com o espelho n8n ativo e a flag ligada só no UAT (cenários 1–6), anexar evidências ao card ACXEGDP-395 e listar no card as pendências de pesquisa fechadas (faultstring de "já concluído", `dtAlt` em recém-criado, fornecedor não cadastrado)
  - Estado (09/10/2026): no UAT pós-405 as escritas são simuladas, então os cenários 1 e 2d não produzem mais a prova de escrita (etapa 60 / `cUsuarioRec=WEBSERVICE` no espelho) — essa evidência já existe do uso real em PROD (4 fiscais concluídos) e do teste de receita na NF 6842. **A barreira "não há NF fiscal pendente na fila" caiu**: uma linha sintética no espelho (`tbl_recebimentoNFe_Q2P`/`_itens_Q2P`, `n_id_receb` inexistente, fornecedor fictício, emissão pós-corte, etapa 40) entra normalmente pela fonte (b) — técnica usada no T041 (cenário 2b, ledger `falha`) e reaproveitável para 2a/2c/3/6. Feitos: 2b (T041), 4 completo com desfazer (T050). Faltam: 2a (duplo clique), 2c (fiscal ok + físico falho), 3 (rejeição do gestor), 5 (flag desligada — já observado incidentalmente quando a flag caiu sozinha, mas não registrado como teste formal) e 6 (edge cases — fornecedor não cadastrado já coberto pela 1257 original em PROD). 2d segue sem caminho prático (exige ação manual simultânea no portal do OMIE). **Gotcha operacional**: a flag `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` já caiu pra `false` uma vez no UAT sem ninguém notar (religamento pós-405) — checar `meta.recebimentoFiscalHabilitado` na resposta de `GET /fila` antes de qualquer teste da 016.
- [X] T056 Abrir PR `016-recebimento-fiscal-nf → uat` com o checklist de revisão da constituição (5 princípios), destacando a exceção ao Princípio II; não promover a `main`/PROD sem a decisão explícita da GMUD sobre `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` em PROD e sem a DDL do espelho criada no PROD pelo n8n (research D4)

---

## Phase 8: Revisão pré-UAT (02/10/2026)

Revisão multiagente (6 dimensões, cada achado verificado por um cético) antes do PR para o UAT: 54 achados, 46 confirmados, 7 plausíveis, 1 refutado. Correções:

- [X] T057 Fornecedor não cadastrado chega do OMIE como `nIdFornecedor: 0` (NF 1257): parser normaliza 0 → null e lê `cBloqueado`/`cDevolvido`; `infoCadastro.cRecebido` ausente recusa a estrutura; serviço recusa sem fornecedor/CNPJ antes de escrever e `executarFiscalSeNecessario` recusa NF sem CNPJ no espelho sem abrir o ledger (`packages/integrations/omie/src/stockbridge/recebimento-nfe.ts`, `modules/stockbridge/src/services/recebimento-fiscal.service.ts`, `recebimento-nacional.service.ts`)
- [X] T058 Só conclui recebimento na etapa 40, não bloqueado nem devolvido (`422 RECEBIMENTO_FISCAL_ETAPA_INESPERADA`); fonte (b) exige `c_recebido='N'`, `c_cancelada='N'` e `c_etapa='40'` explícitos (`fila-nacional.service.ts`)
- [X] T059 Espera de 70 s após falha com escrita (`409 RECEBIMENTO_FISCAL_AGUARDE`, cache de ~1 min) + passos já feitos pulados + órfão de 15 min com token de dono no fechamento + log do erro OMIE antes de gravar o ledger (`recebimento-fiscal.service.ts`)
- [X] T060 NF concluída pelo Atlas fica na fila como "fiscal já feito" pelo ledger na janela entre o sync de recebimentos e o de NF (FR-013); ordem numérica dos itens; `fiscalConcluidoPeloAtlasEm` só para ledger `concluido`; `valorNotaBrl` (NF inteira) no detalhe (`fila-nacional.service.ts`)
- [X] T061 Via 2 da checagem "já recebida" (número da NF) exige `created_at >= emissão` — colisão de número entre fornecedores escondia NF com fiscal pendente (`fiscal-recebida-sql.ts`)
- [X] T062 Tabela da 0053 ausente com a flag ligada → `503 FILA_NACIONAL_NAO_CONFIGURADA` na fila, no detalhe, no POST e no ledger, nunca fila vazia; health `degraded` com espelho vazio ou inacessível (`fila-nacional.service.ts`, rotas, `stockbridge.routes.ts`)
- [X] T063 Baixa externa recusada para NF com fiscal pendente (`409 BAIXA_EXTERNA_FISCAL_PENDENTE`) e link escondido na tela (`recebimento-externo.service.ts`, painel)
- [X] T064 Dispensa: motivo com mensagem própria e `400 MOTIVO_OBRIGATORIO` (inclusive vazio/ausente), `409 NF_EM_RECEBIMENTO` com fiscal em curso, valor da NF inteira no aviso, texto que diz que a situação vem do espelho, aviso ao fiscal também na reversão; `GET …/fiscal` com 403 pela flag; `404 NF_DISPENSADA` no detalhe (`nf-dispensa.service.ts`, `notificacao.service.ts`, rotas)
- [X] T065 UI: banner/botão só prometem o fiscal quando há o que receber; NF sem fornecedor com aviso e botão desabilitado; "Tentar novamente" com contagem após falha e também para erro de proxy/rede; `useApiFetch` sem `SyntaxError` em corpo não-JSON; modal de dispensa e de desfazer com erro dentro, reset, `maxLength`, `htmlFor`, `role="alert"`; seção "NFs dispensadas" mantém a lista em erro de refetch, para o polling no 403 e mostra as desfeitas (FR-024); copy da fila sobre a latência do espelho e o formulário manual
- [X] T066 Stacks: `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED`/`STOCKBRIDGE_FISCAL_EMAILS` no `deploy/portainer/atlas.stack.yml` e nos `.env.example` (no UAT, acrescentar no YAML pelo Portainer); quickstart com a aplicação da 0053 por arquivo e a ordem do deploy; contratos, research (D2 corrigida, limitações) e CLAUDE.md atualizados
- [X] T067 Mock OMIE: `nIdReceb` sintético distinto por chave (concluir uma NF no mock não conclui outra)
- [X] T068 Alerta ativo de espelho defasado: cron `5,35 * * * *` com e-mail a `STOCKBRIDGE_OPS_EMAIL` (reaviso a cada 6 h), limite em `STOCKBRIDGE_ESPELHO_RECEBIMENTOS_MAX_MIN` (default 120, UAT 360) (`alerta-espelho-recebimentos.service.ts`, `cron/index.ts`, `notificacao.service.ts`)
- [X] T069 Segunda rodada (verificação adversarial das correções): `useApiFetch` trata 2xx sem JSON como erro; espera de 70 s também na recursão do lock; `retryAfterSeconds` no corpo dos 502/409 do fiscal (a tela conta com ele); dispensa ignora lock órfão; POST confere a dispensa de novo antes de escrever; recebimento bloqueado/devolvido fora da fila; `c_cancelada` nulo no ramo do ledger; NF sem fornecedor sinalizada já na fila; aviso no formulário manual; seção de dispensadas com uma query só; contrato (§8 baixa externa, §9 health), quickstart (comando zsh-safe com `lock_timeout`, sem reversão como volta de teste, e-mail de teste no UAT) e runbook de PROD

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2 → histórias**. T003 (workflow n8n) corre em paralelo com tudo; só bloqueia a validação em UAT (T027 em UAT, T032, T041, T050, T055). Em dev, o espelho é populado por linhas de teste.
- **US1 (Phase 3)** é o MVP e depende só da Phase 2.
- **US2 (Phase 4)** depende de T016–T018 (CTEs) — pode começar logo após T018.
- **US3 (Phase 5)** depende de T020 (service do fiscal) e T021 (integração); T035–T036 (ledger listável) são independentes das demais tarefas da US3.
- **US4 (Phase 6)** depende de T018 (`dispensavel` no detalhe) e da tabela da Phase 2; é independente de US2/US3.
- **Phase 7** depois de todas.

```
Phase 2 ──▶ US1 (T015–T027) ──▶ US2 (T028–T032)
                 │
                 ├──▶ US3 (T033–T041)
                 └──▶ US4 (T042–T050)        ──▶ Phase 7 (T051–T056)
T003 (n8n) ───────────────────────────────────▶ validações em UAT
```

## Parallel Execution Examples

- **Phase 2**: T009 (flag), T010 (cliente OMIE), T013 (teste do cliente, após T010/T011) e T014 (doc 007) em paralelo com T005–T008 (migration/schema).
- **US1**: T019 (teste da fila) paralelo a T020–T023 (service/integração) depois de T016–T018; T022 e T023 em paralelo entre si.
- **US3 ∥ US4**: duas frentes independentes após a US1 — uma no `recebimento-fiscal.service.ts`, outra em `nf-dispensa.service.ts` + UI do gestor.
- **Phase 7**: T051, T052, T053 em paralelo.

## Implementation Strategy

1. **MVP = Phase 1 + 2 + US1**: fiscal pendente visível e concluído num clique, com os testes do cliente OMIE e do service. Já é demonstrável em dev (mock) e, com o espelho n8n, em UAT.
2. **US2 logo em seguida** (barato — é precedência + regressão): garante a transição sem perda antes de qualquer ativação.
3. **US3 e US4 em paralelo**: robustez e saída da fila.
4. **Ativação**: flag ligada **só no UAT**, processo comunicado à equipe (ninguém mais conclui recebimento de compra nacional no OMIE), observação de algumas NFs reais, então decisão de GMUD para PROD.

## Format Validation

Todas as tarefas seguem `- [ ] T### [P?] [US?] descrição com caminho de arquivo`; fases de Setup/Foundational/Polish sem rótulo de história; US1–US4 com rótulo. Total: **56 tarefas** — Setup 4, Foundational 10, US1 13, US2 5, US3 9, US4 9, Polish 6.
