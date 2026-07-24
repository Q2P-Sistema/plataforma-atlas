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

## Singular/plural agreement — check EVERY count+noun render, even in files that get it right elsewhere
`CockpitExecutivoPage.tsx` (Hero, ~linha 138): `{totalSkus} produtos em {data.familias.length} famílias` — sem guarda de singular (viraria "1 produtos"/"1 família" incorreto se a contagem for 1). Baixa probabilidade de disparar em produção (centenas de SKUs), mas é um bug real e fácil de corrigir: `{totalSkus} {totalSkus === 1 ? 'produto' : 'produtos'}`. O interessante: o MESMO arquivo acerta esse padrão em outros dois lugares — Esteira (`${e.lotes === 1 ? 'lote' : 'lotes'}`) e Galpões (`{g.produtos === 1 ? 'produto' : 'produtos'}`) — então não é desconhecimento do padrão, foi um esquecimento pontual. Ao revisar qualquer tela nova, procure por `{algumaContagem} algumSubstantivo` sem ternário de singular por perto.

## FUP/CMC nunca são explicados em lugar nenhum do StockBridge — risco maior em telas para o dono
Grep confirmou: "FUP" aparece sem glossário em `TransitoPage.tsx`, `PendenciasFiscaisPage.tsx`, `CockpitPage.tsx` e `CockpitExecutivoPage.tsx` — é jargão interno (planilha de acompanhamento de importação) nunca expandido pro usuário, nem em tooltip. "CMC" (custo médio) recebe uma glosa parcial só no rodapé do Cockpit Executivo ("custo médio (CMC)"), mas é usado cru mais cedo no cabeçalho da mesma página ("custos pelo CMC"). Isso é consistente entre páginas gestor (aceitável — gestor já foi treinado no jargão), mas o Cockpit Executivo tem uma persona explícita e diferente: o dono da empresa, que segundo o brief de produto "rejeitou o cockpit atual por ser bagunçado e cheio de informação irrelevante" — ele é justamente o público MENOS provável de já saber o que é FUP. Padrão leve já estabelecido no módulo pra resolver isso sem poluir visualmente: `<span className="cursor-help" title="...">` (usado em `MetricasPage.tsx` com ⓘ, e em `CockpitPage.tsx` com `title=` em vários pontos) — nenhum aplicado a FUP/CMC ainda em página nenhuma.

## PTAX sempre com 4 casas decimais fixas — convenção estabelecida em MetricasPage.tsx
`MetricasPage.tsx` formata PTAX com `{ minimumFractionDigits: 4, maximumFractionDigits: 4 }` — SEMPRE 4 casas, é a convenção correta pra taxa de câmbio BCB (nunca varia o número de casas entre renders). `CockpitExecutivoPage.tsx` (linha 245) usou `{ minimumFractionDigits: 2, maximumFractionDigits: 4 }` — permite 2, 3 ou 4 casas dependendo do valor, o que faz a formatação "pular" (ex.: "5,20" num dia, "5,4321" no outro) numa página cujo objetivo inteiro é parecer um extrato financeiro polido. Ao tocar em qualquer exibição de PTAX nova, usar sempre `{4,4}` fixo.

## Rodapé com link cujo texto repete o sujeito da frase
`CockpitExecutivoPage.tsx` rodapé: "O Cockpit operacional segue em **Cockpit**." — o link (`<Link to="/stockbridge/cockpit">Cockpit</Link>`) repete literalmente a palavra que já é o sujeito da frase. Não é erro gramatical, mas lê estranho. Prefira reformular pra não repetir o destino do link como sujeito da mesma frase (ex.: "A visão operacional completa continua no Cockpit.").

## ModulePlaceholder "indisponivel" copy — audience mismatch nuance (2026-07-14, UI-C/ACXEGDP-263)
`apps/web/src/components/ModulePlaceholder.tsx`: "Este módulo não está disponível para o seu perfil ou ainda não foi ativado. Se você acredita que deveria ter acesso, fale com um gestor." Deliberately covers two causes (role-gated vs. feature-flag-off) since the backend only exposes one boolean — reasonable tradeoff, documented in a code comment. Minor nuance: this screen can be shown to **any** role including gestor/diretor themselves (e.g. a module disabled for everyone), and "fale com um gestor" only makes sense as escalation advice for an operador. Not wrong enough to block, but a role-neutral phrasing ("fale com o administrador do sistema") would read better across all three audiences.
