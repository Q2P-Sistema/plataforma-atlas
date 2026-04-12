# Análise dos Vibecodes — Referência para /speckit-specify

**Data:** 2026-04-12
**Fonte:** `legacy/vibecodes/` — ativos do chefe (vibecoding) + sistema PHP em produção
**Objetivo:** servir de insumo ao `/speckit-specify` de cada módulo, mapeando regras de negócio preserváveis, frontend de referência, conflitos com a constituição Atlas, e estimativas de esforço.

---

## Inventário Geral

| Módulo | Arquivos | Estado | Tipo de ativo |
|---|---|---|---|
| **Hedge Engine** | 56 | Backend JS funcional (dev, mock-validado) | Código + spec + frontend HTML |
| **StockBridge** | 269 | **Sistema PHP em produção há 2+ anos** + pacote vibecoding | Código PHP produção + spec + frontend JSX |
| **ComexFlow** | 23 | Backend Node scaffolded (stubs) + frontend React completo | MVP vibecoded + planilha Excel operacional real |
| **Forecast Planner** | 3 | Frontend JSX completo (2955 linhas) + doc integração | Concept vibecoded |
| **Breaking Point** | — | Frontend JSX (888 linhas) dentro de `pacote-plataforma` | Concept vibecoded |
| **C-Level Dashboard** | — | Frontend JSX (1431 linhas) dentro de `pacote-plataforma` | Concept vibecoded |
| **ComexInsight** | 0 | Vazio — conceito no handoff, sem código | Spec textual no handoff |
| **Pacote Plataforma** | 12 | Landing page JSX + `plataforma.pdf` (5MB) + schema SQL sanitizado | Documento master do chefe |

---

## 1. HEDGE ENGINE

**Localização:** `legacy/vibecodes/hedge/`

### 1.1 Arquitetura atual

Backend Node.js + Express (porta 3005), dois pools Postgres (local hedge_engine + VPS remoto read-only), Redis pra cache, cron job via node-cron. Frontend vanilla JS em HTML monolítico (7000+ linhas). Sem testes.

### 1.2 Regras de negócio — PRESERVAR INTEGRALMENTE

#### Motor de Mínima Variância (MV) — `motor.service.js`

**Três camadas de hedge:**
- **L1 (Automático):** 60% base. Se estoque não-pago >50%, aumenta até min(60+8, 90).
- **L2 (Tático):** λ × 25 (proporcional à aversão a risco).
- **L3 (Aberto):** 100% − L1 − L2 (gap intencional não-hedgeado).

**Recomendação por bucket:**
- Input: bucket (mês, pagar_usd, est_nao_pago_usd, ndf_usd, dias_ate_vencimento).
- Output: targets L1/L2/L3, gap_l1, cobertura_pct, instrumento NDF, status, prioridade.

**Mapeamento prazo → instrumento:**
```
≤35 dias  → NDF 30d (ou Trava cambial se <15 dias)
≤70 dias  → NDF 60d
≤100 dias → NDF 90d
≤150 dias → NDF 120d
>150 dias → NDF 180d
```

**Thresholds de alerta:**
- Gap ≥ 1.000.000 USD → `critico`
- Gap 500.000–1M → `alta`
- Gap > 0 → `media`

**Custo NDF:** `notional_usd × (taxa_ndf − ptax_spot)` (usa `decimal.js` pra precisão).

**Simulação de margem:** cenário câmbio 4.5–7.5, overhead fixo 10%, fórmula:
```
custo_sem_hedge = vol_usd × cambio
custo_com_hedge = vol_usd × ndf_taxa × (1 − pct_aberto) + vol_usd × cambio × pct_aberto
margem = (faturamento − custo − outros_custos) / faturamento × 100
```

**% estoque não-pago:** `total_pagar_brl / est_importado_brl × 100` (cap 100%).

#### PTAX — `bcb.service.js`
- Fonte: `api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados` (série 1 = USD/BRL venda).
- Cache Redis 15 min, persistência em `ptax_historico`.
- Validação sanity: rejeita PTAX fora de [3.00, 10.00] e gera alerta crítico.
- Variação 30d calculada.

#### Soft-archive de títulos — `omie.service.js`
- Compara omie_ids do BD com registros locais status='aberto'.
- Títulos que sumiram do OMIE → status='arquivado', updated_at=NOW().
- Nunca deleta fisicamente.

#### Sync consolidação — `omie.service.js`
- 9 queries paralelas via Promise.allSettled (títulos pagar ACXE, NFs entrada ACXE, estoque ACXE, pedidos compra ACXE, importações ACXE, títulos receber Q2P, NFs saída Q2P, estoque Q2P, pedidos venda Q2P).
- Lookback: 90 dias (configurável).
- Audit trail em `sync_log`.

### 1.3 Data model (schema.sql — 10 tabelas)

