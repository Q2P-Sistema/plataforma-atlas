import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 015 (ACXEGDP-328), T044 — memoria do De->Para (fornecedor, descricao
// da NF) -> produtos Q2P (Historias 3 e 4). Cobre: normalizacao aplicada na
// consulta E na gravacao (D8 — grafias que se fundem), sugestao de par conhecido
// (1:N, ordem de uso), par inedito sem sugestao, uso registrado por UPDATE
// (vezes_usada + 1) e correcao do CONJUNTO por soft delete — nunca DELETE.
//
// Drizzle e simulado por um chain "thenable" que registra cada operacao; a
// trigger de auditoria e provada contra banco real em auditoria-correlacao.test.

type Op = { op: 'select' | 'update' | 'insert'; table: string; set?: Record<string, unknown>; values?: unknown; calls: string[] };
const ops: Op[] = [];
let selectQueue: unknown[][] = [];
const poolQuerySpy = vi.fn();

function chain(op: Op, result: () => unknown): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  c.from = (t: { __id?: string }) => { op.table = t.__id ?? '?'; op.calls.push('from'); return c; };
  for (const m of ['where', 'orderBy', 'limit', 'returning']) c[m] = () => { op.calls.push(m); return c; };
  c.set = (v: Record<string, unknown>) => { op.set = v; op.calls.push('set'); return c; };
  c.values = (v: unknown) => { op.values = v; op.calls.push('values'); return c; };
  c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve().then(result).then(res, rej);
  return c;
}
function fakeDb() {
  const db: Record<string, unknown> = {
    select: () => { const op: Op = { op: 'select', table: '?', calls: [] }; ops.push(op); return chain(op, () => selectQueue.shift() ?? []); },
    update: (t: { __id?: string }) => { const op: Op = { op: 'update', table: t.__id ?? '?', calls: [] }; ops.push(op); return chain(op, () => []); },
    insert: (t: { __id?: string }) => { const op: Op = { op: 'insert', table: t.__id ?? '?', calls: [] }; ops.push(op); return chain(op, () => []); },
  };
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return db;
}

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => fakeDb(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
}));

vi.mock('@atlas/db', () => ({
  correlacaoProdutoFornecedor: {
    __id: 'correlacao_produto_fornecedor',
    id: {}, fornecedorCnpj: {}, fornecedorNome: {}, descricaoNf: {}, descricaoNormalizada: {},
    produtoCodigoQ2p: {}, produtoDescricao: {}, vezesUsada: {}, ultimaVezUsadaEm: {}, ativo: {},
    criadoPor: {}, atualizadoPor: {}, updatedAt: {},
  },
}));

import {
  sugerirProdutosEmLote,
  sugerirProdutos,
  registrarUsoCorrelacao,
  definirConjuntoCorrelacao,
} from '../services/correlacao-produto.service.js';

const CNPJ = '68.176.072/0001-28';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const linhaSug = (desc: string, codigo: number, descricao: string, vezesUsada: number) => ({ descricaoNormalizada: desc, codigo, descricao, vezesUsada });

beforeEach(() => {
  ops.length = 0;
  selectQueue = [];
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes('tbl_produtos_Q2P')) {
      const nomes: Record<number, string> = { 3033097757: 'PS CRISTAL A', 3033097763: 'PS AI B', 3033097755: 'PS CRISTAL B' };
      return Promise.resolve({ rows: ((params?.[0] as number[]) ?? []).filter((c) => nomes[c]).map((c) => ({ codigo_produto: String(c), descricao: nomes[c] })) });
    }
    return Promise.resolve({ rows: [] });
  });
});

const selects = () => ops.filter((o) => o.op === 'select');
const updates = () => ops.filter((o) => o.op === 'update');
const inserts = () => ops.filter((o) => o.op === 'insert');

