# Plataforma ACXE+Q2P — Handoff de Contexto

**Para:** Claude (conversa nova, no repo novo da plataforma)
**De:** Flavio (executor técnico, "o especialista")
**Data do handoff:** 2026-04-11

> **Instrução pra você, Claude-novo:** esse documento é o resumo de uma conversa anterior em outro repo (`sistema_hedge`). Leia inteiro antes de responder. As decisões das seções 2 e 5 estão fechadas; as da seção 9 estão em aberto e você deve me pedir pra confirmar antes de implementar.

---

## 1. Quem sou eu e o que é o projeto

Sou Flavio. Executor técnico da **Plataforma ACXE+Q2P**. Meu chefe é dono da empresa e gera direção de produto via "vibecoding" (conversa com LLM) — não tem convicção arquitetural forte, queria ver "uma cara" de cada módulo e por isso produziu 7 documentos/esboços separados, um por sistema.

A plataforma consolida **7 módulos internos + 1 CRM externo**, todos operando em cima do mesmo banco PostgreSQL `dev_acxe_q2p_sanitizado` (28 tabelas OMIE já sincronizadas). **O ERP OMIE é fonte de verdade** — nenhum módulo escreve status de NF ou contas manualmente.

Este repo novo existe porque decidimos consolidar o que era planejado como 7 microserviços em um **monólito modular** num monorepo. Ver seção 2.

---

## 2. Decisão arquitetural — FECHADA

**Monólito modular em monorepo. NÃO microserviços.**

### Por quê

- O banco é compartilhado entre todos. Isso mata o principal benefício de microserviços (isolamento de dados) e deixa só o custo.
- Equipe pequena (basicamente eu executando).
- Domínios fortemente entrelaçados: Hedge, StockBridge, Breaking Point, C-Level, ComexInsight, ComexFlow — todos leem dados de estoque/financeiro do mesmo BD.
- CRM é externo (outra empresa contratada) → naturalmente fica fora do monólito como integração HTTP.
- O plano original do chefe (PDF "Plataforma ACXE+Q2P — Plano de Implementação", abril 2026) tinha sintomas clássicos de dor de microserviço: conflito de porta entre serviços (D1), polling OMIE multiplicado (D5), fallback gracioso obrigatório com "valores demo" quando outro serviço cai, x-api-key entre módulos que moram na mesma VPS. Tudo isso some em monólito.

### Chefe aceita a mudança

Ele não tem apego a microserviços — só queria ver cada módulo funcionando isolado. Preciso apresentar uma proposta curta defendendo o reempacotamento. Ver seção 10, passo 5.

### Regras de fronteira que seguram a disciplina do monólito

- **Módulos só se importam via `index.ts` público.** Proibido importar de `modules/X/internal/*` a partir de outro módulo.
- Enforcement via lint rule (ex: `eslint-plugin-boundaries`). Não é opcional — é o que segura a arquitetura.
- **Módulos compartilham BD apenas via views** publicadas em schema `shared`. Tabelas privadas de cada módulo ficam em schema próprio (`hedge`, `stockbridge`, `comex`, etc). Nunca ler tabelas cruas de outro módulo.
- Um único `packages/db/migrations/` — sem inferno de ordem entre módulos.
- Se um módulo um dia precisar escalar sozinho (ex: Hedge batendo câmbio em tempo real), extrai *ele* depois. Começar monólito e extrair é fácil. O contrário é brutal.

---

## 3. Tooling recomendado (confirmar comigo)

- **Monorepo**: pnpm workspaces + Turborepo. (Nx é overkill pra onde estamos.)
- **Linguagem**: TypeScript. O hedge atual é JS — converte durante a migração. **← confirmar**
- **Runtime**: Node.js 20 (já definido no plano do chefe)
- **Backend**: Express
- **BD**: PostgreSQL 16 + Redis 7
- **Frontend**: precisa definir framework único pro shell. Hedge atual é HTML/JS puro; Breaking Point e ComexFlow têm `.jsx` prontos. Sugestão: **React 18**. **← confirmar**
- **Nome do repo**: sugestões `acxe-platform`, `q2p-platform`, `acxe-suite`. **← confirmar**

---

## 4. Estrutura-alvo do monorepo

```
acxe-platform/
├── docs/
│   ├── architecture.md
│   ├── data-model.md
│   ├── roadmap.md
│   └── adr/
├── packages/            # reutilizável, sem estado
│   ├── core/            # db pool, logger, config
│   ├── auth/            # JWT + roles (operador/gestor/diretor)
│   ├── ui/              # design system React
│   ├── db/              # migrations + contratos de views
│   └── integrations/
│       ├── omie/        # cliente OMIE único (polling, sync incremental por dDtAlt)
│       └── bcb/         # PTAX
├── modules/             # domínio — 7 módulos
│   ├── hedge/
│   ├── stockbridge/
│   ├── breakingpoint/
│   ├── clevel/
│   ├── comexinsight/
│   ├── comexflow/
│   └── forecast/
├── apps/
│   ├── api/             # backend único — monta todos os módulos
│   └── web/             # frontend único (shell + rotas por módulo)
└── integrations/
    └── crm/             # cliente HTTP pro CRM externo
```

