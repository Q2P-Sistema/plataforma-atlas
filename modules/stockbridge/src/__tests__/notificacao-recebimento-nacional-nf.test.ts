import { describe, it, expect, vi, beforeEach } from 'vitest';

// ACXEGDP-396: o recebimento nacional pela fila de NF grava tipo_aprovacao
// 'entrada_manual' (mesmo do lançamento à mão). Os e-mails ao operador passam a
// identificar a NF e os dados do item quando a aprovação tem chave de NF.

const { sendEmailMock, loggerMock, executeMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue(undefined),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  executeMock: vi.fn(),
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => loggerMock,
  getConfig: () => ({ APP_URL: 'https://atlas.local' }),
  getDb: () => ({
    // resolverEmailOperador: select().from().where().limit()
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ email: 'operador@q2p.local' }]) }) }) }),
    execute: executeMock,
  }),
  sendEmail: sendEmailMock,
  buildEmailLayout: (o: { corpoHtml?: string; ctaUrl?: string }) => ({
    html: `${o?.corpoHtml ?? ''}||URL:${o?.ctaUrl ?? ''}`,
    text: '',
  }),
  escapeHtml: (v: unknown) => String(v ?? ''),
  emailActionBox: (html: string) => html,
  emailDataList: (linhas: Array<{ label: string; valor: string }>) =>
    linhas.map((l) => `[${l.label}: ${l.valor}]`).join(''),
}));
vi.mock('@atlas/db', () => ({ users: {}, userModules: {} }));

import {
  enviarNotificacaoAprovacaoOperador,
  enviarNotificacaoRejeicaoOperador,
} from '../services/notificacao.service.js';

const linhaNf6842 = {
  nota_fiscal: '6842',
  fornecedor: 'REPLAS COMERCIAL LTDA',
  item_nf: 'SUCATA PLASTICO',
  produto: 'PS CRISTAL A',
  quantidade_kg: '18000.000',
  local: 'SANTO ANDRÉ (NACIONAL)',
};

function ultimoEmail() {
  return sendEmailMock.mock.calls.at(-1)![0] as { subject: string; html: string };
}

beforeEach(() => {
  sendEmailMock.mockClear();
  executeMock.mockReset();
  loggerMock.warn.mockClear();
});

describe('ACXEGDP-396 — e-mail de aprovação ao operador', () => {
  it('recebimento nacional por NF: assunto com NF e fornecedor, corpo com os dados do item', async () => {
    executeMock.mockResolvedValue({ rows: [linhaNf6842] });

    await enviarNotificacaoAprovacaoOperador({
      operadorUserId: 'u1',
      aprovacaoId: '381669cf-6f34-4f0f-aed0-a7290f650bec',
      tipoAprovacao: 'entrada_manual',
    });

    const { subject, html } = ultimoEmail();
    expect(subject).toBe('StockBridge — Recebimento aprovado — NF 6842 (REPLAS COMERCIAL LTDA)');
    expect(html).toContain('Recebimento nacional (NF)');
    expect(html).not.toContain('Entrada manual');
    expect(html).toContain('[Item da NF: SUCATA PLASTICO]');
    expect(html).toContain('[Produto: PS CRISTAL A]');
    expect(html).toContain('[Quantidade: 18.000 kg]');
    expect(html).toContain('[Local: SANTO ANDRÉ (NACIONAL)]');
  });

  it('entrada manual sem NF (formulário à mão) continua "Entrada manual"', async () => {
    executeMock.mockResolvedValue({ rows: [] });

    await enviarNotificacaoAprovacaoOperador({ operadorUserId: 'u1', aprovacaoId: 'a1', tipoAprovacao: 'entrada_manual' });

    const { subject, html } = ultimoEmail();
    expect(subject).toBe('StockBridge — Lançamento aprovado (Entrada manual)');
    expect(html).not.toContain('[NF:');
  });

  it('falha ao ler o contexto não impede o e-mail: cai no texto genérico', async () => {
    executeMock.mockRejectedValue(new Error('db fora'));

    await enviarNotificacaoAprovacaoOperador({ operadorUserId: 'u1', aprovacaoId: 'a1', tipoAprovacao: 'entrada_manual' });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(ultimoEmail().subject).toBe('StockBridge — Lançamento aprovado (Entrada manual)');
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});

describe('ACXEGDP-396 — e-mail de rejeição ao operador', () => {
  it('recebimento nacional por NF: assunto com NF, dados do item e link para a Fila de Recebimento', async () => {
    executeMock.mockResolvedValue({ rows: [linhaNf6842] });

    await enviarNotificacaoRejeicaoOperador({
      operadorUserId: 'u1',
      aprovacaoId: 'ap1',
      loteId: 'mov1',
      motivo: 'peso não confere',
      fluxo: 'recebimento',
      tipoAprovacao: 'entrada_manual',
    });

    const { subject, html } = ultimoEmail();
    expect(subject).toBe('StockBridge — Recebimento rejeitado — NF 6842 (REPLAS COMERCIAL LTDA)');
    expect(html).toContain('[Produto: PS CRISTAL A]');
    expect(html).toContain('peso não confere');
    expect(html).toContain('URL:https://atlas.local/stockbridge/fila#rejeicao=ap1');
  });
});
