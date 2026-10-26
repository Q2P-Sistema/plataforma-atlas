import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Feature 017 (ACXEGDP-437), research D20 — baixa do PC pelo peso conferido com o SQL EXECUTADO num Postgres real
// (migration 0059). Prova o que os testes com dublê so leem no texto:
//  - a reserva grava kg_recebido_pc (coluna nova) e a auditoria a registra;
//  - a soma das reservas de OUTRAS NFs usa COALESCE(kg_recebido_pc, qtd_nf_kg) — a 2a NF no mesmo item de PC so
//    tem o saldo que a 1a deixou pelo PESO CONFERIDO, nao pela NF;
//  - a consulta do aviso na rejeicao (sequencias da movimentacao x vinculo concluido acima da NF);
//  - os CHECKs da 0059 (kg_recebido_pc > 0 e o motivo 'excedente_rejeitado' do aviso a compras).
//
// Opt-in: ATLAS_DB_INTEGRATION=1 + DATABASE_URL, com o schema stockbridge ate a 0059. Sem isso o describe e PULADO.
// Nunca chama o OMIE (dublê) nem envia e-mail (o aviso e substituido). Chaves de acesso de teste comecam com 99.
// Os arquivos de banco criam e removem as mesmas tabelas do espelho: com o opt-in o vitest.config.ts do modulo os roda um
// por vez (fora dele, use --no-file-parallelism).
//
//   ATLAS_DB_INTEGRATION=1 DATABASE_URL=postgres://... REDIS_URL=redis://localhost:6379 SESSION_SECRET=<32+ chars> \
//     pnpm --filter @atlas/stockbridge exec vitest run src/__tests__/pc-peso-conferido-db.test.ts

const DB_URL = process.env.DATABASE_URL;
const temBanco = process.env.ATLAS_DB_INTEGRATION === '1' && typeof DB_URL === 'string' && DB_URL.length > 0;

