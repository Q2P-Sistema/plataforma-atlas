import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processarRecebimento } from '../services/recebimento.service.js';

// Feature 013: o recebimento processa 1..N itens por NF; falha de OMIE em um item
// vira DESFECHO daquele item (pendente_q2p | falha_acxe), não erro do lote. Estes
// testes fixam, para N=1, exatamente a semântica de persistência/OMIE de sempre
// (guarda de regressão do single-item) — só o envelope do resultado mudou.

const incluirSpy = vi.fn();
const listarSpy = vi.fn();
const consultarNFSpy = vi.fn();
const poolQuerySpy = vi.fn();

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getPool: () => ({
    // Feature 012: a validação consulta tbl_nf_header — devolve NF válida da ACXE aqui;
    // demais queries (correlação) seguem pelo poolQuerySpy controlado por teste.
    query: (sql: string, params?: unknown[]) =>
      typeof sql === 'string' && sql.includes('tbl_nf_header')
        ? Promise.resolve({ rows: [{ cancelada: false, emitente_acxe: true }] })
        : poolQuerySpy(sql, params),
  }),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  buildEmailLayout: (o: { titulo?: string }) => ({ html: String(o?.titulo ?? ''), text: String(o?.titulo ?? '') }),
  escapeHtml: (v: unknown) => (v == null ? '' : String(v)),
  emailDataList: () => '',
  emailActionBox: (html: string) => html,
}));

vi.mock('@atlas/db', () => ({
  lote: { __id: 'lote' },
  movimentacao: { __id: 'movimentacao' },
  movimentacaoLegado: { __id: 'movimentacaoLegado' },
  aprovacao: { __id: 'aprovacao' },
  localidade: { __id: 'localidade' },
  localidadeCorrelacao: { __id: 'localidadeCorrelacao' },
  users: { __id: 'users' },
}));

vi.mock('@atlas/integration-omie', () => ({
  incluirAjusteEstoque: (...args: unknown[]) => incluirSpy(...args),
  listarAjusteEstoque: (...args: unknown[]) => listarSpy(...args),
  consultarNF: (...args: unknown[]) => consultarNFSpy(...args),
  isMockMode: () => false,
}));

interface ChainMock {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  transaction: (fn: (tx: ChainMock) => Promise<unknown>) => Promise<unknown>;
}

/**
 * Chain mock por-tabela: from(tabela) devolve um "leaf" que resolve as rows
 * daquela tabela tanto em .limit() quanto por await direto (thenable) — o
 * serviço tem consultas awaited em pontos diferentes (batch de localidades usa
 * where sem limit; idempotência usa limit(1); Promise.all mistura as duas).
 */
