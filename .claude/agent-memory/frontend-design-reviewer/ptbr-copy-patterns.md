---
name: ptbr-copy-patterns
description: PT-BR copy conventions observed in StockBridge gestor pages — units, labels, dev-text leaks
type: project
---

## Unit display convention
Lowercase `kg` is the actual displayed convention across ALL StockBridge pages (CockpitPage, AprovacoesPage, MovimentacoesPage, FamiliaTree, CmcSnapshotTab). Despite the memory note saying "Kg", every JSX string uses lowercase `kg`. Do not flag lowercase kg as an error.

## CMC label
Used as "CMC (R$/kg)" in table headers, and "R$ X,XXXX/kg" in cell values (fmtCmc). This is correct.

## "defasado" badge
`CmcSnapshotTab` uses "Dado defasado — não é do dia corrente" in an amber badge with AlertTriangle icon. Correct PT-BR; minor tone note: "dia corrente" is formal but acceptable.

## Dev-text leaks to watch
- CmcPage line 36 (JSX): "A tendência histórica do CMC chega no próximo incremento (US2)." — "(US2)" is a story reference visible to prod users.
- CmcSnapshotTab lines 71–72 (JSX): "Em dev sem o sync de tbl_historico_cmc_estoque, esta lista fica vazia." — table name and dev context visible to prod users.
- CockpitPage (pre-existing): same pattern with "Em dev sem sync OMIE" — not introduced by CMC feature.

## OrigemBadge
Renders "Importado"/"Nacional" as text node but applies CSS `uppercase` — renders visually as "IMPORTADO"/"NACIONAL". Intentional badge styling, not a copy error.

## Loading text ellipsis
DivergenciasPage uses ASCII `...`; ConferenciaEstoquePage uses Unicode `…` (U+2026). Both are in use — flag inconsistency, pick one per page/module update.

## Emoji in warnings
The `⚠` emoji (used in ConferenciaEstoquePage defasagem badge) must be wrapped in `<span aria-hidden="true">` to avoid duplicate reading by screen readers. Prefer lucide-react `<AlertTriangle aria-hidden="true">` per CmcSnapshotTab pattern.

## Header copy promise vs. implementation
ConferenciaEstoquePage header says "aparecem no topo" but the page only filters, not sorts. Always verify that header description copy matches actual UI behavior.

## "você" tone is established, not a one-off
`NotFoundPage.tsx` ("a página que você procura..."), `FilaOmiePage.tsx`/`SaidaManualPage.tsx` confirm dialogs ("...você só não vai ver mais aqui") and now `ModulePlaceholder.tsx`'s "indisponivel" variant ("Se você acredita que deveria ter acesso...") all use direct "você" address. Safe to keep using it in new user-facing copy — it's the app's established register, not informal drift.

## Copy promising an action the UI doesn't have — "retente pelo painel de Movimentações" (feature 013, ConferenciaModal.tsx)
Same class of bug as the "Header copy promise vs. implementation" entry above, found again in feature 013. `ConferenciaModal.tsx`'s `STATUS_RESULTADO.pendente_q2p` label reads "Parcial: ACXE registrado, Q2P pendente — retente pelo painel de Movimentações", pointing the operador at `/stockbridge/movimentacoes`. Verified: `MovimentacoesPage.tsx` is **read-only** (status badges only, no retry button/mutation anywhere in the file) and there is no frontend page anywhere in `apps/web/src` for `GET/POST /api/v1/stockbridge/operacoes-pendentes` (the actual retry endpoint, per CLAUDE.md — "retry idempotente ... operador limitado a 1x"). So the copy sends the operator to a page with no action to take. Either the copy needs softening ("acompanhe pelo painel de Movimentações — o retry é automático" if that's true) or a retry surface needs to exist on that page. Check again if `operacoes-pendentes` ever gets a frontend page — this note would then be stale.

## ModulePlaceholder "indisponivel" copy — audience mismatch nuance (2026-07-14, UI-C/ACXEGDP-263)
`apps/web/src/components/ModulePlaceholder.tsx`: "Este módulo não está disponível para o seu perfil ou ainda não foi ativado. Se você acredita que deveria ter acesso, fale com um gestor." Deliberately covers two causes (role-gated vs. feature-flag-off) since the backend only exposes one boolean — reasonable tradeoff, documented in a code comment. Minor nuance: this screen can be shown to **any** role including gestor/diretor themselves (e.g. a module disabled for everyone), and "fale com um gestor" only makes sense as escalation advice for an operador. Not wrong enough to block, but a role-neutral phrasing ("fale com o administrador do sistema") would read better across all three audiences.
