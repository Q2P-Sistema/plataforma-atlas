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

// Feature 017 (ACXEGDP-437), T016 — Principio IV para as tabelas da migration 0056
// (`stockbridge.recebimento_fiscal_pc`, `stockbridge.nf_aviso_compras`) e as regras
// que so o banco garante: justificativa obrigatoria (matriz do data-model §4) e um
// vinculo vivo por item da NF. Mesmo opt-in do bloco acima.
describe.skipIf(!temBanco)('migration 0056 — vinculo com PC e aviso a compras (integracao)', () => {
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
    if (!pool || chaves.length === 0) return;
    // Dado de teste: hard delete permitido aqui (a trigger registra o DELETE). Filhas antes do ledger (FK).
    await pool.query(`DELETE FROM stockbridge.recebimento_fiscal_pc WHERE nf_chave_acesso = ANY($1::text[])`, [chaves]);
    await pool.query(`DELETE FROM stockbridge.nf_aviso_compras WHERE nf_chave_acesso = ANY($1::text[])`, [chaves]);
    await pool.query(`DELETE FROM stockbridge.recebimento_fiscal WHERE nf_chave_acesso = ANY($1::text[])`, [chaves]);
  });

  const inserirPc = (
    ledgerId: string,
    chave: string,
    uid: string,
    c: { seq: number; origem: string; dentro: boolean; justificativa?: string | null; anterior?: number | null; status?: string },
  ) =>
    pool.query(
      `INSERT INTO stockbridge.recebimento_fiscal_pc
         (recebimento_fiscal_id, nf_chave_acesso, n_sequencia, origem, n_cod_ped, n_cod_item_ped, pc_numero,
          n_cod_ped_omie_anterior, dentro_tolerancia, justificativa, qtd_nf_kg, preco_nf, status, confirmado_por)
       VALUES ($1, $2, $3, $4, 8516905979, 8516907022, '304', $5, $6, $7, 18000, 11.3, $8, $9) RETURNING id`,
      [ledgerId, chave, c.seq, c.origem, c.anterior ?? null, c.dentro, c.justificativa ?? null, c.status ?? 'confirmado', uid],
    );

  it('recebimento_fiscal_pc: auditoria, justificativa obrigatoria pela matriz e um vinculo vivo por item', async () => {
    pool = await getPoolReal();
    const uid = await userId();
    const chave = `7${String(Date.now()).padStart(13, '0')}${'3'.repeat(30)}`.slice(0, 44);
    chaves.push(chave);

    const { rows: led } = await pool.query(
      `INSERT INTO stockbridge.recebimento_fiscal (nf_chave_acesso, nota_fiscal, status, confirmado_por)
       VALUES ($1, 'T016', 'em_andamento', $2) RETURNING id, empresa`,
      [chave, uid],
    );
    const ledgerId = String(led[0]!.id);
    expect(led[0]!.empresa, 'linhas sem empresa explicita sao da Q2P').toBe('q2p');

    // Vinculo do OMIE dentro da tolerancia: sem justificativa.
    const { rows: ok } = await inserirPc(ledgerId, chave, uid, { seq: 1, origem: 'omie', dentro: true });
    const id = String(ok[0]!.id);

    // Fora da tolerancia (qualquer origem), escolha manual e troca do vinculo do OMIE exigem justificativa.
    await expect(inserirPc(ledgerId, chave, uid, { seq: 2, origem: 'omie', dentro: false })).rejects.toMatchObject({ code: '23514' });
    await expect(inserirPc(ledgerId, chave, uid, { seq: 3, origem: 'manual', dentro: true })).rejects.toMatchObject({ code: '23514' });
    await expect(inserirPc(ledgerId, chave, uid, { seq: 4, origem: 'sugestao', dentro: true, anterior: 99, justificativa: '   ' })).rejects.toMatchObject({ code: '23514' });
    await inserirPc(ledgerId, chave, uid, { seq: 4, origem: 'sugestao', dentro: true, anterior: 99, justificativa: 'PC certo e o 304' });

    // Um vinculo vivo por item; depois de 'falha' a nova tentativa entra.
    await expect(inserirPc(ledgerId, chave, uid, { seq: 1, origem: 'sugestao', dentro: true })).rejects.toMatchObject({
      code: '23505',
      constraint: 'recebimento_fiscal_pc_item_vivo_uq',
    });
    await pool.query(`UPDATE stockbridge.recebimento_fiscal_pc SET status = 'falha', erro_omie_mensagem = 'teste' WHERE id = $1`, [id]);
    await inserirPc(ledgerId, chave, uid, { seq: 1, origem: 'sugestao', dentro: true });

    const { rows: audit } = await pool.query(
      `SELECT operation FROM shared.audit_log WHERE schema_name = 'stockbridge' AND table_name = 'recebimento_fiscal_pc' AND record_id = $1 ORDER BY id`,
      [id],
    );
    expect(audit.map((a) => a.operation)).toEqual(['INSERT', 'UPDATE']);

    await expect(pool.query(`UPDATE stockbridge.recebimento_fiscal_pc SET status = 'outro' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE stockbridge.recebimento_fiscal_pc SET origem = 'portal' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' });

    // Passos novos do ledger (0056): 'consultar_pc' e 'associar'.
    for (const passo of ['consultar_pc', 'associar']) {
      await pool.query(`UPDATE stockbridge.recebimento_fiscal SET passo_falha = $2 WHERE id = $1`, [ledgerId, passo]);
    }
    await expect(pool.query(`UPDATE stockbridge.recebimento_fiscal SET empresa = 'xyz' WHERE id = $1`, [ledgerId])).rejects.toMatchObject({ code: '23514' });
  });

  it('nf_aviso_compras: INSERT auditado e motivo restrito', async () => {
    pool = pool ?? (await getPoolReal());
    const uid = await userId();
    const chave = `6${String(Date.now()).padStart(13, '0')}${'1'.repeat(30)}`.slice(0, 44);
    chaves.push(chave);

    const { rows: ins } = await pool.query(
      `INSERT INTO stockbridge.nf_aviso_compras (nf_chave_acesso, nota_fiscal, fornecedor_nome, motivo, itens, enviado_para, disparado_por)
       VALUES ($1, 'T016', 'TESTE AUDITORIA', 'sem_pc', '[]'::jsonb, 'compras@teste', $2) RETURNING id, empresa`,
      [chave, uid],
    );
    expect(ins[0]!.empresa).toBe('q2p');
    const { rows: audit } = await pool.query(
      `SELECT operation FROM shared.audit_log WHERE schema_name = 'stockbridge' AND table_name = 'nf_aviso_compras' AND record_id = $1`,
      [String(ins[0]!.id)],
    );
    expect(audit.map((a) => a.operation)).toEqual(['INSERT']);

    await expect(
      pool.query(
        `INSERT INTO stockbridge.nf_aviso_compras (nf_chave_acesso, motivo, itens, enviado_para) VALUES ($1, 'outro', '[]'::jsonb, 'x@y')`,
        [chave],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('espelho de recebimentos: colunas de pedido existem', async () => {
    pool = pool ?? (await getPoolReal());
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tbl_recebimentoNFe_itens_Q2P'
          AND column_name IN ('n_id_pedido', 'n_id_it_pedido', 'n_num_ped_compra', 'c_num_it_ped_compra')`,
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual(['c_num_it_ped_compra', 'n_id_it_pedido', 'n_id_pedido', 'n_num_ped_compra']);
  });
});

