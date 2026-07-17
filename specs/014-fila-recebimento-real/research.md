# Phase 0 — Research: Fila de Recebimento em Modo Real + Correção de Granularidade

**Feature**: 014-fila-recebimento-real | **Date**: 2026-07-16

Pesquisa conduzida por 3 agentes em paralelo (ciclo de vida do mapa mãe→filhote, UI de recebimento/Pendências Fiscais, e a interação entre a checagem "recebida" e o recebimento parcial da feature 013) + verificação direta de código. Achado central: os dados para a fila real **já existem e já estão corretos na origem** (`nf_pedido_mapa`/`nf_pedido_filhote`, feature 011); o trabalho é (1) consumir esses dados a partir do papel operador, e (2) estender a granularidade de "recebido" — hoje por NF, precisa ser por produto — nos 5 pontos que a herdam.

---

## D1 — Fonte de dados da fila: reaproveitar `nf_pedido_mapa`/`nf_pedido_filhote`

**Decisão**: a fila lê `stockbridge.nf_pedido_mapa` (mapa `ativo=true`) + `stockbridge.nf_pedido_filhote` (filhote `ativo=true`), cruzando ao vivo com `public."tbl_nf_header_ACXE"`/`"tbl_nf_itens_ACXE"` (espelho OMIE) — o mesmo padrão de `pendencias-fiscais.service.ts` (`getPendenciasFiscais`, 011).

- Schema ([packages/db/src/schemas/stockbridge.ts](../../packages/db/src/schemas/stockbridge.ts) L366-399): `nfPedidoMapa` (`pedidoAcxeOmie`, `nfMae`, `ativo`) 1:N `nfPedidoFilhote` (`nfFilhote`, `posicao` 1-12, `ativo`). Nenhuma das duas guarda status de recebimento — é sempre lido ao vivo (comentário na migration 0039: "fonte de verdade é OMIE").
- Validado ao vivo em UAT (16/07): 7 mapas ativos, 15 filhotes pendentes no momento da consulta — dado real, não teórico.
- **Sem migration**: nenhuma tabela nova; a fila é só uma query nova sobre tabelas existentes.

## D2 — Nunca confiar em `mapa.ativo`/`filhote.ativo` sozinho — sempre cruzar ao vivo

**Decisão**: a fila (e a correção nos consumidores existentes) sempre valida contra o espelho OMIE (`n_id_nf`, `cancelada`, `deletada`) e contra `stockbridge.movimentacao`/`movimentacao_legado` — nunca deriva "pendente" só de `ativo=true`.

- **Mapa zumbi** (achado do agente de ciclo de vida): `upsertNfPedidoMapa` ([nf-pedido-mapa.service.ts:94-123](../../modules/stockbridge/src/services/nf-pedido-mapa.service.ts)) só desativa um mapa quando o **próprio pedido é reenviado** pelo n8n — não há job de reconciliação periódica. Um pedido cujas filhotes foram todas recebidas, mas cujo Comex nunca reenviou, fica com `ativo=true` para sempre. Isso é **inofensivo** para a fila porque, cruzando ao vivo, esse mapa zumbi simplesmente não produz nenhum item pendente (todas as filhotes já recebidas) — mesmo padrão que já protege `getPendenciasFiscais`.
- **Escrita do mapa é exclusiva do n8n**: `POST /admin/nf-pedido-mapa` exige `requireIntegrationKey` ([nf-pedido-mapa.routes.ts:21-48](../../modules/stockbridge/src/routes/nf-pedido-mapa.routes.ts)) — não há caminho de UI para gestor/operador cadastrar manualmente. A fila é 100% consumidora, nunca escreve no mapa.
- **Filhote pode estar no mapa antes de existir no OMIE** (Comex cadastra a FUP antes do sync sincronizar a NF) — `n_id_nf IS NULL`. A fila trata isso como "ainda não acionável" e omite (FR-005/US3) — diferente de Pendências Fiscais, que mostra mesmo assim (`nfEmitida: false`) porque lá o objetivo é visão fiscal completa, não uma lista de ações possíveis.

