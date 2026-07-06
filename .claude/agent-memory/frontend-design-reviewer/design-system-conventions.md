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
`p-6 max-w-7xl` without `mx-auto`. CockpitPage and MovimentacoesPage use max-w-7xl; AprovacoesPage uses max-w-6xl. No centering — content starts at left edge of padded shell.

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

## Modal.tsx maxWidth extension (UI-D, ACXEGDP-264, reviewed 2026-07)
`packages/ui/src/components/Modal.tsx` gained a `maxWidth?: 'md'|'lg'|'xl'|'2xl'` prop (default `'md'`, preserves old `max-w-md` for the two original consumers `ConferenciaModal.tsx`/`ReSubmeterModal.tsx` — visually identical) plus `max-h-[90vh] overflow-y-auto` on the card. Three StockBridge modals were migrated to it: `SaidaManualPage.tsx`'s `SaidaManualModal` (`maxWidth="xl"`, footer prop), `ComodatoRetornoPage.tsx`'s `RetornoModal` (`maxWidth="xl"`, footer prop), `UserGalpaoPage.tsx`'s galpão-edit modal (`maxWidth="lg"`, footer prop). Migration reviewed clean: tsc passes, internal `p-5` wrappers correctly dropped in favor of Modal's own `px-6 py-4`, callbacks/disabled-states intact, no orphaned JSX.
**Known structural quirk (pre-existing, not introduced by this migration for 2 of 3 modals):** `max-h-[90vh] overflow-y-auto` wraps header+body+footer as ONE scroll container inside `Modal.tsx` — there's no sticky header/sticky footer. On tall form content the footer's action buttons (Cancelar/Salvar/Registrar) scroll out of view along with the body. `SaidaManualModal`/`RetornoModal`'s old hand-rolled markup had this exact same single-scroll-container structure already (not a regression there). `UserGalpaoPage`'s old modal had NO max-h/overflow at all, so the scroll-behavior itself is new there — but is still an improvement (previously long galpão lists could overflow the viewport with no scroll at all). If `Modal.tsx` is touched again and a consumer reports "can't reach the submit button," the fix is to make header/footer `sticky top-0`/`sticky bottom-0` with their own bg, and restrict `overflow-y-auto` to just the body.
**Minor recurring nit:** in all 3 migrated files, the JSX between `<Modal ...>` and `</Modal>` kept one extra level of indentation (8sp instead of 4sp relative to `</Modal>`) left over from the removed wrapper `<div>`. Cosmetic only — no prettier config exists at repo root (`npx prettier --check` uses defaults and just flags quote style noise, not representative of this repo's actual single-quote convention) and eslint.config.js has no indent/prettier rule wired in, so nothing enforces this. Worth a manual re-indent pass if these files are touched again.

## Badge.tsx vs TopBar.tsx role-color duplication
`packages/ui/src/components/Badge.tsx` centralizes role/status badge colors, claiming to be "a mesma paleta da TopBar" — true, `operador`/`gestor`/`diretor` variants exactly match `TopBar.tsx`'s inline `ROLE_COLORS` map. But TopBar was NOT refactored to consume `<Badge>` — it still hand-rolls its own copy. Two parallel implementations of the same palette now exist; flag if either drifts without the other being updated.