// Feature 017, research D21 (ACXEGDP-437), migration 0060 — fiscal REVERTIDO no portal do OMIE. O que so o banco
// garante: o CHECK do status novo e do rastro da reversao, a trigger de auditoria gravando a transicao, e a trava da
// NF (indice parcial) e do item de PC (indice de item vivo) sendo LIBERADAS pela mudanca de status — o ponto em que
// o re-fiscal da mesma NF falharia para sempre (23505) se as linhas de PC ficassem 'concluido'. Mesmo opt-in dos blocos
// acima. A marcacao e a REAL (fiscal-revertido.ts); o encaixe no ledger do Atlas esta em recebimento-fiscal-revertido-db.test.ts.
describe.skipIf(!temBanco)('migration 0060 — fiscal revertido: status, rastro e liberacao da trava (integracao)', () => {
  let pool: Pool;
  const chaves: string[] = [];
  let seq = 0;

  async function getPoolReal(): Promise<Pool> {
    const core = await import('@atlas/core');
    return core.getPool() as unknown as Pool;
  }

  async function userId(): Promise<string> {
    const { rows } = await pool.query(`SELECT id FROM atlas.users ORDER BY created_at LIMIT 1`);
    expect(rows.length, 'precisa de ao menos um usuario em atlas.users').toBeGreaterThan(0);
    return String(rows[0]!.id);
  }

  /** Chave de 44 digitos, unica por teste, na faixa 96... (fora do que o dado real e os outros testes usam). */
  function chaveNova(): string {
    seq += 1;
    return `96${String(Date.now()).padStart(13, '0')}${String(seq).padStart(29, '0')}`.slice(0, 44);
  }

  afterAll(async () => {
    if (!pool || chaves.length === 0) return;
    // Dado de teste: hard delete permitido aqui (a trigger registra o DELETE). Filhas antes do ledger (FK).
    await pool.query(`DELETE FROM stockbridge.recebimento_fiscal_pc WHERE nf_chave_acesso = ANY($1::text[])`, [chaves]);
    await pool.query(`DELETE FROM stockbridge.recebimento_fiscal WHERE nf_chave_acesso = ANY($1::text[])`, [chaves]);
  });

  const inserirLedger = (chave: string, uid: string, status: string) =>
    pool.query(
      `INSERT INTO stockbridge.recebimento_fiscal (nf_chave_acesso, nota_fiscal, fornecedor_nome, status, confirmado_por, finalizado_em)
       VALUES ($1, 'T-D21', 'TESTE D21', $2::text, $3, CASE WHEN $2::text = 'em_andamento' THEN NULL ELSE now() END) RETURNING id`,
      [chave, status, uid],
    );

  const inserirPc = (ledgerId: string, chave: string, uid: string, status: string, sequencia = 1) =>
    pool.query(
      `INSERT INTO stockbridge.recebimento_fiscal_pc
         (recebimento_fiscal_id, nf_chave_acesso, n_sequencia, origem, n_cod_ped, n_cod_item_ped, pc_numero,
          dentro_tolerancia, qtd_nf_kg, preco_nf, kg_recebido_pc, status, confirmado_por)
       VALUES ($1, $2, $3, 'omie', 8518524342, 8518524343, '308', true, 13750, 10.6, 13750, $4, $5) RETURNING id`,
      [ledgerId, chave, sequencia, status, uid],
    );

  it("status 'revertido': aceito com revertido_em e origem; sem eles ou com origem desconhecida o CHECK recusa; a transicao e auditada (status antigo e novo)", async () => {
    pool = await getPoolReal();
    const uid = await userId();
    const chave = chaveNova();
    chaves.push(chave);
    const { rows } = await inserirLedger(chave, uid, 'concluido');
    const id = String(rows[0]!.id);

    await expect(pool.query(`UPDATE stockbridge.recebimento_fiscal SET status = 'revertido' WHERE id = $1`, [id])).rejects.toMatchObject({
      code: '23514',
      constraint: 'recebimento_fiscal_revertido_check',
    });
    await expect(
      pool.query(`UPDATE stockbridge.recebimento_fiscal SET status = 'revertido', revertido_em = now(), revertido_origem = 'portal' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'recebimento_fiscal_revertido_origem_check' });

    await pool.query(
      `UPDATE stockbridge.recebimento_fiscal
          SET status = 'revertido', revertido_em = now(), revertido_origem = 'espelho', revertido_omie_em = now() - interval '10 minutes', updated_at = now()
        WHERE id = $1`,
      [id],
    );
    // a leitura ao vivo grava quem clicou; a 0060 tem a FK para atlas.users
    await pool.query(`UPDATE stockbridge.recebimento_fiscal SET revertido_por = $2, aviso_fiscal_em = now() WHERE id = $1`, [id, uid]);

    const { rows: audit } = await pool.query(
      `SELECT operation, old_values->>'status' AS antes, new_values->>'status' AS depois, new_values->>'revertido_origem' AS origem
         FROM shared.audit_log WHERE schema_name = 'stockbridge' AND table_name = 'recebimento_fiscal' AND record_id = $1 ORDER BY id`,
      [id],
    );
    // as tentativas recusadas pelo CHECK nao deixam rastro (rollback do proprio comando)
    expect(audit.map((a) => a.operation)).toEqual(['INSERT', 'UPDATE', 'UPDATE']);
    expect(audit[1]).toMatchObject({ antes: 'concluido', depois: 'revertido', origem: 'espelho' });
    // 'outro' continua recusado: o CHECK de status so ganhou o valor novo
    await expect(pool.query(`UPDATE stockbridge.recebimento_fiscal SET status = 'outro' WHERE id = $1`, [id])).rejects.toMatchObject({
      code: '23514',
      constraint: 'recebimento_fiscal_status_check',
    });
  });

  it("depois de 'revertido' a trava da NF fica livre: nova linha em_andamento entra, uma segunda viva e barrada, e varias 'revertido' convivem", async () => {
    pool = pool ?? (await getPoolReal());
    const uid = await userId();
    const chave = chaveNova();
    chaves.push(chave);
    const { rows: l1 } = await inserirLedger(chave, uid, 'concluido');

    // concluido segura a trava (e o que fazia o clique devolver ja_concluido para sempre antes da D21)
    await expect(inserirLedger(chave, uid, 'em_andamento')).rejects.toMatchObject({ code: '23505', constraint: 'recebimento_fiscal_nf_viva_uq' });

    await pool.query(`UPDATE stockbridge.recebimento_fiscal SET status = 'revertido', revertido_em = now(), revertido_origem = 'omie_ao_vivo' WHERE id = $1`, [String(l1[0]!.id)]);
    const { rows: l2 } = await inserirLedger(chave, uid, 'em_andamento');
    await expect(inserirLedger(chave, uid, 'em_andamento')).rejects.toMatchObject({ code: '23505', constraint: 'recebimento_fiscal_nf_viva_uq' });

    // a 2a tentativa conclui e tambem e revertida: o indice nao limita a quantidade de 'revertido' por NF
    await pool.query(`UPDATE stockbridge.recebimento_fiscal SET status = 'concluido', finalizado_em = now() WHERE id = $1`, [String(l2[0]!.id)]);
    await pool.query(`UPDATE stockbridge.recebimento_fiscal SET status = 'revertido', revertido_em = now(), revertido_origem = 'espelho' WHERE id = $1`, [String(l2[0]!.id)]);
    await inserirLedger(chave, uid, 'em_andamento');

    const { rows } = await pool.query(`SELECT status, count(*)::int AS n FROM stockbridge.recebimento_fiscal WHERE nf_chave_acesso = $1 GROUP BY status ORDER BY status`, [chave]);
    expect(rows).toEqual([
      { status: 'em_andamento', n: 1 },
      { status: 'revertido', n: 2 },
    ]);
  });

  it("vinculos de PC: 'concluido' bloqueia a reserva nova do mesmo item (23505); marcarLedgerRevertido move a tentativa antiga para 'revertido' na mesma transacao e a reserva passa", async () => {
    pool = pool ?? (await getPoolReal());
    const uid = await userId();
    const chave = chaveNova();
    chaves.push(chave);
    const { rows: l1 } = await inserirLedger(chave, uid, 'concluido');
    const ledgerId = String(l1[0]!.id);
    await inserirPc(ledgerId, chave, uid, 'concluido', 1);
    await inserirPc(ledgerId, chave, uid, 'associado', 2); // marcarVinculosSeguro nunca lanca: um ledger concluido pode ter linha ainda 'associado'
    await inserirPc(ledgerId, chave, uid, 'falha', 3); // historico: nao se mexe

    // sem a transicao, o re-fiscal da mesma NF faria INSERT 'confirmado' das mesmas sequencias e levaria 23505 a cada tentativa
    await expect(inserirPc(ledgerId, chave, uid, 'confirmado', 1)).rejects.toMatchObject({ code: '23505', constraint: 'recebimento_fiscal_pc_item_vivo_uq' });

    const { marcarLedgerRevertido } = await import('../services/fiscal-revertido.js');
    const marcadas = await marcarLedgerRevertido({ nfChaveAcesso: chave, empresa: 'q2p', origem: 'omie_ao_vivo', ledgerId, userId: uid });
    expect(marcadas.map((m) => m.id)).toEqual([ledgerId]);

    const { rows: led } = await pool.query(`SELECT status, revertido_origem, revertido_por, revertido_em IS NOT NULL AS com_hora FROM stockbridge.recebimento_fiscal WHERE id = $1`, [ledgerId]);
    expect(led[0]).toMatchObject({ status: 'revertido', revertido_origem: 'omie_ao_vivo', revertido_por: uid, com_hora: true });
    const { rows: pcs } = await pool.query(
      `SELECT n_sequencia, status, kg_recebido_pc::float8 AS kg FROM stockbridge.recebimento_fiscal_pc WHERE recebimento_fiscal_id = $1 ORDER BY n_sequencia`,
      [ledgerId],
    );
    // vivas viram 'revertido' (kg_recebido_pc preservado: comQtdAnterior o le sem filtro de status); 'falha' fica
    expect(pcs).toEqual([
      { n_sequencia: 1, status: 'revertido', kg: 13750 },
      { n_sequencia: 2, status: 'revertido', kg: 13750 },
      { n_sequencia: 3, status: 'falha', kg: 13750 },
    ]);

    // agora a reserva da nova tentativa passa (e o ledger novo tambem)
    const { rows: l2 } = await inserirLedger(chave, uid, 'em_andamento');
    await inserirPc(String(l2[0]!.id), chave, uid, 'confirmado', 1);
    await inserirPc(String(l2[0]!.id), chave, uid, 'confirmado', 2);

    // idempotente: quem chega depois (cron, outro clique) marca 0 linhas e nada muda
    const denovo = await marcarLedgerRevertido({ nfChaveAcesso: chave, empresa: 'q2p', origem: 'omie_ao_vivo', ledgerId, userId: uid });
    expect(denovo).toEqual([]);

    const { rows: audit } = await pool.query(
      `SELECT operation, old_values->>'status' AS antes, new_values->>'status' AS depois
         FROM shared.audit_log WHERE schema_name = 'stockbridge' AND table_name = 'recebimento_fiscal_pc' AND record_id = (
           SELECT id::text FROM stockbridge.recebimento_fiscal_pc WHERE recebimento_fiscal_id = $1 AND n_sequencia = 1) ORDER BY id`,
      [ledgerId],
    );
    expect(audit.map((a) => `${a.operation}:${a.antes ?? ''}>${a.depois ?? ''}`)).toEqual(['INSERT:>concluido', 'UPDATE:concluido>revertido']);
  });
});
