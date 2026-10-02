# Phase 0 — Research: Recebimento Fiscal da NF Nacional pelo Atlas

**Feature**: `016-recebimento-fiscal-nf` | **Jira**: ACXEGDP-395 (relacionada: ACXEGDP-394, ACXEGDP-328) | **Data**: 2026-10-02

Evidência colhida de três fontes, todas em leitura: a API OMIE da Q2P (sondas n8n `YN2YubdFHpvheA99`, `0HPZNFvt97wiJsCZ`, `xl6w8zAv7fpp8y1V` — esta última com o teste de escrita autorizado em 02/10/2026 na NF 6842), o espelho PROD (`pg-acxe`) e o banco UAT (`pg-acxe-uat`). As decisões de negócio (duas fontes, fiscal no clique, ordem fiscal→físico, dispensa pelo gestor) foram fechadas com o usuário e estão na spec; aqui ficam as decisões **técnicas** que as sustentam.

---

## D1. A receita de API que reproduz o "só fiscal" da tela é EDITAR → IGNORAR → Concluir, em três chamadas

**Decisão**: o Atlas conclui o recebimento fiscal com três chamadas ao endpoint `produtos/recebimentonfe/`, nesta ordem e sem juntar passos:

1. `AlterarRecebimento` — para **cada item**, `itensIde.cAcao = "EDITAR"` + `itensAjustes = { cNaoGerarMovEstoque: "S", cNaoGerarFinanceiro: "N" }`;
2. `AlterarRecebimento` — para cada item, `itensIde.cAcao = "IGNORAR"`, **sem** `itensAjustes`;
3. `ConcluirRecebimento` — `{ nIdReceb, cEtapa: "60" }`.

**Evidência**: teste real na NF 6842 (Replas, `nIdReceb` 8510564869), execuções 444130 e 444133. O estado final lido por `ConsultarRecebimento` ficou **idêntico** ao da NF 6580, que o fiscal concluiu pela tela com "Ignorar": `cEtapa 60`, `cRecebido S`, `cIgnorarItem S`, `cAssociarExistente N`, `nIdProduto 0`, descrição do item intacta, `cNaoGerarMovEstoque S`, `cNaoGerarFinanceiro N`, conta a pagar gerada (`nIdTitulo` 8510719969, R$ 203.400,00). A NF entrou no `ListarNF` e no espelho às 07:44 e foi recebida fisicamente pela fila às 07:48 sem reaparecer.

**Por que não uma chamada só**: `IGNORAR` com `itensAjustes` no mesmo item devolve `SOAP-ENV:Client-151` ("Quando a tag [cAcao] é diferente de 'EDITAR' as tag […] [itensAjustes] não devem ser informadas") e **não altera nada** — a recusa é limpa. Já `ASSOCIAR-PRODUTO` é exatamente o que poluiu a descrição do item na NF 6495 (ACXEGDP-394) e fica proibido neste fluxo.

**Alternativas**: (a) `AlterarEtapaRecebimento` direto para 60 — não configura "não movimentar estoque" nos itens; sem o passo 1 o OMIE poderia gerar movimento de estoque ao concluir; rejeitada. (b) Reproduzir a tela em massa ("Não Movimentar Estoque") — não existe na API como campo de cabeçalho, só por item; é o que o passo 1 faz.

---

## D2. `ConsultarRecebimento` tem cache de ~1 minuto por corpo idêntico — a conferência varia o corpo e o lock é do Atlas, não do OMIE

**Decisão**: a proteção contra duplo clique e contra "timeout que gravou" vem de **um ledger próprio** (`stockbridge.recebimento_fiscal`, D6) com linha única por NF, **não** de consultar o OMIE duas vezes. O OMIE é consultado uma vez antes de agir (por `cChaveNfe`) e, se um passo de escrita falhar com fault de estado, consultado de novo com **outro corpo** (`nIdReceb`) para furar o cache.

**Evidência**: na execução 444130, logo após as duas alterações, `ConsultarRecebimento` por `nIdReceb` (mesmo corpo da consulta anterior, < 1 min) devolveu o estado **antigo** (`cNaoGerarMovEstoque N`, `cIgnorarItem N`); a mesma consulta por `cChaveNfe` (corpo diferente, execução 444131) devolveu o estado novo. O cliente Atlas já conhece a trava correlata de "consumo redundante" (`segundosDeEsperaRedundante` em `client.ts`); este é outro efeito do mesmo mecanismo: em vez de recusar, devolve resposta velha.

