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

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getConfig: () => config,
  getDb: () => ({
    // resolverEmailOperador: select().from().where().limit(1)
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ email: 'operador@acxe.local' }]) }) }) }),
  }),
  sendEmail: sendEmailMock,
  buildEmailLayout: (o: { titulo?: string }) => ({ html: String(o?.titulo ?? ''), text: '' }),
  escapeHtml: (v: unknown) => String(v ?? ''),
  emailDataList: () => '',
  emailActionBox: (h: string) => h,
}));
vi.mock('@atlas/db', () => ({ users: {}, userModules: {} }));

import {
  enviarAlertaProdutoSemCorrelato,
  enviarNotificacaoRecebimentoConcluido,
} from '../services/notificacao.service.js';

beforeEach(() => sendEmailMock.mockClear());

describe('EML-08 — alertas operacionais vão para a caixa dedicada + admin em CC', () => {
  it('produto sem correlato: To = STOCKBRIDGE_OPS_EMAIL, CC = admin', async () => {
    await enviarAlertaProdutoSemCorrelato({ codigoProdutoAcxe: 1, notaFiscal: '9', descricaoProduto: 'X' });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0]![0] as { to: string; cc?: string };
    expect(arg.to).toBe('ops@acxe.local');
    expect(arg.cc).toBe('admin@acxe.local');
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
