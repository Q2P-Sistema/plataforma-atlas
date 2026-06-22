import { describe, it, expect, vi } from 'vitest';
import {
  statusSaldoNegativo,
  statusGeral,
  classificarLinha,
  compararItens,
  montarResumo,
  aplicarFiltros,
  type ConferenciaItem,
  type LinhaPivot,
} from '../services/conferencia.service.js';

// A engine é pura; o module-load só importa getPool/createLogger (não chamados aqui).
vi.mock('@atlas/core', () => ({
  getPool: vi.fn(),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('conferencia engine — statusSaldoNegativo (FR-006)', () => {
  it('ambos negativos', () => {
    expect(statusSaldoNegativo(-1, -1)).toBe('ACXE e Q2P negativos');
  });
  it('só ACXE negativo', () => {
    expect(statusSaldoNegativo(-1, 5)).toBe('ACXE negativo');
  });
  it('só Q2P negativo', () => {
    expect(statusSaldoNegativo(5, -1)).toBe('Q2P negativo');
  });
  it('ambos não-negativos (inclui zero)', () => {
    expect(statusSaldoNegativo(0, 0)).toBe('OK');
    expect(statusSaldoNegativo(10, 0)).toBe('OK');
  });
});

describe('conferencia engine — statusGeral (FR-007/FR-008, ordem de prioridade)', () => {
  it('ESPELHADO + diferença≠0 + negativo → Divergente e Negativo', () => {
    expect(statusGeral('ESPELHADO', 100, 'ACXE negativo')).toBe('Divergente e Negativo');
  });
  it('ESPELHADO + diferença≠0 + sem negativo → Divergente', () => {
    expect(statusGeral('ESPELHADO', 100, 'OK')).toBe('Divergente');
  });
  it('ESPELHADO + diferença=0 + ambos negativos → Negativo (não Divergente e Negativo)', () => {
    // Caso real: PEBD 100 em 11.1, ACXE=Q2P=-1500
    expect(statusGeral('ESPELHADO', 0, 'ACXE e Q2P negativos')).toBe('Negativo');
  });
  it('INDIVIDUAL nunca é Divergente, mesmo com diferença≠0', () => {
    expect(statusGeral('INDIVIDUAL', 999, 'OK')).toBe('OK');
    expect(statusGeral('INDIVIDUAL', 999, 'ACXE negativo')).toBe('Negativo');
  });
  it('tudo casado → OK', () => {
    expect(statusGeral('ESPELHADO', 0, 'OK')).toBe('OK');
  });
});

describe('conferencia engine — classificarLinha', () => {
  it('calcula diferença = ACXE - Q2P e ausência tratada como 0', () => {
    const l: LinhaPivot = {
      codigoEstoque: '11.1',
      nomeEstoque: 'SANTO ANDRÉ (IMPORTADO)',
      tipoEstoque: 'ESPELHADO',
      produto: 'PEBD 100',
      saldoAcxeKg: 0, // produto só existe no Q2P
      saldoQ2pKg: 500,
    };
    const item = classificarLinha(l);
    expect(item.diferencaKg).toBe(-500);
    expect(item.statusGeral).toBe('Divergente'); // ESPELHADO + diferença≠0
  });

  it('caso planilha: ESPELHADO ambos -1500 → Negativo', () => {
    const item = classificarLinha({
      codigoEstoque: '11.1',
      nomeEstoque: 'SANTO ANDRÉ (IMPORTADO)',
      tipoEstoque: 'ESPELHADO',
      produto: 'PEBD 100',
      saldoAcxeKg: -1500,
      saldoQ2pKg: -1500,
    });
    expect(item.diferencaKg).toBe(0);
    expect(item.statusSaldoNegativo).toBe('ACXE e Q2P negativos');
    expect(item.statusGeral).toBe('Negativo');
  });
});

describe('conferencia engine — ordenação (FR-011, problemas no topo)', () => {
  function mk(statusGeralVal: ConferenciaItem['statusGeral'], produto = 'X'): ConferenciaItem {
    return {
      codigoEstoque: '11.1',
      nomeEstoque: 'A',
      tipoEstoque: 'ESPELHADO',
      produto,
      saldoAcxeKg: 0,
      saldoQ2pKg: 0,
      diferencaKg: 0,
      statusSaldoNegativo: 'OK',
      statusGeral: statusGeralVal,
    };
  }
  it('Divergente e Negativo vem antes de Divergente, Negativo e OK', () => {
    const ordenado = [mk('OK'), mk('Negativo'), mk('Divergente e Negativo'), mk('Divergente')].sort(
      compararItens,
    );
    expect(ordenado.map((i) => i.statusGeral)).toEqual([
      'Divergente e Negativo',
      'Divergente',
      'Negativo',
      'OK',
    ]);
  });
});

describe('conferencia engine — montarResumo (KPIs)', () => {
  const itens: ConferenciaItem[] = [
    classificarLinha({ codigoEstoque: '11.1', nomeEstoque: 'A', tipoEstoque: 'ESPELHADO', produto: 'P1', saldoAcxeKg: 100, saldoQ2pKg: 50 }), // Divergente
    classificarLinha({ codigoEstoque: '11.1', nomeEstoque: 'A', tipoEstoque: 'ESPELHADO', produto: 'P2', saldoAcxeKg: -10, saldoQ2pKg: -10 }), // Negativo
    classificarLinha({ codigoEstoque: '12.1', nomeEstoque: 'B', tipoEstoque: 'ESPELHADO', produto: 'P3', saldoAcxeKg: -5, saldoQ2pKg: 5 }), // Divergente e Negativo
    classificarLinha({ codigoEstoque: '11.2', nomeEstoque: 'C', tipoEstoque: 'INDIVIDUAL', produto: 'P4', saldoAcxeKg: 0, saldoQ2pKg: 0 }), // OK
  ];
  const resumo = montarResumo(itens, '2026-06-22', '2026-06-22');

  it('conta problemas, divergentes e quebras corretamente', () => {
    expect(resumo.totalProblemas).toBe(3); // tudo != OK
    expect(resumo.totalSkusDivergentes).toBe(2); // Divergente + Divergente e Negativo
    expect(resumo.totalQuebrasNegativas).toBe(2); // P2 e P3
  });
  it('soma a diferença (com sinal) e detecta defasagem', () => {
    expect(resumo.somaDiferencaKg).toBe(50 + 0 + -10 + 0);
    expect(resumo.defasagemEntreEmpresas).toBe(false);
    expect(montarResumo(itens, '2026-06-22', '2026-06-21').defasagemEntreEmpresas).toBe(true);
  });
});

describe('conferencia engine — aplicarFiltros (US3)', () => {
  const itens: ConferenciaItem[] = [
    classificarLinha({ codigoEstoque: '11.1', nomeEstoque: 'A', tipoEstoque: 'ESPELHADO', produto: 'PEBD', saldoAcxeKg: 100, saldoQ2pKg: 50 }), // Divergente
    classificarLinha({ codigoEstoque: '11.2', nomeEstoque: 'B', tipoEstoque: 'INDIVIDUAL', produto: 'PP', saldoAcxeKg: -10, saldoQ2pKg: 0 }), // Negativo
    classificarLinha({ codigoEstoque: '12.1', nomeEstoque: 'C', tipoEstoque: 'ESPELHADO', produto: 'PS', saldoAcxeKg: 5, saldoQ2pKg: 5 }), // OK
  ];
  it('status=problemas remove OK', () => {
    expect(aplicarFiltros(itens, { status: 'problemas' }).every((i) => i.statusGeral !== 'OK')).toBe(true);
    expect(aplicarFiltros(itens, { status: 'problemas' })).toHaveLength(2);
  });
  it('status=divergente traz só Divergente*', () => {
    const r = aplicarFiltros(itens, { status: 'divergente' });
    expect(r).toHaveLength(1);
    expect(r[0].produto).toBe('PEBD');
  });
  it('tipo=INDIVIDUAL filtra por tipo', () => {
    expect(aplicarFiltros(itens, { tipo: 'INDIVIDUAL' })).toHaveLength(1);
  });
  it('busca casa produto/local (case-insensitive)', () => {
    expect(aplicarFiltros(itens, { busca: 'pebd' })).toHaveLength(1);
  });
});
