import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ACXEGDP-405: o UAT virou ambiente de testes standalone. ATLAS_ENV=uat libera o
// OMIE em modo leitura com NODE_ENV=production, proíbe o modo real e impede que
// e-mail chegue a usuário real (desvio para EMAIL_DESVIO_PARA ou só log).

const sendgrid = { setApiKey: vi.fn(), send: vi.fn() };
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
  const config = await import('../config.js');
  const email = await import('../email.js');
  return { ...config, ...email };
}

describe('config — guardas de ambiente no boot', () => {
  afterEach(() => {
    process.env = { ...ENV_ORIGINAL };
  });

  it('produção sem ATLAS_ENV continua exigindo OMIE real (STK-15)', async () => {
    envBase({ NODE_ENV: 'production', OMIE_MODE: 'leitura' });
    const { loadConfig } = await importarFresco();
    expect(() => loadConfig()).toThrow(/OMIE_MODE=leitura com NODE_ENV=production só é aceito com ATLAS_ENV=uat/);
  });

  it('UAT com OMIE real não sobe — explícito ou por omissão', async () => {
    envBase({ NODE_ENV: 'production', ATLAS_ENV: 'uat', OMIE_MODE: 'real' });
    let m = await importarFresco();
    expect(() => m.loadConfig()).toThrow(/ATLAS_ENV=uat exige OMIE_MODE=leitura ou mock/);

    envBase({ NODE_ENV: 'production', ATLAS_ENV: 'uat' });
    m = await importarFresco();
    expect(() => m.loadConfig()).toThrow(/ATLAS_ENV=uat exige OMIE_MODE=leitura ou mock/);
  });

  it('UAT com OMIE em leitura sobe e se identifica como uat', async () => {
    envBase({ NODE_ENV: 'production', ATLAS_ENV: 'uat', OMIE_MODE: 'Leitura' });
    const { loadConfig, getAmbiente } = await importarFresco();
    const config = loadConfig();
    expect(config.OMIE_MODE).toBe('leitura');
    expect(getAmbiente(config)).toBe('uat');
  });

  it('sem ATLAS_ENV o ambiente vem do NODE_ENV', async () => {
    const { getAmbiente } = await importarFresco();
    expect(getAmbiente({ ATLAS_ENV: undefined, NODE_ENV: 'production' })).toBe('prod');
    expect(getAmbiente({ ATLAS_ENV: undefined, NODE_ENV: 'development' })).toBe('dev');
  });
});

describe('sendEmail — desvio fora de produção', () => {
  const email = {
    to: 'operador@acxe-polimeros.com.br',
    cc: ['gestor@acxe-polimeros.com.br'],
    subject: 'Recebimento aprovado',
    html: '<!DOCTYPE html><html><body style="margin:0"><p>corpo</p></body></html>',
    text: 'corpo',
  };

  beforeEach(() => {
    sendgrid.send.mockReset();
    sendgrid.setApiKey.mockReset();
  });
  afterEach(() => {
    process.env = { ...ENV_ORIGINAL };
  });

  it('UAT sem EMAIL_DESVIO_PARA não envia nada', async () => {
    envBase({
      NODE_ENV: 'production', ATLAS_ENV: 'uat', OMIE_MODE: 'leitura',
      SENDGRID_API_KEY: 'SG.x', SENDGRID_FROM_EMAIL: 'sistema@q2p.com.br',
    });
    const { sendEmail, getModoEmail } = await importarFresco();
    expect(getModoEmail()).toBe('suprimido');
    await sendEmail(email);
    expect(sendgrid.send).not.toHaveBeenCalled();
  });

  it('com EMAIL_DESVIO_PARA vai só para a caixa de testes, marcado e com os destinatários originais', async () => {
    // Como no YAML do UAT: a chave chega só como SENDGRID_API_KEY_DESVIO.
    envBase({
      NODE_ENV: 'production', ATLAS_ENV: 'uat', OMIE_MODE: 'leitura',
      SENDGRID_API_KEY_DESVIO: 'SG.desvio', SENDGRID_FROM_EMAIL: 'sistema@q2p.com.br',
      EMAIL_DESVIO_PARA: 'testes@acxe-polimeros.com.br',
    });
    const { sendEmail, getModoEmail } = await importarFresco();
    expect(getModoEmail()).toBe('desviado');
    await sendEmail(email);

    expect(sendgrid.setApiKey).toHaveBeenCalledWith('SG.desvio');
    expect(sendgrid.send).toHaveBeenCalledTimes(1);
    const enviado = sendgrid.send.mock.calls[0]![0];
    expect(enviado.to).toBe('testes@acxe-polimeros.com.br');
    expect(enviado.cc).toBeUndefined();
    expect(enviado.subject).toBe('[UAT] Recebimento aprovado');
    expect(enviado.html).toContain('<body style="margin:0"><div');
    expect(enviado.html).toContain('Iria para operador@acxe-polimeros.com.br, com cópia para gestor@acxe-polimeros.com.br.');
    expect(enviado.text).toMatch(/^E-mail de teste \(UAT\)\. Iria para operador@/);
  });

  it('a chave de desvio sozinha não envia nada sem EMAIL_DESVIO_PARA (imagem anterior ao desvio)', async () => {
    envBase({ NODE_ENV: 'production', SENDGRID_API_KEY_DESVIO: 'SG.desvio', SENDGRID_FROM_EMAIL: 'sistema@q2p.com.br' });
    const { sendEmail, getModoEmail } = await importarFresco();
    expect(getModoEmail()).toBe('log');
    await sendEmail(email);
    expect(sendgrid.send).not.toHaveBeenCalled();
  });

  it('produção sem desvio envia aos destinatários reais', async () => {
    envBase({ NODE_ENV: 'production', SENDGRID_API_KEY: 'SG.x', SENDGRID_FROM_EMAIL: 'sistema@q2p.com.br' });
    const { sendEmail, getModoEmail } = await importarFresco();
    expect(getModoEmail()).toBe('normal');
    await sendEmail(email);
    const enviado = sendgrid.send.mock.calls[0]![0];
    expect(enviado.to).toBe('operador@acxe-polimeros.com.br');
    expect(enviado.cc).toEqual(['gestor@acxe-polimeros.com.br']);
    expect(enviado.subject).toBe('Recebimento aprovado');
  });
});
