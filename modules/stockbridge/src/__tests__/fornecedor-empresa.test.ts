import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Feature 017, Historia 5 (ACXEGDP-437, migration 0058) — a exclusao de fornecedor da fila de recebimento
// nacional passa a ser POR EMPRESA (fornecedor_exclusao.empresa). Sem `empresa` vale 'q2p': a tela de
// Fornecedores, que nao manda nada, continua igual.

const poolQuery = vi.fn();
const selects: Array<{ where: unknown }> = [];
const inserts: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];
let selectRows: unknown[] = [];

function fakeDb() {
  const select = () => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.where = (w: unknown) => { selects.push({ where: w }); return c; };
    c.orderBy = () => c;
    c.limit = () => Promise.resolve(selectRows);
    return c;
  };
  return {
    select,
    insert: () => ({ values: (v: Record<string, unknown>) => ({ returning: async () => { inserts.push(v); return [{ id: 'exc-1', ...v }]; } }) }),
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

const roleMock = vi.hoisted(() => ({ user: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', role: 'diretor' } }));
vi.mock('../middleware/role.js', () => ({
  requireDiretor: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = roleMock.user;
    next();
  },
}));

import { listarFornecedores, excluirFornecedor, reincluirFornecedor, FornecedorJaExcluidoError, ExclusaoNaoEncontradaError } from '../services/fornecedor.service.js';
import router from '../routes/fornecedor.routes.js';

const app = express();
app.use(express.json());
app.use(router);

const CNPJ = '27.019.059/0001-88';
const whereComo = (i: number): string => JSON.stringify(selects[i]!.where);

beforeEach(() => {
  poolQuery.mockReset();
  poolQuery.mockImplementation(async (sql: string) =>
    String(sql).includes('fornecedor_exclusao')
      ? { rows: [{ fornecedor_cnpj: CNPJ, fornecedor_nome: 'Q2P COMERCIO', motivo: 'intercompany' }] }
      : { rows: [{ cnpj: '11.111.111/0001-11', nome: 'SOLUTEC', pais: null }, { cnpj: CNPJ, nome: 'Q2P COMERCIO', pais: null }] },
  );
  selects.length = 0;
  inserts.length = 0;
  updates.length = 0;
  selectRows = [];
});

describe('listarFornecedores', () => {
  it('marca como excluidos so os da empresa pedida; sem empresa = q2p', async () => {
    await listarFornecedores('acxe');
    await listarFornecedores();
    const consultasExclusao = poolQuery.mock.calls.filter((c) => String(c[0]).includes('fornecedor_exclusao'));
    expect(consultasExclusao.map((c) => c[1])).toEqual([['acxe'], ['q2p']]);
    expect(String(consultasExclusao[0]![0])).toContain('reincluido_em IS NULL AND empresa = $1');
  });

  it('o resultado marca o excluido da empresa e a lista de candidatos continua a de sempre (cadastro da ACXE)', async () => {
    const lista = await listarFornecedores('acxe');
    expect(lista.find((f) => f.cnpj === CNPJ)).toMatchObject({ excluido: true, motivoExclusao: 'intercompany' });
    expect(lista.find((f) => f.cnpj === '11.111.111/0001-11')).toMatchObject({ excluido: false });
    const consultaCadastro = poolQuery.mock.calls.find((c) => String(c[0]).includes('tbl_cadastroFornecedoresClientes'))!;
    expect(String(consultaCadastro[0])).toContain('"tbl_cadastroFornecedoresClientes_ACXE"');
  });
});

describe('excluirFornecedor / reincluirFornecedor', () => {
  it('exclui na empresa pedida (insert com empresa) e checa a exclusao existente NA MESMA empresa', async () => {
    await excluirFornecedor({ cnpj: CNPJ, nome: 'Q2P', motivo: 'intercompany', usuarioId: 'u1', empresa: 'acxe' });
    expect(inserts[0]).toMatchObject({ empresa: 'acxe', fornecedorCnpj: CNPJ, fornecedorNome: 'Q2P', motivo: 'intercompany', excluidoPor: 'u1' });
    expect(whereComo(0)).toContain('"acxe"');
    expect(whereComo(0)).toContain('fornecedor_cnpj');
  });

  it('sem empresa: q2p', async () => {
    await excluirFornecedor({ cnpj: CNPJ, nome: 'Q2P', motivo: null, usuarioId: 'u1' });
    expect(inserts[0]).toMatchObject({ empresa: 'q2p' });
    expect(whereComo(0)).toContain('"q2p"');
  });

  it('exclusao ativa na MESMA empresa: FornecedorJaExcluidoError (a outra empresa nao conta, o indice e por empresa)', async () => {
    selectRows = [{ id: 'exc-0' }];
    await expect(excluirFornecedor({ cnpj: CNPJ, nome: 'Q2P', motivo: null, usuarioId: 'u1', empresa: 'acxe' })).rejects.toBeInstanceOf(FornecedorJaExcluidoError);
    expect(inserts).toHaveLength(0);
  });

  it('reincluir procura a exclusao ativa da empresa e a encerra', async () => {
    selectRows = [{ id: 'exc-0' }];
    await reincluirFornecedor({ cnpj: CNPJ, usuarioId: 'u1', empresa: 'acxe' });
    expect(whereComo(0)).toContain('"acxe"');
    expect(updates[0]).toMatchObject({ reincluidoPor: 'u1' });
    expect(updates[0]!.reincluidoEm).toBeInstanceOf(Date);
  });

  it('reincluir sem exclusao ativa na empresa: ExclusaoNaoEncontradaError', async () => {
    selectRows = [];
    await expect(reincluirFornecedor({ cnpj: CNPJ, usuarioId: 'u1', empresa: 'acxe' })).rejects.toBeInstanceOf(ExclusaoNaoEncontradaError);
    expect(updates).toHaveLength(0);
  });
});

describe('rotas /fornecedores — empresa opcional (query ou corpo), padrao q2p', () => {
  it('GET sem empresa nao quebra a tela atual; com ?empresa=acxe filtra; invalida = 400', async () => {
    expect((await request(app).get('/api/v1/stockbridge/fornecedores')).status).toBe(200);
    expect((await request(app).get('/api/v1/stockbridge/fornecedores?empresa=acxe')).status).toBe(200);
    const empresas = poolQuery.mock.calls.filter((c) => String(c[0]).includes('fornecedor_exclusao')).map((c) => c[1]);
    expect(empresas).toEqual([['q2p'], ['acxe']]);
    const res = await request(app).get('/api/v1/stockbridge/fornecedores?empresa=outra');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('POST excluir: empresa no corpo; sem empresa = q2p; invalida = 400 sem gravar', async () => {
    const url = `/api/v1/stockbridge/fornecedores/${encodeURIComponent(CNPJ)}/excluir`;
    expect((await request(app).post(url).send({ motivo: 'intercompany', nome: 'Q2P', empresa: 'acxe' })).status).toBe(201);
    expect((await request(app).post(url).send({ motivo: 'x' })).status).toBe(201);
    expect(inserts.map((i) => i.empresa)).toEqual(['acxe', 'q2p']);
    const res = await request(app).post(url).send({ empresa: 'zzz' });
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(2);
  });

  it('POST reincluir: empresa na query; sem empresa = q2p', async () => {
    selectRows = [{ id: 'exc-0' }];
    const url = `/api/v1/stockbridge/fornecedores/${encodeURIComponent(CNPJ)}/reincluir`;
    expect((await request(app).post(url + '?empresa=acxe')).status).toBe(200);
    expect((await request(app).post(url)).status).toBe(200);
    expect(whereComo(0)).toContain('"acxe"');
    expect(whereComo(1)).toContain('"q2p"');
  });
});
