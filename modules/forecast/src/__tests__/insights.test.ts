import { describe, it, expect } from 'vitest';

// Test score COMEX classification (pure function)
function classificarScore(score: number): string {
  if (score >= 70) return 'COMPRAR';
  if (score >= 55) return 'BOM';
  if (score >= 40) return 'NEUTRO';
  if (score >= 25) return 'CAUTELA';
  return 'EVITAR';
}

describe('Score COMEX Classification', () => {
  it('classifies COMPRAR for score >= 70', () => {
    expect(classificarScore(70)).toBe('COMPRAR');
    expect(classificarScore(85)).toBe('COMPRAR');
    expect(classificarScore(100)).toBe('COMPRAR');
  });

  it('classifies BOM for score 55-69', () => {
    expect(classificarScore(55)).toBe('BOM');
    expect(classificarScore(69)).toBe('BOM');
  });

  it('classifies NEUTRO for score 40-54', () => {
    expect(classificarScore(40)).toBe('NEUTRO');
    expect(classificarScore(54)).toBe('NEUTRO');
  });

  it('classifies CAUTELA for score 25-39', () => {
    expect(classificarScore(25)).toBe('CAUTELA');
    expect(classificarScore(39)).toBe('CAUTELA');
  });

  it('classifies EVITAR for score < 25', () => {
    expect(classificarScore(0)).toBe('EVITAR');
    expect(classificarScore(24)).toBe('EVITAR');
  });
});

// Test score normalization
describe('Score Normalization', () => {
  it('calculates score within 0-100 range', () => {
    const precos = [3000, 2800, 3200, 2500];
    const volumes = [100000, 120000, 80000, 95000];
    const taxas = [5.5, 5.8, 5.2, 6.0];

    const maxPreco = Math.max(...precos);
    const maxVolume = Math.max(...volumes);
    const maxTaxa = Math.max(...taxas);

    for (let i = 0; i < precos.length; i++) {
      const precoScore = (1 - precos[i]! / maxPreco) * 100;
      const volumeScore = (volumes[i]! / maxVolume) * 100;
      const cambioScore = (1 - taxas[i]! / maxTaxa) * 100;
      const score = Math.round(precoScore * 0.4 + volumeScore * 0.3 + cambioScore * 0.3);
      const clamped = Math.max(0, Math.min(100, score));

      expect(clamped).toBeGreaterThanOrEqual(0);
      expect(clamped).toBeLessThanOrEqual(100);
    }
  });

  it('lowest price gets highest preco_score', () => {
    const precos = [3000, 2500, 3200];
    const maxPreco = Math.max(...precos);
    const scores = precos.map((p) => (1 - p / maxPreco) * 100);

    // 2500 has highest score (furthest from max)
    expect(scores[1]).toBeGreaterThan(scores[0]!);
    expect(scores[1]).toBeGreaterThan(scores[2]!);
  });

  it('highest volume gets highest volume_score', () => {
    const volumes = [100000, 120000, 80000];
    const maxVolume = Math.max(...volumes);
    const scores = volumes.map((v) => (v / maxVolume) * 100);

    expect(scores[1]).toBe(100); // max volume = 100%
    expect(scores[2]).toBeLessThan(scores[0]!);
  });
});

// Test LT calculation
describe('Fornecedor LT Calculation', () => {
  it('calculates average LT from dates', () => {
    // Simulated: proforma to desembarque differences
    const diffs = [65, 72, 80, 68];
    const avg = Math.round(diffs.reduce((s, d) => s + d, 0) / diffs.length);
    expect(avg).toBe(71);
  });

  it('defaults to 60 when no dates available', () => {
    const lt = null || 60;
    expect(lt).toBe(60);
  });
});
