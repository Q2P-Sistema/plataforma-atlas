import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Redis
const mockRedis = {
  get: vi.fn(),
  setex: vi.fn().mockResolvedValue('OK'),
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

import { fetchPtaxAtual } from '../ptax.service.js';

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
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { data: '11/04/2026', valor: 5.42 },
          { data: '12/04/2026', valor: 5.45 },
        ]),
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
