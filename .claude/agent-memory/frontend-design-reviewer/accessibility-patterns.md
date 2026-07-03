---
name: accessibility-patterns
description: Accessibility patterns (ARIA, keyboard, contrast) observed in StockBridge gestor pages
type: project
---

## aria-expanded on tree toggles
FamiliaTree toggle button has `aria-expanded={aberta}` — correct. But lacks `aria-label` describing what is being expanded (e.g., "Expandir família X"). Screen readers would announce "button, expanded/collapsed" without context.

## Tab toggle ARIA
Neither CmcPage's TabButton nor ForecastDashboard's inline tab buttons use `role="tablist"` / `role="tab"` / `aria-selected`. This is an accepted pattern in the codebase (both old and new pages use the same approach). Do not flag as a new violation — it's a pre-existing known limitation.

## FamiliaTree keyboard nav
The `<tr onClick={onToggle}>` row click is not keyboard-accessible on its own, but the inner `<button>` IS keyboard-accessible and uses `stopPropagation` to avoid double-fire. The tr onClick only fires for mouse users clicking outside the button cell area — this is an edge case but means mouse and keyboard UX differ slightly.

## Table overflow
Wide tables must have an `overflow-x-auto` wrapper. FamiliaTree's 5-column table (`bg-white ... rounded-lg overflow-hidden`) lacks this wrapper — the table can overflow on narrow viewports.

## Badge active/inactive contrast regression (UI-B2, ACXEGDP-262, found 2026-07)
`packages/ui/src/components/Badge.tsx` changed `active`/`inactive` variants from `bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400` / red-equivalent (~8:1 contrast, WCAG AA pass) to `bg-success/10 text-success` / `bg-crit/10 text-crit`. `success` (#059669) and `crit` (#dc2626) in `tailwind.config.ts` are flat hex with NO dark-mode variant, and using the *same* hue for both the 10%-tint background and the text means measured contrast is ~3.1–4.2:1 in both themes — fails WCAG AA 4.5:1 for normal text (badge text is `text-[10px]`, well below the "large text" exemption). Confirmed live via `AdminUsersPage.tsx`'s user-status column, which switched to `<Badge>` in this same diff. Rated **bloqueante** in the UI-B2 review — recommend using darker/lighter shade pairs per mode (e.g. `text-emerald-700`/`dark:text-emerald-300` on a soft bg) instead of a single flat token for both bg-tint and text. If `Badge.tsx` is touched again, re-check contrast math before approving — this component is declared "fonte única" for role/status colors app-wide, so a fix here fixes everywhere.

## Pre-existing: unlabeled form inputs in StockBridge operador forms
`RecebimentoNacionalForm.tsx` and `SaidaManualPage.tsx`'s modal use `<label>` elements as visual siblings of `<input>`/`<select>` with no `htmlFor`/`id` pairing — no programmatic label association for screen readers. Not introduced by UI-B2 (structure untouched, only color classes changed) but worth a follow-up ticket since it's the norm across StockBridge operador forms, not a one-off.
