import { describe, it, expect, vi, beforeEach } from 'vitest';

const incluirSpy = vi.fn();
const listarSpy = vi.fn();

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@atlas/integration-omie', () => ({
  incluirAjusteEstoque: (...args: unknown[]) => incluirSpy(...args),
  listarAjusteEstoque: (...args: unknown[]) => listarSpy(...args),
}));

import { incluirAjusteIdempotente, buscarAjustePorCodIntAjuste } from '../services/omie-idempotente.js';

const inputBase = {
  codigoLocalEstoque: '4498926337',
  idProduto: 100,
  dataAtual: '20/04/2026',
  quantidade: 25_000,
  observacao: 'NF 12345',
  origem: 'AJU' as const,
  tipo: 'TRF' as const,
  motivo: 'TRF' as const,
  valor: 1.2,
};

describe('incluirAjusteIdempotente', () => {
  beforeEach(() => {
    incluirSpy.mockReset();
    listarSpy.mockReset();
  });

  it('verificarAntes=false (default) chama Incluir direto sem listar', async () => {
    incluirSpy.mockResolvedValue({ idMovest: 'M1', idAjuste: 'A1', descricaoStatus: 'ok' });

    const res = await incluirAjusteIdempotente('acxe', 'op-1:acxe-trf', inputBase);

    expect(res).toEqual({ idMovest: 'M1', idAjuste: 'A1', jaExistia: false });
    expect(listarSpy).not.toHaveBeenCalled();
    expect(incluirSpy).toHaveBeenCalledTimes(1);
    expect(incluirSpy).toHaveBeenCalledWith('acxe', expect.objectContaining({
      codIntAjuste: 'op-1:acxe-trf',
      idProduto: 100,
    }));
  });

  it('verificarAntes=true + lista vazia → chama Incluir', async () => {
    listarSpy.mockResolvedValue({
      pagina: 1, totalDePaginas: 1, registros: 0, totalDeRegistros: 0, ajustes: [],
    });
    incluirSpy.mockResolvedValue({ idMovest: 'M2', idAjuste: 'A2', descricaoStatus: 'ok' });

    const res = await incluirAjusteIdempotente(
      'q2p',
      'op-2:q2p-ent',
      inputBase,
      { verificarAntes: true },
    );

    expect(res).toEqual({ idMovest: 'M2', idAjuste: 'A2', jaExistia: false });
    expect(listarSpy).toHaveBeenCalledWith('q2p', expect.objectContaining({
      codIntAjuste: 'op-2:q2p-ent',
    }));
    expect(incluirSpy).toHaveBeenCalledTimes(1);
  });

  it('verificarAntes=true + match → NAO chama Incluir, retorna jaExistia=true', async () => {
    listarSpy.mockResolvedValue({
      pagina: 1, totalDePaginas: 1, registros: 1, totalDeRegistros: 1,
      ajustes: [{
        idMovest: 'M-EXIST',
        idAjuste: 'A-EXIST',
        codIntAjuste: 'op-3:q2p-ent',
        dataMovimento: '20/04/2026',
        codigoLocalEstoque: '8115873874',
        idProduto: 100,
        quantidade: 25_000,
        valor: 1.2,
        observacao: '',
      }],
    });

    const res = await incluirAjusteIdempotente(
      'q2p',
      'op-3:q2p-ent',
      inputBase,
      { verificarAntes: true },
    );

    expect(res).toEqual({ idMovest: 'M-EXIST', idAjuste: 'A-EXIST', jaExistia: true });
    expect(incluirSpy).not.toHaveBeenCalled();
  });

  it('verificarAntes=true + match parcial (codIntAjuste diferente) → chama Incluir', async () => {
    // Defesa contra OMIE retornar prefix-match em vez de exato.
    listarSpy.mockResolvedValue({
      pagina: 1, totalDePaginas: 1, registros: 1, totalDeRegistros: 1,
      ajustes: [{
        idMovest: 'M-OUTRO',
        idAjuste: 'A-OUTRO',
        codIntAjuste: 'op-4-OUTRO:q2p-ent',
        dataMovimento: '20/04/2026',
        codigoLocalEstoque: '8115873874',
        idProduto: 100,
        quantidade: 25_000,
        valor: 1.2,
        observacao: '',
      }],
    });
    incluirSpy.mockResolvedValue({ idMovest: 'M-NEW', idAjuste: 'A-NEW', descricaoStatus: 'ok' });

    const res = await incluirAjusteIdempotente(
      'q2p',
      'op-4:q2p-ent',
      inputBase,
      { verificarAntes: true },
    );

    expect(res.jaExistia).toBe(false);
    expect(incluirSpy).toHaveBeenCalledTimes(1);
  });
});

describe('buscarAjustePorCodIntAjuste', () => {
  beforeEach(() => {
    listarSpy.mockReset();
  });

  it('retorna ajuste quando lista contem match exato', async () => {
    listarSpy.mockResolvedValue({
      pagina: 1, totalDePaginas: 1, registros: 1, totalDeRegistros: 1,
      ajustes: [{
        idMovest: 'M-X',
        idAjuste: 'A-X',
        codIntAjuste: 'op-5:acxe-trf',
        dataMovimento: '20/04/2026',
        codigoLocalEstoque: '4498926337',
        idProduto: 100,
        quantidade: 25_000,
        valor: 1.2,
        observacao: '',
      }],
    });

    const res = await buscarAjustePorCodIntAjuste('acxe', 'op-5:acxe-trf');
    expect(res?.idMovest).toBe('M-X');
  });

  it('retorna null quando lista esta vazia', async () => {
    listarSpy.mockResolvedValue({
      pagina: 1, totalDePaginas: 1, registros: 0, totalDeRegistros: 0, ajustes: [],
    });

    const res = await buscarAjustePorCodIntAjuste('acxe', 'op-nao-existe:acxe-trf');
    expect(res).toBeNull();
  });
});
