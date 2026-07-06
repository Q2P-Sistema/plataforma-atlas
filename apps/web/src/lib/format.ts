// Formatadores pt-BR compartilhados por todos os módulos do frontend.
// Números com vírgula decimal e ponto de milhar; datas dd/mm/aaaa sem passar
// por Date (evita deslocamento de fuso). Substitui os toFixed()/datas ISO cruas
// espalhados pelas telas (auditoria pt-BR — PTB-2/3, ACXEGDP-257/258).

/** Número com N casas decimais, padrão pt-BR. Ex.: fmtNum(1234.5, 1) → "1.234,5". */
export function fmtNum(v: number, casas = 0): string {
  return v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

/** Valor em R$ com N casas. Ex.: fmtBRL(1234.5) → "R$ 1.234,50". */
export function fmtBRL(v: number, casas = 2): string {
  return `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })}`;
}

/** Percentual com N casas. Ex.: fmtPct(72.5) → "72,5%". */
export function fmtPct(v: number, casas = 1): string {
  return `${v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;
}

/** Valor em R$ compacto em milhões. Ex.: fmtBRLMi(1_234_567) → "R$ 1,23 Mi". */
export function fmtBRLMi(v: number, casas = 2): string {
  return `R$ ${(v / 1_000_000).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })} Mi`;
}

/** Valor em US$ compacto em milhões. Ex.: fmtUsdMi(1_234_567) → "US$ 1,23 Mi". */
export function fmtUsdMi(v: number, casas = 2): string {
  return `US$ ${(v / 1_000_000).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })} Mi`;
}

/** ISO "YYYY-MM-DD[...]" → "DD/MM/YYYY" (sem Date, evita fuso). */
export function fmtDataBr(iso: string): string {
  const [y, m, d] = (iso.split('T')[0] ?? iso).split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

/** ISO "YYYY-MM-DD[...]" → "DD/MM" (eixo de gráfico). */
export function fmtDataBrCurta(iso: string): string {
  const [, m, d] = (iso.split('T')[0] ?? iso).split('-');
  return d && m ? `${d}/${m}` : iso;
}

const MESES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** ISO "YYYY-MM[-DD]" → "jul/2026". */
export function fmtMesRef(iso: string): string {
  const [y, m] = iso.split('-');
  const idx = Number(m) - 1;
  return MESES_ABREV[idx] && y ? `${MESES_ABREV[idx]}/${y}` : iso;
}
