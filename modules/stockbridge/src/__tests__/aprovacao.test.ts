import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dbMod from '@atlas/db';
import {
  aprovar,
  rejeitar,
  resubmeter,
  AprovacaoNaoEncontradaError,
  AprovacaoNivelInsuficienteError,
  AprovacaoStatusInvalidoError,
  ResubmissaoDuplicadaError,
  inferirNivelAprovacao,
} from '../services/aprovacao.service.js';

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  buildEmailLayout: (o: { titulo?: string }) => ({ html: String(o?.titulo ?? ''), text: String(o?.titulo ?? '') }),
  emailDataList: () => '',
  emailActionBox: (html: string) => html,
  escapeHtml: (v: unknown) => (v == null ? '' : String(v)),
  getPool: () => ({ query: vi.fn() }),
}));

vi.mock('@atlas/db', () => ({
  aprovacao: { id: {}, status: {}, loteId: {}, precisaNivel: {}, tipoAprovacao: {}, quantidadePrevistaKg: {}, quantidadeRecebidaKg: {}, tipoDivergencia: {}, observacoes: {}, lancadoPor: {}, lancadoEm: {} },
  lote: { id: {}, status: {}, quantidadeFisicaKg: {}, produtoCodigoAcxe: {}, produtoCodigoQ2p: {}, localidadeId: {}, notaFiscal: {}, custoBrlKg: {}, updatedAt: {} },
  movimentacao: { id: {}, movimentacaoOrigemId: {}, tipoMovimento: {}, ativo: {} },
  localidadeCorrelacao: { localidadeId: {}, codigoLocalEstoqueAcxe: {}, codigoLocalEstoqueQ2p: {} },
  users: { id: {}, email: {} },
  reservaSaldo: { movimentacaoId: {}, status: {}, resolvidoEm: {} },
}));

vi.mock('@atlas/integration-omie', () => ({
  incluirAjusteEstoque: vi.fn().mockResolvedValue({
    idMovest: 'MOCK-MOVEST',
    idAjuste: 'MOCK-AJUSTE',
    descricaoStatus: 'ok',
  }),
  consultarNF: vi.fn(),
  isMockMode: () => true,
}));

// STK-06: aprovarSaidaManual/retorno_comodato — as funcoes OMIE de saida sao
// mockadas pra controlar o resultado dual (sucesso vs pendenciaQ2p) sem
// depender das correlacoes reais (db.execute).
vi.mock('../services/omie-saida.service.js', () => ({
  executarSaidaOmieDual: vi.fn(),
  executarTransferenciaIntraDual: vi.fn(),
  executarComodatoOmieDual: vi.fn(),
  executarRetornoComodatoOmieDual: vi.fn(),
  resolverCodigoProdutoOmie: vi.fn(),
}));

/**
 * Mock generico que responde diferentes selects baseando-se no objeto "from".
 * Constroi um chain select().from(X).where().limit() que retorna a lista mapeada
 * por referencia de tabela. `transaction` reaproveita o mesmo chain.
 *
 * Pos STK-01/07 o service usa dois padroes que o mock precisa distinguir:
 *  - claim atomico: update(aprovacao).set().where(status='pendente').returning()
 *    — devolve a linha da tabela (vencedor) ou, com opts.claimFalha, [] (perdedor
 *    da corrida, pra testar o ramo de erro).
 *  - guard de resubmissao: select COM projecao em aprovacao — devolve
 *    opts.pendentesDoLote (default [], lote livre). Selects com projecao em
 *    outras tabelas (ex: email de users) seguem a tabela normal.
 */
function criarDbComTabelas(
  rows: Map<object, unknown[]>,
  opts: { claimFalha?: boolean; pendentesDoLote?: unknown[] } = {},
) {
  let currentRows: unknown[] = [];
  let guardResubmissao = false;
  let temProjecao = false;
  let modo: 'select' | 'update' | 'insert' = 'select';
  let updateTable: object | null = null;
  const chain = {
    select: vi.fn((projecao?: object) => {
      modo = 'select';
      temProjecao = projecao !== undefined;
      return chain;
    }),
    from: vi.fn((table: object) => {
      currentRows = rows.get(table) ?? [];
      guardResubmissao = temProjecao && table === dbMod.aprovacao;
      return chain;
    }),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(() =>
      Promise.resolve(guardResubmissao ? opts.pendentesDoLote ?? [] : currentRows),
    ),
    update: vi.fn((table: object) => {
      modo = 'update';
      updateTable = table;
      return chain;
    }),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn(() => {
      modo = 'insert';
      return chain;
    }),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(() => {
      if (modo === 'insert') return Promise.resolve([{ id: 'nova-id' }]);
      if (updateTable === dbMod.aprovacao && opts.claimFalha) return Promise.resolve([]);
      const tabelaRows = updateTable ? rows.get(updateTable) ?? [] : [];
      return Promise.resolve(tabelaRows.length > 0 ? tabelaRows : [{ id: 'nova-id' }]);
    }),
    // consultarValorUnitarioProduto (media ponderada) — retorna vu fixo 2.5
    execute: vi.fn(() => Promise.resolve({ rows: [{ vu: '2.5' }] })),
  };
  return {
    ...chain,
    transaction: async (fn: (tx: typeof chain) => Promise<unknown>) => fn(chain),
  };
}

