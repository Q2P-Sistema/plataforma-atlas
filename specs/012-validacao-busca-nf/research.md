# Phase 0 — Research: Validações na Busca de NF do Recebimento

**Feature**: 012-validacao-busca-nf | **Date**: 2026-06-24

Resolve os pontos técnicos abertos do plano. Cada item segue o formato Decisão / Rationale / Alternativas.

---

## R1 — Sinais de cancelamento na resposta de `ConsultarNF`

**Contexto**: `consultarNF` ([packages/integrations/omie/src/stockbridge/nf.ts:23](../../packages/integrations/omie/src/stockbridge/nf.ts#L23)) chama `produtos/nfconsultar/` (method `ConsultarNF`) e hoje mapeia só `ide`, `compl`, `det`, `total`, `nfDestInt`. O sync de NFs canceladas (ACXEGDP-184) lê os sinais `ide.dCan` (cancelamento), `ide.dInut` (inutilização) e `cDeneg` (denegação) — ver referência em [fiscal-recebida-sql.ts:35](../../modules/stockbridge/src/services/fiscal-recebida-sql.ts#L35).

**Decisão**: Estender `RawConsultarNF` para capturar os sinais de invalidade fiscal que a resposta do OMIE traz no bloco `ide`/`compl` (`dCan`, `dInut`, `cDeneg`/denegação) e derivar um booleano `cancelada` em `ConsultarNFResponse` (verdadeiro se qualquer um dos sinais estiver preenchido). O critério reusa a mesma definição já adotada pelo sistema (cancelada ∪ inutilizada ∪ denegada — FR-003/FR-005 do spec).

**Rationale**: Mesma fonte e mesmo critério já usados pelo cockpit/pendências, agora aplicados ao ponto de entrada. Vir da MESMA resposta `ConsultarNF` evita TOCTOU (a NF recebida e o status de cancelamento são a mesma foto).

**Incerteza a verificar em UAT/PROD**: o ambiente DEV usa `OMIE_MODE=mock` e o banco DEV é sanitizado/defasado — não dá para confirmar ao vivo os nomes/posições exatos dos campos de cancelamento que `nfconsultar` retorna. **Ação**: implementar o mapeamento conforme os nomes conhecidos do OMIE (`dCan`/`dInut`/denegação no `ide`), e **confirmar contra o OMIE real em UAT** (consistente com a nota do CLAUDE.md: paridade valida-se contra PROD). A rede de segurança é a FR-010 — se o sinal não vier, cai em **indeterminado → fail-open + alerta**, sem travar operação.

**Alternativas consideradas**:
- *Cruzar com o espelho `public."tbl_nf_header_ACXE".cancelada`* — rejeitado no clarify: o espelho pode estar defasado e a coluna `cancelada` some em alguns ambientes após sync PROD→UAT; além disso misturaria foto sincronizada com foto ao vivo (TOCTOU).

---

## R2 — Discriminar "emitida pela ACXE" vs "NF de entrada de terceiro"

**Contexto**: `consultarNF(cnpj, nNF)` busca por número dentro da conta OMIE do CNPJ. Hoje a resposta mapeia `nfDestInt` (destinatário), não o emitente nem o tipo de operação. O usuário relatou colisão: o número digitado pode bater com uma NF de **entrada de outro fornecedor** em vez da NF **emitida pela ACXE**.

**Decisão**: Estender `RawConsultarNF`/`ConsultarNFResponse` para expor o **tipo de operação** (`ide.tpNF`: 0=entrada, 1=saída) e o **CNPJ/identificação do emitente** (`nfEmitInt`/emitente). A engine de validação considera "emitida pela ACXE" quando a NF é de **saída/emissão própria** da ACXE (tpNF de saída e/ou CNPJ emitente = CNPJ ACXE). NF de entrada de terceiro → bloqueada (FR-004/FR-005). Restrito ao **contexto ACXE** (decisão do clarify); contexto Q2P inalterado.

**Rationale**: O discriminador natural entre "NF emitida pela empresa" e "NF de entrada lançada na empresa" no OMIE é o tipo de operação + emitente. Mapear esses campos resolve a colisão sem precisar de novo endpoint.

**Incerteza a verificar em UAT/PROD** (a maior desta feature):
1. Se `produtos/nfconsultar/` retorna NFs de **entrada** de terceiros (e portanto se a colisão se manifesta nesse endpoint) ou só NFs emitidas — comportamento depende do modelo de dados do OMIE da ACXE.
2. Como `ConsultarNF` resolve um número que existe como entrada **e** saída (qual registro retorna). Se retornar o "errado", pode ser necessário um filtro adicional na consulta.

**Ação**: implementar com base em `tpNF`/emitente; **confirmar contra OMIE real em UAT** com um número sabidamente colidente. Se `nfconsultar` não permitir selecionar a NF correta por número, registrar follow-up para avaliar consulta alternativa (ex.: por chave/filtro) — **não** há `ListarNF` hoje no cliente ([packages/integrations/omie](../../packages/integrations/omie/src/stockbridge/)). Rede de segurança: campo ausente → indeterminado → fail-open + alerta (FR-010).

**Alternativas consideradas**:
- *Adicionar `ListarNF` com filtro tpNF=saída* — adiaria; só justificável se a verificação UAT provar que `ConsultarNF` por número não distingue. Mantido como follow-up condicional, fora do escopo inicial.

---

## R3 — Fonte ao vivo (OMIE) vs espelho Postgres — enquadramento no Princípio II

**Decisão**: Ler cancelamento e emitente da resposta **ao vivo** de `consultarNF`, não do espelho sincronizado.

**Rationale**:
- A chamada `consultarNF` (`produtos/nfconsultar/`) **já é exceção documentada** ao Princípio II (`specs/007-stockbridge-module/research.md` §2 — "leitura de NF individual"). Esta feature **não cria exceção nova**: só lê campos adicionais da mesma resposta.
- Enquadra-se na exceção (1) do Princípio II — "dado fresquíssimo e de volume pequeno que não pode aguardar o próximo ciclo de sync": um cancelamento ocorrido após o último sync precisa ser pego no ato do recebimento.
- Coerência de foto: o produto/quantidade recebidos e o status de cancelamento vêm do mesmo retorno (sem TOCTOU).

**Alternativas consideradas**: ler do espelho `public."tbl_nf_header_*"` — rejeitado (defasagem, coluna `cancelada` instável em UAT, mistura de fotos). Ver R1.

**Conformidade**: Sem ADR novo necessário; reusa exceção pré-existente. Documentar o piggyback em comentário no service (gate do Princípio II: "toda exceção deve estar documentada em ADR ou comentário no service").

---

## R4 — Notificação ao admin/gestor no fail-open (FR-010)

**Decisão**: Reusar o padrão de [notificacao.service.ts:71](../../modules/stockbridge/src/services/notificacao.service.ts#L71) (`enviarAlertaProdutoSemCorrelato`) criando `enviarAlertaNfIndeterminada({ nf, cnpj, motivo })`, que envia e-mail via `sendEmail`/`getAdminEmail` (`@atlas/core`), **fora da transação** e sem bloquear o recebimento.

**Rationale**: padrão já estabelecido e alinhado ao ecossistema (Sendgrid via `@atlas/core`, conforme constituição). Mantém consistência operacional (admin já recebe alertas desse service).

**Alternativas**: notificação só por log — rejeitado: a SC-007 exige notificação ativa ao admin/gestor em 100% dos casos indeterminados.

---

## R5 — Superfície de erro ao operador (FR-004/FR-007)

**Decisão**: Criar erros tipados `NotaFiscalCanceladaError` e `NotaFiscalNaoEmitidaPelaAcxeError` (junto de `NotaFiscalJaProcessadaError`), mapeados em [recebimento.routes.ts](../../modules/stockbridge/src/routes/recebimento.routes.ts) para **HTTP 422** com corpo `{ data: null, error: { code, userMessage } }` (pt-BR). Aplicar tanto no **GET fila** (busca — para a NF não aparecer recebível e o operador ver o motivo) quanto no **POST recebimento** (confirmação — FR-008). O fail-open NÃO gera erro: o recebimento segue (201) e dispara o alerta + log.

**Rationale**: padrão existente já usa erros tipados → status + `userMessage` consumidos pelo frontend ([ConferenciaModal.tsx](../../apps/web/src/pages/stockbridge/operador/ConferenciaModal.tsx), [FilaOmiePage.tsx](../../apps/web/src/pages/stockbridge/operador/FilaOmiePage.tsx)). 422 (Unprocessable Entity) expressa "documento inválido para recebimento" melhor que 409 (conflito de idempotência, já usado p/ NF já processada).

**Alternativas**: retornar lista vazia no GET fila (como o caso "já processada") — rejeitado: silencioso, viola FR-007 (operador precisa saber o porquê).

---

## R6 — Localização e forma da engine de validação

**Decisão**: Função **pura** `validarNfRecebivel(nf: ConsultarNFResponse, contexto: { cnpj }): ResultadoValidacaoNf` em `modules/stockbridge/src/services/nf-validacao.service.ts`, sem I/O, retornando união discriminada `{ status: 'ok' } | { status: 'bloqueada', motivo: 'cancelada' | 'nao_emitida_acxe' } | { status: 'indeterminada', motivo }`. Os call-sites (`getFilaOmie`, `processarRecebimento`) traduzem `bloqueada` → erro tipado e `indeterminada` → fail-open (notifica + log).

**Rationale**: engine pura é trivialmente coberta por Vitest (mesmo padrão do `conferencia.service.ts` citado no CLAUDE.md), isola a regra de negócio do transporte e garante que busca e confirmação compartilham exatamente a mesma decisão (FR-008).

**Alternativas**: embutir os `if`s direto em `recebimento.service.ts` — rejeitado: duplicaria a regra nos dois call-sites e dificultaria teste isolado.

---

## Resumo das decisões

| # | Decisão | Verificar em UAT? |
|---|---|---|
| R1 | Mapear sinais de cancelamento (dCan/dInut/denegação) do `ConsultarNF`; `cancelada` = OR dos sinais | ✅ nomes/posição dos campos ao vivo |
| R2 | Discriminar emitente por tpNF/CNPJ emitente; "emitida ACXE" = saída/emissão própria | ✅ comportamento da colisão por número |
| R3 | Fonte ao vivo (reusa exceção §2 do 007 ao Princípio II) | — |
| R4 | `enviarAlertaNfIndeterminada` espelhando o alerta existente | — |
| R5 | Erros tipados → HTTP 422 + userMessage, em busca e confirmação | — |
| R6 | Engine pura `validarNfRecebivel`, Vitest, compartilhada pelos 2 call-sites | — |

Todos os "NEEDS CLARIFICATION" do Technical Context estão resolvidos. As duas incertezas remanescentes (R1/R2) são de **verificação contra OMIE real** (impossível em DEV mock/sanitizado) e têm rede de segurança via fail-open (FR-010) — não bloqueiam o design nem a implementação.
