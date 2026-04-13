import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @atlas/core before importing the service
vi.mock('@atlas/core', () => ({
  getPool: vi.fn(),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import { getPool } from '@atlas/core';
import { getFamilias } from '../services/familia.service.js';

const mockQuery = vi.fn();
(getPool as ReturnType<typeof vi.fn>).mockReturnValue({ query: mockQuery });

beforeEach(() => {
  mockQuery.mockReset();
});

describe('getFamilias', () => {
  const baseRows = [
    { codigo: 'SKU-001', descricao: 'Prod A 10kg', descricao_familia: 'FAMILIA_A', local_descricao: 'CD01', nsaldo: 5000, reservado: 500, npendente: 1000, ncmc: 12.5, lead_time: 45, marca: 'IMPACXE' },
    { codigo: 'SKU-002', descricao: 'Prod A 25kg', descricao_familia: 'FAMILIA_A', local_descricao: 'CD01', nsaldo: 3000, reservado: 0, npendente: 0, ncmc: 11.0, lead_time: 60, marca: 'IMPACXE' },
    { codigo: 'SKU-003', descricao: 'Prod B 10kg', descricao_familia: 'FAMILIA_B', local_descricao: 'CD01', nsaldo: 2000, reservado: 200, npendente: 500, ncmc: 8.0, lead_time: 30, marca: 'OUTRA' },
  ];

  it('groups SKUs into families by descricao_familia', async () => {
    mockQuery.mockResolvedValue({ rows: baseRows });
    const familias = await getFamilias();

    expect(familias).toHaveLength(2);
    const famA = familias.find((f) => f.familia_id === 'FAMILIA_A');
    const famB = familias.find((f) => f.familia_id === 'FAMILIA_B');
    expect(famA).toBeDefined();
    expect(famB).toBeDefined();
    expect(famA!.skus).toHaveLength(2);
    expect(famB!.skus).toHaveLength(1);
  });

  it('calculates disponivel = nsaldo - reservado (min 0)', async () => {
    mockQuery.mockResolvedValue({ rows: baseRows });
    const familias = await getFamilias();
    const famA = familias.find((f) => f.familia_id === 'FAMILIA_A')!;

    // SKU-001: 5000 - 500 = 4500
    const sku1 = famA.skus.find((s) => s.codigo === 'SKU-001')!;
    expect(sku1.disponivel).toBe(4500);
    expect(sku1.bloqueado).toBe(500);
    expect(sku1.transito).toBe(1000);
  });

  it('aggregates pool totals across SKUs in same family', async () => {
    mockQuery.mockResolvedValue({ rows: baseRows });
    const familias = await getFamilias();
    const famA = familias.find((f) => f.familia_id === 'FAMILIA_A')!;

    // SKU-001: disp=4500, bloq=500, trans=1000, total=6000
    // SKU-002: disp=3000, bloq=0, trans=0, total=3000
    expect(famA.pool_disponivel).toBe(7500);
    expect(famA.pool_bloqueado).toBe(500);
    expect(famA.pool_transito).toBe(1000);
    expect(famA.pool_total).toBe(9000);
  });

  it('calculates weighted CMC medio by total', async () => {
    mockQuery.mockResolvedValue({ rows: baseRows });
    const familias = await getFamilias();
    const famA = familias.find((f) => f.familia_id === 'FAMILIA_A')!;

    // SKU-001 total=6000 cmc=12.5, SKU-002 total=3000 cmc=11.0
    // weighted = (6000*12.5 + 3000*11.0) / 9000 = (75000+33000)/9000 = 12.0
    expect(famA.cmc_medio).toBe(12.0);
  });

  it('detects is_internacional from marca IMPACXE', async () => {
    mockQuery.mockResolvedValue({ rows: baseRows });
    const familias = await getFamilias();

    const famA = familias.find((f) => f.familia_id === 'FAMILIA_A')!;
    const famB = familias.find((f) => f.familia_id === 'FAMILIA_B')!;
    expect(famA.is_internacional).toBe(true);
    expect(famB.is_internacional).toBe(false);
  });

  it('uses minimum lead_time as lt_efetivo', async () => {
    mockQuery.mockResolvedValue({ rows: baseRows });
    const familias = await getFamilias();
    const famA = familias.find((f) => f.familia_id === 'FAMILIA_A')!;

    // SKU-001: 45d, SKU-002: 60d → min = 45
    expect(famA.lt_efetivo).toBe(45);
  });

  it('defaults lead_time to 60 when null', async () => {
    mockQuery.mockResolvedValue({ rows: [
      { ...baseRows[0], lead_time: null, descricao_familia: 'SOLO' },
    ] });
    const familias = await getFamilias();
    expect(familias[0]!.lt_efetivo).toBe(60);
  });

  it('sorts families by pool_total descending', async () => {
    mockQuery.mockResolvedValue({ rows: baseRows });
    const familias = await getFamilias();

    // FAMILIA_A total=9000, FAMILIA_B total=2300
    expect(familias[0]!.familia_id).toBe('FAMILIA_A');
    expect(familias[1]!.familia_id).toBe('FAMILIA_B');
  });

  it('returns empty array when no rows', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const familias = await getFamilias();
    expect(familias).toHaveLength(0);
  });
});