// Helpers para montar o Map de tabelas esperadas
async function tabelas(aprovacaoRow: Record<string, unknown> | null, loteRow?: Record<string, unknown> | null) {
  const mod = await import('@atlas/db');
  const m = new Map<object, unknown[]>();
  m.set(mod.aprovacao, aprovacaoRow ? [aprovacaoRow] : []);
  m.set(mod.lote, loteRow ? [loteRow] : []);
  m.set(mod.localidadeCorrelacao, [
    { localidadeId: 'loc-1', codigoLocalEstoqueAcxe: 111, codigoLocalEstoqueQ2p: 222 },
  ]);
  m.set(mod.users, [{ email: 'operador@test.local' }]);
  return m;
}

describe('aprovacao.service#aprovar', () => {
  beforeEach(() => vi.clearAllMocks());

  it('aprova pendencia de entrada_manual e promove lote a provisorio (sem OMIE)', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(
      criarDbComTabelas(await tabelas({
        id: 'apr-1', loteId: 'lote-1', status: 'pendente',
        precisaNivel: 'gestor', tipoAprovacao: 'entrada_manual', lancadoPor: 'op-1',
      })) as never,
    );
    const res = await aprovar({ id: 'apr-1', usuarioId: 'u1', perfilUsuario: 'gestor' });
    expect(res).toEqual({ id: 'apr-1', loteStatus: 'provisorio' });
  });

  it('lanca AprovacaoNaoEncontradaError quando id nao existe', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(criarDbComTabelas(await tabelas(null)) as never);
    await expect(aprovar({ id: 'naoexiste', usuarioId: 'u1', perfilUsuario: 'gestor' })).rejects.toThrow(AprovacaoNaoEncontradaError);
  });

  it('lanca AprovacaoStatusInvalidoError quando ja aprovada', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(
      criarDbComTabelas(await tabelas({
        id: 'apr-1', loteId: 'lote-1', status: 'aprovada',
        precisaNivel: 'gestor', tipoAprovacao: 'entrada_manual', lancadoPor: 'op-1',
      })) as never,
    );
    await expect(aprovar({ id: 'apr-1', usuarioId: 'u1', perfilUsuario: 'gestor' })).rejects.toThrow(AprovacaoStatusInvalidoError);
  });

  it('gestor nao pode aprovar pendencia nivel diretor (comodato)', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(
      criarDbComTabelas(await tabelas({
        id: 'apr-1', loteId: 'lote-1', status: 'pendente',
        precisaNivel: 'diretor', tipoAprovacao: 'saida_comodato', lancadoPor: 'op-1',
      })) as never,
    );
    await expect(aprovar({ id: 'apr-1', usuarioId: 'u1', perfilUsuario: 'gestor' })).rejects.toThrow(AprovacaoNivelInsuficienteError);
  });

  it('diretor pode aprovar pendencia nivel gestor', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(
      criarDbComTabelas(await tabelas({
        id: 'apr-1', loteId: 'lote-1', status: 'pendente',
        precisaNivel: 'gestor', tipoAprovacao: 'entrada_manual', lancadoPor: 'op-1',
      })) as never,
    );
    const res = await aprovar({ id: 'apr-1', usuarioId: 'u1', perfilUsuario: 'diretor' });
    expect(res.id).toBe('apr-1');
  });

  it('aprovar recebimento_divergencia chama OMIE ACXE+Q2P e grava movimentacao', async () => {
    const { getDb } = await import('@atlas/core');
    const omieMod = await import('@atlas/integration-omie');
    const aprRow = {
      id: 'apr-1', loteId: 'lote-1', status: 'pendente',
      precisaNivel: 'gestor', tipoAprovacao: 'recebimento_divergencia',
      quantidadeRecebidaKg: '24500', tipoDivergencia: 'faltando', lancadoPor: 'op-1',
    };
    // Lote com dados da NF persistidos no momento do recebimento
    // vNF=31250, qtdNf=25000kg → ACXE = round(31250/25000 * 100)/100 = 1.25
    //                            Q2P  = ceil(31250/25000 * 1.145 * 100)/100 = ceil(143.125)/100 = 1.44
    const loteRow = {
      id: 'lote-1', codigo: 'L001', notaFiscal: '123', cnpj: 'Acxe Matriz',
      produtoCodigoAcxe: 1001, produtoCodigoQ2p: 2001,
      localidadeId: 'loc-1', quantidadeFisicaKg: '24500',
      quantidadeFiscalKg: '25000', custoBrlKg: '1.20',
      valorTotalNfBrl: '31250.00', codigoLocalEstoqueOrigemAcxe: '999',
    };
    const db = criarDbComTabelas(await tabelas(aprRow, loteRow));
    vi.mocked(getDb).mockReturnValue(db as never);

    const res = await aprovar({ id: 'apr-1', usuarioId: 'u1', perfilUsuario: 'gestor' });
    expect(res).toEqual({ id: 'apr-1', loteStatus: 'provisorio' });

    // NF 5376: movimentacao criada via aprovacao deve carregar o produto do lote —
    // sem ele a checagem "recebida por produto" (feature 014) nunca casa e a NF
    // fica presa como "Aguardando recebimento".
    const movValues = db.values.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((v) => v.tipoMovimento === 'entrada_nf');
    expect(movValues).toMatchObject({ produtoCodigoAcxe: 1001, produtoCodigoQ2p: 2001 });
    expect(omieMod.consultarNF).not.toHaveBeenCalled(); // usa lote persistido
    // 3 chamadas: ACXE primaria (recebido), Q2P (recebido), ACXE diferenca (faltando)
    expect(omieMod.incluirAjusteEstoque).toHaveBeenCalledTimes(3);
    expect(omieMod.incluirAjusteEstoque).toHaveBeenNthCalledWith(1, 'acxe', expect.objectContaining({
      quantidade: 24500,
      tipo: 'TRF',
      motivo: 'TRF',
      codigoLocalEstoque: '999',
      codigoLocalEstoqueDestino: '111',
      valor: 1.25, // vNF/qCom = 31250/25000 = 1.25 (com tributos embutidos, NAO o vUnCom=1.20)
    }));
    expect(omieMod.incluirAjusteEstoque).toHaveBeenNthCalledWith(2, 'q2p', expect.objectContaining({
      quantidade: 24500,
      tipo: 'ENT',
      motivo: 'INI',
      valor: 1.44, // ceil(1.25 * 1.145 * 100)/100 = ceil(143.125)/100
    }));
    // 3a chamada: ACXE transferindo diferenca (500kg) para ACXE-COMEX-FALTANDO
    // (tipoDivergencia=faltando → 4506855468)
    expect(omieMod.incluirAjusteEstoque).toHaveBeenNthCalledWith(3, 'acxe', expect.objectContaining({
      quantidade: 500, // 25000 NF - 24500 recebido
      tipo: 'TRF',
      motivo: 'TRF',
      codigoLocalEstoque: '999',
      codigoLocalEstoqueDestino: '4506855468', // ACXE-COMEX-FALTANDO
      valor: 1.25,
    }));

    // Recebimento divergente concluido COM SUCESSO → Comex em copia no email "aprovado"
    const { sendEmail } = await import('@atlas/core');
    const aprovadoCall = vi.mocked(sendEmail).mock.calls.find((c) =>
      (c[0] as { subject: string }).subject.includes('aprovado'),
    );
    expect(aprovadoCall).toBeDefined();
    const cc = (aprovadoCall![0] as { cc?: string | string[] }).cc;
    const ccArr = Array.isArray(cc) ? cc : cc ? [cc] : [];
    expect(ccArr).toContain('comex_acxe@acxe-polimeros.com.br');
  });

  it('aprovar recebimento_divergencia varredura → diferenca vai pra estoque varredura nao-extrema', async () => {
    const { getDb } = await import('@atlas/core');
    const omieMod = await import('@atlas/integration-omie');
    const aprRow = {
      id: 'apr-2', loteId: 'lote-2', status: 'pendente',
      precisaNivel: 'gestor', tipoAprovacao: 'recebimento_divergencia',
      quantidadeRecebidaKg: '24500', tipoDivergencia: 'varredura', lancadoPor: 'op-1',
    };
    const loteRow = {
      id: 'lote-2', codigo: 'L002', notaFiscal: '124', cnpj: 'Acxe Matriz',
      produtoCodigoAcxe: 1001, produtoCodigoQ2p: 2001,
      localidadeId: 'loc-1', quantidadeFisicaKg: '24500',
      quantidadeFiscalKg: '25000', custoBrlKg: '1.20',
      valorTotalNfBrl: '31250.00', codigoLocalEstoqueOrigemAcxe: '999',
    };
    vi.mocked(getDb).mockReturnValue(criarDbComTabelas(await tabelas(aprRow, loteRow)) as never);

    await aprovar({ id: 'apr-2', usuarioId: 'u1', perfilUsuario: 'gestor' });

    // Destino do recebimento (corr.codigoLocalEstoqueAcxe = 111) NAO e Extrema (4004166399),
    // entao a diferenca vai pra ACXE_VARREDURA_NAO_EXTREMA = 4506526722
    expect(omieMod.incluirAjusteEstoque).toHaveBeenNthCalledWith(3, 'acxe', expect.objectContaining({
      quantidade: 500,
      codigoLocalEstoqueDestino: '4506526722',
    }));
  });

  // US4: Q2P falha durante aprovacao → grava pendente_q2p e nao bloqueia aprovacao
  it('Q2P falha durante aprovar(): movimentacao parcial pendente_q2p + aprovacao continua aprovada', async () => {
    const { getDb } = await import('@atlas/core');
    const omieMod = await import('@atlas/integration-omie');

    // 1a chamada ACXE ok, 2a Q2P falha
    vi.mocked(omieMod.incluirAjusteEstoque)
      .mockResolvedValueOnce({ idMovest: 'M-ACXE', idAjuste: 'A-ACXE', descricaoStatus: 'ok' })
      .mockRejectedValueOnce(new Error('OMIE Q2P 503'));

    const aprRow = {
      id: 'apr-q2pfail', loteId: 'lote-q2pfail', status: 'pendente',
      precisaNivel: 'gestor', tipoAprovacao: 'recebimento_divergencia',
      quantidadeRecebidaKg: '24500', tipoDivergencia: 'faltando', lancadoPor: 'op-1',
    };
    const loteRow = {
      id: 'lote-q2pfail', codigo: 'L-Q', notaFiscal: '500', cnpj: 'Acxe Matriz',
      produtoCodigoAcxe: 1001, produtoCodigoQ2p: 2001,
      localidadeId: 'loc-1', quantidadeFisicaKg: '24500',
      quantidadeFiscalKg: '25000', custoBrlKg: '1.20',
      valorTotalNfBrl: '31250.00', codigoLocalEstoqueOrigemAcxe: '999',
    };
    const dbMock = criarDbComTabelas(await tabelas(aprRow, loteRow));
    vi.mocked(getDb).mockReturnValue(dbMock as never);

    const res = await aprovar({ id: 'apr-q2pfail', usuarioId: 'u1', perfilUsuario: 'gestor' });

    // 1) Aprovacao retorna com pendenciaOmie
    expect(res.id).toBe('apr-q2pfail');
    expect(res.loteStatus).toBe('provisorio');
    expect(res.pendenciaOmie).toBeDefined();
    expect(res.pendenciaOmie!.lado).toBe('q2p');
    expect(res.pendenciaOmie!.movimentacaoId).toBe('nova-id');
    // STK-01: opId deterministico = id da aprovacao (nao mais randomUUID)
    expect(res.pendenciaOmie!.opId).toBe('apr-q2pfail');

    // 2) Movimentacao gravada com statusOmie=pendente_q2p
    const valuesCalls = dbMock.values.mock.calls as Array<[Record<string, unknown>]>;
    const movInsert = valuesCalls.find((c) => c[0] && 'idMovestAcxe' in c[0]);
    expect(movInsert).toBeDefined();
    expect(movInsert![0]).toMatchObject({
      idMovestAcxe: 'M-ACXE',
      idAjusteAcxe: 'A-ACXE',
      idMovestQ2p: null,
      idAjusteQ2p: null,
      mvQ2p: null,
      idUserQ2p: null,
      statusOmie: 'pendente_q2p',
      tentativasQ2p: 1,
      tentativasAcxeFaltando: 0,
    });
    expect(movInsert![0].ultimoErroOmie).toMatchObject({
      lado: 'q2p',
      mensagem: expect.stringContaining('OMIE Q2P 503'),
    });

    // 3) Apenas 2 chamadas OMIE (transferirDiferencaAcxe nao roda quando ja ha pendente_q2p)
    expect(omieMod.incluirAjusteEstoque).toHaveBeenCalledTimes(2);

    // 4) Insucesso (pendencia OMIE) → Comex NAO entra em copia no email "aprovado"
    const { sendEmail } = await import('@atlas/core');
    const aprovadoCall = vi.mocked(sendEmail).mock.calls.find((c) =>
      (c[0] as { subject: string }).subject.includes('aprovado'),
    );
    expect(aprovadoCall).toBeDefined();
    const cc = (aprovadoCall![0] as { cc?: string | string[] }).cc;
    const ccArr = Array.isArray(cc) ? cc : cc ? [cc] : [];
    expect(ccArr).not.toContain('comex_acxe@acxe-polimeros.com.br');
  });

  // US4: transferirDiferencaAcxe falha → pendente_acxe_faltando
  it('transferirDiferencaAcxe falha: movimentacao com pendente_acxe_faltando, dual call salvo', async () => {
    const { getDb } = await import('@atlas/core');
    const omieMod = await import('@atlas/integration-omie');

    // ACXE primary ok, Q2P ok, ACXE diferenca falha
    vi.mocked(omieMod.incluirAjusteEstoque)
      .mockResolvedValueOnce({ idMovest: 'M-ACXE', idAjuste: 'A-ACXE', descricaoStatus: 'ok' })
      .mockResolvedValueOnce({ idMovest: 'M-Q2P', idAjuste: 'A-Q2P', descricaoStatus: 'ok' })
      .mockRejectedValueOnce(new Error('OMIE ACXE timeout na transferencia diferenca'));

    const aprRow = {
      id: 'apr-difffail', loteId: 'lote-diff', status: 'pendente',
      precisaNivel: 'gestor', tipoAprovacao: 'recebimento_divergencia',
      quantidadeRecebidaKg: '24500', tipoDivergencia: 'faltando', lancadoPor: 'op-1',
    };
    const loteRow = {
      id: 'lote-diff', codigo: 'L-D', notaFiscal: '501', cnpj: 'Acxe Matriz',
      produtoCodigoAcxe: 1001, produtoCodigoQ2p: 2001,
      localidadeId: 'loc-1', quantidadeFisicaKg: '24500',
      quantidadeFiscalKg: '25000', custoBrlKg: '1.20',
      valorTotalNfBrl: '31250.00', codigoLocalEstoqueOrigemAcxe: '999',
    };
    const dbMock = criarDbComTabelas(await tabelas(aprRow, loteRow));
    vi.mocked(getDb).mockReturnValue(dbMock as never);

    const res = await aprovar({ id: 'apr-difffail', usuarioId: 'u1', perfilUsuario: 'gestor' });

    expect(res.pendenciaOmie).toBeDefined();
    expect(res.pendenciaOmie!.lado).toBe('acxe-faltando');

    const valuesCalls = dbMock.values.mock.calls as Array<[Record<string, unknown>]>;
    const movInsert = valuesCalls.find((c) => c[0] && 'idMovestAcxe' in c[0]);
    expect(movInsert).toBeDefined();
    expect(movInsert![0]).toMatchObject({
      // Dual call sucedeu — ambos lados gravados
      idMovestAcxe: 'M-ACXE',
      idMovestQ2p: 'M-Q2P',
      mvAcxe: 1,
      mvQ2p: 1,
      // ... mas a transferencia da diferenca falhou
      statusOmie: 'pendente_acxe_faltando',
      tentativasQ2p: 0,
      tentativasAcxeFaltando: 1,
    });
    expect(movInsert![0].ultimoErroOmie).toMatchObject({
      lado: 'acxe-faltando',
      mensagem: expect.stringContaining('timeout'),
    });

    // 3 chamadas OMIE (todas tentadas)
    expect(omieMod.incluirAjusteEstoque).toHaveBeenCalledTimes(3);
  });

  // US1: idempotencia OMIE — opId compartilhado em todas as chamadas + persistido na movimentacao
  it('aprovar divergencia: codIntAjuste compartilha opId e movimentacao grava com statusOmie=concluida', async () => {
    const { getDb } = await import('@atlas/core');
    const omieMod = await import('@atlas/integration-omie');
    const aprRow = {
      id: 'apr-3', loteId: 'lote-3', status: 'pendente',
      precisaNivel: 'gestor', tipoAprovacao: 'recebimento_divergencia',
      quantidadeRecebidaKg: '24500', tipoDivergencia: 'faltando', lancadoPor: 'op-1',
    };
    const loteRow = {
      id: 'lote-3', codigo: 'L003', notaFiscal: '125', cnpj: 'Acxe Matriz',
      produtoCodigoAcxe: 1001, produtoCodigoQ2p: 2001,
      localidadeId: 'loc-1', quantidadeFisicaKg: '24500',
      quantidadeFiscalKg: '25000', custoBrlKg: '1.20',
      valorTotalNfBrl: '31250.00', codigoLocalEstoqueOrigemAcxe: '999',
    };
    const dbMock = criarDbComTabelas(await tabelas(aprRow, loteRow));
    vi.mocked(getDb).mockReturnValue(dbMock as never);

    await aprovar({ id: 'apr-3', usuarioId: 'u1', perfilUsuario: 'gestor' });

    // 1) Todas as 3 chamadas OMIE compartilham o mesmo opId no cod_int_ajuste —
    // e ele e DETERMINISTICO (id da aprovacao, STK-01), nao mais randomUUID.
    const calls = vi.mocked(omieMod.incluirAjusteEstoque).mock.calls;
    const codIntAjustes = calls.map((c) => (c[1] as { codIntAjuste?: string }).codIntAjuste ?? '');
    const opIds = codIntAjustes.map((c) => c.split(':')[0]);
    expect(opIds[0]).toBe('apr-3');
    expect(new Set(opIds).size).toBe(1); // mesmo opId nas 3 chamadas
    expect(codIntAjustes[0]).toMatch(/:acxe-trf$/);
    expect(codIntAjustes[1]).toMatch(/:q2p-ent$/);
    expect(codIntAjustes[2]).toMatch(/:acxe-faltando$/);

    // 2) Movimentacao foi inserida com o mesmo opId + statusOmie=concluida
    const valuesCalls = dbMock.values.mock.calls as Array<[Record<string, unknown>]>;
    const movInsert = valuesCalls.find((c) => c[0] && typeof c[0] === 'object' && 'idMovestAcxe' in c[0]);
    expect(movInsert).toBeDefined();
    expect(movInsert![0]).toMatchObject({
      opId: 'apr-3',
      statusOmie: 'concluida',
    });
  });
});

