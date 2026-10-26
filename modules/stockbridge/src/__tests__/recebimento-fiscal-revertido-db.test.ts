import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Feature 017, research D21 (ACXEGDP-437) — o ENCAIXE do fiscal revertido no ledger, contra Postgres REAL (opt-in).
//
// O que so o banco prova: o SINAL real (SQL com d_alt/h_alt do espelho, fuso e margem de 2 min) decidindo dentro de
// adquirirLedger, a marcacao 'revertido' (ledger + vinculos de PC na mesma transacao) liberando a trava da NF e o
// item de PC, a nova tentativa do fiscal concluindo (e o sinal desligando depois da conclusao nova), a corrida de dois
// cliques e a listagem do ledger com as colunas da 0060. O OMIE e mockado (nenhuma chamada sai do processo); o
// restante — services, ledger, espelho — e o real. Os mesmos cenarios com SQL simulado estao em recebimento-fiscal*.test.ts.
//
// Rodar (banco descartavel migrado ate a 0060; escreve e apaga linhas de teste, chaves 97...; shared.audit_log e
// append-only e fica com rastro — NUNCA contra UAT/PROD). Cria as tabelas do espelho que faltarem no schema public e as remove no
// fim: com o opt-in o vitest.config.ts do modulo roda os arquivos um por vez (fora dele, use --no-file-parallelism):
//   ATLAS_DB_INTEGRATION=1 DATABASE_URL=postgres://... pnpm --filter @atlas/stockbridge exec vitest run src/__tests__/recebimento-fiscal-revertido-db.test.ts

const DB_URL = process.env.DATABASE_URL;
const temBanco = process.env.ATLAS_DB_INTEGRATION === '1' && typeof DB_URL === 'string' && DB_URL.length > 0;

// A D21 so vale com a chave da 016 ligada (o config e lido uma vez, na primeira chamada). So com o opt-in do banco:
// sem ele o arquivo e pulado e nao mexe no ambiente.
vi.hoisted(() => {
  if (process.env.ATLAS_DB_INTEGRATION === '1') {
    process.env.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = 'true';
    process.env.STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED = 'true';
  }
});

const omie = vi.hoisted(() => ({ consultar: vi.fn(), alterar: vi.fn(), concluir: vi.fn() }));
vi.mock('@atlas/integration-omie', () => ({
  consultarRecebimentoNfe: (...a: unknown[]) => omie.consultar(...a),
  alterarRecebimentoNfeItens: (...a: unknown[]) => omie.alterar(...a),
  concluirRecebimentoNfe: (...a: unknown[]) => omie.concluir(...a),
  consultarPedidoCompra: vi.fn(),
}));

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

const FORNECEDOR_COD = 8498397152;
const N_ID_RECEB_BASE = 7_970_000_000;
const MIN = 60 * 1000;
const HORA = 60 * MIN;

