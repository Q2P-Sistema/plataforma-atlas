import { describe, it, expect, vi, beforeEach } from 'vitest';

// STK-14 (ACXEGDP-290): helper cache-aside promovido do hedge para @atlas/core.
// Semântica coberta: hit (não busca), miss (busca + grava em background),
// degradação graciosa (Redis fora → busca direta, nunca propaga o erro).

const redisMock = {
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
  scan: vi.fn(),
};
vi.mock('../redis.js', () => ({
  getRedis: () => redisMock,
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { cached, invalidate } from '../cache.js';

describe('cached — cache-aside com degradação graciosa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.setex.mockResolvedValue('OK');
  });

  it('hit: devolve o valor do Redis sem executar o fetch', async () => {
    redisMock.get.mockResolvedValue(JSON.stringify({ contagem: 7 }));
    const fetchFn = vi.fn();

    const res = await cached('chave', 300, fetchFn);

    expect(res).toEqual({ data: { contagem: 7 }, hit: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('miss: executa o fetch e grava em background com o TTL pedido', async () => {
    redisMock.get.mockResolvedValue(null);
    const fetchFn = vi.fn().mockResolvedValue({ contagem: 3 });

    const res = await cached('chave', 300, fetchFn);

    expect(res).toEqual({ data: { contagem: 3 }, hit: false });
    expect(redisMock.setex).toHaveBeenCalledWith('chave', 300, JSON.stringify({ contagem: 3 }));
  });

  it('Redis fora do ar: cai no fetch direto sem propagar o erro', async () => {
    redisMock.get.mockRejectedValue(new Error('ECONNREFUSED'));
    const fetchFn = vi.fn().mockResolvedValue('vivo');

    const res = await cached('chave', 60, fetchFn);

    expect(res).toEqual({ data: 'vivo', hit: false });
  });

  it('falha na ESCRITA do cache não afeta a resposta (write em background)', async () => {
    redisMock.get.mockResolvedValue(null);
    redisMock.setex.mockRejectedValue(new Error('OOM'));
    const fetchFn = vi.fn().mockResolvedValue(42);

    const res = await cached('chave', 60, fetchFn);

    expect(res.data).toBe(42);
  });
});

describe('invalidate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('chave exata usa DEL direto', async () => {
    redisMock.del.mockResolvedValue(1);

    const n = await invalidate('stockbridge:conferencia:badge');

    expect(n).toBe(1);
    expect(redisMock.del).toHaveBeenCalledWith('stockbridge:conferencia:badge');
    expect(redisMock.scan).not.toHaveBeenCalled();
  });

  it('wildcard usa SCAN + DEL até esgotar o cursor', async () => {
    redisMock.scan
      .mockResolvedValueOnce(['5', ['a:1', 'a:2']])
      .mockResolvedValueOnce(['0', ['a:3']]);
    redisMock.del.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

    const n = await invalidate('a:*');

    expect(n).toBe(3);
    expect(redisMock.scan).toHaveBeenCalledTimes(2);
  });

  it('Redis fora do ar devolve 0 sem propagar', async () => {
    redisMock.del.mockRejectedValue(new Error('down'));

    await expect(invalidate('x')).resolves.toBe(0);
  });
});
