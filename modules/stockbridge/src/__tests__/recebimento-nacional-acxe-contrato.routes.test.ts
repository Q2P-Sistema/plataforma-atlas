import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Feature 017, Historia 5 (ACXEGDP-437) — contrato HTTP de POST /recebimento/nacional/por-nf para a NF da ACXE com o
// SERVICO REAL (recebimento-nacional.routes.test.ts mocka o servico e prova so o mapeamento de erros). Aqui o corpo
// JSON (snake_case) atravessa a rota e o servico ate o banco (fake) e a resposta (camelCase) volta como a tela a le:
// produtoCodigoAcxe / produtoCodigoQ2p / entradaEm por produto, os 4xx do portao 1 e nada gravado quando recusa.
// Detalhe da NF, fiscal, correspondente na Q2P e e-mails sao mockados (cada um tem teste proprio).

const poolQuerySpy = vi.fn();
const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];

const spies = vi.hoisted(() => ({
  detalhe: vi.fn(),
  fiscal: vi.fn(),
  gemeos: vi.fn(),
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
  getConfig: () => ({ STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE: '2026-09-11', STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED: true }),
  getDb: () => ({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: (table: { __id: string }) => ({
          values: (v: Record<string, unknown>) => ({
            returning: async () => {
              inserts.push({ table: table.__id, values: v });
              return [{ id: `${table.__id}-${inserts.length}`, ...v }];
            },
          }),
        }),
      }),
  }),
}));
vi.mock('@atlas/db', () => ({ movimentacao: { __id: 'movimentacao' }, aprovacao: { __id: 'aprovacao' }, users: { __id: 'users' } }));
vi.mock('@atlas/integration-omie', () => ({
  consultarRecebimentoNfe: vi.fn(),
  alterarRecebimentoNfeItens: vi.fn(),
  concluirRecebimentoNfe: vi.fn(),
  consultarPedidoCompra: vi.fn(),
  incluirAjusteEstoque: vi.fn(),
  listarAjusteEstoque: vi.fn(),
  consultarNF: vi.fn(),
  isMockMode: () => false,
}));
vi.mock('../services/notificacao.service.js', () => ({
  enviarAlertaRecebimentoNacionalLote: vi.fn().mockResolvedValue(undefined),
  enviarAvisoComprasNfSemPc: vi.fn().mockResolvedValue('enviado'),
}));
vi.mock('../services/correlacao-produto.service.js', () => ({
  registrarUsoCorrelacao: vi.fn(),
  sugerirProdutosEmLote: vi.fn().mockResolvedValue(new Map()),
  definirConjuntoCorrelacao: vi.fn(),
}));
vi.mock('../services/produto-gemeo-q2p.js', () => ({ resolverGemeosQ2p: (c: number[]) => spies.gemeos(c) }));
vi.mock('../services/fila-nacional.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/fila-nacional.service.js')>('../services/fila-nacional.service.js');
  return { ...real, montarDetalheNfNacional: (c: string) => spies.detalhe(c) };
});
vi.mock('../services/recebimento-fiscal.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/recebimento-fiscal.service.js')>('../services/recebimento-fiscal.service.js');
  return { ...real, concluirRecebimentoFiscal: (i: unknown) => spies.fiscal(i) };
});
vi.mock('../middleware/role.js', () => {
  const auth = (req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user?: { id: string; role: string } }).user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'operador' };
    next();
  };
  return { requireOperador: auth, requireGestor: auth };
});
vi.mock('../middleware/armazem-vinculado.js', () => ({
  requireArmazemVinculado: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import router from '../routes/recebimento-nacional.routes.js';
import { converterItemNfParaKg } from '../services/unidade-nf.js';
import type { DetalheNfNacional, ItemNfNacional } from '../services/fila-nacional.service.js';

const CHAVE = '35261011111111000111550010000009370000009370';
const URL_POR_NF = '/api/v1/stockbridge/recebimento/nacional/por-nf';
const LOC_21_1 = '21111111-1111-4111-8111-111111111111';
const LOC_20_0_7 = '20000000-0000-4000-8000-000000000007';
const LOC_Q2P = '11222222-2222-4222-8222-222222222222';
const DESC = 'PP PRETO Q35';
const app = express();
app.use(express.json());
app.use(router);

function item(): ItemNfNacional {
  return {
    indice: 0, descricaoFornecedor: DESC, descricaoNormalizada: DESC, cfop: '1.101', quantidadeNf: 26000, unidadeOriginal: 'KG',
    quantidadeNfKg: 26000, valorUnitarioBrl: 4.8, valorTotalItemBrl: 124800, rsPorKg: 4.8, linhasAgregadas: 1, produtosSugeridos: [],
    bloqueio: 'sem_correlacao', bloqueioMensagem: null, jaRecebido: false, quantidadeNfJaAtribuidaKg: 0, quantidadeConferidaJaGravadaKg: 0,
    quantidadeRestanteKg: 26000, baixadoComoExterno: false, baixaSolicitada: false, conversao: converterItemNfParaKg(26000, 'KG', 124800),
    sequenciasRecebimento: [1], pc: null,
  };
}
const detalhe = (over: Partial<DetalheNfNacional> = {}): DetalheNfNacional =>
  ({
    nfChaveAcesso: CHAVE, notaFiscal: '937', fornecedorNome: 'SOLUTEC PLASTICOS LTDA', fornecedorCnpj: '11.111.111/0001-11',
    dtEmissao: '2026-10-20', diasDesdeEmissao: 2, cfop: '1.101', valorTotalBrl: 124800, valorNotaBrl: 124800, itens: [item()],
    linhasForaDoRecorte: 0, fiscal: 'concluido', nIdReceb: null, dispensavel: true, empresa: 'acxe', exigePc: false,
    estoqueLancadoPeloOmie: false, copiaPcsDefasada: false, itensSemAvaliacaoPc: [], pcsDaNf: { pcs: [], preSelecionado: null }, ...over,
  }) as DetalheNfNacional;

const corpo = (produtos: Array<Record<string, unknown>>) => ({ nf_chave_acesso: CHAVE, itens: [{ indice: 0, descricao_fornecedor: DESC, produtos }] });

beforeEach(() => {
  inserts.length = 0;
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes('stockbridge.localidade l') && sql.includes("l.tipo NOT LIKE 'virtual%'")) {
      const destinos: Record<string, { codigo: string; codigo_acxe: string; codigo_q2p: string | null }> = {
        [LOC_21_1]: { codigo: '21.1', codigo_acxe: '4553940001', codigo_q2p: '4553940002' },
        [LOC_20_0_7]: { codigo: '20.0.7', codigo_acxe: '4553940398', codigo_q2p: null },
      };
      return Promise.resolve({ rows: ((params?.[0] as string[]) ?? []).filter((id) => destinos[id]).map((id) => ({ id, ...destinos[id]! })) });
    }
    return Promise.resolve({ rows: [] });
  });
  spies.detalhe.mockReset();
  spies.detalhe.mockImplementation(async () => ({ detalhe: detalhe(), interno: { fornecedorCodigo: 1111, espelhoConfirmaConclusao: true, pcPorIndice: new Map() } }));
  spies.fiscal.mockReset();
  spies.gemeos.mockReset();
  spies.gemeos.mockResolvedValue(
    new Map([
      [4001, { codigoAcxe: 4001, descricaoAcxe: 'PP PRETO Q35', ativoAcxe: true, unidadeAcxe: 'KG', emKgAcxe: true, gemeoQ2p: { codigo: 9001, descricao: 'PP PRETO Q35' } }],
      [4002, { codigoAcxe: 4002, descricaoAcxe: 'SUCATA DE PLASTICO', ativoAcxe: true, unidadeAcxe: 'KG', emKgAcxe: true, gemeoQ2p: null }],
    ]),
  );
});