describe('sugestao (T038) — normalizacao na consulta e 1:N por descricao', () => {
  it('par conhecido: devolve o CONJUNTO de produtos da descricao, na ordem em que o banco os entrega (vezes_usada DESC)', async () => {
    selectQueue = [[
      linhaSug('SUCATA PSAI MOIDO MESCLADO GROSSO', 3033097757, 'PS CRISTAL A', 4),
      linhaSug('SUCATA PSAI MOIDO MESCLADO GROSSO', 3033097763, 'PS AI B', 2),
      linhaSug('SUCATA PSAI MOIDO MESCLADO GROSSO', 3033097755, 'PS CRISTAL B', 1),
    ]];
    const m = await sugerirProdutosEmLote(CNPJ, ['SUCATA  PSAI MOIDO MESCLADO GROSSO']);
    expect(m.get('SUCATA PSAI MOIDO MESCLADO GROSSO')).toEqual([
      { codigo: 3033097757, descricao: 'PS CRISTAL A', vezesUsada: 4 },
      { codigo: 3033097763, descricao: 'PS AI B', vezesUsada: 2 },
      { codigo: 3033097755, descricao: 'PS CRISTAL B', vezesUsada: 1 },
    ]);
    expect(selects()[0]!.calls).toEqual(['from', 'where', 'orderBy']);
  });

  it('grafias que se fundem (D8): espaco duplo, caixa e acento chegam a MESMA chave — e a consulta e uma so', async () => {
    selectQueue = [[linhaSug('SUCATA PSAI MOIDO', 3033097757, 'PS CRISTAL A', 1)]];
    const m = await sugerirProdutosEmLote(CNPJ, ['Sucata  PSAI moído', 'SUCATA PSAI MOIDO', ' sucata psai moido ']);
    expect(selects()).toHaveLength(1);
    expect([...m.keys()]).toEqual(['SUCATA PSAI MOIDO']);
    // sugerirProdutos normaliza o que recebe antes de olhar no mapa
    selectQueue = [[linhaSug('SUCATA PSAI MOIDO', 3033097757, 'PS CRISTAL A', 1)]];
    expect((await sugerirProdutos(CNPJ, 'sucata  psai MOÍDO')).map((p) => p.codigo)).toEqual([3033097757]);
  });

  it('par inedito: sem sugestao (lista vazia), sem erro', async () => {
    selectQueue = [[]];
    expect(await sugerirProdutos(CNPJ, 'DESCRICAO NUNCA VISTA')).toEqual([]);
  });

  it('sem cnpj ou sem descricao util: nao consulta o banco', async () => {
    expect((await sugerirProdutosEmLote('', ['X'])).size).toBe(0);
    expect((await sugerirProdutosEmLote(CNPJ, ['   ', ''])).size).toBe(0);
    expect(selects()).toHaveLength(0);
  });
});

describe('registrarUsoCorrelacao (T039/T041) — a escolha do operador vira memoria', () => {
  it('par novo: INSERT com vezes_usada=1, descricao normalizada e descricao original', async () => {
    selectQueue = [[]];
    const r = await registrarUsoCorrelacao({ fornecedorCnpj: CNPJ, fornecedorNome: 'ISOFORMA', descricaoNf: 'Sucata  PSAI moído', produtoCodigoQ2p: 3033097757, produtoDescricao: 'PS CRISTAL A', userId: USER });
    expect(r).toEqual({ criada: true });
    expect(updates()).toHaveLength(0);
    const [ins] = inserts();
    expect(ins!.table).toBe('correlacao_produto_fornecedor');
    expect(ins!.values).toMatchObject({
      fornecedorCnpj: CNPJ, fornecedorNome: 'ISOFORMA', descricaoNf: 'Sucata  PSAI moído', descricaoNormalizada: 'SUCATA PSAI MOIDO',
      produtoCodigoQ2p: 3033097757, produtoDescricao: 'PS CRISTAL A', vezesUsada: 1, criadoPor: USER,
    });
  });

  it('par ja memorizado: UPDATE incrementando vezes_usada e ultima_vez_usada_em — nunca segunda linha', async () => {
    selectQueue = [[{ id: 'corr-1' }]];
    const r = await registrarUsoCorrelacao({ fornecedorCnpj: CNPJ, fornecedorNome: 'ISOFORMA', descricaoNf: 'SUCATA PSAI MOIDO', produtoCodigoQ2p: 3033097757, produtoDescricao: 'PS CRISTAL A', userId: USER });
    expect(r).toEqual({ criada: false });
    expect(inserts()).toHaveLength(0);
    const [up] = updates();
    expect(up!.set).toHaveProperty('vezesUsada');
    expect(String(up!.set!.vezesUsada)).not.toBe('1'); // e uma expressao SQL (+ 1), nao um valor fixo
    expect(up!.set!.ultimaVezUsadaEm).toBeInstanceOf(Date);
    expect(up!.set!.produtoDescricao).toBe('PS CRISTAL A');
  });

  it('sem cnpj: nao grava nada (dado incompleto nao vira memoria errada)', async () => {
    expect(await registrarUsoCorrelacao({ fornecedorCnpj: '', fornecedorNome: 'X', descricaoNf: 'Y', produtoCodigoQ2p: 1, produtoDescricao: 'P', userId: USER })).toEqual({ criada: false });
    expect(ops).toHaveLength(0);
  });
});

