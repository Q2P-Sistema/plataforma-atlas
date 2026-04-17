import { describe, it, expect, vi, beforeAll } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getPool: () => ({
    query: vi.fn().mockResolvedValue({
      rows: [
        {
          produto_codigo_acxe: 12345,
          nome: 'PP RAFIA',
          familia: 'PP RAFIA',
          ncm: '3902.10.10',
          fisica_t: 42,
          fiscal_t: 42,
          transito_intl_t: 15,
          porto_dta_t: 0,
          transito_interno_t: 0,
          provisorio_t: 0,
          consumo_medio_diario_t: 1.2,
          lead_time_dias: 60,
          familia_categoria: 'PP',
          incluir: true,
          divs: 0,
          aprs: 0,
        },
      ],
    }),
  }),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  getDb: () => ({}),
  sendEmail: vi.fn(),
}));

vi.mock('@atlas/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      id: '00000000-0000-0000-0000-000000000001',
      role: 'gestor',
      name: 'Test Gestor',
      email: 'g@test.local',
      status: 'active',
    };
    next();
  },
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('@atlas/db', () => ({
  lote: {},
  movimentacao: {},
  aprovacao: {},
  localidade: {},
  localidadeCorrelacao: {},
}));

vi.mock('@atlas/integration-omie', () => ({
  consultarNF: vi.fn(),
  incluirAjusteEstoque: vi.fn(),
  isMockMode: () => true,
}));

describe('GET /api/v1/stockbridge/cockpit — contratos', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: stockbridgeRouter } = await import('../../routes/stockbridge.routes.js');
    app = express();
    app.use(express.json());
    app.use(stockbridgeRouter);
  });

  it('200 retorna resumo + lista de SKUs', async () => {
    const res = await request(app).get('/api/v1/stockbridge/cockpit');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.resumo).toBeDefined();
    expect(Array.isArray(res.body.data.skus)).toBe(true);
    expect(res.body.data.skus[0]).toMatchObject({
      codigoAcxe: 12345,
      nome: 'PP RAFIA',
      fisicaT: 42,
      criticidade: expect.stringMatching(/critico|alerta|ok|excesso/),
    });
  });

  it('cobertura e criticidade sao calculados no TS', async () => {
    const res = await request(app).get('/api/v1/stockbridge/cockpit');
    const sku = res.body.data.skus[0];
    // 42 / 1.2 = 35 dias ; 35 < 60*1.2 (72) mas > 60*0.5 (30) => alerta
    expect(sku.coberturaDias).toBe(35);
    expect(sku.criticidade).toBe('alerta');
  });

  it('400 quando criticidade invalida', async () => {
    const res = await request(app).get('/api/v1/stockbridge/cockpit?criticidade=amarelo');
    expect(res.status).toBe(400);
  });

  it('400 quando cnpj invalido', async () => {
    const res = await request(app).get('/api/v1/stockbridge/cockpit?cnpj=outro');
    expect(res.status).toBe(400);
  });
});
