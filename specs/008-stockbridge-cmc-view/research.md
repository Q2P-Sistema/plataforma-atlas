# Research — StockBridge CMC View (008)

Resolve as decisões abertas da spec e as escolhas de stack. Todos os pontos verificados contra o código real do módulo e os dados em prod (2026-06-08).

## D1 — Arquitetura de dados: ler direto vs. espelhar (decisão deferida na spec)

**Decisão**: **Ler `public."tbl_historico_cmc_estoque"` diretamente** via `getPool()` + SQL bruto, em um novo `cmc.service.ts`. Sem espelhamento, sem migration, sem job de cópia.

**Rationale**:
- É o padrão já estabelecido do módulo: `meu-estoque.service.ts`, `cockpit.service.ts`, `metricas.service.ts` e `saida-manual.service.ts` leem `public."vw_posicaoEstoqueUnificadaFamilia"` e outras tabelas `public.*` direto via `getPool()`. Não há precedente de espelhar OMIE/operacional para schema de módulo.
- Respeita Princípio II (ler do Postgres) e Princípio I (não cria tabela; consumo single-módulo não exige view em `shared`).
- A tabela já existe nos 3 ambientes (prod/UAT nativos; dev via `sync-vendas-prod-to-dev.sh`, já editado) — ver [[projeto-cmc-stockbridge]] e Assumptions da spec.
- Read-only → sem audit (Princípio IV) e sem risco de divergência (Princípio III).

**Alternativas consideradas**:
- *Espelhar para `stockbridge.cmc_snapshot` via job noturno*: rejeitada — duplica dado, adiciona escrita + trigger de audit + migration sem benefício; reintroduz o risco de divergência que a spec quer evitar.
- *Criar view em `shared`*: rejeitada — consumo é de um único módulo; view `shared` é para dado cross-módulo. Adicionaria um objeto de banco (migration) sem necessidade.
- *Criar view de conveniência em `stockbridge.*`*: rejeitada para v1 — a normalização (origem/kg/sem-família) cabe no SQL do service; uma view exigiria migration, contra a diretriz "não criar migration para isto".

## D2 — Controle de acesso (FR-013)

**Decisão**: Proteger todas as rotas de CMC com `requireGestor` (de `modules/stockbridge/src/middleware/role.ts`), que resolve para `requireRole('gestor', 'diretor')`. No menu (`App.tsx`), `roles: ['gestor', 'diretor']`.

**Reconciliação com a spec**: a spec (FR-013) cita "Gestor, Diretor e **Administrador**". O modelo de papéis do Atlas tem **apenas** `'operador' | 'gestor' | 'diretor'` (`packages/db/src/schemas/atlas.ts:25`) — **não existe** role `admin`/`administrador`. Portanto "Administrador" mapeia para o topo da hierarquia (`diretor`). Implementação efetiva: **gestor + diretor**, Operador excluído (intenção da spec preservada). Não é necessária nenhuma mudança de modelo de papéis.

## D3 — Unidade (corrigido na spec via /speckit.clarify)

**Decisão**: Exibir **kg** e **R$/kg** sem conversão. Verificado em prod: `tbl_historico_cmc_estoque.volume_total` já em **kg** e `media_cmc_ponderada` já em **R$/kg** (ex.: PP-146 = 414.523 kg, R$ 7,2661/kg; total do snapshot = 2.924 t / R$ 23,2 mi — só fecha em kg). **Atenção**: outras telas do StockBridge usam fonte em toneladas; o fator de conversão delas **não** se aplica aqui.

## D4 — Cálculo do CMC e agregação

**Decisão**: O CMC por linha já vem pronto da fonte (`media_cmc_ponderada`). A agregação por **família** (e nos totais filtrados) é **ponderada por volume**: `SUM(valor_total_cmc) / NULLIF(SUM(volume_total), 0)` — calculada em SQL no service. Nunca média aritmética dos CMCs (FR-003). Volume zero → CMC nulo exibido como "—" (FR-008).

