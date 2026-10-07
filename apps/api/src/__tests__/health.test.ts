import { describe, it, expect, vi, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock core dependencies so test runs without real DB/Redis
vi.mock('@atlas/core', () => ({
  loadConfig: () => ({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'test-secret-1234567890',
    API_PORT: 3005,
    NODE_ENV: 'test',
    MODULE_HEDGE_ENABLED: false,
    MODULE_STOCKBRIDGE_ENABLED: false,
    MODULE_BREAKINGPOINT_ENABLED: false,
    MODULE_CLEVEL_ENABLED: false,
    MODULE_COMEXINSIGHT_ENABLED: false,
    MODULE_COMEXFLOW_ENABLED: false,
    MODULE_FORECAST_ENABLED: false,
  }),
  getConfig: () => ({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'test-secret-1234567890',
    API_PORT: 3005,
    NODE_ENV: 'test',
    ATLAS_ENV: 'uat',
    OMIE_MODE: 'leitura',
    N8N_HEALTH_URL: undefined,
    MODULE_HEDGE_ENABLED: false,
    MODULE_STOCKBRIDGE_ENABLED: false,
    MODULE_BREAKINGPOINT_ENABLED: false,
    MODULE_CLEVEL_ENABLED: false,
    MODULE_COMEXINSIGHT_ENABLED: false,
    MODULE_COMEXFLOW_ENABLED: false,
    MODULE_FORECAST_ENABLED: false,
  }),
  getAmbiente: (c: { ATLAS_ENV?: string }) => c.ATLAS_ENV ?? 'dev',
  getModoEmail: () => 'suprimido',
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

describe('GET /api/v1/health', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: healthRouter } = await import('../health.js');
    app = express();
    app.use(healthRouter);
  });

  it('returns 200 with healthy status when all dependencies are up', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('healthy');
    expect(res.body.data.version).toBeDefined();
    expect(res.body.data.dependencies.postgres.status).toBe('up');
    expect(res.body.data.dependencies.redis.status).toBe('up');
    expect(res.body.error).toBeNull();
  });

  it('returns module list with all disabled by default', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.body.data.modules).toBeDefined();
    expect(res.body.data.modules.hedge).toEqual({ enabled: false });
    expect(res.body.data.modules.stockbridge).toEqual({ enabled: false });
    expect(res.body.data.modules.forecast).toEqual({ enabled: false });
  });

  it('informa ambiente, modo OMIE e destino dos e-mails (ACXEGDP-405)', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.body.data.ambiente).toEqual({ nome: 'uat', omie_modo: 'leitura', email: 'suprimido' });
  });

  it('GET /api/v1/ambiente devolve o mesmo resumo, sem sessão', async () => {
    const res = await request(app).get('/api/v1/ambiente');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { nome: 'uat', omie_modo: 'leitura', email: 'suprimido' }, error: null });
  });

  it('includes uptime_seconds as number', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(typeof res.body.data.uptime_seconds).toBe('number');
    expect(res.body.data.uptime_seconds).toBeGreaterThanOrEqual(0);
  });
});