**Distinção importante**:
- `packages/` = reutilizável, sem estado, sem regra de negócio
- `modules/` = domínio, com regras, expõe serviços via `index.ts`
- `apps/` = o que sobe em produção, importa de `modules/` e `packages/`

---

## 5. Os 7 módulos internos + CRM externo

| # | Módulo | Porta original (irrelevante agora) | Responsabilidade | Ativos do vibecoding |
|---|---|---|---|---|
| 1 | **Hedge Engine** | :3005 | Motor hedge cambial USD/BRL (Motor MV), buckets, NDFs, mark-to-market | Backend Node.js implementado, frontend HTML pronto, spec `hedge-engine-docs-v2.docx`, `migration_001.sql` |
| 2 | **StockBridge** | :3006/:3007 (conflito) | Controle físico de estoque — lotes, dual-CNPJ, fase "pescado" | Spec `StockBridge_Backend_Spec.docx` (schema + 25 itens de checklist) |
| 3 | **Breaking Point** | :3004 | Projeção de liquidez BRL 26 semanas, FINIMP, antecipação | Frontend `breaking-point-claude.jsx` pronto, backend pendente |
| 4 | **C-Level Dashboard** | — | Saúde financeira global (DRE, FX sensitivity, intercompany elim) | Agregador, consome dos outros. Não implementado. |
| 5 | **ComexInsight** | :3003 | Rastreador marítimo, 14 fases, dono das 3 localidades virtuais de trânsito | Não implementado, só concept |
| 6 | **ComexFlow** | :3006 | Gestão ciclo de vida de importações, Kanban 14 fases | Frontend `comexflow-mvp.jsx` pronto, backend pendente, spec `ComexFlow_Documentacao_Tecnica_v1.docx` |
| 7 | **Forecast Planner** | :3002 | Pedidos planejados, lead times, sazonalidade | Não implementado |
| — | **CRM Q2P** | :3001 | Gestão clientes, recebíveis, pipeline | **EXTERNO** — outra empresa contratada. Fica fora do monorepo. Integração HTTP com x-api-key. |

**Inventário completo dos arquivos** → eu (Flavio) vou trazer num branch ou zip quando a gente começar. Inclui: `migration_001.sql`, `backend/server.js`, `backend/services/{bcb,omie,motor}.service.js`, `backend/routes/` (5 arquivos), `backend/jobs/sync.job.js`, `backend/config/`, `backend/db/init.js`, `docker-compose.yml`, `.env.example`, os `.jsx` de frontend, os `.docx` de spec.

---

## 6. Regras imutáveis do ecossistema

Vêm do plano master do chefe e valem pra monólito também:

1. **Status de contas a pagar NUNCA é setado manualmente.** Sempre via conciliação OMIE.
2. **Sync OMIE incremental por `dDtAlt`.** Full-refresh proibido em produção.
3. **Audit log append-only.** Nenhum UPDATE/DELETE na tabela de auditoria.
4. **Fallback gracioso pra integrações externas** (OMIE, BCB) — em monólito isso só vale pra externos, não entre módulos.
5. **OMIE é fonte de verdade pra NFs e contas.** Nunca duplicar dados de NF em outro banco.
6. Tema claro padrão (exceto ComexFlow que usa escuro por ser operacional).

---

## 7. Lógicas de negócio críticas (não mudam com a arquitetura)

### 7.1 Identificação de títulos USD (Hedge Engine)

**OMIE não tem campo "moeda".** Tudo em `tbl_contasPagar` está armazenado em BRL.

- Filtro: `tbl_contasPagar_ACXE JOIN tbl_cadastroFornecedoresClientes_ACXE WHERE exterior='S'`
- Status: ABERTO ou ATRASADO (LIQUIDADO = câmbio fechou, sem risco)
- Conversão: `valor_usd = valor_documento ÷ PTAX da data_emissao` (não data atual)
- PTAX: `SELECT ptax FROM ptax_historico WHERE data_ref <= data_emissao ORDER BY data_ref DESC LIMIT 1`
- Mark-to-market: `valor_usd × ptax_atual = exposição real hoje`

Categorias de despesa USD (NET, Financiamento, CIA, CAD) são **apenas informativas** — não são o critério de filtro.

