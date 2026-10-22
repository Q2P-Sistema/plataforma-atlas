import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Feature 017 (ACXEGDP-437), migration 0057 — cache de pedidos de compra vistos
// (`stockbridge.pedido_compra_visto`): so um Postgres REAL prova a tabela, o UNIQUE (empresa, n_cod_item), o CHECK
// de empresa, a trigger de auditoria (Principio IV) e — sobretudo — o upsert `ON CONFLICT … DO UPDATE … WHERE
// (colunas) IS DISTINCT FROM (EXCLUDED …)` de `registrarPcsVistos`, que so pode gerar UPDATE (e linha de
// auditoria) quando algo MUDOU.
//
// Mesmo opt-in do auditoria-recebimento-fiscal.test.ts: ATLAS_DB_INTEGRATION=1 + DATABASE_URL. Sem ele o describe e
// PULADO (nunca falha por falta de banco, nunca "passa" fingindo).
//
// Rodar:  ATLAS_DB_INTEGRATION=1 DATABASE_URL=postgres://... pnpm --filter @atlas/stockbridge exec vitest run src/__tests__/auditoria-pedido-compra-visto.test.ts
//
// Precisa de: schema `stockbridge` com a 0057 aplicada e `shared.audit_log` (0001). As tabelas do ESPELHO OMIE
// (`public."tbl_pedidosCompras_Q2P"/_ACXE"` e `"tbl_cadastroFornecedoresClientes_Q2P"`) sao do n8n, nao das migrations:
// os testes que leem/gravam o cache a partir delas CRIAM as tabelas no inicio e as removem no fim — e so se ainda
// NAO existirem. Se ja existirem (banco com o espelho real), esses testes sao PULADOS: este teste nunca escreve no espelho.
// A auditoria e append-only: as linhas de shared.audit_log geradas aqui ficam (ids de teste em faixa propria).

const DB_URL = process.env.DATABASE_URL;
const temBanco = process.env.ATLAS_DB_INTEGRATION === '1' && typeof DB_URL === 'string' && DB_URL.length > 0;

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> };

/** Faixa de ids de teste (bigint) — nao colide com ids reais do OMIE (10 digitos) nem entre execucoes. */
const BASE = 8_000_000_000_000 + Math.floor(Math.random() * 900_000_000) * 100;
const PED_A = BASE + 1;
const PED_B = BASE + 2;
const PED_C = BASE + 3;
const IT_A1 = BASE + 11;
const IT_A2 = BASE + 12;
const IT_B1 = BASE + 21;
const IT_C1 = BASE + 31;
const COD_FILIAL = BASE + 41;
const COD_MATRIZ = BASE + 42;
const COD_OUTRA = BASE + 43;
const COD_CPF = BASE + 44;

