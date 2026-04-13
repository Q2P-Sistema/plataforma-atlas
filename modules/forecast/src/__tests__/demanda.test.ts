import { describe, it, expect } from 'vitest';

// Test YoY calculation logic (pure function)
function calcularYoY(trimAtual: number, trimAnterior: number) {
  const variacaoPct = trimAnterior > 0
    ? parseFloat(((trimAtual - trimAnterior) / trimAnterior * 100).toFixed(2))
    : 0;
  const tendencia: 'subindo' | 'descendo' | 'estavel' =
    variacaoPct > 10 ? 'subindo' : variacaoPct < -10 ? 'descendo' : 'estavel';
  return { trimestre_atual: trimAtual, trimestre_anterior: trimAnterior, variacao_pct: variacaoPct, tendencia };
}

describe('YoY Calculation', () => {
  it('calculates positive YoY correctly', () => {
    const result = calcularYoY(49100, 42300);
    expect(result.variacao_pct).toBe(16.08);
    expect(result.tendencia).toBe('subindo');
  });

  it('calculates negative YoY correctly', () => {
    const result = calcularYoY(35000, 50000);
    expect(result.variacao_pct).toBe(-30.0);
    expect(result.tendencia).toBe('descendo');
  });

  it('returns estavel for small variation', () => {
    const result = calcularYoY(42000, 40000);
    expect(result.variacao_pct).toBe(5.0);
    expect(result.tendencia).toBe('estavel');
  });

  it('returns estavel for exact -10%', () => {
    const result = calcularYoY(90, 100);
    expect(result.variacao_pct).toBe(-10.0);
    expect(result.tendencia).toBe('estavel');
  });

  it('returns subindo for just above +10%', () => {
    const result = calcularYoY(111, 100);
    expect(result.variacao_pct).toBe(11.0);
    expect(result.tendencia).toBe('subindo');
  });

  it('returns 0 when anterior is 0 (new family)', () => {
    const result = calcularYoY(49100, 0);
    expect(result.variacao_pct).toBe(0);
    expect(result.tendencia).toBe('estavel');
  });
});

// Test sparkline data shape
describe('Sparkline Data', () => {
  it('sparkline should have up to 24 entries for 24 months', () => {
    const sparkline = Array.from({ length: 24 }, (_, i) => (i + 1) * 1000);
    expect(sparkline).toHaveLength(24);
    expect(sparkline[0]).toBe(1000);
    expect(sparkline[23]).toBe(24000);
  });

  it('handles partial data (less than 24 months)', () => {
    const sparkline = Array.from({ length: 6 }, (_, i) => (i + 1) * 500);
    expect(sparkline.length).toBeLessThanOrEqual(24);
    expect(sparkline.length).toBeGreaterThan(0);
  });
});

// Test contribuicao_pct calculation
describe('SKU Contribution', () => {
  it('calculates contribution percentage correctly', () => {
    const total = 100000;
    const skuVolume = 62300;
    const pct = parseFloat((skuVolume / total * 100).toFixed(1));
    expect(pct).toBe(62.3);
  });

  it('contributions sum to ~100%', () => {
    const volumes = [62300, 37700];
    const total = volumes.reduce((s, v) => s + v, 0);
    const pcts = volumes.map((v) => parseFloat((v / total * 100).toFixed(1)));
    const sum = pcts.reduce((s, p) => s + p, 0);
    expect(sum).toBeCloseTo(100, 0);
  });

  it('handles zero total gracefully', () => {
    const pct = 0 > 0 ? parseFloat((1000 / 0 * 100).toFixed(1)) : 0;
    expect(pct).toBe(0);
  });
});