### 7.2 Ciclo de trânsito — 3 localidades virtuais

| status em `carga_transito` | Localidade virtual | Módulo responsável | Risco cambial |
|---|---|---|---|
| `aguardando_booking` | Aguardando Booking | ComexFlow → ComexInsight | Total |
| `em_aguas` | Em Trânsito / Águas | ComexInsight (booking confirmado) | Total |
| `transito_local` | Trânsito Local | ComexInsight (navio atracou) | Total, DI não fechada |
| `pescado` | (sai das virtualidades) | StockBridge escolhe armazém → OMIE emite NF entrada | Câmbio fixado na NF |

**"Pescado" é um evento interno** disparado pela NF de entrada no OMIE, após StockBridge decidir armazém. Não é status visível ao usuário.

### 7.3 Regra Dual-CNPJ (StockBridge)

- Físico creditado no armazém que confirma recebimento
- Fiscal segue CNPJ da NF
- Q2P fatura físico em Acxe → débito físico Acxe + débito fiscal Q2P → divergência controlada
- NF de transferência CFOP 5.152/1.152 baixa a divergência

### 7.4 Ciclo de vida integrado de uma carga

```
Proforma recebida → PO criado (ComexFlow)
  → OMIE cria AP + Hedge abre título USD
Booking confirmado (ComexFlow)
  → ComexInsight inicia rastreamento + Hedge status=em_aguas
BL emitido (ComexInsight)
  → Hedge localidade="Em Trânsito/Águas"
Navio atraca + DI aberta (ComexInsight)
  → Hedge localidade="Trânsito Local" + StockBridge aguarda
StockBridge escolhe armazém
  → OMIE emite NF entrada + Hedge fixa câmbio + sai do trânsito
NF entrada processada
  → StockBridge cria lote + Hedge atualiza posicao_snapshot + ComexFlow fecha processo
```

Em monólito isso vira uma cadeia de chamadas de função dentro do mesmo processo, não HTTP entre serviços.

---

## 8. Data model — resumo

**Banco existente**: `dev_acxe_q2p_sanitizado`, 28 tabelas OMIE. **Não alterar estrutura existente** exceto os ALTERs abaixo.

### Tabelas OMIE mais usadas
- `tbl_produtos_ACXE/Q2P` — cadastro produtos (NCM, família, lead_time, CMC)
- `tbl_posicaoEstoque_ACXE/Q2P` — físico, saldo, ncmc por local
- `tbl_locaisEstoques_ACXE/Q2P` — localidades
- `tbl_contasPagar_ACXE/Q2P` — NFs entrada, categoria JSONB
- `tbl_contasReceber_Q2P` — NFs saída
- `tbl_cadastroFornecedoresClientes_ACXE/Q2P` — tem flag `exterior`
- `tbl_categorias_ACXE/Q2P` — plano de contas, códigos DRE
- `tbl_contasCorrentes_ACXE/Q2P` — bancos

### Tabelas novas a criar (Hedge Engine) — `migration_001.sql` já existe
`localidade_omie · posicao_snapshot · bucket_mensal · titulos_pagar · ndf_registro · ndf_taxas · ptax_historico · alerta · sync_log · banco_limites · config_plataforma · carga_transito`

### Tabelas novas StockBridge
`tbl_lotes_stockbridge · tbl_movimentos_stockbridge · tbl_transito_stockbridge · tbl_usuarios_stockbridge · tbl_sinonimos_produto · tbl_comodatos_stockbridge · tbl_itens_nf`

### ALTER TABLEs em tabelas OMIE
- `tbl_contasCorrentes_*`: `saldo_atual NUMERIC(15,2)`, `saldo_data_ref DATE`
- `tbl_contasReceber_Q2P/*`: `valor_antecipado NUMERIC(15,2)`, `banco_antecip TEXT`
- `tbl_locaisEstoques_*`: `cnpj_vinculado VARCHAR(20)`, `tipo_local VARCHAR(20)` (valores: `proprio` / `3pl` / `porto_seco`)

### Decisão nova do monólito
Módulos leem dados de outros módulos **apenas via views** publicadas em schema `shared`. Cada módulo tem schema próprio pras tabelas privadas.

---

## 9. Decisões em aberto

### Minhas (confirmar comigo na primeira conversa no repo novo)
- TypeScript ou JavaScript? → sugestão: **TS**
- Framework frontend único do shell? → sugestão: **React 18**
- Nome oficial do repo? → sugestões: `acxe-platform` / `q2p-platform` / `acxe-suite`
- Deploy: VPS única ou múltiplas? → define se `apps/api` é um processo ou vários

