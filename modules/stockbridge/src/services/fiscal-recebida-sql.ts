/**
 * Definição canônica de "NF de importação recebida fora do OMIE" (FR-013 / ACXEGDP-183).
 *
 * O critério de "filhote recebida" é `n_id_receb > 0` (OMIE) **OU** consta em
 * `stockbridge.movimentacao` (subtipo='importacao') **OU** em `stockbridge.movimentacao_legado`.
 * A parte OMIE (`n_id_receb`) fica inline em cada query (depende do alias do header).
 * As duas fontes Atlas/legado — propensas a drift (nome de tabela, subtipo, flag ativo) —
 * são centralizadas AQUI e reusadas por:
 *   - cockpit.service.ts        (Parte A saldo + Parte B fallback)
 *   - pendencias-fiscais.service.ts (detalhe por filhote + seção sem-mapa)
 *   - nf-pedido-mapa.service.ts  (auto-desativação do mapa)
 *
 * `nfExpr` é a expressão SQL com o número da NF zero-padded 8 díg — ex.: `h.n_nf`
 * (já padded) ou `LPAD(f.nf_filhote, 8, '0')`.
 */

/** Recebimento de importação registrado no Atlas (`stockbridge.movimentacao`). */
export function recebidaViaMovimentacaoSql(nfExpr: string): string {
  return `EXISTS (SELECT 1 FROM stockbridge.movimentacao m
              WHERE m.ativo = true AND m.subtipo = 'importacao' AND m.nota_fiscal = ${nfExpr})`;
}

/** Recebimento no histórico migrado do MySQL legado (`stockbridge.movimentacao_legado`). */
export function recebidaViaLegadoSql(nfExpr: string): string {
  return `EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml
              WHERE ml.ativo = true AND ml.nota_fiscal = ${nfExpr})`;
}
