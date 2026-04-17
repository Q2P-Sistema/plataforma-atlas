import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isSubtipoSaidaManual,
  registrarSaidaManual,
  LoteInvalidoError,
} from '../services/saida-manual.service.js';
import { NIVEL_APROVACAO_POR_SUBTIPO } from '../types.js';

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  getDb: vi.fn(),
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@atlas/db', () => ({
  lote: {
    id: {}, ativo: {}, status: {}, codigo: {}, quantidadeFisica: {},
    fornecedorNome: {}, updatedAt: {},
  },
  movimentacao: {},
  aprovacao: {},
  divergencia: {},
}));

function mockLote(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'lote-1',
    codigo: 'L001',
    quantidadeFisica: 50,
    status: 'reconciliado',
    fornecedorNome: 'Sinopec',
    ativo: true,
    ...overrides,
  };
}

function criarDbMock(loteData: Record<string, unknown> | null) {
  const tx = {
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'nova-id', codigo: 'L001' }]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(loteData ? [loteData] : []) }),
      }),
    }),
    transaction: async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx),
  };
}

describe('saida-manual#isSubtipoSaidaManual', () => {
  it('aceita os 6 subtipos validos', () => {
    const validos = ['transf_intra_cnpj', 'comodato', 'amostra', 'descarte', 'quebra', 'inventario_menos'];
    for (const s of validos) {
      expect(isSubtipoSaidaManual(s)).toBe(true);
    }
  });

  it('rejeita subtipos de entrada ou invalidos', () => {
    expect(isSubtipoSaidaManual('importacao')).toBe(false);
    expect(isSubtipoSaidaManual('venda')).toBe(false);
    expect(isSubtipoSaidaManual('regularizacao_fiscal')).toBe(false);
    expect(isSubtipoSaidaManual('inexistente')).toBe(false);
  });
});

describe('NIVEL_APROVACAO_POR_SUBTIPO — regras de autoridade', () => {
  it('comodato exige diretor', () => {
    expect(NIVEL_APROVACAO_POR_SUBTIPO.comodato).toBe('diretor');
  });

  it('saidas normais exigem gestor', () => {
    expect(NIVEL_APROVACAO_POR_SUBTIPO.transf_intra_cnpj).toBe('gestor');
    expect(NIVEL_APROVACAO_POR_SUBTIPO.amostra).toBe('gestor');
    expect(NIVEL_APROVACAO_POR_SUBTIPO.descarte).toBe('gestor');
    expect(NIVEL_APROVACAO_POR_SUBTIPO.quebra).toBe('gestor');
    expect(NIVEL_APROVACAO_POR_SUBTIPO.inventario_menos).toBe('gestor');
  });
});

describe('saida-manual#registrarSaidaManual — validacoes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejeita motivo vazio', async () => {
    await expect(registrarSaidaManual({
      subtipo: 'descarte', loteId: 'lote-1', quantidadeOriginal: 1, unidade: 't',
      observacoes: '', userId: 'u1',
    })).rejects.toThrow(/motivo|obrigatorio/i);
  });

  it('rejeita motivo apenas com whitespace', async () => {
    await expect(registrarSaidaManual({
      subtipo: 'descarte', loteId: 'lote-1', quantidadeOriginal: 1, unidade: 't',
      observacoes: '   ', userId: 'u1',
    })).rejects.toThrow(/motivo|obrigatorio/i);
  });

  it('lanca LoteInvalidoError quando lote nao existe', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(criarDbMock(null) as never);

    await expect(registrarSaidaManual({
      subtipo: 'descarte', loteId: 'inexistente', quantidadeOriginal: 1, unidade: 't',
      observacoes: 'teste', userId: 'u1',
    })).rejects.toThrow(LoteInvalidoError);
  });

  it('rejeita lote em status transito ou rejeitado', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(criarDbMock(mockLote({ status: 'transito' })) as never);

    await expect(registrarSaidaManual({
      subtipo: 'descarte', loteId: 'lote-1', quantidadeOriginal: 1, unidade: 't',
      observacoes: 'teste', userId: 'u1',
    })).rejects.toThrow(/reconciliados\/provisorios/);
  });

  it('rejeita quantidade maior que saldo fisico', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(criarDbMock(mockLote({ quantidadeFisica: 10 })) as never);

    await expect(registrarSaidaManual({
      subtipo: 'descarte', loteId: 'lote-1', quantidadeOriginal: 15, unidade: 't',
      observacoes: 'teste', userId: 'u1',
    })).rejects.toThrow(/excede saldo fisico/);
  });

  it('aceita conversao de unidade no calculo de saldo (kg → t)', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(criarDbMock(mockLote({ quantidadeFisica: 5 })) as never);

    // 4000 kg = 4 t < 5 t saldo OK
    await expect(registrarSaidaManual({
      subtipo: 'descarte', loteId: 'lote-1', quantidadeOriginal: 4000, unidade: 'kg',
      observacoes: 'teste', userId: 'u1',
    })).resolves.toBeDefined();
  });

  it('6000 kg (6t) em lote com 5t fisico rejeita', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(criarDbMock(mockLote({ quantidadeFisica: 5 })) as never);

    await expect(registrarSaidaManual({
      subtipo: 'descarte', loteId: 'lote-1', quantidadeOriginal: 6000, unidade: 'kg',
      observacoes: 'teste', userId: 'u1',
    })).rejects.toThrow(/excede/);
  });
});
