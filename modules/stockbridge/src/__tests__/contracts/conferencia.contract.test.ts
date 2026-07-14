import { describe, it, expect, vi, beforeAll } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// getPool responde a (1) datas (MAX(ddataposicao)) e (2) agregação (pivot).
vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getPool: () => ({
    query: vi.fn((sql: string) => {
      const s = String(sql);
      if (s.includes('MAX(ddataposicao)')) {
        return Promise.resolve({ rows: [{ d_acxe: '2026-06-22', d_q2p: '2026-06-22' }] });
      }
      // agregação (WITH base ... GROUP BY)
      return Promise.resolve({
        rows: [
          // ESPELHADO, ambos -1500, diferença 0 → Negativo
          { codigo_estoque: '11.1', nome_estoque: 'SANTO ANDRÉ (IMPORTADO)', tipo_estoque: 'ESPELHADO', produto: 'PEBD 100', saldo_acxe: '-1500', saldo_q2p: '-1500' },
          // ESPELHADO, diferença 50, sem negativo → Divergente
          { codigo_estoque: '11.1', nome_estoque: 'SANTO ANDRÉ (IMPORTADO)', tipo_estoque: 'ESPELHADO', produto: 'PEAD X', saldo_acxe: '100', saldo_q2p: '50' },
          // ESPELHADO, diferença 5500, Q2P negativo → Divergente e Negativo
          { codigo_estoque: '12.1', nome_estoque: 'SANTO ANDRÉ (IMPORTADO)', tipo_estoque: 'ESPELHADO', produto: 'PEAD HDB354', saldo_acxe: '0', saldo_q2p: '-5500' },
          // INDIVIDUAL, diferença ≠ 0 mas nunca Divergente; ambos não-negativos → OK
          { codigo_estoque: '11.2', nome_estoque: 'SANTO ANDRÉ (NACIONAL)', tipo_estoque: 'INDIVIDUAL', produto: 'PP COPO', saldo_acxe: '0', saldo_q2p: '300' },
        ],
      });
    }),
  }),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  getDb: () => ({}),
  sendEmail: vi.fn(),
  buildEmailLayout: (o: { titulo?: string }) => ({ html: String(o?.titulo ?? ''), text: String(o?.titulo ?? '') }),
  emailDataList: () => '',
  emailActionBox: (html: string) => html,
  escapeHtml: (v: unknown) => (v == null ? '' : String(v)),
}));

vi.mock('@atlas/auth', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      id: '00000000-0000-0000-0000-000000000001',
      role: (req.headers['x-test-role'] as string) || 'gestor',
      name: 'Test',
      email: 't@test.local',
      status: 'active',
    };
    next();
  },
  requireRole:
    (...roles: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      if (req.user && roles.includes(req.user.role)) return next();
      res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'forbidden' } });
    },
  requireModule: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('@atlas/db', () => ({
  lote: {},
  movimentacao: {},
  aprovacao: {},
  localidade: {},
  localidadeCorrelacao: {},
  conferenciaLocalMap: {},
}));

vi.mock('@atlas/integration-omie', () => ({
  // Classe dummy: rotas/services importam o binding (STK-10); instanceof falso cai no handler seguinte.
  NotaFiscalMultiItemError: class NotaFiscalMultiItemError extends Error {},
  consultarNF: vi.fn(),
  incluirAjusteEstoque: vi.fn(),
  isMockMode: () => true,
}));

describe('GET /api/v1/stockbridge/conferencia — contratos', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: stockbridgeRouter } = await import('../../routes/stockbridge.routes.js');
    app = express();
    app.use(express.json());
    app.use(stockbridgeRouter);
  }, 30_000);

  it('200 retorna resumo + itens ordenados (problemas no topo) — gestor', async () => {
    const res = await request(app).get('/api/v1/stockbridge/conferencia');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    // resumo sobre o universo completo
    expect(res.body.data.resumo.totalProblemas).toBe(3); // tudo menos o OK
    expect(res.body.data.resumo.totalSkusDivergentes).toBe(2); // Divergente + Divergente e Negativo
    expect(res.body.data.resumo.totalQuebrasNegativas).toBe(2); // PEBD 100 + HDB354
    expect(res.body.data.resumo.dataPosicaoAcxe).toBe('2026-06-22');
    expect(res.body.data.resumo.defasagemEntreEmpresas).toBe(false);
    // ordenação: 1º item é Divergente e Negativo
    expect(res.body.data.itens[0].statusGeral).toBe('Divergente e Negativo');
    expect(res.body.data.itens[0].produto).toBe('PEAD HDB354');
  });

  it('classifica corretamente o caso ESPELHADO ambos -1500 → Negativo', async () => {
    const res = await request(app).get('/api/v1/stockbridge/conferencia');
    const pebd = res.body.data.itens.find((i: { produto: string }) => i.produto === 'PEBD 100');
    expect(pebd.statusGeral).toBe('Negativo');
    expect(pebd.statusSaldoNegativo).toBe('ACXE e Q2P negativos');
    expect(pebd.diferencaKg).toBe(0);
  });

  it('INDIVIDUAL nunca é Divergente mesmo com diferença ≠ 0', async () => {
    const res = await request(app).get('/api/v1/stockbridge/conferencia');
    const pp = res.body.data.itens.find((i: { produto: string }) => i.produto === 'PP COPO');
    expect(pp.diferencaKg).toBe(-300);
    expect(pp.statusGeral).toBe('OK');
  });

  it('?status=problemas só retorna itens != OK', async () => {
    const res = await request(app).get('/api/v1/stockbridge/conferencia?status=problemas');
    expect(res.status).toBe(200);
    expect(res.body.data.itens.every((i: { statusGeral: string }) => i.statusGeral !== 'OK')).toBe(true);
    expect(res.body.data.itens).toHaveLength(3);
  });

  it('?tipo=INDIVIDUAL filtra por tipo', async () => {
    const res = await request(app).get('/api/v1/stockbridge/conferencia?tipo=INDIVIDUAL');
    expect(res.body.data.itens.every((i: { tipoEstoque: string }) => i.tipoEstoque === 'INDIVIDUAL')).toBe(true);
  });

  it('400 quando status inválido', async () => {
    const res = await request(app).get('/api/v1/stockbridge/conferencia?status=xpto');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('403 quando operador', async () => {
    const res = await request(app).get('/api/v1/stockbridge/conferencia').set('x-test-role', 'operador');
    expect(res.status).toBe(403);
  });

  it('contagem: == soma de porStatus == totalProblemas', async () => {
    const res = await request(app).get('/api/v1/stockbridge/conferencia/contagem');
    expect(res.status).toBe(200);
    const { contagem, porStatus } = res.body.data;
    expect(contagem).toBe(3);
    expect(porStatus.divergenteENegativo + porStatus.divergente + porStatus.negativo).toBe(3);
    expect(porStatus).toEqual({ divergenteENegativo: 1, divergente: 1, negativo: 1 });
  });

  it('403 contagem quando operador', async () => {
    const res = await request(app)
      .get('/api/v1/stockbridge/conferencia/contagem')
      .set('x-test-role', 'operador');
    expect(res.status).toBe(403);
  });
});