describe('aprovacao.service#rejeitar', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejeita pendencia e marca lote como rejeitado', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(
      criarDbComTabelas(await tabelas({
        id: 'apr-1', loteId: 'lote-1', status: 'pendente',
        precisaNivel: 'gestor', tipoAprovacao: 'entrada_manual', lancadoPor: 'op-1',
      })) as never,
    );
    const res = await rejeitar({ id: 'apr-1', usuarioId: 'u1', perfilUsuario: 'gestor', motivo: 'Quantidade incorreta' });
    expect(res.id).toBe('apr-1');
  });

  it('notifica operador por email ao rejeitar', async () => {
    const { getDb, sendEmail } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(
      criarDbComTabelas(await tabelas({
        id: 'apr-1', loteId: 'lote-1', status: 'pendente',
        precisaNivel: 'gestor', tipoAprovacao: 'entrada_manual', lancadoPor: 'op-1',
      })) as never,
    );
    await rejeitar({ id: 'apr-1', usuarioId: 'u1', perfilUsuario: 'gestor', motivo: 'Motivo teste' });
    // EML-20: notificação virou fire-and-forget (void) — aguarda flush dos microtasks
    await vi.waitFor(() =>
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'operador@test.local',
          subject: expect.stringContaining('rejeitado'),
        }),
      ),
    );
  });

  it('exige motivo', async () => {
    await expect(rejeitar({ id: 'apr-1', usuarioId: 'u1', perfilUsuario: 'gestor', motivo: '' })).rejects.toThrow(/motivo/i);
    await expect(rejeitar({ id: 'apr-1', usuarioId: 'u1', perfilUsuario: 'gestor', motivo: '   ' })).rejects.toThrow(/motivo/i);
  });
});

