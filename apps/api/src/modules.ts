import type { Express } from 'express';
import { getConfig, createLogger } from '@atlas/core';

const logger = createLogger('modules');

export interface ModuleInfo {
  id: string;
  name: string;
  enabled: boolean;
  path: string;
}

const MODULE_DEFINITIONS: Omit<ModuleInfo, 'enabled'>[] = [
  { id: 'hedge', name: 'Hedge Engine', path: '/hedge' },
  { id: 'stockbridge', name: 'StockBridge', path: '/stockbridge' },
  { id: 'breakingpoint', name: 'Breaking Point', path: '/breakingpoint' },
  { id: 'clevel', name: 'C-Level', path: '/clevel' },
  { id: 'comexinsight', name: 'ComexInsight', path: '/comexinsight' },
  { id: 'comexflow', name: 'ComexFlow', path: '/comexflow' },
  { id: 'forecast', name: 'Forecast', path: '/forecast' },
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
 * Currently a no-op placeholder — each module spec (002-hedge, etc.)
 * will add its router here when implemented.
 */
export function registerModuleRoutes(app: Express): void {
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

  // Register module routers
  if (config.MODULE_HEDGE_ENABLED) {
    import('@atlas/hedge').then(({ hedgeRouter }) => {
      app.use(hedgeRouter);
      logger.info('Hedge Engine routes registered');
    }).catch((err) => {
      logger.error({ err }, 'Failed to load Hedge Engine module');
    });
  }
}
