import { getPool } from '@atlas/core';

/**
 * "Gemeo" Q2P de um produto da ACXE (feature 017, Historia 5 — ACXEGDP-437).
 *
 * A compra nacional da ACXE entra em estoque que tambem e da Q2P (11.1, 12.1, 21.1, 31.1)
 * pelo mesmo valor nas duas empresas; para isso o produto da ACXE precisa ter um
 * correspondente no cadastro da Q2P. A correlacao ACXE -> Q2P e por descricao IDENTICA
 * (clarificacao Q6 da 007), a MESMA regra de `getCorrelacao` (correlacao.service.ts):
 *  - o produto Q2P tem de estar ATIVO (`inativo` nulo ou diferente de 'S');
 *  - igualdade exata da descricao (sem trim nem caixa);
 *  - havendo mais de um, o de MENOR codigo (STK-22: escolha deterministica);
 *  - o gemeo tem de ser controlado em KG, como o recebimento lanca (revisao da Fase 2: o catalogo da ACXE tem
 *    259 de 475 produtos ativos fora de KG — cabos, cimento, material de escritorio).
 * `resolverCodigoProdutoOmie` (omie-saida.service.ts) NAO serve aqui: nao filtra inativos.
 *
 * So le o espelho Postgres (Principio II): `tbl_produtos_ACXE` e `tbl_produtos_Q2P`. Sem gemeo
 * o produto so pode entrar em local so da ACXE (20.0.5, 20.0.7, 21.2) — o detalhe da NF marca
 * `semCorrelatoQ2p` e o POST recusa antes do fiscal (422 PRODUTO_SEM_CORRELATO_Q2P).
 */

export interface GemeoQ2p {
  /** codigo_produto no OMIE da Q2P — vai para `movimentacao.produto_codigo_q2p` */
  codigo: number;
  descricao: string;
}

export interface ProdutoAcxeComGemeo {
  /** codigo_produto no OMIE da ACXE */
  codigoAcxe: number;
  descricaoAcxe: string;
  /** o produto da ACXE esta ativo no cadastro (`inativo` nulo ou diferente de 'S') */
  ativoAcxe: boolean;
  /** unidade do produto da ACXE no cadastro, aparada e em caixa alta ('' sem unidade) */
  unidadeAcxe: string;
  /** o produto da ACXE e controlado em KG — o recebimento lanca a quantidade em kg */
  emKgAcxe: boolean;
  /** produto Q2P ativo de mesma descricao (o de menor codigo); null = sem gemeo */
  gemeoQ2p: GemeoQ2p | null;
}

/**
 * Para cada codigo de produto da ACXE encontrado em `tbl_produtos_ACXE`, o produto e o seu
 * gemeo Q2P. Codigo que nao existe no cadastro fica FORA do mapa (quem chama decide: no POST,
 * 404 PRODUTO_NAO_ENCONTRADO). Lanca em falha de banco.
 */
export async function resolverGemeosQ2p(codigosAcxe: number[]): Promise<Map<number, ProdutoAcxeComGemeo>> {
  const out = new Map<number, ProdutoAcxeComGemeo>();
  const codigos = Array.from(new Set(codigosAcxe.filter((n) => Number.isFinite(n) && n > 0)));
  if (codigos.length === 0) return out;
  const r = await getPool().query<{
    codigo_acxe: string;
    descricao_acxe: string | null;
    ativo_acxe: boolean;
    unidade_acxe: string | null;
    codigo_q2p: string | null;
    descricao_q2p: string | null;
  }>(
    `SELECT a.codigo_produto::text AS codigo_acxe, a.descricao AS descricao_acxe,
            (a.inativo IS NULL OR a.inativo <> 'S') AS ativo_acxe,
            upper(btrim(COALESCE(a.unidade, ''))) AS unidade_acxe,
            g.codigo_produto::text AS codigo_q2p, g.descricao AS descricao_q2p
       FROM public."tbl_produtos_ACXE" a
       LEFT JOIN LATERAL (
         SELECT q.codigo_produto, q.descricao
           FROM public."tbl_produtos_Q2P" q
          WHERE q.descricao = a.descricao
            AND (q.inativo IS NULL OR q.inativo <> 'S')
            AND upper(btrim(COALESCE(q.unidade, ''))) = 'KG'
          ORDER BY q.codigo_produto ASC
          LIMIT 1
       ) g ON true
      WHERE a.codigo_produto = ANY($1::bigint[])`,
    [codigos],
  );
  for (const x of r.rows) {
    const codigoAcxe = Number(x.codigo_acxe);
    const codigoQ2p = x.codigo_q2p != null ? Number(x.codigo_q2p) : null;
    out.set(codigoAcxe, {
      codigoAcxe,
      descricaoAcxe: x.descricao_acxe ?? '',
      ativoAcxe: x.ativo_acxe === true,
      unidadeAcxe: x.unidade_acxe ?? '',
      emKgAcxe: (x.unidade_acxe ?? '') === 'KG',
      gemeoQ2p: codigoQ2p != null && Number.isFinite(codigoQ2p) ? { codigo: codigoQ2p, descricao: x.descricao_q2p ?? '' } : null,
    });
  }
  return out;
}
