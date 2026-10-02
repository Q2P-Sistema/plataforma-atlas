import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Feature 016 (ACXEGDP-395), T047 (+ contrato da T024/T036) — HTTP das rotas novas:
// dispensar / dispensas / reverter / fiscal (ledger), a `meta` da fila e o
// mapeamento 502/409/422 do fiscal no POST por-nf. Padrao do
// recebimento-nacional-nf.routes.test.ts (middlewares simulados, services spies).

let roleAtual: 'operador' | 'gestor' | 'diretor' | null = 'gestor';
let flagFiscal = true;

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getConfig: () => ({}),
  getDb: vi.fn(),
  getPool: vi.fn(),
}));

function comUser(req: Request, next: NextFunction) {
  (req as Request & { user?: { id: string; role: string } }).user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: roleAtual! };
  next();
}
vi.mock('../middleware/role.js', () => ({
  requireOperador: (req: Request, res: Response, next: NextFunction) => {
    if (!roleAtual) {
      res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'sem sessão' } });
      return;
    }
    comUser(req, next);
  },
  requireGestor: (req: Request, res: Response, next: NextFunction) => {
    if (!roleAtual) {
      res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'sem sessão' } });
      return;
    }
    if (roleAtual === 'operador') {
      res.status(403).json({ data: null, error: { code: 'FORBIDDEN', message: 'perfil insuficiente' } });
      return;
    }
    comUser(req, next);
  },
}));
vi.mock('../middleware/armazem-vinculado.js', () => ({
  requireArmazemVinculado: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const svc = {
  getFilaNacional: vi.fn(),
  getDetalheNfNacional: vi.fn(),
  processarRecebimentoNacionalPorNf: vi.fn(),
  dispensarNf: vi.fn(),
  listarDispensas: vi.fn(),
  reverterDispensa: vi.fn(),
  listarLedgerFiscal: vi.fn(),
};
vi.mock('../services/correlacao-produto.service.js', () => ({ definirConjuntoCorrelacao: vi.fn() }));
vi.mock('../services/recebimento-externo.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/recebimento-externo.service.js')>('../services/recebimento-externo.service.js');
  return { ...real, recebimentoExternoHabilitado: () => true, solicitarRecebimentoExterno: vi.fn() };
});
vi.mock('../services/fila-nacional.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/fila-nacional.service.js')>('../services/fila-nacional.service.js');
  return {
    ...real,
    recebimentoFiscalHabilitado: () => flagFiscal,
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
vi.mock('../services/recebimento-fiscal.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/recebimento-fiscal.service.js')>('../services/recebimento-fiscal.service.js');
  return { ...real, concluirRecebimentoFiscal: vi.fn(), listarLedgerFiscal: (...a: unknown[]) => svc.listarLedgerFiscal(...a) };
});
vi.mock('../services/nf-dispensa.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/nf-dispensa.service.js')>('../services/nf-dispensa.service.js');
  return {
    ...real,
    dispensarNf: (...a: unknown[]) => svc.dispensarNf(...a),
    listarDispensas: (...a: unknown[]) => svc.listarDispensas(...a),
    reverterDispensa: (...a: unknown[]) => svc.reverterDispensa(...a),
  };
});

import router from '../routes/recebimento-nacional.routes.js';
import { NfJaDispensadaError, NfNaoDispensavelError, DispensaNaoEncontradaError, MotivoDispensaObrigatorioError, NfEmRecebimentoFiscalError } from '../services/nf-dispensa.service.js';
import { NfNacionalNaoEncontradaError, NfNacionalDispensadaError, FilaNacionalIncompletaError } from '../services/fila-nacional.service.js';
import {
  RecebimentoFiscalError,
  RecebimentoFiscalEmAndamentoError,
  RecebimentoFiscalAguardeError,
  RecebimentoFiscalSemFornecedorError,
  RecebimentoFiscalEtapaInesperadaError,
} from '../services/recebimento-fiscal.service.js';

