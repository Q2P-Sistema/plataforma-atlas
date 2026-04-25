import { describe, it, expect } from 'vitest';
import { calcularCMP, calcularExposicaoCambial } from '../services/metricas.service.js';

describe('metricas#calcularCMP', () => {
  it('retorna media ponderada de custo USD/tonelada (quantidade em kg)', () => {
    // Internamente converte kg → ton para manter CMP em USD/ton
    const lotes = [
      { quantidadeFisicaKg: 10_000, custoBrlKg: 1000 }, // 10t × 1000 = 10000 USD
      { quantidadeFisicaKg: 20_000, custoBrlKg: 1200 }, // 20t × 1200 = 24000 USD
    ];
    // Total: 30t e 34000 USD → 1133.33 USD/t
    expect(calcularCMP(lotes)).toBeCloseTo(1133.33, 1);
  });

  it('ignora lotes sem custo ou quantidade zero', () => {
    const lotes = [
      { quantidadeFisicaKg: 10_000, custoBrlKg: 1000 },
      { quantidadeFisicaKg: 5000, custoBrlKg: null },
      { quantidadeFisicaKg: 0, custoBrlKg: 500 },
    ];
    // Apenas o primeiro conta: 10000 USD / 10t = 1000 USD/t
    expect(calcularCMP(lotes)).toBe(1000);
  });

  it('retorna 0 quando nao ha lotes validos', () => {
    expect(calcularCMP([])).toBe(0);
    expect(calcularCMP([{ quantidadeFisicaKg: 10_000, custoBrlKg: null }])).toBe(0);
  });
});

describe('metricas#calcularExposicaoCambial', () => {
  it('soma apenas lotes em transito_intl com custo USD (retorna USD)', () => {
    const lotes = [
      { estagioTransito: 'transito_intl', quantidadeFisicaKg: 10_000, custoBrlKg: 1000, ativo: true },
      { estagioTransito: 'porto_dta', quantidadeFisicaKg: 5000, custoBrlKg: 1000, ativo: true },
      { estagioTransito: null, quantidadeFisicaKg: 20_000, custoBrlKg: 1000, ativo: true },
    ];
    // Apenas o primeiro conta: 10t × 1000 USD/t = 10000 USD
    expect(calcularExposicaoCambial(lotes)).toBe(10_000);
  });

  it('ignora lotes inativos', () => {
    const lotes = [
      { estagioTransito: 'transito_intl', quantidadeFisicaKg: 10_000, custoBrlKg: 1000, ativo: false },
      { estagioTransito: 'transito_intl', quantidadeFisicaKg: 5000, custoBrlKg: 1000, ativo: true },
    ];
    // 5t × 1000 = 5000 USD
    expect(calcularExposicaoCambial(lotes)).toBe(5000);
  });

  it('retorna 0 quando nao ha lotes em transito_intl', () => {
    const lotes = [
      { estagioTransito: null, quantidadeFisicaKg: 10_000, custoBrlKg: 1000, ativo: true },
      { estagioTransito: 'transito_interno', quantidadeFisicaKg: 5000, custoBrlKg: 1000, ativo: true },
    ];
    expect(calcularExposicaoCambial(lotes)).toBe(0);
  });
});
