import type { Express } from 'express';
import { getConfig, createLogger } from '@atlas/core';

const logger = createLogger('modules');

export interface ModuleInfo {
  id: string;
  name: string;
  enabled: boolean;
  path: string;
}

// Ordem = ordem de exibicao na sidebar: modulos habilitados primeiro, "em
// breve" (sem frontend/flag off) ao fim (UI-C, ACXEGDP-263). Nomes devem
// espelhar apps/web/src/lib/modules.ts.
const MODULE_DEFINITIONS: Omit<ModuleInfo, 'enabled'>[] = [
  { id: 'hedge', name: 'Hedge Engine', path: '/hedge' },
  { id: 'stockbridge', name: 'StockBridge', path: '/stockbridge' },
  { id: 'breakingpoint', name: 'Breaking Point', path: '/breakingpoint' },
  { id: 'forecast', name: 'Forecast', path: '/forecast' },
  { id: 'clevel', name: 'C-Level', path: '/clevel' },
  { id: 'comexinsight', name: 'ComexInsight', path: '/comexinsight' },
  { id: 'comexflow', name: 'ComexFlow', path: '/comexflow' },
];

export function getModules(): ModuleInfo[] {
  const config = getConfig();
  const flags: Record<string, boolean> = {
    hedge: config.MODULE_HEDGE_ENABLED,
    stockbridge: config.MODULE_STOCKBRIDGE_ENABLED,
    breakingpoint: config.MODULE_BREAKINGPOINT_ENABLED,
    clevel: config.MODULE_CLEVEL_ENABLED,
    comexinsight: config.MODULE_COMEXINSIGHT_ENABLED,
    comexflow: config.MODULE_COMEXFLOW_ENABLED,
    forecast: config.MODULE_FORECAST_ENABLED,
  };

  return MODULE_DEFINITIONS.map((m) => ({
    ...m,
    enabled: flags[m.id] ?? false,
  }));
}

export function getEnabledModules(): ModuleInfo[] {
  return getModules().filter((m) => m.enabled);
}

/**
 * Register module-specific routes on the Express app.
 * Only enabled modules get their routes mounted.
 *
 * MOD-13 (ACXEGDP-280): async e AGUARDADA pelo server.ts. Antes os
 * import().then() eram fire-and-forget: os routers montavam DEPOIS do
 * globalErrorHandler (um next(err) de rota de módulo caía no handler HTML
 * default do Express, fora do envelope JSON) e havia janela de 404 no boot.
 * Falha de carga de um módulo segue não-fatal (logada; os demais sobem).
 */
export async function registerModuleRoutes(app: Express): Promise<void> {
  const config = getConfig();
  const enabled = getEnabledModules();

  if (enabled.length === 0) {
    logger.info('No modules enabled');
    return;
  }

  logger.info(
    { modules: enabled.map((m) => m.id) },
    `${enabled.length} module(s) enabled`,
  );

  const carregamentos: Array<Promise<void>> = [];

  if (config.MODULE_HEDGE_ENABLED) {
    carregamentos.push(
      import('@atlas/hedge').then(({ hedgeRouter }) => {
        app.use(hedgeRouter);
        logger.info('Hedge Engine routes registered');
      }).catch((err) => {
        logger.error({ err }, 'Failed to load Hedge Engine module');
      }),
    );
  }

  if (config.MODULE_FORECAST_ENABLED) {
    carregamentos.push(
      import('@atlas/forecast').then(({ forecastRouter }) => {
        app.use(forecastRouter);
        logger.info('Forecast Planner routes registered');
      }).catch((err) => {
        logger.error({ err }, 'Failed to load Forecast Planner module');
      }),
    );
  }

  if (config.MODULE_BREAKINGPOINT_ENABLED) {
    carregamentos.push(
      import('@atlas/breakingpoint').then(({ bpRouter }) => {
        app.use(bpRouter);
        logger.info('Breaking Point routes registered');
      }).catch((err) => {
        logger.error({ err }, 'Failed to load Breaking Point module');
      }),
    );
  }

  if (config.MODULE_STOCKBRIDGE_ENABLED) {
    carregamentos.push(
      import('@atlas/stockbridge').then(({ stockbridgeRouter, iniciarCronsStockBridge }) => {
        app.use(stockbridgeRouter);
        logger.info('StockBridge routes registered');
        iniciarCronsStockBridge();
      }).catch((err) => {
        logger.error({ err }, 'Failed to load StockBridge module');
      }),
    );
  }

  await Promise.all(carregamentos);
}
