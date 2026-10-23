import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Feature 017, Historia 5 (ACXEGDP-437) — HTTP da fila e do detalhe de NF nacional com a ACXE.
//
//  - GET /fila aceita `?empresa=q2p|acxe` (repassado ao servico SO quando enviado — sem ele a chamada e a de antes) e
//    devolve `meta.recebimentoNacionalAcxeHabilitado`, que a tela usa para mostrar o selo de empresa e o filtro;
//  - o meta da ACXE vale so com as TRES condicoes (chave + fiscal pelo Atlas + corte proprio): chave ligada sem as
//    outras duas NAO mostra a ACXE na tela;
//  - GET /fila/:chave passa o detalhe adiante (empresa, produtos sugeridos com `semCorrelatoQ2p`, local dos candidatos).
// Padrao do rotas-dispensa.test.ts: middlewares simulados e servicos espionados.

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getFilaNacional: vi.fn(),
  getDetalheNfNacional: vi.fn(),
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => mocks.logger,
  getConfig: () => mocks.config,
  getDb: vi.fn(),
  getPool: vi.fn(),
}));

vi.mock('../middleware/role.js', () => ({
  requireOperador: (req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user: { id: string; role: string } }).user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'operador' };
    next();
  },
  requireGestor: (req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user: { id: string; role: string } }).user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'gestor' };
    next();
  },
}));
vi.mock('../middleware/armazem-vinculado.js', () => ({
  requireArmazemVinculado: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../services/correlacao-produto.service.js', () => ({ definirConjuntoCorrelacao: vi.fn() }));
vi.mock('../services/recebimento-externo.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/recebimento-externo.service.js')>('../services/recebimento-externo.service.js');
  return { ...real, recebimentoExternoHabilitado: () => true, solicitarRecebimentoExterno: vi.fn() };
});
vi.mock('../services/fila-nacional.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/fila-nacional.service.js')>('../services/fila-nacional.service.js');
  return {
    ...real,
    getFilaNacional: (...a: unknown[]) => mocks.getFilaNacional(...a),
    getDetalheNfNacional: (...a: unknown[]) => mocks.getDetalheNfNacional(...a),
  };
});
vi.mock('../services/recebimento-nacional.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/recebimento-nacional.service.js')>('../services/recebimento-nacional.service.js');
  return { ...real, listarLocalidadesNacional: vi.fn(), listarDestinosEntradaNf: vi.fn(), buscarProdutosNacional: vi.fn(), processarRecebimentoNacional: vi.fn(), processarRecebimentoNacionalPorNf: vi.fn() };
});
vi.mock('../services/recebimento-fiscal.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/recebimento-fiscal.service.js')>('../services/recebimento-fiscal.service.js');
  return { ...real, concluirRecebimentoFiscal: vi.fn(), listarLedgerFiscal: vi.fn() };
});
vi.mock('../services/nf-dispensa.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/nf-dispensa.service.js')>('../services/nf-dispensa.service.js');
  return { ...real, dispensarNf: vi.fn(), listarDispensas: vi.fn(), reverterDispensa: vi.fn() };
});

import router from '../routes/recebimento-nacional.routes.js';
import { FilaNacionalIncompletaError, NfNacionalNaoEncontradaError } from '../services/fila-nacional.service.js';
import { __resetEmpresaNacional } from '../services/empresa-nacional.js';

const BASE = '/api/v1/stockbridge/recebimento/nacional';
const CHAVE_ACXE = '35261012345678000190550010000009371000009370';
const app = express();
app.use(express.json());
app.use(router);

function configurar(opts: { fiscal?: boolean; acxe?: boolean; corte?: string | null } = {}): void {
  const { fiscal = true, acxe = true, corte = '2026-10-01' } = opts;
  for (const k of Object.keys(mocks.config)) delete mocks.config[k];
  mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = fiscal;
  mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED = acxe;
  if (corte) mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE = corte;
}

beforeEach(() => {
  configurar();
  __resetEmpresaNacional();
  for (const f of Object.values(mocks.logger)) f.mockClear();
  mocks.getFilaNacional.mockReset();
  mocks.getFilaNacional.mockResolvedValue([]);
  mocks.getDetalheNfNacional.mockReset();
});