| Tabela | Finalidade | PK |
|---|---|---|
| `posicao_snapshot` | Posição FX consolidada diária | UUID |
| `bucket_mensal` | Exposição por mês de vencimento | UUID |
| `ndf_registro` | Contratos NDF (pendente→ativo→liquidado) | UUID |
| `ndf_taxas` | Taxas de mercado NDF por prazo | UUID, UNIQUE(data_ref, prazo_dias) |
| `ptax_historico` | Histórico PTAX oficial | data_ref (PK) |
| `titulos_pagar` | Títulos individuais do OMIE | UUID, UNIQUE(omie_id) |
| `estoque_snapshot` | Snapshot de estoque por localidade | UUID |
| `alerta` | Alertas gerados pelo sistema | UUID |
| `sync_log` | Audit trail de sincronizações | UUID |
| `localidade_omie` | Locais de estoque descobertos | UUID, UNIQUE(localidade) |

Todos com UUID v4, indexes em data_ref DESC, bucket_mes, vencimento, status.

### 1.4 API surface (14 endpoints)

**Públicos (sem auth):**
- `GET /api/posicao` — posição consolidada (cache 5min, roda motor in-memory)
- `GET /api/posicao/buckets` — buckets do último snapshot
- `GET /api/estoque` — estoque filtrado por localidades
- `GET /api/estoque/localidades` — lista de depósitos
- `GET /api/ptax` — PTAX atual + histórico
- `GET /api/ptax/atual` — só PTAX mais recente
- `GET /api/motor` — motor com params overridáveis via query (?lambda=0.65)
- `POST /api/motor/simular` — simulação de margem (nunca grava no BD)
- `GET /api/alertas` — alertas não resolvidos

**Protegidos (x-api-key):**
- `POST /api/ndf` — registrar novo NDF
- `GET /api/ndf` — listar NDFs por status
- `GET /api/ndf/taxas` / `PUT /api/ndf/taxas` — consultar/atualizar taxas
- `PATCH /api/ndf/:id/liquidar` — liquidar NDF (state machine: ativo→liquidado)
- `POST /api/sync/agora` — sync manual (debounce 60s)
- `GET /api/sync/log` — histórico de syncs
- `GET /api/parametros` / `PUT /api/parametros` — config do motor
- `PATCH /api/alertas/:id/lido` / `PATCH /api/alertas/:id/resolver`

### 1.5 Frontend (5 páginas)

| Página | Componente React alvo | Conteúdo |
|---|---|---|
| **Posição** | `<PositionDashboard>` | 5 KPIs + filtro depósitos + tabela buckets + donut + PTAX line + buckets bar + margem sensitivity |
| **Estoque** | `<InventoryPage>` | Filtro localidades + KPIs (marítimo/aduaneiro/ACXE/Q2P/total) + waterfall estados + depot grid + pago/não-pago pie |
| **Motor MV** | `<MotorMVPage>` | **4 sliders** (λ, câmbio, NDF 90d, %não-pago) com recálculo real-time + 3 cards camada + tabela recomendações + approval queue |
| **Alertas** | `<AlertsPage>` | Lista alertas com mark read/resolver + histórico |
| **Config** | `<ConfigPage>` | Status BD/BCB + taxas NDF editáveis + parâmetros operacionais/motor |

**Design tokens:** `--acxe=#0077cc`, `--q2p=#1a9944`, `--warn=#d97706`, `--crit=#dc2626`, `--ndf=#7c3aed`. Fontes: Syne + Inconsolata.

### 1.6 Classificação para migração Atlas

| Categoria | Componente | Esforço |
|---|---|---|
| **Preserva (port direto TS)** | motor.service, bcb.service, decimal utils, validação, schema SQL | ~5h |
| **Adapta (refactor)** | data.service → Drizzle queries, routes → TS thin, config → tabela DB | ~10h |
| **Move pra n8n** | sync.job (cron), sincronizarTudo (orquestração), soft-archive (endpoint) | ~4h |
| **Reescreve** | Frontend (7000 linhas → React 5 páginas), auth (x-api-key → cookies), cache (padronizar) | ~30h |
| **Descarta** | internal.service (HTTP entre módulos), vps-pool (segundo pool), docker/compose, CLAUDE.md/TECH_STACK antigos | — |
| **Adiciona** | Testes Vitest, audit log triggers, Zod schemas, OpenAPI | ~10h |
| **Total estimado** | | **~60h** |

### 1.7 Conflitos com constituição Atlas

- x-api-key entre módulos → descartado (Princípio I)
- Cron in-process → migra pra n8n (ADR-0006)
- Dois pools Postgres → pool único, lê do BD sincronizado por n8n (ADR-0007)
- Zero testes → obrigatório (Princípio III)
- Config em JSON file → tabela Postgres
- Sem audit log trigger → adicionar (Princípio IV)
- Frontend vanilla → React + shadcn + Tailwind