function criarChain(rowsByTable: Map<{ __id: string }, unknown[]>): ChainMock {
  const chain: ChainMock = {
    select: vi.fn(() => chain) as never,
    from: vi.fn((table: { __id: string }) => {
      const rows = rowsByTable.get(table) ?? [];
      const leaf = {
        where: vi.fn(() => leaf),
        innerJoin: vi.fn(() => leaf),
        limit: vi.fn(() => Promise.resolve(rows)),
        then: (res?: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(res, rej),
      };
      return leaf;
    }) as never,
    insert: vi.fn().mockReturnThis() as never,
    values: vi.fn().mockReturnThis() as never,
    returning: vi.fn() as never,
    execute: vi.fn().mockResolvedValue({ rows: [{ next_val: '42' }] }) as never,
    transaction: async (fn) => fn(chain),
  };
  return chain;
}

const LOCALIDADE_ID = '00000000-0000-0000-0000-000000000100';

function inputBase(nf: string) {
  return {
    nf,
    cnpj: 'acxe' as const,
    itens: [
      {
        produtoCodigoAcxe: 1001,
        quantidadeInput: 25_000,
        unidadeInput: 'kg' as const,
        localidadeId: LOCALIDADE_ID,
      },
    ],
    userId: '00000000-0000-0000-0000-000000000001',
  };
}

function nfOmie(nNF: string) {
  return {
    nNF, cChaveNFe: 'C', dEmi: '15/04/2026',
    vNF: 30_000, nCodCli: 1, cRazao: 'FORN MOCK',
    itens: [{
      nCodProd: 1001, codigoLocalEstoque: '999',
      qCom: 25_000, uCom: 'KG', xProd: 'PEAD', vUnCom: 1.2,
    }],
  };
}

function rowsPadrao(dbMod: Record<string, { __id: string }>) {
  return new Map<{ __id: string }, unknown[]>([
    [dbMod.movimentacao as never, []], // idempotencia: produto nao recebido
    [dbMod.lote as never, []],
    [dbMod.movimentacaoLegado as never, []],
    [dbMod.localidade as never, [{ id: LOCALIDADE_ID, codigo: 'EXT', nome: 'Extrema', ativo: true }]],
    [dbMod.localidadeCorrelacao as never, [{
      localidadeId: LOCALIDADE_ID,
      codigoLocalEstoqueAcxe: 111,
      codigoLocalEstoqueQ2p: 222,
    }]],
  ]);
}

beforeEach(() => {
  incluirSpy.mockReset();
  listarSpy.mockReset();
  consultarNFSpy.mockReset();
  poolQuerySpy.mockReset();
  poolQuerySpy.mockResolvedValue({
    rows: [{
      codigo_produto_acxe: 1001,
      codigo_produto_q2p: 2001,
      descricao: 'PEAD',
      codigo_local_estoque_acxe: 111,
      codigo_local_estoque_q2p: 222,
    }],
  });
});

describe('processarRecebimento — falha Q2P apos ACXE ok (US2)', () => {
  it('grava movimentacao com status_omie=pendente_q2p e devolve o item pendente (recuperavel)', async () => {
    // OMIE: ACXE ok, Q2P falha
    incluirSpy
      .mockResolvedValueOnce({ idMovest: 'M-ACXE', idAjuste: 'A-ACXE', descricaoStatus: 'ok' })
      .mockRejectedValueOnce(new Error('OMIE Q2P 503 Service Unavailable'));
    consultarNFSpy.mockResolvedValue(nfOmie('00000300'));

    const dbMod = await import('@atlas/db');
    const chain = criarChain(rowsPadrao(dbMod as never));
    chain.returning
      .mockResolvedValueOnce([{ id: 'lote-1', codigo: 'L042' }])
      .mockResolvedValueOnce([{ id: 'mov-1' }]);
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(chain as never);

    const res = await processarRecebimento(inputBase('300'));

    // 1) Desfecho por item: pendente_q2p, com os dados de recuperacao
    expect(res.resumo).toMatchObject({ recebidos: 0, pendentesOmie: 1, falhas: 0 });
    const item = res.itens[0]!;
    expect(item.status).toBe('pendente_q2p');
    expect(item.movimentacaoId).toBe('mov-1');
    expect(item.omie?.acxe).toEqual({ idMovest: 'M-ACXE', idAjuste: 'A-ACXE' });
    expect(item.mensagemErro).toMatch(/OMIE Q2P 503/);

    // 2) Movimentacao foi inserida com status_omie=pendente_q2p (semântica intacta)
    const valuesCalls = (chain.values as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
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
      // Feature 013: produto entra na chave de idempotencia (migration 0046)
      produtoCodigoAcxe: 1001,
      produtoCodigoQ2p: 2001,
      empresa: 'acxe',
    });
    expect(movInsert![0].ultimoErroOmie).toMatchObject({
      lado: 'q2p',
      mensagem: expect.stringContaining('OMIE Q2P 503'),
    });

    // 3) OMIE foi chamado 2 vezes (ACXE + Q2P), apenas Q2P falhou
    expect(incluirSpy).toHaveBeenCalledTimes(2);
  });
});

