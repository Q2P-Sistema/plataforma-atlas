import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — listas que a tela usa na NF da ACXE:
//  - listarDestinosEntradaNf: estoques de destino por empresa da NF (a ACXE traz 11.1, 12.1, 21.1, 31.1 — que
//    entram nas duas empresas — e 21.2, 20.0.5, 20.0.7 — so ACXE —, sem o 90.0.2 TRANSITO e sem codigo OMIE);
//  - buscarProdutosNacional(acxe): cada produto diz se NAO tem correspondente na Q2P (semCorrelatoQ2p).

const executeSpy = vi.fn();
const spies = vi.hoisted(() => ({ gemeos: vi.fn() }));

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => ({ execute: (q: unknown) => executeSpy(q) }),
  getPool: () => ({ query: vi.fn() }),
  getConfig: () => ({}),
}));
vi.mock('@atlas/db', () => ({ movimentacao: { __id: 'movimentacao' }, aprovacao: { __id: 'aprovacao' } }));
vi.mock('@atlas/integration-omie', () => ({ consultarRecebimentoNfe: vi.fn(), isMockMode: () => false }));
vi.mock('../services/notificacao.service.js', () => ({
  enviarAlertaRecebimentoNacionalLote: vi.fn(),
  enviarAvisoComprasNfSemPc: vi.fn(),
}));
vi.mock('../services/produto-gemeo-q2p.js', () => ({ resolverGemeosQ2p: (c: number[]) => spies.gemeos(c) }));

import { listarDestinosEntradaNf, buscarProdutosNacional } from '../services/recebimento-nacional.service.js';

const textoSql = (): string => {
  const q = executeSpy.mock.calls[0]![0] as { queryChunks?: unknown[] };
  return JSON.stringify(q.queryChunks ?? q);
};

beforeEach(() => {
  executeSpy.mockReset();
  spies.gemeos.mockReset();
});

describe('listarDestinosEntradaNf', () => {
  it('ACXE: ativos, nao virtuais, com codigo da ACXE; os que tem codigo da Q2P entram nas duas e vem primeiro', async () => {
    executeSpy.mockResolvedValue({
      rows: [
        { id: 'u1', codigo: '11.1', nome: 'SANTO ANDRE', tipo: 'proprio', entra_nas_duas: true },
        { id: 'u2', codigo: '31.1', nome: 'TPL', tipo: 'tpl', entra_nas_duas: true },
        { id: 'u3', codigo: '20.0.5', nome: 'PROCESSO', tipo: 'operacional', entra_nas_duas: false },
        { id: 'u4', codigo: '21.2', nome: 'EXTREMA (NACIONAL)', tipo: 'proprio', entra_nas_duas: false },
      ],
    });
    const lista = await listarDestinosEntradaNf('acxe');
    expect(lista).toEqual([
      { id: 'u1', codigo: '11.1', nome: 'SANTO ANDRE', tipo: 'proprio', entradaEm: ['acxe', 'q2p'] },
      { id: 'u2', codigo: '31.1', nome: 'TPL', tipo: 'tpl', entradaEm: ['acxe', 'q2p'] },
      { id: 'u3', codigo: '20.0.5', nome: 'PROCESSO', tipo: 'operacional', entradaEm: ['acxe'] },
      { id: 'u4', codigo: '21.2', nome: 'EXTREMA (NACIONAL)', tipo: 'proprio', entradaEm: ['acxe'] },
    ]);
  });

  it('ACXE: o SQL filtra por TIPO (nao por codigo), exige codigo da ACXE e ordena as duas empresas primeiro', async () => {
    executeSpy.mockResolvedValue({ rows: [] });
    await listarDestinosEntradaNf('acxe');
    const sql = textoSql();
    expect(sql).toContain('l.ativo = true');
    expect(sql).toContain("l.tipo NOT LIKE 'virtual%'");
    expect(sql).toContain('lc.codigo_local_estoque_acxe IS NOT NULL');
    expect(sql).toContain('ORDER BY (lc.codigo_local_estoque_q2p IS NOT NULL) DESC, l.codigo');
    // nada de lista de espelhadas / tipo proprio / codigo fixo
    expect(sql).not.toContain("'proprio'");
    expect(sql).not.toContain('90.0');
  });

  it('a resposta nao traz codigo do OMIE (ACXEGDP-313)', async () => {
    executeSpy.mockResolvedValue({ rows: [{ id: 'u1', codigo: '21.1', nome: 'EXTREMA', tipo: 'proprio', entra_nas_duas: true }] });
    const [d] = await listarDestinosEntradaNf('acxe');
    expect(Object.keys(d!).sort()).toEqual(['codigo', 'entradaEm', 'id', 'nome', 'tipo']);
  });

  it('Q2P: a lista de hoje (so Q2P), no mesmo formato, entradaEm [q2p]', async () => {
    executeSpy.mockResolvedValue({
      rows: [{ id: 'q1', codigo: '11.2', nome: 'SANTO ANDRE (NACIONAL)', tipo: 'proprio', cidade: 'Santo Andre', cnpj: '27.019.059/0001-88', codigo_local_estoque: '8123584710' }],
    });
    const lista = await listarDestinosEntradaNf('q2p');
    expect(lista).toEqual([{ id: 'q1', codigo: '11.2', nome: 'SANTO ANDRE (NACIONAL)', tipo: 'proprio', entradaEm: ['q2p'] }]);
    // a consulta e a de listarLocalidadesNacional('q2p'): so Q2P (a coluna da ACXE tem de ser NULL)
    const sql = textoSql();
    expect(sql).toContain('"codigo_local_estoque_acxe"');
    expect(sql).toContain(' IS NULL');
  });
});

