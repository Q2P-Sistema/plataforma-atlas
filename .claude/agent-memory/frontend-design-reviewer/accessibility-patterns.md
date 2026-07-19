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

## Badge active/inactive contrast — RESOLVED (confirmed 2026-07-14)
The bloqueante finding below is **fixed**. Current `packages/ui/src/components/Badge.tsx` (as of the ACXEGDP-261/262/263 PR, branch `fix/ui-residual-auditoria`) uses `active: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'` / `inactive: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'` — the ~8:1 pairs, not the flat `bg-success/10 text-success` pattern described below. The file even has a code comment now explaining the WCAG reasoning. Original finding kept for history — **do not re-flag**, just verify Badge.tsx is still on the 100/800 + 900/30/400 pattern if touched again.

<details>
<summary>Original finding (UI-B2, ACXEGDP-262, found 2026-07, now fixed)</summary>
`packages/ui/src/components/Badge.tsx` changed `active`/`inactive` variants from `bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400` / red-equivalent (~8:1 contrast, WCAG AA pass) to `bg-success/10 text-success` / `bg-crit/10 text-crit`. `success` (#059669) and `crit` (#dc2626) in `tailwind.config.ts` are flat hex with NO dark-mode variant, and using the *same* hue for both the 10%-tint background and the text means measured contrast is ~3.1–4.2:1 in both themes — fails WCAG AA 4.5:1 for normal text (badge text is `text-[10px]`, well below the "large text" exemption).
</details>

## Sidebar collapsed flyout — likely clipped by ancestor `overflow-y-auto` (UI-C, ACXEGDP-263, found 2026-07-14)
`packages/ui/src/components/Sidebar.tsx`: the collapsed-mode flyout (`absolute left-full ... hidden group-hover:block group-focus-within:block`, ~line 176) is a descendant of `<nav className="... overflow-y-auto">` (line 121). Per the CSS overflow spec, when one axis is `visible` (overflow-x default) and the other isn't (`overflow-y: auto`), the browser forces the visible axis to compute as `auto` too — so `nav` becomes a clipping container on **both** axes, and the flyout (which must spill past the 64px collapsed-sidebar edge via `left-full`) gets clipped/invisible instead of escaping into the main content area. No `createPortal`/`position:fixed` escape hatch exists anywhere in this codebase (`apps/web/src` + `packages/ui/src`) — flyouts here are pure CSS, which is exactly the pattern this bug hits. **Rule of thumb for future flyout/dropdown/tooltip components**: if the trigger lives inside a scrollable ancestor (`overflow-y-auto`/`scroll`), a CSS-only `position:absolute` flyout meant to escape that ancestor's bounds WILL be clipped — needs either a portal, `position:fixed` + JS-computed coords, or restructuring so the scrollable container doesn't wrap the trigger. Not yet visually confirmed in a browser (no screenshot tool available in that review) — high confidence from spec/mechanism, but worth an actual DevTools check (`computed` tab on `<nav>`, look at `overflow-x`) before trusting this is fixed either way.

## Flyout/submenu triggers missing aria-haspopup/aria-expanded
Same class of gap as "aria-expanded on tree toggles" below. `Sidebar.tsx`'s collapsed-mode module button reveals a flyout submenu on hover/focus but has no `aria-haspopup="true"`/`aria-expanded` — keyboard *flow* still works (focus-within reveals the flyout content so Tab naturally proceeds into it), but screen-reader users get no advance announcement that focusing this button opens a submenu.

## Form validation border-color-only signals need a background pair, not just border shade
`apps/web/src/pages/stockbridge/operador/ConferenciaModal.tsx:235` — the "motivo obrigatório" textarea uses `border-red-300 dark:border-red-700` with **no** `bg-atlas-bg`/`bg-atlas-card` class (unlike its sibling `<select>`s in the same file, and unlike the equivalent pattern in `SaidaManualPage.tsx`/`ComodatoRetornoPage.tsx` which pair with `bg-atlas-bg`). Computed contrast (sRGB relative-luminance formula): `border-red-300` on white/atlas-bg-light ≈ **1.6–1.9:1**; `dark:border-red-700` on atlas-bg-dark (#1a1a2e) ≈ **2.6:1** — both well under the WCAG 1.4.11 non-text 3:1 minimum, and light-mode is the *worse* of the two. The light-mode part pre-dates this PR (untouched); `dark:border-red-700` is new and independently fails. Contrast with a **darker-in-dark-mode** shade also inverts the direction used everywhere else in the same PR (AlertsPage `SEV_STYLES`, BP status badges all go *lighter* for dark: e.g. `-600`→`-400`). Compare `SaidaManualPage.tsx`'s analogous case, `border-red-400 dark:border-red-600` (same file pattern, WITH `bg-atlas-bg`) ≈ 3.5:1 dark — passes, barely. Best fix precedent is 90 lines above in the *same* ConferenciaModal.tsx file (line ~145): `border-amber-400 bg-amber-50 dark:bg-amber-900/20` — pairs a tinted background with the border instead of relying on border-color alone against an unspecified/native background.

## Pre-existing: unlabeled form inputs in StockBridge operador forms
`RecebimentoNacionalForm.tsx` and `SaidaManualPage.tsx`'s modal use `<label>` elements as visual siblings of `<input>`/`<select>` with no `htmlFor`/`id` pairing — no programmatic label association for screen readers. Not introduced by UI-B2 (structure untouched, only color classes changed) but worth a follow-up ticket since it's the norm across StockBridge operador forms, not a one-off.

## ConferenciaModal "motivo obrigatório" border contrast — RESOLVED (confirmed 2026-07-15, feature 013 review)
The bloqueante finding below is **fixed**, apparently by a prior PR (likely the `fix/ui-residual-auditoria` merge, b1551f0) unrelated to feature 013 — feature 013's diff carries the fixed classes forward unchanged. Current `ConferenciaModal.tsx` (~line 353, "Motivo da divergência" textarea) uses `border-red-400 bg-red-50 dark:border-red-600 dark:bg-red-900/20` — background-paired, passes. Do not re-flag unless the classes regress back to a border-only signal.

<details>
<summary>Original finding (found pre-2026-07-15, now fixed)</summary>
`apps/web/src/pages/stockbridge/operador/ConferenciaModal.tsx:235` — the "motivo obrigatório" textarea used `border-red-300 dark:border-red-700` with **no** `bg-atlas-bg`/`bg-atlas-card` pairing, both well under WCAG 1.4.11's 3:1 non-text minimum.
</details>

## No global outline suppression — "missing focus ring" here means unbranded, not invisible
Checked `globals.css` in full: no `*:focus{outline:none}` or similar reset. `.btn-primary`/`.btn-secondary`/`.btn-danger` never strip the outline without a ring replacement either. So a plain `<button>`/`<Link>` with no `focus:` classes still gets the browser's native default focus outline when tabbed to — "missing focus ring" in this codebase is a branding/consistency gap (doesn't match the app's `focus:ring-2 focus:ring-atlas-accent`/`focus:ring-acxe` treatment used on styled inputs/toggles), not a hard WCAG keyboard-trap failure. Still worth fixing for consistency, just don't overstate severity. Reminder: both `atlas-accent` and `acxe` ring colors carry the previously-logged low-contrast-on-dark-card risk (~3.4:1) — copy-pasting them closes the "no ring" gap but not the "ring itself is low-contrast in dark mode" one.

## Familias toggle button (CockpitExecutivoPage.tsx ~line 326) — 2nd occurrence of the aria-expanded gap, this time with no focus ring either
Same family of bug as "aria-expanded on tree toggles" above (FamiliaTree.tsx), but worse: this button has **neither** `aria-expanded` **nor** a focus ring, whereas FamiliaTree.tsx's near-identical expand/collapse toggle (`apps/web/src/pages/stockbridge/gestor/cmc/FamiliaTree.tsx:82`) already established `focus:outline-none focus:ring-2 focus:ring-acxe rounded` as the precedent for this exact UX pattern (row/family toggle button). Also: the decorative `▸` expand-indicator glyph (line 331) and the `→` stage-separator in `Esteira` (line 237) are rendered as raw text with no `aria-hidden="true"` — same class of gap as the already-logged `⚠` emoji issue below, now confirmed as a recurring pattern worth checking on every new glyph/emoji used for decoration (arrows, triangles, warning signs) rather than semantic content. Fix pattern: `aria-expanded={aberta}` on the button, `aria-hidden="true"` on the glyph spans.

## ⚠ emoji without aria-hidden — 2nd confirmed occurrence (CockpitExecutivoPage.tsx line 381)
Same exact gap logged below for `ConferenciaEstoquePage.tsx`'s defasagem badge, now also found in `CockpitExecutivoPage.tsx`'s footer warning ("⚠ {kg} sem custo cadastrado..."). Confirms this isn't a one-off — check for bare `⚠`/emoji-as-text in any new warning copy and wrap in `<span aria-hidden="true">` (or swap for `lucide-react`'s `<AlertTriangle aria-hidden="true">`, the nicer precedent from `CmcSnapshotTab`).

## Multi-item forms need `fieldset`/`legend` per repeated section, not a bare `<span>` header (feature 013, ConferenciaModal.tsx)
When a form repeats the same field set N times (one block per product/line-item), the per-block heading must be a `<legend>` inside a `<fieldset>` — otherwise screen-reader users tabbing into the 2nd, 3rd, ... Nth product's "Quantidade física recebida" input get zero audible context on which product they're editing. `ConferenciaModal.tsx` (~line 234-245, multi-item branch added for feature 013) wraps each product in a bordered `<div>` with a plain `<span className="font-serif ...">{item.produto.nome}</span>` as the visual header — not programmatically associated with the fields below it. Compounds with the pre-existing "unlabeled form inputs" gap (same file, same section) — with N>1 the missing association actually matters (single-item forms don't have this ambiguity since there's only one instance of each field). Fix: `<fieldset className="border border-atlas-border rounded-lg p-3 space-y-3"><legend className="font-serif text-atlas-ink px-1">{item.produto.nome}</legend>...</fieldset>`.

## `autoFocus` dropped in ConferenciaModal's feature-013 rewrite
Pre-feature-013, the quantity input had `autoFocus` (operator could start typing the physical qty immediately on modal open). The multi-item rewrite (`itens.map`/`calculados.map`) dropped it entirely — not even conditionally on the first item. Real, verifiable regression (confirmed via `git diff`, the prop is simply gone, not moved). If touching this file again, restore on the first product's input only, e.g. `autoFocus={i === 0}` in the `calculados.map((..., i) => ...)`.
