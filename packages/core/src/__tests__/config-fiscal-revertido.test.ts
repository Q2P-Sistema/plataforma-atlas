import { describe, it, expect, vi, afterEach } from 'vitest';

// Feature 017 (ACXEGDP-437), research D21 — kill switch do recebimento fiscal revertido no OMIE.
// STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED: LIGADA por padrao (corrige um estado errado da fila); 'false' e '0' desligam.

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const ENV_ORIGINAL = { ...process.env };

async function carregar(extra: Record<string, string>) {
  process.env = {
    ...ENV_ORIGINAL,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'test_secret_with_at_least_32_chars_xx',
    ...extra,
  };
  if (!('STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED' in extra)) delete process.env.STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED;
  vi.resetModules();
  const { loadConfig } = await import('../config.js');
  return loadConfig();
}

describe('config — recebimento fiscal revertido no OMIE (research D21)', () => {
  afterEach(() => {
    process.env = { ...ENV_ORIGINAL };
  });

  it('padrao: ligada; vazio (Swarm com ${VAR}) tambem cai no padrao', async () => {
    expect((await carregar({})).STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED).toBe(true);
    expect((await carregar({ STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED: '' })).STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED).toBe(true);
  });

  it('"false" e "0" desligam; "true" e "1" ligam', async () => {
    expect((await carregar({ STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED: 'false' })).STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED).toBe(false);
    expect((await carregar({ STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED: '0' })).STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED).toBe(false);
    expect((await carregar({ STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED: 'true' })).STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED).toBe(true);
    expect((await carregar({ STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED: '1' })).STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED).toBe(true);
  });

  it('valor fora do enum derruba o boot com a variavel no erro', async () => {
    await expect(carregar({ STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED: 'sim' })).rejects.toThrow(/STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED/);
  });
});