**Consequência**: uma conferência pós-escrita que repita o corpo da pré-conferência pode ler "não concluído" e induzir uma segunda conclusão. Por isso a sequência é: lock no ledger → `Consultar(cChaveNfe)` → escritas → ledger `concluido` sem reconsultar; retry só acontece noutro clique, que começa por `Consultar(cChaveNfe)` de novo.

**Correção da revisão pré-UAT (02/10/2026)**: a premissa "se o retry vier em menos de 1 min, o lock do ledger ainda segura" era falsa — o índice parcial exclui `falha`, então o lock é solto na hora e a tela oferece "Tentar novamente" imediatamente. Agora: (a) depois de uma `falha` em passo **com escrita** (editar/ignorar/concluir), uma nova tentativa da mesma NF é recusada por 70 s (`409 RECEBIMENTO_FISCAL_AGUARDE`; a tela mostra a contagem); (b) passos já feitos são pulados pelo estado lido na consulta — `EDITAR` só em item não ignorado e sem os ajustes, `IGNORAR` só em item não ignorado — o que é seguro mesmo com leitura em cache, porque uma leitura velha só mostra um estado anterior; (c) o órfão do lock passou de 5 para 15 min (pior caso de uma requisição viva: consulta com retry na trava de consumo redundante + três escritas com timeout de 30 s) e o fechamento do ledger confere o dono (`iniciado_em` como token).

---

## D3. O que o OMIE devolve ao concluir duas vezes é desconhecido — o desenho não depende disso

**Decisão**: não testar `ConcluirRecebimento` em recebimento já concluído em produção (único OMIE disponível; risco de efeito colateral fiscal). O fluxo trata qualquer fault nos passos 1–3 como **falha sem escrita do lado Atlas** e, antes de desistir, reconsulta por `nIdReceb`: se `cRecebido = "S"`, o desfecho vira `ja_concluido` e o físico segue. A primeira ocorrência real desse caso fica registrada no ledger (`erro_omie_codigo/mensagem`) para a mensagem ser reconhecida depois.

**Rationale**: a existência de `AlterarRecebimentoConcluido` como método separado indica que `AlterarRecebimento` recusa recebimento concluído — então o passo 1 falha cedo, o que é bom (nada é escrito). O caso "`Concluir` deu timeout mas gravou" é coberto pela reconsulta e pelo ledger.

---

## D4. O espelho dos recebimentos pendentes é novo, em `public.*`, escrito pelo n8n, com DDL canônica na migration Atlas

**Decisão**: duas tabelas novas, `public."tbl_recebimentoNFe_Q2P"` (cabeçalho) e `public."tbl_recebimentoNFe_itens_Q2P"` (itens), alimentadas por um workflow n8n novo ("Q2P - Exporta Recebimentos NF-e", contrato em `contracts/espelho-recebimentos-n8n.md`). A **DDL canônica fica na migration `0053`** (`CREATE TABLE IF NOT EXISTS`), aplicada no UAT e no PROD; o n8n só grava. **Confirmada pelo usuário em 02/10/2026.**

**Evidência**: todas as tabelas-espelho e as do `stockbridge.*` têm o mesmo dono (`postgres`) no UAT — o role do n8n grava sem GRANT extra. Convenção vigente: espelhos OMIE vivem em `public."tbl_*_Q2P"` (Princípio I prevê a exceção), o n8n é o único responsável por sync OMIE→Postgres (Princípio II/III), e tabelas n8n-only vêm sendo criadas à mão (`tbl_sync_debounce`, `tbl_logPvSepararEstoque_Q2P` — "DDL manual via DBeaver" no repo `backup-workflow-n8n`).

**Por que a DDL na migration e não só à mão**: a fila do Atlas e seus testes dependem da tabela existir em dev/UAT/PROD; `IF NOT EXISTS` torna a migration inócua onde o n8n já tiver criado. Consequência operacional: no PROD, onde o Atlas ainda não rodou migration (go-live pendente), a tabela precisa ser criada **antes** pelo n8n/DBeaver com a mesma DDL — o contrato do espelho traz o SQL exato.

