import { describe, it, expect, vi, beforeEach } from 'vitest';

// STK-02 (ACXEGDP-282): o fluxo divergente cria apenas lote (aguardando_aprovacao)
// + aprovacao — nenhuma movimentacao. A idempotencia precisa considerar esses lotes
// abertos, senao a mesma NF pode ser recebida de novo antes da decisao do gestor.
//
// Feature 013: a checagem virou POR PRODUTO (produtoDaNfJaRecebido) e roda DEPOIS
// da consulta da NF no OMIE (precisa dos produtos da nota) — so o historico legado
// PHP continua checado por NF antes do OMIE. Com todos os produtos ja recebidos,
// o resultado segue NotaFiscalJaProcessadaError.

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  buildEmailLayout: (o: { titulo?: string }) => ({ html: String(o?.titulo ?? ''), text: String(o?.titulo ?? '') }),
  emailDataList: () => '',
  emailActionBox: (html: string) => html,
  escapeHtml: (v: unknown) => (v == null ? '' : String(v)),
  getPool: () => ({
    query: (sql: string) =>
      typeof sql === 'string' && sql.includes('tbl_nf_header')
        ? Promise.resolve({ rows: [{ cancelada: false, emitente_acxe: true }] })
        : Promise.resolve({ rows: [] }),
  }),
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

const consultarNFSpy = vi.fn();
vi.mock('@atlas/integration-omie', () => ({
  incluirAjusteEstoque: vi.fn(),
  listarAjusteEstoque: vi.fn(),
  consultarNF: (...args: unknown[]) => consultarNFSpy(...args),
  isMockMode: () => true,
}));

import { getDb } from '@atlas/core';
import {
  processarRecebimento,
  getFilaOmie,
  NotaFiscalJaProcessadaError,
} from '../services/recebimento.service.js';

interface RespostasPorTabela {
  movimentacao?: Array<Record<string, unknown>>;
  movimentacaoLegado?: Array<Record<string, unknown>>;
  lote?: Array<Record<string, unknown>>;
}

/**
 * Mock de db onde cada select() resolve conforme a TABELA passada ao from() —
 * necessario porque a idempotencia faz selects em Promise.all sobre tabelas
 * diferentes e o resultado precisa divergir entre elas. O leaf e thenable
 * (feature 013: ha consultas awaited sem .limit()).
 */
function dbComRespostasPorTabela(rows: RespostasPorTabela) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((t: { __id?: keyof RespostasPorTabela }) => {
        const data = (t?.__id && rows[t.__id]) || [];
        const leaf = {
          where: vi.fn(() => leaf),
          innerJoin: vi.fn(() => leaf),
          limit: vi.fn(() => Promise.resolve(data)),
          then: (res?: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
            Promise.resolve(data).then(res, rej),
        };
        return leaf;
      }),
    })),
  };
}

const inputBase = {
  nf: '300',
  cnpj: 'acxe' as const,
  itens: [
    {
      produtoCodigoAcxe: 1001,
      quantidadeInput: 1000,
      unidadeInput: 'kg' as const,
      localidadeId: 'loc-1',
    },
  ],
  userId: 'user-1',
};

const nfOmie = {
  nNF: '00000300', cChaveNFe: 'C', dEmi: '15/04/2026',
  vNF: 30_000, nCodCli: 1, cRazao: 'FORN',
  itens: [{
    nCodProd: 1001, codigoLocalEstoque: '999',
    qCom: 1000, uCom: 'KG', xProd: 'PEAD', vUnCom: 1.2,
  }],
};

describe('idempotencia considera lote aberto do fluxo divergente (STK-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consultarNFSpy.mockResolvedValue(nfOmie);
  });

  it('processarRecebimento rejeita NF cujo produto tem lote aguardando_aprovacao ativo', async () => {
    const db = dbComRespostasPorTabela({
      lote: [{ id: 'lote-aberto' }],
    });
    vi.mocked(getDb).mockReturnValue(db as never);

    await expect(processarRecebimento(inputBase)).rejects.toThrow(NotaFiscalJaProcessadaError);
    // Feature 013: a checagem por produto exige os produtos da NF — consultarNF
    // roda ANTES da idempotencia por produto (1 chamada, sem escrita).
    expect(consultarNFSpy).toHaveBeenCalledTimes(1);
  });

  it('getFilaOmie oculta produto com lote aguardando_aprovacao ativo (fila vazia)', async () => {
    const db = dbComRespostasPorTabela({
      lote: [{ id: 'lote-aberto' }],
    });
    vi.mocked(getDb).mockReturnValue(db as never);

    const items = await getFilaOmie({ nf: '300', cnpj: 'acxe' });

    expect(items).toEqual([]);
  });

  it('NF sem movimentacao/legado/lote-aberto passa da idempotencia (lote rejeitado nao bloqueia)', async () => {
    // O mock resolve [] para todas as consultas — equivale a "so existe lote rejeitado",
    // que o predicado (status IN aguardando_aprovacao/provisorio) exclui de proposito.
    const db = dbComRespostasPorTabela({});
    vi.mocked(getDb).mockReturnValue(db as never);
    consultarNFSpy.mockRejectedValue(new Error('SENTINELA: passou da checagem do legado'));

    await expect(processarRecebimento(inputBase)).rejects.toThrow('SENTINELA');
    expect(consultarNFSpy).toHaveBeenCalledTimes(1);
  });

  it('movimentacao entrada_nf ativa do produto continua bloqueando (pre-existente preservado)', async () => {
    const db = dbComRespostasPorTabela({
      movimentacao: [{ id: 'mov-1' }],
    });
    vi.mocked(getDb).mockReturnValue(db as never);

    await expect(processarRecebimento(inputBase)).rejects.toThrow(NotaFiscalJaProcessadaError);
  });

  it('historico legado PHP bloqueia a NF inteira ANTES de consultar o OMIE', async () => {
    const db = dbComRespostasPorTabela({
      movimentacaoLegado: [{ id: 'legado-1' }],
    });
    vi.mocked(getDb).mockReturnValue(db as never);

    await expect(processarRecebimento(inputBase)).rejects.toThrow(NotaFiscalJaProcessadaError);
    expect(consultarNFSpy).not.toHaveBeenCalled();
  });
});

// STK-12 (ACXEGDP-288): importação é ACXE-only — para cnpj='q2p', getCorrelacao
// buscava o código de produto Q2P em tbl_produtos_ACXE (falso-bloqueio 409 +
// spam de e-mail admin, ou produto errado em coincidência numérica).
describe('importação ACXE-only (STK-12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processarRecebimento com cnpj=q2p → ImportacaoApenasAcxeError, sem tocar OMIE nem DB', async () => {
    const db = dbComRespostasPorTabela({});
    vi.mocked(getDb).mockReturnValue(db as never);

    await expect(
      processarRecebimento({ ...inputBase, cnpj: 'q2p' }),
    ).rejects.toThrow(/Recebimento Nacional/);
    expect(consultarNFSpy).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('getFilaOmie com cnpj=q2p → ImportacaoApenasAcxeError antes da idempotência', async () => {
    const db = dbComRespostasPorTabela({});
    vi.mocked(getDb).mockReturnValue(db as never);

    await expect(getFilaOmie({ nf: '300', cnpj: 'q2p' })).rejects.toThrow(/apenas para NF emitida pela ACXE/);
    expect(consultarNFSpy).not.toHaveBeenCalled();
  });
});
