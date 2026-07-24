import { describe, it, expect } from 'vitest';
import { parseDataCivilLocal, hojeLocalISO } from '../services/datas.js';

// MOD-08 (ACXEGDP-278): new Date('YYYY-MM-DD') é UTC-midnight; em
// America/Sao_Paulo os getters locais devolviam o dia anterior — NDF de dia 1º
// caía no bucket do mês anterior e NDF vencendo hoje era rejeitado.

describe('parseDataCivilLocal', () => {
  it('interpreta a data civil no fuso LOCAL (getters não regridem um dia)', () => {
    const d = parseDataCivilLocal('2026-08-01');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // agosto (0-based)
    expect(d.getDate()).toBe(1);
    // Contraste com o bug: em qualquer fuso a oeste de UTC,
    // new Date('2026-08-01').getDate() local seria 31 (julho).
  });

  it('meia-noite local: não é menor que "hoje às 00:00" quando é o mesmo dia', () => {
    const hoje = new Date();
    const hojeCivil = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
    const parsed = parseDataCivilLocal(hojeCivil);
    const meiaNoite = new Date();
    meiaNoite.setHours(0, 0, 0, 0);
    // NDF vencendo HOJE deve passar na validação `vencDate < today` → false
    expect(parsed < meiaNoite).toBe(false);
  });

  it('entrada malformada vira Invalid Date (validação a jusante captura)', () => {
    expect(isNaN(parseDataCivilLocal('abc').getTime())).toBe(true);
    expect(isNaN(parseDataCivilLocal('').getTime())).toBe(true);
  });

  it('mês/ano derivados localmente batem com a string de origem (bucket do mês certo)', () => {
    const d = parseDataCivilLocal('2026-08-01');
    const bucketMes = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    expect(bucketMes).toBe('2026-08-01');
  });
});

describe('hojeLocalISO', () => {
  it('retorna a data LOCAL em YYYY-MM-DD (não a UTC de toISOString)', () => {
    const esperado = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    expect(hojeLocalISO()).toBe(esperado);
    expect(hojeLocalISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
