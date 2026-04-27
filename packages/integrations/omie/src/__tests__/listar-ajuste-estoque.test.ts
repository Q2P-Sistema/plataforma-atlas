import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { incluirAjusteEstoque } from '../stockbridge/ajuste-estoque.js';
import { listarAjusteEstoque } from '../stockbridge/listar-ajuste-estoque.js';
import { __resetMockState } from '../stockbridge/mock.js';

describe('listarAjusteEstoque — mock mode', () => {
  const originalMode = process.env.OMIE_MODE;

  beforeEach(() => {
    process.env.OMIE_MODE = 'mock';
    __resetMockState();
  });

  afterEach(() => {
    process.env.OMIE_MODE = originalMode;
    __resetMockState();
  });

  it('filtro por codIntAjuste retorna match exato', async () => {
    await incluirAjusteEstoque('acxe', {
      codigoLocalEstoque: '4498926337',
      idProduto: 100,
      dataAtual: '20/04/2026',
      quantidade: 25_000,
      observacao: 'NF 12345',
      origem: 'AJU',
      tipo: 'TRF',
      motivo: 'TRF',
      valor: 1.2,
      codIntAjuste: 'op-abc-123:acxe-trf',
    });

    const res = await listarAjusteEstoque('acxe', { codIntAjuste: 'op-abc-123:acxe-trf' });

    expect(res.totalDeRegistros).toBe(1);
    expect(res.ajustes).toHaveLength(1);
    expect(res.ajustes[0]?.codIntAjuste).toBe('op-abc-123:acxe-trf');
    expect(res.ajustes[0]?.idMovest).toMatch(/^MOCK-MOVEST-acxe-/);
  });

  it('filtro sem match retorna lista vazia', async () => {
    await incluirAjusteEstoque('acxe', {
      codigoLocalEstoque: '4498926337',
      idProduto: 100,
      dataAtual: '20/04/2026',
      quantidade: 25_000,
      observacao: 'NF 12345',
      origem: 'AJU',
      tipo: 'TRF',
      motivo: 'TRF',
      valor: 1.2,
      codIntAjuste: 'op-abc-123:acxe-trf',
    });

    const res = await listarAjusteEstoque('acxe', { codIntAjuste: 'op-NAO-EXISTE:q2p-ent' });

    expect(res.totalDeRegistros).toBe(0);
    expect(res.ajustes).toEqual([]);
  });

  it('isolamento por CNPJ — codIntAjuste em ACXE nao aparece em Q2P', async () => {
    await incluirAjusteEstoque('acxe', {
      codigoLocalEstoque: '4498926337',
      idProduto: 100,
      dataAtual: '20/04/2026',
      quantidade: 25_000,
      observacao: '',
      origem: 'AJU',
      tipo: 'TRF',
      motivo: 'TRF',
      valor: 1.2,
      codIntAjuste: 'op-shared:acxe-trf',
    });

    const resQ2p = await listarAjusteEstoque('q2p', { codIntAjuste: 'op-shared:acxe-trf' });
    expect(resQ2p.totalDeRegistros).toBe(0);

    const resAcxe = await listarAjusteEstoque('acxe', { codIntAjuste: 'op-shared:acxe-trf' });
    expect(resAcxe.totalDeRegistros).toBe(1);
  });

  it('paginacao retorna metadados corretos', async () => {
    for (let i = 0; i < 7; i++) {
      await incluirAjusteEstoque('acxe', {
        codigoLocalEstoque: '4498926337',
        idProduto: 100,
        dataAtual: '20/04/2026',
        quantidade: 1_000,
        observacao: `bulk ${i}`,
        origem: 'AJU',
        tipo: 'TRF',
        motivo: 'TRF',
        valor: 1.2,
        codIntAjuste: `op-bulk-${i}:acxe-trf`,
      });
    }

    const pagina1 = await listarAjusteEstoque('acxe', { pagina: 1, registrosPorPagina: 3 });
    expect(pagina1.totalDeRegistros).toBe(7);
    expect(pagina1.totalDePaginas).toBe(3);
    expect(pagina1.registros).toBe(3);
    expect(pagina1.ajustes).toHaveLength(3);

    const pagina3 = await listarAjusteEstoque('acxe', { pagina: 3, registrosPorPagina: 3 });
    expect(pagina3.registros).toBe(1);
    expect(pagina3.ajustes).toHaveLength(1);
  });

  it('lista vazia quando nada foi incluido', async () => {
    const res = await listarAjusteEstoque('acxe', {});
    expect(res.totalDeRegistros).toBe(0);
    expect(res.ajustes).toEqual([]);
    expect(res.totalDePaginas).toBe(1);
  });
});
