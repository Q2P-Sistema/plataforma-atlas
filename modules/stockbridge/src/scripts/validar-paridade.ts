/**
 * Compara movimentações recentes entre MySQL legado e PostgreSQL Atlas.
 * Uso: tsx src/scripts/validar-paridade.ts [--dias <n>] [--verbose]
 *
 * Requer variáveis de ambiente:
 *   DATABASE_URL              → PostgreSQL Atlas
 *   MYSQL_Q2P_HOST/PORT/USER/PASS/DB → MySQL legado
 *
 * Não faz nenhuma escrita — somente leitura nos dois bancos.
 */

import { getPool } from '@atlas/core';
import mysql from 'mysql2/promise';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const diasIdx = args.indexOf('--dias');
const DIAS = diasIdx !== -1 ? parseInt(args[diasIdx + 1] ?? '1', 10) : 1;
const VERBOSE = args.includes('--verbose');

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface MovLegado {
  nota_fiscal: string;
  id_movest_acxe: string | null;
  id_movest_q2p: string | null;
  id_ajuste_acxe: string | null;
  id_ajuste_q2p: string | null;
  mv_acxe: number | null;
  dt_acxe: Date | null;
  tem_divergencia: boolean;
  email_user: string | null;
}

interface MovAtlas {
  nota_fiscal: string;
  id_movest_acxe: string | null;
  id_movest_q2p: string | null;
  id_ajuste_acxe: string | null;
  id_ajuste_q2p: string | null;
  mv_acxe: number | null;
  dt_acxe: Date | null;
  tem_divergencia: boolean;
  email_user: string | null;
}

interface Divergencia {
  nota_fiscal: string;
  criterio: string;
  legado: string;
  atlas: string;
}

// ── Conexão MySQL ─────────────────────────────────────────────────────────────

function getMysqlConfig() {
  const host = process.env.MYSQL_Q2P_HOST;
  const port = parseInt(process.env.MYSQL_Q2P_PORT ?? '3306', 10);
  const user = process.env.MYSQL_Q2P_USER;
  const password = process.env.MYSQL_Q2P_PASS ?? '';
  const database = process.env.MYSQL_Q2P_DB;

  if (!host || !user || !database) {
    throw new Error(
      'Variáveis MySQL ausentes: MYSQL_Q2P_HOST, MYSQL_Q2P_USER, MYSQL_Q2P_DB são obrigatórias',
    );
  }
  return { host, port, user, password, database };
}

// ── Consultas ─────────────────────────────────────────────────────────────────

