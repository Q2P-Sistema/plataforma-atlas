import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Feature 017, Historia 5 (ACXEGDP-437, migration 0058) — tipo novo de localidade: 'operacional' (20.0.5 PROCESSO e
// 20.0.7 PRODUCAO da ACXE). O CHECK do banco (localidade_tipo_check) ja o aceita; a API precisa aceita-lo ao criar e
// ao editar localidades — senao a tela de Localidades nao consegue nem editar os dois estoques semeados — e continuar
// recusando tipo que nao existe. O servico (banco) e mockado.

const svc = vi.hoisted(() => ({
  criarLocalidade: vi.fn(),
  atualizarLocalidade: vi.fn(),
  listarLocalidades: vi.fn(),
  listarLocalidadesEspelhadas: vi.fn(),
  desativarLocalidade: vi.fn(),
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getConfig: () => ({}),
  getDb: vi.fn(),
}));
vi.mock('../middleware/role.js', () => {
  const auth = (req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user?: { id: string; role: string } }).user = { id: 'gestor-1', role: 'gestor' };
    next();
  };
  return { requireOperador: auth, requireGestor: auth };
});
vi.mock('../services/localidade.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/localidade.service.js')>('../services/localidade.service.js');
  return {
    ...real,
    criarLocalidade: (...a: unknown[]) => svc.criarLocalidade(...a),
    atualizarLocalidade: (...a: unknown[]) => svc.atualizarLocalidade(...a),
    listarLocalidades: (...a: unknown[]) => svc.listarLocalidades(...a),
    listarLocalidadesEspelhadas: (...a: unknown[]) => svc.listarLocalidadesEspelhadas(...a),
    desativarLocalidade: (...a: unknown[]) => svc.desativarLocalidade(...a),
  };
});

import router from '../routes/localidade.routes.js';

const app = express();
app.use(express.json());
app.use(router);
const URL = '/api/v1/stockbridge/localidades';

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset();
  svc.criarLocalidade.mockImplementation(async (i: Record<string, unknown>) => ({ id: 'novo', ...i }));
  svc.atualizarLocalidade.mockImplementation(async (id: string, i: Record<string, unknown>) => ({ id, ...i }));
});

describe("localidades — tipo 'operacional'", () => {
  it('POST aceita tipo operacional (20.0.7 PRODUCAO) e repassa ao servico', async () => {
    const res = await request(app).post(URL).send({ codigo: '20.0.7', nome: 'PRODUÇÃO', tipo: 'operacional' });
    expect(res.status).toBe(201);
    expect(svc.criarLocalidade).toHaveBeenCalledWith({ codigo: '20.0.7', nome: 'PRODUÇÃO', tipo: 'operacional' });
    expect(res.body.data).toMatchObject({ tipo: 'operacional' });
  });

  it('PATCH aceita trocar para tipo operacional', async () => {
    const res = await request(app).patch(`${URL}/uuid-1`).send({ tipo: 'operacional' });
    expect(res.status).toBe(200);
    expect(svc.atualizarLocalidade).toHaveBeenCalledWith('uuid-1', { tipo: 'operacional' });
  });

  it.each(['proprio', 'tpl', 'porto_seco', 'virtual_transito', 'virtual_ajuste'])('os tipos de sempre seguem aceitos: %s', async (tipo) => {
    const res = await request(app).post(URL).send({ codigo: `T-${tipo}`, nome: 'X', tipo });
    expect(res.status).toBe(201);
  });

  it('tipo que nao existe segue recusado (400 INVALID_INPUT) e o servico nao e chamado', async () => {
    const res = await request(app).post(URL).send({ codigo: 'X', nome: 'X', tipo: 'producao' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(svc.criarLocalidade).not.toHaveBeenCalled();
    expect((await request(app).patch(`${URL}/uuid-1`).send({ tipo: 'outro' })).status).toBe(400);
  });
});