### 1.8 Valores hardcoded a migrar pra config

- `lambda=0.65`, `camada1_minima=60`, `desvio_padrao_brl=3.76`
- Taxas NDF (30d–180d)
- `PTAX_MIN=3.00`, `PTAX_MAX=10.00`
- Thresholds alerta (1M, 500K)
- `outros_custos=10%` na simulação de margem
- TTLs cache (900s PTAX, 300s posição, 3600s estoque)
- Lookback 90 dias

---

## 2. STOCKBRIDGE

**Localização:** `legacy/vibecodes/stockbridge/`

### 2.1 Dois ativos distintos

1. **"StockBridge Pacote/"** — vibecoding do chefe: spec .docx, frontend JSX v5, diagrama HTML, README.
2. **"versão que já está em produção e funcionando/"** — sistema PHP real rodando há 2+ anos. **Este é o ativo mais precioso do projeto inteiro.**

### 2.2 Arquitetura do sistema PHP em produção

MVC customizado em PHP puro (sem framework):
- **Entry point:** `index.php` → `security.php` (JWT check em toda request).
- **Routing:** `MainController.callFunction()` via `call_user_func_array` — request JSON `{endpoint, params}`.
- **Módulos:** `estoqueACXE`, `notafiscal` (recebimento + movimentação), `login`.
- **BD:** MySQL via PDO, ~20 stored procedures.
- **OMIE:** `ApiOmie.php` — wrapper curl com credenciais dual (ACXE + Q2P).
- **Email:** `SendgridMailer.php` (Sendgrid API + SMTP fallback).
- **Frontend:** AngularJS 1.x + Bootstrap 5 + jQuery + DataTables.
- **Auth:** JWT HS256 em cookie HttpOnly (4h expiry), refresh token em BD.

### 2.3 Regras de negócio — PRESERVAR INTEGRALMENTE

#### Recebimento de nota fiscal (NotaFiscalService — 20+ métodos)

Fluxo principal:
1. Operador informa número da NF.
2. Sistema consulta OMIE API (`ConsultarNF`) → retorna dados da NF (produto, qtd, valor, fornecedor, armazém).
3. Verifica se NF já foi processada (`PR_VERIFICA_NOTA_PROCESSADA`).
4. Verifica se produto existe no estoque Q2P (`PR_VERIFICA_PRODUTO_ESTOQUE_EXISTE_Q2P`).
5. Operador indica se há divergência.

**Sem divergência:**
- Ajuste de estoque ACXE via OMIE API: `IncluirAjusteEstoque` (origem="AJU", tipo="TRF").
- Ajuste de estoque Q2P via OMIE API: `IncluirAjusteEstoque` (origem="AJU", tipo="ENT").
- Registra movimentação em BD local.

**Com divergência — 5 variantes:**
1. **Faltando** — quantidade recebida < esperada → rota pra armazém "ACXE-COMEX-FALTANDO".
2. **Varredura** — sobra/diferença → rota pra armazém "Varredura".
3. **Varredura → Extrema** — após varredura, rota pra armazém EXTREMA.
4. **Varredura → Não-Extrema** — após varredura, rota pra outro armazém designado.
5. Cada variante tem método ACXE + Q2P correspondente.

**Cálculo de custo unitário com imposto de importação:**
```
vTx_Nacionaliza = 14.50%
vUnCom_Total = ceil((vNF / qtd + vNF / qtd × 0.145) × 100) / 100
```

**Regra dual-CNPJ:**
- Todo recebimento gera movimentação em AMBAS as empresas (ACXE + Q2P).
- ACXE: tipo="TRF" (transferência), motivo="TRF".
- Q2P: tipo="ENT" (entrada), motivo="INI".
- Produto é identificado pelo `codigo_local_estoque` que mapeia pra códigos distintos em cada empresa.

**Email de notificação:**
- Produto não encontrado → email admin com dados da NF.
- Recebimento com sucesso → email confirmação.

#### Movimentações (ListaMovimentacaoService)
- Listagem paginada via stored procedure `PR_SE_MOVIMENTACAO_PAGINACAO`.
- Soft-delete de movimentação (`PR_UP_REMOVE_MOVIMENTACAO`).

#### Estoque ACXE (EstoqueACXEService)
- Listagem paginada de armazéns via `PR_SE_TB_ESTOQUE_LOCAL_ACXE_PAGINACAO`.

### 2.4 Data model (MySQL — 20+ stored procedures)

**Tabelas inferidas:**
- `tb_usuarios` (id_user, user_name, user_email, pass)
- `tb_refresh_tokens` (id_user, refreshToken, refreshTokenExpiration)
- `tb_estoque_local_acxe` (codigo_local_estoque, codigo_acxe, descricao_acxe)
- `tb_movimentacao` (id_movimentacao, id_movest, id_ajuste, nota_fiscal, id_user, status)
- `tb_notafiscal_processada` (nNF)
- `tb_tp_divergencia` (id, descricao)
- `tb_comex_controle_compra_venda` (id, nQtde)
- `tb_log` (mensagem, pagina, funcao, endpoint, id_user, ip_address, data_hora)

