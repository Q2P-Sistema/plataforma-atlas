import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Feature 015 (ACXEGDP-328), T028 — contrato HTTP das 3 rotas novas do recebimento
// nacional por NF: roles, 400 de payload invalido, RECUSA de valor enviado pelo
// cliente (invariante 2 do contrato) e mapeamento de erros de dominio.

let roleAtual: 'operador' | 'gestor' | 'diretor' | null = 'operador';
let armazemVinculado = true;

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Middlewares reais dependem de sessao/banco — aqui simulamos o contrato deles.
vi.mock('../middleware/role.js', () => ({
  requireOperador: (req: Request, res: Response, next: NextFunction) => {
    if (!roleAtual) {
      res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'sem sessão' } });
      return;
    }
    (req as Request & { user?: { id: string; role: string } }).user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: roleAtual };
    next();
  },
}));
vi.mock('../middleware/armazem-vinculado.js', () => ({
  requireArmazemVinculado: (_req: Request, res: Response, next: NextFunction) => {
    if (!armazemVinculado) {
      res.status(403).json({ data: null, error: { code: 'OPERADOR_ARMAZEM_NAO_VINCULADO', message: 'sem galpão' } });
      return;
    }
    next();
  },
}));

const svc = {
  getFilaNacional: vi.fn(),
  getDetalheNfNacional: vi.fn(),
  processarRecebimentoNacionalPorNf: vi.fn(),
};
vi.mock('../services/fila-nacional.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/fila-nacional.service.js')>('../services/fila-nacional.service.js');
  return {
    ...real,
    getFilaNacional: (...a: unknown[]) => svc.getFilaNacional(...a),
    getDetalheNfNacional: (...a: unknown[]) => svc.getDetalheNfNacional(...a),
  };
});
vi.mock('../services/recebimento-nacional.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/recebimento-nacional.service.js')>('../services/recebimento-nacional.service.js');
  return {
    ...real,
    listarLocalidadesNacional: vi.fn(),
    buscarProdutosNacional: vi.fn(),
    processarRecebimentoNacional: vi.fn(),
    processarRecebimentoNacionalPorNf: (...a: unknown[]) => svc.processarRecebimentoNacionalPorNf(...a),
  };
});

import router from '../routes/recebimento-nacional.routes.js';
import {
  DataCorteNaoConfiguradaError,
  NfNacionalNaoEncontradaError,
  NfNacionalCanceladaError,
  FornecedorExcluidoError,
} from '../services/fila-nacional.service.js';
import {
  ValidacaoRecebimentoNacionalError,
  NfNacionalJaProcessadaError,
  LocalidadeNaoElegivelError,
} from '../services/recebimento-nacional.service.js';

const CHAVE = '35260868176072000128550010000667241693158505';
const LOC = '11111111-1111-4111-8111-111111111111';
const app = express();
app.use(express.json());
app.use(router);

const bodyValido = () => ({
  nf_chave_acesso: CHAVE,
  itens: [{ indice: 0, descricao_fornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtos: [{ produto_codigo_q2p: 3033097757, quantidade_kg: 13160, localidade_id: LOC }] }],
});

beforeEach(() => {
  roleAtual = 'operador';
  armazemVinculado = true;
  for (const f of Object.values(svc)) f.mockReset();
  svc.getFilaNacional.mockResolvedValue([]);
  svc.getDetalheNfNacional.mockResolvedValue({ nfChaveAcesso: CHAVE, itens: [] });
  svc.processarRecebimentoNacionalPorNf.mockResolvedValue({ nfChaveAcesso: CHAVE, notaFiscal: '66724', produtos: [], resumo: { enviadosParaAprovacao: 0, jaRecebidos: 0, bloqueados: 0, falhas: 0 } });
});

