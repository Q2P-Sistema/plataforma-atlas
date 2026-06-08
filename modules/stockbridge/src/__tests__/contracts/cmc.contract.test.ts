import { describe, it, expect, vi, beforeAll } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// getPool responde a (1) resolução de data e (2) folhas do snapshot.
vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getPool: () => ({
    query: vi.fn((sql: string) => {
      const s = String(sql);
      if (s.includes('MIN(data_snapshot)')) {
        return Promise.resolve({ rows: [{ de: '2026-06-01', ate: '2026-06-03' }] });
      }
      if (s.includes('WITH snap')) {
        return Promise.resolve({
          rows: [
            { familia: 'PP HOMO 25', codigo_produto: 'PP-146', descricao_produto: 'PP A' },
            { familia: 'PEAD FILME', codigo_produto: 'PE-1', descricao_produto: 'PE A' },
          ],
        });
      }
      if (s.includes('AS snap')) {
        return Promise.resolve({ rows: [{ snap: '2026-06-08', hoje: '2026-06-08' }] });
      }
      if (s.includes('BETWEEN')) {
        return Promise.resolve({
          rows: [
            { data: '2026-06-01', chave: 'Total', label: 'Total', vol: '100', valor: '1000' },
            { data: '2026-06-03', chave: 'Total', label: 'Total', vol: '200', valor: '1800' },
          ],
        });
      }
      return Promise.resolve({
        rows: [
          { codigo_produto: 'PP-146', descricao_produto: 'PP HOMO', familia: 'PP HOMO 25', origem: 'NACIONAL', volume_total: '414523', valor_total_cmc: '3011949.69' },
          { codigo_produto: 'PP-024', descricao_produto: 'PP HOMO 2', familia: 'PP HOMO 25', origem: 'IMPORTADO', volume_total: '152950', valor_total_cmc: '1392601.03' },
        ],
      });
    }),
  }),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  getDb: () => ({}),
  sendEmail: vi.fn(),
}));

// requireAuth lê o papel do header x-test-role (default gestor); requireRole ENFORÇA.
vi.mock('@atlas/auth', () => ({
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
}));

vi.mock('@atlas/integration-omie', () => ({
  consultarNF: vi.fn(),
  incluirAjusteEstoque: vi.fn(),
  isMockMode: () => true,
}));

describe('GET /api/v1/stockbridge/cmc/snapshot — contratos', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: stockbridgeRouter } = await import('../../routes/stockbridge.routes.js');
    app = express();
    app.use(express.json());
    app.use(stockbridgeRouter);
  }, 30_000); // import do grafo de rotas pode passar de 10s em cold-start

  it('200 retorna snapshot com resumo + famílias (gestor)', async () => {
    const res = await request(app).get('/api/v1/stockbridge/cmc/snapshot');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.dataSnapshot).toBe('2026-06-08');
    expect(res.body.data.defasado).toBe(false);
    expect(res.body.data.resumo).toMatchObject({ volumeTotalKg: 567473, valorTotal: 4404550.72 });
    expect(Array.isArray(res.body.data.familias)).toBe(true);
    const fam = res.body.data.familias[0];
    expect(fam.descricaoFamilia).toBe('PP HOMO 25');
    expect(fam.porOrigem.importado.volumeKg).toBe(152950);
    expect(fam.porOrigem.nacional.volumeKg).toBe(414523);
    // resumo não traz CMC global (FR-018)
    expect(res.body.data.resumo).not.toHaveProperty('cmcPonderado');
  });

  it('403 quando operador (custo é gestor+ — FR-013)', async () => {
    const res = await request(app)
      .get('/api/v1/stockbridge/cmc/snapshot')
      .set('x-test-role', 'operador');
    expect(res.status).toBe(403);
  });

  it('400 quando origem inválida', async () => {
    const res = await request(app).get('/api/v1/stockbridge/cmc/snapshot?origem=OUTRO');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('400 quando data em formato inválido', async () => {
    const res = await request(app).get('/api/v1/stockbridge/cmc/snapshot?data=ontem');
    expect(res.status).toBe(400);
  });

  it('200 tendência com eixo de datas e lacuna em dia sem coleta', async () => {
    const res = await request(app).get('/api/v1/stockbridge/cmc/tendencia');
    expect(res.status).toBe(200);
    expect(res.body.data.datas).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
    expect(res.body.data.series).toHaveLength(1);
    expect(res.body.data.series[0].pontos[1]).toBeNull(); // 02 sem coleta
  });

  it('403 tendência quando operador', async () => {
    const res = await request(app)
      .get('/api/v1/stockbridge/cmc/tendencia')
      .set('x-test-role', 'operador');
    expect(res.status).toBe(403);
  });

  it('200 filtros retorna famílias e produtos', async () => {
    const res = await request(app).get('/api/v1/stockbridge/cmc/filtros');
    expect(res.status).toBe(200);
    expect(res.body.data.familias).toEqual(['PEAD FILME', 'PP HOMO 25']);
    expect(res.body.data.produtos).toHaveLength(2);
  });
});
