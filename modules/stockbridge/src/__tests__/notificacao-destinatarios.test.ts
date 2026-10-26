import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendEmailMock, config } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue(undefined),
  config: {
    STOCKBRIDGE_OPS_EMAIL: 'ops@acxe.local',
    SEED_ADMIN_EMAIL: 'admin@acxe.local',
    STOCKBRIDGE_COMEX_EMAIL: 'comex@acxe.local',
    MODULE_STOCKBRIDGE_ENABLED: true,
  } as Record<string, unknown>,
}));

vi.mock('@atlas/core', async () => ({
  ...(await import('./helpers/email-q2p.js')),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getConfig: () => config,
  getDb: () => ({
    // resolverEmailOperador: select().from().where().limit(1)
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ email: 'operador@acxe.local' }]) }) }) }),
  }),
  sendEmail: sendEmailMock,
}));
vi.mock('@atlas/db', () => ({ users: {}, userModules: {} }));

import {
  enviarAlertaProdutoSemCorrelato,
  enviarDigestBaixasAguardandoVinculo,
  enviarNotificacaoRecebimentoConcluido,
} from '../services/notificacao.service.js';

beforeEach(() => sendEmailMock.mockClear());

describe('EML-08 — alertas operacionais vão para a caixa dedicada + admin em cópia oculta (ACXEGDP-440)', () => {
  it('produto sem correlato: To = STOCKBRIDGE_OPS_EMAIL, Cco = admin', async () => {
    await enviarAlertaProdutoSemCorrelato({ codigoProdutoAcxe: 1, notaFiscal: '9', descricaoProduto: 'X' });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0]![0] as { to: string; cc?: string; bcc?: string };
    expect(arg.to).toBe('ops@acxe.local');
    expect(arg.cc).toBeUndefined();
    expect(arg.bcc).toBe('admin@acxe.local');
  });
});

describe('ACXEGDP-440 (decisão 7) — NF sem vínculo na FUP vai para a Comex', () => {
  it('Para = Comex (quem preenche a FUP); a caixa ops e o admin acompanham em cópia oculta', async () => {
    await enviarDigestBaixasAguardandoVinculo({ itens: [{ notaFiscal: '9', dias: 4 }], diasLimite: 3 });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0]![0] as { to: string; cc?: unknown; bcc?: string[]; subject: string };
    expect(arg.to).toBe('comex@acxe.local');
    expect(arg.cc).toBeUndefined();
    expect(arg.bcc).toEqual(['ops@acxe.local', 'admin@acxe.local']);
    expect(arg.subject).toBe('[AÇÃO REQUERIDA] - Pedido de compra Q2P - NF sem vínculo na FUP - NF 9');
  });
});

describe('EML-14 — recebimento concluído não notifica os gestores', () => {
  it('destinatários = operador + Comex apenas (sem gestores)', async () => {
    await enviarNotificacaoRecebimentoConcluido({
      operadorUserId: 'u1', loteCodigo: 'L1', notaFiscal: '9', produto: 'X',
      quantidadeKg: 100, fornecedor: null, localidade: 'G01',
    });
    const tos = sendEmailMock.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(new Set(tos)).toEqual(new Set(['operador@acxe.local', 'comex@acxe.local']));
  });
});
