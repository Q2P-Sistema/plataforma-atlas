import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getConfig } from './config.js';

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (_pool) return _pool;
  const config = getConfig();
  _pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Fixa o fuso da sessao em todas as conexoes. Sem isto o Postgres herda UTC
    // (fuso do container) e CURRENT_DATE/CURRENT_TIMESTAMP divergem do dia local
    // ~3h antes da meia-noite — gerando falso "dado defasado" e janelas de
    // vencimento erradas. `-c timezone=...` roda SET timezone no startup da conexao.
    options: `-c timezone=${config.DB_TIMEZONE}`,
  });
  return _pool;
}

export function getDb() {
  return drizzle(getPool());
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
