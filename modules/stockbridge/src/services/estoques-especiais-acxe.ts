/**
 * Codigos hardcoded de estoques ACXE usados no fluxo de divergencia.
 * Herdados do legado PHP (NotaFiscalService linhas 217, 403, 442).
 *
 * Quando ha divergencia em um recebimento, a quantidade RECEBIDA vai para o
 * galpao destino escolhido pelo operador, e a DIFERENCA (qtd NF - qtd recebida)
 * vai para um destes estoques especiais conforme o tipo escolhido:
 *
 *  - 'faltando'  → ACXE-COMEX-FALTANDO (material que sumiu / nao chegou)
 *  - 'varredura' → ACXE-MG-EX4-VAR ou estoque de varredura nao-Extrema
 *
 * Para 'varredura' o legado escolhe entre dois codigos com base em se o
 * destino do recebimento e o proprio Extrema (4004166399) ou outro galpao.
 */

/** Codigo do estoque "Extrema" — onde NFs de importacao caem por padrao na ACXE. */
export const ACXE_EXTREMA = '4004166399';

/** Estoque para material em falta (sumiu/nao chegou). */
export const ACXE_COMEX_FALTANDO = '4506855468';

/** Estoque de varredura quando o destino do recebimento e Extrema. */
export const ACXE_VARREDURA_EXTREMA = '4504071362';

/** Estoque de varredura quando o destino do recebimento NAO e Extrema. */
export const ACXE_VARREDURA_NAO_EXTREMA = '4506526722';

export type TipoDivergencia = 'faltando' | 'varredura';

/**
 * Resolve o codigo do estoque ACXE que receberá a parcela DIVERGENTE
 * (qtd_NF - qtd_recebida) com base no tipo de divergencia escolhido pelo
 * operador e no galpao destino do recebimento.
 */
export function resolverEstoqueDiferencaAcxe(args: {
  tipoDivergencia: TipoDivergencia;
  codigoLocalEstoqueDestinoAcxe: number | string;
}): string {
  if (args.tipoDivergencia === 'faltando') {
    return ACXE_COMEX_FALTANDO;
  }
  // varredura
  return String(args.codigoLocalEstoqueDestinoAcxe) === ACXE_EXTREMA
    ? ACXE_VARREDURA_EXTREMA
    : ACXE_VARREDURA_NAO_EXTREMA;
}
