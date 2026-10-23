import { describe, it, expect, vi, afterEach } from 'vitest';

// Feature 017 (ACXEGDP-437), research D20 — as duas chaves da baixa do PC pelo peso conferido.
// STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO: desligada por padrao (ligar so com o primeiro uso acompanhado).
// STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT: 10 por padrao; fora de 0,1..100 derruba o boot (erro visivel, nunca um limite errado).

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
  for (const k of ['STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO', 'STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT']) {
    if (!(k in extra)) delete process.env[k];
  }
  vi.resetModules();
  const { loadConfig } = await import('../config.js');
  return loadConfig();
}

describe('config — baixa do PC pelo peso conferido (research D20)', () => {
  afterEach(() => {
    process.env = { ...ENV_ORIGINAL };
  });

  it('padrao: chave desligada e limite de 10%; vazio (Swarm com ${VAR}) tambem cai no padrao', async () => {
    expect(await carregar({})).toMatchObject({ STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO: false, STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT: 10 });
    expect(await carregar({ STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO: '', STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT: '' })).toMatchObject({
      STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO: false,
      STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT: 10,
    });
  });

  it('liga com "true" ou "1"; "false" e "0" desligam', async () => {
    expect((await carregar({ STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO: 'true' })).STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO).toBe(true);
    expect((await carregar({ STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO: '1' })).STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO).toBe(true);
    expect((await carregar({ STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO: 'false' })).STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO).toBe(false);
    expect((await carregar({ STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO: '0' })).STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO).toBe(false);
  });

  it('valor fora do enum ou limite fora de 0,1..100 derruba o boot com a variavel no erro', async () => {
    await expect(carregar({ STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO: 'sim' })).rejects.toThrow(/STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO/);
    await expect(carregar({ STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT: '0' })).rejects.toThrow(/STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT/);
    await expect(carregar({ STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT: '150' })).rejects.toThrow(/STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT/);
    expect((await carregar({ STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT: '2.5' })).STOCKBRIDGE_PC_PESO_CONFERIDO_MAX_PCT).toBe(2.5);
  });
});
