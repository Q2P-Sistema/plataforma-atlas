import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import type { ConsultarNFResponse } from '@atlas/integration-omie';

// A validação (feature 012) lê da tabela sincronizada tbl_nf_header via getPool().query.
// `state` controla por teste o que a query do header devolve (linhas / erro). As demais
// queries do fluxo (ex.: middleware requireArmazemVinculado) recebem o default count:1.
const state = vi.hoisted(() => ({ headerRows: [] as Array<{ cancelada: boolean; emitente_acxe: boolean }>, headerReject: null as Error | null }));

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  }),
  getPool: () => ({
    query: (sql: string) => {
      if (typeof sql === 'string' && sql.includes('tbl_nf_header')) {
        return state.headerReject ? Promise.reject(state.headerReject) : Promise.resolve({ rows: state.headerRows });
      }
      return Promise.resolve({ rows: [{ count: '1' }] });
    },
  }),
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

/** Produto/qtd vindos da consulta OMIE ao vivo (a validação NÃO depende disto). */
function nfProduto(): ConsultarNFResponse {
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
  };
}

/** Resposta do espelho tbl_nf_header (o que a validação realmente consulta). */
function header(rows: Array<{ cancelada: boolean; emitente_acxe: boolean }>) {
  state.headerRows = rows;
  state.headerReject = null;
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
    consultarNF.mockReset().mockResolvedValue(nfProduto());
    incluirAjusteEstoque.mockReset();
    state.headerRows = [];
    state.headerReject = null;
    sendEmail.mockClear();
  });

  // US1 — cancelada (flag autoritativo do espelho)
  it('GET /fila com NF da ACXE cancelada → 422 NF_CANCELADA', async () => {
    header([{ cancelada: true, emitente_acxe: true }]);
    const res = await request(app).get('/api/v1/stockbridge/fila?nf=5212&cnpj=acxe');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NF_CANCELADA');
  });

  it('POST /recebimento de NF cancelada → 422 e nenhuma escrita no OMIE', async () => {
    header([{ cancelada: true, emitente_acxe: true }]);
    const res = await request(app).post('/api/v1/stockbridge/recebimento').send({
      nf: '5212',
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
  it('GET /fila (acxe) número só de terceiro → 422 NF_NAO_EMITIDA_ACXE', async () => {
    header([{ cancelada: false, emitente_acxe: false }]);
    const res = await request(app).get('/api/v1/stockbridge/fila?nf=556&cnpj=acxe');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NF_NAO_EMITIDA_ACXE');
  });

  it('GET /fila (acxe) colisão terceiro+ACXE → 200 (escolhe a da ACXE)', async () => {
    header([
      { cancelada: false, emitente_acxe: false },
      { cancelada: false, emitente_acxe: false },
      { cancelada: false, emitente_acxe: true },
    ]);
    const res = await request(app).get('/api/v1/stockbridge/fila?nf=556&cnpj=acxe');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });

  it('GET /fila (q2p) número de terceiro NÃO bloqueia por emitente → 200', async () => {
    header([{ cancelada: false, emitente_acxe: false }]);
    const res = await request(app).get('/api/v1/stockbridge/fila?nf=556&cnpj=q2p');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });

  // US3 — sem regressão
  it('GET /fila com NF válida da ACXE → 200 com item (sem falso bloqueio)', async () => {
    header([{ cancelada: false, emitente_acxe: true }]);
    const res = await request(app).get('/api/v1/stockbridge/fila?nf=5218&cnpj=acxe');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });

  // US4 — indeterminado → fail-open + alerta admin
  it('GET /fila com NF ausente no espelho → 200 (fail-open) + alerta ao admin', async () => {
    header([]);
    const res = await request(app).get('/api/v1/stockbridge/fila?nf=99999&cnpj=acxe');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('GET /fila quando o espelho falha (erro SQL) → 200 (fail-open) + alerta', async () => {
    state.headerReject = new Error('coluna cancelada ausente');
    const res = await request(app).get('/api/v1/stockbridge/fila?nf=5218&cnpj=acxe');
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
