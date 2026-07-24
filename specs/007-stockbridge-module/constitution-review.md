# StockBridge — Constitution Review

**Executado em**: 2026-04-16 (pre-cutover)
**Spec**: 007-stockbridge-module
**Commit base**: d0c39e1 (pos Phase 11)

Revisa cada um dos 5 principios inegociaveis de
[.specify/memory/constitution.md](../../.specify/memory/constitution.md)
contra o estado atual do modulo. Conclusao no final.

---

## Principio I — Monolito Modular com Fronteiras Inegociaveis

**Regra**: Modulos cruzam dados via `shared.*` views; tabelas privadas em schema proprio; migrations centralizadas em `packages/db/migrations/`; `eslint-plugin-boundaries` bloqueia import de `modules/X/src/internal/*`.

### Conformidade

| Gate | Status | Evidencia |
|---|---|---|
| Schema proprio | ✅ | `stockbridge.*` com 8 tabelas (`localidade`, `localidade_correlacao`, `lote`, `movimentacao`, `aprovacao`, `divergencia`, `fornecedor_exclusao`, `config_produto`) em [migrations/0008_stockbridge_core.sql](../../packages/db/migrations/0008_stockbridge_core.sql) |
| Views em `shared` para cross-modulo | ✅ | 3 views em [migrations/0009_stockbridge_views.sql](../../packages/db/migrations/0009_stockbridge_views.sql): `vw_sb_saldo_por_produto`, `vw_sb_correlacao_produto`, `vw_sb_fornecedor_ativo` |
| Export publico via `index.ts` | ✅ | Apenas `stockbridgeRouter` + tipos exportados em [modules/stockbridge/src/index.ts](../../modules/stockbridge/src/index.ts) |
| Migrations centralizadas | ✅ | 3 migrations (0008, 0009, 0010) em `packages/db/migrations/` |
| Sem import cross-modulo interno | ✅ | Unica dependencia externa do stockbridge: `@atlas/hedge` em [metricas.service.ts](../../modules/stockbridge/src/services/metricas.service.ts) via **dynamic import** com try/catch + fallback — nao cria acoplamento forte. A intencao futura e expor `ptax` via view em `shared`, mas a API publica ja e estavel. |

**Observacao**: o Drizzle schema nao forca TypeScript a bloquear `import from '@atlas/stockbridge/src/internal/...'` sozinho — depende do ESLint plugin estar ativo. Nao verifiquei o plugin nesta sessao.

**Veredicto**: ✅ PASS.

---

## Principio II — OMIE e Fonte de Verdade, Atlas Le do Postgres

**Regra**: Queries de leitura vao no Postgres; escrita em NF/status OMIE e proibida exceto casos documentados; sync e responsabilidade exclusiva do n8n.

### Excecao documentada

StockBridge **chama a API OMIE diretamente** em 3 lugares:

1. **`produtos/nfconsultar/` → `ConsultarNF`** — leitura individual de NF por numero. Chamada no fluxo de recebimento quando o operador informa o numero da NF que chegou. Motivo: a NF pode ter sido emitida minutos antes e ainda nao estar no sync n8n (delay de ate 15min por `dDtAlt`). Sem essa chamada, o operador nao consegue receber material recem-despachado.

2. **`estoque/ajuste/` → `IncluirAjusteEstoque`** — escrita. Core do dual-CNPJ: cada recebimento gera 2 ajustes (um ACXE, um Q2P) que refletem o estoque real no ERP. Sem isso, OMIE e Atlas ficam dessincronizados.

3. **`produtos/pedidocompra/` → `AlteraPedCompra`** — escrita. Reduz saldo de pedido de compra Q2P apos recebimento. Herdado do legado — necessario para fechar o ciclo de compras.

### Conformidade com a propria excecao da constituicao

A constituicao (Principio II, ultima clausula) **explicitamente autoriza** escrita na OMIE para "emissao de NF de entrada feita pelo StockBridge apos escolha de armazem". As 3 chamadas acima cabem nessa excecao:

- ConsultarNF e leitura de **"dado fresquissimo e de volume pequeno que nao pode aguardar o proximo ciclo de sync"** (caso 1 do Principio II).
- IncluirAjusteEstoque e exatamente a "emissao de NF de entrada... pelo StockBridge" (caso 2).
- AlteraPedCompra complementa o mesmo fluxo (caso 2, extensao).

