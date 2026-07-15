import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  processarRecebimento,
  opIdDeterministicoRecebimento,
  NotaFiscalJaProcessadaError,
} from '../services/recebimento.service.js';

// STK-01b (ACXEGDP-311): o caminho feliz do recebimento usava randomUUID() por
// chamada — duas submissoes concorrentes da mesma NF geravam cod_int_ajuste
// diferentes e a recuperacao 1035 do OMIE nao deduplicava. Estes testes fixam:
//   1. o opId e uma funcao pura e ESTAVEL de (nf, cnpj, produto, tentativa);
//   2. duas execucoes do fluxo com a mesma NF enviam o MESMO cod_int_ajuste;
//   3. reprocessamento legitimo (tentativa maior) ganha opId NOVO;
//   4. o backstop 23505 do indice de idempotencia vira NotaFiscalJaProcessadaError.

const incluirSpy = vi.fn();
const listarSpy = vi.fn();
const consultarNFSpy = vi.fn();
const poolQuerySpy = vi.fn();

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getPool: () => ({
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
  NotaFiscalMultiItemError: class NotaFiscalMultiItemError extends Error {},
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
  nf: '500',
  cnpj: 'acxe' as const,
  quantidadeInput: 25_000,
  unidadeInput: 'kg' as const,
  localidadeId: '00000000-0000-0000-0000-000000000100',
  userId: '00000000-0000-0000-0000-000000000001',
};

const nfOmieOk = {
  nNF: '00000500', cChaveNFe: 'C', dEmi: '15/07/2026',
  nCodProd: 1001, codigoLocalEstoque: '999',
  qCom: 25_000, uCom: 'KG', xProd: 'PEAD',
  vUnCom: 1.2, vNF: 30_000,
  nCodCli: 1, cRazao: 'FORN MOCK',
};

async function prepararMocks(chain: ChainMock): Promise<void> {
  const { getDb } = await import('@atlas/core');
  vi.mocked(getDb).mockReturnValue(chain as never);
}

async function cenarioPadrao(): Promise<ChainMock> {
  const dbMod = await import('@atlas/db');
  const rows = new Map<{ __id: string }, unknown[]>([
    [dbMod.movimentacao as never, []], // sem historico: idempotencia passa, tentativa=0
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
  await prepararMocks(chain);
  return chain;
}

beforeEach(() => {
  incluirSpy.mockReset();
  listarSpy.mockReset();
  consultarNFSpy.mockReset();
  poolQuerySpy.mockReset();
  incluirSpy
    .mockResolvedValue({ idMovest: 'M-X', idAjuste: 'A-X', descricaoStatus: 'ok' });
  consultarNFSpy.mockResolvedValue(nfOmieOk);
  poolQuerySpy.mockResolvedValue({
    rows: [{
      codigo_produto_acxe: 1001, codigo_produto_q2p: 2001, descricao: 'PEAD',
      codigo_local_estoque_acxe: 111, codigo_local_estoque_q2p: 222,
    }],
  });
});

describe('opIdDeterministicoRecebimento (funcao pura)', () => {
  const base = { nfNormalizada: '00000500', cnpj: 'acxe' as const, codigoProdutoAcxe: 1001, tentativa: 0 };

  it('mesmos inputs → mesmo opId, em formato UUID valido', () => {
    const a = opIdDeterministicoRecebimento(base);
    const b = opIdDeterministicoRecebimento({ ...base });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('qualquer componente da chave muda → opId muda', () => {
    const ref = opIdDeterministicoRecebimento(base);
    expect(opIdDeterministicoRecebimento({ ...base, nfNormalizada: '00000501' })).not.toBe(ref);
    expect(opIdDeterministicoRecebimento({ ...base, codigoProdutoAcxe: 1002 })).not.toBe(ref);
    expect(opIdDeterministicoRecebimento({ ...base, tentativa: 1 })).not.toBe(ref);
  });
});

describe('processarRecebimento — opId deterministico no fluxo (STK-01b)', () => {
  it('duas execucoes da mesma NF enviam o MESMO cod_int_ajuste ao OMIE', async () => {
    await cenarioPadrao();
    await processarRecebimento(inputBase);
    const codIntPrimeira = (incluirSpy.mock.calls[0]![1] as { codIntAjuste: string }).codIntAjuste;

    // 2a submissao "concorrente": estado ainda limpo (a 1a nao persistiu na visao desta)
    incluirSpy.mockClear();
    await cenarioPadrao();
    await processarRecebimento(inputBase);
    const codIntSegunda = (incluirSpy.mock.calls[0]![1] as { codIntAjuste: string }).codIntAjuste;

    expect(codIntSegunda).toBe(codIntPrimeira);
    // e o opId gravado corresponde a derivacao publica (tentativa=0)
    const esperado = opIdDeterministicoRecebimento({
      nfNormalizada: '00000500', cnpj: 'acxe', codigoProdutoAcxe: 1001, tentativa: 0,
    });
    expect(codIntPrimeira).toBe(`${esperado}:acxe-trf`);
  });

  it('backstop 23505 do indice de idempotencia vira NotaFiscalJaProcessadaError', async () => {
    const chain = await cenarioPadrao();
    // O returning do INSERT de lote dispara a violacao (constraint do indice 0044)
    const err23505 = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'movimentacao_nf_idempotencia_idx',
    });
    chain.returning.mockReset();
    chain.returning.mockRejectedValue(err23505);

    await expect(processarRecebimento(inputBase)).rejects.toBeInstanceOf(NotaFiscalJaProcessadaError);
  });
});
