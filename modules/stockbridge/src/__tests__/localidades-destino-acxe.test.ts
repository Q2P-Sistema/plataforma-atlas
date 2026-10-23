import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Feature 017, Historia 5 (ACXEGDP-437) — GET /recebimento/nacional/localidades?empresa=...&destino=nf com o SERVICO
// REAL e um banco fake: o formato que a tela le (so id, codigo, nome, tipo, entradaEm — nunca o codigo do OMIE,
// ACXEGDP-313), a ordem devolvida pelo banco preservada (estoques que entram nas duas empresas primeiro), a consulta
// que filtra por TIPO (nao por codigo) e a lista do formulario manual (sem destino) inalterada. O SQL em si roda de
// verdade em auditoria-recebimento-nacional-acxe.test.ts (opt-in com banco).

const executeSpy = vi.fn();

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getConfig: () => ({}),
  getDb: () => ({ execute: (q: unknown) => executeSpy(q) }),
  getPool: () => ({ query: vi.fn() }),
}));
vi.mock('@atlas/db', () => ({ movimentacao: { __id: 'movimentacao' }, aprovacao: { __id: 'aprovacao' }, users: { __id: 'users' } }));
vi.mock('@atlas/integration-omie', () => ({ consultarRecebimentoNfe: vi.fn(), isMockMode: () => false }));
vi.mock('../services/notificacao.service.js', () => ({
  enviarAlertaRecebimentoNacionalLote: vi.fn(),
  enviarAvisoComprasNfSemPc: vi.fn(),
}));
vi.mock('../services/produto-gemeo-q2p.js', () => ({ resolverGemeosQ2p: vi.fn().mockResolvedValue(new Map()) }));
vi.mock('../middleware/role.js', () => {
  const auth = (req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user?: unknown }).user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'operador' };
    next();
  };
  return { requireOperador: auth, requireGestor: auth };
});
vi.mock('../middleware/armazem-vinculado.js', () => ({
  requireArmazemVinculado: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import router from '../routes/recebimento-nacional.routes.js';

const app = express();
app.use(express.json());
app.use(router);
const URL = '/api/v1/stockbridge/recebimento/nacional/localidades';
/** O SQL como o banco o recebe: os pedacos estaticos e as colunas injetadas (sql.raw) na ordem, sem a estrutura do Drizzle. */
const achatar = (n: unknown): string => {
  if (n == null || typeof n !== 'object') return '';
  const o = n as { value?: unknown[]; queryChunks?: unknown[] };
  if (Array.isArray(o.value)) return o.value.map(String).join('');
  return Array.isArray(o.queryChunks) ? o.queryChunks.map(achatar).join('') : '';
};
const sqlDaConsulta = (i = 0): string => achatar(executeSpy.mock.calls[i]![0]).replace(/\s+/g, ' ');

const linhasAcxe = [
  { id: 'u-111', codigo: '11.1', nome: 'SANTO ANDRÉ (IMPORTADO)', tipo: 'proprio', entra_nas_duas: true },
  { id: 'u-311', codigo: '31.1', nome: 'ARMAZÉM EXTERNO', tipo: 'tpl', entra_nas_duas: true },
  { id: 'u-212', codigo: '21.2', nome: 'EXTREMA (NACIONAL)', tipo: 'proprio', entra_nas_duas: false },
  { id: 'u-2005', codigo: '20.0.5', nome: 'PROCESSO', tipo: 'operacional', entra_nas_duas: false },
  { id: 'u-2007', codigo: '20.0.7', nome: 'PRODUÇÃO', tipo: 'operacional', entra_nas_duas: false },
];

beforeEach(() => {
  executeSpy.mockReset();
});

describe('GET /localidades?destino=nf — destinos da entrada por NF', () => {
  it('ACXE: so id, codigo, nome, tipo e entradaEm; a ordem do banco e preservada; tipo operacional e destino valido', async () => {
    executeSpy.mockResolvedValue({ rows: linhasAcxe });
    const res = await request(app).get(`${URL}?empresa=acxe&destino=nf`);
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data).toEqual([
      { id: 'u-111', codigo: '11.1', nome: 'SANTO ANDRÉ (IMPORTADO)', tipo: 'proprio', entradaEm: ['acxe', 'q2p'] },
      { id: 'u-311', codigo: '31.1', nome: 'ARMAZÉM EXTERNO', tipo: 'tpl', entradaEm: ['acxe', 'q2p'] },
      { id: 'u-212', codigo: '21.2', nome: 'EXTREMA (NACIONAL)', tipo: 'proprio', entradaEm: ['acxe'] },
      { id: 'u-2005', codigo: '20.0.5', nome: 'PROCESSO', tipo: 'operacional', entradaEm: ['acxe'] },
      { id: 'u-2007', codigo: '20.0.7', nome: 'PRODUÇÃO', tipo: 'operacional', entradaEm: ['acxe'] },
    ]);
  });

  it('a resposta nunca carrega codigo do OMIE, mesmo que a consulta traga colunas a mais', async () => {
    executeSpy.mockResolvedValue({
      rows: [{ ...linhasAcxe[0], codigo_local_estoque_acxe: '4498926337', codigo_local_estoque_q2p: '8115873874', cnpj: '27.019.059/0001-88' }],
    });
    const res = await request(app).get(`${URL}?empresa=acxe&destino=nf`);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['codigo', 'entradaEm', 'id', 'nome', 'tipo']);
    expect(JSON.stringify(res.body)).not.toMatch(/\d{9,}/);
  });

  it('a consulta da ACXE filtra por TIPO (nao por codigo), exige codigo da ACXE e ordena os que entram nas duas primeiro', async () => {
    executeSpy.mockResolvedValue({ rows: [] });
    await request(app).get(`${URL}?empresa=acxe&destino=nf`);
    const sql = sqlDaConsulta();
    expect(sql).toContain('l.ativo = true');
    expect(sql).toContain("l.tipo NOT LIKE 'virtual%'");
    expect(sql).toContain('lc.codigo_local_estoque_acxe IS NOT NULL');
    expect(sql).toContain('ORDER BY (lc.codigo_local_estoque_q2p IS NOT NULL) DESC, l.codigo');
    expect(sql).not.toMatch(/90\.0|'proprio'/);
  });

  it('Q2P: a lista de hoje (so Q2P, XOR) no mesmo formato, entradaEm [q2p]', async () => {
    executeSpy.mockResolvedValue({
      rows: [
        { id: 'q-112', codigo: '11.2', nome: 'SANTO ANDRÉ (NACIONAL)', tipo: 'proprio', cidade: 'Santo André', cnpj: '27.019.059/0001-88', codigo_local_estoque: '8123584710' },
        { id: 'q-122', codigo: '12.2', nome: 'SANTO ANDRÉ 2 (NACIONAL)', tipo: 'proprio', cidade: 'Santo André', cnpj: '27.019.059/0002-69', codigo_local_estoque: '8123584481' },
      ],
    });
    const res = await request(app).get(`${URL}?empresa=q2p&destino=nf`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: 'q-112', codigo: '11.2', nome: 'SANTO ANDRÉ (NACIONAL)', tipo: 'proprio', entradaEm: ['q2p'] },
      { id: 'q-122', codigo: '12.2', nome: 'SANTO ANDRÉ 2 (NACIONAL)', tipo: 'proprio', entradaEm: ['q2p'] },
    ]);
  });
});

