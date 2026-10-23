import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — os dois e-mails de alerta ao ops ganham a empresa (2o parametro, default
// 'q2p' = o texto de sempre). ACXE: assunto, titulo e corpo "da ACXE" e, no espelho de recebimentos, o workflow
// "ACXE - Exporta Recebimentos NF-e"; a copia de PCs segue citando o workflow unico das duas empresas.
// O texto da Q2P (sem o parametro) e coberto em notificacao-nf-dispensada.test.ts; aqui, que continua o mesmo.

const { sendEmailMock, loggerMock, configMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue(undefined),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  configMock: { APP_URL: 'https://atlas.local', STOCKBRIDGE_OPS_EMAIL: 'ops@q2p.local' },
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

import { enviarAlertaEspelhoRecebimentosDefasado, enviarAlertaCopiaPcsDefasada } from '../services/notificacao.service.js';

const emails = () => sendEmailMock.mock.calls.map((c) => c[0] as { to: string; subject: string; html: string });
const DEGRADADO = { status: 'degraded' as const, idadeMin: 185.4, limiteMin: 120 };
const VAZIO = { status: 'sem_dados' as const, idadeMin: null, limiteMin: 120 };
const INACESSIVEL = { status: 'indisponivel' as const, idadeMin: null, limiteMin: 120 };

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(undefined);
  for (const f of Object.values(loggerMock)) f.mockClear();
});

describe('enviarAlertaEspelhoRecebimentosDefasado — empresa', () => {
  it('ACXE: vai ao ops, cita a ACXE no assunto, no titulo e no corpo, e manda verificar o workflow da ACXE', async () => {
    expect(await enviarAlertaEspelhoRecebimentosDefasado(DEGRADADO, 'acxe')).toBe(true);
    const [e] = emails();
    expect(emails()).toHaveLength(1);
    expect(e!.to).toBe('ops@q2p.local');
    expect(e!.subject).toBe('StockBridge — Espelho de recebimentos de NF-e da ACXE sem atualização');
    expect(e!.html).toContain('[alerta:Espelho de recebimentos de NF-e da ACXE sem atualização]');
    expect(e!.html).toContain('O espelho de recebimentos de NF-e da ACXE não é atualizado há 185 minutos (limite: 120 minutos).');
    expect(e!.html).toContain('notas de compra nacional da ACXE que chegaram da SEFAZ');
    expect(e!.html).toContain('workflow "ACXE - Exporta Recebimentos NF-e"');
    expect(e!.html).not.toContain('Q2P - Exporta Recebimentos NF-e');
  });

  it('ACXE vazio e inacessivel tem o texto proprio, tambem "da ACXE"', async () => {
    await enviarAlertaEspelhoRecebimentosDefasado(VAZIO, 'acxe');
    expect(emails().at(-1)!.html).toContain('O espelho de recebimentos de NF-e da ACXE está vazio.');
    await enviarAlertaEspelhoRecebimentosDefasado(INACESSIVEL, 'acxe');
    expect(emails().at(-1)!.html).toContain('O espelho de recebimentos de NF-e da ACXE não pôde ser lido (tabela ausente ou erro de banco).');
  });

  it('Q2P explicita e o default sao o MESMO e-mail, com o texto de sempre (sem "da ACXE")', async () => {
    await enviarAlertaEspelhoRecebimentosDefasado(DEGRADADO);
    await enviarAlertaEspelhoRecebimentosDefasado(DEGRADADO, 'q2p');
    const [padrao, explicita] = emails();
    expect(explicita).toEqual(padrao);
    expect(padrao!.subject).toBe('StockBridge — Espelho de recebimentos de NF-e sem atualização');
    expect(padrao!.html).toContain('workflow "Q2P - Exporta Recebimentos NF-e"');
    expect(padrao!.html).toContain('O espelho de recebimentos de NF-e não é atualizado há 185 minutos');
    expect(padrao!.html).toContain('notas de compra nacional que chegaram da SEFAZ');
    expect(padrao!.html).not.toContain('ACXE');
  });

  it('falha de envio: devolve false (nunca lanca) e o log leva a empresa', async () => {
    sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));
    await expect(enviarAlertaEspelhoRecebimentosDefasado(DEGRADADO, 'acxe')).resolves.toBe(false);
    expect(loggerMock.error.mock.calls[0]![0]).toMatchObject({ empresa: 'acxe' });
  });

  it('o envio e registrado com a empresa', async () => {
    await enviarAlertaEspelhoRecebimentosDefasado(DEGRADADO, 'acxe');
    expect(loggerMock.info.mock.calls[0]![0]).toMatchObject({ empresa: 'acxe', status: 'degraded' });
  });
});

describe('enviarAlertaCopiaPcsDefasada — empresa', () => {
  it('ACXE: assunto, titulo e corpo "da ACXE"; o workflow e o unico das duas empresas', async () => {
    expect(await enviarAlertaCopiaPcsDefasada({ status: 'degraded', idadeMin: 240.2, limiteMin: 120 }, 'acxe')).toBe(true);
    const [e] = emails();
    expect(e!.to).toBe('ops@q2p.local');
    expect(e!.subject).toBe('StockBridge — Cópia de pedidos de compra da ACXE sem atualização');
    expect(e!.html).toContain('[alerta:Cópia de pedidos de compra da ACXE sem atualização]');
    expect(e!.html).toContain('A cópia local de pedidos de compra da ACXE não é atualizada há 240 minutos (limite: 120 minutos).');
    expect(e!.html).toContain('o recebimento de notas de compra nacional da ACXE com o recebimento fiscal pendente fica bloqueado');
    expect(e!.html).toContain('"ACXE e Q2P - Espelho de Pedidos de Compra (Materiais a chegar)"');
  });

  it('ACXE vazia e inacessivel', async () => {
    await enviarAlertaCopiaPcsDefasada(VAZIO, 'acxe');
    expect(emails().at(-1)!.html).toContain('A cópia local de pedidos de compra da ACXE está vazia.');
    await enviarAlertaCopiaPcsDefasada(INACESSIVEL, 'acxe');
    expect(emails().at(-1)!.html).toContain('A cópia local de pedidos de compra da ACXE não pôde ser lida (tabela ausente ou erro de banco).');
  });

  it('Q2P explicita e o default sao o MESMO e-mail, com o texto de sempre', async () => {
    await enviarAlertaCopiaPcsDefasada(DEGRADADO);
    await enviarAlertaCopiaPcsDefasada(DEGRADADO, 'q2p');
    const [padrao, explicita] = emails();
    expect(explicita).toEqual(padrao);
    expect(padrao!.subject).toBe('StockBridge — Cópia de pedidos de compra sem atualização');
    expect(padrao!.html).toContain('A cópia local de pedidos de compra não é atualizada há 185 minutos');
    expect(padrao!.html).toContain('o recebimento de notas de compra nacional com o recebimento fiscal pendente fica bloqueado');
    expect(padrao!.html).not.toContain('da ACXE');
  });

  it('falha de envio: devolve false e o log leva a empresa', async () => {
    sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));
    await expect(enviarAlertaCopiaPcsDefasada(DEGRADADO, 'acxe')).resolves.toBe(false);
    expect(loggerMock.error.mock.calls[0]![0]).toMatchObject({ empresa: 'acxe' });
  });
});
