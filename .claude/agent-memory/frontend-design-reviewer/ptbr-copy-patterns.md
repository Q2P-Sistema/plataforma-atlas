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