describe('POST /por-nf — NF da ACXE, ponta a ponta (rota + servico + banco fake)', () => {
  it('201: estoque compartilhado (21.1) devolve produtoCodigoAcxe, o correspondente da Q2P e entradaEm [acxe,q2p]; grava movimentacao + aprovacao', async () => {
    const res = await request(app).post(URL_POR_NF).send(corpo([{ produto_codigo_acxe: 4001, quantidade_kg: 26000, localidade_id: LOC_21_1 }]));
    expect(res.status).toBe(201);
    expect(res.body.error).toBeNull();
    expect(res.body.data.resumo).toEqual({ enviadosParaAprovacao: 1, jaRecebidos: 0, bloqueados: 0, falhas: 0 });
    expect(res.body.data.produtos[0]).toMatchObject({
      status: 'aguardando_aprovacao', produtoCodigoAcxe: 4001, produtoCodigoQ2p: 9001, entradaEm: ['acxe', 'q2p'], produto: 'PP PRETO Q35',
      movimentacaoId: 'movimentacao-1', aprovacaoId: 'aprovacao-2',
    });
    expect(inserts.map((i) => i.table)).toEqual(['movimentacao', 'aprovacao']);
    expect(inserts[0]!.values).toMatchObject({ empresa: 'acxe', produtoCodigoAcxe: 4001, produtoCodigoQ2p: 9001, galpao: '21.1' });
  });

  it('201: estoque so da ACXE (20.0.7) devolve produtoCodigoQ2p null e entradaEm [acxe]', async () => {
    const res = await request(app).post(URL_POR_NF).send(corpo([{ produto_codigo_acxe: 4002, quantidade_kg: 26000, localidade_id: LOC_20_0_7 }]));
    expect(res.status).toBe(201);
    expect(res.body.data.produtos[0]).toMatchObject({ status: 'aguardando_aprovacao', produtoCodigoAcxe: 4002, produtoCodigoQ2p: null, entradaEm: ['acxe'] });
    expect(JSON.stringify(res.body)).not.toMatch(/4553940\d{3}/); // nenhum codigo de local do OMIE na resposta
  });

  it('o campo do outro cadastro pode vir null no JSON (a tela manda o par): so o da empresa da NF conta', async () => {
    const a = await request(app).post(URL_POR_NF).send(corpo([{ produto_codigo_acxe: 4001, produto_codigo_q2p: null, quantidade_kg: 26000, localidade_id: LOC_20_0_7 }]));
    expect(a.status).toBe(201);
    expect(inserts[0]!.values).toMatchObject({ produtoCodigoAcxe: 4001, produtoCodigoQ2p: null });
  });

  it('400 PRODUTO_EMPRESA_INCOMPATIVEL: produto da Q2P numa NF da ACXE — nada consultado nem gravado', async () => {
    const res = await request(app).post(URL_POR_NF).send(corpo([{ produto_codigo_q2p: 3033097757, quantidade_kg: 26000, localidade_id: LOC_20_0_7 }]));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PRODUTO_EMPRESA_INCOMPATIVEL');
    expect(res.body.error.userMessage).toContain('é da ACXE');
    expect(inserts).toHaveLength(0);
    expect(spies.gemeos).not.toHaveBeenCalled();
  });

  it('422 PRODUTO_SEM_CORRELATO_Q2P: texto do contrato, sem codigo OMIE, antes do fiscal e sem gravar', async () => {
    spies.detalhe.mockImplementation(async () => ({ detalhe: detalhe({ fiscal: 'pendente' }), interno: { fornecedorCodigo: 1111, espelhoConfirmaConclusao: true, pcPorIndice: new Map() } }));
    const res = await request(app).post(URL_POR_NF).send(corpo([{ produto_codigo_acxe: 4002, quantidade_kg: 26000, localidade_id: LOC_21_1 }]));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PRODUTO_SEM_CORRELATO_Q2P');
    expect(res.body.error.userMessage).toBe(
      'O produto "SUCATA DE PLASTICO" não tem correspondente na Q2P, então não pode entrar em estoque que também é da Q2P. Escolha um estoque só da ACXE ou peça o cadastro do produto na Q2P.',
    );
    expect(spies.fiscal).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it('422 PRODUTO_CORRELATO_Q2P_REPETIDO: dois produtos da ACXE com o mesmo correspondente, ambos em estoque compartilhado', async () => {
    spies.gemeos.mockResolvedValue(
      new Map([
        [4001, { codigoAcxe: 4001, descricaoAcxe: 'PP PRETO Q35', ativoAcxe: true, unidadeAcxe: 'KG', emKgAcxe: true, gemeoQ2p: { codigo: 9001, descricao: 'PP PRETO Q35' } }],
        [4003, { codigoAcxe: 4003, descricaoAcxe: 'PP PRETO Q35', ativoAcxe: true, unidadeAcxe: 'KG', emKgAcxe: true, gemeoQ2p: { codigo: 9001, descricao: 'PP PRETO Q35' } }],
      ]),
    );
    const res = await request(app)
      .post(URL_POR_NF)
      .send(corpo([
        { produto_codigo_acxe: 4001, quantidade_kg: 13000, localidade_id: LOC_21_1 },
        { produto_codigo_acxe: 4003, quantidade_kg: 13000, localidade_id: LOC_21_1 },
      ]));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PRODUTO_CORRELATO_Q2P_REPETIDO');
    expect(inserts).toHaveLength(0);
  });

  it('400 LOCALIDADE_NAO_ELEGIVEL: estoque so da Q2P numa NF da ACXE, sem UUID na mensagem', async () => {
    const res = await request(app).post(URL_POR_NF).send(corpo([{ produto_codigo_acxe: 4001, quantidade_kg: 26000, localidade_id: LOC_Q2P }]));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('LOCALIDADE_NAO_ELEGIVEL');
    expect(res.body.error.userMessage).not.toContain(LOC_Q2P);
    expect(inserts).toHaveLength(0);
  });

  it('a empresa nao entra no corpo: campo `empresa` e recusado (.strict) e a NF da ACXE nao muda por isso', async () => {
    const res = await request(app).post(URL_POR_NF).send({ ...corpo([{ produto_codigo_acxe: 4001, quantidade_kg: 26000, localidade_id: LOC_20_0_7 }]), empresa: 'q2p' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(spies.detalhe).not.toHaveBeenCalled();
  });
});
