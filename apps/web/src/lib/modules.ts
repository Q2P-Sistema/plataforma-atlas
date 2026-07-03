/**
 * Fonte única dos módulos no frontend (UI-C, ACXEGDP-263).
 *
 * Antes havia 4 cópias de MODULE_NAMES (App.tsx, useModules.ts,
 * AdminUsersPage.tsx e apps/api/src/modules.ts) com ordens divergentes.
 * As 3 do frontend consomem este arquivo. O backend
 * (apps/api/src/modules.ts) segue sendo a autoridade sobre habilitação
 * (feature flags) — mantenha os nomes em sincronia com ele.
 *
 * Ordem canônica de exibição: módulos habilitados primeiro, depois os
 * "em breve" (sem frontend/flag desligada).
 */
export const MODULE_NAMES: Record<string, string> = {
  hedge: 'Hedge Engine',
  stockbridge: 'StockBridge',
  breakingpoint: 'Breaking Point',
  forecast: 'Forecast',
  clevel: 'C-Level',
  comexinsight: 'ComexInsight',
  comexflow: 'ComexFlow',
};

export const ALL_MODULE_IDS = Object.keys(MODULE_NAMES);

export const MODULE_OPTIONS: { id: string; name: string }[] = ALL_MODULE_IDS.map(
  (id) => ({ id, name: MODULE_NAMES[id]! }),
);