const h = vi.hoisted(() => ({
  config: { STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO: true, STOCKBRIDGE_COMPRAS_EMAILS: ['compras@teste.local'] } as Record<string, unknown>,
  consultarPedidoCompra: vi.fn(),
  aviso: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('@atlas/core', async () => {
  const real = await vi.importActual<typeof import('@atlas/core')>('@atlas/core');
  const calado = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
  return { ...real, createLogger: () => calado, getConfig: () => h.config, sendEmail: (...a: unknown[]) => h.sendEmail(...a) };
});
vi.mock('@atlas/integration-omie', () => ({
  consultarPedidoCompra: (...a: unknown[]) => h.consultarPedidoCompra(...a),
}));
vi.mock('../services/notificacao.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/notificacao.service.js')>('../services/notificacao.service.js');
  return {
    ...real,
    enviarAvisoComprasExcedenteRejeitado: (...a: unknown[]) => h.aviso(...a),
    carregarContextoEntradaNacional: async () => null,
  };
});

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

const BASE = 6_000_000_000_000 + Math.floor(Math.random() * 900_000_000) * 1000;
const chave = (n: number): string => `99${String(BASE + n).padStart(42, '0')}`;
const PED = BASE + 1;
const ITEM = BASE + 2;
const FORNECEDOR = BASE + 3;
const ITEM2 = BASE + 4;
const NF_A = chave(10);
const NF_B = chave(11);
const NF_C = chave(12);
const NF_D = chave(13);

describe.skipIf(!temBanco)('migration 0059 — baixa do PC pelo peso conferido (integracao)', () => {
  let pool: Pool;
  let pronto = false;
  let usuario = '';
  let criouUsuario = false;
  const ledgers: string[] = [];
  const movs: string[] = [];
  const aprovacoes: string[] = [];
  let svc: typeof import('../services/pc-sugestao.service.js');
  let rejeicao: typeof import('../services/pc-peso-conferido.service.js');

  const escolha = (over: Record<string, unknown> = {}) =>
    ({
      indice: 0,
      sequencias: [1],
      origem: 'sugestao',
      candidato: {
        nCodPed: PED, nCodItem: ITEM, pcNumero: '305', produtoDescricao: 'PS CRISTAL B', qtdPedidaKg: 20000, saldoKg: 20000, precoUnit: 11.3,
        precoNfKgComparado: 11.4, dtPrevisao: null, etapa: '15', dentroTolerancia: true, casaNumeroPedidoNf: true, semDadosLocais: false,
        motivo: 'Quantidade e preço compatíveis', outroCadastro: false, cnpjCadastro: '', dadosEmCache: false, unidade: 'KG',
      },
      dentroTolerancia: true,
      justificativa: null,
      nCodPedOmieAnterior: null,
      nCodItemPedOmieAnterior: null,
      nCodItemOmieVisto: null,
      vinculosDivergentes: false,
      vinculosPorSequencia: {},
      oferecidos: [],
      qtdNfKg: 13382,
      qtdConferidaKg: 13500,
      precoNfKg: 11.4,
      kgPorSequencia: { 1: 13382 },
      itemDescricao: 'PS AI A',
      unidadeNf: 'KG',
      fatorUnidadeNf: 1,
      ...over,
    }) as never;

  async function novoLedger(nf: string): Promise<string> {
    const r = await pool.query(
      `INSERT INTO stockbridge.recebimento_fiscal (nf_chave_acesso, nota_fiscal, status, confirmado_por) VALUES ($1, 'T0059', 'em_andamento', $2) RETURNING id`,
      [nf, usuario],
    );
    const id = String(r.rows[0]!.id);
    ledgers.push(id);
    return id;
  }

  beforeAll(async () => {
    const core = await import('@atlas/core');
    pool = core.getPool() as unknown as Pool;
    const col = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'stockbridge' AND table_name = 'recebimento_fiscal_pc' AND column_name = 'kg_recebido_pc'`,
    );
    if (col.rows.length === 0) {
      console.warn('[pc-peso-conferido-db] testes pulados: schema stockbridge sem a migration 0059');
      return;
    }
    const u = await pool.query(`SELECT id FROM atlas.users WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`);
    if (u.rows[0]) {
      usuario = String(u.rows[0].id);
    } else {
      // banco descartavel sem usuario: cria um so para o teste (removido no fim)
      const novo = await pool.query(`INSERT INTO atlas.users (name, email, password_hash, role) VALUES ('teste 0059', $1, 'x', 'gestor') RETURNING id`, [
        `teste-0059-${BASE}@t.local`,
      ]);
      usuario = String(novo.rows[0]!.id);
      criouUsuario = true;
    }
    svc = await import('../services/pc-sugestao.service.js');
    rejeicao = await import('../services/pc-peso-conferido.service.js');
    // PC 305 com 20.000 kg, nada recebido
    h.consultarPedidoCompra.mockResolvedValue({
      nCodPed: PED, cNumero: '305', cEtapa: '15', nCodFor: FORNECEDOR,
      produtos: [
        { nCodItem: ITEM, cUnidade: 'KG', nQtde: 20000, nQtdeRec: 0, nValUnit: 11.3 },
        { nCodItem: ITEM2, cUnidade: 'KG', nQtde: 20000, nQtdeRec: 0, nValUnit: 11.3 },
      ],
    });
    h.aviso.mockResolvedValue('enviado');
    pronto = true;
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    const apagar = async (sql: string, params: unknown[]) => {
      try {
        await pool.query(sql, params);
      } catch {
        /* limpeza em melhor esforco */
      }
    };
    await apagar(`DELETE FROM stockbridge.recebimento_fiscal_pc WHERE nf_chave_acesso = ANY($1::text[])`, [[NF_A, NF_B, NF_C, NF_D]]);
    await apagar(`DELETE FROM stockbridge.recebimento_fiscal WHERE id = ANY($1::uuid[])`, [ledgers]);
    await apagar(`DELETE FROM stockbridge.aprovacao WHERE id = ANY($1::uuid[])`, [aprovacoes]);
    await apagar(`DELETE FROM stockbridge.movimentacao WHERE id = ANY($1::uuid[])`, [movs]);
    await apagar(`DELETE FROM stockbridge.nf_aviso_compras WHERE nf_chave_acesso = ANY($1::text[])`, [[NF_A, NF_B, NF_C, NF_D]]);
    if (criouUsuario) await apagar(`DELETE FROM atlas.users WHERE id = $1`, [usuario]);
    const core = await import('@atlas/core');
    await core.closePool();
  });

  it('a reserva grava qtd_nf_kg (13.382) e kg_recebido_pc (13.500), e a auditoria registra a coluna nova', async (ctx) => {
    if (!pronto) return ctx.skip();
    const ledger = await novoLedger(NF_A);
    const r = await svc.relerEReservarPcs({
      empresa: 'q2p', ledgerId: ledger, nfChaveAcesso: NF_A, notaFiscal: '67988', fornecedorCodigo: FORNECEDOR, userId: usuario,
      escolhas: [escolha()],
    });
    expect(r[0]).toMatchObject({ nQtdeRecebida: 13500, kgRecebidoPc: 13500 });
    const linha = await pool.query(
      `SELECT id, qtd_nf_kg::text AS qtd, kg_recebido_pc::text AS kg, status FROM stockbridge.recebimento_fiscal_pc WHERE nf_chave_acesso = $1`,
      [NF_A],
    );
    expect(linha.rows).toEqual([expect.objectContaining({ qtd: '13382.000', kg: '13500.000', status: 'confirmado' })]);
    const audit = await pool.query(
      `SELECT new_values->>'kg_recebido_pc' AS kg FROM shared.audit_log
        WHERE schema_name = 'stockbridge' AND table_name = 'recebimento_fiscal_pc' AND record_id = $1 AND operation = 'INSERT'`,
      [String(linha.rows[0]!.id)],
    );
    expect(Number(audit.rows[0]!.kg)).toBe(13500);
  });

  it('a 2a NF no mesmo item de PC ve a reserva da 1a pelo PESO CONFERIDO: sobram 6.500 kg (nao 6.618), e o excedente dela para ai', async (ctx) => {
    if (!pronto) return ctx.skip();
    const ledger = await novoLedger(NF_B);
    const r = await svc.relerEReservarPcs({
      empresa: 'q2p', ledgerId: ledger, nfChaveAcesso: NF_B, notaFiscal: '67990', fornecedorCodigo: FORNECEDOR, userId: usuario,
      escolhas: [escolha({ qtdNfKg: 6000, qtdConferidaKg: 6600, kgPorSequencia: { 1: 6000 } })],
    });
    // 20.000 - 13.500 (reserva da NF A pelo peso conferido) = 6.500 de folga; a NF B pede 6.000 + 600
    expect(r[0]).toMatchObject({ nQtdeRecebida: 6500, kgRecebidoPc: 6500 });
  });

  it('CHECK da 0059: kg_recebido_pc nao aceita zero', async (ctx) => {
    if (!pronto) return ctx.skip();
    await expect(
      pool.query(`UPDATE stockbridge.recebimento_fiscal_pc SET kg_recebido_pc = 0 WHERE nf_chave_acesso = $1`, [NF_A]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'recebimento_fiscal_pc_kg_recebido_check' });
  });

  it('rejeicao da entrada: a consulta acha a sequencia do item com o vinculo concluido acima da NF e chama o aviso', async (ctx) => {
    if (!pronto) return ctx.skip();
    await pool.query(`UPDATE stockbridge.recebimento_fiscal_pc SET status = 'concluido', concluido_em = now() WHERE nf_chave_acesso = $1`, [NF_A]);
    const m = await pool.query(
      `INSERT INTO stockbridge.movimentacao (nota_fiscal, tipo_movimento, subtipo, quantidade_kg, empresa, galpao, produto_codigo_q2p, status_omie, ativo,
          nf_chave_acesso, nf_item_descricao, nf_item_descricao_normalizada, nf_item_sequencias, quantidade_nf_kg)
       VALUES ('67988', 'entrada_manual', 'compra_nacional', 13500, 'q2p', '11.2', $1, 'concluida', false, $2, 'PS AI A', 'PS AI A', ARRAY[1], 13382)
       RETURNING id`,
      [BASE + 9, NF_A],
    );
    const movId = String(m.rows[0]!.id);
    movs.push(movId);
    expect(await rejeicao.avisarComprasSeRejeitouExcedente({ aprovacaoId: '00000000-0000-4000-8000-000000000000', movimentacaoId: movId, motivo: 'teste 0059', usuarioId: usuario })).toBe('enviado');
    expect(h.aviso).toHaveBeenCalledWith(
      expect.objectContaining({
        empresa: 'q2p', nfChaveAcesso: NF_A, notaFiscal: '67988', motivoRejeicao: 'teste 0059',
        linhas: [{ nSequencia: 1, pcNumero: '305', qtdNfKg: 13382, kgRecebidoPc: 13500 }],
      }),
    );
  });

  it('movimentacao de outra sequencia (ou sem excedente) nao gera aviso', async (ctx) => {
    if (!pronto) return ctx.skip();
    h.aviso.mockClear();
    const m = await pool.query(
      `INSERT INTO stockbridge.movimentacao (nota_fiscal, tipo_movimento, subtipo, quantidade_kg, empresa, galpao, produto_codigo_q2p, status_omie, ativo,
          nf_chave_acesso, nf_item_descricao, nf_item_descricao_normalizada, nf_item_sequencias, quantidade_nf_kg)
       VALUES ('67988', 'entrada_manual', 'compra_nacional', 1000, 'q2p', '11.2', $1, 'concluida', false, $2, 'OUTRO ITEM', 'OUTRO ITEM', ARRAY[2], 1000)
       RETURNING id`,
      [BASE + 9, NF_A],
    );
    movs.push(String(m.rows[0]!.id));
    expect(await rejeicao.avisarComprasSeRejeitouExcedente({ aprovacaoId: '00000000-0000-4000-8000-000000000000', movimentacaoId: String(m.rows[0]!.id), motivo: 'x', usuarioId: usuario })).toBe('sem_excedente');
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("aviso a compras: a 0059 aceita o motivo 'excedente_rejeitado' e segue recusando motivo desconhecido", async (ctx) => {
    if (!pronto) return ctx.skip();
    await pool.query(
      `INSERT INTO stockbridge.nf_aviso_compras (empresa, nf_chave_acesso, nota_fiscal, motivo, itens, enviado_para, disparado_por)
       VALUES ('q2p', $1, '67988', 'excedente_rejeitado', '[]'::jsonb, 'compras@teste.local', $2)`,
      [NF_A, usuario],
    );
    await expect(
      pool.query(
        `INSERT INTO stockbridge.nf_aviso_compras (empresa, nf_chave_acesso, nota_fiscal, motivo, itens, enviado_para) VALUES ('q2p', $1, '67988', 'outro', '[]'::jsonb, 'x')`,
        [NF_A],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('retomada com SQL real: tentativa anterior mandou 13.500 e falhou; com a chave desligada a nova manda a da NF (13.382) de volta', async (ctx) => {
    if (!pronto) return ctx.skip();
    const l1 = await novoLedger(NF_C);
    const e = escolha({ candidato: { ...(escolha() as unknown as { candidato: Record<string, unknown> }).candidato, nCodItem: ITEM2 } });
    const r1 = await svc.relerEReservarPcs({ empresa: 'q2p', ledgerId: l1, nfChaveAcesso: NF_C, notaFiscal: '67991', fornecedorCodigo: FORNECEDOR, userId: usuario, escolhas: [e] });
    expect(r1[0]).toMatchObject({ nQtdeRecebida: 13500 });
    // a tentativa morre depois do EDITAR: ledger e reservas em falha
    await pool.query(`UPDATE stockbridge.recebimento_fiscal SET status = 'falha', finalizado_em = now() WHERE id = $1`, [l1]);
    await pool.query(`UPDATE stockbridge.recebimento_fiscal_pc SET status = 'falha' WHERE nf_chave_acesso = $1`, [NF_C]);
    h.config.STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO = false;
    try {
      const l2 = await novoLedger(NF_C);
      const r2 = await svc.relerEReservarPcs({ empresa: 'q2p', ledgerId: l2, nfChaveAcesso: NF_C, notaFiscal: '67991', fornecedorCodigo: FORNECEDOR, userId: usuario, escolhas: [e] });
      expect(r2[0]).toMatchObject({ nQtdeRecebida: 13382, kgRecebidoPc: 13382 });
      const viva = await pool.query(
        `SELECT kg_recebido_pc::text AS kg FROM stockbridge.recebimento_fiscal_pc WHERE nf_chave_acesso = $1 AND status = 'confirmado'`,
        [NF_C],
      );
      expect(viva.rows).toEqual([{ kg: '13382.000' }]);
    } finally {
      h.config.STOCKBRIDGE_PC_BAIXA_PESO_CONFERIDO = true;
    }
  });

  it('deduplicacao por item com jsonb real: o aviso da sequencia 1 cobre a 1 e nao a 2', async (ctx) => {
    if (!pronto) return ctx.skip();
    const r = await pool.query(
      `SELECT bool_or(itens @> $2::jsonb) AS cobre_1, bool_or(itens @> $3::jsonb) AS cobre_2
         FROM stockbridge.nf_aviso_compras WHERE nf_chave_acesso = $1 AND motivo = 'excedente_rejeitado'`,
      [NF_A, JSON.stringify([{ nSequencia: 1 }]), JSON.stringify([{ nSequencia: 2 }])],
    );
    // a linha do teste do CHECK tem itens '[]': nao cobre nada; grava uma com a sequencia 1
    expect(r.rows[0]).toMatchObject({ cobre_1: false, cobre_2: false });
    await pool.query(
      `INSERT INTO stockbridge.nf_aviso_compras (empresa, nf_chave_acesso, nota_fiscal, motivo, itens, enviado_para)
       VALUES ('q2p', $1, '67988', 'excedente_rejeitado', $2::jsonb, 'compras@teste.local')`,
      [NF_A, JSON.stringify([{ nSequencia: 1, descricao: 'PS AI A', qtdKg: 13500, precoUnit: null, pcNumero: '305', qtdNfKg: 13382 }])],
    );
    const r2 = await pool.query(
      `SELECT bool_or(itens @> $2::jsonb) AS cobre_1, bool_or(itens @> $3::jsonb) AS cobre_2
         FROM stockbridge.nf_aviso_compras WHERE nf_chave_acesso = $1 AND motivo = 'excedente_rejeitado'`,
      [NF_A, JSON.stringify([{ nSequencia: 1 }]), JSON.stringify([{ nSequencia: 2 }])],
    );
    expect(r2.rows[0]).toMatchObject({ cobre_1: true, cobre_2: false });
  });

  it('varredura com SQL real: rejeicao recente sem aviso e achada; com o aviso da sequencia gravado, nao mais', async (ctx) => {
    if (!pronto) return ctx.skip();
    // NF_B: vinculo concluido acima da NF (6.500 x 6.000), movimentacao rejeitada e nenhum aviso ainda
    await pool.query(`UPDATE stockbridge.recebimento_fiscal_pc SET status = 'concluido', concluido_em = now() WHERE nf_chave_acesso = $1`, [NF_B]);
    const m = await pool.query(
      `INSERT INTO stockbridge.movimentacao (nota_fiscal, tipo_movimento, subtipo, quantidade_kg, empresa, galpao, produto_codigo_q2p, status_omie, ativo,
          nf_chave_acesso, nf_item_descricao, nf_item_descricao_normalizada, nf_item_sequencias, quantidade_nf_kg)
       VALUES ('67990', 'entrada_manual', 'compra_nacional', 6600, 'q2p', '11.2', $1, 'concluida', false, $2, 'PS AI A', 'PS AI A', ARRAY[1], 6000)
       RETURNING id`,
      [BASE + 9, NF_B],
    );
    const movId = String(m.rows[0]!.id);
    movs.push(movId);
    const a = await pool.query(
      `INSERT INTO stockbridge.aprovacao (precisa_nivel, tipo_aprovacao, lancado_por, status, movimentacao_id, produto_codigo_q2p, galpao, empresa,
          aprovado_por, aprovado_em, rejeicao_motivo)
       VALUES ('gestor', 'entrada_manual', $1, 'rejeitada', $2, $3, '11.2', 'q2p', $1, now(), 'teste 0059 varredura') RETURNING id`,
      [usuario, movId, BASE + 9],
    );
    aprovacoes.push(String(a.rows[0]!.id));
    h.aviso.mockClear();
    expect(await rejeicao.varrerExcedentesRejeitadosSemAviso()).toBeGreaterThanOrEqual(1);
    expect(h.aviso).toHaveBeenCalledWith(
      expect.objectContaining({ nfChaveAcesso: NF_B, motivoRejeicao: 'teste 0059 varredura', linhas: [{ nSequencia: 1, pcNumero: '305', qtdNfKg: 6000, kgRecebidoPc: 6500 }] }),
    );
    // o aviso da sequencia 1 da NF_B gravado (o dublê nao grava): a varredura nao a acha mais
    await pool.query(
      `INSERT INTO stockbridge.nf_aviso_compras (empresa, nf_chave_acesso, nota_fiscal, motivo, itens, enviado_para)
       VALUES ('q2p', $1, '67990', 'excedente_rejeitado', $2::jsonb, 'compras@teste.local')`,
      [NF_B, JSON.stringify([{ nSequencia: 1 }])],
    );
    h.aviso.mockClear();
    await rejeicao.varrerExcedentesRejeitadosSemAviso();
    expect(h.aviso.mock.calls.some((c) => (c[0] as { nfChaveAcesso: string }).nfChaveAcesso === NF_B)).toBe(false);
  });

  it('varredura com SQL real: aviso de rejeicao ANTIGA do mesmo item nao cobre a nova; entrega parcial volta para quem faltou', async (ctx) => {
    if (!pronto) return ctx.skip();
    // a rejeicao da NF_B foi agora; o aviso que existe passa a ter sido enviado 3 dias antes dela
    await pool.query(
      `UPDATE stockbridge.nf_aviso_compras SET enviado_em = now() - interval '3 days' WHERE nf_chave_acesso = $1 AND motivo = 'excedente_rejeitado'`,
      [NF_B],
    );
    h.aviso.mockClear();
    await rejeicao.varrerExcedentesRejeitadosSemAviso();
    expect(h.aviso.mock.calls.some((c) => (c[0] as { nfChaveAcesso: string }).nfChaveAcesso === NF_B)).toBe(true);

    // aviso recente, mas so para um dos dois destinatarios atuais: a varredura ainda acha a rejeicao
    h.config.STOCKBRIDGE_COMPRAS_EMAILS = ['compras@teste.local', 'comprador2@teste.local'];
    try {
      await pool.query(
        `INSERT INTO stockbridge.nf_aviso_compras (empresa, nf_chave_acesso, nota_fiscal, motivo, itens, enviado_para)
         VALUES ('q2p', $1, '67990', 'excedente_rejeitado', $2::jsonb, 'Compras@Teste.local')`,
        [NF_B, JSON.stringify([{ nSequencia: 1 }])],
      );
      h.aviso.mockClear();
      await rejeicao.varrerExcedentesRejeitadosSemAviso();
      expect(h.aviso.mock.calls.some((c) => (c[0] as { nfChaveAcesso: string }).nfChaveAcesso === NF_B)).toBe(true);

      // com os dois cobertos (o segundo entregue numa linha propria), nao mais
      await pool.query(
        `INSERT INTO stockbridge.nf_aviso_compras (empresa, nf_chave_acesso, nota_fiscal, motivo, itens, enviado_para)
         VALUES ('q2p', $1, '67990', 'excedente_rejeitado', $2::jsonb, ' comprador2@teste.local')`,
        [NF_B, JSON.stringify([{ nSequencia: 1 }])],
      );
      h.aviso.mockClear();
      await rejeicao.varrerExcedentesRejeitadosSemAviso();
      expect(h.aviso.mock.calls.some((c) => (c[0] as { nfChaveAcesso: string }).nfChaveAcesso === NF_B)).toBe(false);
    } finally {
      h.config.STOCKBRIDGE_COMPRAS_EMAILS = ['compras@teste.local'];
    }
  });

  it('varredura + envio reais (2a revisao, achado 4): rejeicao de 30 h atras ja avisada a compras@ e destinatario novo — so o novo recebe', async (ctx) => {
    if (!pronto) return ctx.skip();
    // NF_D no 2o item do PC (NF_C reservou 13.382 dele): 6.000 kg da NF, 6.100 conferidos, baixado 6.100
    const ledger = await novoLedger(NF_D);
    const e = escolha({
      candidato: { ...(escolha() as unknown as { candidato: Record<string, unknown> }).candidato, nCodItem: ITEM2 },
      qtdNfKg: 6000, qtdConferidaKg: 6100, kgPorSequencia: { 1: 6000 },
    });
    const r = await svc.relerEReservarPcs({ empresa: 'q2p', ledgerId: ledger, nfChaveAcesso: NF_D, notaFiscal: '67992', fornecedorCodigo: FORNECEDOR, userId: usuario, escolhas: [e] });
    expect(r[0]).toMatchObject({ kgRecebidoPc: 6100 });
    await pool.query(`UPDATE stockbridge.recebimento_fiscal_pc SET status = 'concluido', concluido_em = now() - interval '31 hours' WHERE nf_chave_acesso = $1`, [NF_D]);
    const m = await pool.query(
      `INSERT INTO stockbridge.movimentacao (nota_fiscal, tipo_movimento, subtipo, quantidade_kg, empresa, galpao, produto_codigo_q2p, status_omie, ativo,
          nf_chave_acesso, nf_item_descricao, nf_item_descricao_normalizada, nf_item_sequencias, quantidade_nf_kg)
       VALUES ('67992', 'entrada_manual', 'compra_nacional', 6100, 'q2p', '11.2', $1, 'concluida', false, $2, 'PS AI A', 'PS AI A', ARRAY[1], 6000)
       RETURNING id`,
      [BASE + 9, NF_D],
    );
    movs.push(String(m.rows[0]!.id));
    const a = await pool.query(
      `INSERT INTO stockbridge.aprovacao (precisa_nivel, tipo_aprovacao, lancado_por, status, movimentacao_id, produto_codigo_q2p, galpao, empresa,
          aprovado_por, aprovado_em, rejeicao_motivo)
       VALUES ('gestor', 'entrada_manual', $1, 'rejeitada', $2, $3, '11.2', 'q2p', $1, now() - interval '30 hours', 'teste 0059 janela') RETURNING id`,
      [usuario, String(m.rows[0]!.id), BASE + 9],
    );
    aprovacoes.push(String(a.rows[0]!.id));
    // compras@ foi avisado 1 h depois da rejeicao (29 h atras): fora das "ultimas 24 h", dentro da janela da rejeicao
    await pool.query(
      `INSERT INTO stockbridge.nf_aviso_compras (empresa, nf_chave_acesso, nota_fiscal, motivo, itens, enviado_para, enviado_em)
       VALUES ('q2p', $1, '67992', 'excedente_rejeitado', $2::jsonb, 'compras@teste.local', now() - interval '29 hours')`,
      [NF_D, JSON.stringify([{ nSequencia: 1 }])],
    );
    const real = await vi.importActual<typeof import('../services/notificacao.service.js')>('../services/notificacao.service.js');
    h.aviso.mockImplementation((args: unknown) => real.enviarAvisoComprasExcedenteRejeitado(args as never));
    h.sendEmail.mockReset();
    h.sendEmail.mockResolvedValue(undefined);
    h.config.STOCKBRIDGE_COMPRAS_EMAILS = ['compras@teste.local', 'novo@teste.local'];
    const paraNfD = () =>
      h.sendEmail.mock.calls.map((c) => c[0] as { to: string; subject: string }).filter((x) => x.subject.includes('NF 67992')).map((x) => x.to);
    try {
      await rejeicao.varrerExcedentesRejeitadosSemAviso();
      expect(paraNfD()).toEqual(['novo@teste.local']); // antes da correcao: compras@ recebia de novo
      const gravados = await pool.query(
        `SELECT enviado_para FROM stockbridge.nf_aviso_compras WHERE nf_chave_acesso = $1 AND motivo = 'excedente_rejeitado' ORDER BY enviado_em`,
        [NF_D],
      );
      expect(gravados.rows.map((x) => x.enviado_para)).toEqual(['compras@teste.local', 'novo@teste.local']);
      // a rodada seguinte nao acha mais nada desta rejeicao
      h.sendEmail.mockClear();
      await rejeicao.varrerExcedentesRejeitadosSemAviso();
      expect(paraNfD()).toEqual([]);
    } finally {
      h.config.STOCKBRIDGE_COMPRAS_EMAILS = ['compras@teste.local'];
      h.aviso.mockReset();
      h.aviso.mockResolvedValue('enviado');
    }
  });

  it('o aviso usa o fornecedor gravado no ledger do fiscal quando a NF ainda nao esta no espelho de NF', async (ctx) => {
    if (!pronto) return ctx.skip();
    await pool.query(`UPDATE stockbridge.recebimento_fiscal SET fornecedor_nome = 'ISOFORMA PLASTICOS (ledger)' WHERE id = ANY($1::uuid[])`, [ledgers]);
    h.aviso.mockClear();
    await rejeicao.avisarComprasSeRejeitouExcedente({ aprovacaoId: '00000000-0000-4000-8000-000000000000', movimentacaoId: movs[0]!, motivo: 'x', usuarioId: usuario });
    expect(h.aviso).toHaveBeenCalledWith(expect.objectContaining({ nfChaveAcesso: NF_A, fornecedorNome: 'ISOFORMA PLASTICOS (ledger)' }));
  });
});
