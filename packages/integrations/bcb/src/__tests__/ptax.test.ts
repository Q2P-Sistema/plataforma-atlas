import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Redis
const mockRedis = {
  get: vi.fn(),
  setex: vi.fn().mockResolvedValue('OK'),
  // fetchPtaxAtual grava o último boletim válido em `${CACHE_KEY}:last_good` via
  // redis.set(...). Sem este mock, a chamada estourava TypeError DEPOIS de já ter
  // lido o boletim, derrubando fetchPtaxAtual para o fallback (data de hoje) — a
  // causa real do teste "fetches from BCB when cache is empty" estar vermelho.
  set: vi.fn().mockResolvedValue('OK'),
};

vi.mock('@atlas/core', () => ({
  getRedis: () => mockRedis,
  getConfig: () => ({ NODE_ENV: 'test' }),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { fetchPtaxAtual, fetchPtaxHistorico } from '../ptax.service.js';

describe('PTAX Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
  });

  it('returns cached value when available', async () => {
    const cached = JSON.stringify({
      dataRef: '2026-04-12',
      venda: 5.45,
      compra: 5.44,
      atualizada: true,
    });
    mockRedis.get.mockResolvedValue(cached);

    const result = await fetchPtaxAtual();

    expect(result.venda).toBe(5.45);
    expect(result.atualizada).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches from BCB when cache is empty', async () => {
    // fetchPtaxAtual usa o boletim CotacaoDolarDia — shape { value: [{ cotacaoVenda,
    // cotacaoCompra, dataHoraCotacao }] } (o mock antigo usava o shape do SGS e caía
    // sempre no fallback → teste estava vermelho desde o refactor do boletim).
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          value: [
            { cotacaoCompra: 5.44, cotacaoVenda: 5.45, dataHoraCotacao: '2026-04-12 13:08:00.000' },
          ],
        }),
    });

    const result = await fetchPtaxAtual();

    expect(result.dataRef).toBe('2026-04-12');
    expect(result.venda).toBe(5.45);
    expect(result.atualizada).toBe(true);
    expect(mockRedis.setex).toHaveBeenCalled();
  });

  it('rejects PTAX outside sanity range and falls back', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ data: '12/04/2026', valor: 15.0 }]),
    });
    // No fallback available
    mockRedis.get.mockResolvedValue(null);

    const result = await fetchPtaxAtual();

    expect(result.atualizada).toBe(false);
    expect(result.venda).toBe(0); // No fallback
  });

  it('uses fallback when BCB API fails', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    // First call: no cache, no fallback
    mockRedis.get.mockResolvedValue(null);

    const result = await fetchPtaxAtual();

    expect(result.atualizada).toBe(false);
  });

  it('uses last_good fallback when BCB is down', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));

    // First get returns null (main cache), second returns last_good
    mockRedis.get
      .mockResolvedValueOnce(null) // main cache
      .mockResolvedValueOnce(
        JSON.stringify({
          dataRef: '2026-04-11',
          venda: 5.42,
          compra: 5.41,
          atualizada: true,
        }),
      ); // last_good fallback

    const result = await fetchPtaxAtual();

    expect(result.dataRef).toBe('2026-04-11');
    expect(result.venda).toBe(5.42);
    expect(result.atualizada).toBe(false);
  });
});

describe('fetchPtaxHistorico — MOD-20: valor string do SGS coagido para number', () => {
  beforeEach(() => vi.clearAllMocks());

  it('coage valor string ("5.5023") para number, deixando .toFixed utilizável a jusante', async () => {
    // O SGS devolve valor como STRING. Sem coerção, o consumidor no hedge faz
    // q.venda.toFixed(4) e estoura (string não tem toFixed).
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { data: '01/07/2026', valor: '5.5023' },
          { data: '02/07/2026', valor: '5.4810' },
        ]),
    });

    const result = await fetchPtaxHistorico(30);

    expect(result).toHaveLength(2);
    expect(typeof result[0]!.venda).toBe('number');
    expect(result[0]!.venda).toBe(5.5023);
    // Prova concreta de que o bug do toFixed não reaparece:
    expect(() => result[0]!.venda.toFixed(4)).not.toThrow();
    expect(result[0]!.venda.toFixed(4)).toBe('5.5023');
  });

  it('descarta valores fora da faixa de sanidade e não-numéricos (NaN)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { data: '01/07/2026', valor: '5.50' },   // ok
          { data: '02/07/2026', valor: '15.0' },   // acima do teto (10)
          { data: '03/07/2026', valor: 'n/d' },    // não-numérico → NaN
        ]),
    });

    const result = await fetchPtaxHistorico(30);

    expect(result).toHaveLength(1);
    expect(result[0]!.venda).toBe(5.5);
  });
});
