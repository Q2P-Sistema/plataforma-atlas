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
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  getPool: () => ({ query: vi.fn() }),
}));

vi.mock('@atlas/db', () => ({
  aprovacao: { id: {}, status: {}, loteId: {}, precisaNivel: {}, tipoAprovacao: {}, quantidadePrevistaKg: {}, quantidadeRecebidaKg: {}, tipoDivergencia: {}, observacoes: {}, lancadoPor: {}, lancadoEm: {} },
  lote: { id: {}, status: {}, quantidadeFisicaKg: {}, produtoCodigoAcxe: {}, produtoCodigoQ2p: {}, localidadeId: {}, notaFiscal: {}, custoBrlKg: {}, updatedAt: {} },
  movimentacao: { id: {} },
  localidadeCorrelacao: { localidadeId: {}, codigoLocalEstoqueAcxe: {}, codigoLocalEstoqueQ2p: {} },
  users: { id: {}, email: {} },
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

/**
 * Mock generico que responde diferentes selects baseando-se no objeto "from".
 * Constroi um chain select().from(X).where().limit() que retorna a lista mapeada
 * por referencia de tabela. `transaction` reaproveita o mesmo chain.
 */
function criarDbComTabelas(rows: Map<object, unknown[]>) {
  let currentRows: unknown[] = [];
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn((table: object) => {
      currentRows = rows.get(table) ?? [];
      return chain;
    }),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(() => Promise.resolve(currentRows)),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'nova-id' }]),
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
    vi.mocked(getDb).mockReturnValue(criarDbComTabelas(await tabelas(aprRow, loteRow)) as never);

    const res = await aprovar({ id: 'apr-1', usuarioId: 'u1', perfilUsuario: 'gestor' });
    expect(res).toEqual({ id: 'apr-1', loteStatus: 'provisorio' });
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
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'operador@test.local',
        subject: expect.stringContaining('rejeitado'),
      }),
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