**UAT**: `scripts/sync-omie-public-prod-to-uat.sh` copia `public.*` de PROD para UAT (dump data-only; a lista `ATLAS_TABLES_IN_PUBLIC` só exclui tabelas que **não** existem em PROD). Como a tabela existirá nos dois, a cópia a inclui sem alteração no script. Hoje o UAT fica ~1 h 30 atrás do PROD (`max(synced_at)` 10:44 × 12:09 UTC em 02/10) — a latência da fila no UAT é a do script, não a do n8n; SC-002 (30 min) é meta de PROD.

**Alternativas**: (a) espelho em `stockbridge.*` escrito pelo n8n — mistura escrita externa em schema privado do módulo; rejeitada. (b) sem espelho, fila consultando `ListarRecebimentos` ao vivo — viola o Princípio II e o padrão da fila 015 (zero OMIE no caminho de leitura); rejeitada.

---

## D5. Sync incremental em duas passagens: por `dtAlt` (janela de 2 dias) **e** por `cEtapa=40` sem data

**Decisão**: cada rodada do workflow faz (1) `ListarRecebimentos` com `dtAltDe/dtAltAte` = `MAX(synced_at)::date − 2 dias` até hoje e (2) `ListarRecebimentos` com `cEtapa = "40"` sem filtro de data, ambas com `cExibirDetalhes = "S"`, 100 por página, retry-chain e trava em `tbl_sync_debounce` (chave `receb_q2p_incremental`), no mesmo padrão do `qw7QTeHv3LCVag0s` Rev 1.8.

**Evidência** (sonda `YN2YubdFHpvheA99`, exec. 444213, 02/10/2026):

| Consulta | Resultado |
|---|---|
| 60 dias por emissão, sem detalhe | 383 recebimentos / 4 páginas; na 1ª página 99 na etapa 80 e 1 na 40; `infoCadastro` **ausente** sem detalhe (não dá para ler `cCancelada`/`cRecebido`) |
| `cEtapa = "40"`, com detalhe | **8** recebimentos / 1 página; filtro respeitado; `infoCadastro` presente; itens com `cDescricaoProduto`, `nQtdeNFe`, `cUnidadeNfe`, `vTotalItem`, `cCFOP` (do fornecedor) e `itensAjustes.cCFOPEntrada` |
| `dtAltDe/dtAltAte` 30/09–02/10, sem detalhe | 166 / 2 páginas, todos etapa 80, emissão início de setembro — o filtro por alteração funciona e pega movimentações de etapa |

**Rationale**: a passagem por `dtAlt` traz tudo que mudou (conclusões, cancelamentos, mudança de etapa); a passagem por `cEtapa=40` garante que uma NF **recém-chegada da SEFAZ** entre no espelho mesmo que `dAlt` ainda não exista (na 6842 recém-importada `infoCadastro` tinha `dInc/hInc` e **nenhum** `dAlt` — não se sabe se `dtAltDe` a alcançaria). Ela também é pequena (8 em 60 dias, sem filtro de data) e serve de rede: enquanto a NF estiver pendente, aparece toda rodada; quando sair da 40, a passagem por `dtAlt` atualiza a linha. `cExibirDetalhes = "S"` é obrigatório: sem ele não vêm itens nem `infoCadastro`.

**Escala**: a fila "fiscal pendente" nasce com **zero** NFs elegíveis (dos 8 na etapa 40: 3 cancelados, 3 da ACXE intercompany — excluída por `fornecedor_exclusao` — e 2 fora do CFOP 1.101/1.102/2.101/2.102). O volume esperado é de unidades por semana. Cada rodada: ~2–4 chamadas OMIE.

**Reconciliação**: `nIdReceb` é a PK, com `UNIQUE (c_chave_nfe)` e o mesmo "apaga a linha antiga pela chave antes do upsert" do sync de NF (ACXEGDP-329) — por precaução, já que o `nIdNF` provou ser instável e nada garante que `nIdReceb` não seja.

---

## D6. Ledger `stockbridge.recebimento_fiscal`: lock, idempotência e rastro num só lugar

