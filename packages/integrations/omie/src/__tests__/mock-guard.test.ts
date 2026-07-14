import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// STK-15 (ACXEGDP-289): OMIE_MODE=mock em NODE_ENV=production gravaria
// recebimentos/saidas como 'concluida' com ids MOCK-* sem tocar o ERP,
// silenciosamente (.env.example traz mock como default de dev — copy-paste de
// env bastaria). isMockMode falha explicito nessa combinacao.

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { isMockMode } from '../client.js';

describe('isMockMode — guarda de produção (STK-15)', () => {
  const envOriginal = { NODE_ENV: process.env.NODE_ENV, OMIE_MODE: process.env.OMIE_MODE };

  beforeEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.OMIE_MODE;
  });

  afterEach(() => {
    process.env.NODE_ENV = envOriginal.NODE_ENV;
    process.env.OMIE_MODE = envOriginal.OMIE_MODE;
  });

  it('mock em dev/test funciona normalmente', () => {
    process.env.OMIE_MODE = 'mock';
    process.env.NODE_ENV = 'test';
    expect(isMockMode()).toBe(true);
  });

  it('real em produção funciona normalmente', () => {
    process.env.OMIE_MODE = 'real';
    process.env.NODE_ENV = 'production';
    expect(isMockMode()).toBe(false);
  });

  it('default (sem OMIE_MODE) é real — inclusive em produção', () => {
    process.env.NODE_ENV = 'production';
    expect(isMockMode()).toBe(false);
  });

  it('mock + production → lança erro claro (fail-fast)', () => {
    process.env.OMIE_MODE = 'mock';
    process.env.NODE_ENV = 'production';
    expect(() => isMockMode()).toThrow(/OMIE_MODE=mock com NODE_ENV=production/);
  });
});
