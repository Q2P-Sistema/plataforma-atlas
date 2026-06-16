# Implementation Plan: Posição Fiscal via Mapa NF Mãe/Filhote

**Branch**: `010-fiscal-nf-mapa` | **Date**: 2026-06-10 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/010-fiscal-nf-mapa/spec.md`

## Summary

Adicionar ao cockpit StockBridge a capacidade de calcular a posição fiscal pendente de importação usando o mapeamento explícito NF mãe → NF filhotes. A lógica atual usa CFOP 3.xxx como proxy e nunca fecha o gap quando containers chegam; a nova lógica usa `n_id_receb > 0` nas filhotes (fonte de verdade OMIE) como critério de recebimento. Pedidos sem mapa continuam com o comportamento atual (fallback) durante a transição.

**Confirmação Comex (10/06/2026)**: Todo pedido sempre emite ≥1 filhote. NF mãe tem flag "não gera estoque" e nunca recebe `n_id_receb > 0`. Desativação do mapa depende exclusivamente das filhotes.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, Node.js 20 LTS  
**Primary Dependencies**: Express 4, Drizzle ORM, Zod, `@atlas/core` (getPool, createLogger)  
**Storage**: PostgreSQL 16 — novas tabelas em `stockbridge.*`; leitura de `public."tbl_nf_header_ACXE"`, `public."tbl_pedidosCompras_ACXE"`  
**Testing**: Vitest (apenas se explicitamente solicitado — não solicitado nesta spec)  
**Target Platform**: Linux server (Docker Swarm DigitalOcean)  
**Project Type**: Módulo interno do monólito Atlas — extensão do módulo `stockbridge`  
**Performance Goals**: < 200 pedidos ativos simultâneos; cockpit deve responder dentro do SLA padrão do sistema  
**Constraints**: Zero mudança na interface frontend; migration idempotente; fallback retrocompatível  
**Scale/Scope**: < 200 registros em `nf_pedido_mapa`, até 12 filhotes por pedido

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Princípio | Status | Observação |
|-----------|--------|------------|
| **I. Monólito Modular** | ✅ PASS | Novas tabelas em `stockbridge.*`; código em `modules/stockbridge/src/`; migration em `packages/db/migrations/`; sem import de caminhos internos de outros módulos |
| **II. OMIE é Fonte de Verdade** | ✅ PASS | Nenhuma escrita no OMIE; leitura de `n_id_receb` via Postgres (sync n8n); Atlas não seta status de NF manualmente |
| **III. Dinheiro Só em TypeScript** | ✅ PASS | Cálculo de posição fiscal permanece em `cockpit.service.ts` (TypeScript); n8n faz upsert via HTTP endpoint Atlas com validação Zod — não escreve SQL direto |
| **IV. Audit Log Append-Only** | ✅ PASS | Triggers de auditoria em ambas as novas tabelas → `shared.audit_log` na mesma migration |
| **V. Validação Paralela** | ✅ N/A | Não substitui sistema legado; é feature nova no Atlas (não existe no PHP antigo) |

## Project Structure

### Documentation (this feature)

```text
specs/010-fiscal-nf-mapa/
├── plan.md              # Este arquivo
├── research.md          # Decisões técnicas
├── data-model.md        # Entidades e relacionamentos
└── tasks.md             # Gerado por /speckit.tasks
```

### Source Code (repository root)

```text
packages/db/
├── migrations/
│   └── 0039_stockbridge_nf_pedido_mapa.sql   # NOVO — tabelas + índices + audit triggers
└── src/schemas/
    └── stockbridge.ts                          # MODIFICAR — adicionar nfPedidoMapa, nfPedidoFilhote