## D3 — Granularidade "produto pendente": correção real só é possível no caminho Atlas

**Decisão**: estender `fiscal-recebida-sql.ts` com uma variante de `recebidaViaMovimentacaoSql` que aceita um filtro de produto opcional; `recebidaViaLegadoSql` **permanece por NF** (limitação de dado, não de query).

- Confirmado por leitura de schema: `stockbridge.movimentacao` tem `produtoCodigoAcxe` ([stockbridge.ts:161](../../packages/db/src/schemas/stockbridge.ts)) — correção viável. `stockbridge.movimentacao_legado` **não tem** coluna de produto ([stockbridge.ts:326-343](../../packages/db/src/schemas/stockbridge.ts)) — é o histórico congelado da migração única do MySQL (feature 007, migration 0038); uma linha ali representa uma NF de uma época em que só existia 1 produto por NF. Não há como recuperar retroativamente "qual produto" um registro legado cobria quando a NF (revista hoje no espelho) mostra mais de um item.
- `n_id_receb` (o flag de recebimento formal do OMIE) é um campo do **cabeçalho** de `tbl_nf_header_ACXE` — o modelo do OMIE não expõe recebimento por item para o Atlas consumir.
- **Consequência prática**: a correção de granularidade é completa e útil onde importa — o caminho Atlas é o único capaz de multi-produto (o legado e o `n_id_receb` só existem para NFs que já passaram por um recebimento formal completo, cenário onde a distinção por produto não muda o resultado).
- O padrão correto já existe em produção, só não está generalizado: `produtoDaNfJaRecebido` ([recebimento.service.ts:181-217](../../modules/stockbridge/src/services/recebimento.service.ts)) já faz exatamente essa checagem por produto, usada hoje só na busca por NF específica (`getFilaOmie`, Caso 1).

## D4 — Os 5 pontos a corrigir (não 4 — achado o quinto durante a verificação)

A pesquisa original mapeou 4 arquivos; a verificação de precisão achou um quinto uso da mesma função em `cockpit-executivo.service.ts` (card ACXEGDP-314, mesclado em paralelo a esta investigação):

| # | Arquivo | Linha(s) | Efeito do bug hoje |
|---|---|---|---|
| 1 | `cockpit.service.ts` | L260-261 (`transito_recebido_filhotes`, Parte A) | NF parcial some do "recebido" — subtrai kg do produto ainda pendente da conta de trânsito local, subestimando o que falta chegar fisicamente |
| 2 | `cockpit.service.ts` | L382-383 (mesmo padrão, variante) | idem |
| 3 | `cockpit.service.ts` | L405-406 (Parte B, fallback sem-mapa) | NF parcial some da lista de "sem mapa pendente" mesmo com produto faltando |
| 4 | `cockpit-executivo.service.ts` | L424-425 (`consultarTransitoValorizado`, ACXEGDP-314) | mesmo bug do #1, na visão executiva nova (R$ por local) — a CTE já agrupa por produto (`GROUP BY ... i.n_cod_prod`) mas o filtro EXISTS que decide inclusão é por NF, então o produto pendente entra com seu peso total como se estivesse recebido |
| 5 | `pendencias-fiscais.service.ts` | L181-182, 209-210 | filhote parcial aparece como "recebida" (não "parcial"); e a seção "sem mapa" (Parte B) some prematuramente |
| — | `nf-pedido-mapa.service.ts` | L108-109 | auto-desativação do mapa considera o pedido "resolvido" com produto ainda pendente — desativa cedo demais |

Achado #4 é o mais concreto de demonstrar o bug: a query já faz `GROUP BY mapa.pedido_acxe_omie, i.n_cod_prod` (agrupando por produto) mas o `WHERE` que decide se uma linha entra no CTE é um `EXISTS` de NF inteira (L422-426) — ou seja, o código **já pretendia** granularidade de produto e a query em si documenta essa intenção, só a condição de filtro ficou no nível errado.

## D5 — Padrão de UI: reaproveitar a busca por NF existente, não abrir `ConferenciaModal` direto

