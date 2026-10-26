import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ACXEGDP-440: cópia oculta no envio, sem endereço repetido entre Para, Cc e Cco (o SendGrid recusa), e o
// remetente com o mesmo nome dos fluxos do n8n.

const sendgrid = { setApiKey: vi.fn(), setTimeout: vi.fn(), send: vi.fn() };
vi.mock('@sendgrid/mail', () => ({ default: sendgrid }));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const ENV_ORIGINAL = { ...process.env };

function envBase(extra: Record<string, string>): void {
  process.env = {
    ...ENV_ORIGINAL,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'test_secret_with_at_least_32_chars_xx',
    ...extra,
  };
  for (const k of ['ATLAS_ENV', 'OMIE_MODE', 'EMAIL_DESVIO_PARA', 'SENDGRID_API_KEY', 'SENDGRID_API_KEY_DESVIO', 'SENDGRID_FROM_EMAIL']) {
    if (!(k in extra)) delete process.env[k];
  }
}

/** config.ts guarda o resultado em módulo — cada cenário importa uma cópia nova. */
async function importarFresco() {
  vi.resetModules();
  return import('../email.js');
}

const email = {
  to: ' gustavo.dreer@acxe-polimeros.com.br ',
  cc: ['GUSTAVO.DREER@acxe-polimeros.com.br', 'comex_acxe@acxe-polimeros.com.br', 'Comex_Acxe@acxe-polimeros.com.br', ' '],
  bcc: ['comex_acxe@acxe-polimeros.com.br', 'flavio.endo@acxe-polimeros.com.br', ' FLAVIO.ENDO@acxe-polimeros.com.br ', 'gustavo.dreer@acxe-polimeros.com.br'],
  subject: '[INFORMATIVO] - Recebimento - Aprovado - NF 6842',
  html: '<!DOCTYPE html><html><body style="margin:0"><p>corpo</p></body></html>',
  text: 'corpo',
};

describe('sendEmail — cópia oculta e remetente (ACXEGDP-440)', () => {
  beforeEach(() => {
    sendgrid.send.mockReset();
  });
  afterEach(() => {
    process.env = { ...ENV_ORIGINAL };
  });

  it('produção: Cco enviado, sem repetição entre Para, Cc e Cco, e remetente "Sistema Integrador Q2P"', async () => {
    envBase({ NODE_ENV: 'production', SENDGRID_API_KEY: 'SG.x', SENDGRID_FROM_EMAIL: 'sistema@q2p.com.br' });
    const { sendEmail } = await importarFresco();
    await sendEmail(email);
    const enviado = sendgrid.send.mock.calls[0]![0];
    expect(enviado.to).toBe('gustavo.dreer@acxe-polimeros.com.br');
    expect(enviado.cc).toEqual(['comex_acxe@acxe-polimeros.com.br']);
    expect(enviado.bcc).toEqual(['flavio.endo@acxe-polimeros.com.br']);
    expect(enviado.from).toEqual({ email: 'sistema@q2p.com.br', name: 'Sistema Integrador Q2P' });
  });

  it('sem Cco (ou só com quem já está em Para/Cc) não manda o campo', async () => {
    envBase({ NODE_ENV: 'production', SENDGRID_API_KEY: 'SG.x', SENDGRID_FROM_EMAIL: 'sistema@q2p.com.br' });
    const { sendEmail } = await importarFresco();
    await sendEmail({ ...email, bcc: undefined });
    await sendEmail({ ...email, bcc: ['GUSTAVO.dreer@acxe-polimeros.com.br'] });
    expect(sendgrid.send.mock.calls[0]![0].bcc).toBeUndefined();
    expect(sendgrid.send.mock.calls[1]![0].bcc).toBeUndefined();
  });

  it('UAT com desvio: a faixa diz para quem iria (já sem repetição) e o Cco não é enviado', async () => {
    envBase({
      NODE_ENV: 'production', ATLAS_ENV: 'uat', OMIE_MODE: 'leitura',
      SENDGRID_API_KEY_DESVIO: 'SG.desvio', SENDGRID_FROM_EMAIL: 'sistema@q2p.com.br',
      EMAIL_DESVIO_PARA: 'testes@acxe-polimeros.com.br',
    });
    const { sendEmail } = await importarFresco();
    await sendEmail(email);
    const enviado = sendgrid.send.mock.calls[0]![0];
    expect(enviado.to).toBe('testes@acxe-polimeros.com.br');
    expect(enviado.cc).toBeUndefined();
    expect(enviado.bcc).toBeUndefined();
    expect(enviado.html).toContain(
      'Iria para gustavo.dreer@acxe-polimeros.com.br, com cópia para comex_acxe@acxe-polimeros.com.br, com cópia oculta para flavio.endo@acxe-polimeros.com.br.',
    );
  });
});
