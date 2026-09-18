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
export function recebidaViaMovimentacaoSql(
  nfExpr: string,
  produtoExpr?: string,
  opts: RecebidaViaMovimentacaoOpts = {},
): string {
  // Feature 015 (ACXEGDP-328): parametrizado em subtipo e coluna de produto. Os
  // defaults reproduzem BYTE A BYTE o SQL de antes — os 5 servicos consumidores
  // (cockpit, cockpit-executivo, pendencias-fiscais, nf-pedido-mapa, recebimento)
  // nao mudam de resultado (fiscal-recebida-regressao.test.ts).
  const subtipo = opts.subtipo ?? 'importacao';
  const colunaProduto = opts.colunaProduto ?? 'produto_codigo_acxe';
  const produtoFiltro = produtoExpr ? `
                AND m.${colunaProduto} = ${produtoExpr}` : '';
  return `EXISTS (SELECT 1 FROM stockbridge.movimentacao m
              WHERE m.ativo = true AND m.subtipo = '${subtipo}' AND m.nota_fiscal = ${nfExpr}${produtoFiltro})`;
}

/**
 * Feature 015: o caminho nacional grava o produto em `produto_codigo_q2p` (as 144
 * movimentacoes existentes tem `produto_codigo_acxe` NULL — fluxo single-empresa)
 * e usa `subtipo = 'compra_nacional'`. Reusar a funcao acima como esta erraria nos
 * dois predicados e devolveria "nunca recebida" para 100% das NFs nacionais (D11).
 */
export type RecebidaViaMovimentacaoOpts = {
  subtipo?: 'importacao' | 'compra_nacional';
  colunaProduto?: 'produto_codigo_acxe' | 'produto_codigo_q2p';
};

/**
 * Normalizacao de descricao em SQL — a MESMA regra de `normalizarDescricao` em TS
 * (trim, espacos colapsados, caixa alta, sem acento), para casar o `x_prod` do
 * espelho com `nf_item_descricao_normalizada` gravado pelo Atlas. Exige a extensao
 * `unaccent` (criada na migration 0052).
 */
export function normalizarDescricaoSql(expr: string): string {
  return `upper(regexp_replace(btrim(unaccent(${expr})), '\\s+', ' ', 'g'))`;
}

/**
 * Feature 015 (ACXEGDP-328): item de NF NACIONAL ja recebido — checagem em DUAS
 * VIAS mais a baixa externa (data-model §3.1, research D21):
 *
 *  1. Caminho novo: movimentacao com `nf_chave_acesso` + descricao normalizada do
 *     item. Granularidade por linha da NF (97,5% dos itens nao tem codigo de
 *     produto — a descricao e a unica identidade da linha).
 *  2. Historico do formulario manual (145 linhas) e tudo que ele criar daqui em
 *     diante (NF fora do espelho nunca tera chave): casa por NUMERO sem zeros a
 *     esquerda + empresa. Por NF inteira — o manual nao guarda a linha de origem.
 *     `subtipo = 'compra_nacional'` NAO e opcional: sem ele o ramo casa com as
 *     saidas automaticas da Q2P, que tambem gravam nota_fiscal + empresa sem chave,
 *     e uma NF de compra pendente sumiria da fila.
 *     Cobertura medida ~90% (5% de numeros inexistentes no espelho, 5% ambiguos);
 *     o resto e o motivo de existir o recebimento_externo (via 3).
 *  3. Baixa externa APROVADA para (chave, descricao normalizada) — o item entrou
 *     fora do Atlas (ex.: direto no OMIE). Sem movimentacao, so a aprovacao.
 *
 * `chaveExpr` ex.: `h.c_chave_nfe`; `descricaoExpr` = expressao JA normalizada
 * (ex.: `normalizarDescricaoSql('i.x_prod')`); `nfNumeroExpr` ex.: `h.n_nf`.
 */
export function itemNacionalRecebidoSql(args: {
  chaveExpr: string;
  descricaoNormalizadaExpr: string;
  nfNumeroExpr: string;
}): string {
  return `(
    EXISTS (SELECT 1 FROM stockbridge.movimentacao m
              WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
                AND m.nf_chave_acesso = ${args.chaveExpr}
                AND m.nf_item_descricao_normalizada = ${args.descricaoNormalizadaExpr})
    OR EXISTS (SELECT 1 FROM stockbridge.movimentacao m
              WHERE m.ativo = true AND m.subtipo = 'compra_nacional'
                AND m.nf_chave_acesso IS NULL
                AND m.empresa = 'q2p'
                AND ltrim(m.nota_fiscal, '0') = ltrim(${args.nfNumeroExpr}, '0'))
    OR EXISTS (SELECT 1 FROM stockbridge.aprovacao a
              WHERE a.tipo_aprovacao = 'recebimento_externo' AND a.status = 'aprovada'
                AND a.nf_chave_acesso = ${args.chaveExpr}
                AND ${normalizarDescricaoSql('a.nf_item_descricao')} = ${args.descricaoNormalizadaExpr})
  )`;
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
