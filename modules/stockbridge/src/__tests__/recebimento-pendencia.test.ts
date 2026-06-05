import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processarRecebimento, OmieAjusteError } from '../services/recebimento.service.js';

// Spies para controlar OMIE chamada por chamada
const incluirSpy = vi.fn();
const listarSpy = vi.fn();
const consultarNFSpy = vi.fn();
const poolQuerySpy = vi.fn();

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getPool: () => ({ query: poolQuerySpy }),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@atlas/db', () => ({
  lote: { __id: 'lote' },
  movimentacao: { __id: 'movimentacao' },
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
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  transaction: (fn: (tx: ChainMock) => Promise<unknown>) => Promise<unknown>;
}

function criarChain(rowsByTable: Map<{ __id: string }, unknown[]>): ChainMock {
  let currentRows: unknown[] = [];
  const chain: ChainMock = {
    select: vi.fn().mockReturnThis() as never,
    from: vi.fn((table: { __id: string }) => {
      currentRows = rowsByTable.get(table) ?? [];
      return chain;
    }) as never,
    where: vi.fn().mockReturnThis() as never,
    limit: vi.fn(() => Promise.resolve(currentRows)) as never,
    insert: vi.fn().mockReturnThis() as never,
    values: vi.fn().mockReturnThis() as never,
    returning: vi.fn() as never,
    update: vi.fn().mockReturnThis() as never,
    set: vi.fn().mockReturnThis() as never,
    execute: vi.fn().mockResolvedValue({ rows: [{ next_val: '42' }] }) as never,
    transaction: async (fn) => fn(chain),
  };
  return chain;
}

const inputBase = {
  nf: '300',
  cnpj: 'acxe' as const,
  quantidadeInput: 25_000,
  unidadeInput: 'kg' as const,
  localidadeId: '00000000-0000-0000-0000-000000000100',
  userId: '00000000-0000-0000-0000-000000000001',
};

