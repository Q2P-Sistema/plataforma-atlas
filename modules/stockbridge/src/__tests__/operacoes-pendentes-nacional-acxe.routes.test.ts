import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Feature 017, Historia 5 (ACXEGDP-437) — "Retentar Q2P" pela API (POST /operacoes-pendentes/:id/retentar) com o
// SERVICO REAL e um banco fake: o contrato HTTP da perna Q2P da compra nacional da ACXE. O contrato com o servico
// mockado (404/403/409/502 gerais) ja esta em contracts/operacoes-pendentes.contract.test.ts; aqui se prova o que
// o retry novo faz de ponta a ponta: sucesso (200), falha do OMIE (502 OMIE_Q2P_FAIL com a orientacao certa por
// perfil, ja contando a tentativa) e as guardas (nada vai ao OMIE).

type Chamada = { empresa: 'acxe' | 'q2p'; codInt: string; input: Record<string, unknown>; opts?: Record<string, unknown> };
const chamadasOmie: Chamada[] = [];
let respostaOmie: (c: Chamada) => Promise<{ idMovest: string; idAjuste: string; jaExistia: boolean }>;
const updates: Array<{ table: string; set: Record<string, unknown> }> = [];
let movRow: Record<string, unknown> | null;
let aprovacoesAprovadas: unknown[];
let role: 'operador' | 'gestor' | 'diretor' = 'gestor';
let sqlsExecutados: string[] = [];

function fakeDb() {
  const select = () => {
    let tabela = '?';
    const c: Record<string, unknown> = {};
    c.from = (t: { __id?: string }) => { tabela = t.__id ?? '?'; return c; };
    c.where = () => c;
    c.limit = () => Promise.resolve(tabela === 'aprovacao' ? aprovacoesAprovadas : movRow ? [movRow] : []);
    return c;
  };
  return {
    select,
    execute: (q: unknown) => {
      sqlsExecutados.push(JSON.stringify((q as { queryChunks?: unknown[] }).queryChunks ?? q));
      return Promise.resolve({ rows: [{ codigo: '4553940002' }] });
    },
    update: (t: { __id?: string }) => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          updates.push({ table: t.__id ?? '?', set: v });
          return Promise.resolve(undefined);
        },
      }),
    }),
  };
}

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => fakeDb(),
  getConfig: () => ({}),
  getPool: () => ({ query: vi.fn() }),
}));
vi.mock('@atlas/db', () => ({
  movimentacao: { __id: 'movimentacao' },
  lote: { __id: 'lote' },
  localidade: { __id: 'localidade' },
  localidadeCorrelacao: { __id: 'localidadeCorrelacao' },
  aprovacao: { __id: 'aprovacao' },
}));
vi.mock('@atlas/integration-omie', () => ({ incluirAjusteEstoque: vi.fn(), listarAjusteEstoque: vi.fn() }));
vi.mock('../services/omie-idempotente.js', () => ({
  incluirAjusteIdempotente: (empresa: 'acxe' | 'q2p', codInt: string, input: Record<string, unknown>, opts?: Record<string, unknown>) => {
    const c: Chamada = { empresa, codInt, input, opts };
    chamadasOmie.push(c);
    return respostaOmie(c);
  },
}));
vi.mock('../services/omie-saida.service.js', () => ({
  resolverCorrelacaoCompletaGalpao: vi.fn(),
  resolverCodigosLocaisTroca: vi.fn(),
  resolverCodigoProdutoOmie: vi.fn(),
}));
vi.mock('../services/aprovacao.service.js', () => ({ consultarValorUnitarioProduto: vi.fn() }));
vi.mock('../services/baixa-pedido.service.js', () => ({ dispararBaixaPedidoQ2p: vi.fn() }));
vi.mock('../middleware/role.js', () => {
  const auth = (req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user?: { id: string; role: string } }).user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role };
    next();
  };
  return { requireOperador: auth, requireGestor: auth, requireDiretor: auth };
});

import router from '../routes/operacoes-pendentes.routes.js';

const MOV_ID = '11111111-1111-4111-8111-111111111111';
const OP_ID = '5a1f0c52-0f6d-4d6b-9a41-3d0a8d0f1111';
const URL = `/api/v1/stockbridge/operacoes-pendentes/${MOV_ID}/retentar`;
const app = express();
app.use(express.json());
app.use(router);

const movPendente = (over: Record<string, unknown> = {}) => ({
  id: MOV_ID, opId: OP_ID, loteId: null, notaFiscal: '937', subtipo: 'compra_nacional', tipoMovimento: 'entrada_manual',
  empresa: 'acxe', produtoCodigoAcxe: 4001, produtoCodigoQ2p: 9001, galpao: '21.1', galpaoDestino: null,
  nfChaveAcesso: '35261011111111000111550010000009370000009370', quantidadeKg: '26000.000', custoUnitarioBrl: '4.833333',
  statusOmie: 'pendente_q2p', tentativasQ2p: 1, tentativasAcxeFaltando: 0, mvAcxe: 1, dtAcxe: new Date('2026-10-22T15:30:00.000Z'),
  idMovestAcxe: 'MOV-ACXE', idAjusteAcxe: 'AJ-ACXE', mvQ2p: null, idMovestQ2p: null, idAjusteQ2p: null, movimentacaoOrigemId: null,
  baixaPedidoQ2p: null, ...over,
});