describe('processarRecebimento — falha ACXE (US2)', () => {
  it('NAO grava nada quando ACXE falha (estado limpo; item falha_acxe)', async () => {
    incluirSpy.mockRejectedValueOnce(new Error('OMIE ACXE 504 Gateway Timeout'));
    consultarNFSpy.mockResolvedValue(nfOmie('00000301'));

    const dbMod = await import('@atlas/db');
    const chain = criarChain(rowsPadrao(dbMod as never));
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(chain as never);

    const res = await processarRecebimento(inputBase('301'));

    expect(res.resumo).toMatchObject({ recebidos: 0, pendentesOmie: 0, falhas: 1 });
    expect(res.itens[0]!.status).toBe('falha_acxe');
    expect(res.itens[0]!.mensagemErro).toMatch(/OMIE ACXE/);

    // OMIE chamado uma vez (so ACXE), Q2P nao foi tentado
    expect(incluirSpy).toHaveBeenCalledTimes(1);
    expect(incluirSpy).toHaveBeenCalledWith('acxe', expect.any(Object));

    // Nenhum INSERT foi executado (db.transaction nem rodou)
    expect(chain.insert).not.toHaveBeenCalled();
    expect(chain.values).not.toHaveBeenCalled();
  });

  it('item falha_acxe sai limpo (sem loteId nem movimentacaoId — re-submeter completa)', async () => {
    incluirSpy.mockRejectedValueOnce(new Error('OMIE ACXE down'));
    consultarNFSpy.mockResolvedValue(nfOmie('00000302'));

    const dbMod = await import('@atlas/db');
    const chain = criarChain(rowsPadrao(dbMod as never));
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(chain as never);

    const res = await processarRecebimento(inputBase('302'));

    const item = res.itens[0]!;
    expect(item.status).toBe('falha_acxe');
    // ACXE-fail nao popula campos de recovery porque estado e limpo
    expect(item.loteId).toBeUndefined();
    expect(item.movimentacaoId).toBeUndefined();
  });
});

describe('processarRecebimento — recebimento limpo notifica operador + Comex', () => {
  it('sem divergencia e OMIE ok: dispara email "Recebimento concluido" incluindo o Comex', async () => {
    // OMIE: ACXE ok + Q2P ok (sucesso total → lote provisorio)
    incluirSpy
      .mockResolvedValueOnce({ idMovest: 'M-ACXE', idAjuste: 'A-ACXE', descricaoStatus: 'ok' })
      .mockResolvedValueOnce({ idMovest: 'M-Q2P', idAjuste: 'A-Q2P', descricaoStatus: 'ok' });
    // qCom == quantidadeInput (25_000 kg) → delta 0 → sem divergencia
    consultarNFSpy.mockResolvedValue(nfOmie('00000400'));

    const dbMod = await import('@atlas/db');
    const rows = rowsPadrao(dbMod as never);
    rows.set((dbMod as never as Record<string, { __id: string }>).users as never, [{ email: 'operador@acxe.local' }]);
    const chain = criarChain(rows);
    chain.returning
      .mockResolvedValueOnce([{ id: 'lote-9', codigo: 'L100' }])
      .mockResolvedValueOnce([{ id: 'mov-9' }]);

    const core = await import('@atlas/core');
    vi.mocked(core.getDb).mockReturnValue(chain as never);
    vi.mocked(core.sendEmail).mockClear(); // mock compartilhado no arquivo

    const res = await processarRecebimento(inputBase('400'));
    expect(res.itens[0]!.status).toBe('provisorio');
    expect(res.resumo.recebidos).toBe(1);

    // Email e fire-and-forget (void) — aguarda flush dos microtasks
    await vi.waitFor(() => expect(core.sendEmail).toHaveBeenCalled());

    const sendEmailMock = vi.mocked(core.sendEmail);
    const destinos = sendEmailMock.mock.calls.map((c) => (c[0] as { to: string; subject: string }));
    // Todos os emails desse fluxo sao "Recebimento concluído"
    expect(destinos.every((d) => d.subject.includes('Recebimento concluído'))).toBe(true);
    const tos = destinos.map((d) => d.to);
    expect(tos).toContain('operador@acxe.local');
    expect(tos).toContain('comex_acxe@acxe-polimeros.com.br');
  });
});
