# Revisão Supervisória — Módulo Hedge
**Data:** 2026-04-14  
**Objetivo:** Validar lógicas de cálculo e identificar melhorias

---

## Tarefas Identificadas

### ~~T01~~ — PTAX visível — **IMPLEMENTADO**
- Card "PTAX Atual" redesenhado: valor grande colorido (verde=caiu, vermelho=subiu), variação % vs dia anterior, data ref + horário da última busca
- Mini gráfico de 15 dias abaixo do valor (usando `ptaxHistorico` real, não snapshots)
- Card "Câmbio PTAX" vazio/quebrado removido; seção charts row passou de 3 para 2 colunas
- `HedgeLayout` criado como wrapper compartilhado — badge PTAX (valor + var% + horário) aparece no header de todas as abas do módulo
- Backend: `fetchedAt` exposto no endpoint `/api/v1/hedge/ptax`

### ~~T02~~ — Badge PTAX não aparece no TopBar — **IMPLEMENTADO**
- `topBarSlot` passa `<HedgePtaxBadge />` via `ShellLayout` → `TopBar.centerSlot` quando rota começa com `/hedge`
- Badge aparece no header global em todas as abas do módulo hedge

### ~~T03~~ — Gráfico histórico PTAX vazio — **IMPLEMENTADO**
- Root cause: `getPool` não estava importado em `modules/hedge/src/services/ptax.service.ts` — causava `ReferenceError` silencioso, API retornava 500
- Fix: adicionado `getPool` ao import de `@atlas/core`
- Melhorias adicionais: labels com 3 chars mês PT-BR ("15 Abr"), linha de tendência (regressão linear) no gráfico, ponto intraday do boletim BCB appended como último ponto quando mais recente que `tbl_cotacaoDolar`

### ~~T04~~ — Card "Receita Projetada" exibindo BRL em vez de USD — **IMPLEMENTADO**
- Trocado `recebiveis_brl` → `recebiveis_usd`, label "Receita USD Projetada", formato `$ 11.9M` (`fmtM`)
- Arquivo: `apps/web/src/pages/hedge/PositionDashboard.tsx` linha 215

### ~~T05~~ — PTAX boletins intraday BCB — **IMPLEMENTADO**
- Migrado de SGS-1 (fechamento diário) para `CotacaoDolarDia` (boletins ~3x/dia: ~10h, ~12h, ~16h BRT)
- `fetchedAt` = `dataHoraCotacao` real do boletim BCB (não timestamp do servidor)
- Redis TTL: 3600s. Frontend: staleTime 1h, sem `refetchInterval`
- Label: "Boletim BCB HH:MM · Ref. YYYY-MM-DD"

### T06 — Fórmula de exposição cambial — **DISCUSSÃO EM ABERTO**
**Proposta do supervisor:** `exposicao_usd_total = total_pagar_usd - estoque_importado (no chão + embarcados)`
**Interpretação:** o estoque de importados já comprados (em armazém ou em trânsito) representa dólares que já saíram do caixa ou têm compromisso firme — abater da exposição dá o líquido real a hedgear.
**Pendente:** validar os componentes exatos (no chão = `est_importado_brl` / PTAX? embarcados = `est_transito_brl`?) e comparar com cálculo atual de `est_nao_pago_usd`.

### ~~T07~~ — Acentuação ausente em labels da interface — **IMPLEMENTADO**
**Problema:** Dezenas de strings sem acento no código — visível ao usuário final.  
Exemplos confirmados em `apps/web/src/pages/hedge/PositionDashboard.tsx`:
- "Posicao Consolidada" → "Posição Consolidada" (h1, linha 205)
- "Exposicao USD Total" / "Exposicao Liquida" → "Exposição" / "Líquida" (linhas 214, 218)
- "Composicao da Posicao" → "Composição da Posição" (linha 232)
- "Posicao Agregada por Bucket..." → "Posição Agregada..." (linha 225)
- "Estoque nao pago estimado" → "Estoque não pago estimado" (linha 315)
- "Titulos a pagar" → "Títulos a pagar" (linha 301)

