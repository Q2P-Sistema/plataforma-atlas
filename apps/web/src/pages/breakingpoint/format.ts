/**
 * Formatadores compartilhados do Breaking Point (UI-E, ACXEGDP-265).
 *
 * Antes havia 4 cópias de fmtMi (Dashboard/Tabela/Estrutura/Limites) com
 * tratamento divergente de zero, null e sinal — Limites exibia "R$ 0,00Mi"
 * onde as outras mostravam "R$ 0". Esta versão é o superconjunto: null/
 * undefined vira travessão, zero vira "R$ 0" e negativo ganha "− ".
 */
export const fmtMi = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return '—';
  if (v === 0) return 'R$ 0';
  const mi = v / 1_000_000;
  const sign = v < 0 ? '− ' : '';
  return `${sign}R$ ${Math.abs(mi).toFixed(2).replace('.', ',')}Mi`;
};