**Decisão**: item da fila clicado preenche `buscaNf`/dispara `handleBuscar` (já existe em `FilaOmiePage.tsx:128-132`) — não abre `ConferenciaModal` diretamente.

- `ConferenciaModal` exige `FilaItem[]` completo (produto, unidade, custo rateado, localidade — [FilaOmiePage.tsx:10-21](../../apps/web/src/pages/stockbridge/operador/FilaOmiePage.tsx)), que só existe depois da chamada OMIE ao vivo (`consultarNF`) feita pela busca por NF. O item da fila (vindo só do Postgres) não tem esses campos — abrir o modal direto exigiria uma segunda chamada OMIE de qualquer forma, então não há ganho em pular a busca.
- Ponto de encaixe visual exato: o placeholder `{!queryKey.nf && (...)}` em [FilaOmiePage.tsx:326-330](../../apps/web/src/pages/stockbridge/operador/FilaOmiePage.tsx) — substituído pela lista da fila quando há itens, mantendo os demais estados (loading, "nenhuma NF encontrada", lista de produtos) intocados.
- Padrão de interação já estabelecido no módulo (rejeições → "Re-submeter", produtos → "Receber"): item da lista tem um **botão explícito** (não o card inteiro clicável) que dispara a ação; nenhum lugar do StockBridge usa `onClick` no card todo.

## D6 — Auth: rota nova acessível a operador

**Decisão**: a fila é consumida pelo papel operador — precisa de rota/guard `requireOperador`, diferente de `GET /pendencias-fiscais` (`requireGestor`, [pendencias-fiscais.routes.ts:18](../../modules/stockbridge/src/routes/pendencias-fiscais.routes.ts)).

- Reaproveita o padrão de guard já usado por `GET /fila` (busca por NF): `requireOperador` + `requireArmazemVinculado`.
- O shape de resposta é mais enxuto que `PendenciasFiscaisData` (que carrega resumo financeiro/aging pensado para gestor) — a fila expõe só o necessário para o operador decidir o que clicar: NF, pedido, produtos totais/pendentes, quantidade pendente, dias desde emissão.

## D7 — Sem chamada OMIE nova na listagem (Princípio II)

**Decisão**: a listagem da fila é 100% leitura Postgres. A única chamada OMIE ao vivo do fluxo (`consultarNF`) continua acontecendo só quando o operador confirma a busca de uma NF específica — comportamento inalterado da feature 013.

---

## Resumo das mudanças de código (orientação para tasks)

| Área | Arquivo | Mudança |
|---|---|---|
| Checagem por produto | `fiscal-recebida-sql.ts` | `recebidaViaMovimentacaoSql` ganha parâmetro opcional de produto; nova função (ou parâmetro) para a variante "produto pendente" combinando as 3 fontes |
| Fila (query) | `recebimento.service.ts` | Caso 2 de `getFilaOmie` (hoje `return []`) implementado: query sobre mapa/filhote + espelho + checagem por produto |
| Fila (rota) | `fila.routes.ts` ou rota nova | `requireOperador`; shape de resposta enxuto |
| Cockpit Parte A/B | `cockpit.service.ts` | 3 usos (L260-261, 382-383, 405-406) passam a filtrar por produto |
| Cockpit Executivo | `cockpit-executivo.service.ts` | 1 uso (L424-425) passa a filtrar por produto |
| Pendências Fiscais | `pendencias-fiscais.service.ts` | 2 usos (L181-182, 209-210) passam a considerar granularidade de produto; `FilhoteItem`/tipo pode precisar de campo "parcial" |
| Auto-desativação do mapa | `nf-pedido-mapa.service.ts` | L108-109 passa a checar produto, não só NF |
| UI | `FilaOmiePage.tsx` | nova seção no lugar do placeholder `{!queryKey.nf}`; clique preenche `buscaNf` e dispara busca existente |
| Testes | `__tests__/*` | fila (nova), granularidade por produto nos 5 pontos, regressão do caso single-item (deve ficar idêntico) |
