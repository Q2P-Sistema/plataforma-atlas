import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Feature 017, Historia 5 (ACXEGDP-437, migration 0058) — exclusao de fornecedor POR EMPRESA, pela API com o servico
// real e um banco fake que modela o indice unico (empresa, cnpj) WHERE reincluido_em IS NULL: o mesmo CNPJ pode estar
// excluido na ACXE e na Q2P ao mesmo tempo, duplicar na MESMA empresa e 409, reincluir sem exclusao ativa na empresa e
// 404. A empresa vem no corpo OU na query (o corpo vence); ausente/vazia = q2p; invalida = 400. fornecedor-empresa.test.ts
// cobre o servico e o caminho feliz das rotas; aqui, os desfechos 409/404 por empresa e a leitura do parametro.

/** exclusoes ativas no "banco": chave `${empresa}|${cnpj}` */
const ativas = new Set<string>();
const inserts: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];
const poolQuery = vi.fn();

/** a empresa da condicao `where` do Drizzle: o servico a passa como valor literal ("acxe"/"q2p") */
const empresaDoWhere = (w: unknown): 'acxe' | 'q2p' => (JSON.stringify(w).includes('"acxe"') ? 'acxe' : 'q2p');
const cnpjDoWhere = (w: unknown): string => (/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/.exec(JSON.stringify(w)) ?? [''])[0]!;

function fakeDb() {
  return {
    select: () => {
      let w: unknown;
      const c: Record<string, unknown> = {};
      c.from = () => c;
      c.where = (x: unknown) => { w = x; return c; };
      c.orderBy = () => c;
      c.limit = () => Promise.resolve(ativas.has(`${empresaDoWhere(w)}|${cnpjDoWhere(w)}`) ? [{ id: 'exc-0' }] : []);
      return c;
    },
    insert: () => ({ values: (v: Record<string, unknown>) => ({ returning: async () => { inserts.push(v); ativas.add(`${v.empresa}|${v.fornecedorCnpj}`); return [{ id: 'exc-1', ...v }]; } }) }),
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { updates.push(v); } }) }),
  };
}

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => fakeDb(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuery(sql, params) }),
}));
vi.mock('@atlas/db', () => ({
  fornecedorExclusao: {
    id: { name: 'id' }, fornecedorCnpj: { name: 'fornecedor_cnpj' }, empresa: { name: 'empresa' },
    reincluidoEm: { name: 'reincluido_em' }, excluidoEm: { name: 'excluido_em' },
  },
}));
vi.mock('../middleware/role.js', () => ({
  requireDiretor: (req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user?: unknown }).user = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', role: 'diretor' };
    next();
  },
}));

import router from '../routes/fornecedor.routes.js';

const app = express();
app.use(express.json());
app.use(router);
const CNPJ = '27.019.059/0001-88';
const enc = encodeURIComponent(CNPJ);
const URL_EXCLUIR = `/api/v1/stockbridge/fornecedores/${enc}/excluir`;
const URL_REINCLUIR = `/api/v1/stockbridge/fornecedores/${enc}/reincluir`;

beforeEach(() => {
  ativas.clear();
  inserts.length = 0;
  updates.length = 0;
  poolQuery.mockReset();
  poolQuery.mockResolvedValue({ rows: [] });
});

