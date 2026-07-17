# Phase 1 — Data Model: Fila de Recebimento em Modo Real + Correção de Granularidade

**Feature**: 014-fila-recebimento-real | **Date**: 2026-07-16

> **Nenhuma tabela nova, nenhuma migration.** Os "modelos" abaixo são a extensão de uma função SQL compartilhada e os tipos TypeScript de leitura consumidos pela fila e pelos 5 pontos corrigidos.

---

## 1. `fiscal-recebida-sql.ts` — extensão da checagem existente

**Antes**: `recebidaViaMovimentacaoSql(nfExpr: string): string` — EXISTS por NF inteira.

**Depois**:

```typescript
/**
 * Recebimento de importação registrado no Atlas, por PRODUTO quando `produtoExpr`
 * é informado (feature 014) — o único caminho com granularidade real, pois
 * stockbridge.movimentacao tem produto_codigo_acxe desde sempre e é o único
 * caminho capaz de multi-produto (feature 013). Sem `produtoExpr`, comportamento
 * idêntico ao anterior (compatibilidade com os usos que ainda checam por NF).
 */
export function recebidaViaMovimentacaoSql(nfExpr: string, produtoExpr?: string): string {
  const produtoFiltro = produtoExpr ? ` AND m.produto_codigo_acxe = ${produtoExpr}` : '';
  return `EXISTS (SELECT 1 FROM stockbridge.movimentacao m
              WHERE m.ativo = true AND m.subtipo = 'importacao' AND m.nota_fiscal = ${nfExpr}${produtoFiltro})`;
}

// recebidaViaLegadoSql inalterada — movimentacao_legado não tem coluna de produto
// (histórico congelado da migração única, pré-Atlas — ver research.md D3).
```

**Nova função combinada** — "produto pendente" (nome sugerido: `produtoPendenteRecebimentoSql`), usada pela fila e pelos 5 pontos corrigidos:

```typescript
/**
 * Produto (de uma NF filhote) ainda pendente de recebimento — o inverso de
 * "recebido", combinando as 3 fontes na granularidade que cada uma permite:
 *  - stockbridge.movimentacao: por PRODUTO (a correção desta feature)
 *  - movimentacao_legado + n_id_receb (OMIE): por NF inteira (limitação de dado,
 *    documentada — ver research.md D3). Um match aqui marca TODOS os produtos
 *    daquela NF como recebidos (mesmo comportamento de antes para esses 2 sinais).
 */
export function produtoPendenteSql(args: {
  nfExpr: string;          // ex.: "LPAD(f.nf_filhote, 8, '0')"
  produtoExpr: string;     // ex.: "i.n_cod_prod"
  nIdRecebExpr: string;    // ex.: "h.n_id_receb"
}): string {
  return `NOT (
    ${args.nIdRecebExpr} > 0
    OR ${recebidaViaLegadoSql(args.nfExpr)}
    OR ${recebidaViaMovimentacaoSql(args.nfExpr, args.produtoExpr)}
  )`;
}
```

---

## 2. Fila de recebimento — tipo de resposta (novo)

`FilaQueueItem` (backend, `recebimento.service.ts`, e espelhado no frontend):

```typescript
export interface FilaQueueItem {
  nfFilhote: string;          // número da NF filhote (não zero-padded — forma de exibição)
  pedidoAcxeOmie: string;     // pedido de compra associado (contexto p/ o operador)
  produtosTotal: number;      // quantos produtos a NF tem no total
  produtosPendentes: number;  // quantos ainda faltam (1 = igual a produtosTotal → nada recebido ainda)
  quantidadePendenteKg: number; // soma dos produtos pendentes
  dtEmissao: string;          // para ordenação e exibição de aging
  diasDesdeEmissao: number;
}

export interface FilaQueueResponse {
  itens: FilaQueueItem[];
}
```

Nota: **não** é `FilaItem` (o tipo usado pela busca-por-NF, que tem produto/unidade/custo por item — só existe após a chamada OMIE). `FilaQueueItem` é um resumo por NF, o suficiente para o operador decidir o que clicar; ao clicar, o fluxo existente (busca por NF) produz o `FilaItem[]` de verdade.

---

## 3. `pendencias-fiscais.service.ts` — `FilhoteItem` ganha status parcial

**Antes**: `recebida: boolean`.

**Depois**: mantém `recebida: boolean` (compatibilidade com a UI atual — `true` só quando **todos** os produtos da filhote estão recebidos) e adiciona:

```typescript
export interface FilhoteItem {
  // ...campos existentes...
  recebida: boolean;                 // true SOMENTE se todos os produtos estão recebidos
  produtosTotal: number;             // novo
  produtosRecebidos: number;         // novo — permite a UI mostrar "2 de 3"
}
```

`statusAgregado` do pedido (`'recebida' | 'parcial' | 'pendente'`) não muda de shape — só passa a refletir corretamente o caso em que uma filhote está parcialmente recebida (hoje contava como recebida cedo demais).

---

## 4. Invariantes

- **INV-1**: para qualquer NF single-item (produto único), o resultado de `produtoPendenteSql`/`recebidaViaMovimentacaoSql` é idêntico ao comportamento anterior à esta feature — guarda de regressão (SC-005 da spec).
- **INV-2**: a fila nunca lista a NF mãe de um mapa (filtro estrutural: só itera `nf_pedido_filhote`, nunca `nf_pedido_mapa.nf_mae` diretamente).
- **INV-3**: `produtosPendentes ≤ produtosTotal` sempre; `produtosPendentes = 0` implica que a NF não deveria aparecer na fila (filtrada antes).
- **INV-4**: nenhuma linha de `nf_pedido_mapa`/`nf_pedido_filhote` é escrita por esta feature — 100% leitura.