**Decisão**: tabela nova com **uma linha "viva" por chave de NF** (índice único parcial em `nf_chave_acesso WHERE status IN ('em_andamento','concluido','ja_concluido')`), gravada **antes** da primeira chamada ao OMIE (status `em_andamento`), e fechada em `concluido`, `ja_concluido` ou `falha`. Falhas ficam como histórico (várias linhas `falha` por NF são permitidas). `em_andamento` com mais de 5 minutos é considerado órfão (processo morreu) e pode ser retomado.

**Rationale**: é o mesmo padrão do ledger `stockbridge.baixa_pedido_q2p` (ACXEGDP-344): "pendente gravado ANTES da chamada; o retry confere e não desconta duas vezes". Cumpre FR-011/FR-017/FR-018 de uma vez: o `INSERT` concorrente perde no índice único (duplo clique → 409 "já em andamento"); a linha `concluido` faz a fila marcar a NF como "fiscal já feito" **antes** de o espelho refletir (janela de até 30 min do sync); e quem/quando/resultado/erro ficam no mesmo registro, auditado pela trigger (Princípio IV).

**Alternativas**: advisory lock de sessão — descartado (pool de conexões; mesma razão do ACXEGDP-344). Só a reconsulta no OMIE — descartada por D2.

---

## D7. O valor do item na fonte "fiscal pendente" é `itensCabec.vTotalItem` = `v_prod` (sem o IPI em dobro)

**Decisão**: o detalhe da NF com fiscal pendente usa `vTotalItem` do item do recebimento como `valor_item`, equivalente ao `i.v_prod` que a fila atual usa (D26 da feature 015).

**Evidência**: NF 59869 da Zaraplast (IPI 5%, `nIdReceb` 8509732940), lida por `ConsultarRecebimento` (exec. 444215): item 1 `vTotalItem` **44.550,03**, IPI 2.121,43; no espelho de NF a mesma linha tem `v_prod` **44.550,03** e `v_tot_item` 46.671,46 (= + IPI outra vez). Soma dos `vTotalItem` = 267.300,16 = `nValorNFe` = `totais.vTotalNFe`. A fonte nova **não** tem o campo com IPI duplicado — não há como errar como o `v_tot_item`.

Unidade: `cUnidadeNfe` traz as mesmas grafias de `u_com` (`KG`, `TON`, `TL` nas amostras) — `converterItemNfParaKg` é reaproveitado sem mudança. CFOP do recorte: usar **`itensAjustes.cCFOPEntrada`** (1.102/2.102), não `itensCabec.cCFOP` (5.102/6.101 — é o CFOP de saída do fornecedor).

---

## D8. As duas fontes da fila se unem por chave de acesso, com precedência da fonte "fiscal já feito"

**Decisão**: a query da fila (e a do detalhe) passa a ler um `UNION ALL` de duas fontes normalizadas para o mesmo shape de linha — (a) espelho de NF (`tbl_nf_header_Q2P ⋈ tbl_nf_itens_Q2P`, comportamento atual) e (b) espelho de recebimentos com `c_recebido = 'N'`, `c_cancelada = 'N'` — onde (b) só entra para chaves que **não** existem em (a) e **não** têm ledger `concluido`/`ja_concluido`. Cada NF sai com `fiscal: 'pendente' | 'concluido'`.

**Rationale**: FR-005 (uma NF, uma vez). Entre a conclusão fiscal e o próximo sync, a mesma chave pode estar na fonte (b) como etapa 40 (stale) e já na (a); a precedência da (a), reforçada pelo ledger, resolve sem consultar o OMIE. O critério "pendente" é `c_recebido = 'N'` e não `c_etapa = '40'`: é o campo que o próprio OMIE usa para "recebido", e protege contra etapas anteriores a 40 que porventura carreguem NF.

**Filtros comuns às duas fontes**: `tp_nf = 0`/natureza de entrada, CFOP de entrada no recorte, `d_emissao >= data de corte`, não cancelada/deletada, fornecedor não excluído (`c_cnpj_cpf` vem no mesmo formato `99.999.999/9999-99` de `dest_cnpj_cpf`), e **não dispensada** (D9). A checagem "já recebida" (`itemNacionalRecebidoSql`) é por chave + descrição normalizada e serve igual às duas fontes.

