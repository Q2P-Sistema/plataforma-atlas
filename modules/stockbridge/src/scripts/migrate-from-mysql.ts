#!/usr/bin/env node
/**
 * Migração one-shot: MySQL legado → PostgreSQL Atlas
 *
 * Importa o histórico de recibos do sistema PHP legado
 * (MySQL `tb_movimentacao`, ~731 linhas) para `stockbridge.movimentacao_legado`
 * (criada na migration 0038), preservando o dado 1:1.
 *
 * POR QUE uma tabela dedicada (e não stockbridge.movimentacao):
 *   As linhas do legado são recibos dual-CNPJ puros — só NF + IDs de ajuste
 *   OMIE de cada lado (ACXE/Q2P) + usuário. NÃO têm produto/quantidade/galpão,
 *   então não passam no CHECK `movimentacao_chk_lote_ou_sku`, e podem repetir NF
 *   (violando o índice 1-por-NF). São histórico FECHADO — servem só para
 *   AUDITORIA e IDEMPOTÊNCIA. O saldo já está consolidado no OMIE; recriá-los
 *   como lotes duplicaria estoque. Ver migration 0038 e research.md §6.
 *
 * IDEMPOTÊNCIA: ON CONFLICT (id_legado) DO NOTHING. id_legado = PK original
 *   do MySQL (tb_movimentacao.id_movimentacao). Re-rodar não duplica.
 *
 * Estrutura real do MySQL (inspecionada 2026-06-09):
 *   tb_users:        id_user, user_email, user_name, pass, created_at
 *   tb_movimentacao: id_movimentacao, nota_fiscal(int), mv_acxe, dt_acxe,
 *                    id_movest_acxe, id_ajuste_acxe, id_user_acxe, mv_q2p,
 *                    dt_q2p, id_movest_q2p, id_ajuste_q2p, id_user_q2p, ativo
 *
 * Execução:
 *   pnpm --filter @atlas/stockbridge exec tsx src/scripts/migrate-from-mysql.ts
 *
 * Prerequisitos:
 *   - DATABASE_URL       → PG Atlas (com migration 0038 aplicada)
 *   - LEGACY_MYSQL_URL   → MySQL legado
 *   - mysql2 instalado   (pnpm add -D mysql2 --filter @atlas/stockbridge)
 */

import { createConnection, type Connection } from 'mysql2/promise';
import { getPool, createLogger } from '@atlas/core';

const logger = createLogger('stockbridge:migrate-mysql');

// ── Types ────────────────────────────────────────────────────────
interface LegacyUser {
  id_user: number;
  user_email: string;
  user_name: string;
}

interface LegacyMovimentacao {
  id_movimentacao: number;
  nota_fiscal: number;
  mv_acxe: number | null;
  dt_acxe: string | null;
  id_movest_acxe: string | null;
  id_ajuste_acxe: string | null;
  id_user_acxe: number | null;
  mv_q2p: number | null;
  dt_q2p: string | null;
  id_movest_q2p: string | null;
  id_ajuste_q2p: string | null;
  id_user_q2p: number | null;
  ativo: number;
}

interface MigrationStats {
  usuariosMapeados: number;
  movimentacoesInseridas: number;
  movimentacoesJaExistiam: number;
  erros: string[];
}

// ── Helper: conectar MySQL ────────────────────────────────────────
async function connectLegacyMySQL(): Promise<Connection> {
  const legacyUrl = process.env.LEGACY_MYSQL_URL;
  if (!legacyUrl) throw new Error('LEGACY_MYSQL_URL not set');

  // decode tolerante: a senha pode conter '%' literal (não percent-encoded),
  // o que faz decodeURIComponent lançar "URI malformed". Nesse caso usa o cru.
  const safeDecode = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };

  const url = new URL(legacyUrl);
  return createConnection({
    host: url.hostname,
    port: parseInt(url.port || '3306'),
    user: safeDecode(url.username),
    password: safeDecode(url.password),
    database: url.pathname.slice(1),
  });
}

// ── Helper: mapear users legado → Atlas UUID (por email) ─────────
async function mapUsers(legacyConn: Connection): Promise<Map<number, string>> {
  logger.info('📥 Buscando users do MySQL legado...');
  const [rows] = await legacyConn.query(
    `SELECT id_user, user_email, user_name FROM tb_users ORDER BY id_user`
  );

  const pgPool = getPool();
  const userMap = new Map<number, string>();

  for (const row of rows as LegacyUser[]) {
    const res = await pgPool.query(
      `SELECT id FROM atlas.users WHERE email = $1`,
      [row.user_email]
    );
    if (res.rows.length === 0) {
      logger.warn(`User ${row.user_email} (legado #${row.id_user}) sem correlato no Atlas — id_user ficará NULL.`);
    } else {
      userMap.set(row.id_user, res.rows[0].id);
    }
  }

  logger.info(`✓ ${userMap.size}/${(rows as LegacyUser[]).length} users mapeados`);
  return userMap;
}