describe('POST /fornecedores/:cnpj/excluir — por empresa', () => {
  it('o mesmo CNPJ pode ser excluido na ACXE e na Q2P; repetir na MESMA empresa e 409 FORNECEDOR_JA_EXCLUIDO', async () => {
    expect((await request(app).post(URL_EXCLUIR).send({ empresa: 'acxe', motivo: 'intercompany' })).status).toBe(201);
    // a Q2P ainda nao tinha: a exclusao da ACXE nao conta para ela
    expect((await request(app).post(URL_EXCLUIR).send({ motivo: 'da Q2P' })).status).toBe(201);
    const dup = await request(app).post(URL_EXCLUIR).send({ empresa: 'acxe' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('FORNECEDOR_JA_EXCLUIDO');
    const dupQ2p = await request(app).post(URL_EXCLUIR).send({});
    expect(dupQ2p.status).toBe(409);
    expect(inserts.map((i) => i.empresa)).toEqual(['acxe', 'q2p']);
  });

  it('a empresa pode vir na query; o corpo vence a query; vazia = q2p', async () => {
    await request(app).post(`${URL_EXCLUIR}?empresa=acxe`).send({});
    await request(app).post(`${URL_EXCLUIR}?empresa=q2p`).send({ empresa: 'acxe' }); // corpo vence: acxe ja excluida -> 409
    ativas.clear();
    await request(app).post(`${URL_EXCLUIR}?empresa=acxe`).send({ empresa: 'q2p' }); // corpo vence: q2p
    await request(app).post(URL_EXCLUIR).send({ empresa: '' });
    // 1) acxe (query); 2) corpo acxe com acxe ja excluida (sem insert novo); 3) q2p (corpo sobre query); 4) '' -> q2p (ja excluida por 3: 409)
    expect(inserts.map((i) => i.empresa)).toEqual(['acxe', 'q2p']);
  });

  it.each([['valor desconhecido', '?empresa=outra'], ['repetida na query (array)', '?empresa=acxe&empresa=q2p']])(
    'empresa invalida (%s): 400 INVALID_INPUT e nada gravado',
    async (_n, qs) => {
      const res = await request(app).post(`${URL_EXCLUIR}${qs}`).send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(inserts).toHaveLength(0);
    },
  );
});

describe('POST /fornecedores/:cnpj/reincluir — por empresa', () => {
  it('reincluir na empresa certa encerra so a exclusao dela; sem exclusao ativa NA EMPRESA e 404 EXCLUSAO_NAO_ENCONTRADA', async () => {
    ativas.add(`q2p|${CNPJ}`); // so a Q2P esta excluida
    const naAcxe = await request(app).post(`${URL_REINCLUIR}?empresa=acxe`);
    expect(naAcxe.status).toBe(404);
    expect(naAcxe.body.error.code).toBe('EXCLUSAO_NAO_ENCONTRADA');
    expect(updates).toHaveLength(0);

    const naQ2p = await request(app).post(URL_REINCLUIR); // sem empresa = q2p
    expect(naQ2p.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ reincluidoPor: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
  });

  it('empresa invalida: 400 e nada alterado', async () => {
    ativas.add(`acxe|${CNPJ}`);
    const res = await request(app).post(`${URL_REINCLUIR}?empresa=zzz`);
    expect(res.status).toBe(400);
    expect(updates).toHaveLength(0);
  });
});

describe('GET /fornecedores — a lista marca as exclusoes da empresa pedida', () => {
  it('consulta as exclusoes ativas com a empresa como parametro (padrao q2p)', async () => {
    poolQuery.mockImplementation(async (sql: string) =>
      String(sql).includes('fornecedor_exclusao') ? { rows: [{ fornecedor_cnpj: CNPJ, fornecedor_nome: 'Q2P COMERCIO', motivo: 'intercompany' }] } : { rows: [] },
    );
    const acxe = await request(app).get('/api/v1/stockbridge/fornecedores?empresa=acxe');
    expect(acxe.status).toBe(200);
    // excluido sem cadastro na ACXE ainda aparece na lista (para poder ser reincluido)
    expect(acxe.body.data).toEqual([{ cnpj: CNPJ, nome: 'Q2P COMERCIO', pais: null, excluido: true, motivoExclusao: 'intercompany' }]);
    await request(app).get('/api/v1/stockbridge/fornecedores');
    const parametros = poolQuery.mock.calls.filter((c) => String(c[0]).includes('fornecedor_exclusao')).map((c) => c[1]);
    expect(parametros).toEqual([['acxe'], ['q2p']]);
  });
});