describe('GET /localidades sem destino — o formulario manual, inalterado', () => {
  it('devolve o item completo (cidade, cnpj, empresa, codigoLocalEstoqueOmie) como antes e sem entradaEm', async () => {
    executeSpy.mockResolvedValue({
      rows: [{ id: 'u-212', codigo: '21.2', nome: 'EXTREMA (NACIONAL)', tipo: 'proprio', cidade: 'Extrema', cnpj: null, codigo_local_estoque: '4452867179' }],
    });
    const res = await request(app).get(`${URL}?empresa=acxe`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: 'u-212', codigo: '21.2', nome: 'EXTREMA (NACIONAL)', tipo: 'proprio', cidade: 'Extrema', cnpj: null, empresa: 'acxe', codigoLocalEstoqueOmie: '4452867179' },
    ]);
    // so os estoques com codigo em UMA das empresas (XOR): os compartilhados e os virtuais ficam de fora
    const sql = sqlDaConsulta();
    expect(sql).toContain("l.tipo NOT IN ('virtual_transito', 'virtual_ajuste')");
    expect(sql).toContain('lc.codigo_local_estoque_acxe IS NOT NULL');
    expect(sql).toContain('lc.codigo_local_estoque_q2p IS NULL');
  });
});

describe('parametros e falhas', () => {
  it.each([['sem empresa', '?destino=nf'], ['empresa invalida', '?empresa=x&destino=nf'], ['destino desconhecido', '?empresa=acxe&destino=todos']])(
    '400 INVALID_INPUT: %s (e o banco nao e consultado)',
    async (_n, qs) => {
      const res = await request(app).get(`${URL}${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(executeSpy).not.toHaveBeenCalled();
    },
  );

  it('falha de banco: 500 LOCALIDADES_NACIONAL_FAIL, sem vazar a consulta', async () => {
    executeSpy.mockRejectedValue(new Error('connection refused'));
    const res = await request(app).get(`${URL}?empresa=acxe&destino=nf`);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('LOCALIDADES_NACIONAL_FAIL');
    expect(JSON.stringify(res.body)).not.toContain('SELECT');
  });
});
