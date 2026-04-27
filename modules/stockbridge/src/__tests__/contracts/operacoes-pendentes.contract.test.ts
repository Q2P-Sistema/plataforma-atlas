import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

let testRole: 'operador' | 'gestor' | 'diretor' = 'operador';

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => ({}),
  getPool: () => ({ query: vi.fn() }),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@atlas/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      id: '00000000-0000-0000-0000-000000000001',
      role: testRole,
      name: 'Test',
      email: 't@test.local',
      status: 'active',
    };
    next();
  },
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('@atlas/db', () => ({
  lote: {}, movimentacao: {}, aprovacao: {}, localidade: {}, localidadeCorrelacao: {},
}));

vi.mock('@atlas/integration-omie', () => ({
  consultarNF: vi.fn(),
  incluirAjusteEstoque: vi.fn(),
  listarAjusteEstoque: vi.fn(),
  isMockMode: () => true,
}));

vi.mock('../../services/operacoes-pendentes.service.js', async () => {
  const real = await vi.importActual<typeof import('../../services/operacoes-pendentes.service.js')>(
    '../../services/operacoes-pendentes.service.js',
  );
  return {
    ...real,
    retentarOperacaoPendente: vi.fn(),
    listarPendentes: vi.fn(),
    marcarComoFalhaDefinitiva: vi.fn(),
  };
});

describe('POST /api/v1/stockbridge/operacoes-pendentes/:id/retentar — contratos', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: stockbridgeRouter } = await import('../../routes/stockbridge.routes.js');
    app = express();
    app.use(express.json());
    app.use(stockbridgeRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('400 quando id nao e UUID', async () => {
    testRole = 'operador';
    const res = await request(app)
      .post('/api/v1/stockbridge/operacoes-pendentes/abc/retentar')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('200 quando operador retenta com tentativas restantes', async () => {
    testRole = 'operador';
    const svc = await import('../../services/operacoes-pendentes.service.js');
    vi.mocked(svc.retentarOperacaoPendente).mockResolvedValueOnce({
      movimentacaoId: 'mov-1',
      statusOmie: 'concluida',
      jaExistiaNoOmie: false,
      tentativasQ2p: 1,
    });

    const res = await request(app)
      .post('/api/v1/stockbridge/operacoes-pendentes/00000000-0000-0000-0000-000000000099/retentar')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      movimentacaoId: 'mov-1',
      statusOmie: 'concluida',
    });
    // Service recebeu role=operador
    expect(svc.retentarOperacaoPendente).toHaveBeenCalledWith({
      movimentacaoId: '00000000-0000-0000-0000-000000000099',
      ator: { userId: '00000000-0000-0000-0000-000000000001', role: 'operador' },
    });
  });

  it('403 quando operador esgotou tentativas', async () => {
    testRole = 'operador';
    const svc = await import('../../services/operacoes-pendentes.service.js');
    vi.mocked(svc.retentarOperacaoPendente).mockRejectedValueOnce(
      new svc.OperadorSemRetentativasError('mov-x', 2),
    );

    const res = await request(app)
      .post('/api/v1/stockbridge/operacoes-pendentes/00000000-0000-0000-0000-000000000099/retentar')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'OPERADOR_SEM_RETENTATIVAS',
      userAction: 'contact_admin',
      retryable: false,
    });
  });

  it('200 quando gestor retenta sem limite (mesmo com tentativas_q2p alto)', async () => {
    testRole = 'gestor';
    const svc = await import('../../services/operacoes-pendentes.service.js');
    vi.mocked(svc.retentarOperacaoPendente).mockResolvedValueOnce({
      movimentacaoId: 'mov-2',
      statusOmie: 'concluida',
      jaExistiaNoOmie: true,
      tentativasQ2p: 5,
    });

    const res = await request(app)
      .post('/api/v1/stockbridge/operacoes-pendentes/00000000-0000-0000-0000-000000000099/retentar')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.tentativasQ2p).toBe(5);
    expect(svc.retentarOperacaoPendente).toHaveBeenCalledWith(
      expect.objectContaining({ ator: expect.objectContaining({ role: 'gestor' }) }),
    );
  });

  it('404 quando movimentacao nao existe', async () => {
    testRole = 'gestor';
    const svc = await import('../../services/operacoes-pendentes.service.js');
    vi.mocked(svc.retentarOperacaoPendente).mockRejectedValueOnce(
      new svc.OperacaoPendenteNaoEncontradaError('mov-x'),
    );

    const res = await request(app)
      .post('/api/v1/stockbridge/operacoes-pendentes/00000000-0000-0000-0000-000000000099/retentar')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('OPERACAO_PENDENTE_NAO_ENCONTRADA');
  });

  it('502 com userAction=contact_admin quando OMIE Q2P falha e tentativasRestantes=0 (operador esgotou)', async () => {
    testRole = 'operador';
    const svc = await import('../../services/operacoes-pendentes.service.js');
    const recebSvc = await import('../../services/recebimento.service.js');
    vi.mocked(svc.retentarOperacaoPendente).mockRejectedValueOnce(
      new recebSvc.OmieAjusteError('q2p', new Error('OMIE Q2P 503'), {
        opId: 'op-z',
        movimentacaoId: 'mov-z',
        tentativasRestantes: 0,
      }),
    );

    const res = await request(app)
      .post('/api/v1/stockbridge/operacoes-pendentes/00000000-0000-0000-0000-000000000099/retentar')
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({
      code: 'OMIE_Q2P_FAIL',
      userAction: 'contact_admin',
      retryable: false,
      stateClean: false,
      tentativasRestantes: 0,
    });
  });

  it('502 com userAction=retry_q2p para gestor sem limite de tentativas', async () => {
    testRole = 'gestor';
    const svc = await import('../../services/operacoes-pendentes.service.js');
    const recebSvc = await import('../../services/recebimento.service.js');
    vi.mocked(svc.retentarOperacaoPendente).mockRejectedValueOnce(
      new recebSvc.OmieAjusteError('q2p', new Error('OMIE 503'), {
        opId: 'op-z',
        movimentacaoId: 'mov-z',
      }),
    );

    const res = await request(app)
      .post('/api/v1/stockbridge/operacoes-pendentes/00000000-0000-0000-0000-000000000099/retentar')
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({
      userAction: 'retry_q2p',
      retryable: true,
    });
  });

  it('409 quando movimentacao ja esta concluida', async () => {
    testRole = 'gestor';
    const svc = await import('../../services/operacoes-pendentes.service.js');
    vi.mocked(svc.retentarOperacaoPendente).mockRejectedValueOnce(
      new svc.OperacaoNaoPendenteError('mov-y', 'concluida'),
    );

    const res = await request(app)
      .post('/api/v1/stockbridge/operacoes-pendentes/00000000-0000-0000-0000-000000000099/retentar')
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OPERACAO_NAO_PENDENTE');
  });
});