// ── Helper: normaliza dt do MySQL → ISO p/ Postgres timestamptz ──
function toTimestamp(v: string | null): string | null {
  if (!v) return null;
  // mysql2 já devolve Date-like string ISO; repassa direto (PG parseia).
  return v;
}

// ── Main migration ───────────────────────────────────────────────
async function migrate(): Promise<MigrationStats> {
  const stats: MigrationStats = {
    usuariosMapeados: 0,
    movimentacoesInseridas: 0,
    movimentacoesJaExistiam: 0,
    erros: [],
  };

  let legacyConn: Connection | null = null;

  try {
    logger.info('🔌 Conectando ao MySQL legado...');
    legacyConn = await connectLegacyMySQL();

    const userMap = await mapUsers(legacyConn);
    stats.usuariosMapeados = userMap.size;

    logger.info('📊 Importando tb_movimentacao → stockbridge.movimentacao_legado...');
    const [movRows] = await legacyConn.query(`
      SELECT
        id_movimentacao, nota_fiscal,
        mv_acxe, dt_acxe, id_movest_acxe, id_ajuste_acxe, id_user_acxe,
        mv_q2p,  dt_q2p,  id_movest_q2p,  id_ajuste_q2p,  id_user_q2p,
        ativo
      FROM tb_movimentacao
      ORDER BY id_movimentacao
    `);
    const rows = movRows as LegacyMovimentacao[];
    logger.info(`  ${rows.length} linhas lidas do MySQL`);

    const pgPool = getPool();
    const client = await pgPool.connect();

    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      for (const row of rows) {
        try {
          const res = await client.query(
            `INSERT INTO stockbridge.movimentacao_legado (
              id_legado, nota_fiscal,
              mv_acxe, dt_acxe, id_movest_acxe, id_ajuste_acxe, id_user_acxe,
              mv_q2p,  dt_q2p,  id_movest_q2p,  id_ajuste_q2p,  id_user_q2p,
              ativo
            ) VALUES (
              $1, $2,
              $3, $4, $5, $6, $7,
              $8, $9, $10, $11, $12,
              $13
            )
            ON CONFLICT (id_legado) DO NOTHING`,
            [
              row.id_movimentacao,
              // NF zero-padded a 8 dígitos = formato do OMIE n_nf (ex: 2275 → '00002275')
              String(row.nota_fiscal).padStart(8, '0'),
              row.mv_acxe,
              toTimestamp(row.dt_acxe),
              row.id_movest_acxe,
              row.id_ajuste_acxe,
              row.id_user_acxe ? (userMap.get(row.id_user_acxe) ?? null) : null,
              row.mv_q2p,
              toTimestamp(row.dt_q2p),
              row.id_movest_q2p,
              row.id_ajuste_q2p,
              row.id_user_q2p ? (userMap.get(row.id_user_q2p) ?? null) : null,
              row.ativo === 1,
            ]
          );
          if (res.rowCount === 1) stats.movimentacoesInseridas++;
          else stats.movimentacoesJaExistiam++;
        } catch (err) {
          const msg = `Erro na movimentação legado #${row.id_movimentacao} (NF ${row.nota_fiscal}): ${err}`;
          logger.error(msg);
          stats.erros.push(msg);
        }
      }

      if (stats.erros.length === 0) {
        await client.query('COMMIT');
        logger.info('✅ COMMIT — importação concluída');
      } else {
        await client.query('ROLLBACK');
        logger.error(`❌ ROLLBACK — ${stats.erros.length} erro(s)`);
        throw new Error('Migração com erros');
      }
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err }, '❌ Erro fatal na migração');
    console.error('DETALHE DO ERRO:', err);
    throw err;
  } finally {
    if (legacyConn) await legacyConn.end();
  }

  return stats;
}

// ── CLI entry point ──────────────────────────────────────────────
async function main() {
  logger.info('🚀 Migração MySQL → PostgreSQL (StockBridge — histórico legado)');
  try {
    const stats = await migrate();
    console.log('\n📈 Estatísticas finais:');
    console.log(`  - Users mapeados:           ${stats.usuariosMapeados}`);
    console.log(`  - Movimentações inseridas:  ${stats.movimentacoesInseridas}`);
    console.log(`  - Já existiam (idemp.):     ${stats.movimentacoesJaExistiam}`);
    if (stats.erros.length > 0) {
      console.log(`\n⚠️  ${stats.erros.length} erro(s):`);
      stats.erros.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
      process.exit(1);
    } else {
      console.log('\n✅ Migração concluída sem erros!');
      process.exit(0);
    }
  } catch {
    process.exit(1);
  }
}

main();
