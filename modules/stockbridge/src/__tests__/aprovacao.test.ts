import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  aprovar,
  rejeitar,
  resubmeter,
  AprovacaoNaoEncontradaError,
  AprovacaoNivelInsuficienteError,
  AprovacaoStatusInvalidoError,
  inferirNivelAprovacao,
} from '../services/aprovacao.service.js';

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
}));

vi.mock('@atlas/db', () => ({
  aprovacao: { id: {}, status: {}, loteId: {}, precisaNivel: {}, tipoAprovacao: {}, quantidadePrevistaT: {}, quantidadeRecebidaT: {}, tipoDivergencia: {}, observacoes: {}, lancadoPor: {}, lancadoEm: {} },
  lote: { id: {}, status: {}, quantidadeFisica: {}, updatedAt: {} },
}));

type MockTx = {
  select: (..._args: unknown[]) => MockTx;
  from: (..._args: unknown[]) => MockTx;
  where: (..._args: unknown[]) => MockTx;
  limit: (..._args: unknown[]) => Promise<unknown[]>;
  update: (..._args: unknown[]) => MockTx;
  set: (..._args: unknown[]) => MockTx;
  insert: (..._args: unknown[]) => MockTx;
  values: (..._args: unknown[]) => MockTx;
  returning: (..._args: unknown[]) => Promise<unknown[]>;
};

function criarDbComAprovacao(apr: Record<string, unknown> | null) {
  const tx: Partial<MockTx> = {};
  tx.select = vi.fn().mockReturnValue(tx);
  tx.from = vi.fn().mockReturnValue(tx);
  tx.where = vi.fn().mockReturnValue(tx);
  tx.limit = vi.fn().mockResolvedValue(apr ? [apr] : []);
  tx.update = vi.fn().mockReturnValue(tx);
  tx.set = vi.fn().mockReturnValue(tx);
  tx.insert = vi.fn().mockReturnValue(tx);
  tx.values = vi.fn().mockReturnValue(tx);
  tx.returning = vi.fn().mockResolvedValue([{ id: 'nova-aprovacao-id' }]);
  return {
    transaction: async (fn: (tx: MockTx) => Promise<unknown>) => fn(tx as MockTx),
  };
}

describe('aprovacao.service#aprovar', () => {
  beforeEach(() => vi.clearAllMocks());

  it('aprova pendencia de recebimento_divergencia e promove lote a provisorio', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(criarDbComAprovacao({
      id: 'apr-1', loteId: 'lote-1', status: 'pendente',
      precisaNivel: 'gestor', tipoAprovacao: 'recebimento_divergencia',
    }) as never);

    const res = await aprovar({ id: 'apr-1', usuarioId: 'u1', perfilUsuario: 'gestor' });
    expect(res).toEqual({ id: 'apr-1', loteStatus: 'provisorio' });
  });

  it('lanca AprovacaoNaoEncontradaError quando id nao existe', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(criarDbComAprovacao(null) as never);
    await expect(aprovar({ id: 'naoexiste', usuarioId: 'u1', perfilUsuario: 'gestor' })).rejects.toThrow(AprovacaoNaoEncontradaError);
  });

  it('lanca AprovacaoStatusInvalidoError quando ja aprovada', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(criarDbComAprovacao({
      id: 'apr-1', loteId: 'lote-1', status: 'aprovada',
      precisaNivel: 'gestor', tipoAprovacao: 'recebimento_divergencia',
    }) as never);
    await expect(aprovar({ id: 'apr-1', usuarioId: 'u1', perfilUsuario: 'gestor' })).rejects.toThrow(AprovacaoStatusInvalidoError);
  });

  it('gestor nao pode aprovar pendencia nivel diretor (comodato)', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(criarDbComAprovacao({
      id: 'apr-1', loteId: 'lote-1', status: 'pendente',
      precisaNivel: 'diretor', tipoAprovacao: 'saida_comodato',
    }) as never);
    await expect(aprovar({ id: 'apr-1', usuarioId: 'u1', perfilUsuario: 'gestor' })).rejects.toThrow(AprovacaoNivelInsuficienteError);
  });

  it('diretor pode aprovar pendencia nivel gestor (cobre nivel inferior)', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(criarDbComAprovacao({
      id: 'apr-1', loteId: 'lote-1', status: 'pendente',
      precisaNivel: 'gestor', tipoAprovacao: 'recebimento_divergencia',
    }) as never);
    const res = await aprovar({ id: 'apr-1', usuarioId: 'u1', perfilUsuario: 'diretor' });
    expect(res.id).toBe('apr-1');
  });
});

describe('aprovacao.service#rejeitar', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejeita pendencia e marca lote como rejeitado', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(criarDbComAprovacao({
      id: 'apr-1', loteId: 'lote-1', status: 'pendente',
      precisaNivel: 'gestor', tipoAprovacao: 'recebimento_divergencia',
    }) as never);
    const res = await rejeitar({ id: 'apr-1', usuarioId: 'u1', perfilUsuario: 'gestor', motivo: 'Quantidade incorreta' });
    expect(res.id).toBe('apr-1');
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
    vi.mocked(getDb).mockReturnValue(criarDbComAprovacao({
      id: 'apr-1', loteId: 'lote-1', status: 'rejeitada',
      precisaNivel: 'gestor', tipoAprovacao: 'recebimento_divergencia',
      quantidadePrevistaT: '25', quantidadeRecebidaT: '20', tipoDivergencia: 'faltando',
    }) as never);
    const res = await resubmeter({
      id: 'apr-1', usuarioId: 'u-operador',
      quantidadeRecebidaT: 22, observacoes: 'Recontagem: encontrados 2t adicionais',
    });
    expect(res.novaAprovacaoId).toBe('nova-aprovacao-id');
    expect(res.id).toBe('apr-1');
  });

  it('bloqueia resubmissao se status nao e rejeitada', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(criarDbComAprovacao({
      id: 'apr-1', loteId: 'lote-1', status: 'pendente',
      precisaNivel: 'gestor', tipoAprovacao: 'recebimento_divergencia',
    }) as never);
    await expect(resubmeter({
      id: 'apr-1', usuarioId: 'u1', quantidadeRecebidaT: 22, observacoes: 'x',
    })).rejects.toThrow(AprovacaoStatusInvalidoError);
  });

  it('exige motivo', async () => {
    await expect(resubmeter({ id: 'apr-1', usuarioId: 'u1', quantidadeRecebidaT: 20, observacoes: '' })).rejects.toThrow(/motivo/i);
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