const argumentoDaFila = (): Record<string, unknown> => mocks.getFilaNacional.mock.calls[0]![0] as Record<string, unknown>;

describe('GET /fila — filtro por empresa', () => {
  it('sem ?empresa a chamada ao servico e a de antes da Historia 5: so q e fornecedor, SEM a chave `empresa`', async () => {
    const res = await request(app).get(`${BASE}/fila`);
    expect(res.status).toBe(200);
    expect(mocks.getFilaNacional).toHaveBeenCalledTimes(1);
    expect(argumentoDaFila()).toEqual({ q: null, fornecedor: null });
    expect(argumentoDaFila()).not.toHaveProperty('empresa');
  });

  it.each(['q2p', 'acxe'] as const)('?empresa=%s e repassado ao servico', async (empresa) => {
    const res = await request(app).get(`${BASE}/fila?empresa=${empresa}`);
    expect(res.status).toBe(200);
    expect(argumentoDaFila()).toEqual({ q: null, fornecedor: null, empresa });
  });

  it('?empresa junto com q e fornecedor: tudo chega ao servico', async () => {
    await request(app).get(`${BASE}/fila?empresa=acxe&q=937&fornecedor=SOLUTEC`);
    expect(argumentoDaFila()).toEqual({ q: '937', fornecedor: 'SOLUTEC', empresa: 'acxe' });
  });

  it.each(['ACXE', 'outra', '', 'q2p,acxe'])('empresa invalida (%j): 400 INVALID_QUERY e o servico nem e chamado', async (empresa) => {
    const res = await request(app).get(`${BASE}/fila`).query({ empresa });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_QUERY');
    expect(res.body.data).toBeNull();
    expect(mocks.getFilaNacional).not.toHaveBeenCalled();
  });

  it('a data de corte continua NAO sendo parametro de requisicao (invariante 10): corte na query e ignorado', async () => {
    await request(app).get(`${BASE}/fila?dataCorte=2020-01-01&corteAcxe=2020-01-01`);
    expect(argumentoDaFila()).toEqual({ q: null, fornecedor: null });
  });

  it('a lista devolvida pelo servico vai em `data`, com a empresa de cada NF', async () => {
    mocks.getFilaNacional.mockResolvedValue([
      { nfChaveAcesso: CHAVE_ACXE, notaFiscal: '937', empresa: 'acxe', fiscal: 'pendente', pcSituacao: 'sugerido' },
      { nfChaveAcesso: '3'.repeat(44), notaFiscal: '6842', empresa: 'q2p', fiscal: 'concluido', pcSituacao: 'nao_aplicavel' },
    ]);
    const res = await request(app).get(`${BASE}/fila`);
    expect(res.body.data.map((f: { empresa: string }) => f.empresa)).toEqual(['acxe', 'q2p']);
    expect(res.body.error).toBeNull();
  });
});

describe('GET /fila — meta', () => {
  it('ACXE habilitada (chave + fiscal + corte): recebimentoNacionalAcxeHabilitado=true', async () => {
    const res = await request(app).get(`${BASE}/fila`);
    expect(res.body.meta).toEqual({ recebimentoFiscalHabilitado: true, recebimentoNacionalAcxeHabilitado: true });
  });

  it('ACXE desligada: false (a tela nao mostra selo de empresa nem filtro); o meta da 016 segue', async () => {
    configurar({ acxe: false });
    const res = await request(app).get(`${BASE}/fila`);
    expect(res.body.meta).toEqual({ recebimentoFiscalHabilitado: true, recebimentoNacionalAcxeHabilitado: false });
  });

  it.each([
    ['chave ligada SEM o fiscal pelo Atlas', { fiscal: false }, { recebimentoFiscalHabilitado: false, recebimentoNacionalAcxeHabilitado: false }],
    ['chave ligada SEM o corte da ACXE', { corte: null }, { recebimentoFiscalHabilitado: true, recebimentoNacionalAcxeHabilitado: false }],
    ['tudo desligado', { fiscal: false, acxe: false, corte: null }, { recebimentoFiscalHabilitado: false, recebimentoNacionalAcxeHabilitado: false }],
  ])('%s: a ACXE nao aparece na tela', async (_nome, opts, meta) => {
    configurar(opts);
    const res = await request(app).get(`${BASE}/fila`);
    expect(res.body.meta).toEqual(meta);
  });

  it('o meta tambem vai com o filtro de empresa e com a lista vazia', async () => {
    const res = await request(app).get(`${BASE}/fila?empresa=acxe`);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.recebimentoNacionalAcxeHabilitado).toBe(true);
  });
});

