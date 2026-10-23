/**
 * Entrada nacional "nas duas empresas" (feature 017, Historia 5 — ACXEGDP-437).
 *
 * A compra nacional da ACXE em estoque que tambem e da Q2P (11.1, 12.1, 21.1, 31.1) lanca a
 * entrada na ACXE E na Q2P, pelo mesmo valor unitario (sem o x1,145 da importacao). Nao existe
 * coluna para isso: a marca e derivada dos dados que o POST por NF grava (`movimentacao` e
 * `aprovacao` carregam os mesmos campos), e este e o UNICO lugar que a define — aprovacao,
 * retry da perna Q2P e listagens perguntam aqui.
 *
 * Modulo puro (sem imports): o retry de operacoes-pendentes o usa sem puxar o aprovacao.service
 * (que os testes dele substituem por mock parcial).
 */

/** Campos que identificam a entrada; `movimentacao` traz `subtipo`, `aprovacao` traz `tipoAprovacao`. */
export interface LinhaEntradaNacional {
  /** movimentacao.subtipo — 'compra_nacional' */
  subtipo?: string | null;
  /** aprovacao.tipo_aprovacao — 'entrada_manual' (a aprovacao nao tem subtipo) */
  tipoAprovacao?: string | null;
  empresa: string | null;
  /** NF do espelho (a entrada pelo formulario manual nao tem chave de acesso) */
  nfChaveAcesso: string | null;
  /** na NF da ACXE so e gravado quando o estoque tambem e da Q2P: o "gemeo" do produto da ACXE */
  produtoCodigoQ2p: number | string | null;
}

/**
 * compra nacional da ACXE, por NF, com produto da Q2P gravado = a entrada vale nas duas empresas.
 * O formulario manual (sem chave de acesso) nunca e espelhado, mesmo com os dois codigos no corpo.
 */
export function entradaNacionalEspelhada(row: LinhaEntradaNacional): boolean {
  const compraNacional = row.subtipo !== undefined ? row.subtipo === 'compra_nacional' : row.tipoAprovacao === 'entrada_manual';
  return compraNacional && row.empresa === 'acxe' && !!row.nfChaveAcesso && row.produtoCodigoQ2p != null;
}
