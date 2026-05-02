import { describe, it, expect, vi, beforeAll } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Lote fixture com estagio transito_intl
const loteMock = {
  id: '00000000-0000-0000-0000-000000000aaa',
  codigo: 'F-499-1',
  produto_codigo_acxe: 1,
  fornecedor_nome: 'Mock',
  pais_origem: 'China',
  quantidade_fisica_kg: 25_000,
  quantidade_fiscal_kg: 25_000,
  custo_brl_kg: 6,
  cnpj: 'acxe',
  estagio_transito: 'transito_intl',
  di: null,
  dta: null,
  nota_fiscal: null,
  dt_prev_chegada: '2026-04-20',
  pedido_compra_acxe: '499',
  localidade_codigo: '90.0.2',
  protocolo_di: null,
  despachante: null,
  terminal_atracacao: null,
  numero_bl: null,
  data_bl: null,
  etd: null,
  eta: '2026-05-15',
  data_desembarque: null,
  data_liberacao_transporte: null,
  data_entrada_armazem: null,
  lsd: null,
  free_time: null,
  etapa_fup: '10 - Aguardando Chegada do Navio',
};

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => ({
    execute: vi.fn().mockResolvedValue({ rows: [{ atualizados: 0 }] }),
  }),
  getPool: () => ({
    query: vi.fn().mockResolvedValue({ rows: [loteMock] }),
  }),
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
  lote: {},
  localidade: {},
  movimentacao: {},
  aprovacao: {},
  localidadeCorrelacao: {},
}));

describe('Transito — contratos (read-only)', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: stockbridgeRouter } = await import('../../routes/stockbridge.routes.js');
    app = express();
    app.use(express.json());
    app.use(stockbridgeRouter);
  });

  it('GET /transito 200 para gestor com 3 estagios (sem reservado)', async () => {
    currentUser = { id: 'u-gestor', role: 'gestor' };
    const res = await request(app).get('/api/v1/stockbridge/transito');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('transito_intl');
    expect(res.body.data).toHaveProperty('porto_dta');
    expect(res.body.data).toHaveProperty('transito_interno');
  });

  it('GET /transito 200 para operador (mesma visibilidade que gestor agora)', async () => {
    currentUser = { id: 'u-op', role: 'operador' };
    const res = await request(app).get('/api/v1/stockbridge/transito');
    expect(res.status).toBe(200);
  });

  it('GET /transito retorna campos extras vindos do FUP no payload', async () => {
    currentUser = { id: 'u-gestor', role: 'gestor' };
    const res = await request(app).get('/api/v1/stockbridge/transito');
    expect(res.status).toBe(200);
    const lote = res.body.data.transito_intl[0];
    expect(lote).toMatchObject({
      pedidoComprasAcxe: '499',
      eta: '2026-05-15',
      etapaFup: '10 - Aguardando Chegada do Navio',
    });
  });
});