const CHAVE = '35261014555032000753550010000068421827355174';
const ID = '11111111-1111-4111-8111-111111111111';
const LOC = '22222222-2222-4222-8222-222222222222';
const BASE = '/api/v1/stockbridge/recebimento/nacional';
const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => {
  roleAtual = 'gestor';
  flagFiscal = true;
  for (const f of Object.values(svc)) f.mockReset();
  svc.getFilaNacional.mockResolvedValue([]);
  svc.dispensarNf.mockResolvedValue({ id: ID, notaFiscal: '6842', fornecedorNome: 'REPLAS COMERCIAL LTDA', situacaoFiscalNaDispensa: 'pendente', dispensadoEm: '2026-10-02T13:00:00.000Z' });
  svc.listarDispensas.mockResolvedValue([{ id: ID, notaFiscal: '6842' }]);
  svc.reverterDispensa.mockResolvedValue({ id: ID, notaFiscal: '6842' });
  svc.listarLedgerFiscal.mockResolvedValue([{ id: 'l1', notaFiscal: '6842', status: 'concluido' }]);
});

describe('roles — operador nao dispensa, nao reverte, nao lista o ledger (invariante 10)', () => {
  it('403 nas quatro rotas de gestor', async () => {
    roleAtual = 'operador';
    expect((await request(app).post(`${BASE}/dispensar`).send({ nf_chave_acesso: CHAVE, motivo: 'x' })).status).toBe(403);
    expect((await request(app).get(`${BASE}/dispensas`)).status).toBe(403);
    expect((await request(app).post(`${BASE}/dispensas/${ID}/reverter`).send({ motivo: 'x' })).status).toBe(403);
    expect((await request(app).get(`${BASE}/fiscal`)).status).toBe(403);
    expect(svc.dispensarNf).not.toHaveBeenCalled();
    expect(svc.listarLedgerFiscal).not.toHaveBeenCalled();
  });

  it('diretor tambem passa', async () => {
    roleAtual = 'diretor';
    expect((await request(app).get(`${BASE}/dispensas`)).status).toBe(200);
  });
});