describe.skipIf(!temBanco)('D21 — adquirirLedger e concluirRecebimentoFiscal contra o banco (integracao)', () => {
  let pool: Pool;
  let uid: string;
  let pronto = false;
  let criouHeader = false;
  const chaves: string[] = [];
  let seq = 0;
  let service: typeof import('../services/recebimento-fiscal.service.js');
  let revertido: typeof import('../services/fiscal-revertido.js');

  beforeAll(async () => {
    const core = await import('@atlas/core');
    pool = core.getPool() as unknown as Pool;
    const { rows: col } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'stockbridge' AND table_name = 'recebimento_fiscal' AND column_name = 'revertido_em'`,
    );
    if (col.length === 0) {
      console.warn('[recebimento-fiscal-revertido-db] migration 0060 ausente neste banco — testes pulados');
      return;
    }
    const { rows: us } = await pool.query(`SELECT id FROM atlas.users ORDER BY created_at LIMIT 1`);
    if (us.length === 0) {
      console.warn('[recebimento-fiscal-revertido-db] precisa de ao menos um usuario em atlas.users — testes pulados');
      return;
    }
    uid = String(us[0]!.id);
    // O espelho de NF e escrito pelo n8n (OMIE -> Postgres) e nao tem migration: cria se faltar (mesmo DDL dos outros testes de banco
    // da D21), e remove ao final. Se ja existir, precisa ter as colunas que o sinal le.
    const { rows: h } = await pool.query(`SELECT to_regclass('public."tbl_nf_header_Q2P"') IS NOT NULL AS existe`);
    if (h[0]!.existe !== true) {
      await pool.query(`CREATE TABLE public."tbl_nf_header_Q2P" (
        n_id_nf bigint PRIMARY KEY, c_chave_nfe varchar(44), n_nf varchar(20), dest_razao varchar(200), dest_cnpj_cpf varchar(20),
        d_emi date, n_id_receb bigint, cancelada boolean NOT NULL DEFAULT false, deletada boolean NOT NULL DEFAULT false, tp_nf smallint,
        d_alt date, h_alt time)`);
      criouHeader = true;
    } else {
      const { rows: cs } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tbl_nf_header_Q2P'`);
      const tem = new Set(cs.map((c) => String(c.column_name)));
      if (['c_chave_nfe', 'tp_nf', 'd_alt', 'h_alt'].some((c) => !tem.has(c))) {
        console.warn('[recebimento-fiscal-revertido-db] public."tbl_nf_header_Q2P" existe sem as colunas do sinal — testes pulados');
        return;
      }
    }
    service = await import('../services/recebimento-fiscal.service.js');
    revertido = await import('../services/fiscal-revertido.js');
    pronto = await revertido.fiscalRevertidoHabilitado();
    if (!pronto) console.warn('[recebimento-fiscal-revertido-db] fiscalRevertidoHabilitado() = false neste ambiente — testes pulados');
  });

  afterAll(async () => {
    if (!pool) return;
    if (chaves.length > 0) {
      // Dado de teste: hard delete permitido aqui (a trigger registra o DELETE). Filhas antes do ledger (FK).
      await pool.query(`DELETE FROM stockbridge.recebimento_fiscal_pc WHERE nf_chave_acesso = ANY($1::text[])`, [chaves]);
      await pool.query(`DELETE FROM stockbridge.recebimento_fiscal WHERE nf_chave_acesso = ANY($1::text[])`, [chaves]);
      await pool.query(`DELETE FROM public."tbl_recebimentoNFe_Q2P" WHERE c_chave_nfe = ANY($1::text[])`, [chaves]);
      if (!criouHeader) await pool.query(`DELETE FROM public."tbl_nf_header_Q2P" WHERE c_chave_nfe = ANY($1::text[])`, [chaves]);
    }
    if (criouHeader) await pool.query(`DROP TABLE public."tbl_nf_header_Q2P"`);
  });

  beforeEach(() => {
    omie.consultar.mockReset();
    omie.alterar.mockReset();
    omie.concluir.mockReset();
  });

  /** Chave de 44 digitos unica por cenario (faixa 97...). */
  function chaveNova(): string {
    seq += 1;
    const c = `97${String(Date.now()).padStart(13, '0')}${String(seq).padStart(29, '0')}`.slice(0, 44);
    chaves.push(c);
    return c;
  }

  /** Recebimento no OMIE: etapa 40, "nao movimentar estoque" e o vinculo com o PC mantidos (o que a reversao da NF 19252 deixou). */
  const recebimento = (chave: string, nIdReceb: number, over: Record<string, unknown> = {}) => ({
    nIdReceb,
    cChaveNFe: chave,
    cNumeroNFe: '000019252',
    cEtapa: '40',
    dEmissaoNFe: '24/10/2026',
    nIdFornecedor: FORNECEDOR_COD,
    cCNPJ_CPF: '61.827.663/0020-31',
    cRazaoSocial: 'ZARAPLAST S/A',
    nValorNFe: 145750.05,
    cRecebido: 'N',
    cCancelada: 'N',
    cBloqueado: 'N',
    cDevolvido: 'N',
    cUsuarioRec: null,
    dRec: null,
    hRec: null,
    itens: [
      {
        nSequencia: 1, cDescricaoProduto: 'PP NATURAL REPROCESSADO', cCodigoProduto: 'PPNAT', cNCM: '3915.90.00', cCFOP: '5.101', cCFOPEntrada: '1.101',
        nQtdeNFe: 13750, cUnidadeNfe: 'KG', nPrecoUnit: 10.6, vTotalItem: 145750.05, cIgnorarItem: 'N', cAssociarExistente: 'S', cAdicionarNovo: 'N',
        nIdItem: 0, nIdProduto: 0, nIdPedido: 8518524342, nIdItPedido: 8518524343, nNumPedCompra: null, cNumItPedCompra: null,
        cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N',
      },
    ],
    ...over,
  });

  /**
   * Cenario: o Atlas concluiu o fiscal `concluidoHa` ms atras (ledger 'concluido' com uma linha de PC concluida) e o
   * espelho de recebimentos mostra c_recebido `recebido` alterado em `alteradoEm` (horario de Brasilia no d_alt/h_alt).
   */
  async function semear(opts: { chave: string; nIdReceb: number; concluidoHa: number; recebido: 'N' | 'S' | null; alteradoEm?: Date; status?: string }): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO stockbridge.recebimento_fiscal
         (nf_chave_acesso, n_id_receb, nota_fiscal, fornecedor_nome, status, confirmado_por, iniciado_em, finalizado_em, itens_total)
       VALUES ($1, $2, '19252', 'ZARAPLAST S/A', $3::text, $4, now() - ($5::numeric * interval '1 millisecond') - interval '1 minute', now() - ($5::numeric * interval '1 millisecond'), 1)
       RETURNING id`,
      [opts.chave, opts.nIdReceb, opts.status ?? 'concluido', uid, opts.concluidoHa],
    );
    const id = String(rows[0]!.id);
    await pool.query(
      `INSERT INTO stockbridge.recebimento_fiscal_pc
         (recebimento_fiscal_id, nf_chave_acesso, n_sequencia, origem, n_cod_ped, n_cod_item_ped, pc_numero, dentro_tolerancia, qtd_nf_kg, preco_nf, status, confirmado_por, concluido_em)
       VALUES ($1, $2, 1, 'omie', 8518524342, 8518524343, '308', true, 13750, 10.6, 'concluido', $3, now())`,
      [id, opts.chave, uid],
    );
    if (opts.recebido) {
      const alt = (opts.alteradoEm ?? new Date()).toISOString();
      await pool.query(
        `INSERT INTO public."tbl_recebimentoNFe_Q2P" (n_id_receb, c_chave_nfe, c_recebido, c_cancelada, c_etapa, d_alt, h_alt)
         VALUES ($1, $2, $3, 'N', '40', ($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date, to_char($4::timestamptz AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI:SS'))`,
        [opts.nIdReceb, opts.chave, opts.recebido, alt],
      );
    }
    return id;
  }

  const input = (chave: string, nIdReceb: number) => ({
    nfChaveAcesso: chave,
    nIdReceb,
    notaFiscal: '19252',
    fornecedorNome: 'ZARAPLAST S/A',
    userId: uid,
    fornecedorCodigo: FORNECEDOR_COD,
  });

  const ledgers = async (chave: string) =>
    (
      await pool.query(
        `SELECT id, status, revertido_origem, revertido_em IS NOT NULL AS tem_revertido_em, revertido_omie_em, finalizado_em
           FROM stockbridge.recebimento_fiscal WHERE nf_chave_acesso = $1 ORDER BY iniciado_em`,
        [chave],
      )
    ).rows;
  const pcs = async (chave: string) =>
    (await pool.query(`SELECT recebimento_fiscal_id, n_sequencia, status FROM stockbridge.recebimento_fiscal_pc WHERE nf_chave_acesso = $1 ORDER BY created_at, n_sequencia`, [chave])).rows;

  it('NF 19252: concluida pelo Atlas e revertida no portal 11 min depois (espelho em N): o ledger vira revertido, os vinculos tambem, e o fiscal CONCLUI DE NOVO — depois disso o sinal desliga', async (ctx) => {
    if (!pronto) ctx.skip();
    const chave = chaveNova();
    const nIdReceb = N_ID_RECEB_BASE + seq;
    const concluidoHa = 3 * HORA;
    const l1 = await semear({ chave, nIdReceb, concluidoHa, recebido: 'N', alteradoEm: new Date(Date.now() - concluidoHa + 11 * MIN) });
    omie.consultar.mockImplementation(async () => recebimento(chave, nIdReceb));
    omie.alterar.mockResolvedValue({ cCodStatus: '0' });
    omie.concluir.mockResolvedValue({ cCodStatus: '0' });

    // o sinal real, avaliado pelo banco, esta ligado
    expect(await revertido.nfComFiscalRevertido(chave, 'q2p')).toBe(true);

    const r = await service.concluirRecebimentoFiscal(input(chave, nIdReceb));

    expect(r.status).toBe('concluido');
    expect(r.ledgerId).not.toBe(l1);
    // o OMIE manteve o vinculo e os ajustes: so o Concluir (o EDITAR/IGNORAR nunca se repete)
    expect(omie.consultar).toHaveBeenCalledWith('q2p', { cChaveNfe: chave });
    expect(omie.alterar).not.toHaveBeenCalled();
    expect(omie.concluir).toHaveBeenCalledWith('q2p', { nIdReceb, cEtapa: '60' });

    const ls = await ledgers(chave);
    expect(ls.map((x) => x.status)).toEqual(['revertido', 'concluido']);
    expect(String(ls[0]!.id)).toBe(l1);
    expect(ls[0]).toMatchObject({ revertido_origem: 'espelho', tem_revertido_em: true });
    // a hora da alteracao no OMIE (espelho) vai para o rastro: conclusao + 11 min, com folga de 1 min para o arredondamento do h_alt
    const omieEm = new Date(String(ls[0]!.revertido_omie_em)).getTime();
    const esperado = new Date(ls[0]!.finalizado_em as string).getTime() + 11 * MIN;
    expect(Math.abs(omieEm - esperado)).toBeLessThan(MIN);
    expect(String(ls[1]!.id)).toBe(r.ledgerId);

    // vinculos de PC da tentativa antiga saem do indice de item vivo
    expect((await pcs(chave)).map((p) => `${p.n_sequencia}:${p.status}`)).toEqual(['1:revertido']);

    // clique repetido logo depois: a conclusao nova e mais recente que o 'N' do espelho — ja_concluido, sem OMIE
    omie.consultar.mockClear();
    omie.concluir.mockClear();
    expect(await revertido.nfComFiscalRevertido(chave, 'q2p')).toBe(false);
    const r2 = await service.concluirRecebimentoFiscal(input(chave, nIdReceb));
    expect(r2).toMatchObject({ status: 'ja_concluido', ledgerId: r.ledgerId });
    expect(omie.consultar).not.toHaveBeenCalled();
    expect(omie.concluir).not.toHaveBeenCalled();
    expect((await ledgers(chave)).map((x) => x.status)).toEqual(['revertido', 'concluido']);
  });

  it('espelho em N ANTES da conclusao (linha defasada) ou dentro da margem de 2 min: nao e reversao — ja_concluido, sem OMIE, ledger intacto', async (ctx) => {
    if (!pronto) ctx.skip();
    for (const alteradoApos of [-2 * HORA, 60 * 1000]) {
      const chave = chaveNova();
      const nIdReceb = N_ID_RECEB_BASE + seq;
      const concluidoHa = 3 * HORA;
      const l1 = await semear({ chave, nIdReceb, concluidoHa, recebido: 'N', alteradoEm: new Date(Date.now() - concluidoHa + alteradoApos) });
      expect(await revertido.nfComFiscalRevertido(chave, 'q2p')).toBe(false);

      const r = await service.concluirRecebimentoFiscal(input(chave, nIdReceb));

      expect(r).toMatchObject({ status: 'ja_concluido', ledgerId: l1 });
      expect(omie.consultar).not.toHaveBeenCalled();
      expect((await ledgers(chave)).map((x) => x.status)).toEqual(['concluido']);
      expect((await pcs(chave)).map((p) => p.status)).toEqual(['concluido']);
    }
  });

  it('espelho em S depois da conclusao (concluido de novo no portal) e NF sem linha no espelho: ja_concluido', async (ctx) => {
    if (!pronto) ctx.skip();
    const chaveS = chaveNova();
    const nS = N_ID_RECEB_BASE + seq;
    const lS = await semear({ chave: chaveS, nIdReceb: nS, concluidoHa: 3 * HORA, recebido: 'S', alteradoEm: new Date(Date.now() - 2 * HORA) });
    expect(await service.concluirRecebimentoFiscal(input(chaveS, nS))).toMatchObject({ status: 'ja_concluido', ledgerId: lS });

    const chaveSem = chaveNova();
    const nSem = N_ID_RECEB_BASE + seq;
    const lSem = await semear({ chave: chaveSem, nIdReceb: nSem, concluidoHa: 3 * HORA, recebido: null });
    expect(await service.concluirRecebimentoFiscal(input(chaveSem, nSem))).toMatchObject({ status: 'ja_concluido', ledgerId: lSem });
    expect(omie.consultar).not.toHaveBeenCalled();
  });

  it('ja_concluido (fiscal feito no portal e visto pelo Atlas) revertido depois: a mesma reabertura', async (ctx) => {
    if (!pronto) ctx.skip();
    const chave = chaveNova();
    const nIdReceb = N_ID_RECEB_BASE + seq;
    const concluidoHa = 2 * HORA;
    await semear({ chave, nIdReceb, concluidoHa, recebido: 'N', alteradoEm: new Date(Date.now() - concluidoHa + 15 * MIN), status: 'ja_concluido' });
    omie.consultar.mockImplementation(async () => recebimento(chave, nIdReceb));
    omie.concluir.mockResolvedValue({ cCodStatus: '0' });

    const r = await service.concluirRecebimentoFiscal(input(chave, nIdReceb));

    expect(r.status).toBe('concluido');
    expect((await ledgers(chave)).map((x) => x.status)).toEqual(['revertido', 'concluido']);
  });

  it('dois cliques ao mesmo tempo na NF revertida: UM so conclui no OMIE (o outro recebe EmAndamento ou ja_concluido); um ledger vivo, um revertido', async (ctx) => {
    if (!pronto) ctx.skip();
    const chave = chaveNova();
    const nIdReceb = N_ID_RECEB_BASE + seq;
    const concluidoHa = 3 * HORA;
    await semear({ chave, nIdReceb, concluidoHa, recebido: 'N', alteradoEm: new Date(Date.now() - concluidoHa + 11 * MIN) });
    omie.consultar.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150)); // mantem o 1o clique "em andamento" tempo suficiente para o 2o bater na trava
      return recebimento(chave, nIdReceb);
    });
    omie.concluir.mockResolvedValue({ cCodStatus: '0' });

    const resultados = await Promise.allSettled([service.concluirRecebimentoFiscal(input(chave, nIdReceb)), service.concluirRecebimentoFiscal(input(chave, nIdReceb))]);

    const ok = resultados.filter((r) => r.status === 'fulfilled') as Array<PromiseFulfilledResult<Awaited<ReturnType<typeof service.concluirRecebimentoFiscal>>>>;
    const falhas = resultados.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(ok.filter((r) => r.value.status === 'concluido')).toHaveLength(1);
    for (const f of falhas) expect(f.reason).toBeInstanceOf(service.RecebimentoFiscalEmAndamentoError);
    expect(omie.concluir).toHaveBeenCalledTimes(1);
    const ls = await ledgers(chave);
    expect(ls.map((x) => x.status).sort()).toEqual(['concluido', 'revertido']);
  });

  it('ledgerFiscalVigente enxerga a linha concluida e deixa de enxerga-la depois de marcada (a leitura ao vivo do clique depende disso)', async (ctx) => {
    if (!pronto) ctx.skip();
    const chave = chaveNova();
    const nIdReceb = N_ID_RECEB_BASE + seq;
    const id = await semear({ chave, nIdReceb, concluidoHa: 10 * MIN, recebido: null });

    const v = await revertido.ledgerFiscalVigente(chave);
    expect(v).toMatchObject({ id, status: 'concluido', empresa: 'q2p', nIdReceb, notaFiscal: '19252', fornecedorNome: 'ZARAPLAST S/A' });
    expect(revertido.leituraAoVivoPodeDeclararReversao(v!.finalizadoEm)).toBe(true);

    await revertido.marcarLedgerRevertido({ nfChaveAcesso: chave, empresa: 'q2p', origem: 'omie_ao_vivo', ledgerId: id, userId: uid });
    expect(await revertido.ledgerFiscalVigente(chave)).toBeNull();
  });

  it('listarLedgerFiscal real: status=revertido devolve o rastro da 0060 (revertidoEm, origem, hora no OMIE) e os vinculos revertidos, sem erro_omie_*', async (ctx) => {
    if (!pronto) ctx.skip();
    const chave = chaveNova();
    const nIdReceb = N_ID_RECEB_BASE + seq;
    const concluidoHa = 3 * HORA;
    const id = await semear({ chave, nIdReceb, concluidoHa, recebido: 'N', alteradoEm: new Date(Date.now() - concluidoHa + 11 * MIN) });
    await revertido.marcarLedgerRevertido({ nfChaveAcesso: chave, empresa: 'q2p', origem: 'espelho', ledgerId: id });

    const lista = await service.listarLedgerFiscal({ status: 'revertido', limit: 200 });
    const meu = lista.find((x) => x.id === id);
    expect(meu).toBeDefined();
    expect(meu).toMatchObject({ status: 'revertido', notaFiscal: '19252', revertidoOrigem: 'espelho', empresa: 'q2p' });
    expect(typeof meu!.revertidoEm).toBe('string');
    expect(typeof meu!.revertidoOmieEm).toBe('string');
    expect(meu!.vinculos.map((v) => `${v.pcNumero}:${v.status}`)).toEqual(['308:revertido']);
    expect(JSON.stringify(meu)).not.toContain('erro_omie');
    // sem filtro tambem lista (a coluna existe), e os concluidos trazem os campos nulos
    const todos = await service.listarLedgerFiscal({ limit: 200 });
    expect(todos.some((x) => x.id === id)).toBe(true);
  });
});
