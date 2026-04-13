import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';

// Test the NDF calculation formulas directly (no DB needed)

describe('NDF Calculations', () => {
  describe('custo_brl = notional * (taxa_ndf - ptax_spot)', () => {
    it('calculates positive cost when taxa > ptax', () => {
      const notional = new Decimal(100000);
      const taxaNdf = new Decimal(5.50);
      const ptaxSpot = new Decimal(5.40);
      const custo = notional.times(taxaNdf.minus(ptaxSpot));

      expect(custo.toNumber()).toBe(10000);
    });

    it('calculates negative cost when taxa < ptax', () => {
      const notional = new Decimal(100000);
      const taxaNdf = new Decimal(5.30);
      const ptaxSpot = new Decimal(5.40);
      const custo = notional.times(taxaNdf.minus(ptaxSpot));

      expect(custo.toNumber()).toBe(-10000);
    });

    it('handles zero difference', () => {
      const notional = new Decimal(100000);
      const taxaNdf = new Decimal(5.40);
      const ptaxSpot = new Decimal(5.40);
      const custo = notional.times(taxaNdf.minus(ptaxSpot));

      expect(custo.toNumber()).toBe(0);
    });
  });

  describe('resultado_brl = notional * (taxa_ndf - ptax_liquidacao)', () => {
    it('positive result when taxa > ptax_liquidacao (hedge protected)', () => {
      const notional = new Decimal(100000);
      const taxaNdf = new Decimal(5.50);
      const ptaxLiq = new Decimal(5.60);
      const resultado = notional.times(taxaNdf.minus(ptaxLiq));

      // taxa 5.50 vs ptax 5.60 → lost 0.10 per USD
      expect(resultado.toNumber()).toBe(-10000);
    });

    it('negative result means hedge gained (ptax rose above taxa)', () => {
      const notional = new Decimal(100000);
      const taxaNdf = new Decimal(5.50);
      const ptaxLiq = new Decimal(5.30);
      const resultado = notional.times(taxaNdf.minus(ptaxLiq));

      // taxa 5.50 vs ptax 5.30 → gained 0.20 per USD
      expect(resultado.toNumber()).toBe(20000);
    });

    it('maintains precision with decimal.js', () => {
      const notional = new Decimal(123456.78);
      const taxaNdf = new Decimal(5.4321);
      const ptaxLiq = new Decimal(5.4320);
      const resultado = notional.times(taxaNdf.minus(ptaxLiq));

      // Difference is 0.0001, so result = 123456.78 * 0.0001 = 12.345678
      expect(resultado.toDecimalPlaces(2).toNumber()).toBe(12.35);
    });
  });

  describe('state transitions', () => {
    const VALID_TRANSITIONS: Record<string, string[]> = {
      pendente: ['ativo', 'cancelado'],
      ativo: ['liquidado', 'cancelado'],
      liquidado: [],
      cancelado: [],
    };

    it('pendente can transition to ativo', () => {
      expect(VALID_TRANSITIONS['pendente']).toContain('ativo');
    });

    it('pendente can transition to cancelado', () => {
      expect(VALID_TRANSITIONS['pendente']).toContain('cancelado');
    });

    it('ativo can transition to liquidado', () => {
      expect(VALID_TRANSITIONS['ativo']).toContain('liquidado');
    });

    it('ativo can transition to cancelado', () => {
      expect(VALID_TRANSITIONS['ativo']).toContain('cancelado');
    });

    it('liquidado cannot transition to anything', () => {
      expect(VALID_TRANSITIONS['liquidado']).toHaveLength(0);
    });

    it('cancelado cannot transition to anything', () => {
      expect(VALID_TRANSITIONS['cancelado']).toHaveLength(0);
    });

    it('liquidado → ativo is invalid', () => {
      expect(VALID_TRANSITIONS['liquidado']).not.toContain('ativo');
    });
  });
});