**Caso observado**: um dos 8 recebimentos na etapa 40 veio **sem fornecedor** (`cRazaoSocial`/`cCNPJ_CPF` ausentes — fornecedor não cadastrado no OMIE). A fila mostra "Fornecedor não identificado no OMIE"; o fiscal via API deve falhar nesse caso com fault do OMIE (cadastro é pré-requisito) — mensagem ao operador orienta o fiscal a cadastrar o fornecedor no OMIE. Fica registrado como edge case testável, não como bloqueio de desenho.

---

## D9. Dispensa de NF: tabela própria, soft delete por reversão, sem tocar no OMIE

**Decisão**: `stockbridge.nf_dispensa` com `nf_chave_acesso`, `motivo NOT NULL`, `dispensado_por/em`, `revertido_por/em`, `motivo_reversao`; índice único parcial `(nf_chave_acesso) WHERE revertido_em IS NULL`; trigger de auditoria. A fila exclui chaves com dispensa ativa nas **duas** fontes (clarificação da spec: dispensada e depois concluída no OMIE continua fora até a reversão). Rotas `requireGestor`.

**Rationale**: espelha `fornecedor_exclusao` (excluído/reincluído) e a reversão de `recebimento_externo` (FR-031 da 015) — padrões já aceitos pelo módulo para "tirar da fila com motivo e trilha". Não reaproveita `stockbridge.aprovacao` porque não há nada a aprovar: a dispensa é a decisão do gestor, final até ser desfeita.

**Escopo ampliado na análise de 02/10/2026 (decisão do usuário)**: a dispensa vale para qualquer NF ainda não recebida fisicamente, com fiscal **pendente ou já feito**. Antes era só "fiscal pendente", o que deixava sem saída a NF cujo fiscal foi concluído no OMIE mas cuja carga nunca chega — e a mensagem de erro apontava para a baixa por recebimento externo, que declara uma entrada de estoque que não existiu. A tabela guarda `situacao_fiscal_na_dispensa` para o gestor saber, na lista, se há uma conta a pagar no OMIE a tratar.

---

## D10. Onde o fiscal entra no fluxo existente: entre o portão 1 e o portão 2 de `processarRecebimentoNacionalPorNf`

**Decisão**: o service de recebimento por NF ganha um passo entre a validação tudo-ou-nada e a escrita por produto: se `detalhe.fiscal === 'pendente'` **e** há ao menos um produto preparado para gravar **e** a flag está ligada → `concluirRecebimentoFiscal(detalhe)`. Falha → lança `RecebimentoFiscalError` (502, mensagem com NF e fornecedor, sem código OMIE) **antes** de qualquer `INSERT`. Sucesso ou `ja_concluido` → segue para o portão 2 inalterado. O resultado ganha `fiscal: { status, concluidoEm, mensagem }`.

**Rationale**: FR-008 (fiscal antes do estoque) e FR-012 (falha do fiscal = nada escrito). O "físico" no caminho nacional é a dupla movimentação+aprovação gravada no clique e o ajuste OMIE na **aprovação do gestor** (`aprovarEntradaNacional`); nada disso muda. Rejeição do gestor desativa a movimentação (`ativo = false`, já existente) → a checagem "já recebida" deixa de casar → a NF volta à fila, agora pela fonte (a) ou pelo ledger como "fiscal já feito" (FR-016). Itens todos bloqueados por unidade **não** disparam o fiscal (nada será recebido pelo Atlas; a NF continua "fiscal pendente" com o bloqueio visível).

**Alternativa rejeitada**: fiscal na aprovação do gestor, junto com o ajuste OMIE — contraria a decisão de processo (fiscal no clique do operador, inclusive com divergência) e atrasaria a conta a pagar até a aprovação.

---

## D11. Cliente OMIE: três funções novas em `packages/integrations/omie`, mock com estado, sem retry nas escritas

**Decisão**: `stockbridge/recebimento-nfe.ts` com `consultarRecebimentoNfe` (leitura, `retries: 2`), `alterarRecebimentoNfeItens` (escrita, sem retry) e `concluirRecebimentoNfe` (escrita, sem retry); mock em `mock.ts` com um mapa em memória de recebimentos (`__injectMockRecebimentoNfe`, estado de `cEtapa/cRecebido/itens`), para que a transição 40→60 e o `ja_concluido` sejam testáveis sem OMIE. Exportação em `index.ts`.

