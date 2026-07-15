import { describe, it, expect, vi, beforeEach } from 'vitest';

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  getPool: () => ({ query: vi.fn() }),
}));

vi.mock('@atlas/db', () => ({
  lote: {}, movimentacao: {}, movimentacaoLegado: {}, aprovacao: {},
  localidade: {}, localidadeCorrelacao: {}, users: {},
}));

vi.mock('@atlas/integration-omie', () => ({
  incluirAjusteEstoque: vi.fn(),
  listarAjusteEstoque: vi.fn(),
  consultarNF: vi.fn(),
  isMockMode: () => true,
}));

import { normalizarUnidade, inferirSubtipoPorNumeroNf } from '../services/recebimento.service.js';

beforeEach(() => warnSpy.mockClear());

describe('normalizarUnidade — STK-20', () => {
  it('reconhece as unidades conhecidas sem warn', () => {
    expect(normalizarUnidade('t')).toBe('t');
    expect(normalizarUnidade('TON')).toBe('t');
    expect(normalizarUnidade('kg')).toBe('kg');
    expect(normalizarUnidade('Big Bag')).toBe('bigbag');
    expect(normalizarUnidade('saco 25kg')).toBe('saco');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('unidade desconhecida cai em kg E loga warning (antes sumia silenciosamente)', () => {
    expect(normalizarUnidade('caixa')).toBe('kg');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatchObject({ unidadeOriginal: 'caixa' });
  });
});

describe('inferirSubtipoPorNumeroNf — STK-21', () => {
  it('deriva o subtipo pelo prefixo do número da NF', () => {
    expect(inferirSubtipoPorNumeroNf('IMP-123')).toBe('importacao');
    expect(inferirSubtipoPorNumeroNf('DEV/45')).toBe('devolucao_cliente');
    expect(inferirSubtipoPorNumeroNf('CN-9')).toBe('compra_nacional');
  });

  it('NF sem prefixo reconhecido (ou vazia) → importacao (default, = comportamento anterior)', () => {
    expect(inferirSubtipoPorNumeroNf('999888')).toBe('importacao');
    expect(inferirSubtipoPorNumeroNf('')).toBe('importacao');
  });
});
