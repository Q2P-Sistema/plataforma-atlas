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

vi.mock('@atlas/core', async () => ({
  ...(await import('./helpers/email-q2p.js')),
  createLogger: () => loggerMock,
  getConfig: () => ({ APP_URL: 'https://atlas.local' }),
  getDb: () => ({
    // resolverEmailOperador: select().from().where().limit()
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ email: 'operador@q2p.local' }]) }) }) }),
    execute: executeMock,
  }),
  sendEmail: sendEmailMock,
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
  return sendEmailMock.mock.calls.at(-1)![0] as { subject: string; html: string; text: string };
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

    const { subject, html, text } = ultimoEmail();
    // ACXEGDP-440: o fornecedor sai do assunto (quem lançou já sabe) e vai no subtítulo.
    expect(subject).toBe('[INFORMATIVO] - Recebimento - Aprovado - NF 6842');
    expect(html).toContain('Recebimento nacional (NF)');
    expect(html).not.toContain('Entrada manual');
    expect(text).toContain('NF 6842 · REPLAS COMERCIAL LTDA');
    expect(text).toContain('Item da NF: SUCATA PLASTICO');
    expect(text).toContain('Produto: PS CRISTAL A');
    expect(text).toContain('Quantidade: 18.000 kg');
    expect(text).toContain('Local: SANTO ANDRÉ (NACIONAL)');
  });

  it('formulário manual: mesmo padrão da fila, com "manual" no começo do assunto', async () => {
    executeMock.mockResolvedValue({
      rows: [{ por_nf: false, nota_fiscal: '12345', fornecedor: null, item_nf: null, produto: 'PP H301', quantidade_kg: '1250.500', local: 'SANTO ANDRÉ (NACIONAL)' }],
    });

    await enviarNotificacaoAprovacaoOperador({ operadorUserId: 'u1', aprovacaoId: 'a1', tipoAprovacao: 'entrada_manual' });

    const { subject, html, text } = ultimoEmail();
    expect(subject).toBe('[INFORMATIVO] - Recebimento manual - Aprovado - NF 12345');
    expect(html).toContain('Recebimento nacional (manual)');
    expect(html).not.toContain('Entrada manual');
    expect(text).not.toContain('Item da NF:');
    expect(text).toContain('\nNF 12345\n');
    expect(text).toContain('Produto: PP H301');
    expect(text).toContain('Quantidade: 1.250,5 kg');
    expect(text).toContain('Local: SANTO ANDRÉ (NACIONAL)');
  });

  it('outro tipo de aprovação (sem contexto): assunto e corpo genéricos', async () => {
    executeMock.mockResolvedValue({ rows: [] });

    await enviarNotificacaoAprovacaoOperador({ operadorUserId: 'u1', aprovacaoId: 'a1', tipoAprovacao: 'saida_amostra' });

    const { subject, text } = ultimoEmail();
    expect(subject).toBe('[INFORMATIVO] - Lançamento - Aprovado - Amostra/Brinde');
    expect(text).not.toMatch(/\bNF\b/);
  });

  it('divergência aprovada: com pendência no OMIE o e-mail não diz que o ajuste entrou nas duas empresas (ACXEGDP-440)', async () => {
    executeMock.mockResolvedValue({ rows: [] });
    await enviarNotificacaoAprovacaoOperador({ operadorUserId: 'u1', aprovacaoId: 'a1', tipoAprovacao: 'recebimento_divergencia', incluirComex: true });
    expect(ultimoEmail().text).toContain('O ajuste foi lançado no OMIE (ACXE e Q2P) com a quantidade aprovada.');
    await enviarNotificacaoAprovacaoOperador({ operadorUserId: 'u1', aprovacaoId: 'a1', tipoAprovacao: 'recebimento_divergencia', pendenciaOmie: true });
    const { text } = ultimoEmail();
    expect(text).toContain('Parte do lançamento no OMIE ficou pendente: o Gestor do Sistema Integrador vai concluir.');
    expect(text).not.toContain('O ajuste foi lançado no OMIE (ACXE e Q2P)');
  });

  it('falha ao ler o contexto não impede o e-mail: cai no texto genérico', async () => {
    executeMock.mockRejectedValue(new Error('db fora'));

    await enviarNotificacaoAprovacaoOperador({ operadorUserId: 'u1', aprovacaoId: 'a1', tipoAprovacao: 'entrada_manual' });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(ultimoEmail().subject).toBe('[INFORMATIVO] - Lançamento - Aprovado - Entrada manual');
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

    // ACXEGDP-440: no manual a situação fica só "Rejeitado", para caber nos 76 caracteres.
    expect(ultimoEmail().subject).toBe('[AÇÃO REQUERIDA] - Recebimento manual - Rejeitado - NF 777');
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

    const { subject, html, text } = ultimoEmail();
    expect(subject).toBe('[AÇÃO REQUERIDA] - Recebimento - Rejeitado, corrigir e reenviar - NF 6842');
    expect(text).toContain('Produto: PS CRISTAL A');
    expect(html).toContain('peso não confere');
    expect(html).toContain('href="https://atlas.local/stockbridge/fila#rejeicao=ap1"');
  });
});
