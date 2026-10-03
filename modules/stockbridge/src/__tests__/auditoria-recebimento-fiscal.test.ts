import { describe, it, expect, afterAll } from 'vitest';

// Feature 016 (ACXEGDP-395), T052 — Principio IV, gate explicito: a trigger de
// auditoria das tabelas novas (`stockbridge.recebimento_fiscal`, `stockbridge.nf_dispensa`,
// migration 0053) so pode ser provada contra um Postgres REAL. Mesmo opt-in do
// auditoria-correlacao.test.ts: ATLAS_DB_INTEGRATION=1 + DATABASE_URL. Sem ele o
// describe e PULADO (nunca falha por falta de banco, nunca "passa" fingindo).
//
// Rodar:  ATLAS_DB_INTEGRATION=1 DATABASE_URL=postgres://... pnpm --filter @atlas/stockbridge exec vitest run src/__tests__/auditoria-recebimento-fiscal.test.ts

const DB_URL = process.env.DATABASE_URL;
const temBanco = process.env.ATLAS_DB_INTEGRATION === '1' && typeof DB_URL === 'string' && DB_URL.length > 0;

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

describe.skipIf(!temBanco)('migration 0053 — auditoria, indices parciais e espelho (integracao)', () => {
  let pool: Pool;
  const chaves: string[] = [];

  async function getPoolReal(): Promise<Pool> {
    const core = await import('@atlas/core');
    return core.getPool() as unknown as Pool;
  }

  async function userId(): Promise<string> {
    const { rows } = await pool.query(`SELECT id FROM atlas.users ORDER BY created_at LIMIT 1`);
    expect(rows.length, 'precisa de ao menos um usuario em atlas.users').toBeGreaterThan(0);
    return String(rows[0]!.id);
  }

  afterAll(async () => {
    if (!pool) return;
    // Dado de teste: hard delete permitido aqui (a trigger registra o DELETE).
    if (chaves.length) {
      await pool.query(`DELETE FROM stockbridge.recebimento_fiscal WHERE nf_chave_acesso = ANY($1::text[])`, [chaves]);
      await pool.query(`DELETE FROM stockbridge.nf_dispensa WHERE nf_chave_acesso = ANY($1::text[])`, [chaves]);
    }
  });

  it('recebimento_fiscal: INSERT/UPDATE em shared.audit_log; indice parcial permite nova linha apos falha e barra duas vivas', async () => {
    pool = await getPoolReal();
    const uid = await userId();
    const chave = `9${String(Date.now()).padStart(13, '0')}${'7'.repeat(30)}`.slice(0, 44);
    chaves.push(chave);

    const { rows: ins } = await pool.query(
      `INSERT INTO stockbridge.recebimento_fiscal (nf_chave_acesso, nota_fiscal, fornecedor_nome, status, confirmado_por)
       VALUES ($1, 'T052', 'TESTE AUDITORIA', 'em_andamento', $2) RETURNING id`,
      [chave, uid],
    );
    const id = String(ins[0]!.id);

    // segunda linha VIVA para a mesma chave e barrada pelo indice parcial
    await expect(
      pool.query(
        `INSERT INTO stockbridge.recebimento_fiscal (nf_chave_acesso, nota_fiscal, status, confirmado_por) VALUES ($1, 'T052', 'em_andamento', $2)`,
        [chave, uid],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'recebimento_fiscal_nf_viva_uq' });

    await pool.query(`UPDATE stockbridge.recebimento_fiscal SET status = 'falha', passo_falha = 'concluir', erro_omie_codigo = 'X', finalizado_em = now() WHERE id = $1`, [id]);

    // apos 'falha', uma nova tentativa abre linha nova sem violar o indice
    await pool.query(
      `INSERT INTO stockbridge.recebimento_fiscal (nf_chave_acesso, nota_fiscal, status, confirmado_por) VALUES ($1, 'T052', 'em_andamento', $2)`,
      [chave, uid],
    );

    const { rows: audit } = await pool.query(
      `SELECT operation, record_id FROM shared.audit_log WHERE schema_name = 'stockbridge' AND table_name = 'recebimento_fiscal' AND record_id = $1 ORDER BY id`,
      [id],
    );
    expect(audit.map((a) => a.operation)).toEqual(['INSERT', 'UPDATE']);

    // CHECKs de status/passo
    await expect(pool.query(`UPDATE stockbridge.recebimento_fiscal SET status = 'outro' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
  });

  it('nf_dispensa: INSERT/UPDATE auditados; so UMA dispensa ativa por chave; reversao libera nova dispensa', async () => {
    pool = pool ?? (await getPoolReal());
    const uid = await userId();
    const chave = `8${String(Date.now()).padStart(13, '0')}${'5'.repeat(30)}`.slice(0, 44);
    chaves.push(chave);

    const { rows: ins } = await pool.query(
      `INSERT INTO stockbridge.nf_dispensa (nf_chave_acesso, nota_fiscal, fornecedor_nome, situacao_fiscal_na_dispensa, motivo, dispensado_por)
       VALUES ($1, 'T052', 'TESTE AUDITORIA', 'pendente', 'teste de auditoria', $2) RETURNING id`,
      [chave, uid],
    );
    const id = String(ins[0]!.id);

    await expect(
      pool.query(
        `INSERT INTO stockbridge.nf_dispensa (nf_chave_acesso, nota_fiscal, situacao_fiscal_na_dispensa, motivo, dispensado_por) VALUES ($1, 'T052', 'concluido', 'dupla', $2)`,
        [chave, uid],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'nf_dispensa_ativa_uq' });

    await pool.query(`UPDATE stockbridge.nf_dispensa SET revertido_por = $2, revertido_em = now(), motivo_reversao = 'teste' WHERE id = $1`, [id, uid]);

    // revertida -> nova dispensa ativa e permitida
    await pool.query(
      `INSERT INTO stockbridge.nf_dispensa (nf_chave_acesso, nota_fiscal, situacao_fiscal_na_dispensa, motivo, dispensado_por) VALUES ($1, 'T052', 'concluido', 'de novo', $2)`,
      [chave, uid],
    );

    const { rows: audit } = await pool.query(
      `SELECT operation FROM shared.audit_log WHERE schema_name = 'stockbridge' AND table_name = 'nf_dispensa' AND record_id = $1 ORDER BY id`,
      [id],
    );
    expect(audit.map((a) => a.operation)).toEqual(['INSERT', 'UPDATE']);

    await expect(
      pool.query(`INSERT INTO stockbridge.nf_dispensa (nf_chave_acesso, nota_fiscal, situacao_fiscal_na_dispensa, motivo, dispensado_por) VALUES ($1, 'T052', 'invalida', 'x', $2)`, [`${chave.slice(0, 43)}0`, uid]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('espelho de recebimentos: tabelas, chave unica e colunas que a fila usa existem', async () => {
    pool = pool ?? (await getPoolReal());
    const { rows: cols } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('tbl_recebimentoNFe_Q2P', 'tbl_recebimentoNFe_itens_Q2P')`,
    );
    const nomes = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
    for (const c of [
      'tbl_recebimentoNFe_Q2P.n_id_receb', 'tbl_recebimentoNFe_Q2P.c_chave_nfe', 'tbl_recebimentoNFe_Q2P.c_numero_nfe', 'tbl_recebimentoNFe_Q2P.c_razao_social',
      'tbl_recebimentoNFe_Q2P.c_cnpj_cpf', 'tbl_recebimentoNFe_Q2P.d_emissao', 'tbl_recebimentoNFe_Q2P.c_recebido', 'tbl_recebimentoNFe_Q2P.c_cancelada', 'tbl_recebimentoNFe_Q2P.synced_at',
      'tbl_recebimentoNFe_itens_Q2P.n_sequencia', 'tbl_recebimentoNFe_itens_Q2P.c_descricao_produto', 'tbl_recebimentoNFe_itens_Q2P.c_cfop_entrada',
      'tbl_recebimentoNFe_itens_Q2P.n_qtde_nfe', 'tbl_recebimentoNFe_itens_Q2P.c_unidade_nfe', 'tbl_recebimentoNFe_itens_Q2P.v_total_item',
    ]) {
      expect(nomes.has(c), c).toBe(true);
    }
    const { rows: idx } = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'tbl_recebimentoNFe_Q2P'`);
    expect(idx.map((i) => i.indexname)).toContain('tbl_recebimentoNFe_Q2P_chave_idx');
  });
});