modules/stockbridge/src/
├── services/
│   ├── nf-pedido-mapa.service.ts              # NOVO — upsertNfPedidoMapa, listNfPedidoMapa
│   └── cockpit.service.ts                     # MODIFICAR — substituir CTE fiscal_pend_importacao
└── routes/
    ├── nf-pedido-mapa.routes.ts               # NOVO — POST + GET /admin/nf-pedido-mapa
    └── stockbridge.routes.ts                  # MODIFICAR — registrar novo router
```

**Structure Decision**: Extensão do módulo `stockbridge` existente — sem novo projeto, sem nova pasta de módulo. Segue o padrão estabelecido pelas migrations 0036–0038 e serviços existentes.

---

## Phase 0: Research Decisions

Registradas em [research.md](./research.md).

---

## Phase 1: Implementation Design

### Migration 0039 — `packages/db/migrations/0039_stockbridge_nf_pedido_mapa.sql`

```sql
-- Tabela 1: um row por pedido ativo
CREATE TABLE IF NOT EXISTS stockbridge.nf_pedido_mapa (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_acxe_omie varchar(50) NOT NULL,
    nf_mae           varchar(50) NOT NULL,
    ativo            boolean     NOT NULL DEFAULT true,
    importado_em     timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS nf_pedido_mapa_pedido_idx
    ON stockbridge.nf_pedido_mapa (pedido_acxe_omie) WHERE ativo = true;
CREATE INDEX IF NOT EXISTS nf_pedido_mapa_nf_mae_idx
    ON stockbridge.nf_pedido_mapa (nf_mae);

-- Tabela 2: filhotes por pedido (1–12)
CREATE TABLE IF NOT EXISTS stockbridge.nf_pedido_filhote (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    mapa_id    uuid        NOT NULL REFERENCES stockbridge.nf_pedido_mapa(id),
    nf_filhote varchar(50) NOT NULL,
    posicao    smallint    NOT NULL,
    ativo      boolean     NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nf_pedido_filhote_mapa_idx
    ON stockbridge.nf_pedido_filhote (mapa_id);
CREATE INDEX IF NOT EXISTS nf_pedido_filhote_nf_idx
    ON stockbridge.nf_pedido_filhote (nf_filhote);
```

Triggers: padrão `stockbridge.audit_[tabela]()` → `shared.audit_log` (igual migration 0038).

### Drizzle Schema — `packages/db/src/schemas/stockbridge.ts`

Adicionar após as definições existentes:

```typescript
export const nfPedidoMapa = stockbridgeSchema.table('nf_pedido_mapa', {
  id: uuid('id').defaultRandom().primaryKey(),
  pedidoAcxeOmie: varchar('pedido_acxe_omie', { length: 50 }).notNull(),
  nfMae: varchar('nf_mae', { length: 50 }).notNull(),
  ativo: boolean('ativo').notNull().default(true),
  importadoEm: timestamp('importado_em', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const nfPedidoFilhote = stockbridgeSchema.table('nf_pedido_filhote', {
  id: uuid('id').defaultRandom().primaryKey(),
  mapaId: uuid('mapa_id').notNull().references(() => nfPedidoMapa.id),
  nfFilhote: varchar('nf_filhote', { length: 50 }).notNull(),
  posicao: smallint('posicao').notNull(),
  ativo: boolean('ativo').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type NfPedidoMapa = typeof nfPedidoMapa.$inferSelect;
export type NfPedidoFilhote = typeof nfPedidoFilhote.$inferSelect;
```

### Service — `modules/stockbridge/src/services/nf-pedido-mapa.service.ts`

Função `upsertNfPedidoMapa(items)` em transação SERIALIZABLE:
- Para cada item: upsert em `nf_pedido_mapa` por `pedido_acxe_omie` (partial unique index)
- Soft-delete filhotes antigas do pedido (`ativo = false`)
- INSERT filhotes novas com `posicao` 1-N
- Retorna `{ inseridos, atualizados }`

Função `listNfPedidoMapa()` para validação (gestor+):
- `SELECT ... WHERE mapa.ativo = true` com contagem de filhotes ativas

### Cockpit CTE — `modules/stockbridge/src/services/cockpit.service.ts`

> ⚠️ **SUPERSEDED (2026-06-16 — ver § Amendment)**: o SQL abaixo é o desenho original e **não reflete** o estado atual. Foi corrigido por: LPAD nf_filhote/nf_mae (T026/T028), Fix 1 (recebida = 3 fontes), Fix 2 (fallback exclui filhote) e Fix 3 (Parte A conta saldo). Use a seção **Amendment 2026-06-16** como referência da lógica vigente.

Substituir o CTE `fiscal_pend_importacao` (linhas 293-309) por:

```sql
fiscal_pend_importacao AS (
  -- Parte A: pedidos COM mapa (filhote sempre presente — NF mãe nunca tem n_id_receb > 0)
  SELECT pc.ncodprod AS produto_codigo_acxe, SUM(pc.nqtde)::numeric AS pendente_importacao_kg
  FROM stockbridge.nf_pedido_mapa mapa
  JOIN public."tbl_pedidosCompras_ACXE" pc ON pc.cnumero = mapa.pedido_acxe_omie
  WHERE mapa.ativo = true AND pc.nqtde > 0
    AND $4::bool = true
    AND (
      NOT EXISTS (
        SELECT 1 FROM stockbridge.nf_pedido_filhote f
        WHERE f.mapa_id = mapa.id AND f.ativo = true
      )
      OR
      EXISTS (
        SELECT 1 FROM stockbridge.nf_pedido_filhote f
        LEFT JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = f.nf_filhote
        WHERE f.mapa_id = mapa.id AND f.ativo = true
          AND (h.n_id_nf IS NULL OR h.n_id_receb = 0 OR h.n_id_receb IS NULL)
      )
    )
  GROUP BY pc.ncodprod

  UNION ALL

  -- Parte B: pedidos SEM mapa — fallback CFOP 3.xxx (retrocompatibilidade)
  SELECT i.n_cod_prod AS produto_codigo_acxe, SUM(i.q_com)::numeric AS pendente_importacao_kg
  FROM public."tbl_nf_header_ACXE" h
  JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
  WHERE $4::bool = true
    AND h.tp_nf = 0
    AND LEFT(i.cfop, 1) = '3'
    AND h.d_emi >= $3::date
    AND NOT EXISTS (
      SELECT 1 FROM stockbridge.movimentacao m
      WHERE m.ativo = true AND m.subtipo = 'importacao' AND m.nota_fiscal = h.n_nf
    )
    AND NOT EXISTS (
      SELECT 1 FROM stockbridge.nf_pedido_mapa mapa
      WHERE mapa.nf_mae = h.n_nf AND mapa.ativo = true
    )
  GROUP BY i.n_cod_prod
)
```

### Rotas — `modules/stockbridge/src/routes/nf-pedido-mapa.routes.ts`

```typescript
POST /admin/nf-pedido-mapa  — requirePerfil('gestor') — upsertNfPedidoMapa
GET  /admin/nf-pedido-mapa  — requirePerfil('gestor') — listNfPedidoMapa
```

Registrar em `modules/stockbridge/src/routes/stockbridge.routes.ts`.

### Spec Corrections (✅ aplicadas em 2026-06-10)

| Seção | Correção |
|-------|---------|
| US1 Scenario 3 | Remover — "NF mãe recebida" é impossível |
| US2 Scenario 3 | Corrigir texto — 1 container sempre tem filhote |
| Edge Case | Remover bullet "Pedido sem filhotes (apenas NF mãe)" |
| NF Mãe entity | Adicionar: "designada para 21.1 Extrema, não gera estoque, nunca n_id_receb > 0" |
| NF Filhote entity | Atualizar: "sempre ≥1, 90.0.2 TRANSITO, gera estoque" |
| FR-003 | Simplificar: remover cláusula "sem filhotes → checar NF mãe" |
| Clarifications Q2 | Remover "(pedido sem filhotes: quando NF mãe for recebida)" |
| Assumptions | Adicionar: "Todo pedido tem sempre ≥1 filhote (Comex 10/06/2026)" |

---

## Known Limitations

### Auto-desativação do mapa (`mapa.ativo` eventual)

A flag `mapa.ativo` é atualizada para `false` apenas quando `upsertNfPedidoMapa` é chamado (ex: n8n FUP roda e re-envia o pedido). Entre execuções do n8n, se as filhotes forem recebidas no OMIE sem que haja novo upsert, `ativo` permanece `true` mesmo que o pedido esteja completamente recebido.

**Impacto no cockpit**: **nulo** — a Parte A do CTE consulta `n_id_receb` ao vivo via LEFT JOIN; mapa com `ativo=true` mas todas filhotes recebidas não aparece como pendente (condição `EXISTS (... n_id_receb = 0)` retorna false).

**Impacto na listagem GET**: o mapa aparece como ativo mesmo concluído — aceitável para < 200 pedidos.

**Decisão**: limitação aceita para v1. Se necessário no futuro, adicionar endpoint `/admin/nf-pedido-mapa/reconciliar` chamado pelo n8n após ciclo de sync OMIE.

---

## Verification

1. Aplicar migration: `psql "$DATABASE_URL" -f packages/db/migrations/0039_stockbridge_nf_pedido_mapa.sql`
2. Popular mapa via POST: `curl -X POST http://localhost:3000/api/v1/stockbridge/admin/nf-pedido-mapa -H "Content-Type: application/json" -d '[{"pedido":"PED-001","nf_mae":"00004625","nf_filhotes":["00004626","00004627"]}]'`
3. Consultar cockpit: `totalFiscalPendenteImportacaoKg` deve cair para pedidos com todas filhotes recebidas
4. Re-enviar mesmo payload — contagem de registros deve permanecer igual (idempotência)
5. Consultar audit log: `SELECT * FROM shared.audit_log WHERE table_name = 'nf_pedido_mapa' ORDER BY created_at DESC`

---

## Amendment 2026-06-16 — Correções de cálculo (Fix 1/2/3) + Aba "Pendências Fiscais" (ACXEGDP-183)

US1–US3 + migration 0039 (acima) estão **implementadas e em UAT**. Esta emenda cobre as correções descobertas em UAT/prod e a nova aba de diagnóstico (US4). Escopo aprovado: **só importação**, aba **somente leitura**.

### Resumo das mudanças
- **Fix 1** *(em UAT — commits `d59cb77`→`917f7e1`)*: "filhote recebida" = `n_id_receb>0` **OU** `movimentacao`(subtipo=importacao) **OU** `movimentacao_legado`. **Supera a Decision 3** original do research.
- **Fix 2** *(em UAT — commits `945ea8e`→`173f78c`)*: fallback CFOP 3.xxx exclui **mãe E filhote** de mapa ativo (anti dupla contagem A+B).
- **Fix 3** *(a implementar)*: Parte A conta o **saldo** (`pc.nqtde − Σ q_com das filhotes já recebidas`, com piso 0), não o pedido inteiro. **Supera parcialmente a Decision 2**.
- **Aba Pendências Fiscais** *(US4, a implementar)*: visão de detalhe read-only com aging (exoneração + filhotes) e sinal de inconsistência "chegou — NF aberta".

### Technical Context (delta)
- **Frontend agora em escopo**: nova página React em `apps/web` (a feature original era "zero frontend"; FR-008 revisado). Segue o padrão hand-rolled Tailwind de `DivergenciasPage.tsx` — `apps/web` não usa shadcn (desvio **pré-existente** do projeto vs. constituição; não introduzido aqui).
- **Novo endpoint read-only**: `GET /api/v1/stockbridge/pendencias-fiscais` (gestor+).
- **Sem nova tabela / sem migration**: a aba é visão derivada sobre tabelas existentes + `d_emi` das NFs (aging). Aging derivado, não persistido.

### Constitution Check (re-avaliação pós-emenda)
| Princípio | Status | Observação |
|---|---|---|
| I. Monólito Modular | ✅ PASS | Página em `apps/web`, endpoint em `modules/stockbridge`; sem import cross-módulo |
| II. OMIE é fonte de verdade | ✅ PASS | Aba 100% leitura; nenhuma escrita OMIE; lê `d_emi`/`n_id_receb` do Postgres |
| III. Dinheiro só em TS | ✅ PASS | Cálculo de saldo (Fix 3) e aging em services TS; n8n não envolvido |
| IV. Audit log | ✅ N/A | Sem mutação (read-only) e sem nova tabela — nada a auditar |
| V. Validação paralela | ✅ N/A | Entrega via UAT antes de prod; `main` não tocada nesta fase |

### Phase 1 Design (delta)

**Fix 3 — `modules/stockbridge/src/services/cockpit.service.ts` (Parte A)**: substituir a lógica binária por saldo —
`GREATEST(pc.nqtde − COALESCE(Σ q_com das filhotes recebidas por (mapa_id, ncodprod), 0), 0)`. "Recebida" = OR de 3 fontes (Fix 1), idêntica em todos os pontos (FR-013). Parte B e GROUP BY externo intactos. Validado em UAT: Parte A 1.094.000 → **939.250 kg**.

**Novo — `pendencias-fiscais.service.ts` + `pendencias-fiscais.routes.ts`** (`GET`, `requireGestor`; registrar em `stockbridge.routes.ts`). Retorno `PendenciasFiscaisData`:
- `pedidos[]`: `pedidoAcxeOmie`, `nfMae`, produto(s), `qtdePedidoKg`, `recebidoKg`, `saldoPendenteKg`, `statusAgregado`; `filhotes[]` (`nfFilhote`, `posicao`, `qtdeKg`, `recebida`, `fonteRecebimento`, `nfEmitida`, `diasDesdeEmissao`); `exoneracao` (`dataEntrada` = `d_emi` da NF mãe, `diasEmExoneracao`); `estagioFup`, `loteEmTransito`, `inconsistencia` (FR-015: ≥1 filhote com NF emitida não recebida E pedido fora do trânsito).
- `semMapa[]`: Parte B detalhada (NF, produto, kg, CFOP, `d_emi`).
- `resumo`: totais.
- 4 queries `getPool()` (detalhe por filhote; qtde pedido; FUP/lote; Parte B), montadas em TS; `Number()` em BIGINT. Aging = `hoje − d_emi`; faixas configuráveis (default lead time).

**Frontend — `apps/web/src/pages/stockbridge/gestor/PendenciasFiscaisPage.tsx`**: molde `DivergenciasPage` (useApiFetch + useQuery, `fmtKg`/`fmtData`, filtros toggle); agrupado por pedido (expandível); badges status + **inconsistência** + faixas de **aging**; seções **exoneração** e **importação sem mapa**; toggle `incluir_metricas`. Registrar rota + item de menu em `apps/web/src/App.tsx` (roles `['gestor','diretor']`).

### Verification (delta)
1. Build `tsc` (`@atlas/stockbridge`) + build `apps/web`.
2. UAT (`mcp pg-acxe-uat`): Parte A nova = 939.250; importação ~1.015.000; pedidos 455/485 com `inconsistencia=true`; exoneração lista pedidos com `diasEmExoneracao`; aging por filhote (`diasDesdeEmissao`).
3. Coerência cockpit ↔ aba (Σ saldo + sem-mapa ≈ `fiscalPendenteImportacaoKg`).
4. Entrega: commit na `010` + cherry-pick na `uat`. Tarefas detalhadas em `tasks-pendencias-fiscais.md` (T029+, geradas por `/speckit.tasks`).
