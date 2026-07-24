import { getPool, createLogger } from '@atlas/core';

const logger = createLogger('stockbridge:correlacao');

export interface Correlacao {
  codigoProdutoAcxe: number;
  codigoProdutoQ2p: number;
  descricao: string;
  codigoLocalEstoqueAcxe: number;
  codigoLocalEstoqueQ2p: number;
}

export class CorrelacaoNaoEncontradaError extends Error {
  // ACXEGDP-313: a mensagem identifica produto/local por descrição — os códigos
  // OMIE (numéricos, 10 dígitos) não significam nada para o operador e ficam
  // apenas nos campos estruturados (logs/e-mail).
  constructor(
    public readonly codigoProdutoAcxe: number,
    public readonly codigoLocalEstoqueAcxe: number,
    contexto?: { produtoLabel?: string | null; localLabel?: string | null },
  ) {
    const produto = contexto?.produtoLabel?.trim()
      ? `"${contexto.produtoLabel.trim()}"`
      : 'da NF (não identificado no cadastro ACXE)';
    const local = contexto?.localLabel?.trim() ?? 'não identificado';
    super(
      `Produto ${produto} não tem correlato na Q2P (match por descrição). ` +
        `Cadastre o produto na Q2P com a descrição exata e tente o recebimento novamente. ` +
        `Local de estoque destino: ${local}.`,
    );
    this.name = 'CorrelacaoNaoEncontradaError';
  }
}

/**
 * ACXEGDP-313: resolve rótulos legíveis (descrição do produto + código/nome do
 * local) para compor a mensagem de erro ao usuário. Best-effort — se a consulta
 * falhar, o erro sai com os fallbacks genéricos e os códigos seguem só no log.
 */
async function resolverContextoLegivel(
  codigoProdutoAcxe: number,
  codigoLocalEstoqueAcxe: number,
): Promise<{ produtoLabel: string | null; localLabel: string | null }> {
  try {
    const pool = getPool();
    const result = await pool.query(
      `
      SELECT
        (SELECT p.descricao FROM public."tbl_produtos_ACXE" p
          WHERE p.codigo_produto = $1 LIMIT 1) AS produto_label,
        (SELECT l.codigo || ' — ' || l.descricao FROM public."tbl_locaisEstoques_ACXE" l
          WHERE l.codigo_local_estoque = $2 LIMIT 1) AS local_label
      `,
      [codigoProdutoAcxe, codigoLocalEstoqueAcxe],
    );
    const row = result.rows[0] as { produto_label?: string | null; local_label?: string | null } | undefined;
    return { produtoLabel: row?.produto_label ?? null, localLabel: row?.local_label ?? null };
  } catch (err) {
    logger.warn({ err, codigoProdutoAcxe, codigoLocalEstoqueAcxe }, 'Falha ao resolver contexto legível do erro de correlação');
    return { produtoLabel: null, localLabel: null };
  }
}

/**
 * Resolve correlacao de produto ACXE ↔ Q2P via match textual da descricao (clarificacao Q6).
 * Tambem retorna os codigos de local de estoque correspondentes (ACXE ↔ Q2P).
 *
 * Query combina:
 * - public.tb_produtos_ACXE × public.tb_produtos_Q2P por descricao
 * - stockbridge.localidade_correlacao para achar o par de localidades
 *
 * Lanca CorrelacaoNaoEncontradaError se produto nao existe na Q2P OU localidade nao mapeada.
 */
export async function getCorrelacao(
  codigoProdutoAcxe: number,
  codigoLocalEstoqueAcxe: number,
): Promise<Correlacao> {
  const pool = getPool();
  const sql = `
    SELECT
      a.codigo_produto  AS codigo_produto_acxe,
      q.codigo_produto  AS codigo_produto_q2p,
      a.descricao,
      c.codigo_local_estoque_acxe,
      c.codigo_local_estoque_q2p
    FROM public."tbl_produtos_ACXE" a
    INNER JOIN public."tbl_produtos_Q2P" q ON a.descricao = q.descricao
    INNER JOIN stockbridge.localidade_correlacao c
      ON c.codigo_local_estoque_acxe = $2
    WHERE a.codigo_produto = $1
      AND (a.inativo IS NULL OR a.inativo <> 'S')
      AND (q.inativo IS NULL OR q.inativo <> 'S')
    -- STK-22: quando >1 produto Q2P casa a mesma descricao, LIMIT 1 sem ORDER BY
    -- escolhia arbitrariamente (não-determinístico entre execuções/planos). ORDER
    -- BY estável fixa a escolha no menor codigo Q2P. Sem efeito no caso 1:1 comum.
    ORDER BY q.codigo_produto ASC
    LIMIT 1
  `;
  const result = await pool.query(sql, [codigoProdutoAcxe, codigoLocalEstoqueAcxe]);
  if (result.rows.length === 0) {
    logger.warn(
      { codigoProdutoAcxe, codigoLocalEstoqueAcxe },
      'Correlação ACXE→Q2P não encontrada',
    );
    throw new CorrelacaoNaoEncontradaError(
      codigoProdutoAcxe,
      codigoLocalEstoqueAcxe,
      await resolverContextoLegivel(codigoProdutoAcxe, codigoLocalEstoqueAcxe),
    );
  }

  const row = result.rows[0] as {
    codigo_produto_acxe: number;
    codigo_produto_q2p: number;
    descricao: string;
    codigo_local_estoque_acxe: number;
    codigo_local_estoque_q2p: number;
  };

  return {
    codigoProdutoAcxe: Number(row.codigo_produto_acxe),
    codigoProdutoQ2p: Number(row.codigo_produto_q2p),
    descricao: row.descricao,
    codigoLocalEstoqueAcxe: Number(row.codigo_local_estoque_acxe),
    codigoLocalEstoqueQ2p: Number(row.codigo_local_estoque_q2p),
  };
}
