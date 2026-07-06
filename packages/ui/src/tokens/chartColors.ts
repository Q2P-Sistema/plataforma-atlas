import { colors } from './colors.js';

/**
 * Cores de gráfico/KPI compartilhadas entre os módulos (UI-B, ACXEGDP-262).
 *
 * Fonte única para os hexes que antes ficavam repetidos como string crua em
 * Hedge/Forecast/StockBridge (recharts stroke/fill, style inline, arrays de
 * série). Os valores são EXATAMENTE os mesmos usados antes — trocar o hex cru
 * por estas constantes não muda nada visualmente.
 */
export const chartColors = {
  acxe: colors.accent.acxe, // #0077cc — azul ACXE
  q2p: colors.accent.q2p, // #1a9944 — verde Q2P
  warn: colors.accent.warn, // #d97706 — atenção
  crit: colors.accent.crit, // #dc2626 — crítico
  ndf: colors.accent.ndf, // #7c3aed — NDF/violeta
  success: colors.accent.success, // #059669 — positivo/ok
} as const;

/**
 * Paleta própria do Breaking Point (tons rebaixados para os KPIs/gráficos de
 * caixa). Documentada como token oficial do módulo — antes espalhada como hex
 * cru em BPDashboardPage/BPLimitesPage/BPEstruturaBancosPage.
 */
export const bpChartColors = {
  vermelho: '#B83228', // pagamentos / crítico
  laranja: '#CF6437', // antecipação
  ocre: '#A85A08', // FINIMP
  verde: '#2A7A4A', // liquidez / saldo CC
  azul: '#0C6E8A', // estoque / saldo
  violeta: '#7236CC', // duplicatas bloqueadas
  magenta: '#B05A8A', // capacidade de compras
} as const;
