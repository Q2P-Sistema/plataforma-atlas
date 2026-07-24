import { describe, it, expect } from 'vitest';
import { dataLocalISO, mesLocalBR } from '../services/datas.js';

// MOD-21: os containers rodam em UTC; toISOString()/getMonth() "viram o dia/mês"
// até 3h antes da meia-noite local (BR = UTC-3). Estes casos fixam instantes que
// caem em dias/meses diferentes em UTC vs America/Sao_Paulo.

describe('dataLocalISO — data no fuso BR, imune ao TZ do processo', () => {
  it('01/07 02:00 UTC ainda é 30/06 no BR (não vira o mês)', () => {
    // 2026-07-01T02:00:00Z = 2026-06-30 23:00 em America/Sao_Paulo
    expect(dataLocalISO(new Date('2026-07-01T02:00:00Z'))).toBe('2026-06-30');
  });

  it('meio-dia UTC cai no mesmo dia no BR', () => {
    expect(dataLocalISO(new Date('2026-07-06T12:00:00Z'))).toBe('2026-07-06');
  });

  it('virada do ano: 01/01 01:00 UTC ainda é 31/12 no BR', () => {
    expect(dataLocalISO(new Date('2027-01-01T01:00:00Z'))).toBe('2026-12-31');
  });
});

describe('mesLocalBR — mês sazonal no fuso BR', () => {
  it('01/07 02:00 UTC → mês 6 (junho), não 7', () => {
    // getMonth()+1 em UTC daria 7 (julho) — o bug que o MOD-21 corrige.
    expect(mesLocalBR(new Date('2026-07-01T02:00:00Z'))).toBe(6);
  });

  it('meio-dia claramente dentro do mês → mês correto', () => {
    expect(mesLocalBR(new Date('2026-07-06T12:00:00Z'))).toBe(7);
  });

  it('virada do ano em UTC ainda é dezembro no BR', () => {
    expect(mesLocalBR(new Date('2027-01-01T01:00:00Z'))).toBe(12);
  });
});
