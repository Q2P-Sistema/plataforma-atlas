import { describe, it, expect, vi, beforeEach } from 'vitest';

// MOD-10 (ACXEGDP-279): a sazonalidade inteira é carregada em 1 query
// (getSazFactorsTodas) e resolvida por família via fatoresEfetivos — antes eram
// 2 SELECTs POR família (o _DEFAULT re-buscado N×) dentro do loop do forecast.
// Semântica preservada: override de família > _DEFAULT > 1.0.

const mockFrom = vi.fn();

const mockDb = {
  select: () => ({ from: mockFrom }),
};

vi.mock('@atlas/core', () => ({
  getDb: () => mockDb,
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@atlas/db', () => ({
  configSazonalidade: { familiaId: 'familia_id', mes: 'mes', id: 'id', fatorSugerido: 'fator_sugerido', fatorUsuario: 'fator_usuario' },
  sazonalidadeLog: {},
}));

import { getSazFactors, getSazFactorsTodas, fatoresEfetivos } from '../services/sazonalidade.service.js';

interface Row {
  familiaId: string;
  mes: number;
  fatorSugerido: string;
  fatorUsuario: string | null;
}

function comRows(rows: Row[]): void {
  mockFrom.mockReturnValueOnce(Promise.resolve(rows));
}

function defaultRows12(): Row[] {
  return Array.from({ length: 12 }, (_, i) => ({
    familiaId: '_DEFAULT',
    mes: i + 1,
    fatorSugerido: '1.00',
    fatorUsuario: null,
  }));
}

describe('getSazFactors (via mapa único)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 12 month factors from 1 to 12', async () => {
    comRows(defaultRows12());
    const factors = await getSazFactors('FAM_TEST');
    expect(factors.size).toBe(12);
    for (let m = 1; m <= 12; m++) {
      expect(factors.has(m)).toBe(true);
    }
  });

  it('uses fator_usuario over fator_sugerido when present', async () => {
    comRows([
      ...defaultRows12(),
      { familiaId: 'FAM_CUSTOM', mes: 6, fatorSugerido: '1.00', fatorUsuario: '1.25' },
    ]);
    const factors = await getSazFactors('FAM_CUSTOM');
    expect(factors.get(6)).toBe(1.25);
    // Other months should be 1.0 (from default)
    expect(factors.get(1)).toBe(1.0);
  });

  it('falls back to _DEFAULT when family has no specific entries', async () => {
    comRows([
      { familiaId: '_DEFAULT', mes: 1, fatorSugerido: '0.88', fatorUsuario: null },
      { familiaId: '_DEFAULT', mes: 7, fatorSugerido: '1.08', fatorUsuario: null },
    ]);
    const factors = await getSazFactors('FAM_NO_OVERRIDE');
    expect(factors.get(1)).toBe(0.88);
    expect(factors.get(7)).toBe(1.08);
  });

  it('defaults to 1.0 when neither family nor _DEFAULT has a month', async () => {
    comRows([{ familiaId: '_DEFAULT', mes: 1, fatorSugerido: '0.90', fatorUsuario: null }]);
    const factors = await getSazFactors('FAM_SPARSE');
    expect(factors.get(1)).toBe(0.90);
    // Months without entries default to 1.0
    expect(factors.get(5)).toBe(1.0);
    expect(factors.get(12)).toBe(1.0);
  });

  it('family-specific override takes precedence over _DEFAULT', async () => {
    comRows([
      { familiaId: '_DEFAULT', mes: 3, fatorSugerido: '0.96', fatorUsuario: null },
      { familiaId: 'FAM_PRIORITY', mes: 3, fatorSugerido: '0.96', fatorUsuario: '1.50' },
    ]);
    const factors = await getSazFactors('FAM_PRIORITY');
    // Family has user override 1.50, should use it instead of default's 0.96
    expect(factors.get(3)).toBe(1.50);
  });
});

describe('getSazFactorsTodas + fatoresEfetivos (MOD-10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carrega TODAS as famílias em uma única query (from chamado 1x)', async () => {
    comRows([
      ...defaultRows12(),
      { familiaId: 'FAM_A', mes: 2, fatorSugerido: '1.10', fatorUsuario: null },
      { familiaId: 'FAM_B', mes: 2, fatorSugerido: '0.80', fatorUsuario: null },
    ]);
    const mapa = await getSazFactorsTodas();
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mapa.has('_DEFAULT')).toBe(true);

    // o MESMO mapa resolve N famílias sem novas queries
    expect(fatoresEfetivos('FAM_A', mapa).get(2)).toBe(1.1);
    expect(fatoresEfetivos('FAM_B', mapa).get(2)).toBe(0.8);
    expect(fatoresEfetivos('FAM_INEXISTENTE', mapa).get(2)).toBe(1.0);
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
});