**Atenção:** sistema usa **MySQL**, não Postgres. Na migração pra Atlas, as stored procedures precisam virar queries Drizzle em Postgres. A lógica dentro das procs precisa ser extraída e portada pra TypeScript.

### 2.5 API surface

Request pattern unificado: `POST /app/module/{modulo}/controllers/{Controller}.php` com body `{endpoint, params}`.

**LoginController:** `apiLogin(email, pass)`.
**EstoqueACXEController:** `apiCarregarEstoquesACXEPaginacao(current_page, per_page, total_rows)`.
**NotaFiscalController:** `apiConsultaNotaFiscal(inputNumberNF)`, `apiNotaFiscalRecebimento(retorno_api, form_recebimento, tipo_divergencia)`, `apiCarregarEstoquesACXESelect()`, `apiCarregarTipoDivergenciaSelect()`.
**ListaMovimentacaoController:** `apiRemoveMovimentacao(movimentacao, pagination)`, `apiCarregaPaginacao(current_page, per_page, total_rows)`.

### 2.6 Frontend (AngularJS 1.x + Bootstrap 5)

| View | Conteúdo |
|---|---|
| **Login** | Email + password, JWT em cookie |
| **Home** | Dashboard placeholder |
| **Nota Fiscal (Recebimento)** | 2 estágios: (1) busca NF por número, (2) formulário recebimento com opção divergência |
| **Movimentações** | Lista paginada (50/100/200/400/600 por página) com delete |
| **Estoque ACXE** | Lista paginada de armazéns |

**UX patterns:** modais confirm, toasts (success/warning/error/info), loading spinner, paginação parametrizável, validação inline (ng-required, ng-pattern).

### 2.7 Vibecoding do chefe (StockBridge Pacote)

`StockBridge_v5_Source.jsx` — frontend React 18 com 5 funcionalidades-alvo:
1. **Produtos** — cadastro unificado ACXE+Q2P com sinônimos.
2. **Lotes** — rastreio por lote (NF entrada, origem, DI, armazém, status).
3. **Trânsito** — 4 fases (aguardando_booking → em_aguas → transito_local → pescado) com 3 localidades virtuais.
4. **Perfis** — controle de acesso por role (operador, gestor, admin).
5. **Tipos de divergência** — cadastro dos tipos (faltando, sobrando, avariado, etc.).

**O JSX do chefe adiciona funcionalidades que o PHP em produção NÃO tem** (lotes, trânsito, sinônimos). A spec do Atlas precisa UNIR ambos: lógica de recebimento/divergência do PHP real + funcionalidades novas do JSX.

### 2.8 Classificação para migração Atlas

| Categoria | Componente | Esforço |
|---|---|---|
| **Preserva (regras de negócio pra TS)** | Recebimento NF com 5 variantes divergência, cálculo custo nacionalização (14.5%), dual-CNPJ, tipos de movimento, soft-delete | ~15h |
| **Porta (MySQL → Postgres/Drizzle)** | 20+ stored procedures → queries Drizzle. Lógica dentro das procs vira TypeScript | ~10h |
| **Reescreve** | Frontend Angular 1.x → React + shadcn. Incorpora funcionalidades novas do JSX (lotes, trânsito, sinônimos) | ~40h |
| **Adapta** | Auth JWT PHP → packages/auth do Atlas (cookie httpOnly, RBAC) | ~3h |
| **Move pra n8n** | Email (SendGrid) via n8n notification routing | ~1h |
| **Adiciona** | Testes Vitest (recebimento + divergências), audit log triggers, Zod schemas | ~12h |
| **Total estimado** | | **~80h** |

### 2.9 Pontos críticos da migração

1. **MySQL → Postgres:** o sistema atual roda em MySQL (PDO). Atlas é Postgres. Stored procedures precisam ser redesenhadas como queries Drizzle.
2. **OMIE API calls no PHP:** o PHP chama OMIE diretamente pra ajustar estoque. No Atlas, isso continua como exceção (ADR-0007) — StockBridge é o único módulo que ESCREVE no OMIE.
3. **Lógica de divergência:** 5 variantes de recebimento com routing diferente pra armazéns. É a lógica de negócio mais complexa do projeto inteiro. Precisa de testes intensivos.
4. **Dual-CNPJ:** todo recebimento gera 2 movimentações (ACXE + Q2P). Erro aqui gera divergência fiscal real.
5. **Validação paralela** (Princípio V): o PHP continua rodando enquanto a versão TS é validada. Comparação de outputs (NFs processadas, movimentações criadas, estoques ajustados).

