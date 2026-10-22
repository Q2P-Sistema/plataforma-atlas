import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';

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
  // Sem listener de 'error', a queda de uma conexao (failover, reinicio ou
  // pg_terminate_backend) derruba o processo inteiro com "Unhandled error event" —
  // tanto a ociosa no pool quanto a retirada por quem segura uma transacao
  // (ex.: aviso a compras da 017 durante o envio do e-mail). Loga e segue: a
  // consulta em curso falha por conta propria e o pool descarta a conexao.
  const logger = createLogger('db');
  _pool.on('error', (err) => logger.error({ err }, 'Erro em conexão ociosa do pool do Postgres'));
  _pool.on('connect', (client) => {
    client.on('error', (err) => logger.error({ err }, 'Erro em conexão do Postgres'));
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