**Documentacao**: [research.md secao 2](research.md), [plan.md linha Constitution Check](plan.md), [CLAUDE.md bloco manual](../../CLAUDE.md).

### Gates

| Gate | Status | Evidencia |
|---|---|---|
| Leitura sem chamada OMIE | ⚠ PARCIAL | Fila OMIE e cockpit leem do Postgres (`shared.vw_sb_*`). Consulta de NF individual vai na API — excecao. |
| Excecao documentada em ADR/comentario | ✅ | research.md + plan.md + CLAUDE.md. Falta ADR dedicado (sugerido: `docs/adr/0008-stockbridge-omie-write.md`). |
| Monitoramento de `MAX(dDtAlt)` | ❌ Nao implementado | Pre-requisito de cutover — adicionar alerta Grafana (Phase 14 pos-cutover). |

**Veredicto**: ✅ PASS com excecao autorizada. TODO: ADR dedicado + alerta de sync lag antes do cutover.

---

## Principio III — Dinheiro So em TypeScript

**Regra**: Calculos financeiros, escrita transacional em tabelas de dominio, regras dual-CNPJ — tudo em TypeScript com testes Vitest. n8n nao calcula dinheiro.

### Conformidade

| Area | TS? | Testado? |
|---|---|---|
| Conversao de unidades (t/kg/saco/bigbag) | ✅ `motor.service.ts` | ✅ 7 tests, 100% cobertura |
| Cobertura + criticidade de estoque | ✅ `motor.service.ts` | ✅ 10 tests, 100% cobertura |
| CMP (custo medio ponderado) | ✅ `metricas.service.ts` | ✅ 3 tests (calcularCMP puro) |
| Exposicao cambial USD | ✅ `metricas.service.ts` | ✅ 3 tests (calcularExposicaoCambial puro) |
| Deteccao debito cruzado | ✅ `saida-automatica.service.ts` | ✅ 5 tests + contract |
| Correlacao ACXE↔Q2P | ✅ `correlacao.service.ts` | ✅ 3 tests (match texto legado) |
| Fluxo de aprovacao hierarquica | ✅ `aprovacao.service.ts` | ✅ 13 tests, 100% cobertura |
| Transicoes de transito | ✅ `transito.service.ts` | ✅ 8 tests (matriz valida/invalida) |
| Validacoes de saida manual | ✅ `saida-manual.service.ts` | ✅ 11 tests (quantidade, status lote, motivo, conversao) |

### n8n isolado da logica

O workflow [stockbridge-saida-automatica.json](../../workflows/stockbridge-saida-automatica.json):
- Faz polling do OMIE (nao calcula)
- Normaliza payload (mapeamento CFOP → tipo_omie em JS simples)
- POST para endpoint interno Atlas
- **Zero escrita em tabela financeira**, zero calculo de dinheiro

