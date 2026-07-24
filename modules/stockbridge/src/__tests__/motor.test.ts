import { describe, it, expect } from 'vitest';
import {
  converterParaKg,
  fmtQtdUnidade,
  calcularCobertura,
  classificarCriticidade,
  normalizarNumeroNf,
} from '../services/motor.service.js';

describe('motor.service#converterParaKg', () => {
  it('tonelada converte para 1000 kg', () => {
    expect(converterParaKg(25, 't')).toBe(25_000);
    expect(converterParaKg(0.5, 't')).toBe(500);
  });

  it('kg mantem o valor', () => {
    expect(converterParaKg(1000, 'kg')).toBe(1000);
    expect(converterParaKg(18_000, 'kg')).toBe(18_000);
    expect(converterParaKg(250, 'kg')).toBe(250);
  });

  it('saco de 25kg converte para 25 kg cada', () => {
    expect(converterParaKg(40, 'saco')).toBe(1000); // 40 sacos × 25kg = 1000kg
    expect(converterParaKg(980, 'saco')).toBe(24_500);
    expect(converterParaKg(1, 'saco')).toBe(25);
  });

  it('bigbag converte para 1000 kg cada (1 bigbag = 1t)', () => {
    expect(converterParaKg(1, 'bigbag')).toBe(1000);
    expect(converterParaKg(35, 'bigbag')).toBe(35_000);
  });

  it('valor zero retorna zero', () => {
    expect(converterParaKg(0, 't')).toBe(0);
    expect(converterParaKg(0, 'kg')).toBe(0);
    expect(converterParaKg(0, 'saco')).toBe(0);
    expect(converterParaKg(0, 'bigbag')).toBe(0);
  });

  it('valor negativo preserva sinal (para saidas)', () => {
    expect(converterParaKg(-5, 't')).toBe(-5000);
    expect(converterParaKg(-1000, 'kg')).toBe(-1000);
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
    // 60 kg de saldo / 2 kg/dia = 30 dias
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
  const consumo = 1; // 1 kg/dia

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

describe('motor.service#normalizarNumeroNf', () => {
  it('numerica curta vira zero-padded 8 digitos', () => {
    expect(normalizarNumeroNf('300')).toBe('00000300');
    expect(normalizarNumeroNf('1')).toBe('00000001');
    expect(normalizarNumeroNf('12345678')).toBe('12345678');
  });

  it('numerica que ja vem padded fica igual', () => {
    expect(normalizarNumeroNf('00000300')).toBe('00000300');
  });

  it('apara espacos antes de normalizar', () => {
    expect(normalizarNumeroNf('  300  ')).toBe('00000300');
  });

  it('alfanumerica preserva o formato original', () => {
    expect(normalizarNumeroNf('IMP-2026-0301')).toBe('IMP-2026-0301');
    expect(normalizarNumeroNf('DEV/123')).toBe('DEV/123');
  });

  it('formato invalido (vazio, nao-numerico puro) retorna como veio', () => {
    expect(normalizarNumeroNf('')).toBe('');
    expect(normalizarNumeroNf('300abc')).toBe('300abc');
    expect(normalizarNumeroNf('-300')).toBe('-300');
  });
});
