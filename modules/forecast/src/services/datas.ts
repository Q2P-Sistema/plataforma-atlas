/**
 * Utilitários de data no fuso de operação (America/Sao_Paulo). MOD-21.
 *
 * Os containers rodam em UTC, então `Date#toISOString()` e `Date#getMonth()`
 * usam UTC e "viram o dia/mês" até 3h antes da meia-noite local (BR é UTC-3).
 * Isso desloca o dia-0 e o mês sazonal em relação ao `CURRENT_DATE` do Postgres,
 * que roda com `DB_TIMEZONE=America/Sao_Paulo` (ver memória de timezone da sessão).
 * Estas funções formatam explicitamente no fuso BR, imunes ao TZ do processo Node.
 *
 * Puras e sem dependências — testáveis diretamente.
 */

const TZ_BR = 'America/Sao_Paulo';

/** Data `YYYY-MM-DD` de um instante no fuso de operação (America/Sao_Paulo). */
export function dataLocalISO(d: Date): string {
  // 'en-CA' formata como YYYY-MM-DD; timeZone converte para o fuso BR.
  return d.toLocaleDateString('en-CA', { timeZone: TZ_BR });
}

/** Mês (1–12) de um instante no fuso de operação — sem o off-by-one de getMonth() em UTC. */
export function mesLocalBR(d: Date): number {
  return Number(dataLocalISO(d).slice(5, 7));
}
