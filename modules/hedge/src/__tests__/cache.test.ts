import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
const mockSetex = vi.fn().mockResolvedValue('OK');
const mockDel = vi.fn().mockResolvedValue(1);
const mockScan = vi.fn();

vi.mock('@atlas/core', () => ({
  getRedis: () => ({
    get: mockGet,
    setex: mockSetex,
    del: mockDel,
    scan: mockScan,
  }),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { cached, invalidate } from '../services/cache.service.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cached()', () => {
  it('returns fetchFn result on cache miss', async () => {
    mockGet.mockResolvedValue(null);
    const fetchFn = vi.fn().mockResolvedValue({ value: 42 });

    const { data, hit } = await cached('test:key', 300, fetchFn);

    expect(hit).toBe(false);
    expect(data).toEqual({ value: 42 });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(mockSetex).toHaveBeenCalledWith('test:key', 300, JSON.stringify({ value: 42 }));
  });

  it('returns cached result on cache hit', async () => {
    mockGet.mockResolvedValue(JSON.stringify({ value: 99 }));
    const fetchFn = vi.fn();

    const { data, hit } = await cached('test:key', 300, fetchFn);

    expect(hit).toBe(true);
    expect(data).toEqual({ value: 99 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('falls back to fetchFn when Redis throws', async () => {
    mockGet.mockRejectedValue(new Error('Redis down'));
    const fetchFn = vi.fn().mockResolvedValue({ fallback: true });

    const { data, hit } = await cached('test:key', 300, fetchFn);

    expect(hit).toBe(false);
    expect(data).toEqual({ fallback: true });
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

describe('invalidate()', () => {
  it('deletes exact key', async () => {
    mockDel.mockResolvedValue(1);

    const count = await invalidate('atlas:hedge:posicao:acxe');

    expect(mockDel).toHaveBeenCalledWith('atlas:hedge:posicao:acxe');
    expect(count).toBe(1);
  });

  it('scans and deletes wildcard keys', async () => {
    mockScan
      .mockResolvedValueOnce(['0', ['key1', 'key2']]);
    mockDel.mockResolvedValue(2);

    const count = await invalidate('atlas:hedge:posicao:*');

    expect(mockScan).toHaveBeenCalledWith('0', 'MATCH', 'atlas:hedge:posicao:*', 'COUNT', 100);
    expect(mockDel).toHaveBeenCalledWith('key1', 'key2');
    expect(count).toBe(2);
  });

  it('returns 0 when Redis is unavailable', async () => {
    mockDel.mockRejectedValue(new Error('Redis down'));

    const count = await invalidate('some:key');

    expect(count).toBe(0);
  });
});
