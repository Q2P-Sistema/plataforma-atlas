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

/**
 * Recebimento de importação registrado no Atlas (`stockbridge.movimentacao`).
 *
 * Feature 014 (ACXEGDP-299): com `produtoExpr`, a checagem é por PRODUTO —
 * `stockbridge.movimentacao` tem `produto_codigo_acxe` e é o único caminho capaz
 * de multi-produto (feature 013), então é o único onde a granularidade fina é
 * real. Sem `produtoExpr`, comportamento idêntico ao anterior (por NF inteira).
 * Necessário porque uma NF multi-produto pode ficar PARCIALMENTE recebida
 * (recebimento resumível) — o EXISTS por NF marcava a NF toda como recebida com
 * 1 de N produtos, sumindo pendências do cockpit/pendências fiscais.
 */
export function recebidaViaMovimentacaoSql(nfExpr: string, produtoExpr?: string): string {
  const produtoFiltro = produtoExpr ? `
                AND m.produto_codigo_acxe = ${produtoExpr}` : '';
  return `EXISTS (SELECT 1 FROM stockbridge.movimentacao m
              WHERE m.ativo = true AND m.subtipo = 'importacao' AND m.nota_fiscal = ${nfExpr}${produtoFiltro})`;
}

/**
 * Recebimento no histórico migrado do MySQL legado (`stockbridge.movimentacao_legado`).
 * SEMPRE por NF: a tabela não tem coluna de produto (histórico congelado da
 * migração única, de uma época em que toda NF tinha 1 produto) — não há como
 * refinar retroativamente (feature 014, limitação de dado documentada).
 */
export function recebidaViaLegadoSql(nfExpr: string): string {
  return `EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml
              WHERE ml.ativo = true AND ml.nota_fiscal = ${nfExpr})`;
}

/**
 * Feature 014 (ACXEGDP-299): produto de uma NF de importação ainda PENDENTE de
 * recebimento — o inverso de "recebido", combinando as 3 fontes na granularidade
 * que cada uma permite:
 *  - `n_id_receb > 0` (OMIE) e legado: por NF inteira — um match marca TODOS os
 *    produtos daquela NF como recebidos (campo de cabeçalho / dado sem produto);
 *  - `stockbridge.movimentacao`: por PRODUTO (a correção desta feature).
 *
 * `nfExpr` zero-padded 8 díg (ex.: `LPAD(f.nf_filhote, 8, '0')`); `produtoExpr`
 * ex.: `i.n_cod_prod`; `nIdRecebExpr` ex.: `h.n_id_receb`.
 */
export function produtoPendenteSql(args: {
  nfExpr: string;
  produtoExpr: string;
  nIdRecebExpr: string;
}): string {
  return `NOT (
    COALESCE(${args.nIdRecebExpr}, 0) > 0
    OR ${recebidaViaLegadoSql(args.nfExpr)}
    OR ${recebidaViaMovimentacaoSql(args.nfExpr, args.produtoExpr)}
  )`;
}

/**
 * Filtro "NF fiscalmente válida" (ACXEGDP-183/184) — contrato com o sync n8n.
 *
 * Exclui do cálculo de pendência fiscal NFs que não são documentos válidos:
 *  - `deletada = true`  → NF que SUMIU do OMIE (reconciliação por desaparecimento);
 *  - `cancelada = true` → NF que CONTINUA no OMIE mas está fiscalmente inválida
 *    (cancelada/inutilizada/denegada, lida de ide.dCan/dInut/cDeneg). Coluna sticky,
 *    SEPARADA de `deletada` (sync ACXEGDP-184, nas 3 empresas).
 *
 * As duas são independentes; aplicamos ambas. Sem isto, uma NF inválida (ex.:
 * importação cancelada CFOP 3 sem mapa) conta como Pendência para sempre. Usado
 * na Parte A (filhote recebida), Parte B (fallback) e Pendência Nacional do
 * cockpit, e no serviço de pendências-fiscais.
 *
 * `cancelada` é recente e pode NÃO existir (o sync PROD→UAT recria `public.*` e
 * pode dropá-la, como já acontece com os grants). Por isso o predicado de
 * `cancelada` só é emitido quando a coluna existe — ver `colunaCanceladaExiste`.
 * `deletada` é coluna estável (sempre presente) e é sempre filtrada. Inerte
 * quando `cancelada` ausente: a query roda igual e o cockpit não quebra (sem a
 * guarda, o `catch` devolveria vazio).
 */
export function nfValidaSql(canceladaExiste: boolean, alias = 'h'): string {
  const naoDeletada = `AND COALESCE(${alias}.deletada, false) = false`;
  return canceladaExiste
    ? `${naoDeletada} AND COALESCE(${alias}.cancelada, false) = false`
    : naoDeletada;
}

/** Pool mínimo (estrutural) — evita acoplar ao tipo concreto de `pg`. */
type QueryablePool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

/**
 * `true` se a coluna `cancelada` existe na tabela-espelho de NF informada.
 * Resolvido em runtime (um SELECT barato em `information_schema`) para tolerar
 * a coluna sumir após um sync PROD→UAT. Em erro, retorna `false` (fail-safe:
 * nenhum filtro é aplicado, comportamento idêntico ao de antes do contrato).
 */
export async function colunaCanceladaExiste(
  pool: QueryablePool,
  tabela = 'tbl_nf_header_ACXE',
): Promise<boolean> {
  try {
    const r = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'cancelada'
       ) AS ok`,
      [tabela],
    );
    return (r.rows as Array<{ ok?: boolean }>)[0]?.ok === true;
  } catch {
    return false;
  }
}