describe('aprovacao.service#resubmeter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cria nova linha de aprovacao (preserva historico)', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(
      criarDbComTabelas(await tabelas({
        id: 'apr-1', loteId: 'lote-1', status: 'rejeitada',
        precisaNivel: 'gestor', tipoAprovacao: 'recebimento_divergencia',
        quantidadePrevistaKg: '25', quantidadeRecebidaKg: '20', tipoDivergencia: 'faltando',
      })) as never,
    );
    const res = await resubmeter({
      id: 'apr-1', usuarioId: 'u-operador',
      quantidadeRecebidaKg: 22, observacoes: 'Recontagem: encontrados 2t adicionais',
    });
    expect(res.novaAprovacaoId).toBe('nova-id');
    expect(res.id).toBe('apr-1');
  });

  it('bloqueia resubmissao se status nao e rejeitada', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(
      criarDbComTabelas(await tabelas({
        id: 'apr-1', loteId: 'lote-1', status: 'pendente',
        precisaNivel: 'gestor', tipoAprovacao: 'recebimento_divergencia',
      })) as never,
    );
    await expect(resubmeter({
      id: 'apr-1', usuarioId: 'u1', quantidadeRecebidaKg: 22, observacoes: 'x',
    })).rejects.toThrow(AprovacaoStatusInvalidoError);
  });

  it('exige motivo', async () => {
    await expect(resubmeter({ id: 'apr-1', usuarioId: 'u1', quantidadeRecebidaKg: 20, observacoes: '' })).rejects.toThrow(/motivo/i);
  });
});

