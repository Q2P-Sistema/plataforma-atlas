import { describe, it, expect, vi } from 'vitest';

// decidirValidacaoNf é puro, mas o módulo importa getPool/createLogger do @atlas/core
// (usados só pela parte de I/O). Mockamos para o teste puro não carregar a config real.
vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getPool: () => ({ query: async () => ({ rows: [] }) }),
}));

import { decidirValidacaoNf, type NfHeaderRow } from '../services/nf-validacao.service.js';

const acxe = (cancelada: boolean): NfHeaderRow => ({ cancelada, emitenteAcxe: true });
const terceiro = (cancelada: boolean): NfHeaderRow => ({ cancelada, emitenteAcxe: false });

describe('decidirValidacaoNf — decisão pura sobre as linhas do espelho (feature 012)', () => {
  // Contexto ACXE
  it('ACXE: NF emitida pela ACXE e não cancelada → ok', () => {
    expect(decidirValidacaoNf([acxe(false)], { cnpj: 'acxe' })).toEqual({ status: 'ok' });
  });

  it('ACXE: NF da ACXE cancelada → bloqueada/cancelada', () => {
    expect(decidirValidacaoNf([acxe(true)], { cnpj: 'acxe' })).toEqual({
      status: 'bloqueada',
      motivo: 'cancelada',
    });
  });

  it('ACXE: número existe só como NF de terceiro → bloqueada/nao_emitida_acxe', () => {
    expect(decidirValidacaoNf([terceiro(false)], { cnpj: 'acxe' })).toEqual({
      status: 'bloqueada',
      motivo: 'nao_emitida_acxe',
    });
  });

  it('ACXE: colisão (terceiros + ACXE válida) → ok (escolhe a da ACXE)', () => {
    // Caso real NF 000000556: 2 emitentes terceiros + 1 ACXE.
    expect(
      decidirValidacaoNf([terceiro(false), terceiro(false), acxe(false)], { cnpj: 'acxe' }),
    ).toEqual({ status: 'ok' });
  });

  it('ACXE: ACXE cancelada + terceiro presente → cancelada (cancelamento da ACXE prevalece)', () => {
    expect(decidirValidacaoNf([acxe(true), terceiro(false)], { cnpj: 'acxe' })).toEqual({
      status: 'bloqueada',
      motivo: 'cancelada',
    });
  });

  it('ACXE: número não encontrado no espelho → indeterminada (fail-open)', () => {
    expect(decidirValidacaoNf([], { cnpj: 'acxe' })).toEqual({
      status: 'indeterminada',
      motivo: 'nao_encontrada_no_espelho',
    });
  });

  // Contexto Q2P — sem filtro de emitente
  it('Q2P: não cancelada → ok (ignora emitente)', () => {
    expect(decidirValidacaoNf([terceiro(false)], { cnpj: 'q2p' })).toEqual({ status: 'ok' });
  });

  it('Q2P: cancelada → bloqueada/cancelada', () => {
    expect(decidirValidacaoNf([terceiro(true)], { cnpj: 'q2p' })).toEqual({
      status: 'bloqueada',
      motivo: 'cancelada',
    });
  });

  it('Q2P: não encontrada → indeterminada (fail-open)', () => {
    expect(decidirValidacaoNf([], { cnpj: 'q2p' })).toEqual({
      status: 'indeterminada',
      motivo: 'nao_encontrada_no_espelho',
    });
  });
});
