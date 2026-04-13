import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @atlas/core and @atlas/db before importing the service
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockOrderBy = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();

const mockDb = {
  select: () => ({ from: mockFrom }),
  update: () => ({ set: mockSet }),
  insert: () => ({ values: mockValues }),
};

vi.mock('@atlas/core', () => ({
  getDb: () => mockDb,
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@atlas/db', () => ({
  configSazonalidade: { familiaId: 'familia_id', mes: 'mes', id: 'id', fatorSugerido: 'fator_sugerido', fatorUsuario: 'fator_usuario' },
  sazonalidadeLog: {},
}));

import { getSazFactors } from '../services/sazonalidade.service.js';

describe('getSazFactors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 12 month factors from 1 to 12', async () => {
    // Family-specific: empty
    const familyCall = { where: vi.fn().mockResolvedValue([]) };
    // Default: 12 rows
    const defaultRows = Array.from({ length: 12 }, (_, i) => ({
      mes: i + 1,
      fatorSugerido: '1.00',
      fatorUsuario: null,
    }));
    const defaultCall = { where: vi.fn().mockResolvedValue(defaultRows) };

    mockFrom.mockReturnValueOnce(familyCall).mockReturnValueOnce(defaultCall);

    const factors = await getSazFactors('FAM_TEST');
    expect(factors.size).toBe(12);
    for (let m = 1; m <= 12; m++) {
      expect(factors.has(m)).toBe(true);
    }
  });

  it('uses fator_usuario over fator_sugerido when present', async () => {
    const familyRows = [{ mes: 6, fatorSugerido: '1.00', fatorUsuario: '1.25' }];
    const familyCall = { where: vi.fn().mockResolvedValue(familyRows) };

    const defaultRows = Array.from({ length: 12 }, (_, i) => ({
      mes: i + 1,
      fatorSugerido: '1.00',
      fatorUsuario: null,
    }));
    const defaultCall = { where: vi.fn().mockResolvedValue(defaultRows) };

    mockFrom.mockReturnValueOnce(familyCall).mockReturnValueOnce(defaultCall);

    const factors = await getSazFactors('FAM_CUSTOM');
    expect(factors.get(6)).toBe(1.25);
    // Other months should be 1.0 (from default)
    expect(factors.get(1)).toBe(1.0);
  });

  it('falls back to _DEFAULT when family has no specific entries', async () => {
    const familyCall = { where: vi.fn().mockResolvedValue([]) };
    const defaultRows = [
      { mes: 1, fatorSugerido: '0.88', fatorUsuario: null },
      { mes: 7, fatorSugerido: '1.08', fatorUsuario: null },
    ];
    const defaultCall = { where: vi.fn().mockResolvedValue(defaultRows) };

    mockFrom.mockReturnValueOnce(familyCall).mockReturnValueOnce(defaultCall);

    const factors = await getSazFactors('FAM_NO_OVERRIDE');
    expect(factors.get(1)).toBe(0.88);
    expect(factors.get(7)).toBe(1.08);
  });

  it('defaults to 1.0 when neither family nor _DEFAULT has a month', async () => {
    const familyCall = { where: vi.fn().mockResolvedValue([]) };
    // Only month 1 in default
    const defaultCall = { where: vi.fn().mockResolvedValue([
      { mes: 1, fatorSugerido: '0.90', fatorUsuario: null },
    ]) };

    mockFrom.mockReturnValueOnce(familyCall).mockReturnValueOnce(defaultCall);

    const factors = await getSazFactors('FAM_SPARSE');
    expect(factors.get(1)).toBe(0.90);
    // Months without entries default to 1.0
    expect(factors.get(5)).toBe(1.0);
    expect(factors.get(12)).toBe(1.0);
  });

  it('family-specific override takes precedence over _DEFAULT', async () => {
    const familyRows = [{ mes: 3, fatorSugerido: '0.96', fatorUsuario: '1.50' }];
    const familyCall = { where: vi.fn().mockResolvedValue(familyRows) };

    const defaultRows = [{ mes: 3, fatorSugerido: '0.96', fatorUsuario: null }];
    const defaultCall = { where: vi.fn().mockResolvedValue(defaultRows) };

    mockFrom.mockReturnValueOnce(familyCall).mockReturnValueOnce(defaultCall);

    const factors = await getSazFactors('FAM_PRIORITY');
    // Family has user override 1.50, should use it instead of default's 0.96
    expect(factors.get(3)).toBe(1.50);
  });
});
