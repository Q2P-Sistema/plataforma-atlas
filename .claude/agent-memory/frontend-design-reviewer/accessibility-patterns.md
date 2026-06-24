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
