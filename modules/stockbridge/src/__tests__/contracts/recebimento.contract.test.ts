import { describe, it, expect, vi, beforeAll } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Mocks — @atlas/core, @atlas/auth, @atlas/db, @atlas/integration-omie
vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  }),
  getPool: () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@atlas/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      id: '00000000-0000-0000-0000-000000000001',
      role: 'operador',
      name: 'Test Operador',
      email: 'op@test.local',
      status: 'active',
      // @ts-expect-error — campo adicional para o middleware de armazem
      armazemId: '00000000-0000-0000-0000-000000000100',
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

describe('POST /api/v1/stockbridge/recebimento — contratos', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: stockbridgeRouter } = await import('../../routes/stockbridge.routes.js');
    app = express();
    app.use(express.json());
    app.use(stockbridgeRouter);
  });

  it('400 quando payload vazio', async () => {
    const res = await request(app).post('/api/v1/stockbridge/recebimento').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('400 quando unidade invalida', async () => {
    const res = await request(app).post('/api/v1/stockbridge/recebimento').send({
      nf: '123',
      cnpj: 'acxe',
      quantidade_input: 10,
      unidade_input: 'litros', // invalido
      localidade_id: '00000000-0000-0000-0000-000000000100',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/unidade_input/);
  });

  it('400 quando localidade_id nao e UUID', async () => {
    const res = await request(app).post('/api/v1/stockbridge/recebimento').send({
      nf: '123',
      cnpj: 'acxe',
      quantidade_input: 10,
      unidade_input: 't',
      localidade_id: 'not-a-uuid',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/localidade_id/);
  });

  it('400 quando cnpj invalido', async () => {
    const res = await request(app).post('/api/v1/stockbridge/recebimento').send({
      nf: '123',
      cnpj: 'outro',
      quantidade_input: 10,
      unidade_input: 't',
      localidade_id: '00000000-0000-0000-0000-000000000100',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/cnpj/);
  });
});

describe('POST /api/v1/stockbridge/recebimento — erro estruturado OMIE (US2)', () => {
  let app: express.Express;

  beforeAll(async () => {
    // Re-mock recebimento.service para conseguir simular OmieAjusteError no fluxo da rota.
    // (As outras suites usam o stub simples acima — este describe roda com mock dedicado.)
    vi.resetModules();

    vi.doMock('@atlas/core', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
      getDb: () => ({
        select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
        insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      }),
      getPool: () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
      getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
      sendEmail: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock('@atlas/auth', () => ({
      requireAuth: (req: Request, _res: Response, next: NextFunction) => {
        req.user = {
          id: '00000000-0000-0000-0000-000000000001',
          role: 'operador',
          name: 'Test',
          email: 'op@test.local',
          status: 'active',
          // @ts-expect-error armazem
          armazemId: '00000000-0000-0000-0000-000000000100',
        };
        next();
      },
      requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    }));

    vi.doMock('@atlas/db', () => ({
      lote: {}, movimentacao: {}, aprovacao: {}, localidade: {}, localidadeCorrelacao: {},
    }));

    vi.doMock('../../services/recebimento.service.js', async () => {
      const real = await vi.importActual<typeof import('../../services/recebimento.service.js')>(
        '../../services/recebimento.service.js',
      );
      return {
        ...real,
        processarRecebimento: vi.fn(),
      };
    });

    const { default: stockbridgeRouter } = await import('../../routes/stockbridge.routes.js');
    app = express();
    app.use(express.json());
    app.use(stockbridgeRouter);
  });

  it('502 com payload estruturado quando Q2P falha (stateClean=false, tentativasRestantes=1)', async () => {
    const recebimentoService = await import('../../services/recebimento.service.js');
    vi.mocked(recebimentoService.processarRecebimento).mockRejectedValueOnce(
      new recebimentoService.OmieAjusteError(
        'q2p',
        new Error('OMIE Q2P 503'),
        {
          opId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          movimentacaoId: 'mov-xyz',
          recoverable: true,
          tentativasRestantes: 1,
          idACXE: { idMovest: 'M-A', idAjuste: 'A-A' },
        },
      ),
    );

    const res = await request(app).post('/api/v1/stockbridge/recebimento').send({
      nf: '300',
      cnpj: 'acxe',
      quantidade_input: 25_000,
      unidade_input: 'kg',
      localidade_id: '00000000-0000-0000-0000-000000000100',
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({
      code: 'OMIE_Q2P_FAIL',
      userAction: 'retry_q2p',
      retryable: true,
      stateClean: false,
      opId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      movimentacaoId: 'mov-xyz',
      tentativasRestantes: 1,
    });
    expect(res.body.error.userMessage).toMatch(/parcial/i);
  });

  it('502 com stateClean=true quando ACXE falha (operador retenta limpo)', async () => {
    const recebimentoService = await import('../../services/recebimento.service.js');
    vi.mocked(recebimentoService.processarRecebimento).mockRejectedValueOnce(
      new recebimentoService.OmieAjusteError('acxe', new Error('OMIE ACXE 504')),
    );

    const res = await request(app).post('/api/v1/stockbridge/recebimento').send({
      nf: '301',
      cnpj: 'acxe',
      quantidade_input: 25_000,
      unidade_input: 'kg',
      localidade_id: '00000000-0000-0000-0000-000000000100',
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({
      code: 'OMIE_ACXE_FAIL',
      userAction: 'retry',
      retryable: true,
      stateClean: true,
    });
    expect(res.body.error.userMessage).toMatch(/indisponivel/i);
    expect(res.body.error.movimentacaoId).toBeUndefined();
  });
});

describe('GET /api/v1/stockbridge/fila — contratos', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: stockbridgeRouter } = await import('../../routes/stockbridge.routes.js');
    app = express();
    app.use(express.json());
    app.use(stockbridgeRouter);
  });

  it('200 com lista vazia em modo real sem filtros', async () => {
    const res = await request(app).get('/api/v1/stockbridge/fila');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('400 quando cnpj invalido', async () => {
    const res = await request(app).get('/api/v1/stockbridge/fila?cnpj=outro');
    expect(res.status).toBe(400);
  });
});