beforeEach(() => {
  chamadasOmie.length = 0;
  updates.length = 0;
  sqlsExecutados = [];
  role = 'gestor';
  movRow = movPendente();
  aprovacoesAprovadas = [{ id: 'ap-1' }];
  respostaOmie = async () => ({ idMovest: 'MOV-Q2P', idAjuste: 'AJ-Q2P', jaExistia: false });
});

describe('POST /operacoes-pendentes/:id/retentar — perna Q2P da compra nacional da ACXE', () => {
  it('200: conclui, grava a perna Q2P como entrada e devolve o desfecho', async () => {
    const res = await request(app).post(URL);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { movimentacaoId: MOV_ID, statusOmie: 'concluida', jaExistiaNoOmie: false, tentativasQ2p: 1 }, error: null });
    expect(chamadasOmie).toHaveLength(1);
    expect(chamadasOmie[0]).toMatchObject({ empresa: 'q2p', codInt: `${OP_ID}:nacional-q2p`, opts: { verificarAntes: true } });
    expect(updates[0]!.set).toMatchObject({ mvQ2p: 1, statusOmie: 'concluida' });
  });

  it('502 OMIE_Q2P_FAIL para o gestor: estado parcial (stateClean false), pode retentar sem limite, com op e movimentacao; a tentativa foi contada', async () => {
    respostaOmie = async () => {
      throw new Error('OMIE Q2P fora do ar');
    };
    const res = await request(app).post(URL);
    expect(res.status).toBe(502);
    expect(res.body.data).toBeNull();
    expect(res.body.error).toMatchObject({
      code: 'OMIE_Q2P_FAIL', stateClean: false, retryable: true, userAction: 'retry_q2p', opId: OP_ID, movimentacaoId: MOV_ID,
      userMessage: 'OMIE Q2P ainda indisponível. Você pode retentar quantas vezes precisar.',
    });
    expect(updates[0]!.set).toMatchObject({ tentativasQ2p: 2, ultimoErroOmie: { lado: 'q2p', mensagem: 'OMIE Q2P fora do ar' } });
    expect(updates[0]!.set).not.toHaveProperty('statusOmie'); // segue pendente_q2p
  });

  it('403 para o operador que ja gastou as tentativas (a aprovacao + 1 retry), sem tocar o OMIE', async () => {
    role = 'operador';
    movRow = movPendente({ tentativasQ2p: 2 });
    const res = await request(app).post(URL);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('OPERADOR_SEM_RETENTATIVAS');
    expect(chamadasOmie).toHaveLength(0);
  });

  it('409 quando a perna Q2P ja foi concluida (status concluida)', async () => {
    movRow = movPendente({ statusOmie: 'concluida' });
    const res = await request(app).post(URL);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OPERACAO_NAO_PENDENTE');
    expect(chamadasOmie).toHaveLength(0);
  });

  it('guardas violadas (entrada ainda sem aprovacao concluida; perna ACXE nao feita; entrada so ACXE): 409 RETENTATIVA_INVALIDA com a explicacao em pt-BR (userMessage) e NADA vai ao OMIE', async () => {
    aprovacoesAprovadas = [];
    let res = await request(app).post(URL);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RETENTATIVA_INVALIDA');
    expect(res.body.error.message).toMatch(/ainda não tem aprovação concluída/);
    expect(res.body.error.userMessage).toMatch(/ainda não foi aprovada pelo gestor/);

    aprovacoesAprovadas = [{ id: 'ap-1' }];
    movRow = movPendente({ mvAcxe: null, idMovestAcxe: null });
    res = await request(app).post(URL);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/entrada na ACXE ainda não foi lançada/);

    movRow = movPendente({ produtoCodigoQ2p: null });
    res = await request(app).post(URL);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/não é uma entrada nas duas empresas/);
    expect(chamadasOmie).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('o local da Q2P e lido por join direto em localidade_correlacao, SEM filtro de tipo (o 31.1 e tpl e o retry de saida, que filtra proprio, o recusaria)', async () => {
    await request(app).post(URL);
    expect(sqlsExecutados).toHaveLength(1);
    expect(sqlsExecutados[0]).toContain('lc.codigo_local_estoque_q2p::text AS codigo');
    expect(sqlsExecutados[0]).toContain('stockbridge.localidade_correlacao');
    expect(sqlsExecutados[0]).not.toMatch(/l\.tipo|'proprio'/);
  });

  it('id que nao e UUID: 400; movimentacao inexistente: 404', async () => {
    expect((await request(app).post('/api/v1/stockbridge/operacoes-pendentes/nao-e-uuid/retentar')).status).toBe(400);
    movRow = null;
    const res = await request(app).post(URL);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('OPERACAO_PENDENTE_NAO_ENCONTRADA');
  });
});
