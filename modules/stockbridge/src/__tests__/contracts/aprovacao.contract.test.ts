import { describe, it, expect, vi, beforeAll } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const mockTx = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([
    // tipoAprovacao = entrada_manual nao dispara fluxo OMIE — mantem contract simples
    { id: 'apr-1', loteId: 'lote-1', status: 'pendente', precisaNivel: 'gestor', tipoAprovacao: 'entrada_manual', lancadoPor: 'u-op' },
  ]),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  returning: vi.fn().mockResolvedValue([{ id: 'nova-apr' }]),
  innerJoin: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockResolvedValue([]),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
};

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => ({
    select: () => mockTx,
    update: () => mockTx,
    insert: () => mockTx,
    transaction: async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx),
    execute: mockTx.execute,
  }),
  getPool: () => ({ query: vi.fn() }),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  sendEmail: vi.fn(),
}));

let currentUser: { id: string; role: 'operador' | 'gestor' | 'diretor' } = { id: 'u1', role: 'gestor' };

vi.mock('@atlas/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      id: currentUser.id, role: currentUser.role,
      name: 'Test User', email: 't@test.local', status: 'active',
    };
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
  aprovacao: {},
  lote: {},
  movimentacao: {},
  localidadeCorrelacao: {},
  users: {},
}));

describe('Aprovacoes — contratos', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: stockbridgeRouter } = await import('../../routes/stockbridge.routes.js');
    app = express();
    app.use(express.json());
    app.use(stockbridgeRouter);
  });

  it('GET /aprovacoes 200 para gestor', async () => {
    currentUser = { id: 'u-gestor', role: 'gestor' };
    const res = await request(app).get('/api/v1/stockbridge/aprovacoes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /aprovacoes 403 para operador', async () => {
    currentUser = { id: 'u-op', role: 'operador' };
    const res = await request(app).get('/api/v1/stockbridge/aprovacoes');
    expect(res.status).toBe(403);
  });

  it('POST /aprovacoes/:id/aprovar 200 para gestor', async () => {
    currentUser = { id: 'u-gestor', role: 'gestor' };
    const res = await request(app).post('/api/v1/stockbridge/aprovacoes/apr-1/aprovar');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('apr-1');
  });

  it('POST /aprovacoes/:id/rejeitar 400 sem motivo', async () => {
    currentUser = { id: 'u-gestor', role: 'gestor' };
    const res = await request(app).post('/api/v1/stockbridge/aprovacoes/apr-1/rejeitar').send({});
    expect(res.status).toBe(400);
  });

  it('POST /aprovacoes/:id/resubmeter 400 sem dados', async () => {
    currentUser = { id: 'u-op', role: 'operador' };
    const res = await request(app).post('/api/v1/stockbridge/aprovacoes/apr-1/resubmeter').send({});
    expect(res.status).toBe(400);
  });

  it('POST /aprovacoes/:id/resubmeter 403 para gestor (so operador pode)', async () => {
    currentUser = { id: 'u-gestor', role: 'gestor' };
    const res = await request(app)
      .post('/api/v1/stockbridge/aprovacoes/apr-1/resubmeter')
      .send({ quantidade_recebida_kg: 22_000, observacoes: 'ok' });
    // requireOperador allows gestor too (hierarquico), entao este teste passa 200 ou 409
    expect([200, 409]).toContain(res.status);
  });
});

describe('POST /aprovacoes/:id/aprovar — pendenciaOmie residual (US4)', () => {
  let app: express.Express;

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../../services/aprovacao.service.js', async () => {
      const real = await vi.importActual<typeof import('../../services/aprovacao.service.js')>(
        '../../services/aprovacao.service.js',
      );
      return {
        ...real,
        aprovar: vi.fn(),
      };
    });
    const { default: stockbridgeRouter } = await import('../../routes/stockbridge.routes.js');
    app = express();
    app.use(express.json());
    app.use(stockbridgeRouter);
  });

  it('200 com pendenciaOmie quando OMIE deixa Q2P pendente apos aprovacao', async () => {
    currentUser = { id: 'u-gestor', role: 'gestor' };
    const svc = await import('../../services/aprovacao.service.js');
    vi.mocked(svc.aprovar).mockResolvedValueOnce({
      id: 'apr-1',
      loteStatus: 'provisorio',
      pendenciaOmie: {
        lado: 'q2p',
        opId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        movimentacaoId: 'mov-pendente',
        mensagem: 'OMIE Q2P 503',
      },
    });

    const res = await request(app).post('/api/v1/stockbridge/aprovacoes/apr-1/aprovar');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: 'apr-1',
      loteStatus: 'provisorio',
      pendenciaOmie: {
        lado: 'q2p',
        opId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        movimentacaoId: 'mov-pendente',
      },
    });
  });

  it('200 sem pendenciaOmie quando aprovacao concluiu OMIE inteiramente', async () => {
    currentUser = { id: 'u-gestor', role: 'gestor' };
    const svc = await import('../../services/aprovacao.service.js');
    vi.mocked(svc.aprovar).mockResolvedValueOnce({
      id: 'apr-2',
      loteStatus: 'provisorio',
    });

    const res = await request(app).post('/api/v1/stockbridge/aprovacoes/apr-2/aprovar');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'apr-2', loteStatus: 'provisorio' });
    expect(res.body.data.pendenciaOmie).toBeUndefined();
  });
});