### Herdadas do plano do chefe (ainda pendentes)
- **D2**: estrutura real do JSONB `categorias` em `tbl_contasPagar_ACXE`. Assumimos `{ cCodCateg, nValorCateg, cDescCateg }` — confirmar com query real antes de codar.
- **D3**: integração DI/Siscomex pra `custo_usd` dos lotes. DI não está no dump OMIE.
- **D4**: limite de tolerância pra quebra técnica sem aprovação no StockBridge.
- **D5**: frequência polling OMIE vs rate limits. **Em monólito, polling único resolve.**
- **D6**: ordem de prioridade no débito cruzado dual-CNPJ quando múltiplos CNPJs têm físico.
- **D7**: integração AIS (Marine Traffic) pro ComexInsight — fase 2.

### Resolvidas pela mudança arquitetural (não existem mais)
- ~~D1 conflito de porta :3006~~ → tudo é um único `apps/api`.
- ~~Fallback gracioso entre serviços internos~~ → são chamadas de função.
- ~~x-api-key entre módulos~~ → só existe pro CRM externo.

---

## 10. Próximos passos (roadmap imediato)

1. **Receber o inventário dos vibecodes** — eu trago os arquivos (branch, zip, ou cópia direta pras pastas certas).
2. **Confirmar as 4 decisões abertas da seção 9.1**.
3. **Gerar estrutura inicial do monorepo**: `package.json` raiz, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint` com `eslint-plugin-boundaries`, pastas vazias conforme seção 4.
4. **Escrever 3 ADRs curtos** em `docs/adr/`:
   - ADR-0001: Monólito modular (usar o "por quê" da seção 2)
   - ADR-0002: Postgres compartilhado via views
   - ADR-0003: CRM como integração externa
5. **Doc curto pro chefe** defendendo o reempacotamento. Foco: **"seu plano continua valendo 95%, só muda a casca"**. Usar mapa de tradução:
   - `backend/routes/` → `modules/hedge/routes/`
   - `backend/services/omie.service.js` → `packages/integrations/omie/` (um só, compartilhado)
   - `backend/services/motor.service.js` → `modules/hedge/services/motor.service.js`
   - `migration_001.sql` → `packages/db/migrations/001_hedge.sql`
   - `POST /api/eventos/fase-atualizada` (HTTP) → `hedgeModule.atualizarFaseTransito(...)` (função)
   - x-api-key interno → some
   - Fallback gracioso entre serviços → some
6. **Sprint 0 revisado**: importar os ativos do vibecoding pro monorepo com mínima mudança.
7. **Ordem de migração dos módulos** (primeiro Hedge porque é o mais maduro e serve de cobaia pra fronteiras):
   `Hedge → StockBridge → Breaking Point → ComexInsight → ComexFlow → Forecast → C-Level`
   C-Level por último porque depende de todos os outros estarem estáveis.
8. **Durante tudo isso, o `sistema_hedge` atual continua rodando em produção.** Zero big-bang. Hedge migra como primeiro módulo, valida em paralelo, só depois desliga o antigo.

---

## 11. Como eu gosto de colaborar (feedback importante)

- **Sou direto. Não quero bajulação.** Se uma ideia minha for ruim, fala. Se uma do chefe for boa, fala também. Pedi explicitamente na conversa anterior: "sem me bajular, preciso que seja sincero".
- Quando eu pergunto arquitetura, quero a análise com prós e contras reais, não "depende". Recomendação + tradeoff principal.
- Não invente soluções pra problemas que não existem. Não abstraia prematuramente.
- Respostas curtas pra perguntas simples, respostas longas só quando o tema merece.
- Chefe vibecoda porque quer "ver uma cara" — **o valor de domínio que ele gera é real** (lógica de títulos USD, dual-CNPJ, ciclo de 14 fases). Preservar isso é obrigatório. Reempacotar é permitido.

---

## 12. Arquivos de referência do repo antigo

No `sistema_hedge` (branch `002-omie-to-internal-db`) existe contexto relevante que não repeti aqui por não ser transferível automaticamente:

- Memória `project_refatoracao_fonte_dados.md` — contexto da refatoração OMIE → BD interno
- Memória `reference_schema_bd_interno.md` — mapeamento detalhado schema BD interno Q2P/Acxe
- Memória `project_validacao_numeros.md` — views criadas, bugs corrigidos no dashboard
- PDF "Plataforma ACXE+Q2P — Plano Master de Implementação" (abril 2026, confidencial) — **é a fonte de verdade pra data model e regras de negócio**. Não descartar, adaptar pra monólito.

Se precisar desses detalhes, eu trago conforme surgirem.

---

**Fim do handoff.** Claude-novo: pode começar perguntando qual é o primeiro passo que eu quero dar. Minha expectativa é começar pela estrutura inicial do monorepo (passo 3 da seção 10) e só depois importar os ativos.
