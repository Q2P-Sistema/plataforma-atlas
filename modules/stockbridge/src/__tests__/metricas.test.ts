import { describe, it, expect } from 'vitest';
import { calcularCMP, calcularExposicaoCambial } from '../services/metricas.service.js';

describe('metricas#calcularCMP', () => {
  it('retorna media ponderada de custo USD/t', () => {
    const lotes = [
      { quantidadeFisica: 10, custoUsd: 1000 }, // 10t × 1000 = 10000 USD
      { quantidadeFisica: 20, custoUsd: 1200 }, // 20t × 1200 = 24000 USD
    ];
    // Total: 30t e 34000 USD → 1133.33 USD/t
    expect(calcularCMP(lotes)).toBeCloseTo(1133.33, 1);
  });

  it('ignora lotes sem custo ou quantidade zero', () => {
    const lotes = [
      { quantidadeFisica: 10, custoUsd: 1000 },
      { quantidadeFisica: 5, custoUsd: null },
      { quantidadeFisica: 0, custoUsd: 500 },
    ];
    // Apenas o primeiro conta: 10 × 1000 / 10 = 1000
    expect(calcularCMP(lotes)).toBe(1000);
  });

  it('retorna 0 quando nao ha lotes validos', () => {
    expect(calcularCMP([])).toBe(0);
    expect(calcularCMP([{ quantidadeFisica: 10, custoUsd: null }])).toBe(0);
  });
});

describe('metricas#calcularExposicaoCambial', () => {
  it('soma apenas lotes em transito_intl com custo USD', () => {
    const lotes = [
      { estagioTransito: 'transito_intl', quantidadeFisica: 10, custoUsd: 1000, ativo: true },
      { estagioTransito: 'porto_dta', quantidadeFisica: 5, custoUsd: 1000, ativo: true },
      { estagioTransito: null, quantidadeFisica: 20, custoUsd: 1000, ativo: true },
    ];
    // Apenas o primeiro conta: 10 × 1000 = 10000 USD
    expect(calcularExposicaoCambial(lotes)).toBe(10000);
  });

  it('ignora lotes inativos', () => {
    const lotes = [
      { estagioTransito: 'transito_intl', quantidadeFisica: 10, custoUsd: 1000, ativo: false },
      { estagioTransito: 'transito_intl', quantidadeFisica: 5, custoUsd: 1000, ativo: true },
    ];
    expect(calcularExposicaoCambial(lotes)).toBe(5000);
  });

  it('retorna 0 quando nao ha lotes em transito_intl', () => {
    const lotes = [
      { estagioTransito: null, quantidadeFisica: 10, custoUsd: 1000, ativo: true },
      { estagioTransito: 'transito_interno', quantidadeFisica: 5, custoUsd: 1000, ativo: true },
    ];
    expect(calcularExposicaoCambial(lotes)).toBe(0);
  });
});