async function buscarMovLegado(conn: mysql.Connection, dias: number): Promise<MovLegado[]> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT
       m.nota_fiscal,
       m.id_movest_acxe,
       m.id_movest_q2p,
       m.id_ajuste_acxe,
       m.id_ajuste_q2p,
       m.mv_acxe,
       m.dt_acxe,
       (m.tp_divergencia_id IS NOT NULL) AS tem_divergencia,
       u.email                           AS email_user
     FROM tb_movimentacao m
     LEFT JOIN tb_users u ON u.id = m.id_user
     WHERE m.ativo = 1
       AND m.dt_acxe >= NOW() - INTERVAL ? DAY
     ORDER BY m.nota_fiscal`,
    [dias],
  );

  return rows.map((r) => ({
    nota_fiscal: String(r['nota_fiscal'] ?? ''),
    id_movest_acxe: r['id_movest_acxe'] != null ? String(r['id_movest_acxe']) : null,
    id_movest_q2p: r['id_movest_q2p'] != null ? String(r['id_movest_q2p']) : null,
    id_ajuste_acxe: r['id_ajuste_acxe'] != null ? String(r['id_ajuste_acxe']) : null,
    id_ajuste_q2p: r['id_ajuste_q2p'] != null ? String(r['id_ajuste_q2p']) : null,
    mv_acxe: r['mv_acxe'] != null ? Number(r['mv_acxe']) : null,
    dt_acxe: r['dt_acxe'] ? new Date(r['dt_acxe'] as string) : null,
    tem_divergencia: Boolean(r['tem_divergencia']),
    email_user: r['email_user'] != null ? String(r['email_user']) : null,
  }));
}

async function buscarMovAtlas(dias: number): Promise<MovAtlas[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    nota_fiscal: string;
    id_movest_acxe: string | null;
    id_movest_q2p: string | null;
    id_ajuste_acxe: string | null;
    id_ajuste_q2p: string | null;
    mv_acxe: number | null;
    dt_acxe: Date | null;
    tem_divergencia: boolean;
    email_user: string | null;
  }>(
    `SELECT
       m.nota_fiscal,
       m.id_movest_acxe,
       m.id_movest_q2p,
       m.id_ajuste_acxe,
       m.id_ajuste_q2p,
       m.mv_acxe,
       m.dt_acxe,
       EXISTS (
         SELECT 1 FROM stockbridge.divergencia d WHERE d.movimentacao_id = m.id
       )                               AS tem_divergencia,
       u.email                         AS email_user
     FROM stockbridge.movimentacao m
     LEFT JOIN shared.users u ON u.id = m.id_user_acxe
     WHERE m.ativo = true
       AND m.dt_acxe >= NOW() - ($1 || ' days')::interval
     ORDER BY m.nota_fiscal`,
    [dias],
  );

  return rows;
}

// ── Comparação por critério ───────────────────────────────────────────────────

function compararMovimentacao(
  nf: string,
  legado: MovLegado,
  atlas: MovAtlas,
): Divergencia[] {
  const divergencias: Divergencia[] = [];

  const checar = (criterio: string, vLegado: unknown, vAtlas: unknown) => {
    const l = String(vLegado ?? '');
    const a = String(vAtlas ?? '');
    if (l !== a) {
      divergencias.push({ nota_fiscal: nf, criterio, legado: l, atlas: a });
    }
  };

  // Critério 1 — Sucesso de integração OMIE em ambos os sistemas.
  // IDs serão diferentes (cada sistema faz sua própria chamada OMIE);
  // o que precisa coincidir é a presença de ID (≠ null) em ambos os lados.
  const checarSucessoOmie = (criterio: string, idLegado: string | null, idAtlas: string | null) => {
    const lOk = idLegado != null && idLegado !== '';
    const aOk = idAtlas != null && idAtlas !== '';
    if (lOk !== aOk) {
      divergencias.push({
        nota_fiscal: nf,
        criterio: `${criterio} (sucesso integração OMIE)`,
        legado: lOk ? 'ok' : 'falhou/null',
        atlas: aOk ? 'ok' : 'falhou/null',
      });
    }
  };
  checarSucessoOmie('id_movest_acxe', legado.id_movest_acxe, atlas.id_movest_acxe);
  checarSucessoOmie('id_movest_q2p', legado.id_movest_q2p, atlas.id_movest_q2p);
  checarSucessoOmie('id_ajuste_acxe', legado.id_ajuste_acxe, atlas.id_ajuste_acxe);
  checarSucessoOmie('id_ajuste_q2p', legado.id_ajuste_q2p, atlas.id_ajuste_q2p);

  // Critério 2 — Divergência registrada
  checar('tem_divergencia', legado.tem_divergencia, atlas.tem_divergencia);

  // Critério 4 — CNPJ/usuário
  checar('email_user', legado.email_user, atlas.email_user);

  // Critério 4 — Timestamp (±5 min)
  if (legado.dt_acxe && atlas.dt_acxe) {
    const diffMs = Math.abs(legado.dt_acxe.getTime() - atlas.dt_acxe.getTime());
    if (diffMs > 5 * 60 * 1000) {
      divergencias.push({
        nota_fiscal: nf,
        criterio: 'dt_acxe (tolerância ±5min)',
        legado: legado.dt_acxe.toISOString(),
        atlas: atlas.dt_acxe.toISOString(),
      });
    }
  }

  return divergencias;
}

// ── Relatório ─────────────────────────────────────────────────────────────────

function imprimirRelatorio(
  legadoMap: Map<string, MovLegado>,
  atlasMap: Map<string, MovAtlas>,
  divergencias: Divergencia[],
) {
  const nfsLegado = new Set(legadoMap.keys());
  const nfsAtlas = new Set(atlasMap.keys());

  const soNoLegado = [...nfsLegado].filter((nf) => !nfsAtlas.has(nf));
  const soNoAtlas = [...nfsAtlas].filter((nf) => !nfsLegado.has(nf));
  const emAmbos = [...nfsLegado].filter((nf) => nfsAtlas.has(nf));

  console.log('\n========================================');
  console.log('  RELATÓRIO DE PARIDADE — StockBridge  ');
  console.log('========================================');
  console.log(`Período analisado: últimos ${DIAS} dia(s)`);
  console.log(`Data/hora:         ${new Date().toLocaleString('pt-BR')}`);
  console.log('');
  console.log('── Contagens ───────────────────────────');
  console.log(`  NFs no legado:   ${legadoMap.size}`);
  console.log(`  NFs no Atlas:    ${atlasMap.size}`);
  console.log(`  Em ambos:        ${emAmbos.length}`);
  console.log(`  Só no legado:    ${soNoLegado.length}`);
  console.log(`  Só no Atlas:     ${soNoAtlas.length}`);
  console.log('');

  if (soNoLegado.length > 0) {
    console.log('── NFs processadas só no legado (faltam no Atlas) ──');
    soNoLegado.forEach((nf) => console.log(`  ⚠  ${nf}`));
    console.log('');
  }

  if (soNoAtlas.length > 0) {
    console.log('── NFs processadas só no Atlas (faltam no legado) ──');
    soNoAtlas.forEach((nf) => console.log(`  ⚠  ${nf}`));
    console.log('');
  }

  console.log('── Divergências de conteúdo ────────────');
  if (divergencias.length === 0) {
    console.log('  ✓ Nenhuma divergência encontrada nas NFs comuns');
  } else {
    divergencias.forEach((d) => {
      console.log(`  ✗ NF ${d.nota_fiscal} | ${d.criterio}`);
      console.log(`      legado: ${d.legado}`);
      console.log(`      atlas:  ${d.atlas}`);
    });
  }

  console.log('');
  console.log('── Resumo ──────────────────────────────');

  const totalProblemas = soNoLegado.length + soNoAtlas.length + divergencias.length;
  if (totalProblemas === 0) {
    console.log('  ✓ PARIDADE OK — nenhuma divergência no período');
  } else {
    console.log(`  ✗ ${totalProblemas} problema(s) encontrado(s) — investigar antes de avançar`);
  }

  console.log('========================================\n');

  if (VERBOSE && divergencias.length > 0) {
    console.log('── Detalhe (--verbose) ─────────────────');
    console.log(JSON.stringify(divergencias, null, 2));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nIniciando validação de paridade (últimos ${DIAS} dia(s))...`);

  let mysqlConn: mysql.Connection | null = null;

  try {
    mysqlConn = await mysql.createConnection(getMysqlConfig());

    const [movsLegado, movsAtlas] = await Promise.all([
      buscarMovLegado(mysqlConn, DIAS),
      buscarMovAtlas(DIAS),
    ]);

    const legadoMap = new Map<string, MovLegado>(movsLegado.map((m) => [m.nota_fiscal, m]));
    const atlasMap = new Map<string, MovAtlas>(movsAtlas.map((m) => [m.nota_fiscal, m]));

    const divergencias: Divergencia[] = [];

    for (const nf of legadoMap.keys()) {
      const atlas = atlasMap.get(nf);
      if (!atlas) continue;
      divergencias.push(...compararMovimentacao(nf, legadoMap.get(nf)!, atlas));
    }

    imprimirRelatorio(legadoMap, atlasMap, divergencias);

    const totalProblemas =
      [...legadoMap.keys()].filter((nf) => !atlasMap.has(nf)).length +
      [...atlasMap.keys()].filter((nf) => !legadoMap.has(nf)).length +
      divergencias.length;

    process.exit(totalProblemas > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nErro durante validação:', err);
    process.exit(2);
  } finally {
    await mysqlConn?.end();
  }
}

main();