describe('processarRecebimento — falha Q2P apos ACXE ok (US2)', () => {
  beforeEach(() => {
    incluirSpy.mockReset();
    listarSpy.mockReset();
    consultarNFSpy.mockReset();
    poolQuerySpy.mockReset();
  });

  it('grava movimentacao com status_omie=pendente_q2p e lanca erro recoverable', async () => {
    // OMIE: ACXE ok, Q2P falha
    incluirSpy
      .mockResolvedValueOnce({ idMovest: 'M-ACXE', idAjuste: 'A-ACXE', descricaoStatus: 'ok' })
      .mockRejectedValueOnce(new Error('OMIE Q2P 503 Service Unavailable'));

    consultarNFSpy.mockResolvedValue({
      nNF: '00000300', cChaveNFe: 'C', dEmi: '15/04/2026',
      nCodProd: 1001, codigoLocalEstoque: '999',
      qCom: 25_000, uCom: 'KG', xProd: 'PEAD',
      vUnCom: 1.2, vNF: 30_000,
      nCodCli: 1, cRazao: 'FORN MOCK',
    });

    poolQuerySpy.mockResolvedValue({
      rows: [{
        codigo_produto_acxe: 1001,
        codigo_produto_q2p: 2001,
        descricao: 'PEAD',
        codigo_local_estoque_acxe: 111,
        codigo_local_estoque_q2p: 222,
      }],
    });

    const dbMod = await import('@atlas/db');
    const rows = new Map<{ __id: string }, unknown[]>([
      [dbMod.movimentacao as never, []], // idempotencia: nao processada
      [dbMod.localidade as never, [{ id: inputBase.localidadeId, codigo: 'EXT', ativo: true }]],
      [dbMod.localidadeCorrelacao as never, [{
        localidadeId: inputBase.localidadeId,
        codigoLocalEstoqueAcxe: 111,
        codigoLocalEstoqueQ2p: 222,
      }]],
    ]);
    const chain = criarChain(rows);
    chain.returning
      .mockResolvedValueOnce([{ id: 'lote-1', codigo: 'L042' }])
      .mockResolvedValueOnce([{ id: 'mov-1' }]);

    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(chain as never);

    let capturedErr: unknown;
    try {
      await processarRecebimento(inputBase);
    } catch (err) {
      capturedErr = err;
    }

    // 1) Erro lancado e OmieAjusteError enriquecido
    expect(capturedErr).toBeInstanceOf(OmieAjusteError);
    const ajErr = capturedErr as OmieAjusteError;
    expect(ajErr.lado).toBe('q2p');
    expect(ajErr.recoverable).toBe(true);
    expect(ajErr.opId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ajErr.movimentacaoId).toBe('mov-1');
    expect(ajErr.tentativasRestantes).toBe(1);
    expect(ajErr.idACXE).toEqual({ idMovest: 'M-ACXE', idAjuste: 'A-ACXE' });

    // 2) Movimentacao foi inserida com status_omie=pendente_q2p
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
      opId: ajErr.opId,
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
  beforeEach(() => {
    incluirSpy.mockReset();
    listarSpy.mockReset();
    consultarNFSpy.mockReset();
    poolQuerySpy.mockReset();
  });

  it('NAO grava nada quando ACXE falha (estado limpo)', async () => {
    incluirSpy.mockRejectedValueOnce(new Error('OMIE ACXE 504 Gateway Timeout'));

    consultarNFSpy.mockResolvedValue({
      nNF: '00000301', cChaveNFe: 'C', dEmi: '15/04/2026',
      nCodProd: 1001, codigoLocalEstoque: '999',
      qCom: 25_000, uCom: 'KG', xProd: 'PEAD',
      vUnCom: 1.2, vNF: 30_000,
      nCodCli: 1, cRazao: 'FORN MOCK',
    });

    poolQuerySpy.mockResolvedValue({
      rows: [{
        codigo_produto_acxe: 1001,
        codigo_produto_q2p: 2001,
        descricao: 'PEAD',
        codigo_local_estoque_acxe: 111,
        codigo_local_estoque_q2p: 222,
      }],
    });

    const dbMod = await import('@atlas/db');
    const rows = new Map<{ __id: string }, unknown[]>([
      [dbMod.movimentacao as never, []],
      [dbMod.localidade as never, [{ id: inputBase.localidadeId, codigo: 'EXT', ativo: true }]],
      [dbMod.localidadeCorrelacao as never, [{
        localidadeId: inputBase.localidadeId,
        codigoLocalEstoqueAcxe: 111,
        codigoLocalEstoqueQ2p: 222,
      }]],
    ]);
    const chain = criarChain(rows);
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(chain as never);

    await expect(processarRecebimento({ ...inputBase, nf: '301' })).rejects.toThrow(OmieAjusteError);

    // OMIE chamado uma vez (so ACXE), Q2P nao foi tentado
    expect(incluirSpy).toHaveBeenCalledTimes(1);
    expect(incluirSpy).toHaveBeenCalledWith('acxe', expect.any(Object));

    // Nenhum INSERT foi executado (db.transaction nem rodou)
    expect(chain.insert).not.toHaveBeenCalled();
    expect(chain.values).not.toHaveBeenCalled();
  });

  it('erro ACXE tem stateClean implicito (sem opId nem movimentacaoId)', async () => {
    incluirSpy.mockRejectedValueOnce(new Error('OMIE ACXE down'));

    consultarNFSpy.mockResolvedValue({
      nNF: '00000302', cChaveNFe: 'C', dEmi: '15/04/2026',
      nCodProd: 1001, codigoLocalEstoque: '999',
      qCom: 25_000, uCom: 'KG', xProd: 'PEAD',
      vUnCom: 1.2, vNF: 30_000,
      nCodCli: 1, cRazao: 'FORN MOCK',
    });
    poolQuerySpy.mockResolvedValue({
      rows: [{
        codigo_produto_acxe: 1001, codigo_produto_q2p: 2001, descricao: 'PEAD',
        codigo_local_estoque_acxe: 111, codigo_local_estoque_q2p: 222,
      }],
    });

    const dbMod = await import('@atlas/db');
    const rows = new Map<{ __id: string }, unknown[]>([
      [dbMod.movimentacao as never, []],
      [dbMod.localidade as never, [{ id: inputBase.localidadeId, codigo: 'EXT', ativo: true }]],
      [dbMod.localidadeCorrelacao as never, [{
        localidadeId: inputBase.localidadeId,
        codigoLocalEstoqueAcxe: 111,
        codigoLocalEstoqueQ2p: 222,
      }]],
    ]);
    const chain = criarChain(rows);
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(chain as never);

    let capturedErr: unknown;
    try {
      await processarRecebimento({ ...inputBase, nf: '302' });
    } catch (err) {
      capturedErr = err;
    }

    expect(capturedErr).toBeInstanceOf(OmieAjusteError);
    const ajErr = capturedErr as OmieAjusteError;
    expect(ajErr.lado).toBe('acxe');
    // ACXE-fail nao popula campos de recovery porque estado e limpo
    expect(ajErr.movimentacaoId).toBeUndefined();
    expect(ajErr.recoverable).toBeUndefined();
  });
});