describe('buscarProdutosNacional — semCorrelatoQ2p (empresa=acxe)', () => {
  beforeEach(() => {
    executeSpy.mockResolvedValue({
      rows: [
        { codigo: '4001', descricao: 'PP PRETO Q35', unidade: 'KG' },
        { codigo: '4002', descricao: 'SUCATA DE PLASTICO', unidade: 'KG' },
        { codigo: '4009', descricao: 'PRODUTO NOVO', unidade: 'KG' },
      ],
    });
  });

  it('marca o produto sem produto Q2P ativo de mesma descricao; o com correspondente fica false', async () => {
    spies.gemeos.mockResolvedValue(
      new Map([
        [4001, { codigoAcxe: 4001, descricaoAcxe: 'PP PRETO Q35', ativoAcxe: true, unidadeAcxe: 'KG', emKgAcxe: true, gemeoQ2p: { codigo: 9001, descricao: 'PP PRETO Q35' } }],
        [4002, { codigoAcxe: 4002, descricaoAcxe: 'SUCATA DE PLASTICO', ativoAcxe: true, unidadeAcxe: 'KG', emKgAcxe: true, gemeoQ2p: null }],
      ]),
    );
    const lista = await buscarProdutosNacional({ empresa: 'acxe', q: 'p' });
    expect(spies.gemeos).toHaveBeenCalledWith([4001, 4002, 4009]);
    expect(lista.map((p) => [p.codigo, p.semCorrelatoQ2p])).toEqual([
      [4001, false],
      [4002, true],
      [4009, undefined], // fora do cadastro retornado pelo correspondente: sem marca
    ]);
  });

  it('falha ao consultar o correspondente: a lista segue sem a marca (o POST por NF ainda recusa)', async () => {
    spies.gemeos.mockRejectedValue(new Error('db fora'));
    const lista = await buscarProdutosNacional({ empresa: 'acxe' });
    expect(lista).toHaveLength(3);
    expect(lista.every((p) => p.semCorrelatoQ2p === undefined)).toBe(true);
  });

  it('Q2P: nao consulta o correspondente e nao traz a marca', async () => {
    executeSpy.mockResolvedValue({ rows: [{ codigo: '3033097757', descricao: 'PS CRISTAL A', unidade: 'KG' }] });
    const lista = await buscarProdutosNacional({ empresa: 'q2p' });
    expect(lista).toEqual([{ codigo: 3033097757, descricao: 'PS CRISTAL A', unidadeMedida: 'KG' }]);
    expect(spies.gemeos).not.toHaveBeenCalled();
  });
});
