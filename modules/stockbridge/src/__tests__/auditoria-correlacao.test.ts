import { describe, it, expect, afterAll } from 'vitest';

// Feature 015 (ACXEGDP-328), T006c — Principio IV, gate explicito: "testes de
// integracao DEVEM incluir ao menos um caso que verifica gravacao no audit log
// apos operacao de dominio". A trigger so pode ser provada contra um Postgres
// REAL com a migration 0052 aplicada. Sem DATABASE_URL o describe e PULADO —
// nunca falha por ausencia de banco, nunca "passa" fingindo.
//
// Tambem confere (T006b/T007) que o seed de fornecedor_exclusao da 0052 esta
// ativo e que os dois indices unicos existem.
//
// Rodar:  DATABASE_URL=postgres://... pnpm --filter @atlas/stockbridge test auditoria-correlacao

const DB_URL = process.env.DATABASE_URL;
const temBanco = typeof DB_URL === 'string' && DB_URL.length > 0;

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; end?: () => Promise<void> };

describe.skipIf(!temBanco)('migration 0052 — auditoria, indices e seed (integracao)', () => {
  let pool: Pool;
  const ids: string[] = [];

  async function getPoolReal(): Promise<Pool> {
    // import dinamico: @atlas/core carrega a config no import e exige DATABASE_URL
    const core = await import('@atlas/core');
    return core.getPool() as unknown as Pool;
  }

  afterAll(async () => {
    if (!pool) return;
    // Limpeza do que este teste criou (hard delete e permitido aqui: e dado de
    // teste, e a trigger registra o DELETE — o que, alias, tambem e verificado).
    if (ids.length) await pool.query(`DELETE FROM stockbridge.correlacao_produto_fornecedor WHERE id = ANY($1::uuid[])`, [ids]);
  });

  it('a trigger grava INSERT, UPDATE e DELETE em shared.audit_log', async () => {
    pool = await getPoolReal();
    const { rows: users } = await pool.query(`SELECT id FROM atlas.users WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`);
    expect(users.length, 'precisa de ao menos um usuario em atlas.users').toBeGreaterThan(0);
    const userId = String(users[0]!.id);
    const cnpj = `00.000.000/0001-${String(Math.floor(Math.random() * 90) + 10)}`; // fora de qualquer fornecedor real

    const { rows: ins } = await pool.query(
      `INSERT INTO stockbridge.correlacao_produto_fornecedor
         (fornecedor_cnpj, fornecedor_nome, descricao_nf, descricao_normalizada, produto_codigo_q2p, produto_descricao, criado_por)
       VALUES ($1, 'TESTE AUDITORIA', 'Sucata  Teste', 'SUCATA TESTE', 1, 'PRODUTO TESTE', $2)
       RETURNING id`,
      [cnpj, userId],
    );
    const id = String(ins[0]!.id);
    ids.push(id);

    await pool.query(`UPDATE stockbridge.correlacao_produto_fornecedor SET vezes_usada = vezes_usada + 1, atualizado_por = $2 WHERE id = $1`, [id, userId]);
    await pool.query(`DELETE FROM stockbridge.correlacao_produto_fornecedor WHERE id = $1`, [id]);
    ids.pop();

    const { rows: log } = await pool.query(
      `SELECT operation, old_values, new_values FROM shared.audit_log
        WHERE schema_name = 'stockbridge' AND table_name = 'correlacao_produto_fornecedor' AND record_id = $1
        ORDER BY ts`,
      [id],
    );
    expect(log.map((r) => r.operation)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
    expect((log[0]!.new_values as Record<string, unknown>).descricao_normalizada).toBe('SUCATA TESTE');
    expect((log[1]!.old_values as Record<string, unknown>).vezes_usada).toBe(0);
    expect((log[1]!.new_values as Record<string, unknown>).vezes_usada).toBe(1);
    expect(log[2]!.new_values).toBeNull();
  });

  it('indices unicos da 0052 existem', async () => {
    pool ??= await getPoolReal();
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'stockbridge'
        AND indexname IN ('movimentacao_nf_nacional_idempotencia_idx', 'correlacao_produto_fornecedor_ativa_idx')`,
    );
    expect(rows.map((r) => r.indexname).sort()).toEqual(['correlacao_produto_fornecedor_ativa_idx', 'movimentacao_nf_nacional_idempotencia_idx']);
  });

  it('seed: PLASTFIX e a contraparte ACXE tem exclusao ATIVA (T006b/T007)', async () => {
    pool ??= await getPoolReal();
    const { rows } = await pool.query(
      `SELECT fornecedor_cnpj FROM stockbridge.fornecedor_exclusao
        WHERE reincluido_em IS NULL AND fornecedor_cnpj IN ('29.654.678/0001-70', '42.672.052/0001-54')`,
    );
    expect(rows.map((r) => r.fornecedor_cnpj).sort()).toEqual(['29.654.678/0001-70', '42.672.052/0001-54']);
  });

  it('aprovacao_chk_lote_ou_sku admite recebimento_externo identificado pela chave da NF', async () => {
    pool ??= await getPoolReal();
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'aprovacao_chk_lote_ou_sku'`,
    );
    expect(String(rows[0]?.def ?? '')).toContain("recebimento_externo");
    expect(String(rows[0]?.def ?? '')).toContain('nf_chave_acesso IS NOT NULL');
  });

  it('extensao unaccent instalada (normalizacao em SQL)', async () => {
    pool ??= await getPoolReal();
    const { rows } = await pool.query(`SELECT unaccent('PAPELÃO') AS v`);
    expect(rows[0]!.v).toBe('PAPELAO');
  });
});

describe.skipIf(temBanco)('migration 0052 — integracao (pulado: sem DATABASE_URL)', () => {
  it('documenta que a prova da trigger exige banco real', () => {
    expect(temBanco).toBe(false);
  });
});
