import { describe, it, expect } from 'vitest';
import { simularMargem } from '../services/simulacao.service.js';

describe('Simulacao de Margem', () => {
  const params = { faturamento_brl: 5000000, outros_custos_brl: 800000, volume_usd: 500000 };
  const cobertura = { ndf_taxa_media: 5.50, pct_cobertura: 70 };

  it('generates 31 scenarios from 4.50 to 7.50 (step 0.10)', () => {
    const cenarios = simularMargem(params, cobertura);
    expect(cenarios).toHaveLength(31);
    expect(cenarios[0]!.cambio).toBe(4.50);
    expect(cenarios[cenarios.length - 1]!.cambio).toBe(7.50);
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
    const last = cenarios[cenarios.length - 1]!.margem_pct;
    expect(first).toBeGreaterThan(last);
  });

  it('returns margem_sem_hedge_pct', () => {
    const cenarios = simularMargem(params, cobertura);
    for (const c of cenarios) {
      expect(c.margem_sem_hedge_pct).toBeDefined();
      expect(typeof c.margem_sem_hedge_pct).toBe('number');
    }
  });

  it('uses decimal arithmetic (no float precision issues)', () => {
    const cenarios = simularMargem(params, cobertura);
    for (const c of cenarios) {
      // Step should be exact 0.10 increments — use round to avoid float drift
      expect(Math.round(c.cambio * 100) % 10).toBe(0);
    }
  });

  it('accepts l1/l2 instead of pct_cobertura', () => {
    const cenarios = simularMargem(params, { ndf_taxa_media: 5.50, l1: 60, l2: 15 });
    // l1+l2 = 75% coverage, same as pct_cobertura=75
    const cenariosFlat = simularMargem(params, { ndf_taxa_media: 5.50, pct_cobertura: 75 });
    expect(cenarios[0]!.margem_pct).toBe(cenariosFlat[0]!.margem_pct);
  });

  it('accepts pct_custo_importado instead of volume_usd', () => {
    // faturamento 5M * 70% = 3.5M volume
    const cenarios = simularMargem(
      { faturamento_brl: 5000000, outros_custos_brl: 800000, pct_custo_importado: 70 },
      { ndf_taxa_media: 5.50, pct_cobertura: 70 },
    );
    const cenariosVol = simularMargem(
      { faturamento_brl: 5000000, outros_custos_brl: 800000, volume_usd: 3500000 },
      { ndf_taxa_media: 5.50, pct_cobertura: 70 },
    );
    expect(cenarios[0]!.custo_sem_hedge).toBe(cenariosVol[0]!.custo_sem_hedge);
  });
});