**Rationale**: segue `client.ts`/`pedido-compra.ts` (STK-23: retry só em leitura idempotente). A exceção ao Princípio II para `produtos/recebimentonfe/` (leitura `ConsultarRecebimento` + escritas `AlterarRecebimento`/`ConcluirRecebimento`) fica documentada no cabeçalho do arquivo e no `research.md` da 007, como as demais.

---

## D12. Flag `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED`, default **desligada**

**Decisão**: nova chave no schema de config (`packages/core/src/config.ts`), default `false`. **Confirmada pelo usuário em 02/10/2026** (alternativa oferecida — default ligada, padrão das demais flags do módulo — recusada). Desligada: a fila não lê a fonte (b), o detalhe não mostra "fiscal pendente", o POST não chama o OMIE e as rotas de dispensa respondem 403 — comportamento idêntico ao anterior à feature (FR-020). O contrato devolve a flag no detalhe (`recebimentoFiscalHabilitado`), como já faz com a de recebimento externo.

**Rationale**: diferente das flags de baixa de pedido e de recebimento externo (default ligadas), esta **escreve em documento fiscal** do OMIE e muda um processo operacional (a equipe deixa de concluir no portal). Ligar explicitamente por ambiente (UAT primeiro) é a postura do Princípio V. O go-live PROD por transplante do UAT (ACXEGDP-321) decide o valor em PROD na GMUD.

---

## Pendências de pesquisa que o UAT fecha (não bloqueiam o plano)

1. **Faultstring de `AlterarRecebimento`/`ConcluirRecebimento` em recebimento já concluído** (D3) — capturar na primeira ocorrência via ledger e, se útil, mapear para `ja_concluido` sem reconsulta.
2. **`dtAltDe` alcança recebimento recém-criado sem `dAlt`?** (D5) — irrelevante para a correção (a passagem `cEtapa=40` cobre), mas define se a segunda passagem pode virar semanal.
3. ~~**Fornecedor não cadastrado** (D8)~~ — **resolvido na revisão pré-UAT**: o OMIE real devolve `nIdFornecedor: 0` (não nulo) e omite CNPJ/razão (NF 1257, sonda `YN2YubdFHpvheA99`, exec 444213). O parser normaliza 0 → null; o Atlas recusa antes de qualquer escrita (sem CNPJ no espelho → nem abre o ledger; `nIdFornecedor` 0/nulo ou sem CNPJ na consulta → ledger `falha` no passo `consultar`). O fault do OMIE ao tentar concluir sem fornecedor segue desconhecido — e agora não é mais provocado.
4. **`EDITAR` em item já ignorado** nunca foi testado no OMIE real — o fluxo passou a não enviar (passos já feitos são pulados).

## Limitações conhecidas (revisão pré-UAT, 02/10/2026)

- **Fiscal revertido no OMIE depois de concluído pelo Atlas**: o ledger `concluido` é terminal — a NF segue "fiscal já feito" no Atlas e o próximo recebimento faz só o físico. Refazer o fiscal, nesse caso, fica com o fiscal no portal (é ele quem reverteu). Reabrir o ledger exigiria comparar o `synced_at` do espelho com o `finalizado_em` e um estado novo; só com caso real.
- **NF com fiscal pendente lançada pelo formulário manual**: o manual grava movimentação sem chave; a via 2 da checagem "já recebida" (número da NF) a reconhece e a NF sai da fila — o Atlas não conclui o fiscal. Mitigação: a via 2 agora exige `created_at >= emissão` (lançamento manual anterior à emissão é de outra NF com o mesmo número — colisão TRADECONNEX 6894 × REPLAS 6894) e a tela avisa que o manual não conclui o fiscal. NFs assim continuam visíveis ao fiscal na caixa "Faturado pelo fornecedor" do OMIE. Evolução possível: ação "concluir só o fiscal" para NF recebida manualmente.
- **Alerta ativo de espelho defasado**: o health do módulo (`GET /api/v1/stockbridge/health`) marca `degraded` com o espelho vazio, inacessível ou com mais de 120 min, e a fila loga `warn`; não há e-mail nem entrada no `/api/v1/health`. O `errorWorkflow` do n8n cobre falha de execução, não workflow parado. Fica como evolução (cron com e-mail para `STOCKBRIDGE_OPS_EMAIL`).
