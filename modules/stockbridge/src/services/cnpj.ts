/**
 * CNPJ/CPF do cadastro de fornecedores do OMIE (feature 017, ACXEGDP-437).
 *
 * A mesma empresa pode ter um cadastro por filial no OMIE, e compras pode lancar
 * o pedido de compra no cadastro da matriz (NF 60199 x PC 306, Zaraplast). A
 * raiz do CNPJ (8 primeiros digitos) identifica a empresa; o cadastro, o CNPJ
 * inteiro.
 */

/**
 * Mascara CNPJ (14 digitos -> 00.000.000/0000-00) ou CPF (11 -> 000.000.000-00).
 * Aceita o valor ja mascarado. Qualquer outro tamanho devolve '' — nunca inventa
 * mascara nem exibe um numero que nao e documento (ex.: codigo interno do OMIE).
 */
export function fmtCnpj(valor: string | null | undefined): string {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  if (digitos.length === 14) return digitos.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (digitos.length === 11) return digitos.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return '';
}

/** Raiz do CNPJ (8 primeiros digitos, a empresa); null para CPF, vazio ou outro tamanho. */
export function raizCnpj(valor: string | null | undefined): string | null {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  return digitos.length === 14 ? digitos.slice(0, 8) : null;
}
