import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Feature 017, Historia 5 (ACXEGDP-437) — contrato HTTP do recebimento nacional para a NF da ACXE:
//  - POST /por-nf: produtos[] com exatamente UM de produto_codigo_q2p | produto_codigo_acxe (.strict());
//    o servico recebe so o campo informado; 400 PRODUTO_EMPRESA_INCOMPATIVEL, 422 PRODUTO_SEM_CORRELATO_Q2P e
//    422 PRODUTO_CORRELATO_Q2P_REPETIDO com userMessage pt-BR;
//  - GET /localidades?empresa=...&destino=nf: os destinos da entrada por NF (com entradaEm); sem destino, a lista
//    do formulario manual, inalterada.

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getConfig: () => ({}),
  getDb: vi.fn(),
  getPool: vi.fn(),
}));

vi.mock('../middleware/role.js', () => ({
  requireOperador: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: { id: string; role: string } }).user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'operador' };
    next();
  },
  requireGestor: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: { id: string; role: string } }).user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'gestor' };
    next();
  },
}));
vi.mock('../middleware/armazem-vinculado.js', () => ({
  requireArmazemVinculado: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const svc = vi.hoisted(() => ({
  processarRecebimentoNacionalPorNf: vi.fn(),
  listarLocalidadesNacional: vi.fn(),
  listarDestinosEntradaNf: vi.fn(),
  buscarProdutosNacional: vi.fn(),
  getDetalheNfNacional: vi.fn(),
  definirConjuntoCorrelacao: vi.fn(),
}));
vi.mock('../services/fila-nacional.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/fila-nacional.service.js')>('../services/fila-nacional.service.js');
  return { ...real, getDetalheNfNacional: (...a: unknown[]) => svc.getDetalheNfNacional(...a) };
});
vi.mock('../services/correlacao-produto.service.js', () => ({
  definirConjuntoCorrelacao: (...a: unknown[]) => svc.definirConjuntoCorrelacao(...a),
}));
vi.mock('../services/recebimento-nacional.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/recebimento-nacional.service.js')>('../services/recebimento-nacional.service.js');
  return {
    ...real,
    processarRecebimentoNacionalPorNf: (...a: unknown[]) => svc.processarRecebimentoNacionalPorNf(...a),
    listarLocalidadesNacional: (...a: unknown[]) => svc.listarLocalidadesNacional(...a),
    listarDestinosEntradaNf: (...a: unknown[]) => svc.listarDestinosEntradaNf(...a),
    buscarProdutosNacional: (...a: unknown[]) => svc.buscarProdutosNacional(...a),
  };
});

import router from '../routes/recebimento-nacional.routes.js';
import {
  ProdutoSemCorrelatoQ2pError,
  ProdutoCorrelatoQ2pRepetidoError,
  ValidacaoRecebimentoNacionalError,
  LocalidadeNaoElegivelError,
} from '../services/recebimento-nacional.service.js';

const CHAVE = '35261011111111000111550010000009370000009370';
const LOC = '21111111-1111-4111-8111-111111111111';
const URL_POR_NF = '/api/v1/stockbridge/recebimento/nacional/por-nf';
const URL_LOCALIDADES = '/api/v1/stockbridge/recebimento/nacional/localidades';
const app = express();
app.use(express.json());
app.use(router);

const corpo = (produtos: Array<Record<string, unknown>>) => ({
  nf_chave_acesso: CHAVE,
  itens: [{ indice: 0, descricao_fornecedor: 'PP PRETO Q35', produtos }],
});

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset();
  svc.processarRecebimentoNacionalPorNf.mockResolvedValue({ nfChaveAcesso: CHAVE, notaFiscal: '937', produtos: [], resumo: { enviadosParaAprovacao: 0, jaRecebidos: 0, bloqueados: 0, falhas: 0 } });
});

