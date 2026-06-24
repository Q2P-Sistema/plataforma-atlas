---
name: design-system-conventions
description: Card backgrounds, empty-state pattern, tab toggle style, font conventions used in StockBridge gestor pages
type: project
---

## Card backgrounds
All info cards in StockBridge gestor pages use `bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg`. The `atlas-card` token exists but is NOT used in gestor pages — they use explicit bg-white.

## Empty state
Consistent pattern: `p-12 text-center text-sm text-atlas-muted border border-dashed border-slate-300 dark:border-slate-700 rounded-lg`. Used across CockpitPage, AprovacoesPage, MovimentacoesPage, DivergenciasPage, FilaOmiePage, CmcPage, CmcSnapshotTab.

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
