import { describe, it, expect } from 'vitest';
import { calcularCMP, calcularExposicaoCambial } from '../services/metricas.service.js';

describe('metricas#calcularCMP', () => {
  it('retorna media ponderada de custo BRL/kg (quantidade em kg)', () => {
    const lotes = [
      { quantidadeFisicaKg: 10_000, custoBrlKg: 5 }, // 10_000 × 5 = 50_000 BRL
      { quantidadeFisicaKg: 20_000, custoBrlKg: 6 }, // 20_000 × 6 = 120_000 BRL
    ];
    // Total: 30_000 kg e 170_000 BRL → 5.6667 BRL/kg
    expect(calcularCMP(lotes)).toBeCloseTo(5.6667, 3);
  });

  it('ignora lotes sem custo ou quantidade zero', () => {
    const lotes = [
      { quantidadeFisicaKg: 10_000, custoBrlKg: 5 },
      { quantidadeFisicaKg: 5000,   custoBrlKg: null },
      { quantidadeFisicaKg: 0,      custoBrlKg: 7 },
    ];
    // Apenas o primeiro: 50_000 BRL / 10_000 kg = 5 BRL/kg
    expect(calcularCMP(lotes)).toBe(5);
  });

  it('retorna 0 quando nao ha lotes validos', () => {
    expect(calcularCMP([])).toBe(0);
    expect(calcularCMP([{ quantidadeFisicaKg: 10_000, custoBrlKg: null }])).toBe(0);
  });
});

describe('metricas#calcularExposicaoCambial', () => {
  it('soma apenas lotes em transito_intl, retorna BRL (kg × BRL/kg)', () => {
    const lotes = [
      { estagioTransito: 'transito_intl', quantidadeFisicaKg: 10_000, custoBrlKg: 6, ativo: true },
      { estagioTransito: 'porto_dta',     quantidadeFisicaKg: 5000,   custoBrlKg: 6, ativo: true },
      { estagioTransito: null,            quantidadeFisicaKg: 20_000, custoBrlKg: 6, ativo: true },
    ];
    // Apenas o primeiro conta: 10_000 kg × 6 BRL/kg = 60_000 BRL
    expect(calcularExposicaoCambial(lotes)).toBe(60_000);
  });

  it('ignora lotes inativos', () => {
    const lotes = [
      { estagioTransito: 'transito_intl', quantidadeFisicaKg: 10_000, custoBrlKg: 6, ativo: false },
      { estagioTransito: 'transito_intl', quantidadeFisicaKg: 5000,   custoBrlKg: 6, ativo: true },
    ];
    // 5000 × 6 = 30_000 BRL
    expect(calcularExposicaoCambial(lotes)).toBe(30_000);
  });

  it('retorna 0 quando nao ha lotes em transito_intl', () => {
    const lotes = [
      { estagioTransito: null,               quantidadeFisicaKg: 10_000, custoBrlKg: 6, ativo: true },
      { estagioTransito: 'transito_interno', quantidadeFisicaKg: 5000,   custoBrlKg: 6, ativo: true },
    ];
    expect(calcularExposicaoCambial(lotes)).toBe(0);
  });
});