describe('POST /por-nf — produto XOR', () => {
  it('produto_codigo_acxe: o servico recebe produtoCodigoAcxe e NAO recebe produtoCodigoQ2p', async () => {
    const res = await request(app).post(URL_POR_NF).send(corpo([{ produto_codigo_acxe: 4001, quantidade_kg: 26000, localidade_id: LOC }]));
    expect(res.status).toBe(201);
    const input = svc.processarRecebimentoNacionalPorNf.mock.calls[0]![0] as { itens: Array<{ produtos: unknown[] }> };
    expect(input.itens[0]!.produtos).toEqual([{ produtoCodigoAcxe: 4001, quantidadeKg: 26000, localidadeId: LOC }]);
    expect(input.itens[0]!.produtos[0]).not.toHaveProperty('produtoCodigoQ2p');
  });

  it('produto_codigo_q2p: o formato de sempre (so produtoCodigoQ2p)', async () => {
    await request(app).post(URL_POR_NF).send(corpo([{ produto_codigo_q2p: 3033097757, quantidade_kg: 13160, localidade_id: LOC }]));
    const input = svc.processarRecebimentoNacionalPorNf.mock.calls[0]![0] as { itens: Array<{ produtos: unknown[] }> };
    expect(input.itens[0]!.produtos).toEqual([{ produtoCodigoQ2p: 3033097757, quantidadeKg: 13160, localidadeId: LOC }]);
    expect(input.itens[0]!.produtos[0]).not.toHaveProperty('produtoCodigoAcxe');
  });

  it.each([
    ['os dois codigos', { produto_codigo_acxe: 4001, produto_codigo_q2p: 3033097757, quantidade_kg: 1, localidade_id: LOC }],
    ['nenhum dos dois', { quantidade_kg: 1, localidade_id: LOC }],
    ['os dois nulos', { produto_codigo_acxe: null, produto_codigo_q2p: null, quantidade_kg: 1, localidade_id: LOC }],
    ['empresa no corpo (a empresa vem da NF)', { produto_codigo_acxe: 4001, quantidade_kg: 1, localidade_id: LOC, empresa: 'acxe' }],
    ['valor no produto (o valor vem da NF)', { produto_codigo_acxe: 4001, quantidade_kg: 1, localidade_id: LOC, valor_unitario_brl: 9 }],
    ['codigo da ACXE nao positivo', { produto_codigo_acxe: 0, quantidade_kg: 1, localidade_id: LOC }],
  ])('400 INVALID_INPUT: %s', async (_n, produto) => {
    const res = await request(app).post(URL_POR_NF).send(corpo([produto]));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(svc.processarRecebimentoNacionalPorNf).not.toHaveBeenCalled();
  });

  it.each([
    [
      new ValidacaoRecebimentoNacionalError('PRODUTO_EMPRESA_INCOMPATIVEL', 'A NF 937 é da ACXE: escolha o produto do cadastro da ACXE.'),
      400, 'PRODUTO_EMPRESA_INCOMPATIVEL',
    ],
    [new LocalidadeNaoElegivelError(LOC, 'o estoque escolhido não está entre os estoques da ACXE'), 400, 'LOCALIDADE_NAO_ELEGIVEL'],
    [new ProdutoSemCorrelatoQ2pError('SUCATA DE PLASTICO', '21.1'), 422, 'PRODUTO_SEM_CORRELATO_Q2P'],
    [new ProdutoCorrelatoQ2pRepetidoError('PP PRETO Q35', 'PP PRETO Q35'), 422, 'PRODUTO_CORRELATO_Q2P_REPETIDO'],
  ])('mapeia %# -> %i %s com userMessage', async (err, status, code) => {
    svc.processarRecebimentoNacionalPorNf.mockRejectedValue(err);
    const res = await request(app).post(URL_POR_NF).send(corpo([{ produto_codigo_acxe: 4001, quantidade_kg: 26000, localidade_id: LOC }]));
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.userMessage).toBe((err as Error).message);
  });

  it('o 422 de produto sem correspondente traz o texto exato do contrato, sem codigo OMIE', async () => {
    svc.processarRecebimentoNacionalPorNf.mockRejectedValue(new ProdutoSemCorrelatoQ2pError('SUCATA DE PLASTICO'));
    const res = await request(app).post(URL_POR_NF).send(corpo([{ produto_codigo_acxe: 4002, quantidade_kg: 26000, localidade_id: LOC }]));
    expect(res.body.error.userMessage).toBe(
      'O produto "SUCATA DE PLASTICO" não tem correspondente na Q2P, então não pode entrar em estoque que também é da Q2P. Escolha um estoque só da ACXE ou peça o cadastro do produto na Q2P.',
    );
    expect(res.body.error.userMessage).not.toMatch(/\d{7,}/);
  });
});

