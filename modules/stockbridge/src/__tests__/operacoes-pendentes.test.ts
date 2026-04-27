import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  sendEmail: vi.fn(),
  getPool: () => ({ query: vi.fn() }),
}));

vi.mock('@atlas/db', () => ({
  movimentacao: { __id: 'movimentacao' },
  lote: { __id: 'lote' },
  localidadeCorrelacao: { __id: 'localidadeCorrelacao' },
}));

vi.mock('@atlas/integration-omie', () => ({
  incluirAjusteEstoque: vi.fn(),
  listarAjusteEstoque: vi.fn(),
}));

import {
  marcarComoFalhaDefinitiva,
  OperadorSemRetentativasError,
  OperacaoPendenteNaoEncontradaError,
  OperacaoNaoPendenteError,
} from '../services/operacoes-pendentes.service.js';

interface ChainMock {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

function chainComMov(mov: Record<string, unknown> | null): ChainMock {
  // db.select().from().where().limit(1) -> [mov?]
  // db.update().set().where() -> Promise<void>
  // where() retorna chain (encadeavel) na select-chain; quando vier de set(), deve retornar promise.
  // Solucao: where retorna THIS, mas limit retorna a lista. set retorna um sub-chain com where=Promise.
  const limitResolved = mov ? [mov] : [];
  const setSpy = vi.fn();
  const chain: ChainMock = {
    select: vi.fn().mockReturnThis() as never,
    from: vi.fn().mockReturnThis() as never,
    where: vi.fn().mockReturnThis() as never,
    limit: vi.fn(() => Promise.resolve(limitResolved)) as never,
    update: vi.fn().mockReturnThis() as never,
    set: setSpy as never,
  };
  setSpy.mockReturnValue({ where: vi.fn(() => Promise.resolve(undefined)) });
  return chain;
}

describe('marcarComoFalhaDefinitiva (US3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('atualiza status_omie=falha e registra motivo no ultimo_erro_omie', async () => {
    const { getDb } = await import('@atlas/core');
    const chain = chainComMov({
      id: 'mov-1',
      statusOmie: 'pendente_q2p',
      tentativasQ2p: 2,
    });
    vi.mocked(getDb).mockReturnValue(chain as never);

    const res = await marcarComoFalhaDefinitiva({
      movimentacaoId: 'mov-1',
      motivo: 'OMIE bloqueado, produto suspenso',
      ator: { userId: 'u1', role: 'gestor' },
    });

    expect(res).toEqual({ id: 'mov-1' });
    // set() recebeu statusOmie=falha + ultimoErroOmie estruturado
    const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    expect(setCalls[0]?.[0]).toMatchObject({
      statusOmie: 'falha',
      ultimoErroOmie: expect.objectContaining({
        lado: 'manual',
        mensagem: expect.stringContaining('OMIE bloqueado'),
      }),
    });
  });

  it('rejeita operador (apenas gestor/diretor)', async () => {
    await expect(
      marcarComoFalhaDefinitiva({
        movimentacaoId: 'mov-1',
        motivo: 'tentativa do operador',
        ator: { userId: 'op1', role: 'operador' },
      }),
    ).rejects.toBeInstanceOf(OperadorSemRetentativasError);
  });

  it('rejeita motivo vazio', async () => {
    await expect(
      marcarComoFalhaDefinitiva({
        movimentacaoId: 'mov-1',
        motivo: '   ',
        ator: { userId: 'u1', role: 'gestor' },
      }),
    ).rejects.toThrow(/Motivo obrigatorio/);
  });

  it('lanca OperacaoPendenteNaoEncontradaError quando movimentacao nao existe', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(chainComMov(null) as never);

    await expect(
      marcarComoFalhaDefinitiva({
        movimentacaoId: 'naoexiste',
        motivo: 'teste',
        ator: { userId: 'u1', role: 'diretor' },
      }),
    ).rejects.toBeInstanceOf(OperacaoPendenteNaoEncontradaError);
  });

  it('lanca OperacaoNaoPendenteError quando ja esta concluida', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(
      chainComMov({ id: 'mov-1', statusOmie: 'concluida' }) as never,
    );

    await expect(
      marcarComoFalhaDefinitiva({
        movimentacaoId: 'mov-1',
        motivo: 'teste',
        ator: { userId: 'u1', role: 'gestor' },
      }),
    ).rejects.toBeInstanceOf(OperacaoNaoPendenteError);
  });

  it('lanca OperacaoNaoPendenteError quando ja foi marcada como falha antes', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(
      chainComMov({ id: 'mov-1', statusOmie: 'falha' }) as never,
    );

    await expect(
      marcarComoFalhaDefinitiva({
        movimentacaoId: 'mov-1',
        motivo: 'teste',
        ator: { userId: 'u1', role: 'gestor' },
      }),
    ).rejects.toBeInstanceOf(OperacaoNaoPendenteError);
  });
});