describe('POST /dispensar (contrato §4)', () => {
  it('gestor com corpo valido: 201 com o resultado do service; perfil e userId repassados', async () => {
    const res = await request(app).post(`${BASE}/dispensar`).send({ nf_chave_acesso: CHAVE, motivo: 'Carga nunca chegou' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: ID, notaFiscal: '6842', situacaoFiscalNaDispensa: 'pendente' });
    expect(svc.dispensarNf).toHaveBeenCalledWith({ nfChaveAcesso: CHAVE, motivo: 'Carga nunca chegou', userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', perfilUsuario: 'gestor' });
  });

  it('flag desligada: 403 RECEBIMENTO_FISCAL_DESABILITADO ANTES de validar o corpo (corpo invalido tambem da 403)', async () => {
    flagFiscal = false;
    const res = await request(app).post(`${BASE}/dispensar`).send({ qualquer: 'coisa' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('RECEBIMENTO_FISCAL_DESABILITADO');
    expect(res.body.error.userMessage).toContain('desligado');
    expect(svc.dispensarNf).not.toHaveBeenCalled();
  });

  it('corpo com campo extra -> 400 (.strict()); chave invalida -> 400; motivo acima de 1000 -> 400', async () => {
    expect((await request(app).post(`${BASE}/dispensar`).send({ nf_chave_acesso: CHAVE, motivo: 'x', extra: 1 })).status).toBe(400);
    expect((await request(app).post(`${BASE}/dispensar`).send({ nf_chave_acesso: '123', motivo: 'x' })).status).toBe(400);
    expect((await request(app).post(`${BASE}/dispensar`).send({ nf_chave_acesso: CHAVE, motivo: 'x'.repeat(1001) })).status).toBe(400);
    expect(svc.dispensarNf).not.toHaveBeenCalled();
  });

  it('motivo vazio ou ausente chega ao service e volta 400 MOTIVO_OBRIGATORIO com a mensagem da dispensa (contrato §4/§6)', async () => {
    svc.dispensarNf.mockRejectedValue(new MotivoDispensaObrigatorioError('dispensar'));
    for (const body of [{ nf_chave_acesso: CHAVE, motivo: '' }, { nf_chave_acesso: CHAVE }]) {
      const res = await request(app).post(`${BASE}/dispensar`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'MOTIVO_OBRIGATORIO', userMessage: 'Informe o motivo da dispensa: por que esta nota não será recebida.' });
    }
    expect(svc.dispensarNf).toHaveBeenLastCalledWith(expect.objectContaining({ motivo: '' }));
    svc.reverterDispensa.mockRejectedValue(new MotivoDispensaObrigatorioError('reverter'));
    const rev = await request(app).post(`${BASE}/dispensas/${ID}/reverter`).send({});
    expect(rev.status).toBe(400);
    expect(rev.body.error.code).toBe('MOTIVO_OBRIGATORIO');
    expect(rev.body.error.userMessage).toBe('Informe o motivo para desfazer a dispensa.');
  });

  it('NF sendo recebida agora (ledger em_andamento): 409 NF_EM_RECEBIMENTO', async () => {
    svc.dispensarNf.mockRejectedValueOnce(new NfEmRecebimentoFiscalError('6842'));
    const res = await request(app).post(`${BASE}/dispensar`).send({ nf_chave_acesso: CHAVE, motivo: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NF_EM_RECEBIMENTO');
  });

  it('mapeia erros de dominio: 409 NF_JA_DISPENSADA, 422 NF_NAO_DISPENSAVEL, 404 NF_NAO_ENCONTRADA, 400 MOTIVO_OBRIGATORIO', async () => {
    svc.dispensarNf.mockRejectedValueOnce(new NfJaDispensadaError('6842'));
    let res = await request(app).post(`${BASE}/dispensar`).send({ nf_chave_acesso: CHAVE, motivo: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NF_JA_DISPENSADA');

    svc.dispensarNf.mockRejectedValueOnce(new NfNaoDispensavelError('6842'));
    res = await request(app).post(`${BASE}/dispensar`).send({ nf_chave_acesso: CHAVE, motivo: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'NF_NAO_DISPENSAVEL', userMessage: 'A NF 6842 já foi recebida no Atlas — não há o que dispensar.' });

    svc.dispensarNf.mockRejectedValueOnce(new NfNacionalNaoEncontradaError(CHAVE, 'ainda não foi sincronizada'));
    res = await request(app).post(`${BASE}/dispensar`).send({ nf_chave_acesso: CHAVE, motivo: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NF_NAO_ENCONTRADA');

    svc.dispensarNf.mockRejectedValueOnce(new MotivoDispensaObrigatorioError('dispensar'));
    res = await request(app).post(`${BASE}/dispensar`).send({ nf_chave_acesso: CHAVE, motivo: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MOTIVO_OBRIGATORIO');
  });
});

describe('GET /dispensas (contrato §5) e POST /dispensas/:id/reverter (§6)', () => {
  it('lista ativas por padrao e todas com incluirRevertidas=true', async () => {
    let res = await request(app).get(`${BASE}/dispensas`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: ID, notaFiscal: '6842' }]);
    expect(svc.listarDispensas).toHaveBeenLastCalledWith({ incluirRevertidas: false });
    res = await request(app).get(`${BASE}/dispensas?incluirRevertidas=true`);
    expect(svc.listarDispensas).toHaveBeenLastCalledWith({ incluirRevertidas: true });
    expect((await request(app).get(`${BASE}/dispensas?incluirRevertidas=talvez`)).status).toBe(400);
  });

  it('flag desligada: GET /dispensas -> 403 (a UI esconde a secao inteira)', async () => {
    flagFiscal = false;
    const res = await request(app).get(`${BASE}/dispensas`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('RECEBIMENTO_FISCAL_DESABILITADO');
  });

  it('reverter: 200; id invalido -> 400; campo extra -> 400; inexistente -> 404 DISPENSA_NAO_ENCONTRADA', async () => {
    let res = await request(app).post(`${BASE}/dispensas/${ID}/reverter`).send({ motivo: 'engano' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: ID, notaFiscal: '6842' });
    expect(svc.reverterDispensa).toHaveBeenCalledWith({ id: ID, motivo: 'engano', userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', perfilUsuario: 'gestor' });

    expect((await request(app).post(`${BASE}/dispensas/nao-e-uuid/reverter`).send({ motivo: 'x' })).status).toBe(400);
    expect((await request(app).post(`${BASE}/dispensas/${ID}/reverter`).send({ motivo: 'x', extra: true })).status).toBe(400);

    svc.reverterDispensa.mockRejectedValueOnce(new DispensaNaoEncontradaError(ID));
    res = await request(app).post(`${BASE}/dispensas/${ID}/reverter`).send({ motivo: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DISPENSA_NAO_ENCONTRADA');
  });
});

describe('GET /fiscal — ledger (contrato §7)', () => {
  it('flag desligada: 403 RECEBIMENTO_FISCAL_DESABILITADO (como as demais rotas novas — ROT-7)', async () => {
    flagFiscal = false;
    const res = await request(app).get(`${BASE}/fiscal`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('RECEBIMENTO_FISCAL_DESABILITADO');
    expect(svc.listarLedgerFiscal).not.toHaveBeenCalled();
  });

  it('gestor: 200 com status/limit repassados; limit fora de 1..200 -> 400; status desconhecido -> 400', async () => {
    const res = await request(app).get(`${BASE}/fiscal?status=falha&limit=50`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: 'l1', notaFiscal: '6842', status: 'concluido' }]);
    expect(svc.listarLedgerFiscal).toHaveBeenCalledWith({ status: 'falha', limit: 50 });
    await request(app).get(`${BASE}/fiscal`);
    expect(svc.listarLedgerFiscal).toHaveBeenLastCalledWith({ status: null, limit: 100 });
    expect((await request(app).get(`${BASE}/fiscal?limit=500`)).status).toBe(400);
    expect((await request(app).get(`${BASE}/fiscal?status=outro`)).status).toBe(400);
  });
});

describe('fila e POST por-nf — extensoes da feature 016 (T024)', () => {
  it('GET /fila devolve a lista em data e a flag em meta', async () => {
    roleAtual = 'operador';
    svc.getFilaNacional.mockResolvedValue([{ nfChaveAcesso: CHAVE, notaFiscal: '6842', fiscal: 'pendente' }]);
    let res = await request(app).get(`${BASE}/fila`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toEqual({ recebimentoFiscalHabilitado: true });
    flagFiscal = false;
    res = await request(app).get(`${BASE}/fila`);
    expect(res.body.meta).toEqual({ recebimentoFiscalHabilitado: false });
  });

  it('GET /fila/:chave devolve recebimentoFiscalHabilitado junto do detalhe', async () => {
    roleAtual = 'operador';
    svc.getDetalheNfNacional.mockResolvedValue({ nfChaveAcesso: CHAVE, notaFiscal: '6842', itens: [], fiscal: 'pendente', dispensavel: true });
    const res = await request(app).get(`${BASE}/fila/${CHAVE}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ notaFiscal: '6842', fiscal: 'pendente', dispensavel: true, recebimentoFiscalHabilitado: true, recebimentoExternoHabilitado: true });
  });

  it('POST /por-nf mapeia 502 RECEBIMENTO_FISCAL_FAIL, 409 RECEBIMENTO_FISCAL_EM_ANDAMENTO e 422 RECEBIMENTO_FISCAL_SEM_FORNECEDOR, sempre com userMessage sem codigo OMIE', async () => {
    roleAtual = 'operador';
    const body = { nf_chave_acesso: CHAVE, itens: [{ indice: 0, descricao_fornecedor: 'SUCATA PLASTICO', produtos: [{ produto_codigo_q2p: 3033097757, quantidade_kg: 18000, localidade_id: LOC }] }] };

    svc.processarRecebimentoNacionalPorNf.mockRejectedValueOnce(new RecebimentoFiscalError('concluir', '6842', 'REPLAS COMERCIAL LTDA'));
    let res = await request(app).post(`${BASE}/por-nf`).send(body);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('RECEBIMENTO_FISCAL_FAIL');
    expect(res.body.error.userMessage).toContain('NF 6842 (REPLAS COMERCIAL LTDA)');
    expect(res.body.error.userMessage).toContain('Nada foi registrado');

    svc.processarRecebimentoNacionalPorNf.mockRejectedValueOnce(new RecebimentoFiscalEmAndamentoError('6842'));
    res = await request(app).post(`${BASE}/por-nf`).send(body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RECEBIMENTO_FISCAL_EM_ANDAMENTO');
    expect(res.body.error.userMessage).toContain('já está sendo concluído');

    svc.processarRecebimentoNacionalPorNf.mockRejectedValueOnce(new RecebimentoFiscalSemFornecedorError('6842'));
    res = await request(app).post(`${BASE}/por-nf`).send(body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RECEBIMENTO_FISCAL_SEM_FORNECEDOR');
    expect(res.body.error.userMessage).toContain('sem fornecedor cadastrado');

    svc.processarRecebimentoNacionalPorNf.mockRejectedValueOnce(new RecebimentoFiscalAguardeError('6842', 40));
    res = await request(app).post(`${BASE}/por-nf`).send(body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RECEBIMENTO_FISCAL_AGUARDE');
    expect(res.body.error.userMessage).toContain('40 segundos');
    expect(res.body.error.retryAfterSeconds).toBe(40);

    // a tela usa retryAfterSeconds: 70 depois de falha com escrita, 0 quando falhou so a consulta
    svc.processarRecebimentoNacionalPorNf.mockRejectedValueOnce(new RecebimentoFiscalError('concluir', '6842', 'REPLAS COMERCIAL LTDA'));
    res = await request(app).post(`${BASE}/por-nf`).send(body);
    expect(res.body.error.retryAfterSeconds).toBe(70);
    svc.processarRecebimentoNacionalPorNf.mockRejectedValueOnce(new RecebimentoFiscalError('consultar', '6842', 'REPLAS COMERCIAL LTDA'));
    res = await request(app).post(`${BASE}/por-nf`).send(body);
    expect(res.body.error.retryAfterSeconds).toBe(0);

    svc.processarRecebimentoNacionalPorNf.mockRejectedValueOnce(new RecebimentoFiscalEtapaInesperadaError('6842', 'bloqueado'));
    res = await request(app).post(`${BASE}/por-nf`).send(body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RECEBIMENTO_FISCAL_ETAPA_INESPERADA');
    expect(res.body.error.userMessage).toContain('bloqueado no OMIE');
  });

  it('detalhe de NF dispensada: 404 NF_DISPENSADA (a UI nao oferece o formulario manual nesse caso)', async () => {
    roleAtual = 'operador';
    svc.getDetalheNfNacional.mockRejectedValueOnce(new NfNacionalDispensadaError('6842', '02/10/2026'));
    const res = await request(app).get(`${BASE}/fila/${CHAVE}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NF_DISPENSADA');
    expect(res.body.error.userMessage).toContain('desfazer a dispensa');
  });

  it('tabela ausente (migration pendente): 503 FILA_NACIONAL_NAO_CONFIGURADA na fila, no detalhe, no POST e no ledger — nunca fila vazia nem 500', async () => {
    roleAtual = 'operador';
    svc.getFilaNacional.mockRejectedValueOnce(new FilaNacionalIncompletaError());
    let res = await request(app).get(`${BASE}/fila`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('FILA_NACIONAL_NAO_CONFIGURADA');
    svc.getDetalheNfNacional.mockRejectedValueOnce(new FilaNacionalIncompletaError());
    res = await request(app).get(`${BASE}/fila/${CHAVE}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('FILA_NACIONAL_NAO_CONFIGURADA');
    const pgErr = Object.assign(new Error('relation "stockbridge.recebimento_fiscal" does not exist'), { code: '42P01' });
    svc.processarRecebimentoNacionalPorNf.mockRejectedValueOnce(pgErr);
    res = await request(app).post(`${BASE}/por-nf`).send({ nf_chave_acesso: CHAVE, itens: [{ indice: 0, descricao_fornecedor: 'X', produtos: [{ produto_codigo_q2p: 1, quantidade_kg: 1, localidade_id: LOC }] }] });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('FILA_NACIONAL_NAO_CONFIGURADA');
    roleAtual = 'gestor';
    svc.listarLedgerFiscal.mockRejectedValueOnce(pgErr);
    res = await request(app).get(`${BASE}/fiscal`);
    expect(res.status).toBe(503);
  });
});
