import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const INTEGRATION_KEY = 'test-integration-key-1234567890';

// Simula o estado do DB para idempotencia e localidade
let idempotencyHit = false;
const localidadeResolvida = { localidadeId: 'loc-1', cnpj: 'Acxe Matriz' };

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getConfig: () => ({ ATLAS_INTEGRATION_KEY: INTEGRATION_KEY, SEED_ADMIN_EMAIL: 'a@a' }),
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(idempotencyHit ? [{ id: 'existente-1' }] : []) }),
        innerJoin: () => ({
          where: () => ({ limit: () => Promise.resolve([localidadeResolvida]) }),
        }),
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: 'nova-mov' }]) }) }),
      }),
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
  }),
  getPool: () => ({ query: vi.fn() }),
  sendEmail: vi.fn(),
}));

vi.mock('@atlas/auth', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireModule: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('@atlas/db', () => ({
  movimentacao: {},
  divergencia: {},
  localidadeCorrelacao: { codigoLocalEstoqueAcxe: {}, codigoLocalEstoqueQ2p: {}, localidadeId: {} },
  localidade: { id: {}, cnpj: {} },
  lote: {},
  aprovacao: {},
}));

const payloadBase = {
  nf: 'NF-VENDA-12345',
  tipo_omie: 'venda',
  cnpj_emissor: 'acxe',
  produto_codigo: 123,
  quantidade_original: 25,
  unidade: 't',
  localidade_origem_codigo: 4498926337,
  // OMIE emite a data como dd/MM/aaaa (dEmi) — nao ISO. Usar o formato real do OMIE.
  dt_emissao: '20/04/2026',
  id_movest_omie: '7777777',
};

describe('POST /saida-automatica/processar — contratos', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: stockbridgeRouter } = await import('../../routes/stockbridge.routes.js');
    app = express();
    app.use(express.json());
    app.use(stockbridgeRouter);
  });

  beforeEach(() => {
    idempotencyHit = false;
  });

  it('401 sem header X-Atlas-Integration-Key', async () => {
    const res = await request(app)
      .post('/api/v1/stockbridge/saida-automatica/processar')
      .send(payloadBase);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_INTEGRATION_KEY');
  });

  it('401 com integration key invalida', async () => {
    const res = await request(app)
      .post('/api/v1/stockbridge/saida-automatica/processar')
      .set('X-Atlas-Integration-Key', 'wrong-key')
      .send(payloadBase);
    expect(res.status).toBe(401);
  });

  it('400 com payload invalido (tipo_omie inexistente)', async () => {
    const res = await request(app)
      .post('/api/v1/stockbridge/saida-automatica/processar')
      .set('X-Atlas-Integration-Key', INTEGRATION_KEY)
      .send({ ...payloadBase, tipo_omie: 'importacao' });
    expect(res.status).toBe(400);
  });

  it('200 processa NF nova (nao debito cruzado quando emissor bate com fisico)', async () => {
    const res = await request(app)
      .post('/api/v1/stockbridge/saida-automatica/processar')
      .set('X-Atlas-Integration-Key', INTEGRATION_KEY)
      .send(payloadBase);
    expect(res.status).toBe(200);
    expect(res.body.data.debitoCruzado).toBe(false);
    expect(res.body.data.idempotente).toBe(false);
  });

  it('200 retorna idempotente=true quando NF ja processada', async () => {
    idempotencyHit = true;
    const res = await request(app)
      .post('/api/v1/stockbridge/saida-automatica/processar')
      .set('X-Atlas-Integration-Key', INTEGRATION_KEY)
      .send(payloadBase);
    expect(res.status).toBe(200);
    expect(res.body.data.idempotente).toBe(true);
  });

  it('200 detecta debito cruzado quando Q2P fatura e fisico e ACXE', async () => {
    const res = await request(app)
      .post('/api/v1/stockbridge/saida-automatica/processar')
      .set('X-Atlas-Integration-Key', INTEGRATION_KEY)
      .send({ ...payloadBase, cnpj_emissor: 'q2p' }); // emissor=q2p, fisico=Acxe Matriz → cruzado
    expect(res.status).toBe(200);
    expect(res.body.data.debitoCruzado).toBe(true);
    expect(res.body.data.subtipo).toBe('debito_cruzado');
  });

  // STK-05 (ACXEGDP-285): OMIE envia uCom em MAIUSCULA ("KG"); antes caia em 400.
  it('200 aceita unidade em maiuscula (KG) vinda crua do OMIE', async () => {
    const res = await request(app)
      .post('/api/v1/stockbridge/saida-automatica/processar')
      .set('X-Atlas-Integration-Key', INTEGRATION_KEY)
      .send({ ...payloadBase, unidade: 'KG', quantidade_original: 500 });
    expect(res.status).toBe(200);
    expect(res.body.data.idempotente).toBe(false);
  });

  it('400 rejeita unidade desconhecida (nao cai em kg silenciosamente)', async () => {
    const res = await request(app)
      .post('/api/v1/stockbridge/saida-automatica/processar')
      .set('X-Atlas-Integration-Key', INTEGRATION_KEY)
      .send({ ...payloadBase, unidade: 'litro' });
    expect(res.status).toBe(400);
  });

  // STK-04 (ACXEGDP-284): data dd/MM/aaaa com dia>12 dava 500 (Invalid Date).
  it('200 processa data dd/MM/aaaa com dia > 12', async () => {
    const res = await request(app)
      .post('/api/v1/stockbridge/saida-automatica/processar')
      .set('X-Atlas-Integration-Key', INTEGRATION_KEY)
      .send({ ...payloadBase, dt_emissao: '25/03/2026' });
    expect(res.status).toBe(200);
  });

  it('400 rejeita dt_emissao em formato ISO (nao dd/MM/aaaa)', async () => {
    const res = await request(app)
      .post('/api/v1/stockbridge/saida-automatica/processar')
      .set('X-Atlas-Integration-Key', INTEGRATION_KEY)
      .send({ ...payloadBase, dt_emissao: '2026-04-20' });
    expect(res.status).toBe(400);
  });

  // OMIE pode enviar codigos numericos como string — coerce deve aceitar.
  it('200 aceita produto_codigo/localidade como string numerica', async () => {
    const res = await request(app)
      .post('/api/v1/stockbridge/saida-automatica/processar')
      .set('X-Atlas-Integration-Key', INTEGRATION_KEY)
      .send({ ...payloadBase, produto_codigo: '123', localidade_origem_codigo: '4498926337' });
    expect(res.status).toBe(200);
  });
});