describe('GET /api/v1/stockbridge/operacoes-pendentes — contratos (US3)', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: stockbridgeRouter } = await import('../../routes/stockbridge.routes.js');
    app = express();
    app.use(express.json());
    app.use(stockbridgeRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('200 com lista de pendentes para gestor', async () => {
    testRole = 'gestor';
    const svc = await import('../../services/operacoes-pendentes.service.js');
    vi.mocked(svc.listarPendentes).mockResolvedValueOnce([
      {
        id: 'mov-1',
        opId: 'op-uuid-1',
        notaFiscal: '00000300',
        ladoPendente: 'q2p',
        statusOmie: 'pendente_q2p',
        tentativas: 1,
        ultimoErro: { lado: 'q2p', mensagem: 'OMIE 503', timestamp: '2026-04-27T12:00:00Z' },
        createdAt: '2026-04-27T11:59:00Z',
        lote: { id: 'lote-1', codigo: 'L042', fornecedorNome: 'FORN', produtoCodigoAcxe: 1001, quantidadeKg: 25_000 },
      },
    ]);

    const res = await request(app).get('/api/v1/stockbridge/operacoes-pendentes');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: 'mov-1',
      opId: 'op-uuid-1',
      ladoPendente: 'q2p',
      tentativas: 1,
    });
    expect(res.body.data[0].lote.codigo).toBe('L042');
  });

  it('200 com lista vazia quando nao ha pendencias', async () => {
    testRole = 'diretor';
    const svc = await import('../../services/operacoes-pendentes.service.js');
    vi.mocked(svc.listarPendentes).mockResolvedValueOnce([]);

    const res = await request(app).get('/api/v1/stockbridge/operacoes-pendentes');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('POST /operacoes-pendentes/:id/marcar-falha — contratos (US3)', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: stockbridgeRouter } = await import('../../routes/stockbridge.routes.js');
    app = express();
    app.use(express.json());
    app.use(stockbridgeRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('400 quando motivo ausente', async () => {
    testRole = 'gestor';
    const res = await request(app)
      .post('/api/v1/stockbridge/operacoes-pendentes/00000000-0000-0000-0000-000000000099/marcar-falha')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('200 quando gestor marca como falha com motivo', async () => {
    testRole = 'gestor';
    const svc = await import('../../services/operacoes-pendentes.service.js');
    vi.mocked(svc.marcarComoFalhaDefinitiva).mockResolvedValueOnce({ id: 'mov-1' });

    const res = await request(app)
      .post('/api/v1/stockbridge/operacoes-pendentes/00000000-0000-0000-0000-000000000099/marcar-falha')
      .send({ motivo: 'OMIE Q2P retornou erro permanente — produto bloqueado' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 'mov-1' });
    expect(svc.marcarComoFalhaDefinitiva).toHaveBeenCalledWith({
      movimentacaoId: '00000000-0000-0000-0000-000000000099',
      motivo: 'OMIE Q2P retornou erro permanente — produto bloqueado',
      ator: { userId: '00000000-0000-0000-0000-000000000001', role: 'gestor' },
    });
  });

  it('404 quando movimentacao nao existe', async () => {
    testRole = 'diretor';
    const svc = await import('../../services/operacoes-pendentes.service.js');
    vi.mocked(svc.marcarComoFalhaDefinitiva).mockRejectedValueOnce(
      new svc.OperacaoPendenteNaoEncontradaError('mov-x'),
    );

    const res = await request(app)
      .post('/api/v1/stockbridge/operacoes-pendentes/00000000-0000-0000-0000-000000000099/marcar-falha')
      .send({ motivo: 'teste' });

    expect(res.status).toBe(404);
  });
});