describe('GET /localidades — destino=nf', () => {
  const destinosAcxe = [
    { id: LOC, codigo: '21.1', nome: 'EXTREMA', tipo: 'proprio', entradaEm: ['acxe', 'q2p'] },
    { id: 'b', codigo: '20.0.7', nome: 'PRODUÇÃO', tipo: 'operacional', entradaEm: ['acxe'] },
  ];

  it('destino=nf & empresa=acxe: os destinos da entrada por NF, com entradaEm', async () => {
    svc.listarDestinosEntradaNf.mockResolvedValue(destinosAcxe);
    const res = await request(app).get(`${URL_LOCALIDADES}?empresa=acxe&destino=nf`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(destinosAcxe);
    expect(svc.listarDestinosEntradaNf).toHaveBeenCalledWith('acxe');
    expect(svc.listarLocalidadesNacional).not.toHaveBeenCalled();
  });

  it('destino=nf & empresa=q2p: a mesma rota, empresa q2p', async () => {
    svc.listarDestinosEntradaNf.mockResolvedValue([{ id: 'c', codigo: '11.2', nome: 'SANTO ANDRE (NACIONAL)', tipo: 'proprio', entradaEm: ['q2p'] }]);
    const res = await request(app).get(`${URL_LOCALIDADES}?empresa=q2p&destino=nf`);
    expect(res.status).toBe(200);
    expect(svc.listarDestinosEntradaNf).toHaveBeenCalledWith('q2p');
  });

  it('sem destino: a lista do formulario manual, inalterada', async () => {
    svc.listarLocalidadesNacional.mockResolvedValue([{ id: 'x', codigo: '21.2', nome: 'EXTREMA (NACIONAL)', empresa: 'acxe' }]);
    const res = await request(app).get(`${URL_LOCALIDADES}?empresa=acxe`);
    expect(res.status).toBe(200);
    expect(svc.listarLocalidadesNacional).toHaveBeenCalledWith('acxe');
    expect(svc.listarDestinosEntradaNf).not.toHaveBeenCalled();
  });

  it.each([['destino desconhecido', '?empresa=acxe&destino=xyz'], ['empresa invalida', '?empresa=outra&destino=nf'], ['sem empresa', '?destino=nf']])(
    '400 INVALID_INPUT: %s',
    async (_n, qs) => {
      const res = await request(app).get(`${URL_LOCALIDADES}${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    },
  );

  it('falha de banco: 500 LOCALIDADES_NACIONAL_FAIL', async () => {
    svc.listarDestinosEntradaNf.mockRejectedValue(new Error('db fora'));
    const res = await request(app).get(`${URL_LOCALIDADES}?empresa=acxe&destino=nf`);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('LOCALIDADES_NACIONAL_FAIL');
  });
});

describe('GET /produtos — empresa=acxe repassa semCorrelatoQ2p', () => {
  it('devolve o que o servico montou', async () => {
    svc.buscarProdutosNacional.mockResolvedValue([
      { codigo: 4001, descricao: 'PP PRETO Q35', unidadeMedida: 'KG', semCorrelatoQ2p: false },
      { codigo: 4002, descricao: 'SUCATA DE PLASTICO', unidadeMedida: 'KG', semCorrelatoQ2p: true },
    ]);
    const res = await request(app).get('/api/v1/stockbridge/recebimento/nacional/produtos?empresa=acxe&q=PP');
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { semCorrelatoQ2p: boolean }) => p.semCorrelatoQ2p)).toEqual([false, true]);
    expect(svc.buscarProdutosNacional).toHaveBeenCalledWith({ empresa: 'acxe', q: 'PP', limit: 50 });
  });
});

describe('PUT /correlacao — a memoria fornecedor x descricao e so da Q2P', () => {
  const URL_CORRELACAO = '/api/v1/stockbridge/recebimento/nacional/correlacao';
  const body = { nf_chave_acesso: CHAVE, descricao_nf: 'PP PRETO Q35', produtos_codigo_q2p: [3033097757] };

  it('NF da ACXE: 422 CORRELACAO_SO_Q2P e nada e memorizado', async () => {
    svc.getDetalheNfNacional.mockResolvedValue({ nfChaveAcesso: CHAVE, empresa: 'acxe', fornecedorCnpj: '11.111.111/0001-11', fornecedorNome: 'SOLUTEC' });
    const res = await request(app).put(URL_CORRELACAO).send(body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CORRELACAO_SO_Q2P');
    expect(res.body.error.userMessage).toContain('NF da Q2P');
    expect(svc.definirConjuntoCorrelacao).not.toHaveBeenCalled();
  });

  it('NF da Q2P (ou detalhe sem empresa): como sempre', async () => {
    svc.definirConjuntoCorrelacao.mockResolvedValue({ adicionados: 1, mantidos: 0, desativados: 0, produtosNaoEncontrados: [] });
    svc.getDetalheNfNacional.mockResolvedValue({ nfChaveAcesso: CHAVE, empresa: 'q2p', fornecedorCnpj: '68.176.072/0001-28', fornecedorNome: 'ISOFORMA' });
    expect((await request(app).put(URL_CORRELACAO).send(body)).status).toBe(200);
    svc.getDetalheNfNacional.mockResolvedValue({ nfChaveAcesso: CHAVE, fornecedorCnpj: '68.176.072/0001-28', fornecedorNome: 'ISOFORMA' });
    expect((await request(app).put(URL_CORRELACAO).send(body)).status).toBe(200);
    expect(svc.definirConjuntoCorrelacao).toHaveBeenCalledTimes(2);
  });
});