**Escopo:** varredura em todos os arquivos `.tsx` de `apps/web/src/pages/` (hedge, forecast, breakingpoint).  
**Impacto:** puramente visual/textual, sem risco de regressão.

---

### ~~T08~~ — Loading states sem feedback visual adequado — **IMPLEMENTADO**
**Problema:** Todos os estados de carregamento são `<p className="text-atlas-muted">Carregando...</p>` (PositionDashboard linha 116, ForecastDashboard linha 76). Nenhum esqueleto ou animação.  
**Sugestão:** Substituir pelo padrão de skeleton pulse do Tailwind (`animate-pulse`) nos KPI cards e na tabela principal de cada módulo. Não requer dependência nova.  
Exemplo: os 5 KpiCards em grid podem ter um skeleton `h-20 rounded-lg bg-atlas-border animate-pulse` enquanto carregam.

---

### ~~T09~~ — Dois verdes diferentes no sistema — `emerald-600` vs `q2p` — **IMPLEMENTADO**
**Problema:** O design system define `q2p: #1a9944` como verde semântico da marca. Mas `globals.css` e componentes usam `emerald-600` (`#059669`) em botões primários, focus rings e textos de sucesso — são verdes distintos que coexistem sem intenção.  
**Localização:**
- `globals.css` linha 29: `.btn-primary` usa `bg-emerald-600`  
- `globals.css` linha 29: focus ring usa `focus:ring-emerald-600`  
- `PositionDashboard.tsx` linha 218: KpiCard "Exposição Líquida" usa `color="#059669"` inline  
**Decisão necessária:** unificar para `q2p` em tudo que representa sucesso/positivo, ou manter `emerald` como cor de ação (botões) e `q2p` como cor de dado (KPIs). Deve ser documentado como regra.

---

### ~~T10~~ — Gráficos Recharts com cores hardcoded incompatíveis com dark mode — **IMPLEMENTADO**
**Problema:** `CartesianGrid` usa `stroke="rgba(221,225,232,0.5)"` (cor clara) — visível em light, praticamente invisível em dark (`--atlas-bg: #1a1a2e`). O mesmo padrão se repete no gráfico de barras e no miniGráfico PTAX.  
**Localização:** `PositionDashboard.tsx` linhas 252, 281.  
**Solução:** Criar uma constante ou CSS variable para a cor do grid: `var(--atlas-border)` funciona em ambos os temas. Aplicar em todos os `CartesianGrid` e `ReferenceLine` do projeto.

---

### ~~T11~~ — Transições ausentes em botões e sidebar — **IMPLEMENTADO**
**Problema:** `.btn-primary`, `.btn-secondary`, `.btn-danger` em `globals.css` não têm `transition-colors`. Clicks e hovers são instantâneos — falta do feedback tátil mínimo esperado em UI profissional.  
**Fix trivial:** adicionar `transition-colors duration-150` nas classes `.btn-*` no `globals.css`.  
**Sidebar:** verificar se o colapso (w-60 → w-16) tem `transition-all` — se não tiver, adicionar.

---

### ~~T12~~ — Favicon ausente — **IMPLEMENTADO**
**Problema:** `apps/web/index.html` não tem favicon. A aba do browser mostra ícone genérico do Vite.  
**Fix:** Adicionar um SVG favicon simples (pode ser um "A" estilizado ou as iniciais ACXE/Q2P) em `apps/web/public/favicon.svg` e referenciar no `<head>`.

---

### ~~T13~~ — `font-heading` (Fraunces) subutilizada — **IMPLEMENTADO**
**Problema:** Fraunces foi escolhida como fonte de display — é a personalidade tipográfica do sistema. Mas só aparece confirmada no `h1` de `PositionDashboard`. Os outros módulos (Forecast, Breaking Point) provavelmente não usam `font-heading` nos títulos de página.  
**Verificar:** todos os `h1`/`h2` em `pages/forecast/` e `pages/breakingpoint/` e confirmar uso de `font-heading`. Adicionar onde ausente.

---

## Notas / Dúvidas Registradas

---

## Regra para próximas sessões

> Anotar no arquivo de tarefas antes de implementar. Não sair codando sem confirmação do supervisor.

