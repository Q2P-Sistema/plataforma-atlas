---
name: design-system-conventions
description: Card backgrounds, empty-state pattern, tab toggle style, font conventions used in StockBridge gestor pages
type: project
---

## Card backgrounds
UPDATE (2026-07, UI-B2/ACXEGDP-262): StockBridge gestor+operador pages were migrated from `bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700` to `bg-atlas-card border border-atlas-border`. The old note ("atlas-card exists but is NOT used") is now obsolete — atlas-card is the current standard everywhere reviewed (CockpitPage, DivergenciasPage, SaidaManualPage, RecebimentoNacionalForm). See "UI-B2 token migration" section below for the full token map.

## Empty state
Consistent pattern: `p-12 text-center text-sm text-atlas-muted border border-dashed border-atlas-border rounded-lg` (post UI-B2; was `border-slate-300 dark:border-slate-700`). Used across CockpitPage, AprovacoesPage, MovimentacoesPage, DivergenciasPage, FilaOmiePage, CmcPage, CmcSnapshotTab.

## Tab toggle (CmcPage / ForecastDashboard)
Custom `TabButton` component (not shadcn Tabs) using `flex rounded-lg border border-atlas-border overflow-hidden w-fit`. Active state: `bg-acxe text-white`. Inactive: `bg-atlas-bg text-atlas-muted hover:text-atlas-text`. No `role="tablist"` or `role="tab"` — pattern followed by ForecastDashboard too (accepted non-ARIA pattern).

## Font usage
- Page headings: `text-2xl font-serif text-atlas-ink` (h1) — all gestor pages
- Metric values in cards: `font-serif text-lg` or `font-serif text-base`
- Numeric table cells: `font-mono text-atlas-ink`
- Code/identifiers: `font-mono text-[10px] text-atlas-muted`

## Page wrapper
`p-6 max-w-7xl` without `mx-auto`. No centering — content starts at left edge of padded shell.
UPDATE (2026-07-14, UI-E/ACXEGDP-265): fully standardized. 7 StockBridge pages migrated from max-w-5xl/6xl → max-w-7xl in one PR: `ConfigProdutosPage`, `FornecedoresPage`, `UserGalpaoPage`, `AprovacoesPage` (was the max-w-6xl outlier noted below — now fixed), `LocalidadesPage`, `FilaOmiePage`, `MeuEstoquePage`. `TransitoPage` deliberately keeps `max-w-full` (inline comment: "pipeline de 5 estágios lado a lado precisa da largura total") — correct, documented exception, not an inconsistency. If a new StockBridge page shows up with max-w-5xl/6xl, that's now a real regression against an established standard, not just a stylistic nit.

## Table overflow
Tables with 5+ columns must be wrapped in `overflow-x-auto`. CockpitPage does this; FamiliaTree (CMC) does NOT — flagged as a missing pattern.

## Error/loading render order
CockpitPage renders: error first → data → loading. CmcSnapshotTab deviates: data first → error → loading.

## KPI card layout pattern
DivergenciasPage uses `grid grid-cols-2 md:grid-cols-4 gap-2` for summary cards — NOT `flex flex-wrap`. Avoid `min-w-[Xpx]` on cards; use grid instead. ConferenciaEstoquePage introduced `flex flex-wrap gap-3 min-w-[160px]` — flagged as inconsistent.

## Row hover in tables
All rows in DivergenciasPage, MovimentacoesPage use `hover:bg-slate-50 dark:hover:bg-slate-800/30`. ConferenciaEstoquePage omits hover on colored rows (uses LINHA_CFG severity tints). Accepted approach: add `hover:brightness-95 dark:hover:brightness-110` on colored rows or keep `hover:bg-slate-50/80 dark:hover:bg-slate-800/30`.

## Badge text size
Badges in DivergenciasPage use `text-xs` (not `text-[11px]`). Avoid arbitrary font sizes in badges.

## Opacity floor for severity row tints
Row background opacity must be at least `/20` in dark mode to remain distinguishable. `dark:bg-amber-900/10` (used in ConferenciaEstoquePage for Negativo row) is too subtle — use `/20` minimum.

