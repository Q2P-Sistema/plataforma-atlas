/**
 * MOD-08 (ACXEGDP-278): helpers de data CIVIL para o hedge.
 *
 * `new Date('YYYY-MM-DD')` interpreta a string como meia-noite UTC; em
 * America/Sao_Paulo os getters locais retornam o dia ANTERIOR (21h). Efeitos
 * observados: NDF com vencimento dia 1o caia no bucket do mes anterior, e NDF
 * vencendo HOJE era rejeitado como "data futura".
 */

/** 'YYYY-MM-DD' → Date a meia-noite LOCAL (retorna Invalid Date para entrada malformada). */
export function parseDataCivilLocal(data: string): Date {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(data));
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Data de HOJE no fuso LOCAL como 'YYYY-MM-DD' (toISOString e UTC: apos 21h local "vira o dia"). */
export function hojeLocalISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
