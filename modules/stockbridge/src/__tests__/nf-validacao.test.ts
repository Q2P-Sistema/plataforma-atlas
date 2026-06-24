import { describe, it, expect } from 'vitest';
import type { ConsultarNFResponse } from '@atlas/integration-omie';
import { validarNfRecebivel } from '../services/nf-validacao.service.js';

/** NF base válida, emitida pela ACXE (saída), não cancelada. */
function nf(overrides: Partial<ConsultarNFResponse> = {}): ConsultarNFResponse {
  return {
    nNF: 300,
    cChaveNFe: 'CHAVE',
    dEmi: '15/04/2026',
    nCodProd: 4_452_881_285,
    codigoLocalEstoque: '4498926337',
    qCom: 25_000,
    uCom: 'KG',
    xProd: 'PEAD 5502',
    vUnCom: 1.2,
    vNF: 30_000,
    nCodCli: 12345,
    cRazao: 'FORNECEDOR',
    cancelada: false,
    sinaisCancelamento: {},
    tpNF: 1,
    cnpjEmitente: 'Acxe Matriz',
    ...overrides,
  };
}

describe('validarNfRecebivel — matriz de decisão (feature 012)', () => {
  it('NF cancelada → bloqueada/cancelada (qualquer contexto)', () => {
    expect(validarNfRecebivel(nf({ cancelada: true }), { cnpj: 'acxe' })).toEqual({
      status: 'bloqueada',
      motivo: 'cancelada',
    });
    expect(validarNfRecebivel(nf({ cancelada: true }), { cnpj: 'q2p' })).toEqual({
      status: 'bloqueada',
      motivo: 'cancelada',
    });
  });

  it('contexto ACXE: NF de entrada de terceiro (tpNF=0) → bloqueada/nao_emitida_acxe', () => {
    expect(validarNfRecebivel(nf({ tpNF: 0, cnpjEmitente: 'Fornecedor Terceiro' }), { cnpj: 'acxe' })).toEqual({
      status: 'bloqueada',
      motivo: 'nao_emitida_acxe',
    });
  });

  it('contexto ACXE: NF emitida pela ACXE (tpNF=1) → ok', () => {
    expect(validarNfRecebivel(nf({ tpNF: 1 }), { cnpj: 'acxe' })).toEqual({ status: 'ok' });
  });

  it('contexto Q2P: NÃO bloqueia por emitente (mesmo tpNF=0)', () => {
    expect(validarNfRecebivel(nf({ tpNF: 0, cnpjEmitente: 'Fornecedor Terceiro' }), { cnpj: 'q2p' })).toEqual({
      status: 'ok',
    });
  });

  it('NF da ACXE porém cancelada → cancelada (cancelamento avaliado antes de emitente)', () => {
    expect(validarNfRecebivel(nf({ cancelada: true, tpNF: 1 }), { cnpj: 'acxe' })).toEqual({
      status: 'bloqueada',
      motivo: 'cancelada',
    });
  });

  it('contexto ACXE: sem tpNF e sem emitente → indeterminada (fail-open)', () => {
    expect(validarNfRecebivel(nf({ tpNF: undefined, cnpjEmitente: undefined }), { cnpj: 'acxe' })).toEqual({
      status: 'indeterminada',
      motivo: 'emitente_desconhecido',
    });
  });

  it('contexto ACXE: sem tpNF mas emitente textual = ACXE → ok (fallback)', () => {
    expect(validarNfRecebivel(nf({ tpNF: undefined, cnpjEmitente: 'Acxe Matriz' }), { cnpj: 'acxe' })).toEqual({
      status: 'ok',
    });
  });

  it('contexto ACXE: sem tpNF e emitente textual ≠ ACXE → bloqueada/nao_emitida_acxe (fallback)', () => {
    expect(validarNfRecebivel(nf({ tpNF: undefined, cnpjEmitente: 'Outro' }), { cnpj: 'acxe' })).toEqual({
      status: 'bloqueada',
      motivo: 'nao_emitida_acxe',
    });
  });
});