describe.skipIf(!temBanco)('migration 0057 — pedido_compra_visto: auditoria, UNIQUE e upsert só do que mudou (integração)', () => {
  let pool: Pool;
  let criouCopiaQ2p = false;
  let criouCopiaAcxe = false;
  let criouCadastroQ2p = false;
  let criouCadastroAcxe = false;
  let srv: typeof import('../services/pc-visto.service.js');

  const existe = async (tabela: string): Promise<boolean> => {
    const { rows } = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS existe`, [`public."${tabela}"`]);
    return rows[0]!.existe === true;
  };
  const criarCopia = (tabela: string) =>
    pool.query(`
      CREATE TABLE public."${tabela}" (
        ncodped bigint, ncoditem bigint, cnumero text, cetapa text, ncodfor bigint, nqtde numeric, nqtderec numeric, nvalunit numeric,
        nvaltot numeric, cunidade text, ddtprevisao date, cdescricao text, cproduto text, data_atualizacao timestamptz DEFAULT now()
      )`);
  /** Insere um item na copia de teste. Defaults: PC 304 da Replas, 18.000 kg a R$ 11,30, nada recebido. */
  const itemCopia = (tabela: string, o: Record<string, unknown>) => {
    const v = {
      ncodped: PED_A, ncoditem: IT_A1, cnumero: ' 306 ', cetapa: '15', ncodfor: COD_MATRIZ, nqtde: 13750, nqtderec: 0, nvalunit: 10.8,
      nvaltot: 148500, cunidade: 'kg', ddtprevisao: '2026-11-05', cdescricao: 'MC PEAD ES', cproduto: 'PEAD', ...o,
    };
    return pool.query(
      `INSERT INTO public."${tabela}" (ncodped, ncoditem, cnumero, cetapa, ncodfor, nqtde, nqtderec, nvalunit, nvaltot, cunidade, ddtprevisao, cdescricao, cproduto)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [v.ncodped, v.ncoditem, v.cnumero, v.cetapa, v.ncodfor, v.nqtde, v.nqtderec, v.nvalunit, v.nvaltot, v.cunidade, v.ddtprevisao, v.cdescricao, v.cproduto],
    );
  };
  const linhaCache = async (empresa: string, item: number) => {
    const { rows } = await pool.query(
      `SELECT *, dt_previsao::text AS dt_previsao_txt FROM stockbridge.pedido_compra_visto WHERE empresa = $1 AND n_cod_item = $2`,
      [empresa, item],
    );
    return rows[0] ?? null;
  };
  const auditoriaDe = async (id: string) => {
    const { rows } = await pool.query(
      `SELECT operation, old_values, new_values FROM shared.audit_log WHERE schema_name = 'stockbridge' AND table_name = 'pedido_compra_visto' AND record_id = $1 ORDER BY id`,
      [id],
    );
    return rows;
  };

  beforeAll(async () => {
    const core = await import('@atlas/core');
    pool = core.getPool() as unknown as Pool;
    srv = await import('../services/pc-visto.service.js');
    srv.__resetRegistroPcsVistos();
  });

  afterAll(async () => {
    if (!pool) return;
    // Dado de teste: hard delete permitido (a trigger registra o DELETE).
    await pool.query(`DELETE FROM stockbridge.pedido_compra_visto WHERE n_cod_item BETWEEN $1 AND $2`, [BASE, BASE + 99]);
    if (criouCopiaQ2p) await pool.query(`DROP TABLE IF EXISTS public."tbl_pedidosCompras_Q2P"`);
    if (criouCopiaAcxe) await pool.query(`DROP TABLE IF EXISTS public."tbl_pedidosCompras_ACXE"`);
    if (criouCadastroQ2p) await pool.query(`DROP TABLE IF EXISTS public."tbl_cadastroFornecedoresClientes_Q2P"`);
    if (criouCadastroAcxe) await pool.query(`DROP TABLE IF EXISTS public."tbl_cadastroFornecedoresClientes_ACXE"`);
  });

  // ── Estrutura ──────────────────────────────────────────────────────────────

  it('a tabela, as colunas, os índices e a trigger de auditoria existem', async () => {
    const cols = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'stockbridge' AND table_name = 'pedido_compra_visto' ORDER BY ordinal_position`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      'id', 'empresa', 'n_cod_ped', 'n_cod_item', 'pc_numero', 'n_cod_for', 'produto_descricao', 'unidade', 'qtde', 'qtde_rec', 'preco_unit',
      'etapa', 'dt_previsao', 'valor_total_pc', 'visto_em', 'created_at', 'updated_at',
    ]);
    const obrigatorias = cols.rows.filter((c) => c.is_nullable === 'NO').map((c) => c.column_name);
    expect(obrigatorias).toEqual(['id', 'empresa', 'n_cod_ped', 'n_cod_item', 'pc_numero', 'visto_em', 'created_at', 'updated_at']);

    const idx = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'stockbridge' AND tablename = 'pedido_compra_visto'`);
    expect(idx.rows.map((i) => i.indexname).sort()).toEqual(['pedido_compra_visto_for_idx', 'pedido_compra_visto_item_uq', 'pedido_compra_visto_ped_idx', 'pedido_compra_visto_pkey']);

    const trg = await pool.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'stockbridge.pedido_compra_visto'::regclass AND NOT tgisinternal`,
    );
    expect(trg.rows.map((t) => t.tgname)).toEqual(['trg_audit_sb_pedido_compra_visto']);
  });

  it('empresa só aceita q2p e acxe (CHECK); UNIQUE (empresa, n_cod_item): o mesmo item de PC não duplica, mas pode existir nas duas empresas', async () => {
    const ins = (empresa: string, item: number) =>
      pool.query(`INSERT INTO stockbridge.pedido_compra_visto (empresa, n_cod_ped, n_cod_item) VALUES ($1, $2, $3) RETURNING id`, [empresa, PED_C, item]);

    await expect(ins('xx', IT_C1)).rejects.toMatchObject({ code: '23514' });

    const { rows } = await ins('q2p', IT_C1);
    expect(rows).toHaveLength(1);
    await expect(ins('q2p', IT_C1)).rejects.toMatchObject({ code: '23505', constraint: 'pedido_compra_visto_item_uq' });
    await expect(ins('acxe', IT_C1)).resolves.toBeDefined(); // outra empresa: outra chave

    const linha = await linhaCache('q2p', IT_C1);
    expect(linha).toMatchObject({ pc_numero: '', n_cod_for: null, qtde: null });
    expect(linha!.visto_em).toBeInstanceOf(Date);
  });

  // ── Trigger de auditoria ───────────────────────────────────────────────────

  it('INSERT, UPDATE e DELETE são auditados em shared.audit_log, com os valores antigo e novo', async () => {
    const { rows } = await pool.query(
      `INSERT INTO stockbridge.pedido_compra_visto (empresa, n_cod_ped, n_cod_item, pc_numero, qtde, qtde_rec) VALUES ('q2p', $1, $2, '306', 13750, 0) RETURNING id`,
      [PED_B, IT_B1],
    );
    const id = String(rows[0]!.id);
    await pool.query(`UPDATE stockbridge.pedido_compra_visto SET qtde_rec = 8250 WHERE id = $1`, [id]);
    await pool.query(`DELETE FROM stockbridge.pedido_compra_visto WHERE id = $1`, [id]);

    const audit = await auditoriaDe(id);
    expect(audit.map((a) => a.operation)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
    expect(audit[0]).toMatchObject({ old_values: null });
    expect((audit[0]!.new_values as Record<string, unknown>).n_cod_item).toBe(IT_B1);
    expect(Number((audit[1]!.old_values as Record<string, unknown>).qtde_rec)).toBe(0);
    expect(Number((audit[1]!.new_values as Record<string, unknown>).qtde_rec)).toBe(8250);
    expect(audit[2]!.new_values).toBeNull();
    expect((audit[2]!.old_values as Record<string, unknown>).pc_numero).toBe('306');
  });

  // ── Upsert de registrarPcsVistos (SQL real) ────────────────────────────────

  describe('registrarPcsVistos — só grava (e só audita) o que mudou', () => {
    let pronto = false;

    beforeAll(async () => {
      if ((await existe('tbl_pedidosCompras_Q2P')) || (await existe('tbl_pedidosCompras_ACXE'))) return; // espelho real: nao escreve
      await criarCopia('tbl_pedidosCompras_Q2P');
      criouCopiaQ2p = true;
      await criarCopia('tbl_pedidosCompras_ACXE');
      criouCopiaAcxe = true;
      pronto = true;
    });

    it('1ª rodada: grava todos os itens da cópia (3) com os valores normalizados; o valor total do PC é a soma dos itens do mesmo pedido', async (ctx) => {
      if (!pronto) return ctx.skip();
      await itemCopia('tbl_pedidosCompras_Q2P', {});
      await itemCopia('tbl_pedidosCompras_Q2P', { ncoditem: IT_A2, cdescricao: null, cproduto: 'PELBD', nqtde: 11000, nvaltot: 118800, cunidade: ' Ton ' });
      await itemCopia('tbl_pedidosCompras_Q2P', { ncodped: PED_B, ncoditem: IT_B1, cnumero: '310', ncodfor: COD_FILIAL, nvaltot: null, nqtde: 10, nvalunit: 5000 });
      // linhas sem id (lixo do espelho) nunca entram
      await pool.query(`INSERT INTO public."tbl_pedidosCompras_Q2P" (ncodped, ncoditem) VALUES (NULL, $1), ($2, NULL)`, [IT_A1 + 1000, PED_A]);

      const n = await srv.registrarPcsVistos('q2p');
      expect(n).toBe(3);

      const a1 = await linhaCache('q2p', IT_A1);
      expect(a1).toMatchObject({
        empresa: 'q2p', n_cod_ped: String(PED_A), pc_numero: '306', n_cod_for: String(COD_MATRIZ), produto_descricao: 'MC PEAD ES', unidade: 'KG',
        etapa: '15', valor_total_pc: '267300.00',
      });
      expect(Number(a1!.qtde)).toBe(13750);
      expect(Number(a1!.preco_unit)).toBe(10.8);
      // descrição cai no código do produto; unidade apara e vai a caixa alta
      expect(await linhaCache('q2p', IT_A2)).toMatchObject({ produto_descricao: 'PELBD', unidade: 'TON', valor_total_pc: '267300.00' });
      // sem nvaltot: usa nqtde × nvalunit (10 × 5000)
      expect(await linhaCache('q2p', IT_B1)).toMatchObject({ valor_total_pc: '50000.00' });
      expect(a1!.dt_previsao_txt).toBe('2026-11-05');

      const audit = await auditoriaDe(String(a1!.id));
      expect(audit.map((x) => x.operation)).toEqual(['INSERT']);
    });

    it('2ª rodada SEM mudança: 0 linhas gravadas, nenhum UPDATE, nenhuma linha nova de auditoria e visto_em intocado', async (ctx) => {
      if (!pronto) return ctx.skip();
      const antes = await linhaCache('q2p', IT_A1);
      const auditAntes = (await auditoriaDe(String(antes!.id))).length;
      await new Promise((r) => setTimeout(r, 25)); // now() precisa andar para o visto_em denunciar um UPDATE indevido

      expect(await srv.registrarPcsVistos('q2p')).toBe(0);

      const depois = await linhaCache('q2p', IT_A1);
      expect(depois!.visto_em).toEqual(antes!.visto_em);
      expect(depois!.updated_at).toEqual(antes!.updated_at);
      expect((await auditoriaDe(String(antes!.id))).length).toBe(auditAntes);
    });

    it('mudança real (nqtderec 0 → 8.250): grava SÓ essa linha, com 1 UPDATE auditado (old/new) e visto_em/updated_at novos; as outras ficam como estavam', async (ctx) => {
      if (!pronto) return ctx.skip();
      const a1 = await linhaCache('q2p', IT_A1);
      const b1 = await linhaCache('q2p', IT_B1);
      await new Promise((r) => setTimeout(r, 25));
      // item 2 do mesmo PC mantém o valor total (nvaltot igual), então só o item 1 muda
      await pool.query(`UPDATE public."tbl_pedidosCompras_Q2P" SET nqtderec = 8250 WHERE ncoditem = $1`, [IT_A1]);

      expect(await srv.registrarPcsVistos('q2p')).toBe(1);

      const novo = await linhaCache('q2p', IT_A1);
      expect(Number(novo!.qtde_rec)).toBe(8250);
      expect((novo!.visto_em as Date).getTime()).toBeGreaterThan((a1!.visto_em as Date).getTime());
      expect((novo!.updated_at as Date).getTime()).toBeGreaterThan((a1!.updated_at as Date).getTime());
      const audit = await auditoriaDe(String(a1!.id));
      expect(audit.map((x) => x.operation)).toEqual(['INSERT', 'UPDATE']);
      expect(Number((audit[1]!.old_values as Record<string, unknown>).qtde_rec)).toBe(0);
      expect(Number((audit[1]!.new_values as Record<string, unknown>).qtde_rec)).toBe(8250);
      expect((await linhaCache('q2p', IT_B1))!.visto_em).toEqual(b1!.visto_em);
    });

    it('mudança no valor de um item muda o valor total do PC e portanto TODOS os itens desse pedido (2 linhas gravadas); o outro pedido não', async (ctx) => {
      if (!pronto) return ctx.skip();
      await pool.query(`UPDATE public."tbl_pedidosCompras_Q2P" SET nvaltot = 100000 WHERE ncoditem = $1`, [IT_A2]);
      expect(await srv.registrarPcsVistos('q2p')).toBe(2);
      expect((await linhaCache('q2p', IT_A1))!.valor_total_pc).toBe('248500.00');
      expect((await linhaCache('q2p', IT_A2))!.valor_total_pc).toBe('248500.00');
    });

    it('cada coluna comparada dispara o UPDATE quando muda (número, etapa, preço, unidade, previsão, fornecedor, pedido)', async (ctx) => {
      if (!pronto) return ctx.skip();
      const mudancas: Array<[string, unknown]> = [
        ['cnumero', '307'], ['cetapa', '10'], ['nvalunit', 11.5], ['cunidade', 'TON'], ['ddtprevisao', '2026-12-01'], ['ncodfor', COD_OUTRA], ['ncodped', PED_C],
      ];
      for (const [coluna, valor] of mudancas) {
        await pool.query(`UPDATE public."tbl_pedidosCompras_Q2P" SET ${coluna} = $1 WHERE ncoditem = $2`, [valor, IT_B1]);
        expect(await srv.registrarPcsVistos('q2p'), `mudar ${coluna} deve gravar 1 linha`).toBe(1);
        expect(await srv.registrarPcsVistos('q2p'), `sem nova mudança em ${coluna}`).toBe(0);
      }
      expect(await linhaCache('q2p', IT_B1)).toMatchObject({
        pc_numero: '307', etapa: '10', unidade: 'TON', n_cod_for: String(COD_OUTRA), n_cod_ped: String(PED_C), dt_previsao_txt: '2026-12-01',
      });
    });

    it('o item que SAI da cópia (PC com item associado a recebimento aberto — PC 306) permanece no cache com o último saldo visto', async (ctx) => {
      if (!pronto) return ctx.skip();
      await pool.query(`DELETE FROM public."tbl_pedidosCompras_Q2P" WHERE ncoditem = $1`, [IT_A2]);
      expect(await srv.registrarPcsVistos('q2p')).toBe(1); // o valor total do PC A mudou para o item que sobrou
      const fantasma = await linhaCache('q2p', IT_A2);
      expect(fantasma).not.toBeNull();
      expect(Number(fantasma!.qtde)).toBe(11000);
    });

    it('ncoditem repetido na cópia: não aborta o upsert (21000), vale a linha mais recente e a repetição não entra no valor total do PC', async (ctx) => {
      if (!pronto) return ctx.skip();
      const antes = await linhaCache('q2p', IT_A1);
      // repetição MAIS ANTIGA do item 1, com outro saldo recebido: ignorada (nem no saldo, nem no valor total do PC A)
      await itemCopia('tbl_pedidosCompras_Q2P', { nqtderec: 1 });
      await pool.query(`UPDATE public."tbl_pedidosCompras_Q2P" SET data_atualizacao = now() - interval '1 day' WHERE ncoditem = $1 AND nqtderec = 1`, [IT_A1]);
      expect(await srv.registrarPcsVistos('q2p')).toBe(0);
      expect(await linhaCache('q2p', IT_A1)).toMatchObject({ qtde_rec: antes!.qtde_rec, valor_total_pc: antes!.valor_total_pc });

      // a repetição passa a ser a MAIS RECENTE: é ela que vale
      await pool.query(`UPDATE public."tbl_pedidosCompras_Q2P" SET data_atualizacao = now() + interval '1 second' WHERE ncoditem = $1 AND nqtderec = 1`, [IT_A1]);
      expect(await srv.registrarPcsVistos('q2p')).toBe(1);
      expect(Number((await linhaCache('q2p', IT_A1))!.qtde_rec)).toBe(1);

      // limpeza: some a repetição, o item volta ao que era
      await pool.query(`DELETE FROM public."tbl_pedidosCompras_Q2P" WHERE ncoditem = $1 AND nqtderec = 1`, [IT_A1]);
      expect(await srv.registrarPcsVistos('q2p')).toBe(1);
      expect((await linhaCache('q2p', IT_A1))!.qtde_rec).toBe(antes!.qtde_rec);
    });

    it('as duas empresas são independentes: a cópia da ACXE grava empresa "acxe" mesmo com o mesmo n_cod_item da Q2P', async (ctx) => {
      if (!pronto) return ctx.skip();
      await itemCopia('tbl_pedidosCompras_ACXE', { ncodped: PED_A, ncoditem: IT_A1, cnumero: '9', nqtde: 5 });
      expect(await srv.registrarPcsVistos('acxe')).toBe(1);
      expect(await linhaCache('acxe', IT_A1)).toMatchObject({ empresa: 'acxe', pc_numero: '9' });
      expect((await linhaCache('q2p', IT_A1))!.pc_numero).toBe('306');
    });

    it('cópia inexistente: registrarPcsVistos NUNCA lança — devolve 0', async (ctx) => {
      if (!pronto) return ctx.skip();
      await pool.query(`ALTER TABLE public."tbl_pedidosCompras_ACXE" RENAME TO "tbl_pedidosCompras_ACXE_x"`);
      try {
        await expect(srv.registrarPcsVistos('acxe')).resolves.toBe(0);
      } finally {
        await pool.query(`ALTER TABLE public."tbl_pedidosCompras_ACXE_x" RENAME TO "tbl_pedidosCompras_ACXE"`);
      }
    });
  });

  // ── lerPcsVistos / numerosPcsVistos (SQL real) ─────────────────────────────

  describe('lerPcsVistos e numerosPcsVistos — por fornecedor, raiz de CNPJ e pedido', () => {
    let pronto = false;

    beforeAll(async () => {
      if ((await existe('tbl_cadastroFornecedoresClientes_Q2P')) || (await existe('tbl_cadastroFornecedoresClientes_ACXE'))) return; // cadastro real: nao escreve
      await pool.query(`CREATE TABLE public."tbl_cadastroFornecedoresClientes_Q2P" (codigo_cliente_omie bigint, cnpj_cpf text)`);
      criouCadastroQ2p = true;
      await pool.query(`CREATE TABLE public."tbl_cadastroFornecedoresClientes_ACXE" (codigo_cliente_omie bigint, cnpj_cpf text)`);
      criouCadastroAcxe = true;
      await pool.query(
        `INSERT INTO public."tbl_cadastroFornecedoresClientes_Q2P" (codigo_cliente_omie, cnpj_cpf) VALUES
           ($1, '61.827.663/0013-02'), ($2, '61827663000179'), ($3, '99.999.999/0001-00'), ($4, '123.456.789-01')`,
        [COD_FILIAL, COD_MATRIZ, COD_OUTRA, COD_CPF],
      );
      // cache: PC 306 na matriz, PC 304 na filial, PC 277 em outra empresa, PC de pessoa fisica
      const ins = (ped: number, item: number, numero: string, forn: number, extra: { unid?: string; qtde?: number; rec?: number; valor?: number } = {}) =>
        pool.query(
          `INSERT INTO stockbridge.pedido_compra_visto (empresa, n_cod_ped, n_cod_item, pc_numero, n_cod_for, unidade, qtde, qtde_rec, preco_unit, etapa, valor_total_pc)
           VALUES ('q2p', $1, $2, $3, $4, $5, $6, $7, 10.8, '15', $8)
           ON CONFLICT (empresa, n_cod_item) DO NOTHING`,
          [ped, item, numero, forn, extra.unid ?? 'KG', extra.qtde ?? 13750, extra.rec ?? 3750, extra.valor ?? 148500],
        );
      await pool.query(`DELETE FROM stockbridge.pedido_compra_visto WHERE n_cod_item BETWEEN $1 AND $2`, [BASE, BASE + 99]);
      await ins(PED_A, IT_A1, '306', COD_MATRIZ);
      await ins(PED_A, IT_A2, '306', COD_MATRIZ, { unid: 'TON', qtde: 11, rec: 0 });
      await ins(PED_B, IT_B1, '304', COD_FILIAL);
      await ins(PED_C, IT_C1, '277', COD_OUTRA);
      await ins(PED_C, BASE + 32, '', COD_CPF);
      // PC 304 da filial visto pela última vez há 8 dias (saiu da lista por recebimento total/cancelamento): fora da validade
      await ins(PED_B, BASE + 33, '304', COD_FILIAL);
      await pool.query(`UPDATE stockbridge.pedido_compra_visto SET visto_em = now() - interval '8 days' WHERE empresa = 'q2p' AND n_cod_item = $1`, [BASE + 33]);
      pronto = true;
    });

    const itens = (r: Array<{ nCodItem: number }>) => r.map((p) => p.nCodItem).sort((a, b) => a - b);

    it('por fornecedor: só os itens do cadastro pedido', async (ctx) => {
      if (!pronto) return ctx.skip();
      expect(itens(await srv.lerPcsVistos('q2p', { fornecedores: [COD_FILIAL], raizes: [], nCodPeds: [] }))).toEqual([IT_B1]);
      expect(itens(await srv.lerPcsVistos('q2p', { fornecedores: [COD_FILIAL, COD_OUTRA], raizes: [], nCodPeds: [] }))).toEqual([IT_B1, IT_C1]);
    });

    it('por raiz de CNPJ: traz os PCs da matriz E da filial (mesma raiz), nunca o de outra empresa', async (ctx) => {
      if (!pronto) return ctx.skip();
      const r = await srv.lerPcsVistos('q2p', { fornecedores: [], raizes: ['61827663'], nCodPeds: [] });
      expect(itens(r)).toEqual([IT_A1, IT_A2, IT_B1]);
      expect(r.every((p) => p.raizCnpj === '61827663')).toBe(true);
      expect(new Set(r.map((p) => p.cnpjCadastro))).toEqual(new Set(['61827663000179', '61827663001302']));
    });

    it('cadastro de pessoa física (CPF) nunca casa por raiz', async (ctx) => {
      if (!pronto) return ctx.skip();
      expect(await srv.lerPcsVistos('q2p', { fornecedores: [], raizes: ['12345678'], nCodPeds: [] })).toEqual([]);
      expect(await srv.lerPcsVistos('q2p', { fornecedores: [], raizes: ['123.456.7'], nCodPeds: [] })).toEqual([]);
    });

    it('por pedido: traz o PC do vínculo do OMIE mesmo de OUTRO fornecedor', async (ctx) => {
      if (!pronto) return ctx.skip();
      expect(itens(await srv.lerPcsVistos('q2p', { fornecedores: [], raizes: [], nCodPeds: [PED_C] }))).toEqual([IT_C1, BASE + 32]);
    });

    it('validade: item visto há mais de 7 dias não volta por fornecedor nem por raiz (candidato), mas volta por pedido (vínculo do OMIE)', async (ctx) => {
      if (!pronto) return ctx.skip();
      expect(itens(await srv.lerPcsVistos('q2p', { fornecedores: [COD_FILIAL], raizes: [], nCodPeds: [] }))).toEqual([IT_B1]);
      expect(itens(await srv.lerPcsVistos('q2p', { fornecedores: [], raizes: ['61827663'], nCodPeds: [] }))).toEqual([IT_A1, IT_A2, IT_B1]);
      expect(itens(await srv.lerPcsVistos('q2p', { fornecedores: [], raizes: [], nCodPeds: [PED_B] }))).toEqual([IT_B1, BASE + 33]);
    });

    it('os três critérios somam (OU), sem repetir o item', async (ctx) => {
      if (!pronto) return ctx.skip();
      const r = await srv.lerPcsVistos('q2p', { fornecedores: [COD_FILIAL], raizes: ['61827663'], nCodPeds: [PED_A, PED_C] });
      expect(itens(r)).toEqual([IT_A1, IT_A2, IT_B1, IT_C1, BASE + 32]);
    });

    it('a empresa isola: a ACXE não enxerga os PCs da Q2P', async (ctx) => {
      if (!pronto) return ctx.skip();
      expect(await srv.lerPcsVistos('acxe', { fornecedores: [COD_FILIAL], raizes: ['61827663'], nCodPeds: [PED_A] })).toEqual([]);
    });

    it('o mapeamento sai na forma da cópia: kg, saldo, preço por kg, PC-espelho e instante visto', async (ctx) => {
      if (!pronto) return ctx.skip();
      const r = await srv.lerPcsVistos('q2p', { fornecedores: [COD_MATRIZ], raizes: [], nCodPeds: [] });
      const kg = r.find((p) => p.nCodItem === IT_A1)!;
      expect(kg).toMatchObject({ nCodPed: PED_A, pcNumero: '306', etapa: '15', nCodFor: COD_MATRIZ, unidade: 'KG', qtdPedidaKg: 13750, saldoCopiaKg: 10000, pcEspelho: false });
      expect(kg.precoKg).toBeCloseTo(10.8, 6);
      expect(Math.abs(kg.vistoEmMs - Date.now())).toBeLessThan(10 * 60_000);
      expect(kg.atualizadoEmMs).toBe(kg.vistoEmMs);
      const ton = r.find((p) => p.nCodItem === IT_A2)!;
      expect(ton).toMatchObject({ unidade: 'TON', qtdPedidaKg: 11000, saldoCopiaKg: 11000 });
      expect(ton.precoKg).toBeCloseTo(0.0108, 8);
    });

    it('numerosPcsVistos: número legível por pedido (MIN entre os itens), ignorando número vazio', async (ctx) => {
      if (!pronto) return ctx.skip();
      const m = await srv.numerosPcsVistos('q2p', [PED_A, PED_B, PED_C, BASE + 9999]);
      expect(Object.fromEntries(m)).toEqual({ [PED_A]: '306', [PED_B]: '304', [PED_C]: '277' });
      expect((await srv.numerosPcsVistos('acxe', [PED_A])).size).toBe(0);
    });
  });

  // ── Idempotência da migration ─────────────────────────────────────────────

  it('reaplicar a 0057 é seguro (IF NOT EXISTS / OR REPLACE / DROP TRIGGER IF EXISTS): sem erro, sem perder linhas e com uma só trigger', async () => {
    const arquivo = fileURLToPath(new URL('../../../../packages/db/migrations/0057_stockbridge_pedido_compra_visto.sql', import.meta.url));
    const sql = readFileSync(arquivo, 'utf8');
    const antes = await pool.query(`SELECT count(*)::int AS n FROM stockbridge.pedido_compra_visto`);
    await pool.query(sql);
    const depois = await pool.query(`SELECT count(*)::int AS n FROM stockbridge.pedido_compra_visto`);
    expect(depois.rows[0]!.n).toBe(antes.rows[0]!.n);
    const trg = await pool.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'stockbridge.pedido_compra_visto'::regclass AND NOT tgisinternal`);
    expect(trg.rows[0]!.n).toBe(1);
  });
});
