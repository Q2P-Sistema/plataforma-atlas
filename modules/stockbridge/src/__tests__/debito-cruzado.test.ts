import { describe, it, expect } from 'vitest';
import { detectarDebitoCruzado } from '../services/saida-automatica.service.js';

describe('saida-automatica#detectarDebitoCruzado', () => {
  it('retorna false quando emissor e fisico batem (acxe=acxe)', () => {
    expect(detectarDebitoCruzado('acxe', 'acxe')).toBe(false);
  });

  it('retorna false quando emissor e fisico batem (q2p=q2p)', () => {
    expect(detectarDebitoCruzado('q2p', 'q2p')).toBe(false);
  });

  it('retorna true quando Q2P fatura mas fisico esta em ACXE', () => {
    expect(detectarDebitoCruzado('q2p', 'acxe')).toBe(true);
  });

  it('retorna true quando ACXE fatura mas fisico esta em Q2P', () => {
    expect(detectarDebitoCruzado('acxe', 'q2p')).toBe(true);
  });

  it('retorna false quando fisico desconhecido (nao e debito cruzado — e lote sem localidade)', () => {
    expect(detectarDebitoCruzado('acxe', null)).toBe(false);
    expect(detectarDebitoCruzado('q2p', null)).toBe(false);
  });
});
