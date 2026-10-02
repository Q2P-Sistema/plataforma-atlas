import { describe, it, expect, vi, beforeEach } from 'vitest';

// ACXEGDP-396: o recebimento nacional pela fila de NF grava tipo_aprovacao
// 'entrada_manual' (mesmo do lançamento à mão). Os e-mails ao operador passam a
// identificar a NF e os dados do item — pela fila (com chave de NF) e também no
// formulário manual (NF digitada, sem fornecedor nem item).

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
  por_nf: true,
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

  it('formulário manual: continua "Entrada manual", agora com NF digitada, produto, quantidade e local', async () => {
    executeMock.mockResolvedValue({
      rows: [{ por_nf: false, nota_fiscal: '12345', fornecedor: null, item_nf: null, produto: 'PP H301', quantidade_kg: '1250.500', local: 'SANTO ANDRÉ (NACIONAL)' }],
    });

    await enviarNotificacaoAprovacaoOperador({ operadorUserId: 'u1', aprovacaoId: 'a1', tipoAprovacao: 'entrada_manual' });

    const { subject, html } = ultimoEmail();
    expect(subject).toBe('StockBridge — Entrada manual aprovada — NF 12345');
    expect(html).toContain('Entrada manual');
    expect(html).not.toContain('Recebimento nacional (NF)');
    expect(html).toContain('[NF: 12345]');
    expect(html).toContain('[Produto: PP H301]');
    expect(html).toContain('[Quantidade: 1.250,5 kg]');
    expect(html).toContain('[Local: SANTO ANDRÉ (NACIONAL)]');
  });

  it('outro tipo de aprovação (sem contexto): assunto e corpo genéricos', async () => {
    executeMock.mockResolvedValue({ rows: [] });

    await enviarNotificacaoAprovacaoOperador({ operadorUserId: 'u1', aprovacaoId: 'a1', tipoAprovacao: 'saida_amostra' });

    const { subject, html } = ultimoEmail();
    expect(subject).toBe('StockBridge — Lançamento aprovado (Amostra/Brinde)');
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
  it('formulário manual rejeitado: assunto com a NF digitada', async () => {
    executeMock.mockResolvedValue({
      rows: [{ por_nf: false, nota_fiscal: '777', fornecedor: null, item_nf: null, produto: 'PP H301', quantidade_kg: '500', local: '11.2' }],
    });

    await enviarNotificacaoRejeicaoOperador({
      operadorUserId: 'u1', aprovacaoId: 'ap2', loteId: 'mov2', motivo: 'NF errada', fluxo: 'recebimento', tipoAprovacao: 'entrada_manual',
    });

    expect(ultimoEmail().subject).toBe('StockBridge — Entrada manual rejeitada — NF 777');
  });

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
