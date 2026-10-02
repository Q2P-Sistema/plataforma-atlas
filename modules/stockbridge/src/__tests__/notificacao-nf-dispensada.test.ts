import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 016 (FR-026, ACXEGDP-395), T045 — e-mail ao FISCAL quando o gestor
// dispensa uma NF da fila. Um e-mail por destinatario de STOCKBRIDGE_FISCAL_EMAILS;
// o corpo diz o que fica pendente no OMIE conforme a situacao fiscal; nada de
// codigo OMIE. Padrao do notificacao-recebimento-nacional-nf.test.ts.

const { sendEmailMock, loggerMock, configMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue(undefined),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  configMock: {
    APP_URL: 'https://atlas.local',
    STOCKBRIDGE_FISCAL_EMAILS: ['nfe@acxe-polimeros.com.br', 'mauricio@acxe-polimeros.com.br', 'gustavo.dreer@acxe-polimeros.com.br'] as string[],
  },
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => loggerMock,
  getConfig: () => configMock,
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }), execute: vi.fn() }),
  sendEmail: sendEmailMock,
  buildEmailLayout: (o: { titulo?: string; variante?: string; corpoHtml?: string; ctaUrl?: string }) => ({
    html: `[${o?.variante ?? ''}:${o?.titulo ?? ''}]${o?.corpoHtml ?? ''}||URL:${o?.ctaUrl ?? ''}`,
    text: '',
  }),
  escapeHtml: (v: unknown) => String(v ?? ''),
  emailActionBox: (html: string, titulo?: string) => `[${titulo ?? 'Ação necessária'}]${html}`,
  emailDataList: (linhas: Array<{ label: string; valor: string | number | null | undefined }>) =>
    linhas.filter((l) => l.valor !== '' && l.valor != null).map((l) => `[${l.label}: ${l.valor}]`).join(''),
}));
vi.mock('@atlas/db', () => ({ users: {}, userModules: {} }));

import { enviarAlertaNfDispensada, getFiscalEmails } from '../services/notificacao.service.js';

const base = {
  notaFiscal: '6842',
  fornecedorNome: 'REPLAS COMERCIAL LTDA',
  situacaoFiscalNaDispensa: 'pendente' as const,
  valorNfBrl: 203400,
  motivo: 'Carga nunca chegou; fornecedor vai cancelar a nota',
  dispensadoPorNome: 'Flavio Endo',
  dispensadoEm: '2026-10-02T13:00:00.000Z',
};

const emails = () => sendEmailMock.mock.calls.map((c) => c[0] as { to: string; subject: string; html: string });

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(undefined);
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
  configMock.STOCKBRIDGE_FISCAL_EMAILS = ['nfe@acxe-polimeros.com.br', 'mauricio@acxe-polimeros.com.br', 'gustavo.dreer@acxe-polimeros.com.br'];
});

describe('getFiscalEmails', () => {
  it('le a lista da config; string separada por virgula tambem e aceita; vazio -> []', () => {
    expect(getFiscalEmails()).toHaveLength(3);
    (configMock as { STOCKBRIDGE_FISCAL_EMAILS: unknown }).STOCKBRIDGE_FISCAL_EMAILS = ' a@x.com , b@x.com ,, ';
    expect(getFiscalEmails()).toEqual(['a@x.com', 'b@x.com']);
    (configMock as { STOCKBRIDGE_FISCAL_EMAILS: unknown }).STOCKBRIDGE_FISCAL_EMAILS = [];
    expect(getFiscalEmails()).toEqual([]);
  });
});

describe('enviarAlertaNfDispensada', () => {
  it('1 e-mail por destinatario, mesmo assunto com NF e fornecedor, sem lista no To', async () => {
    await enviarAlertaNfDispensada(base);
    const enviados = emails();
    expect(enviados).toHaveLength(3);
    expect(new Set(enviados.map((e) => e.to))).toEqual(new Set(configMock.STOCKBRIDGE_FISCAL_EMAILS));
    for (const e of enviados) {
      expect(e.subject).toBe('StockBridge — NF 6842 (REPLAS COMERCIAL LTDA) dispensada da fila');
      expect(e.to).not.toContain(',');
    }
  });

  it('fiscal PENDENTE: corpo diz que a nota segue na caixa de Recebimento de NF-e aguardando manifestacao/cancelamento e que nao ha conta a pagar', async () => {
    await enviarAlertaNfDispensada(base);
    const { html } = emails()[0]!;
    expect(html).toContain('[alerta:NF dispensada da fila de recebimento]');
    expect(html).toContain('[Pendência no OMIE]');
    expect(html).toContain('aguardando manifestação ou cancelamento');
    expect(html).toContain('Nenhuma conta a pagar foi gerada');
    expect(html).toContain('[Recebimento fiscal no OMIE: Pendente (não concluído)]');
    expect(html).toContain('[Motivo da dispensa: Carga nunca chegou; fornecedor vai cancelar a nota]');
    expect(html).toContain('[Dispensada por: Flavio Endo]');
    expect(html).toContain('[Valor da nota: R$');
    expect(html).toContain('URL:https://atlas.local/stockbridge/aprovacoes');
    // a dispensa nao mexe no OMIE — o texto deixa isso explicito ao fiscal
    expect(html).toContain('não alterou nada no OMIE');
  });

  it('fiscal CONCLUIDO: corpo fala da conta a pagar de R$ N a estornar ou manter', async () => {
    await enviarAlertaNfDispensada({ ...base, situacaoFiscalNaDispensa: 'concluido' });
    const { html } = emails()[0]!;
    expect(html).toContain('JÁ foi concluído no OMIE');
    expect(html).toMatch(/conta a pagar de R\$\s?203\.400,00 a estornar ou manter/);
    expect(html).toContain('[Recebimento fiscal no OMIE: Concluído]');
    expect(html).not.toContain('aguardando manifestação');
  });

  it('fornecedor nulo vira "Fornecedor não identificado no OMIE"; nome do gestor ausente e omitido do card', async () => {
    await enviarAlertaNfDispensada({ ...base, fornecedorNome: null, dispensadoPorNome: null });
    const { subject, html } = emails()[0]!;
    expect(subject).toBe('StockBridge — NF 6842 (Fornecedor não identificado no OMIE) dispensada da fila');
    expect(html).not.toContain('[Dispensada por:');
  });

  it('lista vazia: nenhum envio e warn', async () => {
    configMock.STOCKBRIDGE_FISCAL_EMAILS = [];
    await enviarAlertaNfDispensada(base);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it('falha do sendEmail em um destinatario nao propaga e e logada; os demais seguem', async () => {
    sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));
    await expect(enviarAlertaNfDispensada(base)).resolves.toBeUndefined();
    expect(sendEmailMock).toHaveBeenCalledTimes(3);
    expect(loggerMock.error).toHaveBeenCalled();
  });
});