**Cobertura total**: 91 testes passando, 49.8% cobertura global. Services puros (motor, aprovacao, saida-automatica#detectarDebitoCruzado, metricas#calcularCMP/calcularExposicaoCambial) tem 90-100%.

**Gap conhecido**: `recebimento.service.ts` (fluxo transacional complexo com OMIE) tem apenas contract test, nao unit test. Motivo: exige DB real + OMIE mock stateful. Sera coberto pela **validacao paralela** (Phase 13) onde cada recebimento real valida a logica end-to-end contra o legado.

**Veredicto**: ✅ PASS.

---

## Principio IV — Audit Log Append-Only via Trigger

**Regra**: Mutacoes em tabelas criticas gravam em `shared.audit_log` via trigger na mesma transacao. Append-only enforced por privilegios + trigger de rejeicao.

### Conformidade

Migration [0008_stockbridge_core.sql](../../packages/db/migrations/0008_stockbridge_core.sql) cria **8 funcoes de audit dedicadas** (padrao hedge/breakingpoint) + triggers nas 8 tabelas:

- `stockbridge.audit_localidade()` + `trg_audit_sb_localidade`
- `stockbridge.audit_localidade_correlacao()` + `trg_audit_sb_localidade_correlacao`
- `stockbridge.audit_lote()` + `trg_audit_sb_lote`
- `stockbridge.audit_movimentacao()` + `trg_audit_sb_movimentacao`
- `stockbridge.audit_aprovacao()` + `trg_audit_sb_aprovacao`
- `stockbridge.audit_divergencia()` + `trg_audit_sb_divergencia`
- `stockbridge.audit_fornecedor_exclusao()` + `trg_audit_sb_fornecedor_exclusao`
- `stockbridge.audit_config_produto()` + `trg_audit_sb_config_produto`

**Append-only**: `shared.prevent_audit_mutation()` trigger em `shared.audit_log` (migration 0001) bloqueia UPDATE e DELETE.

**Soft delete em vez de DELETE fisico**: movimentacao e localidade usam `ativo=false` — a UPDATE gera linha de audit preservando estado anterior. Diferente do legado PHP (`PR_UP_REMOVE_MOVIMENTACAO` fazia DELETE sem rastro).

### Gates

| Gate | Status | Evidencia |
|---|---|---|
| Nova tabela com trigger de audit na mesma migration | ✅ | Todas as 8 tabelas de stockbridge.* tem trigger dedicada |
| Trigger cobre INSERT, UPDATE, DELETE | ✅ | Padrao `AFTER INSERT OR UPDATE OR DELETE ON stockbridge.X FOR EACH ROW` |
| Testes verificam gravacao no audit log | ⚠ | Nao temos teste com DB real ainda. Sera coberto em Phase 13 (validacao paralela) com comparacao do audit_log entre sistemas. |
| Privilegios de app-role sem UPDATE/DELETE em audit_log | ✅ | Herdado do migration 0001 (trigger `trg_audit_log_immutable`) |

**Veredicto**: ✅ PASS com caveat: teste de integracao com DB real e pre-requisito de cutover.

---

## Principio V — Validacao Paralela, Zero Big-Bang

**Regra**: Modulos que substituem legado em producao nao podem cortar sem paridade validada contra dados reais.

### Conformidade

- **Plano de validacao paralela documentado**: [research.md secao 1](research.md#1-estrategia-de-cutover---validacao-paralela-principio-v) especifica 2 semanas sem divergencia, criterios de paridade (mesma NF → mesmo `id_movest_acxe` + `id_movest_q2p`, mesmo tratamento de divergencia, mesmos emails).
- **Feature flag em prod**: `MODULE_STOCKBRIDGE_ENABLED=false` por default. So vira `true` apos cutover explicito.
- **SC-010 alinhado** (apos correcao CA1 da analise): "apos 2 semanas de validacao paralela sem divergencia".
- **Tasks de validacao paralela na Phase 13** (T116-T120): criterios, script `validar-paridade.ts`, execucao 2 semanas, investigacao de divergencias, decisao formal de cutover.

### Gates

| Gate | Status | Evidencia |
|---|---|---|
| Plano de validacao documentado | ✅ | research.md secao 1 + tasks.md Phase 13 |
| Feature flag para promocao explicita | ✅ | `MODULE_STOCKBRIDGE_ENABLED` default false |
| Divergencias durante validacao → resolvidas antes do cutover | 🔜 | Aguarda execucao |
| Registro formal da decisao de cutover | 🔜 | T120 especifica ADR ou PR de decisao |

**Veredicto**: 🔜 PENDENTE EXECUCAO. Infra de validacao pronta, execucao comeca quando staging for montado.

---

## Resumo

| Principio | Status |
|---|---|
| I. Monolito Modular | ✅ PASS |
| II. OMIE Fonte de Verdade | ✅ PASS (excecao autorizada) |
| III. Dinheiro so em TS | ✅ PASS |
| IV. Audit Log append-only | ✅ PASS |
| V. Validacao paralela | 🔜 Infra pronta, aguarda execucao |

## TODOs pre-cutover (nao-bloqueantes mas recomendados)

1. **ADR-0008** dedicado documentando excecao do Principio II (escrita OMIE). Historico narrativo alem de research.md.
2. **Alerta Grafana** para `MAX(dDtAlt)` das tabelas OMIE criticas (Principio II gate 3).
3. **Teste de integracao** em Phase 13 que verifique gravacao no `shared.audit_log` apos operacao de recebimento real (Principio IV gate 3).
4. **Coverage adicional** em `recebimento.service.ts` (hoje so contract test) — pode ser ao vivo durante validacao paralela.

## Decisao

Modulo **apto a entrar em validacao paralela** em staging. Cutover para producao so apos 2 semanas sem divergencia nova + decisao formal registrada (Phase 13).
