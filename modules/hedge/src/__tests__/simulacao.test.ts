import { describe, it, expect } from 'vitest';
import { simularMargem } from '../services/simulacao.service.js';

describe('Simulacao de Margem', () => {
  const params = { faturamento_brl: 5000000, outros_custos_brl: 800000, volume_usd: 500000 };
  const cobertura = { ndf_taxa_media: 5.50, pct_cobertura: 70 };

  it('generates 13 scenarios from 4.50 to 7.50', () => {
    const cenarios = simularMargem(params, cobertura);
    expect(cenarios).toHaveLength(13);
    expect(cenarios[0]!.cambio).toBe(4.50);
    expect(cenarios[12]!.cambio).toBe(7.50);
  });

  it('custo_sem_hedge = volume * cambio', () => {
    const cenarios = simularMargem(params, cobertura);
    const c = cenarios[0]!; // cambio 4.50
    expect(c.custo_sem_hedge).toBe(500000 * 4.50);
  });

  it('custo_com_hedge < custo_sem_hedge when cambio > ndf_taxa', () => {
    const cenarios = simularMargem(params, cobertura);
    // At cambio 6.50 (above ndf_taxa 5.50), hedge should reduce cost
    const c = cenarios.find((c) => c.cambio === 6.50)!;
    expect(c.custo_com_hedge).toBeLessThan(c.custo_sem_hedge);
  });

  it('margem decreases as cambio increases', () => {
    const cenarios = simularMargem(params, cobertura);
    const first = cenarios[0]!.margem_pct;
    const last = cenarios[12]!.margem_pct;
    expect(first).toBeGreaterThan(last);
  });

  it('uses decimal arithmetic (no float precision issues)', () => {
    const cenarios = simularMargem(params, cobertura);
    for (const c of cenarios) {
      // Step should be exact 0.25 increments
      expect(c.cambio * 100 % 25).toBe(0);
    }
  });
});