describe('GET /fila — erros de ambiente continuam visiveis', () => {
  it('FilaNacionalIncompletaError (espelho/tabela ausente, tambem na fila so da ACXE) -> 503 FILA_NACIONAL_NAO_CONFIGURADA, sem nome de variavel nem de tabela na mensagem do usuario', async () => {
    mocks.getFilaNacional.mockRejectedValue(new FilaNacionalIncompletaError());
    const res = await request(app).get(`${BASE}/fila?empresa=acxe`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('FILA_NACIONAL_NAO_CONFIGURADA');
    expect(res.body.error.userMessage).not.toMatch(/STOCKBRIDGE_|tbl_|_ACXE/);
  });

  it('erro inesperado -> 500 FILA_NACIONAL_FAIL', async () => {
    mocks.getFilaNacional.mockRejectedValue(new Error('boom'));
    const res = await request(app).get(`${BASE}/fila`);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('FILA_NACIONAL_FAIL');
  });
});

describe('GET /fila/:chave — detalhe da NF da ACXE', () => {
  const detalheAcxe = {
    nfChaveAcesso: CHAVE_ACXE,
    notaFiscal: '937',
    empresa: 'acxe',
    fiscal: 'pendente',
    itens: [
      {
        indice: 0,
        produtosSugeridos: [{ codigo: 4501234567, descricao: 'PP PRETO Q35', vezesUsada: 0, semCorrelatoQ2p: false }],
        pc: { candidatos: [{ pcNumero: '580', localidadeId: '5b1a1c2e-7d1f-4d0e-9a53-0a7c6e0b2007', localDescricao: '20.0.7 · PRODUÇÃO' }] },
      },
    ],
  };

  it('devolve o detalhe como o servico o montou (empresa, produtos com semCorrelatoQ2p, local dos candidatos) mais as flags de ambiente', async () => {
    mocks.getDetalheNfNacional.mockResolvedValue(detalheAcxe);
    const res = await request(app).get(`${BASE}/fila/${CHAVE_ACXE}`);
    expect(res.status).toBe(200);
    expect(mocks.getDetalheNfNacional).toHaveBeenCalledWith(CHAVE_ACXE);
    expect(res.body.data).toMatchObject({
      empresa: 'acxe',
      notaFiscal: '937',
      recebimentoExternoHabilitado: true,
      recebimentoFiscalHabilitado: true,
    });
    expect(res.body.data.itens[0].produtosSugeridos[0]).toEqual({ codigo: 4501234567, descricao: 'PP PRETO Q35', vezesUsada: 0, semCorrelatoQ2p: false });
    expect(res.body.data.itens[0].pc.candidatos[0]).toMatchObject({ localidadeId: '5b1a1c2e-7d1f-4d0e-9a53-0a7c6e0b2007', localDescricao: '20.0.7 · PRODUÇÃO' });
  });

  it('a resposta nao leva o codigo OMIE de 10 digitos do local (ACXEGDP-313) alem do que o servico montou', async () => {
    mocks.getDetalheNfNacional.mockResolvedValue(detalheAcxe);
    const res = await request(app).get(`${BASE}/fila/${CHAVE_ACXE}`);
    expect(JSON.stringify(res.body.data.itens[0].pc.candidatos)).not.toMatch(/\d{10}/);
  });

  it('chave que nao tem 44 digitos: 400 sem chamar o servico', async () => {
    const res = await request(app).get(`${BASE}/fila/12345`);
    expect(res.status).toBe(400);
    expect(mocks.getDetalheNfNacional).not.toHaveBeenCalled();
  });

  it('NF da ACXE nao encontrada (a ACXE esta fora da fila): 404 NF_NAO_ENCONTRADA', async () => {
    mocks.getDetalheNfNacional.mockRejectedValue(new NfNacionalNaoEncontradaError(CHAVE_ACXE, 'ainda não foi sincronizada ou é anterior à data de corte'));
    const res = await request(app).get(`${BASE}/fila/${CHAVE_ACXE}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NF_NAO_ENCONTRADA');
  });
});