**Origem**: valores `IMPORTADO`/`NACIONAL` (maiúsculas, confirmado). Filtro de origem aceita `IMPORTADO`, `NACIONAL` ou ambos.

> **Derivação de `origem` (upstream, no workflow n8n `Coleta_Estoque_PN`)** — verificado 2026-06-08: importado = `UPPER(TRIM(modelo))='IMPACXE'` (coluna **`modelo`**, não `marca`). O workflow original usava `marca='IMPACXE'`, que está vazio (0/531) → classificava ~tudo como NACIONAL (bug). Correção = trocar `marca`→`modelo` no `CASE`. O Atlas só LÊ `origem`; a correção é no workflow + re-run. Mesmo critério deve valer no `forecast/familia.service.ts` (hoje usa `marca`).

**Sem família**: 3 linhas com `descricao_familia` NULL/'' no snapshot atual → agrupar em "Sem família" via `COALESCE(NULLIF(descricao_familia,''), 'Sem família')` (FR-006).

## D5 — Defasagem do dado (FR-007)

**Decisão**: O snapshot exibido é `MAX(data_snapshot)`. Sinalizar **defasado** quando `MAX(data_snapshot) <> CURRENT_DATE` (job roda diariamente, inclusive fim de semana). O endpoint retorna `dataSnapshot` + `defasado: boolean`; a UI mostra "Posição em DD/MM" e um aviso quando defasado.

## D6 — Tendência histórica (FR-011)

**Decisão**: Série **diária** na v1. Período padrão = todo o histórico disponível (hoje ~8 dias, desde 2026-06-01); seletor de intervalo permite restringir. Dias sem `data_snapshot` aparecem como **lacuna** (ponto `null`, sem interpolar) — recharts com `connectNulls={false}`. Agregação semana/mês fica **fora da v1**.

**Gráfico**: recharts (`LineChart`), uma linha por série selecionada. Por padrão plota CMC ponderado por família selecionada; se produtos forem filtrados, plota por produto. Eixo Y = R$/kg.

## D7 — Stack de UI (componentes)

**Decisão**: Construir com **Tailwind hand-rolled**, seguindo `CockpitPage.tsx` (845 linhas, mesmo módulo) que já implementa: linhas expansíveis com `ChevronDown`, filtros, badges, tabela densa. **Não há** biblioteca de primitivos shadcn em `apps/web` (apesar de citada no CLAUDE.md) — `@atlas/ui` expõe `ShellLayout` e `DataTable`.

- **Árvore família→produto (FR-017)**: linha de família clicável que expande/recolhe `produtos[]` no lugar, com ícone de estado (padrão CockpitPage). Famílias iniciam recolhidas.
- **Abas (FR-016)**: troca de aba via estado local (`useState`), padrão simples de tabs em Tailwind. Aba Snapshot é a default.
- **Combo multi-seleção (FR-009)**: componente hand-rolled (`MultiSelectCombo`) — dropdown com busca + checkboxes. O combo de produto filtra suas opções pelas famílias selecionadas.
- **Gráfico**: recharts.
- **Dados**: TanStack Query (`useQuery`) + `fetch('/api/v1/stockbridge/cmc/...', { credentials:'include', headers: { 'x-csrf-token' } })` — padrão de `App.tsx`/CockpitPage.

## D8 — Export (FR/Assumption)

**Decisão**: **Fora de escopo na v1** (decidido em /speckit.clarify). Sem botão de export; Metabase/planilha n8n seguem como saída externa.

## Resumo de conformidade

Nenhum `NEEDS CLARIFICATION` remanescente. Sem migration. Sem escrita. Sem dependência nova de pacote (recharts e TanStack Query já instalados). Constituição: PASS (nota do Princípio III registrada no plan, Complexity Tracking).
