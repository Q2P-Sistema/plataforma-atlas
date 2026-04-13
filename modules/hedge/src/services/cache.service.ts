import { getRedis, createLogger } from '@atlas/core';

const logger = createLogger('hedge:cache');

/**
 * Generic cache-aside wrapper. Tries Redis first, falls back to fetchFn.
 * Gracefully degrades if Redis is unavailable.
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
    // Store in background — don't block response
    redis.setex(key, ttlSeconds, JSON.stringify(data)).catch((err) => {
      logger.warn({ err, key }, 'Failed to write cache');
    });
    return { data, hit: false };
  } catch (err) {
    // Redis unavailable — fallback to direct fetch
    logger.warn({ err, key }, 'Redis unavailable, falling back to direct fetch');
    const data = await fetchFn();
    return { data, hit: false };
  }
}

/**
 * Invalidates cache keys matching a pattern.
 * Supports '*' wildcard via SCAN + DEL.
 */
export async function invalidate(pattern: string): Promise<number> {
  try {
    const redis = getRedis();

    if (!pattern.includes('*')) {
      const count = await redis.del(pattern);
      if (count > 0) logger.debug({ pattern, count }, 'Cache invalidated');
      return count;
    }

    // Wildcard: SCAN + DEL
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

    if (total > 0) logger.debug({ pattern, total }, 'Cache invalidated (wildcard)');
    return total;
  } catch (err) {
    logger.warn({ err, pattern }, 'Failed to invalidate cache');
    return 0;
  }
}
