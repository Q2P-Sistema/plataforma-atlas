import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import type { ConsultarNFResponse } from '@atlas/integration-omie';

// Mocks — @atlas/core, @atlas/auth, @atlas/db, @atlas/integration-omie.
// consultarNF é mockado direto: a validação roda sobre o retorno que injetamos.
vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  }),
  getPool: () => ({ query: vi.fn().mockResolvedValue({ rows: [{ count: '1' }] }) }),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local', MODULE_STOCKBRIDGE_ENABLED: true }),
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
  requireModule: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('@atlas/db', () => ({
  lote: {},
  movimentacao: {},
  movimentacaoLegado: {},
  aprovacao: {},
  localidade: {},
  localidadeCorrelacao: {},
}));

vi.mock('@atlas/integration-omie', () => ({
  consultarNF: vi.fn(),
  incluirAjusteEstoque: vi.fn(),
  isMockMode: () => true,
}));

/** NF base válida (ACXE, saída, não cancelada). */
function nf(overrides: Partial<ConsultarNFResponse> = {}): ConsultarNFResponse {
  return {
    nNF: 300,
    cChaveNFe: 'CHAVE',
    dEmi: '15/04/2026',
    nCodProd: 4_452_881_285,
    codigoLocalEstoque: '4498926337',
    qCom: 25_000,
    uCom: 'KG',
    xProd: 'PEAD 5502',
    vUnCom: 1.2,
    vNF: 30_000,
    nCodCli: 12345,
    cRazao: 'FORNECEDOR',
    cancelada: false,
    sinaisCancelamento: {},
    tpNF: 1,
    cnpjEmitente: 'Acxe Matriz',
    ...overrides,
  };
}

describe('Validação de NF no recebimento — contratos (feature 012)', () => {
  let app: express.Express;
  let consultarNF: ReturnType<typeof vi.fn>;
  let incluirAjusteEstoque: ReturnType<typeof vi.fn>;
  let sendEmail: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const omie = await import('@atlas/integration-omie');
    consultarNF = vi.mocked(omie.consultarNF) as ReturnType<typeof vi.fn>;
    incluirAjusteEstoque = vi.mocked(omie.incluirAjusteEstoque) as ReturnType<typeof vi.fn>;
    const core = await import('@atlas/core');
    sendEmail = vi.mocked(core.sendEmail) as ReturnType<typeof vi.fn>;

    const { default: stockbridgeRouter } = await import('../../routes/stockbridge.routes.js');
    app = express();
    app.use(express.json());
    app.use(stockbridgeRouter);
  });

  beforeEach(() => {
    consultarNF.mockReset();
    incluirAjusteEstoque.mockReset();
    sendEmail.mockClear();
  });

  // US1 — cancelada
  it('GET /fila com NF cancelada → 422 NF_CANCELADA', async () => {
    consultarNF.mockResolvedValue(nf({ cancelada: true }));
    const res = await request(app).get('/api/v1/stockbridge/fila?nf=300&cnpj=acxe');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NF_CANCELADA');
    expect(res.body.data).toBeNull();
  });

  it('POST /recebimento de NF cancelada → 422 e nenhuma escrita no OMIE', async () => {
    consultarNF.mockResolvedValue(nf({ cancelada: true }));
    const res = await request(app).post('/api/v1/stockbridge/recebimento').send({
      nf: '300',
      cnpj: 'acxe',
      quantidade_input: 25_000,
      unidade_input: 'kg',
      localidade_id: '00000000-0000-0000-0000-000000000100',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NF_CANCELADA');
    expect(incluirAjusteEstoque).not.toHaveBeenCalled();
  });

  // US2 — emitente ACXE
  it('GET /fila (acxe) com NF de entrada de terceiro → 422 NF_NAO_EMITIDA_ACXE', async () => {
    consultarNF.mockResolvedValue(nf({ tpNF: 0, cnpjEmitente: 'Fornecedor Terceiro' }));
    const res = await request(app).get('/api/v1/stockbridge/fila?nf=300&cnpj=acxe');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NF_NAO_EMITIDA_ACXE');
  });

  it('GET /fila (q2p) com tpNF=0 → NÃO bloqueia por emitente (200)', async () => {
    consultarNF.mockResolvedValue(nf({ tpNF: 0, cnpjEmitente: 'Fornecedor Terceiro' }));
    const res = await request(app).get('/api/v1/stockbridge/fila?nf=300&cnpj=q2p');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
  });

  it('GET /fila com NF da ACXE cancelada → 422 NF_CANCELADA (cancelamento antes de emitente)', async () => {
    consultarNF.mockResolvedValue(nf({ cancelada: true, tpNF: 0 }));
    const res = await request(app).get('/api/v1/stockbridge/fila?nf=300&cnpj=acxe');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NF_CANCELADA');
  });

  // US3 — sem regressão
  it('GET /fila com NF válida ACXE → 200 com item (sem falso bloqueio)', async () => {
    consultarNF.mockResolvedValue(nf());
    const res = await request(app).get('/api/v1/stockbridge/fila?nf=300&cnpj=acxe');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].nf).toBe('300');
  });

  // US4 — indeterminado → fail-open + alerta admin
  it('GET /fila com NF indeterminada (acxe) → 200 (fail-open) + alerta ao admin', async () => {
    consultarNF.mockResolvedValue(nf({ tpNF: undefined, cnpjEmitente: undefined }));
    const res = await request(app).get('/api/v1/stockbridge/fila?nf=300&cnpj=acxe');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
