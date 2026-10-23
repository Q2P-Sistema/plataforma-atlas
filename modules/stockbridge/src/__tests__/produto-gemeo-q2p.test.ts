import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — `resolverGemeosQ2p`: o "gemeo" Q2P de um produto da ACXE.
//
// A compra nacional da ACXE em estoque que tambem e da Q2P (11.1, 12.1, 21.1, 31.1) entra nas duas empresas, entao o
// produto da ACXE precisa ter correspondente na Q2P. A regra e a de `getCorrelacao` (correlacao.service.ts, clarificacao
// Q6 da 007): descricao IDENTICA (sem trim nem caixa), produto Q2P ATIVO, o de MENOR codigo quando ha mais de um. NAO e a
// de `resolverCodigoProdutoOmie`, que nao filtra inativos. O SQL real (descricao exata, inativo, menor codigo) e provado
// em Postgres em fila-nacional-acxe-db.test.ts (opt-in); aqui, a forma da consulta e o mapeamento, com o pool mockado.

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
}));

vi.mock('@atlas/core', () => ({
  getPool: () => ({ query: (sql: string, params?: unknown[]) => mocks.poolQuery(sql, params) }),
}));

import { resolverGemeosQ2p } from '../services/produto-gemeo-q2p.js';

const norm = (sql: unknown): string => String(sql).replace(/\s+/g, ' ').trim();

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolQuery.mockResolvedValue({ rows: [] });
});

