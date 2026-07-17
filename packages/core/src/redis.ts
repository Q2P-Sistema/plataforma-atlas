import Redis from 'ioredis';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (_redis) return _redis;
  const config = getConfig();
  const logger = createLogger('redis');
  _redis = new Redis(config.REDIS_URL, {
    // maxRetriesPerRequest: null evita que, na corrida de deploy (Swarm sobe a API
    // antes do DNS do Redis resolver -> ENOTFOUND), o ioredis rejeite os comandos
    // enfileirados com MaxRetriesPerRequestError. Sem um catch, essa rejeicao virava
    // excecao nao tratada e DERRUBAVA o processo (crash-loop ate o Redis subir). Com
    // null, os comandos ficam na fila offline e sao drenados quando a conexao volta.
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5_000);
      return delay;
    },
    lazyConnect: true,
  });
  // Sem um listener de 'error', o ioredis so imprime "Unhandled error event" e, em
  // alguns caminhos, o erro escapa e mata o processo. Aqui logamos e seguimos: a
  // reconexao e cuidada pelo retryStrategy.
  _redis.on('error', (err: Error) => {
    logger.error({ err }, 'Redis connection error');
  });
  return _redis;
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
