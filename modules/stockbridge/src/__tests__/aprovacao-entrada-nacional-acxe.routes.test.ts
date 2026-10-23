import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Feature 017, Historia 5 (ACXEGDP-437) — contrato HTTP de POST /aprovacoes/:id/aprovar para a entrada nacional
// da ACXE: a falha do OMIE da ACXE e 502 OMIE_ACXE_FAIL (nada gravado, aprovacao segue pendente); a entrada
// que nao pode ser aprovada como esta gravada e 422 ENTRADA_NACIONAL_INCONSISTENTE com userMessage; a pendencia
// da Q2P vem em `pendenciaOmie` na resposta 200.

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getConfig: () => ({}),
  getDb: vi.fn(),
  getPool: vi.fn(),
}));
vi.mock('../middleware/role.js', () => ({
  requireGestor: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: { id: string; role: string } }).user = { id: 'gestor-1', role: 'gestor' };
    next();
  },
  requireOperador: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: { id: string; role: string } }).user = { id: 'op-1', role: 'operador' };
    next();
  },
}));

const svc = vi.hoisted(() => ({ aprovar: vi.fn() }));
vi.mock('../services/aprovacao.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/aprovacao.service.js')>('../services/aprovacao.service.js');
  return { ...real, aprovar: (...a: unknown[]) => svc.aprovar(...a) };
});

import router from '../routes/aprovacao.routes.js';
import { EntradaNacionalInconsistenteError } from '../services/aprovacao.service.js';
import { OmieAjusteError } from '../services/recebimento.service.js';

const app = express();
app.use(express.json());
app.use(router);
const URL = '/api/v1/stockbridge/aprovacoes/ap-1/aprovar';

beforeEach(() => {
  svc.aprovar.mockReset();
});

describe('POST /aprovacoes/:id/aprovar — entrada nacional da ACXE', () => {
  it('OMIE da ACXE falhou: 502 OMIE_ACXE_FAIL, stateClean (nada foi registrado) e retryable', async () => {
    svc.aprovar.mockRejectedValue(new OmieAjusteError('acxe', new Error('timeout'), { opId: 'op-x', movimentacaoId: 'mov-1' }));
    const res = await request(app).post(URL).send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ code: 'OMIE_ACXE_FAIL', stateClean: true, retryable: true, opId: 'op-x', movimentacaoId: 'mov-1' });
    expect(res.body.error.userMessage).toContain('Nada foi registrado');
  });

  it('entrada inconsistente (sem custo, estoque que deixou de ser compartilhado): 422 com userMessage', async () => {
    svc.aprovar.mockRejectedValue(new EntradaNacionalInconsistenteError('O estoque 21.1 deixou de ser compartilhado com a Q2P.'));
    const res = await request(app).post(URL).send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toEqual({
      code: 'ENTRADA_NACIONAL_INCONSISTENTE',
      userMessage: 'O estoque 21.1 deixou de ser compartilhado com a Q2P.',
      message: 'O estoque 21.1 deixou de ser compartilhado com a Q2P.',
    });
  });

  it('perna Q2P pendente: 200 com pendenciaOmie (a aprovacao valeu)', async () => {
    svc.aprovar.mockResolvedValue({
      id: 'ap-1',
      loteStatus: 'reconciliado',
      pendenciaOmie: { lado: 'q2p', opId: 'op-x', movimentacaoId: 'mov-1', mensagem: 'OMIE Q2P fora do ar' },
    });
    const res = await request(app).post(URL).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: 'ap-1',
      loteStatus: 'reconciliado',
      pendenciaOmie: { lado: 'q2p', opId: 'op-x', movimentacaoId: 'mov-1', mensagem: 'OMIE Q2P fora do ar' },
    });
  });

  it('erro inesperado continua 500 APROVACAO_FAIL', async () => {
    svc.aprovar.mockRejectedValue(new Error('boom'));
    const res = await request(app).post(URL).send({});
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('APROVACAO_FAIL');
  });
});
