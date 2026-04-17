import { describe, it, expect } from 'vitest';
import {
  converterParaToneladas,
  fmtQtdUnidade,
  calcularCobertura,
  classificarCriticidade,
} from '../services/motor.service.js';

describe('motor.service#converterParaToneladas', () => {
  it('tonelada mantem o valor', () => {
    expect(converterParaToneladas(25, 't')).toBe(25);
    expect(converterParaToneladas(0.5, 't')).toBe(0.5);
  });

  it('kg converte para tonelada dividindo por 1000', () => {
    expect(converterParaToneladas(1000, 'kg')).toBe(1);
    expect(converterParaToneladas(18_000, 'kg')).toBe(18);
    expect(converterParaToneladas(250, 'kg')).toBe(0.25);
  });

  it('saco de 25kg converte para 0.025t cada', () => {
    expect(converterParaToneladas(40, 'saco')).toBe(1); // 40 sacos × 25kg = 1000kg = 1t
    expect(converterParaToneladas(980, 'saco')).toBeCloseTo(24.5, 3);
    expect(converterParaToneladas(1, 'saco')).toBe(0.025);
  });

  it('bigbag mantem 1:1 com tonelada (1 bigbag = 1t)', () => {
    expect(converterParaToneladas(1, 'bigbag')).toBe(1);
    expect(converterParaToneladas(35, 'bigbag')).toBe(35);
  });

  it('valor zero retorna zero', () => {
    expect(converterParaToneladas(0, 't')).toBe(0);
    expect(converterParaToneladas(0, 'kg')).toBe(0);
    expect(converterParaToneladas(0, 'saco')).toBe(0);
    expect(converterParaToneladas(0, 'bigbag')).toBe(0);
  });

  it('valor negativo preserva sinal (para saidas)', () => {
    expect(converterParaToneladas(-5, 't')).toBe(-5);
    expect(converterParaToneladas(-1000, 'kg')).toBe(-1);
  });
});

describe('motor.service#fmtQtdUnidade', () => {
  it('formata com unidade legivel', () => {
    expect(fmtQtdUnidade(25, 't')).toMatch(/25\s+t/);
    expect(fmtQtdUnidade(1000, 'kg')).toMatch(/1[.,]?000\s+kg/);
    expect(fmtQtdUnidade(40, 'saco')).toMatch(/40\s+saco/);
    expect(fmtQtdUnidade(35, 'bigbag')).toMatch(/35\s+big\s?bag/);
  });
});

describe('motor.service#calcularCobertura', () => {
  it('divide saldo fisico pelo consumo medio diario', () => {
    expect(calcularCobertura(60, 2)).toBe(30);
    expect(calcularCobertura(100, 5)).toBe(20);
  });

  it('retorna null quando consumo medio e zero/nulo (evita divisao por zero)', () => {
    expect(calcularCobertura(60, 0)).toBeNull();
    expect(calcularCobertura(60, null)).toBeNull();
  });

  it('retorna 0 quando saldo e zero', () => {
    expect(calcularCobertura(0, 2)).toBe(0);
  });

  it('arredonda para inteiro (dias)', () => {
    expect(calcularCobertura(10, 3)).toBe(3); // 3.33...
    expect(calcularCobertura(11, 3)).toBe(4); // 3.66...
  });
});

describe('motor.service#classificarCriticidade', () => {
  const leadTime = 60;
  const consumo = 1;

  it('cobertura < 50% do lead time => critico', () => {
    // 29 dias < 30 (50% de 60)
    expect(classificarCriticidade(29, leadTime, 29, consumo)).toBe('critico');
  });

  it('cobertura entre 50% e 120% do lead time => alerta', () => {
    expect(classificarCriticidade(31, leadTime, 31, consumo)).toBe('alerta'); // 50.1%
    expect(classificarCriticidade(71, leadTime, 71, consumo)).toBe('alerta'); // 118%
  });

  it('cobertura entre 120% e 400% => ok', () => {
    expect(classificarCriticidade(72, leadTime, 72, consumo)).toBe('ok'); // 120%
    expect(classificarCriticidade(240, leadTime, 240, consumo)).toBe('ok'); // 400%
  });

  it('saldo > consumo*leadTime*4 => excesso', () => {
    expect(classificarCriticidade(300, leadTime, 300, consumo)).toBe('excesso'); // 500%
  });

  it('sem consumo medio retorna "ok" (nao classificavel)', () => {
    expect(classificarCriticidade(null, leadTime, 50, 0)).toBe('ok');
    expect(classificarCriticidade(null, leadTime, 50, null)).toBe('ok');
  });

  it('sem lead time assume default 60 dias', () => {
    expect(classificarCriticidade(29, null, 29, 1)).toBe('critico');
    expect(classificarCriticidade(100, null, 100, 1)).toBe('ok');
  });
});
