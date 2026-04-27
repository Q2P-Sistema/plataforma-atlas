import { describe, it, expect, vi } from 'vitest';

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getConfig: () => ({}),
  sendEmail: vi.fn(),
  getPool: () => ({ query: vi.fn() }),
}));

vi.mock('@atlas/db', () => ({
  lote: {}, movimentacao: {}, aprovacao: {}, localidade: {}, localidadeCorrelacao: {}, users: {},
}));

vi.mock('@atlas/integration-omie', () => ({
  incluirAjusteEstoque: vi.fn(),
  listarAjusteEstoque: vi.fn(),
  consultarNF: vi.fn(),
  isMockMode: () => true,
}));

import { mapearErroOmieParaResposta } from '../services/erros-omie.js';
import { OmieAjusteError } from '../services/recebimento.service.js';

describe('mapearErroOmieParaResposta (US5)', () => {
  it('ACXE-fail: stateClean=true, userAction=retry, retryable=true', () => {
    const err = new OmieAjusteError('acxe', new Error('OMIE 504'));
    const res = mapearErroOmieParaResposta(err, { role: 'operador' });

    expect(res.httpStatus).toBe(502);
    expect(res.body).toMatchObject({
      code: 'OMIE_ACXE_FAIL',
      userAction: 'retry',
      retryable: true,
      stateClean: true,
    });
    expect(res.body.userMessage.length).toBeGreaterThan(0);
    expect(res.body.userMessage).toMatch(/ACXE/i);
  });

  it('Q2P-fail recoverable: stateClean=false, retry_q2p, tentativasRestantes propagado', () => {
    const err = new OmieAjusteError('q2p', new Error('OMIE 503'), {
      idACXE: { idMovest: 'M', idAjuste: 'A' },
      opId: 'op-1',
      movimentacaoId: 'mov-1',
      recoverable: true,
      tentativasRestantes: 1,
    });
    const res = mapearErroOmieParaResposta(err, { role: 'operador' });

    expect(res.body).toMatchObject({
      code: 'OMIE_Q2P_FAIL',
      userAction: 'retry_q2p',
      retryable: true,
      stateClean: false,
      opId: 'op-1',
      movimentacaoId: 'mov-1',
      tentativasRestantes: 1,
    });
    expect(res.body.userMessage).toMatch(/parcial/i);
  });

  it('Q2P-fail operador esgotou (tentativasRestantes=0): userAction=contact_admin, retryable=false', () => {
    const err = new OmieAjusteError('q2p', new Error('OMIE 503'), {
      opId: 'op-2',
      movimentacaoId: 'mov-2',
      tentativasRestantes: 0,
    });
    const res = mapearErroOmieParaResposta(err, { role: 'operador' });

    expect(res.body).toMatchObject({
      code: 'OMIE_Q2P_FAIL',
      userAction: 'contact_admin',
      retryable: false,
      stateClean: false,
    });
    expect(res.body.userMessage).toMatch(/esgotou|gestor|diretor/i);
  });

  it('Q2P-fail para gestor/diretor: sem limite, retryable=true mesmo sem tentativasRestantes', () => {
    const err = new OmieAjusteError('q2p', new Error('OMIE 503'), {
      opId: 'op-3',
      movimentacaoId: 'mov-3',
    });
    const res = mapearErroOmieParaResposta(err, { role: 'gestor' });

    expect(res.body).toMatchObject({
      userAction: 'retry_q2p',
      retryable: true,
      stateClean: false,
    });
    expect(res.body.userMessage).toMatch(/retentar|quantas vezes/i);
  });

  it('Q2P-fail diretor: mesmo tratamento de gestor', () => {
    const err = new OmieAjusteError('q2p', new Error('OMIE 503'));
    const res = mapearErroOmieParaResposta(err, { role: 'diretor' });

    expect(res.body.retryable).toBe(true);
    expect(res.body.userAction).toBe('retry_q2p');
  });

  it('userMessage e PT-BR nao-vazia para todos cenarios', () => {
    const cenarios = [
      new OmieAjusteError('acxe', new Error('x')),
      new OmieAjusteError('q2p', new Error('x'), { tentativasRestantes: 1 }),
      new OmieAjusteError('q2p', new Error('x'), { tentativasRestantes: 0 }),
    ];
    for (const err of cenarios) {
      const res = mapearErroOmieParaResposta(err, { role: 'operador' });
      expect(res.body.userMessage).toMatch(/[a-z]/);
      expect(res.body.userMessage.length).toBeGreaterThan(20);
    }
  });
});
