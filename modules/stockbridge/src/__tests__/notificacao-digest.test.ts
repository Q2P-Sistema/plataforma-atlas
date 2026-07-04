import { describe, it, expect, vi, beforeEach } from 'vitest';

// EML-09/13: os e-mails de recebimento nacional e de comodato vencido passaram a
// ser DIGESTS — 1 e-mail por destinatário em vez de 1 por item/comodato.

const { sendEmailMock, loggerMock, config } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue(undefined),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  config: {
    APP_URL: 'https://atlas.local',
    MODULE_STOCKBRIDGE_ENABLED: true,
    SEED_ADMIN_EMAIL: 'admin@acxe.local',
  } as Record<string, unknown>,
}));

// getDb().select().from().innerJoin().where() → lista de aprovadores (gestores)
const gestoresMock = vi.fn().mockResolvedValue([
  { email: 'gestor1@acxe.local' },
  { email: 'gestor2@acxe.local' },
]);

vi.mock('@atlas/core', () => ({
  createLogger: () => loggerMock,
  getConfig: () => config,
  getDb: () => ({
    select: () => ({ from: () => ({ innerJoin: () => ({ where: () => gestoresMock() }) }) }),
  }),
  sendEmail: sendEmailMock,
  // Devolve o corpo cru pra podermos inspecionar o conteúdo montado.
  buildEmailLayout: (o: { corpoHtml?: string; ctaLabel?: string }) => ({
    html: `${o?.corpoHtml ?? ''}||CTA:${o?.ctaLabel ?? ''}`,
    text: '',
  }),
  escapeHtml: (v: unknown) => String(v ?? ''),
  emailActionBox: (html: string, titulo?: string) => `[ACTIONBOX:${titulo ?? ''}]${html}`,
  emailDataList: () => '',
}));
vi.mock('@atlas/db', () => ({ users: {}, userModules: {} }));

import {
  enviarAlertaRecebimentoNacionalLote,
  enviarDigestComodatosVencidos,
  type ComodatoVencidoDigestItem,
} from '../services/notificacao.service.js';

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(undefined);
  gestoresMock.mockClear();
  loggerMock.info.mockClear();
  loggerMock.error.mockClear();
});

describe('EML-09 — recebimento nacional: 1 e-mail por gestor (não N itens × M gestores)', () => {
  it('3 itens + 2 gestores → 2 e-mails, cada um listando os 3 produtos', async () => {
    await enviarAlertaRecebimentoNacionalLote({
      notaFiscal: '12345',
      nivel: 'gestor',
      itens: [
        { produto: 'PP H301', empresa: 'acxe', galpao: '11', quantidadeKg: 1000 },
        { produto: 'PEAD F200', empresa: 'q2p', galpao: '21', quantidadeKg: 2500 },
        { produto: 'PVC K57', empresa: 'acxe', galpao: '12', quantidadeKg: 800 },
      ],
    });

    // 2 gestores → 2 e-mails (NÃO 6). Este é o coração do EML-09.
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    const tos = sendEmailMock.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(new Set(tos)).toEqual(new Set(['gestor1@acxe.local', 'gestor2@acxe.local']));

    // Cada e-mail lista os 3 produtos e a NF.
    for (const call of sendEmailMock.mock.calls) {
      const { html, subject } = call[0] as { html: string; subject: string };
      expect(html).toContain('PP H301');
      expect(html).toContain('PEAD F200');
      expect(html).toContain('PVC K57');
      expect(subject).toContain('12345');
      expect(subject).toContain('3 itens');
    }
  });

  it('lista vazia → nenhum e-mail', async () => {
    await enviarAlertaRecebimentoNacionalLote({ notaFiscal: '9', nivel: 'gestor', itens: [] });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // EML-10: quando TODOS os envios falham, não pode logar "enviado" e cada
  // destinatário que falhou tem de aparecer num error.
  it('100% de falha → nenhum info de sucesso + 1 error por destinatário', async () => {
    sendEmailMock.mockRejectedValue(new Error('SMTP 550'));
    await enviarAlertaRecebimentoNacionalLote({
      notaFiscal: '77',
      nivel: 'gestor',
      itens: [{ produto: 'PP', empresa: 'acxe', galpao: '11', quantidadeKg: 100 }],
    });
    // 2 gestores falharam → 2 errors por destinatário, motivo capturado.
    const perDest = loggerMock.error.mock.calls.filter(
      (c) => (c[1] as string) === 'Falha ao enviar e-mail para destinatário',
    );
    expect(perDest).toHaveLength(2);
    expect((perDest[0]![0] as { motivo: string }).motivo).toBe('SMTP 550');
    // Nenhum "enviado com sucesso".
    const infoMsgs = loggerMock.info.mock.calls.map((c) => c[1] as string);
    expect(infoMsgs).not.toContain('Digest de recebimento nacional enviado');
  });
});

describe('EML-13 — comodato: 1 digest por destinatário com todos os comodatos', () => {
  const base: Omit<ComodatoVencidoDigestItem, 'cliente' | 'diasVencido' | 'fase'> = {
    movimentacaoId: 'm1',
    produtoCodigoAcxe: 5678,
    produtoDescricao: 'PP H301',
    quantidadeKg: 500,
    galpaoOrigem: '11',
    dtSaida: '2026-05-01',
    dtPrevistaRetorno: '2026-06-01',
  };

  it('3 comodatos para o mesmo destinatário → 1 e-mail listando os 3', async () => {
    await enviarDigestComodatosVencidos({
      to: 'gestor1@acxe.local',
      comodatos: [
        { ...base, movimentacaoId: 'a', cliente: 'Cliente A', diasVencido: 1, fase: 'inicial' },
        { ...base, movimentacaoId: 'b', cliente: 'Cliente B', diasVencido: 5, fase: 'inicial' },
        { ...base, movimentacaoId: 'c', cliente: 'Cliente C', diasVencido: 3, fase: 'inicial' },
      ],
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const { to, html, subject } = sendEmailMock.mock.calls[0]![0] as { to: string; html: string; subject: string };
    expect(to).toBe('gestor1@acxe.local');
    expect(html).toContain('Cliente A');
    expect(html).toContain('Cliente B');
    expect(html).toContain('Cliente C');
    expect(subject).toContain('3 comodatos vencidos');
    // Nenhum escalado → sem action box e sem tag [Escalado].
    expect(html).not.toContain('[ACTIONBOX');
    expect(subject).not.toContain('[Escalado]');
  });

  it('inclui a action box de escalada quando algum comodato está escalado', async () => {
    await enviarDigestComodatosVencidos({
      to: 'diretor@acxe.local',
      comodatos: [
        { ...base, cliente: 'Cliente A', diasVencido: 1, fase: 'inicial' },
        { ...base, cliente: 'Cliente B', diasVencido: 30, fase: 'escalada' },
      ],
    });

    const { html, subject } = sendEmailMock.mock.calls[0]![0] as { html: string; subject: string };
    expect(html).toContain('[ACTIONBOX');
    expect(subject).toContain('[Escalado]');
  });

  it('lista vazia → nenhum e-mail', async () => {
    await enviarDigestComodatosVencidos({ to: 'x@acxe.local', comodatos: [] });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
