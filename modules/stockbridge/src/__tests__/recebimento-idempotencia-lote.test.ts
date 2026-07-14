import { describe, it, expect, vi, beforeEach } from 'vitest';

// STK-02 (ACXEGDP-282): o fluxo divergente cria apenas lote (aguardando_aprovacao)
// + aprovacao — nenhuma movimentacao. nfJaProcessada precisa considerar esses lotes
// abertos, senao a mesma NF pode ser recebida de novo antes da decisao do gestor.

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
 * necessario porque nfJaProcessada faz 3 selects em Promise.all sobre tabelas
 * diferentes e o resultado precisa divergir entre elas.
 */
function dbComRespostasPorTabela(rows: RespostasPorTabela) {
  return {
    select: vi.fn(() => {
      let alvo: keyof RespostasPorTabela | undefined;
      const mini = {
        from: vi.fn((t: { __id?: keyof RespostasPorTabela }) => {
          alvo = t?.__id;
          return mini;
        }),
        where: vi.fn(() => mini),
        limit: vi.fn(() => Promise.resolve((alvo && rows[alvo]) || [])),
      };
      return mini;
    }),
  };
}

const inputBase = {
  nf: '300',
  cnpj: 'acxe' as const,
  quantidadeInput: 1000,
  unidadeInput: 'kg' as const,
  localidadeId: 'loc-1',
  userId: 'user-1',
};

describe('nfJaProcessada considera lote aberto do fluxo divergente (STK-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processarRecebimento rejeita NF com lote aguardando_aprovacao ativo (sem consultar OMIE)', async () => {
    const db = dbComRespostasPorTabela({
      lote: [{ id: 'lote-aberto' }],
    });
    vi.mocked(getDb).mockReturnValue(db as never);

    await expect(processarRecebimento(inputBase)).rejects.toThrow(NotaFiscalJaProcessadaError);
    expect(consultarNFSpy).not.toHaveBeenCalled();
  });

  it('getFilaOmie oculta NF com lote aguardando_aprovacao ativo', async () => {
    const db = dbComRespostasPorTabela({
      lote: [{ id: 'lote-aberto' }],
    });
    vi.mocked(getDb).mockReturnValue(db as never);

    const items = await getFilaOmie({ nf: '300', cnpj: 'acxe' });

    expect(items).toEqual([]);
    expect(consultarNFSpy).not.toHaveBeenCalled();
  });

  it('NF sem movimentacao/legado/lote-aberto passa da idempotencia (lote rejeitado nao bloqueia)', async () => {
    // O mock resolve [] para as 3 consultas — equivale a "so existe lote rejeitado",
    // que o predicado (status IN aguardando_aprovacao/provisorio) exclui de proposito.
    const db = dbComRespostasPorTabela({});
    vi.mocked(getDb).mockReturnValue(db as never);
    consultarNFSpy.mockRejectedValue(new Error('SENTINELA: passou da idempotencia'));

    await expect(processarRecebimento(inputBase)).rejects.toThrow('SENTINELA: passou da idempotencia');
    expect(consultarNFSpy).toHaveBeenCalledTimes(1);
  });

  it('movimentacao entrada_nf ativa continua bloqueando (comportamento pre-existente preservado)', async () => {
    const db = dbComRespostasPorTabela({
      movimentacao: [{ id: 'mov-1' }],
    });
    vi.mocked(getDb).mockReturnValue(db as never);

    await expect(processarRecebimento(inputBase)).rejects.toThrow(NotaFiscalJaProcessadaError);
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
