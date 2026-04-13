import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { determinarStatus } from '../services/bucket.service.js';

describe('Bucket Status', () => {
  it('returns sub_hedged when cobertura < 60%', () => {
    expect(determinarStatus(0)).toBe('sub_hedged');
    expect(determinarStatus(30)).toBe('sub_hedged');
    expect(determinarStatus(59.99)).toBe('sub_hedged');
  });

  it('returns ok when cobertura between 60% and 100%', () => {
    expect(determinarStatus(60)).toBe('ok');
    expect(determinarStatus(72.5)).toBe('ok');
    expect(determinarStatus(100)).toBe('ok');
  });

  it('returns over_hedged when cobertura > 100%', () => {
    expect(determinarStatus(100.01)).toBe('over_hedged');
    expect(determinarStatus(150)).toBe('over_hedged');
  });
});

// GAP-01: Proportional distribution of est_nao_pago_usd
function distribuirEstNaoPago(
  bucketsPagarUsd: number[],
  estNaoPagoTotal: number,
): { parcela: number; exposicao: number }[] {
  const total = bucketsPagarUsd.reduce((s, v) => s + v, 0);
  return bucketsPagarUsd.map((pagar) => {
    const parcela = total === 0 ? 0 : new Decimal(estNaoPagoTotal).times(pagar).div(total).toDecimalPlaces(2).toNumber();
    return { parcela, exposicao: parseFloat((pagar + parcela).toFixed(2)) };
  });
}

describe('Est Nao Pago Distribution (GAP-01)', () => {
  it('distributes proportionally to pagar_usd', () => {
    const result = distribuirEstNaoPago([500000, 300000, 200000], 100000);

    expect(result[0]!.parcela).toBe(50000);
    expect(result[1]!.parcela).toBe(30000);
    expect(result[2]!.parcela).toBe(20000);

    // Sum of parcels equals total
    const totalParcelas = result.reduce((s, r) => s + r.parcela, 0);
    expect(totalParcelas).toBe(100000);
  });

  it('exposicao = pagar + parcela', () => {
    const result = distribuirEstNaoPago([500000, 300000, 200000], 100000);

    expect(result[0]!.exposicao).toBe(550000);
    expect(result[1]!.exposicao).toBe(330000);
    expect(result[2]!.exposicao).toBe(220000);
  });

  it('returns zero parcels when est_nao_pago is 0', () => {
    const result = distribuirEstNaoPago([500000, 300000], 0);

    expect(result[0]!.parcela).toBe(0);
    expect(result[1]!.parcela).toBe(0);
    expect(result[0]!.exposicao).toBe(500000);
  });

  it('handles single bucket', () => {
    const result = distribuirEstNaoPago([1000000], 200000);

    expect(result[0]!.parcela).toBe(200000);
    expect(result[0]!.exposicao).toBe(1200000);
  });

  it('handles empty buckets', () => {
    const result = distribuirEstNaoPago([], 100000);
    expect(result).toHaveLength(0);
  });

  it('handles all buckets with pagar_usd=0', () => {
    const result = distribuirEstNaoPago([0, 0, 0], 100000);
    for (const r of result) {
      expect(r.parcela).toBe(0);
      expect(r.exposicao).toBe(0);
    }
  });
});
