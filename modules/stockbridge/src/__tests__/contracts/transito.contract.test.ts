import { describe, it, expect, vi, beforeAll } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Lote fixture com estagio transito_intl
const loteMock = {
  id: '00000000-0000-0000-0000-000000000aaa',
  codigo: 'T001',
  estagioTransito: 'transito_intl',
  ativo: true,
  produtoCodigoAcxe: 1,
  fornecedorNome: 'Mock',
  paisOrigem: 'China',
  quantidadeFisicaKg: '0',
  quantidadeFiscalKg: '25',
  custoBrlKg: '1200',
  cnpj: 'Acxe Matriz',
  di: null,
  dta: null,
  notaFiscal: null,
  dtPrevChegada: '2026-04-20',
};

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => ({
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => Promise.resolve([{ ...loteMock, localidadeCodigo: null }]),
        }),
        where: () => ({ limit: () => Promise.resolve([loteMock]) }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  }),
  getPool: () => ({ query: vi.fn() }),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'a@a' }),
  sendEmail: vi.fn(),
}));

let currentUser: { id: string; role: 'operador' | 'gestor' | 'diretor' } = { id: 'u1', role: 'gestor' };

vi.mock('@atlas/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: currentUser.id, role: currentUser.role, name: 't', email: 't@t', status: 'active' };
    next();
  },
  requireRole: (...allowed: string[]) => (req: Request, res: Response, next: NextFunction) => {
    if (!allowed.includes(req.user?.role ?? '')) {
      res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'sem permissao' } });
      return;
    }
    next();
  },
}));

vi.mock('@atlas/db', () => ({
  lote: { id: {}, codigo: {}, produtoCodigoAcxe: {}, fornecedorNome: {}, paisOrigem: {}, quantidadeFisicaKg: {}, quantidadeFiscalKg: {}, custoBrlKg: {}, cnpj: {}, estagioTransito: {}, di: {}, dta: {}, notaFiscal: {}, dtPrevChegada: {}, ativo: {}, localidadeId: {}, status: {}, updatedAt: {} },
  localidade: { id: {}, codigo: {} },
  movimentacao: {},
  aprovacao: {},
  localidadeCorrelacao: {},
}));

describe('Transito — contratos', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: stockbridgeRouter } = await import('../../routes/stockbridge.routes.js');
    app = express();
    app.use(express.json());
    app.use(stockbridgeRouter);
  });

  it('GET /transito 200 para gestor com todos os estagios inicializados', async () => {
    currentUser = { id: 'u-gestor', role: 'gestor' };
    const res = await request(app).get('/api/v1/stockbridge/transito');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('transito_intl');
    expect(res.body.data).toHaveProperty('porto_dta');
    expect(res.body.data).toHaveProperty('transito_interno');
    expect(res.body.data).toHaveProperty('reservado');
  });

  it('GET /transito 200 para operador (com filtro de visibilidade no service)', async () => {
    currentUser = { id: 'u-op', role: 'operador' };
    const res = await request(app).get('/api/v1/stockbridge/transito');
    expect(res.status).toBe(200);
  });

  it('PATCH /transito/:id/avancar 400 sem proximo_estagio', async () => {
    currentUser = { id: 'u-gestor', role: 'gestor' };
    const res = await request(app).patch(`/api/v1/stockbridge/transito/${loteMock.id}/avancar`).send({});
    expect(res.status).toBe(400);
  });

  it('PATCH /transito/:id/avancar 400 avancando para porto_dta sem DI/DTA', async () => {
    currentUser = { id: 'u-gestor', role: 'gestor' };
    const res = await request(app)
      .patch(`/api/v1/stockbridge/transito/${loteMock.id}/avancar`)
      .send({ proximo_estagio: 'porto_dta' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DADOS_FALTANDO');
    expect(res.body.error.message).toMatch(/DI/);
    expect(res.body.error.message).toMatch(/DTA/);
  });

  it('PATCH /transito/:id/avancar 200 avancando para porto_dta com DI+DTA', async () => {
    currentUser = { id: 'u-gestor', role: 'gestor' };
    const res = await request(app)
      .patch(`/api/v1/stockbridge/transito/${loteMock.id}/avancar`)
      .send({ proximo_estagio: 'porto_dta', di: 'DI-2026-0001', dta: 'DTA-2026-0001' });
    expect(res.status).toBe(200);
    expect(res.body.data.estagio).toBe('porto_dta');
  });

  it('PATCH /transito/:id/avancar 403 para operador', async () => {
    currentUser = { id: 'u-op', role: 'operador' };
    const res = await request(app)
      .patch(`/api/v1/stockbridge/transito/${loteMock.id}/avancar`)
      .send({ proximo_estagio: 'porto_dta', di: 'x', dta: 'y' });
    expect(res.status).toBe(403);
  });
});
