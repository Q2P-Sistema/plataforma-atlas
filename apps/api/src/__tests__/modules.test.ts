import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

let mockConfig = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'test-secret-1234567890',
  API_PORT: 3005,
  NODE_ENV: 'test',
  N8N_HEALTH_URL: undefined as string | undefined,
  MODULE_HEDGE_ENABLED: false,
  MODULE_STOCKBRIDGE_ENABLED: false,
  MODULE_BREAKINGPOINT_ENABLED: false,
  MODULE_CLEVEL_ENABLED: false,
  MODULE_COMEXINSIGHT_ENABLED: false,
  MODULE_COMEXFLOW_ENABLED: false,
  MODULE_FORECAST_ENABLED: false,
};

vi.mock('@atlas/core', () => ({
  loadConfig: () => mockConfig,
  getConfig: () => mockConfig,
  getAmbiente: () => 'dev',
  getModoEmail: () => 'log',
  getPool: () => ({
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
  }),
  getRedis: () => ({
    ping: vi.fn().mockResolvedValue('PONG'),
  }),
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe('Module Feature Flags', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: healthRouter } = await import('../health.js');
    app = express();
    app.use(healthRouter);
  });

  it('returns all modules disabled when flags are false', async () => {
    mockConfig.MODULE_HEDGE_ENABLED = false;
    mockConfig.MODULE_STOCKBRIDGE_ENABLED = false;

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.data.modules.hedge.enabled).toBe(false);
    expect(res.body.data.modules.stockbridge.enabled).toBe(false);
    expect(res.body.data.modules.breakingpoint.enabled).toBe(false);
    expect(res.body.data.modules.clevel.enabled).toBe(false);
    expect(res.body.data.modules.comexinsight.enabled).toBe(false);
    expect(res.body.data.modules.comexflow.enabled).toBe(false);
    expect(res.body.data.modules.forecast.enabled).toBe(false);
  });

  it('returns hedge enabled when MODULE_HEDGE_ENABLED=true', async () => {
    mockConfig.MODULE_HEDGE_ENABLED = true;

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.data.modules.hedge.enabled).toBe(true);
    // Others still disabled
    expect(res.body.data.modules.stockbridge.enabled).toBe(false);
    expect(res.body.data.modules.forecast.enabled).toBe(false);
  });

  it('returns multiple modules enabled when flags are true', async () => {
    mockConfig.MODULE_HEDGE_ENABLED = true;
    mockConfig.MODULE_FORECAST_ENABLED = true;
    mockConfig.MODULE_COMEXFLOW_ENABLED = true;

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.data.modules.hedge.enabled).toBe(true);
    expect(res.body.data.modules.forecast.enabled).toBe(true);
    expect(res.body.data.modules.comexflow.enabled).toBe(true);
    expect(res.body.data.modules.stockbridge.enabled).toBe(false);
  });

  it('always returns all 7 modules regardless of flags', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    const moduleIds = Object.keys(res.body.data.modules);
    expect(moduleIds).toHaveLength(7);
    expect(moduleIds).toContain('hedge');
    expect(moduleIds).toContain('stockbridge');
    expect(moduleIds).toContain('breakingpoint');
    expect(moduleIds).toContain('clevel');
    expect(moduleIds).toContain('comexinsight');
    expect(moduleIds).toContain('comexflow');
    expect(moduleIds).toContain('forecast');
  });
});