---

## 3. COMEXFLOW

**Localização:** `legacy/vibecodes/comexflow/`

### 3.1 Dois ativos distintos

1. **comexflow-dev/** — MVP vibecoded Node.js + React. Backend scaffolded (stubs), frontend completo (2132 linhas).
2. **"FUP - ACXE Rev 1.10.1"** — planilha Excel (.xlsm, 2.7MB) usada HOJE pra controle real do comex. **Não pode ser lida pelo agente de IA — Flavio precisa me guiar no conteúdo.**

### 3.2 Modelo de 14 fases

O ComexFlow organiza importações em 14 fases sequenciais, agrupadas em 4 grupos:

| Grupo | Fases | Descrição |
|---|---|---|
| **Pré-Embarque** | 1–5 | Proforma → PO → Booking → Docs → Embarque |
| **Trânsito** | 6–10 | Em águas → Rastreio → Draft BL → BL Final → Chegada |
| **Desembaraço** | 11–12 | Processo DI → Liberação aduaneira |
| **Recebimento** | 13–14 | Conferência → Estoque (fecha processo) |

**Ações por fase** (PHASE_ACTIONS): cada fase tem 2–3 ações específicas. Ex:
- Fase 1: "Validar Proforma", "Rejeitar"
- Fase 5: "Confirmar Booking", "Acionar Freight Forwarder", "Alertar LSD"
- Fase 14: "Confirmar Estoque", "Alimentar CRM Q2P", "Fechar Processo"

### 3.3 Regras de negócio

**Status de pagamento é READ-ONLY do OMIE:**
- `contas_pagar.pago` NUNCA é setado manualmente — só via leitura do OMIE `ListarContasPagar`.
- Regra reforçada no schema (comentário no SQL) e no código.

**Anomalias por benchmark de origem:**
```
CN (China): 35 dias  |  IN (Índia): 28 dias  |  KR (Coreia): 40 dias
EG (Egito): 18 dias  |  US (EUA): 20 dias    |  DE (Alemanha): 22 dias
```
Desvio do benchmark → anomalia (booking_atrasado, transito_longo, draft_atrasado, aprovacao_lenta, desembaraco_lento, lsd_vencido).

**Severidade:** critical / warning / info.

**Status de conta por vencimento:**
- Vencido (vermelho): dias < 0
- Crítico (vermelho): dias ≤ 3
- Atenção (âmbar): dias ≤ 7
- Aberto (âmbar): dias > 7
- OK (verde): pago=true

**Audit log append-only** com 6 categorias: system, action, anomalia, critico, navegacao, proforma.

### 3.4 Data model (schema.sql — 3 tabelas)

| Tabela | Finalidade |
|---|---|
| `importacoes` | PK `id` tipo "IMP-YYYY-NNN", campos: fornecedor, produto, quantidade_kg, valor_usd, origem, navio, bl, eta, etd, lsd, fase_atual (1–14), operador, omie_order |
| `contas_pagar` | FK→importacoes.id, omie_lancamento, tipo, moeda (USD/BRL), valor, vencimento, pago (READ-ONLY OMIE), dt_pagamento |
| `audit_log` | Append-only, sem UPDATE/DELETE. Categorias: system/action/anomalia/critico/navegacao/proforma |

### 3.5 Frontend (React — 12 subcomponentes)

| Componente | Função |
|---|---|
| **KpiBar** | 6 métricas (operações ativas, em trânsito, críticos, contas OMIE semáforo, portfólio USD, USD/BRL) |
| **KanbanView** | 4 colunas (Pré-Embarque / Trânsito / Desembaraço / Recebimento) |
| **KanbanCard** | Card mini por importação com badges anomalia |
| **DetailPanel** | Sidebar 400px com tabs Timeline + Contas |
| **TimelineView** | Eventos cronológicos por fase |
| **ContasView** | Tabela de contas com status OMIE read-only |
| **FlowInfographic** | Análise 3 fases com seletor de métrica (ton/usd/brl/count) |
| **InfographicView** | Dashboard anomalias: KPIs + radar hex + distribuição por fase + scorecard operador |
| **ListView** | Tabela sortável com menu de ações inline |
| **ActionMenu** | Modal com ações por fase (14 × 2-3 ações cada) |
| **AuditView** | Browser filtável do audit log |
| **ExportModal** | Export JSON/CSV com scope selecionável |

**Design system:** fundo escuro `#060c18` (operacional), accent `#60a5fa`, fontes Syne + IBM Plex Mono.

### 3.6 Planilha Excel (FUP - ACXE Rev 1.10.1)

**Arquivo:** `FUP - ACXE Rev 1.10.1 - planilha usada atualmente para controle do comex.xlsm` (2.7MB).
**Status:** em uso TODAY. Controla toda a operação comex (logística + financeiro).
**Importância:** fonte de verdade operacional real. O ComexFlow MVP foi desenhado pra substituí-la.
**Ação necessária:** Flavio precisa guiar o agente pelo conteúdo da planilha (abas, colunas, fórmulas) pra extrair regras de negócio que não estão no código.

### 3.7 Classificação para migração Atlas

| Categoria | Componente | Esforço |
|---|---|---|
| **Preserva** | 14 fases, anomalias/benchmarks, status conta, actions por fase, audit log, read-only OMIE | Regras diretas |
| **Implementa backend** | Todos os routes são stubs — CRUD real precisa ser escrito | ~20h |
| **Adapta frontend** | 2132 linhas React inline → componentes separados TS + shadcn + Tailwind | ~15h |
| **Move pra n8n** | Sync OMIE contas, BullMQ job planejado | ~3h |
| **Integra** | Fase 10 ↔ Hedge (localidades trânsito), Fase 14 ↔ StockBridge (recebimento) | ~5h |
| **Total estimado** | | **~45h** |

### 3.8 Relação com outros módulos

- **ComexFlow → Hedge:** fase 10 (em trânsito) atualiza localidade virtual do Hedge.
- **ComexFlow → StockBridge:** fase 14 (recebido) dispara recebimento no StockBridge.
- **ComexFlow → ComexInsight:** ComexInsight é a camada analítica sobre o ComexFlow (tendências, gargalos).
- **ComexFlow → Forecast:** fase 14 alimenta projeção de chegada de estoque.
- **ComexFlow ← OMIE:** read-only sync de contas a pagar por importação.

---

## 4. FORECAST PLANNER

**Localização:** `legacy/vibecodes/forecast/`

### 4.1 Ativo

`forecast-planner.jsx` (2955 linhas) — frontend React completo com dados mock. Sem backend. Doc de integração `integracao-forecast-planner.md`.

### 4.2 Regras de negócio

**5 famílias de produto:** PP Injetado, PP Sopro, Ráfia, PEAD, Poliestireno.

**Sazonalidade:** array de 12 índices mensais (média=1.0) por família. Padrões distintos:
- PP Injetado/Sopro: pico H2 (embalagem, utilidades domésticas).
- Ráfia: duplo pico (safra abr-jul, embalagem out-nov).
- PEAD: estável com spike construção/bebidas (mar-mai, jun-ago).

**Cálculo de demanda diária:**
```
demanda_diaria = (vendas_anuais / 365) × (1 + variacao_AA) × indice_sazonal_mes
```

**Projeção 120 dias rolling** com carry-over de pedidos de compra em trânsito.

**Detecção de ruptura:**
- Dia em que estoque chega a zero.
- Criticidade: <30d=crítico, 30-60d=atenção, >60d=ok.

**Quantidade sugerida de compra:**
```
qtd = demanda para (lead_time + 60 dias) − pedidos pendentes
arredondado para MOQ (25t internacional | 12t spot doméstico)
```

**Data de pedido:**
```
data_pedido = dia_ruptura − lead_time − buffer_dias (default 10)
```

**Compra local de emergência:**
- Disparada quando deadline internacional já passou.
- Cobre dias de gap a custo local (`custo_estoque_medio` BRL/kg).

**Scoring de janela de importação (Comex Insight mock):**
- Scores por variância histórica de preço, match sazonal, alinhamento lead time, custo logístico.
- Recomenda melhor mês pra comprar + data ideal de pedido.

### 4.3 Frontend (5 abas)

| Aba | Conteúdo |
|---|---|
| **Dashboard** | 7 KPIs (estoque, timeline ruptura, compras urgentes, famílias críticas, valor a comprar) |
| **Urgência** | Tabela expandível por família com previsão de ruptura + recomendação de compra |
| **Demanda** | Histórico 24 meses + projeção 6 meses por família com YoY e sparklines |
| **Shopping List** | Lista de compras gerada com scoring comex, lead time override, alertas convergência |
| **Insights** | Calendário comex (análise custo mensal), tabela oportunidades com scoring |

**Design system:** paleta quente creme/areia (`#e4e7e0`, `#f2f4ef`), accent blue `#2563eb`, fontes DM Sans + Fraunces.

### 4.4 Integração com OMIE
- `tbl_produtos_Q2P` → código, descrição, família, lead time.
- `tbl_posicaoEstoque_Q2P` → estoque por localidade (físico, reservado, pendente — 3 camadas).
- `movestoque` OMIE → vendas 12 meses por SKU.
- Pedidos de compra → pipeline de chegada.

### 4.5 Classificação para migração Atlas

| Categoria | Esforço |
|---|---|
| Backend a criar (zero existe) — services de cálculo de demanda, ruptura, sugestão de compra, scoring | ~20h |
| Frontend adaptar (JSX → TS + shadcn + Tailwind, separar componentes) | ~15h |
| Testes Vitest (sazonalidade, ruptura, MOQ) | ~5h |
| Integração com dados OMIE via BD (views shared) | ~3h |
| **Total estimado** | **~45h** |

---

## 5. BREAKING POINT

**Localização:** `legacy/vibecodes/pacote-plataforma-acxe-q2p/pacote/` (dentro do breaking-point-claude.jsx embutido no pacote plataforma)

### 5.1 Ativo

Frontend JSX (888 linhas) com simulação de stress test de caixa 26 semanas.

### 5.2 Regras de negócio

**Motor próprio (NÃO é OMIE):**
- Simula 26 semanas (180 dias) de fluxo de caixa.
- Inputs: saldo CC, duplicatas total, antecipação (taxa/limite por banco), FINIMP (saldo/limite), pagamentos semanais, estoque.

**4 breakpoints rastreados:**
1. **Saldo CC negativo** (caixa quebra).
2. **Antecipação esgotada** (disponível < R$200k).
3. **Gap total de liquidez** (receitas + caixa < obrigações).
4. **Trava FINIMP** (duplicatas bloqueadas > 60% das livres).

**Regras de cálculo:**
- Markup estoque D+15: 18% por semana se expectativa de venda em 15 dias.
- Buffer reserve: 20% dos pagamentos semanais retido por segurança.
- FINIMP bloqueia 40% das duplicatas como garantia.
- Cap. compras = caixa − 20% reserva.

**5 bancos rastreados:** Bradesco, Itaú, Santander, BTG, Sicoob — cada um com antecipação (limite/usado/taxa), FINIMP (limite/usado/garantiaPct), cheque especial (limite/usado).

### 5.3 Frontend (4 abas)

| Aba | Conteúdo |
|---|---|
| **Gráfico** | 4 countdown boxes + 6 KPIs + ComposedChart 26 semanas (áreas/barras/linhas) + chart FINIMP×Duplicatas |
| **Tabela** | 26 linhas semanais com semana/data/tipo/pagamento/saldo CC/cap antecip/cap compras/FINIMP/dup bloq/gap/status |
| **Estrutura Bancária** | 5 cards de banco com limites editáveis (antecipação/FINIMP/cheque) |
| **Limites** | Breakdown por banco com totais |

### 5.4 Classificação para migração Atlas

| Categoria | Esforço |
|---|---|
| Backend a criar — motor de simulação 26 semanas em TS | ~15h |
| Frontend adaptar (JSX → TS + shadcn + Tailwind) | ~10h |
| Integração com dados OMIE via BD (contas CC, duplicatas, FINIMP) | ~5h |
| Testes Vitest (motor de simulação) | ~5h |
| **Total estimado** | **~35h** |

---

## 6. C-LEVEL DASHBOARD

**Localização:** `legacy/vibecodes/pacote-plataforma-acxe-q2p/pacote/` (dashboard-clevel embutido)

### 6.1 Ativo

Frontend JSX (1431 linhas) com 5 abas de visão executiva.

### 6.2 Regras de negócio

**Modelo duas empresas:** Acxe (importadora, exposição USD) + Q2P (distribuidora, BRL puro).

**Toggle intercompany:** elimina vendas Acxe→Q2P pra visão consolidada real.

**Dois estados cambiais (regra central):**
- **Título ABERTO:** fornecedor exterior, OMIE armazena em BRL. Hedge reconstrói USD original = BRL / PTAX_data_emissão. Mark-to-market com PTAX live.
- **Título LIQUIDADO:** câmbio fixado no pagamento. BRL é final. Sem risco FX.

**DRE automática:**
```
Receita (vendas, excl. remessas CFOP 5.9xx/6.9xx)
− CMV (custo médio × qtde vendida)
= Lucro Bruto
− Despesas Operacionais (folha, aluguel, logística, TI, admin)
= EBITDA (target floor 15%)
− Despesas Financeiras
+ Impacto Câmbio (só Acxe)
+ Resultado Hedge (NDFs/Travas, só Acxe)
= Resultado Líquido
```

**CMC landed cost (Acxe):**
- OMIE ncmc (FOB + II, IPI, PIS/COFINS, ICMS) + adders (frete intl, seguro, AFRMM, despachante, armazenagem, handling).
- Rateio mensal: `cmc_import_real = ncmc_omie + despesas_import / kg_chegados`.

**16 índices de crédito** em 5 grupos (Liquidez, Rentabilidade, Endividamento, Eficiência, Cobertura) com faixas de cor (green/yellow/red). Guia de apresentação bancária incluído.

**Capital de giro:** DSO, DIO, DPO, CCC (ciclo de conversão de caixa).

### 6.3 Frontend (5 abas)

| Aba | Conteúdo |
|---|---|
| **Diretor** | Semáforo KPIs + DRE 6 meses + sensibilidade câmbio×margem + top 10 clientes + top fornecedores + capital de giro + 16 índices |
| **Operação** | Posição cambial + localidades estoque + buckets mensais + NDFs + alertas |
| **Configurar** | Seletor empresa + clientes/fornecedores ativos + toggle intercompany |
| **Report** | Layout imprimível (capa + KPIs + DRE + 3 gráficos 12m + clientes + exposição) |
| **Q2P** | Mesma estrutura sem colunas FX (Q2P opera em BRL puro) |

### 6.4 Classificação para migração Atlas

| Categoria | Esforço |
|---|---|
| Backend a criar — DRE engine, CMC landed cost, 16 índices, sensibilidade FX | ~25h |
| Frontend adaptar (JSX → TS + shadcn + Tailwind) | ~15h |
| Integração com todos os outros módulos via views shared | ~8h |
| Testes Vitest (DRE, índices, intercompany elimination) | ~5h |
| **Total estimado** | **~55h** |

**Nota:** C-Level é o último módulo na ordem de migração porque depende de TODOS os outros estarem estáveis (Hedge pra posição cambial, StockBridge pra estoque, Breaking Point pra liquidez, ComexFlow/Insight pra pipeline).

---

## 7. COMEXINSIGHT

**Sem código.** Conceito descrito no handoff:
- Rastreador marítimo de cargas.
- Dono das 3 localidades virtuais de trânsito (aguardando_booking, em_aguas, transito_local).
- 14 fases (compartilha com ComexFlow — ComexInsight é a camada analítica).
- Integração AIS/Marine Traffic (fase 2, decisão D7 em aberto).
- **Estimativa de esforço:** ~40-50h quando chegar a vez dele na fila.

---

## 8. PACOTE PLATAFORMA (plataforma.pdf)

**Localização:** `legacy/vibecodes/pacote-plataforma-acxe-q2p/`

- `plataforma.pdf` (5MB) — "Plano Master de Implementação" do chefe. Fonte de verdade pra data model e regras de negócio. **Confidencial.**
- Landing page JSX (625 linhas) — hub navegacional com KPIs consolidados e config global (seletor empresa, toggle intercompany).
- Schema SQL sanitizado do banco dev_acxe_q2p_sanitizado.
- Docker-compose (Postgres 16 + Redis 7 + Node 3005).
- 4 docs markdown (integração, endpoints, dicionário de campos, CMC landed cost).

**Design system unificado:** paleta quente (#F2EDE4 base), fontes Fraunces + DM Sans, semáforos coloridos (green/amber/orange/red/teal).

---

## Resumo de esforço total estimado

| Módulo | Backend | Frontend | Testes | Integração | Total |
|---|---|---|---|---|---|
| **Hedge** | 15h | 30h | 8h | 7h | **60h** |
| **StockBridge** | 25h | 40h | 12h | 3h | **80h** |
| **ComexFlow** | 20h | 15h | 5h | 5h | **45h** |
| **Forecast** | 20h | 15h | 5h | 3h | **45h** (sem backend hoje) |
| **Breaking Point** | 15h | 10h | 5h | 5h | **35h** |
| **C-Level** | 25h | 15h | 5h | 8h | **55h** |
| **ComexInsight** | 25h | 15h | 5h | 5h | **~50h** (sem código hoje) |
| **Infra Atlas** | 15h | — | — | — | **15h** (Entrega 2 pipeline) |
| **TOTAL** | | | | | **~385h** |

**Nota:** essas estimativas são ballpark baseadas na análise dos vibecodes. O esforço real pode variar conforme complexidade encontrada durante implementação, especialmente no StockBridge (lógica de divergência) e no C-Level (DRE/índices).

---

## Ordem de migração confirmada

1. **Hedge** → mais maduro em dev, port JS→TS, cobaia pras fronteiras
2. **StockBridge** → porte PHP→TS do sistema em produção, validação paralela obrigatória
3. **Forecast** → frontend maduro, backend greenfield
4. **Breaking Point** → motor próprio independente, frontend maduro
5. **ComexFlow + ComexInsight** → juntos ou sequenciais, dependem da planilha Excel
6. **C-Level** → último, depende de todos

---

## Decisões abertas que afetam o speckit-specify

- **D2:** estrutura real do JSONB `categorias` em `tbl_contasPagar_ACXE` — confirmar com query antes de especificar Hedge.
- **D3:** integração DI/Siscomex — afeta ComexInsight e StockBridge.
- **D4:** tolerância de quebra técnica no StockBridge — afeta lógica de divergência.
- **D6:** prioridade débito dual-CNPJ — afeta StockBridge.
- **D7:** AIS/Marine Traffic — afeta ComexInsight (fase 2).
- **Planilha Excel comex:** Flavio precisa guiar revisão das abas/colunas/fórmulas.
- **`plataforma.pdf`:** Flavio precisa disponibilizar ou guiar leitura das seções relevantes.
