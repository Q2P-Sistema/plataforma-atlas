# Implementation Plan: Recebimento Nacional com Pedido de Compra

**Branch**: `017-recebimento-nacional-com-pc` | **Date**: 2026-10-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/017-recebimento-nacional-com-pc/spec.md`
**Jira**: ACXEGDP-437 (subtarefa de ACXEGDP-114; estende ACXEGDP-328/015 e ACXEGDP-395/016)

## Summary

Desde 19/10/2026, compras lança pedido de compra (PC) no OMIE para a compra nacional. A receita fiscal da 016 (`EDITAR → IGNORAR → Concluir`) desfaz o vínculo do item com o PC, e o PC fica aberto. Isso aconteceu nas NFs 7736 e 67913, e por isso o fiscal pelo Atlas está desligado em PROD desde 21/10 (contenção). A feature faz o Atlas sugerir o PC de cada item, o operador confirmar, e o fiscal ser concluído **com o item vinculado ao PC e sem movimentar estoque no OMIE**. O estoque continua entrando pelo Atlas, depois da aprovação.

**Abordagem técnica**: seis peças sobre a estrutura da 015/016, mais os ajustes pós-estreia de 22/10/2026 (peça 7) e o fiscal revertido no portal (peça 8, 25/10/2026).

1. **Espelho de recebimentos com o vínculo**: quatro colunas novas (`n_id_pedido`, `n_id_it_pedido`, `n_num_ped_compra`, `c_num_it_ped_compra`) na migration `0056`, gravadas pelo n8n (D9). É de onde vem o "vínculo do OMIE" e a detecção de estoque lançado pelo portal.
2. **Sugestão de PC** (`pc-sugestao.service.ts`, novo): monta, por item agregado, o vínculo do OMIE, os candidatos dentro da tolerância (2% na quantidade, 1% no preço, etapa 15, mesmo fornecedor), os outros PCs do fornecedor (escolha manual com justificativa) e os PCs aguardando aprovação. Lê só o Postgres: espelho de recebimentos, cópia de PCs na Rev 1.5 e cache de PCs vistos (D3, D16).
3. **Fiscal com vínculo**: `recebimento-fiscal.service.ts` passa a manter o vínculo existente (`EDITAR` + `Concluir`, validado na NF 7813, D1) ou gravar um novo (`ASSOCIAR-PEDIDO` antes do `EDITAR`, D2). O `IGNORAR` fica restrito a itens sem PC. Antes de escrever, relê ao vivo o recebimento e cada PC (D4). Os vínculos ficam em `stockbridge.recebimento_fiscal_pc` (D5).
4. **Regras novas no portão 1**: NF sem PC (configurável, bloquear por padrão, aviso a compras deduplicado, D6) e estoque já lançado pelo OMIE (bloqueio que vale com a chave desligada, D7).
5. **Leitores da cópia de PCs** passam a usar o saldo (`nqtde − nqtderec`): cockpit e pendências fiscais. A função de trânsito da 0037 (PL/pgSQL) fica como está, com a limitação registrada (D10). A cópia de PCs passa a ser monitorada como tabela crítica, e, defasada, não bloqueia NF nem avisa compras (D13).
6. **Compra nacional pela ACXE** (História 5, fase 2, migration `0058`): empresa como dimensão da fila, espelho de recebimentos da ACXE, fiscal na ACXE, entrada de estoque pela regra da importação, sempre nas duas empresas no local espelhado escolhido (Extrema = 21.1), **mesmo valor nas duas empresas**, sem PC nem baixa na Q2P (D11).
7. **Ajustes pós-estreia (22/10/2026)**, depois da NF 60199 (Zaraplast × PC 306) em PROD, com a chave religada (~14h50, imagem v1.1.20, 0056 aplicada):
   - **PC por NF** (D14): `pcsDaNf` no detalhe (`montarPcsDaNf`, em `pc-sugestao.service.ts`); o operador escolhe o PC uma vez, e o POST segue por item;
   - **PC de outro cadastro com a mesma raiz de CNPJ** oferecido (D17), depois do T033 (`ASSOCIAR-PEDIDO` aceito entre cadastros);
   - **trava de unidade** (D15): `STOCKBRIDGE_PC_UNIDADE_DIFERENTE` (`bloquear` por padrão, `converter` atrás de chave) e `itensAjustes.nQtdeRecebida` no cliente OMIE, porque o OMIE baixa o PC na unidade da NF, sem converter;
   - **cache de PCs vistos** (D16): migration `0057`, `stockbridge.pedido_compra_visto` e `pc-visto.service.ts`, porque o OMIE tira da lista de pendentes o PC com item associado a um recebimento aberto.
8. **Fiscal revertido no portal** (D21 da 017, 25/10/2026, NF 19252 × PC 308): o ledger `concluido` deixa de ser final.
   - **sinal** `fiscalRevertidoSql` (`fiscal-revertido.ts`): horas de evento do OMIE (`d_alt` + `h_alt`, Brasília) dos espelhos de recebimentos e de NF contra a conclusão, com margem de 2 min. A NF revertida volta como fiscal pendente pelo espelho de recebimentos, com `fiscalRevertido` e o selo "Fiscal revertido no OMIE";
   - **ledger** `revertido` (migration `0060`) e vínculos de PC `revertido` na mesma transação; `adquirirLedger` marca e abre a trava nova;
   - **leitura ao vivo no clique** de NF cujo fiscal o Atlas concluiu (há pelo menos 75 s), com `409 RECEBIMENTO_FISCAL_REVERTIDO`;
   - **varredura no cron `5,35`** e e-mail ao fiscal quando a entrada física já foi lançada (a NF não volta à fila);
   - kill switch `STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED`; vale só com a chave da 016; o Atlas nunca reverte no OMIE.

**O que a pesquisa fixou** (detalhe em [research.md](./research.md)):

- O teste da NF 7813 mostrou que `EDITAR` preserva o vínculo, que `Concluir` gera a conta a pagar sem movimentar estoque e que o OMIE atualiza sozinho o `nQtdeRec` do PC. O Atlas não precisa mexer no PC.
- O n8n que espelha PCs da ACXE na Q2P ignora PC nacional (ACXEGDP-376). Por isso não há PC na Q2P na compra nacional pela ACXE.
- `ConsultarPedCompra` tem cache de cerca de 1 minuto, daí a regra "PC recém-usado".
- O vínculo novo pela API (`ASSOCIAR-PEDIDO`) foi **testado com NF real em 22/10/2026** (T033, NF 60199) e aceito, inclusive com PC de outro cadastro do mesmo fornecedor. Falta a troca de um vínculo existente. A NF menor que o saldo do PC foi confirmada em 23/10/2026 (NF 67988, D20): o OMIE aceita, e o PC fica "recebido parcialmente", com o saldo em aberto.
- O OMIE grava no PC a quantidade recebida **na unidade da NF**, sem converter (NF em toneladas × PC em kg). Daí a trava de unidade (D15).
- O OMIE tira da lista de pendentes o PC com item associado a um recebimento aberto. Daí o cache de PCs vistos (D16).
- A reversão no portal devolve o recebimento à etapa 40, mantém vínculo, "não movimentar estoque" e quantidades, e devolve o saldo do PC; o espelho de NF nunca marca a nota como excluída (0 de 24.978 cabeçalhos da Q2P). Daí o sinal por horas de evento do OMIE e a leitura ao vivo no clique (D21 da 017).

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, Node.js 20 LTS

**Primary Dependencies**: as mesmas da 016, sem dependência nova.
- Express 4: rotas estendidas + 1 nova (`POST …/recebimento/nacional/aviso-compras`, achado A1 da revisão de UI).
- Drizzle ORM: 3 tabelas novas (2 na 0056 e o cache de PCs vistos na 0057), 1 estendida.
- Raw SQL via `getPool()`: sugestão sobre os espelhos.
- `@atlas/integration-omie`: ação `ASSOCIAR-PEDIDO` e parse do vínculo em `recebimento-nfe.ts`; `consultarPedidoCompra` reaproveitado da 344.
- Zod, React 18 + TanStack Query + Tailwind (`RecebimentoNacionalNfPanel`).
- n8n, fora deste repo, contrato em `contracts/espelhos-n8n.md`: nova revisão do workflow de recebimentos da Q2P e workflow novo da ACXE.

**Storage**: PostgreSQL 16.
- **Leitura**: `public."tbl_recebimentoNFe_*"` (com as colunas novas), `public."tbl_pedidosCompras_*"` (Rev 1.5), `stockbridge.pedido_compra_visto` (cache de PCs vistos, 0057), `public."tbl_nf_header_*"`/`"tbl_nf_itens_*"`, `public."tbl_cadastroFornecedoresClientes_*"`, `stockbridge.fornecedor_exclusao`, `stockbridge.localidade_correlacao`.
- **Escrita**: as novas `stockbridge.recebimento_fiscal_pc`, `stockbridge.nf_aviso_compras` e `stockbridge.pedido_compra_visto` (0057, cache de PCs vistos), todas com trigger de auditoria, a extensão de `stockbridge.recebimento_fiscal` e, pelo fluxo existente, `movimentacao`/`aprovacao`.
- **Escrita no OMIE**: `AlterarRecebimento` com a ação nova `ASSOCIAR-PEDIDO`, dentro da exceção ao Princípio II já documentada para `produtos/recebimentonfe/`.

**Testing**: Vitest.
- Cliente OMIE: `ASSOCIAR-PEDIDO`, parse do vínculo, mock com associação e `nQtdeRec`.
- `pc-sugestao.service`: tolerâncias, ordenação, empates, número do pedido, PC-espelho, etapa 10, vínculos divergentes por sequência; PC de outro cadastro, trava de unidade (`bloquear` e `converter`) e `montarPcsDaNf`.
- `pc-visto.service`: upsert só do que mudou, leitura só do que a cópia não trouxe, falha sem exceção.
- `recebimento-fiscal.service`: receitas D1/D2, `IGNORAR` só sem PC, releitura, "PC recém-usado", `VINCULO_OMIE_MUDOU`, idempotência por item.
- Portão 1: `NF_SEM_PC` nos dois modos, estoque já lançado, aviso deduplicado.
- Regressão da contenção (chave desligada) e da baixa da 344.
- Fiscal revertido (D21 da 017): o sinal (`fiscal-revertido`), a fila e o detalhe com e sem a D21 da 017 (golden `*-desligado` intactos), `adquirirLedger`, o clique e o 409, a varredura e o e-mail ao fiscal; opt-in com Postgres real e a 0060. A tela não tem teste automatizado no repositório (como em T097).
- Supertest no schema `.strict()` do POST.
- Integração `ATLAS_DB_INTEGRATION=1` para as triggers novas.

**Target Platform**: Linux server (Docker Swarm, `apps/api` + `apps/web`); n8n self-hosted na mesma infra.

**Project Type**: Web, monorepo modular (`modules/stockbridge` + `apps/web` + `packages/db` + `packages/core` + `packages/integrations/omie`).

**Performance Goals**:
- O detalhe da NF ganha uma consulta à cópia de PCs filtrada por fornecedor. A cópia tem cerca de 250 linhas, então o custo é desprezível.
- O POST com fiscal pendente ganha **1 `ConsultarPedCompra` por PC distinto** e **1 `AlterarRecebimento` (`ASSOCIAR-PEDIDO`)** por item com vínculo novo. O item com vínculo do OMIE não ganha chamada extra.
- O caso típico (1 item, 1 PC, vínculo do OMIE) soma 1 chamada à 016: cerca de 1 a 1,5 s a mais num clique de confirmação.

**Config nova**: ver data-model §10.
- `STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC` (default `true`);
- `STOCKBRIDGE_PC_TOLERANCIA_QTD_PCT` (2) e `STOCKBRIDGE_PC_TOLERANCIA_PRECO_PCT` (1);
- `STOCKBRIDGE_COMPRAS_EMAILS` (vazio → `STOCKBRIDGE_OPS_EMAIL`);
- `STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED` (default `false`);
- `STOCKBRIDGE_COPIA_PCS_MAX_MIN` (default 120);
- `STOCKBRIDGE_PC_UNIDADE_DIFERENTE` (default `bloquear`, 22/10/2026).
- `STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO` (default `false`, 23/10/2026, research D20; migration 0059) e `STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT` (default 10).
- `STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED` (default `true`, 25/10/2026, D21 da 017; exige a migration 0060 e a chave da 016).

Todas no schema Zod de `packages/core/src/config.ts` e listadas nas stacks (`atlas.stack.yml`, YAML do UAT, `.env.example`). Reaproveitada: `STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED`.

**Constraints**:
- (a) Nunca `IGNORAR` item com PC associado, salvo troca explícita para outro PC por `ASSOCIAR-PEDIDO` (FR-011a).
- (b) Nunca concluir com `cNaoGerarMovEstoque = 'N'` em item não ignorado.
- (c) Releitura ao vivo do recebimento e dos PCs antes de escrever; falha ⇒ nada gravado.
- (d) Sem retry em escrita OMIE (STK-23); idempotência pelos ledgers.
- (e) Cache de cerca de 1 min no OMIE: regra "PC recém-usado" (75 s) e corpo alternado na reconsulta.
- (f) Mensagens com número da NF, fornecedor e número do PC, nunca IDs internos (ACXEGDP-313).
- (g) A chave desligada mantém a contenção, mais FR-021/021a.
- (h) A baixa da 344 não muda.
- (i) Religar a chave só com a imagem da 017 (quickstart).
- (j) No UAT, `OMIE_MODE=leitura`: o `ASSOCIAR-PEDIDO` é simulado na sombra.
- (k) Cópia de PCs defasada não decide nada: sem `NF_SEM_PC` e sem aviso a compras; o POST com fiscal pendente responde 503 (D13).
- (l) Reserva de saldo por item de PC (linhas `confirmado`/`associado` de outras NFs) para duas NFs simultâneas não consumirem o mesmo saldo; a trava consultiva só cobre a checagem e a gravação da reserva (D4).
- (m) PC em unidade diferente da NF não é vinculado no modo `bloquear`: o OMIE baixaria o PC na unidade da NF, sem converter. `converter` validado em PROD em 25/10/2026 (T073, D15).
- (n) O ledger `concluido` só vale se nenhuma leitura posterior do OMIE mostrar a NF não recebida: o sinal compara horas de evento do OMIE (Brasília, margem de 2 min), nunca `synced_at`; o clique de NF cujo fiscal o Atlas concluiu confere o recebimento ao vivo antes de pular o fiscal; o Atlas nunca reverte no OMIE (D21 da 017).

**Scale/Scope**:
- Volume: cerca de 3 PCs nacionais por dia na Q2P (19 a 21/10), zero na ACXE; fila nacional de unidades por dia.
- Mudanças: cerca de 10 arquivos de backend estendidos e 5 novos (com `pc-visto.service.ts`, `fiscal-revertido.ts` e `fiscal-revertido-varredura.service.ts`), 5 migrations (0056, 0057, na Fase 2 a 0058, para a baixa do PC pelo peso conferido a 0059 e, para o fiscal revertido, a 0060), 3 arquivos do cliente OMIE, 1 tela estendida, 2 workflows n8n (1 revisão e 1 novo).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Princípio | Avaliação | Status |
|---|---|---|
| **I. Monólito Modular com Fronteiras Inegociáveis** | Código novo em `modules/stockbridge/*`, `packages/integrations/omie/*`, `packages/db/*`, `packages/core/src/config.ts` e `apps/web`. Tabelas de estado em `stockbridge.*`. Os espelhos ficam em `public."tbl_*"`, escritos só pelo n8n (exceção prevista no gate, como na 016). Nenhuma leitura de tabela privada de outro módulo: o forecast continua lendo `tbl_pedidosCompras_ACXE` pela sua própria query, sem mudança. | ✅ PASS |
| **II. OMIE é Fonte de Verdade, Atlas Lê do Postgres** | A fila, o detalhe e a sugestão de PC leem **só** o Postgres (espelho de recebimentos e cópia de PCs, sincronizados pelo n8n por evento e agenda, sem full-refresh no caminho de leitura, mais o cache de PCs vistos, que é derivado da cópia). Ler o PC ao vivo no detalhe foi descartado justamente por este princípio (D16). As leituras ao vivo acontecem só no POST, imediatamente antes de escrever (`ConsultarRecebimento`, da 016, e `ConsultarPedCompra`, da 344), e uma vez para NF "fiscal já feito" cuja conclusão o espelho de recebimentos não confirma (NF ausente, linha defasada com `c_recebido = 'N'` ou não casada com o item) e sem o fiscal concluído pelo Atlas no ledger (D7), e uma vez, no clique de NF cujo fiscal o próprio Atlas concluiu, para detectar a reversão no portal antes de pular o fiscal (D21 da 017). A escrita nova (`ASSOCIAR-PEDIDO`) é uma ação de `AlterarRecebimento`, dentro da exceção já documentada para `produtos/recebimentonfe/`. O texto da seção 2 da 007 ganha a ação e as leituras ao vivo (D4, D7, D21 da 017). O OMIE segue fonte de verdade do PC: o Atlas não altera o PC, e o próprio ERP atualiza `nQtdeRec` (D1). **Monitoramento** (DEVE do gate): a cópia de PCs passa a decidir a sugestão e o bloqueio, então vira tabela crítica, com health, alerta de defasagem e modo seguro (D13), como o espelho de recebimentos da 016. | ✅ PASS (exceção existente, ampliada; achado C1 do `/speckit-analyze` resolvido) |
| **III. Dinheiro Só em TypeScript** | Tolerâncias, escolha de candidato, valores de entrada (incluindo a regra "mesmo valor nas duas empresas" da História 5) e regras de bloqueio ficam em TS, com Vitest. O n8n só copia OMIE→Postgres. A feature **não** altera `refresh_lotes_em_transito_se_stale` (0037): a função é PL/pgSQL que faz UPSERT e soft-delete em `stockbridge.lote`, um desvio herdado ao Princípio III. Reeditá-la reforçaria o desvio, então ela fica como está e a limitação (quantidade cheia de PC recebido em parte, caso que hoje não existe) vai para um card próprio, que leva o trânsito para TypeScript (D10). | ✅ PASS (desvio herdado da 0037 registrado, não ampliado; achado C2 do `/speckit-analyze`) |
| **IV. Audit Log Append-Only via Trigger** | `stockbridge.recebimento_fiscal_pc`, `stockbridge.nf_aviso_compras` e `stockbridge.pedido_compra_visto` (0057) nascem com `audit_<tabela>()` + `trg_audit_sb_<tabela>` (padrão da skill `stockbridge-migration`). A extensão de `recebimento_fiscal` herda a trigger existente. Nada é apagado: os vínculos passam por estados, e a troca do vínculo do OMIE guarda o anterior e a justificativa. | ✅ PASS |
| **V. Validação Paralela, Zero Big-Bang** | A ativação é por chave (a da 016, hoje desligada). Desligada, vale a contenção, mais duas proteções aditivas (FR-021/021a). O vínculo novo (D2) teve teste controlado com NF real antes da ativação em PROD, como na NF 6842 e na 7813 (T033, NF 60199, 22/10/2026). A História 5 entra numa fase própria, atrás de outra chave. Reversível: desligar a chave devolve a contenção sem migration. | ✅ PASS |

**Resultado do gate**: PASS. A única decisão com registro formal é a ampliação da exceção ao Princípio II para a ação `ASSOCIAR-PEDIDO`. Nada a justificar em Complexity Tracking.

**Re-check pós-Fase 1** (refeito depois do `/speckit-analyze` de 21/10/2026, que apontou C1 e C2): mantido PASS. O desenho não pôs leitura OMIE no caminho da fila nem do detalhe, não moveu regra para o n8n, criou trigger nas duas tabelas novas e não criou tabela de domínio fora de `stockbridge.*`.

**Re-check da D21 da 017** (25/10/2026): mantido PASS. A leitura ao vivo nova é só no POST, imediatamente antes de decidir se pula o fiscal, de uma NF por vez, e fica documentada na seção 2 da 007 e no comentário do código. A fila, o detalhe e a varredura do cron leem só o Postgres, e o Atlas não escreve no OMIE para reverter nada. A 0060 é aditiva, e as colunas novas herdam o trigger de auditoria das duas tabelas (Princípio IV).

## Project Structure

### Documentation (this feature)

```text
specs/017-recebimento-nacional-com-pc/
├── plan.md                                  # Este arquivo
├── spec.md                                  # 5 histórias, FR-000..035, SC-001..012, clarificações de 21/10, 22/10, 23/10 e 25/10/2026
├── research.md                              # Phase 0: 21 decisões, D1 a D21 da 017 (teste NF 7813, T033, gate ACXEGDP-376, cache de PCs, unidade, ACXE, quantidade recebida, peso conferido, fiscal revertido)
├── data-model.md                            # Phase 1: colunas do espelho, 3 tabelas novas (§11 = cache de PCs vistos), extensões, shapes (§13 = fiscal revertido)
├── quickstart.md                            # Phase 1: 12 cenários + ordem de deploy
├── contracts/
│   ├── recebimento-nacional-pc.md           # API Atlas: fila/detalhe/POST/ledger estendidos, erros novos
│   └── espelhos-n8n.md                      # n8n: colunas de pedido (Q2P) + espelho ACXE
├── checklists/requirements.md               # aprovado
└── tasks.md                                 # Phase 2 (/speckit.tasks; NÃO criado aqui)
```

### Source Code (repository root)

```text
packages/db/
├── migrations/
│   ├── 0056_stockbridge_recebimento_nacional_pc.sql   # NOVA (Q2P): colunas de pedido no espelho de itens;
│   │                                                  #   recebimento_fiscal (+empresa, +passo 'associar', +itens_vinculados);
│   │                                                  #   recebimento_fiscal_pc + trigger (dentro_tolerancia, índice de reservas);
│   │                                                  #   nf_aviso_compras + trigger
│   ├── 0057_stockbridge_pedido_compra_visto.sql       # NOVA (22/10/2026): cache de PCs vistos + trigger de auditoria
│   ├── 0058_stockbridge_recebimento_nacional_acxe.sql # NOVA (História 5): espelho de recebimentos ACXE;
│   │                                                  #   fornecedor_exclusao.empresa (+ Q2P excluída na ACXE)
│   ├── 0059_stockbridge_pc_peso_conferido.sql         # NOVA (23/10/2026, D20): recebimento_fiscal_pc.kg_recebido_pc;
│   │                                                  #   motivo 'excedente_rejeitado' em nf_aviso_compras
│   └── 0060_stockbridge_fiscal_revertido.sql          # NOVA (25/10/2026, D21 da 017): status 'revertido' + revertido_* e
│                                                      #   aviso_fiscal_em no ledger; 'revertido' em recebimento_fiscal_pc
└── src/schemas/stockbridge.ts                         # ESTENDER: recebimentoFiscal (+campos, +status da 0060), recebimentoFiscalPc,
                                                       #   nfAvisoCompras, fornecedorExclusao.empresa

packages/core/src/config.ts                            # ESTENDER: 10 variáveis novas (data-model §10)

packages/integrations/omie/src/
├── stockbridge/recebimento-nfe.ts                     # ESTENDER: AcaoItemRecebimento += 'ASSOCIAR-PEDIDO'
│                                                      #   (nIdPedidoExistente/nIdItPedidoExistente); parse de
│                                                      #   itensCabec.nIdPedido/nIdItPedido e itensInfoAdic
├── stockbridge/mock.ts                                # ESTENDER: associação com estado, nQtdeRec do PC ao concluir,
│                                                      #   sombra do modo leitura
└── __tests__/recebimento-nfe.test.ts, mock.test.ts    # ESTENDER

modules/stockbridge/src/
├── services/
│   ├── pc-sugestao.service.ts               # NOVO: sugerirPcPorItem (vínculo do OMIE, candidatos, outros, aguardando),
│   │                                        #   validarEscolhaPc (portão 1), releituraPc (ConsultarPedCompra + trava
│   │                                        #   + "PC recém-usado")
│   ├── pc-visto.service.ts                  # NOVO (22/10): cache de PCs vistos (registrarPcsVistos, lerPcsVistos); best-effort
│   ├── fiscal-revertido.ts                  # NOVO (25/10, D21 da 017): módulo folha — fiscalRevertidoSql (o sinal), guarda da 0060,
│   │                                        #   marcarLedgerRevertido, ledgerFiscalVigente, RecebimentoFiscalRevertidoError
│   ├── fiscal-revertido-varredura.service.ts # NOVO (25/10, D21 da 017): cron 5,35 — fase A marca ledgers, fase B avisa o fiscal
│   ├── fila-nacional.service.ts             # ESTENDER: colunas de pedido nas duas fontes; pc por item agregado;
│   │                                        #   pcSituacao; estoqueLancadoPeloOmie; empresa (fase 2);
│   │                                        #   fiscalRevertido/fiscalRevertidoEm: fonte (b) serve a NF revertida (D21 da 017)
│   ├── recebimento-fiscal.service.ts        # ESTENDER: itensParaIgnorar só sem PC; ASSOCIAR-PEDIDO antes de EDITAR;
│   │                                        #   recusa VINCULO_OMIE_MUDOU; linhas em recebimento_fiscal_pc;
│   │                                        #   callOmie por empresa (fase 2); adquirirLedger marca revertido (D21 da 017)
│   ├── recebimento-nacional.service.ts      # ESTENDER: portão 1 (NF_SEM_PC, estoque já lançado, escolha de PC);
│   │                                        #   pc no resultado; entrada ACXE/dual sem markup (fase 2);
│   │                                        #   leitura ao vivo do recebimento no clique de NF concluída pelo Atlas (D21 da 017)
│   ├── notificacao.service.ts               # ESTENDER: enviarAvisoComprasNfSemPc (deduplicado); enviarAvisoFiscalRevertido (D21 da 017)
│   ├── alerta-espelho-recebimentos.service.ts # ESTENDER: idade da cópia de PCs no health e no alerta (D13)
│   ├── cockpit.service.ts                   # ESTENDER: saldo = nqtde - nqtderec (D10)
│   └── pendencias-fiscais.service.ts        # ESTENDER: idem
├── cron/index.ts                            # ESTENDER: a varredura do fiscal revertido entra no job 5,35 (nunca uma 4ª expressão)
├── routes/recebimento-nacional.routes.ts    # ESTENDER: schema .strict() com itens[].pc; mapeamento dos erros novos
│                                            #   (409 RECEBIMENTO_FISCAL_REVERTIDO); GET /fiscal com vínculos e status revertido
└── __tests__/                               # NOVOS: pc-sugestao, recebimento-fiscal-pc, recebimento-nacional-pc;
                                             #   ESTENDER: rotas, fila unificada, flag-off, auditoria, cockpit/pendências

apps/web/src/pages/stockbridge/operador/
└── RecebimentoNacionalNfPanel.tsx           # ESTENDER: selo de PC na fila; bloco "Pedido de compra" no ItemCard
                                             #   (vínculo do OMIE, candidatos, outros com justificativa, aguardando
                                             #   aprovação, sem PC); aviso de estoque já lançado; mensagens dos erros novos;
                                             #   selo "Fiscal revertido no OMIE", aviso do detalhe e o 409 que recarrega a nota (D21 da 017)

specs/007-stockbridge-module/research.md    # ESTENDER: seção 2, ação ASSOCIAR-PEDIDO
CLAUDE.md                                   # ESTENDER: bloco StockBridge (feature 017)
deploy/portainer/atlas.stack.yml, YAML UAT, .env.example   # ESTENDER: variáveis novas

# Fora deste repo (contrato em contracts/espelhos-n8n.md):
# backup-workflow-n8n: "Q2P - Exporta Recebimentos NF-e" (nova revisão) + "ACXE - Exporta Recebimentos NF-e" (novo)
```

**Structure Decision**: web monorepo modular, estendendo os arquivos da 015/016. A sugestão de PC fica num service próprio (`pc-sugestao.service.ts`), chamado pelo detalhe (só leitura) e pelo portão 1 e pela releitura do POST. Assim fica testável sozinha e a regra de elegibilidade fica num lugar só. O fiscal continua isolado em `recebimento-fiscal.service.ts`, agora decidindo a ação por item (manter vínculo, associar ou ignorar). A História 5 reaproveita a mesma fila e o mesmo fiscal, parametrizados por empresa, e a escolha de locais da importação (`listarLocalidadesEspelhadas`, com a correspondência em `localidade_correlacao`).

**Fases de entrega**:
- **Fase 1** (Histórias 1 a 4, Q2P): 0056, n8n Q2P, monitoramento da cópia de PCs, sugestão, fiscal com vínculo, portão 1, leitores. Fecha a contenção.
- **Ajustes pós-estreia** (22/10/2026): 0057 (cache de PCs vistos) e a imagem seguinte à v1.1.20, com PC por NF, PC de outro cadastro e trava de unidade.
- **Fase 2** (História 5, ACXE): 0058, n8n ACXE, empresa na fila e no fiscal, entrada dual (ACXE + Q2P) no local espelhado; Extrema = 21.1 (research D11).
- **Ajuste de 25/10/2026** (D21 da 017, fiscal revertido): 0060 **antes** da imagem; a chave nova (`STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED`) já vem ligada, mas a D21 da 017 só vale com a chave da 016 e com a 0060; primeiro uso acompanhado na NF 19252.

## Complexity Tracking

> Constitution Check passou sem violações; preenchimento não requerido.

Cinco notas de desenho, nenhuma delas violação:

**1. Teste com NF real antes de ativar.** O vínculo novo (`ASSOCIAR-PEDIDO`) foi exercitado contra o OMIE de produção, que é o único disponível, na NF 60199 (T033, 22/10/2026), e a chave foi religada depois (quickstart, pré-requisito 5). Não foi testada a troca de um vínculo existente (plano B em D2); a NF menor que o saldo do PC foi confirmada em 23/10/2026 (NF 67988, D20). O modo `converter` da trava de unidade (D15) teve o próprio teste em PROD em 25/10/2026 (T073, NF 19252 × PC 308) e foi ligado no mesmo dia (T074).

**2. Religar a chave com imagem antiga reabre o problema.** A chave é a mesma da 016 por decisão do usuário. O risco operacional (ligar antes do deploy da 017) fica no quickstart e no runbook de deploy, e não em código.

**3. Correção preventiva de leitores, sem a função de trânsito.** Cockpit e pendências fiscais só ficariam errados com PC recebido em parte, que hoje não existe; a correção entra nesta feature porque a Rev 1.5 passou a manter esses PCs na cópia. A função de trânsito da 0037 também usa a quantidade cheia, mas fica fora: é PL/pgSQL que escreve em tabela de domínio (desvio herdado ao Princípio III), e corrigi-la ali reforçaria o desvio. Vai para um card próprio, que a leva para TypeScript.

**4. Sem entrada só na ACXE.** A compra nacional da ACXE entra sempre nas duas empresas. Quando chega fisicamente a Extrema, o local é o 21.1 EXTREMA, espelhado, para que vendas possa vender pela Q2P. O 21.2 EXTREMA (NACIONAL), só da ACXE, não é usado. Decidido em 21/10/2026, sem pendência para a Fase 2.

**5. Sinal por horas de evento do OMIE, com leitura ao vivo no clique.** Comparar `synced_at` com a conclusão (a ideia da 016) marcaria falso positivo, porque o espelho regrava `synced_at` a cada rodada. O sinal usa `d_alt` + `h_alt` (Brasília) com margem de 2 min, e o clique de NF cujo fiscal o Atlas concluiu lê o recebimento ao vivo para cobrir a janela do espelho (~30 min). A 0060 vai antes da imagem; sem ela o tratamento fica desligado, com erro no log (D21 da 017).