describe('resolverGemeosQ2p — entrada', () => {
  it('sem codigos validos nao consulta o banco (vazio, zero, negativo, NaN, infinito)', async () => {
    expect((await resolverGemeosQ2p([])).size).toBe(0);
    expect((await resolverGemeosQ2p([0, -4, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])).size).toBe(0);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('UMA consulta em lote com os codigos sem repeticao e so os validos', async () => {
    await resolverGemeosQ2p([4501234567, 4501234999, 4501234567, 0, -1]);
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    expect(mocks.poolQuery.mock.calls[0]![1]).toEqual([[4501234567, 4501234999]]);
  });
});

describe('resolverGemeosQ2p — a consulta', () => {
  it('le o cadastro de produtos da ACXE e, para cada um, o produto Q2P de MESMA descricao exata, ativo, de menor codigo', async () => {
    await resolverGemeosQ2p([4501234567]);
    const s = norm(mocks.poolQuery.mock.calls[0]![0]);
    expect(s).toContain('FROM public."tbl_produtos_ACXE" a');
    expect(s).toContain('LEFT JOIN LATERAL (');
    expect(s).toContain('FROM public."tbl_produtos_Q2P" q');
    // descricao identica: igualdade simples, sem lower/trim/unaccent na descricao (a unidade e normalizada a parte)
    expect(s).toContain('WHERE q.descricao = a.descricao');
    expect(s).not.toMatch(/(lower|upper|btrim|unaccent)\([^)]*descricao/);
    // so produto Q2P ativo (a mesma regra de getCorrelacao; resolverCodigoProdutoOmie nao filtra)
    expect(s).toContain("AND (q.inativo IS NULL OR q.inativo <> 'S')");
    // escolha deterministica quando mais de um (STK-22)
    expect(s).toContain('ORDER BY q.codigo_produto ASC LIMIT 1');
    expect(s).toContain('WHERE a.codigo_produto = ANY($1::bigint[])');
  });

  it('o LEFT JOIN mantem o produto da ACXE sem gemeo (codigo_q2p nulo) em vez de sumir com ele', async () => {
    await resolverGemeosQ2p([4501234567]);
    const s = norm(mocks.poolQuery.mock.calls[0]![0]);
    expect(s).toContain('LEFT JOIN LATERAL');
    expect(s).not.toMatch(/INNER JOIN|\bJOIN public\."tbl_produtos_Q2P"/);
  });

  it('o produto da ACXE informa se esta ativo (inativo nulo ou diferente de "S"), sem filtra-lo da consulta', async () => {
    await resolverGemeosQ2p([4501234567]);
    const s = norm(mocks.poolQuery.mock.calls[0]![0]);
    expect(s).toContain("(a.inativo IS NULL OR a.inativo <> 'S') AS ativo_acxe");
    // o filtro de ativo da ACXE nao esta no WHERE: quem chama decide (404 PRODUTO_NAO_ENCONTRADO no POST)
    expect(s.slice(s.indexOf('WHERE a.codigo_produto'))).not.toContain('inativo');
  });
});

describe('resolverGemeosQ2p — resultado', () => {
  it('produto com gemeo: codigo e descricao dos dois lados, como numeros', async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [{ codigo_acxe: '4501234567', descricao_acxe: 'PP PRETO Q35', ativo_acxe: true, unidade_acxe: 'KG', codigo_q2p: '3100320435', descricao_q2p: 'PP PRETO Q35' }],
    });
    const mapa = await resolverGemeosQ2p([4501234567]);
    expect(mapa.get(4501234567)).toEqual({
      codigoAcxe: 4501234567,
      descricaoAcxe: 'PP PRETO Q35',
      ativoAcxe: true,
      unidadeAcxe: 'KG',
      emKgAcxe: true,
      gemeoQ2p: { codigo: 3100320435, descricao: 'PP PRETO Q35' },
    });
  });

  it('produto SEM gemeo ativo na Q2P: gemeoQ2p nulo (so pode entrar em estoque so da ACXE)', async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [{ codigo_acxe: '4501234999', descricao_acxe: 'PS POLIESTIRENO BRANCO', ativo_acxe: true, unidade_acxe: 'KG', codigo_q2p: null, descricao_q2p: null }],
    });
    const mapa = await resolverGemeosQ2p([4501234999]);
    expect(mapa.get(4501234999)).toEqual({ codigoAcxe: 4501234999, descricaoAcxe: 'PS POLIESTIRENO BRANCO', ativoAcxe: true, unidadeAcxe: 'KG', emKgAcxe: true, gemeoQ2p: null });
  });

  it('produto inativo na ACXE vem marcado como inativo (e continua tendo o gemeo, se houver)', async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [{ codigo_acxe: '4500000001', descricao_acxe: 'PRODUTO DESATIVADO', ativo_acxe: false, unidade_acxe: 'KG', codigo_q2p: '3100000001', descricao_q2p: 'PRODUTO DESATIVADO' }],
    });
    const mapa = await resolverGemeosQ2p([4500000001]);
    expect(mapa.get(4500000001)).toMatchObject({ ativoAcxe: false, gemeoQ2p: { codigo: 3100000001 } });
  });

  it('codigo ausente do cadastro da ACXE fica FORA do mapa (quem chama decide: 404 no POST)', async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [{ codigo_acxe: '4501234567', descricao_acxe: 'PP PRETO Q35', ativo_acxe: true, unidade_acxe: 'KG', codigo_q2p: null, descricao_q2p: null }],
    });
    const mapa = await resolverGemeosQ2p([4501234567, 4509999999]);
    expect([...mapa.keys()]).toEqual([4501234567]);
    expect(mapa.has(4509999999)).toBe(false);
  });

  it('descricao nula no cadastro vira texto vazio; "ativo" so vale com true estrito', async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [
        { codigo_acxe: '1', descricao_acxe: null, ativo_acxe: true, unidade_acxe: 'KG', codigo_q2p: '2', descricao_q2p: null },
        { codigo_acxe: '3', descricao_acxe: 'X', ativo_acxe: null, unidade_acxe: 'KG', codigo_q2p: null, descricao_q2p: null },
      ],
    });
    const mapa = await resolverGemeosQ2p([1, 3]);
    expect(mapa.get(1)).toEqual({ codigoAcxe: 1, descricaoAcxe: '', ativoAcxe: true, unidadeAcxe: 'KG', emKgAcxe: true, gemeoQ2p: { codigo: 2, descricao: '' } });
    expect(mapa.get(3)!.ativoAcxe).toBe(false);
  });

  it('varios produtos: um por codigo, na ordem em que o banco devolveu', async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [
        { codigo_acxe: '20', descricao_acxe: 'B', ativo_acxe: true, unidade_acxe: 'KG', codigo_q2p: null, descricao_q2p: null },
        { codigo_acxe: '10', descricao_acxe: 'A', ativo_acxe: true, unidade_acxe: 'KG', codigo_q2p: '11', descricao_q2p: 'A' },
      ],
    });
    const mapa = await resolverGemeosQ2p([10, 20]);
    expect([...mapa.keys()]).toEqual([20, 10]);
    expect(mapa.get(10)!.gemeoQ2p!.codigo).toBe(11);
  });

  it('unidade do produto da ACXE (revisao da Fase 2): so KG vale para o recebimento; sem unidade ou outra, emKgAcxe false', async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [
        { codigo_acxe: '1', descricao_acxe: 'CABO PP 3X2,5MM', ativo_acxe: true, unidade_acxe: 'MT', codigo_q2p: null, descricao_q2p: null },
        { codigo_acxe: '2', descricao_acxe: 'SEM UNIDADE', ativo_acxe: true, unidade_acxe: null, codigo_q2p: null, descricao_q2p: null },
        { codigo_acxe: '3', descricao_acxe: 'PP PRETO Q35', ativo_acxe: true, unidade_acxe: 'KG', codigo_q2p: null, descricao_q2p: null },
      ],
    });
    const mapa = await resolverGemeosQ2p([1, 2, 3]);
    expect(mapa.get(1)).toMatchObject({ unidadeAcxe: 'MT', emKgAcxe: false });
    expect(mapa.get(2)).toMatchObject({ unidadeAcxe: '', emKgAcxe: false });
    expect(mapa.get(3)).toMatchObject({ unidadeAcxe: 'KG', emKgAcxe: true });
  });

  it('a consulta le a unidade aparada e em caixa alta, e o gemeo da Q2P tambem tem de ser KG', async () => {
    await resolverGemeosQ2p([4501234567]);
    const s = norm(mocks.poolQuery.mock.calls[0]![0]);
    expect(s).toContain("upper(btrim(COALESCE(a.unidade, ''))) AS unidade_acxe");
    expect(s).toContain("AND upper(btrim(COALESCE(q.unidade, ''))) = 'KG'");
  });

  it('falha de banco sobe (o detalhe da NF a trata como "sem sugestao"; o POST nao pode seguir sem o gemeo)', async () => {
    mocks.poolQuery.mockRejectedValue(new Error('connection terminated'));
    await expect(resolverGemeosQ2p([4501234567])).rejects.toThrow('connection terminated');
  });
});
