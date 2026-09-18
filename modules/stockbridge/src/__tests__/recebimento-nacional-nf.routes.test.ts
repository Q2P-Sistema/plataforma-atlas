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
  getConfig: () => ({}),
  getDb: vi.fn(),
  getPool: vi.fn(),
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
  definirConjuntoCorrelacao: vi.fn(),
  solicitarRecebimentoExterno: vi.fn(),
};
let flagExterno = true;
vi.mock('../services/correlacao-produto.service.js', () => ({
  definirConjuntoCorrelacao: (...a: unknown[]) => svc.definirConjuntoCorrelacao(...a),
}));
vi.mock('../services/recebimento-externo.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/recebimento-externo.service.js')>('../services/recebimento-externo.service.js');
  return {
    ...real,
    recebimentoExternoHabilitado: () => flagExterno,
    solicitarRecebimentoExterno: (...a: unknown[]) => svc.solicitarRecebimentoExterno(...a),
  };
});
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
import { ItemJaRecebidoError, NenhumItemPendenteError, MotivoObrigatorioError, ItemNaoCorrespondeError } from '../services/recebimento-externo.service.js';

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
  flagExterno = true;
  for (const f of Object.values(svc)) f.mockReset();
  svc.getFilaNacional.mockResolvedValue([]);
  svc.getDetalheNfNacional.mockResolvedValue({ nfChaveAcesso: CHAVE, notaFiscal: '66724', fornecedorCnpj: '68.176.072/0001-28', fornecedorNome: 'ISOFORMA PLASTICOS INDUSTRIAIS LTDA', itens: [] });
  svc.definirConjuntoCorrelacao.mockResolvedValue({ adicionados: 1, mantidos: 0, desativados: 0, produtosNaoEncontrados: [] });
  svc.solicitarRecebimentoExterno.mockResolvedValue({ notaFiscal: '66724', aprovacoesCriadas: 1, jaSolicitados: 0, status: 'pendente_aprovacao', aprovacaoIds: ['ap-1'] });
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

  it('200 com o detalhe + flag de baixa externa (a UI esconde a acao quando desligada)', async () => {
    let res = await request(app).get(`/api/v1/stockbridge/recebimento/nacional/fila/${CHAVE}`);
    expect(res.status).toBe(200);
    expect(res.body.data.nfChaveAcesso).toBe(CHAVE);
    expect(res.body.data.recebimentoExternoHabilitado).toBe(true);
    flagExterno = false;
    res = await request(app).get(`/api/v1/stockbridge/recebimento/nacional/fila/${CHAVE}`);
    expect(res.body.data.recebimentoExternoHabilitado).toBe(false);
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

// ── Historia 3/4 — PUT /correlacao (contrato §4, T042) ─────────────────────
describe('PUT /recebimento/nacional/correlacao', () => {
  const body = () => ({ nf_chave_acesso: CHAVE, descricao_nf: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtos_codigo_q2p: [3033097757, 3033097763] });

  it('200: fornecedor (cnpj/nome) resolvido pela chave da NF no servidor, conjunto repassado ao servico', async () => {
    const res = await request(app).put('/api/v1/stockbridge/recebimento/nacional/correlacao').send(body());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ adicionados: 1, mantidos: 0, desativados: 0 });
    expect(svc.getDetalheNfNacional).toHaveBeenCalledWith(CHAVE);
    expect(svc.definirConjuntoCorrelacao).toHaveBeenCalledWith({
      fornecedorCnpj: '68.176.072/0001-28', fornecedorNome: 'ISOFORMA PLASTICOS INDUSTRIAIS LTDA',
      descricaoNf: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtosCodigoQ2p: [3033097757, 3033097763],
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
  });

  it('cnpj/nome do fornecedor e nome do produto NAO sao aceitos do cliente (.strict)', async () => {
    const res = await request(app).put('/api/v1/stockbridge/recebimento/nacional/correlacao').send({ ...body(), fornecedor_cnpj: '00.000.000/0001-00', fornecedor_nome: 'FALSO' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(svc.definirConjuntoCorrelacao).not.toHaveBeenCalled();
  });

  it.each([
    ['chave invalida', { nf_chave_acesso: '66724' }],
    ['descricao vazia', { descricao_nf: '   ' }],
    ['codigo nao inteiro positivo', { produtos_codigo_q2p: [0] }],
  ])('400 INVALID_INPUT: %s', async (_n, over) => {
    const res = await request(app).put('/api/v1/stockbridge/recebimento/nacional/correlacao').send({ ...body(), ...over });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('produto repetido -> 400 PRODUTO_REPETIDO_NO_ITEM', async () => {
    const res = await request(app).put('/api/v1/stockbridge/recebimento/nacional/correlacao').send({ ...body(), produtos_codigo_q2p: [1, 1] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PRODUTO_REPETIDO_NO_ITEM');
  });

  it('produto fora do catalogo -> 404 PRODUTO_NAO_ENCONTRADO sem codigo OMIE na userMessage', async () => {
    svc.definirConjuntoCorrelacao.mockResolvedValue({ adicionados: 0, mantidos: 0, desativados: 0, produtosNaoEncontrados: [999999] });
    const res = await request(app).put('/api/v1/stockbridge/recebimento/nacional/correlacao').send(body());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PRODUTO_NAO_ENCONTRADO');
    expect(res.body.error.userMessage).not.toContain('999999');
  });

  it('NF fora do espelho -> 404 NF_NAO_ENCONTRADA; erro inesperado -> 500 CORRELACAO_FAIL; exige operador com armazem', async () => {
    svc.getDetalheNfNacional.mockRejectedValue(new NfNacionalNaoEncontradaError(CHAVE));
    let res = await request(app).put('/api/v1/stockbridge/recebimento/nacional/correlacao').send(body());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NF_NAO_ENCONTRADA');

    svc.getDetalheNfNacional.mockResolvedValue({ nfChaveAcesso: CHAVE, fornecedorCnpj: 'x', fornecedorNome: 'y', itens: [] });
    svc.definirConjuntoCorrelacao.mockRejectedValue(new Error('boom'));
    res = await request(app).put('/api/v1/stockbridge/recebimento/nacional/correlacao').send(body());
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CORRELACAO_FAIL');

    armazemVinculado = false;
    expect((await request(app).put('/api/v1/stockbridge/recebimento/nacional/correlacao').send(body())).status).toBe(403);
    roleAtual = null;
    expect((await request(app).put('/api/v1/stockbridge/recebimento/nacional/correlacao').send(body())).status).toBe(401);
  });
});

// ── Historia 6 — POST /recebimento-externo (contrato §5, T068) ─────────────
describe('POST /recebimento/nacional/recebimento-externo', () => {
  const url = '/api/v1/stockbridge/recebimento/nacional/recebimento-externo';
  const body = () => ({ nf_chave_acesso: CHAVE, motivo: 'Recebido direto no OMIE em 12/09 por indisponibilidade do Atlas', itens: [{ indice: 0, descricao_fornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO' }] });

  it('201 com o resumo; itens repassados ao servico', async () => {
    const res = await request(app).post(url).send(body());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ aprovacoesCriadas: 1, status: 'pendente_aprovacao' });
    expect(svc.solicitarRecebimentoExterno).toHaveBeenCalledWith({
      nfChaveAcesso: CHAVE, motivo: body().motivo,
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO' }],
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
  });

  it('itens ausente = todos os pendentes (servico recebe null)', async () => {
    const { itens: _omit, ...semItens } = body();
    void _omit;
    const res = await request(app).post(url).send(semItens);
    expect(res.status).toBe(201);
    expect(svc.solicitarRecebimentoExterno.mock.calls[0]![0]).toMatchObject({ itens: null });
  });

  it('flag desligada -> 403 RECEBIMENTO_EXTERNO_DESABILITADO, sem tocar no servico (T071)', async () => {
    flagExterno = false;
    const res = await request(app).post(url).send(body());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('RECEBIMENTO_EXTERNO_DESABILITADO');
    expect(svc.solicitarRecebimentoExterno).not.toHaveBeenCalled();
  });

  it.each([
    ['motivo ausente', { motivo: undefined }],
    ['motivo em branco', { motivo: '   ' }],
  ])('400 MOTIVO_OBRIGATORIO: %s', async (_n, over) => {
    const res = await request(app).post(url).send({ ...body(), ...over });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MOTIVO_OBRIGATORIO');
    expect(res.body.error.userMessage).toContain('motivo');
    expect(svc.solicitarRecebimentoExterno).not.toHaveBeenCalled();
  });

  it.each([
    ['chave invalida', { nf_chave_acesso: '66724' }],
    ['campo desconhecido', { quantidade_kg: 100 }],
    ['item sem descricao', { itens: [{ indice: 0 }] }],
  ])('400 INVALID_INPUT: %s — com userMessage institucional, nunca o texto do Zod', async (_n, over) => {
    const res = await request(app).post(url).send({ ...body(), ...over });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(res.body.error.userMessage).toContain('dados enviados são inválidos');
  });

  it.each([
    [new ItemJaRecebidoError('SUCATA PSAI'), 409, 'ITEM_JA_RECEBIDO'],
    [new NenhumItemPendenteError('66724'), 409, 'NENHUM_ITEM_PENDENTE'],
    [new ItemNaoCorrespondeError('OUTRA COISA', '66724'), 400, 'ITEM_NAO_ENCONTRADO'],
    [new MotivoObrigatorioError(), 400, 'MOTIVO_OBRIGATORIO'],
    [new NfNacionalNaoEncontradaError(CHAVE), 404, 'NF_NAO_ENCONTRADA'],
    [new FornecedorExcluidoError('PLASTFIX'), 422, 'FORNECEDOR_EXCLUIDO'],
    [new Error('boom'), 500, 'RECEBIMENTO_EXTERNO_FAIL'],
  ])('mapeia erro de dominio -> %i %s', async (err, status, code) => {
    svc.solicitarRecebimentoExterno.mockRejectedValue(err);
    const res = await request(app).post(url).send(body());
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  });

  it('exige operador autenticado com armazem vinculado', async () => {
    armazemVinculado = false;
    expect((await request(app).post(url).send(body())).status).toBe(403);
    roleAtual = null;
    expect((await request(app).post(url).send(body())).status).toBe(401);
  });
});