describe('definirConjuntoCorrelacao (T049/T042) — correcao por UPDATE auditado, nunca DELETE', () => {
  it('ativos [A,B], desejados [B,C]: desativa A (ativo=false + atualizado_por), mantem B, insere C com o nome do catalogo Q2P', async () => {
    selectQueue = [[{ id: 'corr-A', codigo: 3033097757 }, { id: 'corr-B', codigo: 3033097763 }]];
    const r = await definirConjuntoCorrelacao({ fornecedorCnpj: CNPJ, fornecedorNome: 'ISOFORMA', descricaoNf: 'SUCATA PSAI MOIDO', produtosCodigoQ2p: [3033097763, 3033097755], userId: USER });
    expect(r).toEqual({ adicionados: 1, mantidos: 1, desativados: 1, produtosNaoEncontrados: [] });
    expect(ops.map((o) => o.op)).not.toContain('delete');
    const [up] = updates();
    expect(up!.set).toMatchObject({ ativo: false, atualizadoPor: USER });
    const [ins] = inserts();
    expect(ins!.values).toEqual([
      expect.objectContaining({ produtoCodigoQ2p: 3033097755, produtoDescricao: 'PS CRISTAL B', descricaoNormalizada: 'SUCATA PSAI MOIDO', vezesUsada: 0, criadoPor: USER, atualizadoPor: USER }),
    ]);
    // nomes vieram do catalogo, nao do cliente
    expect(poolQuerySpy.mock.calls.some((c) => String(c[0]).includes('tbl_produtos_Q2P'))).toBe(true);
  });

  it('conjunto identico: nada muda (0 update, 0 insert)', async () => {
    selectQueue = [[{ id: 'corr-A', codigo: 3033097757 }]];
    const r = await definirConjuntoCorrelacao({ fornecedorCnpj: CNPJ, fornecedorNome: 'ISOFORMA', descricaoNf: 'SUCATA PSAI MOIDO', produtosCodigoQ2p: [3033097757], userId: USER });
    expect(r).toMatchObject({ adicionados: 0, mantidos: 1, desativados: 0 });
    expect(updates()).toHaveLength(0);
    expect(inserts()).toHaveLength(0);
  });

  it('conjunto vazio desativa tudo; produto fora do catalogo e devolvido em produtosNaoEncontrados e NAO gravado', async () => {
    selectQueue = [[{ id: 'corr-A', codigo: 3033097757 }]];
    let r = await definirConjuntoCorrelacao({ fornecedorCnpj: CNPJ, fornecedorNome: 'ISOFORMA', descricaoNf: 'SUCATA PSAI MOIDO', produtosCodigoQ2p: [], userId: USER });
    expect(r).toMatchObject({ desativados: 1, adicionados: 0 });

    ops.length = 0;
    selectQueue = [[]];
    r = await definirConjuntoCorrelacao({ fornecedorCnpj: CNPJ, fornecedorNome: 'ISOFORMA', descricaoNf: 'SUCATA PSAI MOIDO', produtosCodigoQ2p: [999999, 3033097757], userId: USER });
    expect(r.produtosNaoEncontrados).toEqual([999999]);
    expect(r.adicionados).toBe(1);
    expect((inserts()[0]!.values as unknown[]).map((v) => (v as { produtoCodigoQ2p: number }).produtoCodigoQ2p)).toEqual([3033097757]);
  });

  it('descricao vazia e recusada; codigos repetidos/invalidos sao ignorados', async () => {
    await expect(definirConjuntoCorrelacao({ fornecedorCnpj: CNPJ, fornecedorNome: 'X', descricaoNf: '   ', produtosCodigoQ2p: [1], userId: USER })).rejects.toThrow('obrigatória');
    selectQueue = [[]];
    const r = await definirConjuntoCorrelacao({ fornecedorCnpj: CNPJ, fornecedorNome: 'X', descricaoNf: 'D', produtosCodigoQ2p: [3033097757, 3033097757, -1, 0], userId: USER });
    expect(r.adicionados).toBe(1);
  });
});
