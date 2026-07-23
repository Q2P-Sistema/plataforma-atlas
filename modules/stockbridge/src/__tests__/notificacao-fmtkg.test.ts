import { describe, it, expect, vi, beforeEach } from 'vitest';

// ACXEGDP-176: o e-mail de aprovação de recebimento com divergência exibia
// "25.000 kg" para 25 kg — o delta era formatado com toFixed(3) (ponto decimal
// en-US), que em pt-BR se lê como VINTE E CINCO MIL quilos. Estes testes cobrem
// o formatador central fmtKg e o template afetado (enviarAlertaAprovacaoPendente).

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
const gestoresMock = vi.fn().mockResolvedValue([{ email: 'gestor1@acxe.local' }]);

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
  // Renderiza os pares label/valor pra podermos asseverar a quantidade formatada.
  emailDataList: (items: Array<{ label: string; valor: unknown }>) =>
    items.map((i) => `${i.label}: ${i.valor}`).join(' | '),
}));
vi.mock('@atlas/db', () => ({ users: {}, userModules: {} }));

import {
  fmtKg,
  enviarAlertaAprovacaoPendente,
  enviarAlertaAprovacaoPendenteImportacaoLote,
} from '../services/notificacao.service.js';

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(undefined);
  gestoresMock.mockClear();
});

describe('fmtKg — quantidade em kg no padrão pt-BR (ACXEGDP-176)', () => {
  it('inteiro sem casas decimais: 25 → "25 kg" (nunca "25.000 kg")', () => {
    expect(fmtKg(25)).toBe('25 kg');
  });

  it('fração com vírgula decimal: 25.5 → "25,5 kg"', () => {
    expect(fmtKg(25.5)).toBe('25,5 kg');
  });

  it('milhar legível sem ambiguidade: 1250 → "1.250 kg" (decimal pt-BR é vírgula)', () => {
    // Em pt-BR o ponto é SEMPRE milhar — não há leitura como "1,25 kg" porque
    // fração aparece com vírgula (caso abaixo).
    expect(fmtKg(1250)).toBe('1.250 kg');
    expect(fmtKg(1250.75)).toBe('1.250,75 kg');
  });

  it('até 3 casas decimais (escala NUMERIC(,3) do banco): 0.125 → "0,125 kg"', () => {
    expect(fmtKg(0.125)).toBe('0,125 kg');
  });

  it('string numérica vinda de coluna NUMERIC do Postgres: "25.000" → "25 kg"', () => {
    // Drizzle/pg devolvem NUMERIC como string com ponto DECIMAL en-US. Antes,
    // a string atravessava o toLocaleString sem conversão e o e-mail exibia
    // "25.000 kg" — exatamente o repro da ACXEGDP-176.
    expect(fmtKg('25.000')).toBe('25 kg');
    expect(fmtKg('1250.500')).toBe('1.250,5 kg');
  });

  it('valor não numérico não vaza "NaN kg" no e-mail', () => {
    expect(fmtKg(Number.NaN)).toBe('—');
    expect(fmtKg('abc')).toBe('—');
  });
});

describe('enviarAlertaAprovacaoPendente — template do e-mail de divergência', () => {
  it('25 kg aparece como "25 kg" na Quantidade e no detalhe do delta', async () => {
    await enviarAlertaAprovacaoPendente({
      aprovacaoId: 'ap-1',
      tipoAprovacao: 'recebimento_divergencia',
      nivel: 'gestor',
      loteCodigo: 'LOTE-001',
      produto: 'PP H301',
      quantidadeKg: 25,
      detalhes: `Divergência faltando de ${fmtKg(25)}`,
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const { html, subject } = sendEmailMock.mock.calls[0]![0] as { html: string; subject: string };
    expect(html).toContain('Quantidade: 25 kg');
    expect(html).toContain('Divergência faltando de 25 kg');
    // Regressão ACXEGDP-176: nada no corpo pode se ler como "25 mil".
    expect(html).not.toContain('25.000');
    expect(subject).toContain('Recebimento com divergência');
  });

  it('quantidade fracionada usa vírgula decimal: 25.5 → "25,5 kg"', async () => {
    await enviarAlertaAprovacaoPendente({
      aprovacaoId: 'ap-2',
      tipoAprovacao: 'recebimento_divergencia',
      nivel: 'gestor',
      loteCodigo: 'LOTE-002',
      produto: 'PEAD F200',
      quantidadeKg: 25.5,
    });

    const { html } = sendEmailMock.mock.calls[0]![0] as { html: string };
    expect(html).toContain('Quantidade: 25,5 kg');
  });
});

describe('enviarAlertaAprovacaoPendenteImportacaoLote — digest de divergências', () => {
  it('quantidades e deltas da tabela saem no padrão pt-BR', async () => {
    await enviarAlertaAprovacaoPendenteImportacaoLote({
      notaFiscal: '12345',
      nivel: 'gestor',
      itens: [
        { produto: 'PP H301', quantidadeKg: 1250, deltaKg: -25, tipoDivergencia: 'faltando' },
        { produto: 'PVC K57', quantidadeKg: 800.5, deltaKg: -0.75, tipoDivergencia: 'varredura' },
      ],
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const { html } = sendEmailMock.mock.calls[0]![0] as { html: string };
    expect(html).toContain('1.250 kg');
    expect(html).toContain('25 kg a menos');
    expect(html).toContain('800,5 kg');
    expect(html).toContain('0,75 kg a menos');
    expect(html).not.toContain('25.000');
  });
});
