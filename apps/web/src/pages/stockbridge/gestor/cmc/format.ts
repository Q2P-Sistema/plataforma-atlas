// Formatadores locais da visão de Custos (CMC). O repo não tem util central de
// formatação — cada página define os seus (ver fmtKg/fmtBrl em CockpitPage etc).
// Unidades já vêm em kg e R$/kg da fonte — sem conversão de toneladas aqui.

/** Quantidade em kg, separador de milhar, sem casas decimais. Ex.: "414.523". */
export function fmtKg(n: number): string {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

/** Valor em R$, 2 casas. Ex.: "R$ 3.011.949,69". */
export function fmtBrl(v: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

/** CMC ponderado em R$/kg (até 4 casas, como o custo unitário do recebimento).
 *  null/volume-zero → "—" (FR-008). Ex.: "R$ 7,2661/kg". */
export function fmtCmc(v: number | null): string {
  if (v == null) return '—';
  return `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}/kg`;
}

/** ISO "YYYY-MM-DD" → "DD/MM/YYYY" sem passar por Date (evita fuso). */
export function fmtDataBr(iso: string): string {
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

/** ISO "YYYY-MM-DD" → "DD/MM" (eixo de gráfico). */
export function fmtDataBrCurta(iso: string): string {
  const [, m, d] = iso.split('-');
  return d && m ? `${d}/${m}` : iso;
}
