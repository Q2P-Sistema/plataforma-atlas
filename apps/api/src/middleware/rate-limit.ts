import type { Request } from 'express';
import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedis } from '@atlas/core';
import { sendError } from '../envelope.js';

/**
 * Rate limit por IP para rotas públicas sensíveis (SEG-09, ACXEGDP-247).
 *
 * A app não usa `app.set('trust proxy')`; extraímos o IP manualmente do
 * X-Forwarded-For (mesmo modelo que o login já usa para registrar IP de sessão).
 * Store em Redis compartilhado em runtime; em teste (NODE_ENV=test) usa o
 * MemoryStore default para não exigir mock de `redis.call`.
 */
function clientIp(req: Request): string {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
    req.socket.remoteAddress ??
    'unknown'
  );
}

export function createIpRateLimiter(opts: {
  prefix: string;
  windowMs: number;
  limit: number;
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIp,
    validate: { xForwardedForHeader: false, ip: false },
    handler: (_req, res) =>
      sendError(res, 'TOO_MANY_ATTEMPTS', 'Muitas tentativas. Tente novamente mais tarde.', 429),
    ...(process.env.NODE_ENV !== 'test'
      ? {
          store: new RedisStore({
            prefix: `atlas:rl:${opts.prefix}:`,
            // ioredis .call espera (command, ...args); o cast permite espalhar o
            // array de strings que o rate-limit-redis fornece.
            sendCommand: (...args: string[]) =>
              (getRedis() as unknown as { call: (...a: string[]) => Promise<unknown> }).call(
                ...args,
              ) as never,
          }),
        }
      : {}),
  });
}