describe('GET /recebimento/nacional/fila', () => {
  it('200 com a fila; repassa q e fornecedor', async () => {
    svc.getFilaNacional.mockResolvedValue([{ nfChaveAcesso: CHAVE }]);
    const res = await request(app).get('/api/v1/stockbridge/recebimento/nacional/fila?q=667&fornecedor=ISO');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ nfChaveAcesso: CHAVE }]);
    expect(svc.getFilaNacional).toHaveBeenCalledWith({ q: '667', fornecedor: 'ISO' });
  });

  it('exige sessao (401) e armazem vinculado (403)', async () => {
    roleAtual = null;
    expect((await request(app).get('/api/v1/stockbridge/recebimento/nacional/fila')).status).toBe(401);
    roleAtual = 'operador';
    armazemVinculado = false;
    expect((await request(app).get('/api/v1/stockbridge/recebimento/nacional/fila')).status).toBe(403);
  });

  it('a data de corte NAO e aceita como parametro de query (invariante 10)', async () => {
    svc.getFilaNacional.mockResolvedValue([]);
    await request(app).get('/api/v1/stockbridge/recebimento/nacional/fila?janelaDias=3650&dataCorte=2020-01-01');
    // parametros desconhecidos sao ignorados e NAO chegam ao servico
    expect(svc.getFilaNacional).toHaveBeenCalledWith({ q: null, fornecedor: null });
  });

  it('503 FILA_NACIONAL_NAO_CONFIGURADA quando falta a data de corte', async () => {
    svc.getFilaNacional.mockRejectedValue(new DataCorteNaoConfiguradaError());
    const res = await request(app).get('/api/v1/stockbridge/recebimento/nacional/fila');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('FILA_NACIONAL_NAO_CONFIGURADA');
    expect(res.body.error.userMessage).toContain('data de corte');
  });
});

describe('GET /recebimento/nacional/fila/:chaveAcesso', () => {
  it('400 para chave que nao tem 44 digitos', async () => {
    const res = await request(app).get('/api/v1/stockbridge/recebimento/nacional/fila/66724');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(svc.getDetalheNfNacional).not.toHaveBeenCalled();
  });

  it('200 com o detalhe', async () => {
    const res = await request(app).get(`/api/v1/stockbridge/recebimento/nacional/fila/${CHAVE}`);
    expect(res.status).toBe(200);
    expect(res.body.data.nfChaveAcesso).toBe(CHAVE);
  });

  it.each([
    [new NfNacionalNaoEncontradaError(CHAVE), 404, 'NF_NAO_ENCONTRADA'],
    [new NfNacionalCanceladaError('66724'), 422, 'NF_CANCELADA'],
    [new FornecedorExcluidoError('PLASTFIX'), 422, 'FORNECEDOR_EXCLUIDO'],
  ])('mapeia %s -> %i %s', async (err, status, code) => {
    svc.getDetalheNfNacional.mockRejectedValue(err);
    const res = await request(app).get(`/api/v1/stockbridge/recebimento/nacional/fila/${CHAVE}`);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(typeof res.body.error.userMessage).toBe('string');
  });
});

