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
  constructor(
    public readonly codigoProdutoAcxe: number,
    public readonly codigoLocalEstoqueAcxe: number,
  ) {
    super(
      `Produto ACXE ${codigoProdutoAcxe} nao tem correlato na Q2P (match por descricao). ` +
        `Local de estoque destino: ${codigoLocalEstoqueAcxe}.`,
    );
    this.name = 'CorrelacaoNaoEncontradaError';
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
    LIMIT 1
  `;
  const result = await pool.query(sql, [codigoProdutoAcxe, codigoLocalEstoqueAcxe]);
  if (result.rows.length === 0) {
    logger.warn(
      { codigoProdutoAcxe, codigoLocalEstoqueAcxe },
      'Correlacao ACXE→Q2P nao encontrada',
    );
    throw new CorrelacaoNaoEncontradaError(codigoProdutoAcxe, codigoLocalEstoqueAcxe);
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
