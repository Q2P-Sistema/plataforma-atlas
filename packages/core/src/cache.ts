import { getRedis } from './redis.js';
import { createLogger } from './logger.js';

const logger = createLogger('core:cache');

/**
 * Cache-aside genérico sobre Redis, com degradação graciosa (Redis fora →
 * busca direta, sem quebrar o caller).
 *
 * Promovido de modules/hedge/src/services/cache.service.ts para @atlas/core
 * (STK-14, ACXEGDP-290) — o mesmo helper era duplicado verbatim em hedge e
 * breakingpoint (MOD-17/ACXEGDP-298); consumidores existentes migram no
 * follow-up 298, novos usos (ex.: badge da conferência do StockBridge) já
 * importam daqui.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fetchFn: () => Promise<T>,
): Promise<{ data: T; hit: boolean }> {
  try {
    const redis = getRedis();
    const raw = await redis.get(key);
    if (raw) {
      return { data: JSON.parse(raw) as T, hit: true };
    }

    const data = await fetchFn();
    // Escrita em background — não bloqueia a resposta
    redis.setex(key, ttlSeconds, JSON.stringify(data)).catch((err) => {
      logger.warn({ err, key }, 'Falha ao escrever no cache');
    });
    return { data, hit: false };
  } catch (err) {
    // Redis indisponível — segue direto pro fetch
    logger.warn({ err, key }, 'Redis indisponível — buscando direto');
    const data = await fetchFn();
    return { data, hit: false };
  }
}

/**
 * Invalida chaves de cache. Suporta wildcard '*' via SCAN + DEL.
 */
export async function invalidate(pattern: string): Promise<number> {
  try {
    const redis = getRedis();

    if (!pattern.includes('*')) {
      const count = await redis.del(pattern);
      if (count > 0) logger.debug({ pattern, count }, 'Cache invalidado');
      return count;
    }

    let cursor = '0';
    let total = 0;
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        const deleted = await redis.del(...keys);
        total += deleted;
      }
    } while (cursor !== '0');

    if (total > 0) logger.debug({ pattern, total }, 'Cache invalidado (wildcard)');
    return total;
  } catch (err) {
    logger.warn({ err, pattern }, 'Falha ao invalidar cache');
    return 0;
  }
}