// STK-01/07 (ACXEGDP-281/287): claim atomico — o perdedor de uma corrida
// (outra requisicao mudou o status entre o pre-check e o UPDATE condicional)
// recebe erro tipado em vez de sobrescrever silenciosamente.
describe('aprovacao.service — claim atomico (STK-01/07)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('aprovar: perdedor da corrida recebe AprovacaoStatusInvalidoError (nao 200 silencioso)', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(
      criarDbComTabelas(
        await tabelas({
          id: 'apr-race', loteId: 'lote-1', status: 'pendente',
          precisaNivel: 'gestor', tipoAprovacao: 'entrada_manual', lancadoPor: 'op-1',
        }),
        { claimFalha: true },
      ) as never,
    );
    await expect(
      aprovar({ id: 'apr-race', usuarioId: 'u1', perfilUsuario: 'gestor' }),
    ).rejects.toThrow(AprovacaoStatusInvalidoError);
  });

  it('rejeitar: perdedor da corrida recebe AprovacaoStatusInvalidoError', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(
      criarDbComTabelas(
        await tabelas({
          id: 'apr-race', loteId: 'lote-1', status: 'pendente',
          precisaNivel: 'gestor', tipoAprovacao: 'entrada_manual', lancadoPor: 'op-1',
        }),
        { claimFalha: true },
      ) as never,
    );
    await expect(
      rejeitar({ id: 'apr-race', usuarioId: 'u1', perfilUsuario: 'gestor', motivo: 'corrida' }),
    ).rejects.toThrow(AprovacaoStatusInvalidoError);
  });

  it('aprovar divergencia: opId dos cod_int_ajuste e o ID DA APROVACAO (deterministico, nao random)', async () => {
    const { getDb } = await import('@atlas/core');
    const omieMod = await import('@atlas/integration-omie');
    const aprRow = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', loteId: 'lote-det', status: 'pendente',
      precisaNivel: 'gestor', tipoAprovacao: 'recebimento_divergencia',
      quantidadeRecebidaKg: '24500', tipoDivergencia: 'faltando', lancadoPor: 'op-1',
    };
    const loteRow = {
      id: 'lote-det', codigo: 'L-DET', notaFiscal: '900', cnpj: 'Acxe Matriz',
      produtoCodigoAcxe: 1001, produtoCodigoQ2p: 2001,
      localidadeId: 'loc-1', quantidadeFisicaKg: '24500',
      quantidadeFiscalKg: '25000', custoBrlKg: '1.20',
      valorTotalNfBrl: '31250.00', codigoLocalEstoqueOrigemAcxe: '999',
    };
    vi.mocked(getDb).mockReturnValue(criarDbComTabelas(await tabelas(aprRow, loteRow)) as never);

    await aprovar({ id: aprRow.id, usuarioId: 'u1', perfilUsuario: 'gestor' });

    // Duas invocacoes concorrentes desta mesma aprovacao gerariam o MESMO
    // cod_int_ajuste — a protecao 1035 do OMIE deduplica no ERP.
    const calls = vi.mocked(omieMod.incluirAjusteEstoque).mock.calls;
    for (const c of calls) {
      expect((c[1] as { codIntAjuste?: string }).codIntAjuste).toMatch(
        new RegExp(`^${aprRow.id}:`),
      );
    }
  });
});

