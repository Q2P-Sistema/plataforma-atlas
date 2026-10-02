# Implementation Plan: Recebimento Fiscal da NF Nacional pelo Atlas

**Branch**: `016-recebimento-fiscal-nf` | **Date**: 2026-10-02 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/016-recebimento-fiscal-nf/spec.md`
**Jira**: ACXEGDP-395 (subtarefa de ACXEGDP-114; relacionada a ACXEGDP-328 e ACXEGDP-394)

## Summary

Hoje uma NF de compra nacional só chega à fila do StockBridge depois que alguém conclui o recebimento **fiscal** no portal do OMIE — e, quando essa pessoa faz o físico junto (vínculo de produto), a descrição do item é alterada e a NF reaparece na fila (caso 6495). A feature move o fiscal para dentro do Atlas: no clique de confirmação do operador, o Atlas conclui o recebimento fiscal no OMIE **sem movimentar estoque** e só então grava o recebimento físico (que continua como na feature 015, com ajuste de estoque na aprovação do gestor).

**Abordagem técnica** — cinco peças, sobre a estrutura da 015:

1. **Espelho novo** `public."tbl_recebimentoNFe_Q2P"` + itens, alimentado por workflow n8n novo (`ListarRecebimentos`, duas passagens: por `dtAlt` e por `cEtapa=40`), DDL canônica na migration `0053` (research D4/D5). É a fonte "fiscal pendente".
2. **Fila com duas fontes** — `fila-nacional.service.ts` passa a unir o espelho de NF (atual, "fiscal já feito") e o espelho de recebimentos (`c_recebido='N'`), por chave de acesso, com precedência da primeira e do ledger; cada NF sai com `fiscal: 'pendente'|'concluido'` (D8). Valor do item na fonte nova = `v_total_item` ≡ `v_prod` (D7).
3. **Fiscal via API** — `recebimento-fiscal.service.ts` executa `EDITAR → IGNORAR → Concluir` (D1), com lock e rastro no ledger `stockbridge.recebimento_fiscal` (D6), consultando o OMIE uma vez antes e furando o cache de ~1 min quando precisa reconsultar (D2/D3). Entra em `processarRecebimentoNacionalPorNf` entre o portão 1 (validação) e o portão 2 (gravação) — falha no fiscal = nada escrito (D10).
4. **Dispensa de NF** — `stockbridge.nf_dispensa`, rotas `requireGestor` de dispensar/listar/reverter, exclusão nas duas fontes da fila (D9).
5. **Flag** `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` (default `false`): desligada, tudo volta ao comportamento da 015 (D12).

Cliente OMIE ganha `recebimento-nfe.ts` (3 funções + mock com estado, D11). UI: selo fiscal na fila, banner e desfecho fiscal no detalhe, botão "Dispensar" para gestor, seção "NFs dispensadas" em Aprovações. E-mails existentes (396) não mudam; há **um e-mail novo**, ao fiscal, na dispensa (FR-026), descrevendo a pendência que fica no OMIE — decisão de 02/10/2026 de não automatizar `ReverterRecebimento`/`ExcluirRecebimento`. Defasagem do espelho novo entra no `/api/health` do módulo (gate 3 do Princípio II).

**O que a pesquisa fixou** (detalhe em [research.md](./research.md)): a receita de três chamadas reproduz exatamente o "Ignorar" da tela (NF 6842); `IGNORAR` com ajustes dá erro 151 sem efeito; `ConsultarRecebimento` repete resposta velha por ~1 min para corpo idêntico; `ListarRecebimentos` só traz itens e `infoCadastro` com `cExibirDetalhes=S`; há **8** recebimentos na etapa 40 em 60 dias (zero elegíveis hoje) — a fila "fiscal pendente" é pequena; `vTotalItem` = `v_prod` (sem IPI em dobro); a tabela-espelho pode nascer na migration porque todos os espelhos e o `stockbridge.*` têm o mesmo dono (`postgres`).

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, Node.js 20 LTS
**Primary Dependencies**: Express 4 (rotas estendidas + 4 novas), Drizzle ORM (2 tabelas novas no schema + migration), raw SQL via `getPool()` (fila unificada sobre os dois espelhos), `@atlas/integration-omie` (3 funções novas em `produtos/recebimentonfe/`), Zod (validação), React 18 + TanStack Query + Tailwind (`RecebimentoNacionalNfPanel`, `AprovacoesPage`). Sem dependência nova. n8n (workflow novo de sync — fora deste repo, contrato em `contracts/espelho-recebimentos-n8n.md`).
**Storage**: PostgreSQL 16 — **leitura** de `public."tbl_recebimentoNFe_Q2P"`/`"_itens_Q2P"` (novas, escritas pelo n8n), `public."tbl_nf_header_Q2P"`/`"tbl_nf_itens_Q2P"`, `stockbridge.fornecedor_exclusao`, `stockbridge.movimentacao`, `stockbridge.aprovacao`; **escrita** nas novas `stockbridge.recebimento_fiscal` e `stockbridge.nf_dispensa` (ambas com trigger de auditoria) e, pelo fluxo já existente, em `movimentacao`/`aprovacao`. **Escrita no OMIE**: `AlterarRecebimento` ×2 e `ConcluirRecebimento` (exceção nova ao Princípio II, documentada).
**Testing**: Vitest — cliente OMIE `recebimento-nfe` (mock com transição 40→60, `ja_concluido`, erro 151), `recebimento-fiscal.service` (ordem dos passos, lock, falha sem escrita, reconsulta com corpo alternativo, flag), SQL da fila unificada (inspeção do SQL gerado e casos de precedência/dispensa, como `fila-pendente.test.ts`), `nf-dispensa.service`, regressão da 015 com a flag desligada (fila/detalhe/POST idênticos), Supertest nas rotas novas (gestor × operador); integração com `ATLAS_DB_INTEGRATION=1` para as duas triggers de auditoria.
**Target Platform**: Linux server (Docker Swarm, `apps/api` + `apps/web`); n8n self-hosted na mesma infra.
**Project Type**: Web — monorepo modular (`modules/stockbridge` + `apps/web` + `packages/db` + `packages/integrations/omie`).
**Performance Goals**: fila consultada na abertura da aba; a query unificada adiciona um `UNION ALL` sobre um espelho de dezenas de linhas (8 na etapa 40 em 60 dias). O POST por-nf ganha **3 chamadas OMIE síncronas** (~1–1,5 s cada medidas no teste) só quando o fiscal está pendente — latência aceitável para um clique de confirmação; sem fiscal pendente, zero chamada extra.
**Config nova**: `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED` (default `false`) e `STOCKBRIDGE_FISCAL_EMAILS` (lista separada por vírgula; default `nfe@acxe-polimeros.com.br,mauricio@acxe-polimeros.com.br,gustavo.dreer@acxe-polimeros.com.br` — destinatários do e-mail de dispensa, FR-026; definido pelo usuário em 02/10/2026).
**Constraints**: (a) fiscal **antes** de qualquer `INSERT`; falha ⇒ nada gravado (FR-008/012); (b) nunca `ASSOCIAR-PRODUTO` — é a causa do 6495; (c) sem retry em escrita OMIE (STK-23) — idempotência pelo ledger + reconsulta; (d) `ConsultarRecebimento` repetido com corpo idêntico em < 1 min devolve cache — variar `cChaveNfe`/`nIdReceb`; (e) mensagens por NF + fornecedor, nunca `nIdReceb`/faultcode (ACXEGDP-313); (f) flag desligada = comportamento da 015 byte a byte; (g) fonte "fiscal pendente" nunca entra sem a flag; (h) Wait no n8n < 65 s (ACXEGDP-319); (i) NFs já na etapa 60 **não** são revertidas.
**Scale/Scope**: fila "fiscal pendente" com 0–5 NFs por vez; ~2–4 chamadas OMIE por rodada do sync; ~6 arquivos backend estendidos + 3 novos, 1 migration, 3 arquivos no cliente OMIE, 2 telas estendidas, 1 workflow n8n novo.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Princípio | Avaliação | Status |
|---|---|---|
| **I. Monólito Modular com Fronteiras Inegociáveis** | Código novo em `modules/stockbridge/*`, `packages/integrations/omie/*`, `packages/db/*` e `apps/web`. Tabelas de estado nascem em `stockbridge.*`. As duas tabelas-espelho nascem em `public."tbl_*_Q2P"` — **exceção prevista no próprio gate** ("tabelas OMIE sincronizadas, que permanecem em `public`"), escritas só pelo n8n (research D4). Nenhuma leitura de tabela privada de outro módulo. Migration centralizada em `packages/db/migrations/0053_*`. | ✅ PASS |
| **II. OMIE é Fonte de Verdade, Atlas Lê do Postgres** | Fila e detalhe continuam lendo **só** o Postgres (espelho de NF + espelho de recebimentos). O sync OMIE→Postgres do novo espelho é do n8n, incremental por `dtAlt` (+ passagem `cEtapa=40`), sem full-refresh. **Exceção nova e deliberada**: o Atlas **escreve** no OMIE para concluir o recebimento fiscal (`AlterarRecebimento`, `ConcluirRecebimento`) e lê `ConsultarRecebimento` uma vez, imediatamente antes de escrever — ambas documentadas no cabeçalho de `recebimento-nfe.ts` e na seção 2 de `specs/007-stockbridge-module/research.md` (a ser estendida), ao lado das exceções já aceitas (`estoque/ajuste/`, `produtos/pedidocompra/`, `nfconsultar`). O OMIE segue fonte de verdade do documento: o Atlas não seta status à mão, aciona a operação do próprio ERP. | ✅ PASS (exceção justificada) |
| **III. Dinheiro Só em TypeScript** | Toda a lógica (decisão de concluir, ordem dos passos, idempotência, dispensa, fila unificada) vive em TS com Vitest. O n8n só sincroniza OMIE→Postgres (ETL, sem regra de domínio nem escrita em tabela financeira do Atlas). Nenhum cálculo novo de valor: o custo do item vem de `v_total_item` ≡ `v_prod`, reaproveitando `converterItemNfParaKg`. | ✅ PASS |
| **IV. Audit Log Append-Only via Trigger** | `stockbridge.recebimento_fiscal` e `stockbridge.nf_dispensa` nascem na migration 0053 com `audit_<tabela>()` + `trg_audit_sb_<tabela>` cobrindo INSERT/UPDATE/DELETE (padrão da skill `stockbridge-migration`). Dispensa e reversão são UPDATE auditado; o ledger nunca é apagado. Teste de integração verifica a gravação em `shared.audit_log`. Tabelas-espelho não são de domínio crítico do Atlas (cópia de leitura, como as demais `tbl_*`). | ✅ PASS |
| **V. Validação Paralela, Zero Big-Bang** | Flag **default desligada**: nada muda sem decisão explícita por ambiente (UAT primeiro). Com a flag ligada, a fonte "fiscal já feito" permanece **intacta** — quem concluir no OMIE continua atendido; NFs já na etapa 60 não são revertidas. A transição é aditiva e reversível (desligar a flag devolve o comportamento anterior sem migration). O processo operacional (equipe deixa de concluir no portal) é pré-requisito de ativação, registrado na spec. | ✅ PASS |

**Resultado do gate**: PASS. A exceção ao Princípio II é a única decisão que exige registro formal — feita aqui e replicada na documentação da 007 pelas tarefas. Nada a justificar em Complexity Tracking.

**Re-check pós-Fase 1**: mantido PASS. O desenho não acrescentou leitura OMIE no caminho da fila, não moveu lógica para o n8n, manteve as triggers nas duas tabelas novas e não criou tabela de domínio fora de `stockbridge.*`.

## Project Structure

### Documentation (this feature)

```text
specs/016-recebimento-fiscal-nf/
├── plan.md                                # Este arquivo
├── spec.md                                # 3 histórias, 25 FRs, 9 SCs, 1 clarificação
├── research.md                            # Phase 0 — 12 decisões com evidência OMIE/PROD/UAT
├── data-model.md                          # Phase 1 — 2 espelhos + ledger + dispensa; shapes
├── quickstart.md                          # Phase 1 — 6 cenários de validação
├── contracts/
│   ├── recebimento-fiscal-nf.md           # API Atlas (3 rotas estendidas + 4 novas)
│   └── espelho-recebimentos-n8n.md        # DDL + workflow n8n (prompt para o agente dos workflows)
├── checklists/requirements.md             # aprovado
└── tasks.md                               # Phase 2 (/speckit.tasks — NÃO criado aqui)
```

### Source Code (repository root)

```text
packages/db/
├── migrations/
│   └── 0053_stockbridge_recebimento_fiscal_nf.sql   # NOVA: public."tbl_recebimentoNFe_Q2P" + itens (IF NOT EXISTS);
│                                                    #   stockbridge.recebimento_fiscal + trigger; stockbridge.nf_dispensa
│                                                    #   + trigger; índices únicos parciais
└── src/schemas/stockbridge.ts                       # ESTENDER: recebimentoFiscal, nfDispensa

packages/core/src/config.ts                          # ESTENDER: STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED (default false)

packages/integrations/omie/src/
├── stockbridge/recebimento-nfe.ts                   # NOVO: consultarRecebimentoNfe (retries 2),
│                                                    #   alterarRecebimentoNfeItens, concluirRecebimentoNfe (sem retry)
├── stockbridge/mock.ts                              # ESTENDER: mapa de recebimentos, __injectMockRecebimentoNfe,
│                                                    #   transições 40→60, erro 151 ao juntar IGNORAR+ajustes
├── index.ts                                         # ESTENDER: exports
└── __tests__/recebimento-nfe.test.ts                # NOVO

modules/stockbridge/src/
├── services/
│   ├── fila-nacional.service.ts            # ESTENDER: CTEs nf_unificada/itens_unificados (duas fontes, precedência,
│   │                                       #   ledger, dispensa); `fiscal` e `nIdReceb` nos shapes; fornecedor nulo
│   ├── recebimento-fiscal.service.ts       # NOVO: concluirRecebimentoFiscal (lock no ledger → Consultar(chave) →
│   │                                       #   EDITAR → IGNORAR → Concluir → ledger), reconsulta por nIdReceb em fault,
│   │                                       #   listarLedgerFiscal, erros RecebimentoFiscalError/EmAndamento/SemFornecedor
│   ├── nf-dispensa.service.ts              # NOVO: dispensar, listar, reverter (gestor); erros
│   └── recebimento-nacional.service.ts     # ESTENDER: passo fiscal entre portão 1 e 2; `fiscal` no resultado
├── routes/
│   ├── recebimento-nacional.routes.ts      # ESTENDER: fila/detalhe/por-nf; NOVAS: POST dispensar, GET dispensas,
│   │                                       #   POST dispensas/:id/reverter, GET fiscal (requireGestor)
│   └── aprovacao.routes.ts                 # (sem mudança — listagem de dispensas fica nas rotas nacionais)
└── __tests__/                              # NOVO: recebimento-fiscal.test.ts, fila-nacional-unificada.test.ts,
                                            #   nf-dispensa.test.ts, recebimento-nacional-fiscal-flag.test.ts (regressão),
                                            #   rotas-dispensa.test.ts (supertest); ESTENDER: audit integration

apps/web/src/pages/stockbridge/
├── operador/RecebimentoNacionalNfPanel.tsx # ESTENDER: selo "Fiscal pendente/já feito" na fila; banner no detalhe;
│                                           #   desfecho fiscal no resultado; botão "Dispensar da fila" (gestor/diretor)
│                                           #   com modal de motivo
└── gestor/AprovacoesPage.tsx               # ESTENDER: seção "NFs dispensadas" (lista + desfazer), ao lado de
                                            #   "Baixas externas"

specs/007-stockbridge-module/research.md   # ESTENDER: seção 2 — exceção `produtos/recebimentonfe/`
CLAUDE.md                                   # ESTENDER: bloco StockBridge (feature 016)

# Fora deste repo (contrato em contracts/espelho-recebimentos-n8n.md):
# backup-workflow-n8n — workflow "Q2P - Exporta Recebimentos NF-e - Rev 1.0" + specs/<id>/spec.md
```

**Structure Decision**: web monorepo modular, estendendo os mesmos arquivos da 015. A peça central de reúso é a **query da fila**: em vez de uma segunda fila, as duas fontes são normalizadas para o shape de linha que `getFilaNacional`/`getDetalheNfNacional` já consomem (`c_chave_nfe, n_nf, dest_razao, …, x_prod, cfop, q_com, u_com, valor_item`), de modo que agregação por descrição, conversão de unidade, checagem "já recebida", sugestão de correlação e UI continuam iguais. O fiscal entra como um passo isolado (`recebimento-fiscal.service.ts`) chamado pelo service de recebimento, para ser testável sozinho e reutilizável por um eventual painel de retentativa.

## Complexity Tracking

> Constitution Check passou sem violações — preenchimento não requerido.

Quatro notas de desenho, nenhuma delas violação:

**1. Exceção ao Princípio II é ampliada, não contornada.** A escrita em `produtos/recebimentonfe/` é a quarta exceção do StockBridge (depois de ajuste de estoque, pedido de compra e `nfconsultar`). Ela é feita pelo próprio mecanismo do ERP (concluir recebimento), com o ERP permanecendo fonte de verdade do documento, e fica atrás de flag default desligada. Registrada no cabeçalho do cliente e na 007.

**2. DDL do espelho na migration Atlas.** Convenção vigente é DDL manual (DBeaver) para tabelas n8n-only; aqui a DDL canônica fica na 0053 (`IF NOT EXISTS`) porque a fila e os testes do Atlas dependem da tabela existir em dev/UAT/PROD. Até o go-live do Atlas em PROD, o n8n cria a tabela com a mesma DDL (está no contrato) — a migration é inócua onde ela já existir. Risco de drift mitigado por um único texto de DDL referenciado nos dois lugares.

**3. Latência no UAT não é a do n8n.** O UAT lê `public.*` por cópia de PROD (`sync-omie-public-prod-to-uat.sh`); SC-002 (30 min) é meta de PROD. Para o UAT, o critério de aceite é "aparece na fila após a próxima cópia" — documentado no quickstart.

**4. `ja_concluido` sem teste prévio do fault.** Não se testou concluir duas vezes em produção (único OMIE disponível). O desenho não depende da mensagem: fault ⇒ reconsulta com corpo alternativo ⇒ `cRecebido='S'` vira `ja_concluido`. A primeira ocorrência real fica no ledger para refinar a detecção depois (research, pendência 1).
