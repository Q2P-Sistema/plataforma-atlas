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

vi.mock('@atlas/core', async () => ({
  ...(await import('./helpers/email-q2p.js')),
  createLogger: () => loggerMock,
  getConfig: () => configMock,
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }), execute: vi.fn() }),
  sendEmail: sendEmailMock,
}));
vi.mock('@atlas/db', () => ({ users: {}, userModules: {} }));

import {
  enviarAlertaNfDispensada,
  enviarAlertaDispensaRevertida,
  enviarAlertaEspelhoRecebimentosDefasado,
  enviarAlertaCopiaPcsDefasada,
  getFiscalEmails,
} from '../services/notificacao.service.js';

const base = {
  notaFiscal: '6842',
  fornecedorNome: 'REPLAS COMERCIAL LTDA',
  situacaoFiscalNaDispensa: 'pendente' as const,
  valorNfBrl: 203400,
  motivo: 'Carga nunca chegou; fornecedor vai cancelar a nota',
  dispensadoPorNome: 'Flavio Endo',
  dispensadoEm: '2026-10-02T13:00:00.000Z',
};

const emails = () => sendEmailMock.mock.calls.map((c) => c[0] as { to: string; subject: string; html: string; text: string });

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
      expect(e.subject).toBe('[AÇÃO REQUERIDA] - Fiscal - NF dispensada da fila - REPLAS COMERCIAL LTDA - NF 6842');
      expect(e.to).not.toContain(',');
    }
  });

  it('fiscal PENDENTE: corpo diz que a nota segue na caixa de Recebimento de NF-e aguardando manifestacao/cancelamento e que nao ha conta a pagar', async () => {
    await enviarAlertaNfDispensada(base);
    const { html, text } = emails()[0]!;
    expect(html).toContain('Fiscal: NF dispensada da fila de recebimento');
    expect(html).toContain('NF 6842 · REPLAS COMERCIAL LTDA · R$ 203.400,00');
    expect(html).toContain('Quem age: <strong>Fiscal</strong>');
    expect(html).toContain('ainda <strong>não tinha sido concluído</strong>');
    expect(html).toContain('etapa &quot;Faturado pelo fornecedor&quot;');
    expect(html).toContain('sem conta a pagar gerada pelo recebimento');
    expect(html).toContain('manifestação, recusa ou cancelamento');
    // a situacao vem do espelho no momento da dispensa: o texto pede conferencia no OMIE (ROT-9)
    expect(html).toContain('Confira a nota no OMIE.');
    expect(html).toContain('A situação acima é a que o Atlas tinha na hora da dispensa e pode ter mudado.');
    expect(text).toContain('Motivo da dispensa: Carga nunca chegou; fornecedor vai cancelar a nota');
    expect(text).toContain('Dispensada por: Flavio Endo');
    expect(text).toContain('Quando: 02/10/2026 às 10:00');
    // ACXEGDP-440: sem botão — o fiscal age no OMIE
    expect(html).not.toContain('<a href');
    // a dispensa nao mexe no OMIE — o texto deixa isso explicito ao fiscal
    expect(html).toContain('nada mudou no OMIE');
  });

  it('fiscal CONCLUIDO: corpo fala da conta a pagar de R$ N a estornar ou manter', async () => {
    await enviarAlertaNfDispensada({ ...base, situacaoFiscalNaDispensa: 'concluido' });
    const { html } = emails()[0]!;
    expect(html).toContain('já tinha sido <strong>concluído</strong> no OMIE: existe conta a pagar de R$ 203.400,00.');
    expect(html).toContain('Estorne ou mantenha a conta a pagar no OMIE, conforme o acerto com o fornecedor.');
    expect(html).not.toContain('manifestação');
  });

  it('fornecedor nulo vira "Fornecedor não identificado no OMIE"; nome do gestor ausente e omitido do card', async () => {
    await enviarAlertaNfDispensada({ ...base, fornecedorNome: null, dispensadoPorNome: null });
    const { subject, html, text } = emails()[0]!;
    // ACXEGDP-440: sem nome, o fornecedor sai do assunto; o corpo avisa que o OMIE não o identificou
    expect(subject).toBe('[AÇÃO REQUERIDA] - Fiscal - NF dispensada da fila - NF 6842');
    expect(html).toContain('NF 6842 · Fornecedor não identificado no OMIE');
    expect(text).not.toContain('Dispensada por:');
  });

  // Feature 017 (T044, caso de borda "Dispensa de NF"): o fiscal fica sabendo qual PC
  // ficou com quantidade recebida no OMIE — so o numero legivel, nunca id interno.
  it('017: cita o PC vinculado a cada item; numero desconhecido vira "PC vinculado no OMIE"', async () => {
    await enviarAlertaNfDispensada({
      ...base,
      situacaoFiscalNaDispensa: 'concluido',
      pcsPorItem: [
        { descricao: 'SUCATA PLASTICO', pcNumero: '304' },
        { descricao: 'SUCATA PP', pcNumero: '' },
      ],
    });
    const { html, text } = emails()[0]!;
    expect(text).toContain('Pedido de compra vinculado: SUCATA PLASTICO: PC 304; SUCATA PP: PC vinculado no OMIE');
    expect(html).not.toMatch(/\d{10}/);
  });

  it('017: sem PC vinculado, a linha de pedido de compra nao aparece', async () => {
    await enviarAlertaNfDispensada({ ...base, pcsPorItem: [] });
    expect(emails()[0]!.html).not.toContain('Pedido de compra vinculado');
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
    for (const e of enviados) expect(e.subject).toBe('[INFORMATIVO] - Fiscal - Dispensa desfeita - REPLAS COMERCIAL LTDA - NF 6842');
    const { html, text } = enviados[0]!;
    expect(html).toContain('Fiscal: dispensa de NF desfeita');
    expect(text).toContain('Motivo da reversão: A carga chegou afinal');
    expect(text).toContain('Desfeita por: Flavio Endo');
    expect(html).toContain('também vai concluir o recebimento fiscal no OMIE');
    expect(html).toContain('avise o gestor');
    expect(html).not.toContain('<a href');
  });

  it('dispensa de NF com fiscal ja feito: nao promete concluir o fiscal; lista vazia nao envia', async () => {
    await enviarAlertaDispensaRevertida({ ...rev, situacaoFiscalNaDispensa: 'concluido' });
    expect(emails()[0]!.html).not.toContain('também vai concluir o recebimento fiscal');
    sendEmailMock.mockClear();
    configMock.STOCKBRIDGE_FISCAL_EMAILS = [];
    await enviarAlertaDispensaRevertida(rev);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('enviarAlertaEspelhoRecebimentosDefasado (revisao pre-UAT, ROT-6)', () => {
  it('vai para STOCKBRIDGE_OPS_EMAIL com a idade, o limite, o impacto na fila e o que verificar (n8n e copia do UAT)', async () => {
    // devolve true quando o e-mail foi entregue ao provedor (o job so suprime o reaviso depois disso)
    expect(await enviarAlertaEspelhoRecebimentosDefasado({ status: 'degraded', idadeMin: 185.4, limiteMin: 120 })).toBe(true);
    const enviados = emails();
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.to).toBe('ops@q2p.local');
    expect(enviados[0]!.subject).toBe('[AÇÃO REQUERIDA] - Infra - Espelho de recebimentos parado - Q2P');
    const { html } = enviados[0]!;
    expect(html).toContain('Infra: espelho de recebimentos de NF-e parado');
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
    await expect(enviarAlertaEspelhoRecebimentosDefasado({ status: 'degraded', idadeMin: 300, limiteMin: 120 })).resolves.toBe(false);
  });
});

// Feature 017 (research D13, FR-030) e revisao pos-017 (infra-03): alerta da copia de pedidos
// de compra ao ops; devolve se o e-mail foi entregue, sem nunca lancar.
describe('enviarAlertaCopiaPcsDefasada (feature 017, D13)', () => {
  it('vai para STOCKBRIDGE_OPS_EMAIL com a idade, o limite e o impacto (modo seguro), e devolve true', async () => {
    expect(await enviarAlertaCopiaPcsDefasada({ status: 'degraded', idadeMin: 240.2, limiteMin: 120 })).toBe(true);
    const enviados = emails();
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.to).toBe('ops@q2p.local');
    expect(enviados[0]!.subject).toBe('[AÇÃO REQUERIDA] - Infra - Cópia de pedidos de compra parada - Q2P');
    const { html } = enviados[0]!;
    expect(html).toContain('Infra: cópia de pedidos de compra parada');
    expect(html).toContain('não é atualizada há 240 minutos (limite: 120 minutos)');
    expect(html).toContain('fica bloqueado no StockBridge');
  });

  it('vazia e inacessivel tem texto proprio; falha de envio nao propaga, e logada e devolve false', async () => {
    await enviarAlertaCopiaPcsDefasada({ status: 'sem_dados', idadeMin: null, limiteMin: 120 });
    expect(emails().at(-1)!.html).toContain('está vazia');
    await enviarAlertaCopiaPcsDefasada({ status: 'indisponivel', idadeMin: null, limiteMin: 120 });
    expect(emails().at(-1)!.html).toContain('não pôde ser lida');
    sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));
    await expect(enviarAlertaCopiaPcsDefasada({ status: 'degraded', idadeMin: 300, limiteMin: 120 })).resolves.toBe(false);
    expect(loggerMock.error).toHaveBeenCalled();
  });
});