describe('aprovacao.service#resubmeter — guard de duplicacao (STK-07)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bloqueia re-submissao quando o lote ja tem aprovacao pendente', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(
      criarDbComTabelas(
        await tabelas({
          id: 'apr-1', loteId: 'lote-1', status: 'rejeitada',
          precisaNivel: 'gestor', tipoAprovacao: 'recebimento_divergencia',
          quantidadePrevistaKg: '25', quantidadeRecebidaKg: '20', tipoDivergencia: 'faltando',
        }),
        { pendentesDoLote: [{ id: 'apr-pendente-de-resubmissao-anterior' }] },
      ) as never,
    );
    await expect(
      resubmeter({ id: 'apr-1', usuarioId: 'u1', quantidadeRecebidaKg: 22, observacoes: 'de novo' }),
    ).rejects.toThrow(ResubmissaoDuplicadaError);
  });
});

// STK-06 (ACXEGDP-286): retorno de comodato — a persistencia da BAIXA do TROCA
// era feita fora/antes da transacao com statusOmie='concluida' incondicional.
// Agora roda dentro da tx (apos o claim) e reflete a pendencia Q2P nas DUAS
// movimentacoes, com os valores unitarios persistidos pro retry (STK-03b).
describe('aprovacao.service#aprovarSaidaManual — retorno_comodato (STK-06)', () => {
  beforeEach(() => vi.clearAllMocks());

  const aprRow = {
    id: 'apr-ret', loteId: null, status: 'pendente',
    precisaNivel: 'gestor', tipoAprovacao: 'retorno_comodato',
    quantidadeRecebidaKg: '800', lancadoPor: 'op-1',
    produtoCodigoAcxe: 2002, galpao: '11.1', empresa: 'q2p',
    movimentacaoId: 'mov-multi',
  };
  // Uma unica linha serve os 3 selects de movimentacao (entrada, origem, baixa)
  // no mock por-tabela — os campos cobrem os 3 papeis.
  const movRow = {
    id: 'mov-multi', opId: 'op-ret', movimentacaoOrigemId: 'mov-multi',
    produtoCodigoAcxe: 1001, galpao: '11.1', quantidadeKg: '800',
    createdAt: new Date('2026-06-01T12:00:00Z'), observacoes: 'Comodato cliente X',
  };

  async function montarDb() {
    const mod = await import('@atlas/db');
    const m = new Map<object, unknown[]>();
    m.set(mod.aprovacao, [aprRow]);
    m.set(mod.movimentacao, [movRow]);
    m.set(mod.users, [{ email: 'operador@test.local' }]);
    return criarDbComTabelas(m);
  }

  it('Q2P pendente: BAIXA e ENTRADA ficam pendente_q2p, com custo persistido, dentro da tx', async () => {
    const { getDb } = await import('@atlas/core');
    const omieSaida = await import('../services/omie-saida.service.js');
    vi.mocked(omieSaida.executarRetornoComodatoOmieDual).mockResolvedValue({
      acxe: {
        baixa: { idMovest: 'MB-A', idAjuste: 'AB-A' },
        entrada: { idMovest: 'ME-A', idAjuste: 'AE-A' },
      },
      q2p: null,
      pendenciaQ2p: { mensagem: 'Q2P caiu depois do ACXE' },
    });
    const dbMock = await montarDb();
    vi.mocked(getDb).mockReturnValue(dbMock as never);

    await aprovar({ id: 'apr-ret', usuarioId: 'gestor-1', perfilUsuario: 'gestor' });

    const setCalls = (dbMock.set as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;

    // Baixa do TROCA: ids ACXE da perna baixa + pendente_q2p (antes: 'concluida' incondicional)
    const setBaixa = setCalls.find((c) => c[0]?.idMovestAcxe === 'MB-A');
    expect(setBaixa?.[0]).toMatchObject({
      statusOmie: 'pendente_q2p',
      custoUnitarioBrl: '2.5',
      mvAcxe: -1,
      tentativasQ2p: 1,
      ultimoErroOmie: expect.objectContaining({ mensagem: expect.stringContaining('Q2P caiu') }),
    });

    // Entrada destino: ids ACXE da perna entrada + pendente_q2p + custo persistido
    const setEntrada = setCalls.find((c) => c[0]?.idMovestAcxe === 'ME-A');
    expect(setEntrada?.[0]).toMatchObject({
      statusOmie: 'pendente_q2p',
      custoUnitarioBrl: '2.5',
      mvAcxe: 1,
      tentativasQ2p: 1,
    });

    // Ordem dos updates prova que a baixa roda DEPOIS do claim da aprovacao
    // (dentro da tx) — antes ela commitava sozinha antes da tx abrir.
    const updateCalls = (dbMock.update as ReturnType<typeof vi.fn>).mock.calls as Array<[{ __id?: string } | object]>;
    expect(updateCalls[0]?.[0]).toBe(dbMod.aprovacao);
  });

  it('sucesso completo: baixa e entrada concluidas com os 4 ids persistidos', async () => {
    const { getDb } = await import('@atlas/core');
    const omieSaida = await import('../services/omie-saida.service.js');
    vi.mocked(omieSaida.executarRetornoComodatoOmieDual).mockResolvedValue({
      acxe: {
        baixa: { idMovest: 'MB-A', idAjuste: 'AB-A' },
        entrada: { idMovest: 'ME-A', idAjuste: 'AE-A' },
      },
      q2p: {
        baixa: { idMovest: 'MB-Q', idAjuste: 'AB-Q' },
        entrada: { idMovest: 'ME-Q', idAjuste: 'AE-Q' },
      },
      pendenciaQ2p: null,
    });
    const dbMock = await montarDb();
    vi.mocked(getDb).mockReturnValue(dbMock as never);

    await aprovar({ id: 'apr-ret', usuarioId: 'gestor-1', perfilUsuario: 'gestor' });

    const setCalls = (dbMock.set as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    const setBaixa = setCalls.find((c) => c[0]?.idMovestAcxe === 'MB-A');
    expect(setBaixa?.[0]).toMatchObject({
      statusOmie: 'concluida',
      idMovestQ2p: 'MB-Q',
      mvQ2p: -1,
    });
    const setEntrada = setCalls.find((c) => c[0]?.idMovestAcxe === 'ME-A');
    expect(setEntrada?.[0]).toMatchObject({
      statusOmie: 'concluida',
      idMovestQ2p: 'ME-Q',
      mvQ2p: 1,
    });
  });
});

describe('aprovacao.service#inferirNivelAprovacao', () => {
  it('comodato exige diretor', () => {
    expect(inferirNivelAprovacao('comodato')).toBe('diretor');
  });
  it('saidas normais exigem gestor', () => {
    expect(inferirNivelAprovacao('descarte')).toBe('gestor');
    expect(inferirNivelAprovacao('amostra')).toBe('gestor');
    expect(inferirNivelAprovacao('transf_intra_cnpj')).toBe('gestor');
  });
  it('default para subtipos nao mapeados e gestor', () => {
    expect(inferirNivelAprovacao('subtipo-desconhecido')).toBe('gestor');
  });
});