## UI-B2 token migration (ACXEGDP-262, branch fix/ui-b2-harmonizacao-visual)
StockBridge migrated slate-*/bg-white/dark: pairs to adaptive `atlas-*` CSS-var tokens. Defined in `apps/web/src/globals.css` (`:root`/`.dark`), aliased in `apps/web/tailwind.config.ts`:
- `atlas-bg` (#F2EDE4 light / #1a1a2e dark), `atlas-card` (#FFFFFF / #16213e), `atlas-text`/`atlas-ink` (alias, same CSS var), `atlas-muted` (#6b7280 / #9ca3af), `atlas-border` (#d6d0c4 / #2d3748) — all adaptive via CSS var swap on `.dark` class.
- `atlas-btn-bg`/`atlas-btn-bg-hover`/`atlas-btn-text` — NEW adaptive primary-button blue (#0077cc→#005fa3 light, #2196f3→#1976d2 dark). `.btn-primary` and most inline "primary action" buttons use these. System primary action is now BLUE; `bg-q2p` (green) stays reserved for Q2P brand-identity chips, not actions.
- `atlas-accent` and `acxe` are **static hex `#0077cc`, NOT adaptive** (no `.dark` override) — the same shade that motivated `atlas-btn-bg`'s existence (globals.css comment: static blue was too dark against dark navy cards). Still used for `focus:ring-atlas-accent`/`focus:ring-acxe` and some secondary-button text/borders — carries the same low-contrast-on-dark-card risk the button fix was meant to solve (~3.4:1 on atlas-card dark, below AA). Confirmed in RecebimentoNacionalForm.tsx focus rings and its "+ Adicionar item" button.

## `bg-atlas-bg` is a sub-surface token, not page chrome
`bg-atlas-bg` is meant for a tinted sub-surface *inside* a card (table `<thead>`, segmented-control track, `Cell` mini-box) where it visually differs from the surrounding `bg-atlas-card`. It must NOT be applied to elements sitting directly on the page canvas — `ShellLayout.tsx`'s `<main>` has no bg of its own and the outer shell div is `bg-atlas-bg`, so anything painted `bg-atlas-bg` directly on a page becomes fill-invisible, relying only on its border. Confirmed bug: CockpitPage.tsx's `esteira` (5-stage pipeline) — 4 of 5 stage boxes keep colored tints (violet-50/amber-50/orange-50/green-50) but "Ag. Embarque" was migrated to `bg: 'bg-atlas-bg'` (CockpitPage.tsx:247), which visually vanishes against the page — breaks the pipeline's color-coded visual language. Same root cause, lower/probably-acceptable impact in `MultiSelectDropdown` trigger button (CockpitPage.tsx:797) and segmented-control "track" divs (there the *active* pill still contrasts via `bg-atlas-card`).

## Hover pattern inconsistency on `atlas-btn-bg` buttons
Two hover techniques coexist for the same nominal primary-button style: `.btn-primary` (globals.css) and LoginPage.tsx use the dedicated `hover:bg-atlas-btn-bg-hover` token (a real darker shade); most inline action buttons (RecebimentoNacionalForm submit, SaidaManualPage "Registrar saída"/modal submit, ConferenciaModal confirm) use `hover:opacity-90` instead — pre-existing, not touched by UI-B2. Low severity, worth standardizing eventually.

## Badge.tsx vs TopBar.tsx role-color duplication — RESOLVED (2026-07-14, UI-B/ACXEGDP-262 follow-up)
Was: `packages/ui/src/components/Badge.tsx` centralized role/status badge colors, claiming to be "a mesma paleta da TopBar" but TopBar hand-rolled its own copy (`ROLE_COLORS`) — two parallel implementations. Now fixed: `TopBar.tsx` imports and renders `<Badge variant={...}>` directly, `ROLE_COLORS` deleted. Verified byte-identical color classes for operador/gestor/diretor (zero visual diff) — the only delta is padding, `px-1.5`→`px-2` (Badge.tsx's own padding wins), a harmless ~2px/side change. This is the correct direction: single source of truth > preserving old bespoke spacing. If a new top-level chrome component needs a role/status pill, it should consume `<Badge>` too, not hand-roll colors again.

## chartColors token additions: neutral / slate / info (2026-07-14, UI-B/ACXEGDP-262 follow-up)
`packages/ui/src/tokens/chartColors.ts` added `neutral: '#6b7280'`, `slate: '#8492a6'`, `info: '#3b82f6'` — byte-exact matches to raw hex previously hardcoded across Hedge/Forecast pages (verified via repo-wide grep: zero raw-hex strays left in `apps/web/src` after the swap; the only remaining `#6b7280` hit is `colors.ts`'s unrelated `--atlas-muted` CSS var, which coincidentally shares the value). Use these tokens instead of raw hex for: PTAX/variação-neutra states (`neutral`), secondary/muted chart labels (`slate`), and non-alert info series/sparklines (`info`). Zero visual change by construction — this is the same "extract repeated raw hex into `chartColors`" pattern as the original `acxe`/`q2p`/`warn`/`crit`/`ndf`/`success` tokens.

## Modal `maxWidth` convention — 'md' default, 'xl' for "bigger" forms (confirmed 2026-07-15)
`packages/ui/src/components/Modal.tsx` has an explicit code comment: default is `'md'` (max-w-md), and "Modais de formulário maiores usam 'xl'" (ACXEGDP-264/UI-D). Confirmed precedent: `SaidaManualPage.tsx` and `ComodatoRetornoPage.tsx` both pass `maxWidth="xl"` for their forms. Counter-example found in feature 013: `ConferenciaModal.tsx` was rewritten to hold 1..N stacked per-product sections (each with a 2-col qty/unit row, a 3-col NF/Recebido/Diferença grid, 2 selects, a textarea) but never added a `maxWidth` prop, so it stays on the 'md' default even for N=5-10 products — the most form-dense modal in StockBridge operador but the narrowest. If touching multi-item forms/modals again, check whether they've grown past the "simple form" tier and need `maxWidth="xl"` to match this precedent.

## `resumo` is a backend-wide summary pattern that the frontend is expected to render — watch for silent misses
Every list/report endpoint in StockBridge pairs `itens`/`skus`/`pedidos` with a `resumo` object (`cockpit.service.ts`, `conferencia.service.ts`, `cmc.service.ts`, `pendencias-fiscais.service.ts`, `recebimento.service.ts`), and on the frontend every gestor page that consumes one (`CockpitPage`, `ConferenciaEstoquePage`, `PendenciasFiscaisPage`, `CmcSnapshotTab`) renders it as visible KPI cards. Counter-example: feature 013's `ConferenciaModal.tsx` result screen receives `resultado.resumo` (`recebidos`/`aguardandoAprovacao`/`pendentesOmie`/`falhas`/`jaRecebidos`) and only uses it internally to compute a boolean (`tudoOk`) for the top icon — the counts themselves are never shown to the user, even though for a multi-item NF (5-10 products) a one-line summary ("8 recebidos · 1 aguardando aprovação · 1 falha") would help before scanning the per-item list below. Worth checking any new screen that receives a `resumo` field: is it actually rendered, or just consumed for a derived boolean?

## Breaking Point (BP) module — icon props widened string→ReactNode, migration is partial
`BPDashboardPage.tsx`'s local `KpiCard`/`Row` components and `breakingpoint/components/Countdown.tsx` had their `icon`/`extra` props changed from `string` to `React.ReactNode` (2026-07-14, UI-E/ACXEGDP-265) to allow swapping emoji for lucide icons incrementally. Only some call sites were actually migrated — as of that PR, `BPDashboardPage.tsx` still passes raw emoji strings for `icon` at lines ~209-211 (Countdown: 🏦📄🔒) and ~217-220 (KpiCard: 📦📄🏛🔒), and `BPLimitesPage.tsx`'s separate `TotalCard` component (untouched, uses `icone` prop) still has 📄🏛💳. This is fine functionally (strings are valid ReactNode) but is an incomplete migration relative to the stated PR goal — check for stragglers if touching BP icons again. **Gotcha**: `Countdown.tsx`'s icon wrapper div lost its `text-2xl` sizing class in that same edit (now just `flex justify-center`, relying on each icon to self-size) — any remaining emoji-string icon renders at inherited/base font size instead of 24px, a real size regression vs. the lucide-converted ones (`Ban size={16}`, `CheckCircle2 size={24}`). If finishing this migration, either restore an explicit size class on the wrapper as a floor for string icons, or just finish converting all 4 call sites to lucide.
