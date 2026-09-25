/**
 * Normalizacao da descricao do item da NF (feature 015, ACXEGDP-328).
 *
 * E a chave de tudo que amarra uma movimentacao a linha da NF que a originou:
 * 97,5% dos itens nao tem codigo de produto, entao a descricao do fornecedor e
 * a unica identidade da linha (research D20). A mesma regra roda em SQL na
 * query da fila (`normalizarDescricaoSql` em fiscal-recebida-sql.ts) — as duas
 * PRECISAM produzir o mesmo resultado, senao o que o Atlas gravou nunca casa
 * com o espelho. `descricao-nf.test.ts` prova a paridade em amostras reais.
 *
 * Regra (data-model §1.1): trim -> colapsa espacos internos -> caixa alta ->
 * remove acentuacao. Sem fuzzy: com 2,5% de variacao puramente formatal
 * (research D8), fuzzy arriscaria sugerir o produto errado num fluxo que move
 * estoque e dinheiro.
 */
export function normalizarDescricaoNf(raw: string | null | undefined): string {
  return (raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}
