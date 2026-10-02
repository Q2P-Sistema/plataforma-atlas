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
    STOCKBRIDGE_OPS_EMAIL: 'ops@q2p.local',
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

import { enviarAlertaNfDispensada, enviarAlertaDispensaRevertida, enviarAlertaEspelhoRecebimentosDefasado, getFiscalEmails } from '../services/notificacao.service.js';

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
    expect(html).toContain('sem conta a pagar gerada pelo recebimento');
    // a situacao vem do espelho no momento da dispensa: o texto pede conferencia no OMIE (ROT-9)
    expect(html).toContain('Pelo espelho do OMIE no momento da dispensa');
    expect(html).toContain('Confira no OMIE antes de agir');
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

describe('enviarAlertaDispensaRevertida (revisao pre-UAT, ROT-4)', () => {
  const rev = {
    notaFiscal: '6842',
    fornecedorNome: 'REPLAS COMERCIAL LTDA',
    situacaoFiscalNaDispensa: 'pendente' as const,
    motivoReversao: 'A carga chegou afinal',
    revertidoPorNome: 'Flavio Endo',
    revertidoEm: '2026-10-03T12:00:00.000Z',
  };

  it('1 e-mail por destinatario, assunto com NF e fornecedor, corpo com motivo/quem e o pedido de avisar o gestor se ja agiu no OMIE', async () => {
    await enviarAlertaDispensaRevertida(rev);
    const enviados = emails();
    expect(enviados).toHaveLength(3);
    for (const e of enviados) expect(e.subject).toBe('StockBridge — Dispensa desfeita: NF 6842 (REPLAS COMERCIAL LTDA) voltou à fila');
    const { html } = enviados[0]!;
    expect(html).toContain('[info:Dispensa de NF desfeita]');
    expect(html).toContain('[Motivo da reversão: A carga chegou afinal]');
    expect(html).toContain('[Desfeita por: Flavio Endo]');
    expect(html).toContain('também concluirá o recebimento fiscal no OMIE');
    expect(html).toContain('avise o gestor');
  });

  it('dispensa de NF com fiscal ja feito: nao promete concluir o fiscal; lista vazia nao envia', async () => {
    await enviarAlertaDispensaRevertida({ ...rev, situacaoFiscalNaDispensa: 'concluido' });
    expect(emails()[0]!.html).not.toContain('também concluirá o recebimento fiscal');
    sendEmailMock.mockClear();
    configMock.STOCKBRIDGE_FISCAL_EMAILS = [];
    await enviarAlertaDispensaRevertida(rev);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('enviarAlertaEspelhoRecebimentosDefasado (revisao pre-UAT, ROT-6)', () => {
  it('vai para STOCKBRIDGE_OPS_EMAIL com a idade, o limite, o impacto na fila e o que verificar (n8n e copia do UAT)', async () => {
    await enviarAlertaEspelhoRecebimentosDefasado({ status: 'degraded', idadeMin: 185.4, limiteMin: 120 });
    const enviados = emails();
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.to).toBe('ops@q2p.local');
    expect(enviados[0]!.subject).toBe('StockBridge — Espelho de recebimentos de NF-e sem atualização');
    const { html } = enviados[0]!;
    expect(html).toContain('[alerta:Espelho de recebimentos de NF-e sem atualização]');
    expect(html).toContain('não é atualizado há 185 minutos (limite: 120 minutos)');
    expect(html).toContain('podem não aparecer na fila de recebimento');
    expect(html).toContain('Q2P - Exporta Recebimentos NF-e');
    expect(html).toContain('cópia do espelho de produção para o UAT');
  });

  it('vazio e inacessivel tem texto proprio; falha de envio nao propaga', async () => {
    await enviarAlertaEspelhoRecebimentosDefasado({ status: 'sem_dados', idadeMin: null, limiteMin: 120 });
    expect(emails().at(-1)!.html).toContain('está vazio');
    await enviarAlertaEspelhoRecebimentosDefasado({ status: 'indisponivel', idadeMin: null, limiteMin: 120 });
    expect(emails().at(-1)!.html).toContain('não pôde ser lido');
    sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));
    await expect(enviarAlertaEspelhoRecebimentosDefasado({ status: 'degraded', idadeMin: 300, limiteMin: 120 })).resolves.toBeUndefined();
  });
});