describe('POST /recebimento/nacional/por-nf', () => {
  it('201 com desfecho por produto e mapeia snake_case -> camelCase', async () => {
    const res = await request(app).post('/api/v1/stockbridge/recebimento/nacional/por-nf').send({
      ...bodyValido(),
      observacoes: 'obs',
      itens: [{ indice: 0, descricao_fornecedor: 'X', quantidade_conferida_kg: 13500, motivo_divergencia: 'balança',
        produtos: [{ produto_codigo_q2p: 3033097757, quantidade_kg: 13500, localidade_id: LOC }] }],
    });
    expect(res.status).toBe(201);
    expect(svc.processarRecebimentoNacionalPorNf).toHaveBeenCalledWith({
      nfChaveAcesso: CHAVE,
      observacoes: 'obs',
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      itens: [{ indice: 0, descricaoFornecedor: 'X', quantidadeConferidaKg: 13500, motivoDivergencia: 'balança', observacoes: null,
        produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 13500, localidadeId: LOC }] }],
    });
  });

  it.each([
    ['valor_item_brl no produto', { produtos: [{ produto_codigo_q2p: 1, quantidade_kg: 1, localidade_id: LOC, valor_item_brl: 100 }] }],
    ['valor_unitario no produto', { produtos: [{ produto_codigo_q2p: 1, quantidade_kg: 1, localidade_id: LOC, valor_unitario_brl: 9 }] }],
    ['unidade no item', { unidade: 'kg' }],
    ['valor_total no item', { valor_total_item_brl: 100 }],
  ])('RECUSA valor/unidade enviados pelo cliente (%s) com 400 — o valor vem da NF', async (_n, extra) => {
    const body = bodyValido();
    body.itens[0] = { ...body.itens[0]!, ...(extra as object) } as never;
    const res = await request(app).post('/api/v1/stockbridge/recebimento/nacional/por-nf').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(svc.processarRecebimentoNacionalPorNf).not.toHaveBeenCalled();
  });

  it('RECUSA valor_total_nf_brl no cabecalho (o total e derivado da NF)', async () => {
    const res = await request(app).post('/api/v1/stockbridge/recebimento/nacional/por-nf').send({ ...bodyValido(), valor_total_nf_brl: 1 });
    expect(res.status).toBe(400);
  });

  it.each([
    ['chave invalida', { nf_chave_acesso: '66724' }],
    ['itens vazio', { itens: [] }],
    ['produtos vazio', { itens: [{ indice: 0, descricao_fornecedor: 'X', produtos: [] }] }],
    ['quantidade nao positiva', { itens: [{ indice: 0, descricao_fornecedor: 'X', produtos: [{ produto_codigo_q2p: 1, quantidade_kg: 0, localidade_id: LOC }] }] }],
    ['localidade nao uuid', { itens: [{ indice: 0, descricao_fornecedor: 'X', produtos: [{ produto_codigo_q2p: 1, quantidade_kg: 1, localidade_id: 'abc' }] }] }],
  ])('400 INVALID_INPUT: %s', async (_n, over) => {
    const res = await request(app).post('/api/v1/stockbridge/recebimento/nacional/por-nf').send({ ...bodyValido(), ...over });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('exige armazem vinculado (403)', async () => {
    armazemVinculado = false;
    const res = await request(app).post('/api/v1/stockbridge/recebimento/nacional/por-nf').send(bodyValido());
    expect(res.status).toBe(403);
  });

  it.each([
    [new ValidacaoRecebimentoNacionalError('MOTIVO_DIVERGENCIA_OBRIGATORIO', 'informe o motivo'), 400, 'MOTIVO_DIVERGENCIA_OBRIGATORIO'],
    [new ValidacaoRecebimentoNacionalError('DISTRIBUICAO_NAO_FECHA', 'nao fecha'), 400, 'DISTRIBUICAO_NAO_FECHA'],
    [new ValidacaoRecebimentoNacionalError('PRODUTO_REPETIDO_NO_ITEM', 'repetido'), 400, 'PRODUTO_REPETIDO_NO_ITEM'],
    [new LocalidadeNaoElegivelError(LOC, 'espelhado'), 400, 'LOCALIDADE_NAO_ELEGIVEL'],
    [new NfNacionalNaoEncontradaError(CHAVE), 404, 'NF_NAO_ENCONTRADA'],
    [new NfNacionalJaProcessadaError('66724'), 409, 'NF_JA_PROCESSADA'],
    [new NfNacionalCanceladaError('66724'), 422, 'NF_CANCELADA'],
  ])('mapeia erro de dominio -> %i %s', async (err, status, code) => {
    svc.processarRecebimentoNacionalPorNf.mockRejectedValue(err);
    const res = await request(app).post('/api/v1/stockbridge/recebimento/nacional/por-nf').send(bodyValido());
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(typeof res.body.error.userMessage).toBe('string');
  });

  it('erro inesperado -> 500 RECEBIMENTO_NACIONAL_NF_FAIL', async () => {
    svc.processarRecebimentoNacionalPorNf.mockRejectedValue(new Error('boom'));
    const res = await request(app).post('/api/v1/stockbridge/recebimento/nacional/por-nf').send(bodyValido());
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('RECEBIMENTO_NACIONAL_NF_FAIL');
  });
});
