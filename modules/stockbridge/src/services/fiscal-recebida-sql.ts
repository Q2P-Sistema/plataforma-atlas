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

/**
 * Filtro "NF não cancelada" (ACXEGDP-183) — contrato com o sync n8n.
 *
 * O sync de NF (workflows "FullSync NF Itens Semanal") passa a marcar
 * `tbl_nf_header_<EMP>.cancelada = true` para NFs canceladas no OMIE (que o
 * `ListarNF` continua devolvendo — não somem, então a reconciliação por
 * desaparecimento nunca as pegava). Sem este filtro, uma importação cancelada
 * (CFOP 3, sem mapa, sem recebimento) conta como Pendência de Importação para
 * sempre. Aplicado na Parte A (filhote recebida) e Parte B (fallback) do cockpit
 * e no serviço de pendências-fiscais.
 *
 * A coluna pode NÃO existir (o sync PROD→UAT recria `public.*` e pode dropá-la,
 * como já acontece com os grants). Por isso o predicado só é emitido quando a
 * coluna existe — ver `colunaCanceladaExiste`. Inerte quando ausente: a query
 * roda igual e o cockpit não quebra (sem a guarda, o `catch` devolveria vazio).
 */
export function naoCanceladaSql(existe: boolean, alias = 'h'): string {
  return existe ? `AND COALESCE(${alias}.cancelada, false) = false` : '';
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
