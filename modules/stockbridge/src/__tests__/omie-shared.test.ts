import { describe, it, expect } from 'vitest';
import { formatarDataOmie } from '../services/omie-shared.js';

// STK-17: consolidou 4 cópias idênticas do formatador dd/MM/yyyy que a OMIE espera.
describe('formatarDataOmie', () => {
  it('formata dd/MM/yyyy com zero-padding (dia e mês)', () => {
    // Construído com componentes locais → lido com componentes locais: TZ-neutro.
    expect(formatarDataOmie(new Date(2026, 6, 6))).toBe('06/07/2026'); // 6 jul 2026
    expect(formatarDataOmie(new Date(2026, 0, 1))).toBe('01/01/2026'); // 1 jan
    expect(formatarDataOmie(new Date(2026, 11, 31))).toBe('31/12/2026'); // 31 dez
  });

  it('sem argumento usa a data atual (formato válido dd/MM/yyyy)', () => {
    expect(formatarDataOmie()).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });
});
