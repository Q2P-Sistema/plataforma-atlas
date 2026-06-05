import { describe, it, expect, vi, beforeEach } from 'vitest';

const incluirSpy = vi.fn();
const listarSpy = vi.fn();

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  getPool: () => ({ query: vi.fn() }),
}));

vi.mock('@atlas/db', () => ({
  lote: {},
  movimentacao: {},
  aprovacao: {},
  localidade: {},
  localidadeCorrelacao: {},
  users: {},
}));

vi.mock('@atlas/integration-omie', () => ({
  incluirAjusteEstoque: (...args: unknown[]) => incluirSpy(...args),
  listarAjusteEstoque: (...args: unknown[]) => listarSpy(...args),
  consultarNF: vi.fn(),
  isMockMode: () => true,
}));

import { executarAjusteOmieDual, transferirDiferencaAcxe } from '../services/recebimento.service.js';

const argsBase = {
  codigoLocalEstoqueAcxeOrigem: '999',
  codigoLocalEstoqueAcxeDestino: 111,
  codigoLocalEstoqueQ2p: 222,
  codigoProdutoAcxe: 1001,
  codigoProdutoQ2p: 2001,
  quantidadeKg: 24_500,
  valorUnitarioAcxe: 1.25,
  valorUnitarioQ2p: 1.44,
  notaFiscal: '12345',
  observacaoSufixo: 'sem divergencias',
};

describe('executarAjusteOmieDual — idempotency markers (US1)', () => {
  beforeEach(() => {
    incluirSpy.mockReset();
    listarSpy.mockReset();
    incluirSpy.mockImplementation((cnpj: string) => Promise.resolve({
      idMovest: `M-${cnpj}`,
      idAjuste: `A-${cnpj}`,
      descricaoStatus: 'ok',
    }));
  });

  it('passa cod_int_ajuste em ambas as chamadas OMIE com mesmo opId e sufixos esperados', async () => {
    const opId = '11111111-2222-3333-4444-555555555555';

    await executarAjusteOmieDual({ ...argsBase, opId });

    expect(incluirSpy).toHaveBeenCalledTimes(2);
    expect(incluirSpy).toHaveBeenNthCalledWith(1, 'acxe', expect.objectContaining({
      codIntAjuste: `${opId}:acxe-trf`,
    }));
    expect(incluirSpy).toHaveBeenNthCalledWith(2, 'q2p', expect.objectContaining({
      codIntAjuste: `${opId}:q2p-ent`,
    }));
  });

  it('verificarAntes=false (default) NAO chama listarAjusteEstoque', async () => {
    await executarAjusteOmieDual({ ...argsBase, opId: 'op-x' });
    expect(listarSpy).not.toHaveBeenCalled();
  });

  it('verificarAntes=true chama listarAjusteEstoque antes de cada inclusao', async () => {
    listarSpy.mockResolvedValue({
      pagina: 1, totalDePaginas: 1, registros: 0, totalDeRegistros: 0, ajustes: [],
    });

    await executarAjusteOmieDual({ ...argsBase, opId: 'op-retry', verificarAntes: true });

    expect(listarSpy).toHaveBeenCalledTimes(2);
    expect(listarSpy).toHaveBeenNthCalledWith(1, 'acxe', expect.objectContaining({
      codIntAjuste: 'op-retry:acxe-trf',
    }));
    expect(listarSpy).toHaveBeenNthCalledWith(2, 'q2p', expect.objectContaining({
      codIntAjuste: 'op-retry:q2p-ent',
    }));
    expect(incluirSpy).toHaveBeenCalledTimes(2);
  });

  it('verificarAntes=true + match em ACXE pula Incluir mas ainda chama Q2P', async () => {
    listarSpy
      .mockResolvedValueOnce({
        pagina: 1, totalDePaginas: 1, registros: 1, totalDeRegistros: 1,
        ajustes: [{
          idMovest: 'M-EXIST',
          idAjuste: 'A-EXIST',
          codIntAjuste: 'op-mid:acxe-trf',
          dataMovimento: '20/04/2026',
          codigoLocalEstoque: '999',
          idProduto: 1001,
          quantidade: 24_500,
          valor: 1.25,
          observacao: '',
        }],
      })
      .mockResolvedValueOnce({
        pagina: 1, totalDePaginas: 1, registros: 0, totalDeRegistros: 0, ajustes: [],
      });

    const res = await executarAjusteOmieDual({ ...argsBase, opId: 'op-mid', verificarAntes: true });

    // ACXE foi recuperado da listagem, Q2P teve que chamar Incluir
    expect(incluirSpy).toHaveBeenCalledTimes(1);
    expect(incluirSpy).toHaveBeenCalledWith('q2p', expect.any(Object));
    expect(res.idACXE.idMovest).toBe('M-EXIST');
  });
});

describe('transferirDiferencaAcxe — idempotency marker', () => {
  beforeEach(() => {
    incluirSpy.mockReset();
    listarSpy.mockReset();
    incluirSpy.mockResolvedValue({ idMovest: 'M', idAjuste: 'A', descricaoStatus: 'ok' });
  });

  it('passa cod_int_ajuste com sufixo acxe-faltando', async () => {
    await transferirDiferencaAcxe({
      opId: 'op-falt',
      codigoLocalEstoqueOrigem: '999',
      codigoLocalEstoqueDiferenca: '4506855468',
      codigoProdutoAcxe: 1001,
      quantidadeKg: 500,
      valorUnitarioAcxe: 1.25,
      notaFiscal: '12345',
      observacaoSufixo: 'divergencia faltando',
    });

    expect(incluirSpy).toHaveBeenCalledWith('acxe', expect.objectContaining({
      codIntAjuste: 'op-falt:acxe-faltando',
      codigoLocalEstoqueDestino: '4506855468',
    }));
  });
});
