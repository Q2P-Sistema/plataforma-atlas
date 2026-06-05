import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isSubtipoSaidaManual,
  registrarSaidaManual,
  SaldoInsuficienteError,
  SubtipoInvalidoError,
  ComodatoDadosObrigatoriosError,
} from '../services/saida-manual.service.js';
import { NIVEL_APROVACAO_POR_SUBTIPO } from '../types.js';

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  getDb: vi.fn(),
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@atlas/db', () => ({
  movimentacao: {},
  aprovacao: {},
  divergencia: {},
  reservaSaldo: {},
}));

vi.mock('../services/notificacao.service.js', () => ({
  enviarAlertaAprovacaoPendente: vi.fn().mockResolvedValue(undefined),
}));

/** Mock do db.execute retornando saldo OMIE configuravel + reservas configuraveis. */
function criarDbMockSaldo(saldoKg: number, reservadoKg: number) {
  const tx = {
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'novo-id' }]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue({
      rows: [{ disp_kg: String(saldoKg - reservadoKg) }],
    }),
  };
  return {
    execute: vi.fn().mockResolvedValue({
      rows: [{ saldo_omie_kg: String(saldoKg), reservado_kg: String(reservadoKg) }],
    }),
    transaction: async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx),
  };
}

describe('saida-manual#isSubtipoSaidaManual', () => {
  it('aceita os 6 subtipos validos', () => {
    const validos = ['transf_intra_cnpj', 'comodato', 'amostra', 'descarte', 'quebra', 'inventario_menos'];
    for (const s of validos) {
      expect(isSubtipoSaidaManual(s)).toBe(true);
    }
  });

  it('rejeita subtipos de entrada ou invalidos', () => {
    expect(isSubtipoSaidaManual('importacao')).toBe(false);
    expect(isSubtipoSaidaManual('venda')).toBe(false);
    expect(isSubtipoSaidaManual('regularizacao_fiscal')).toBe(false);
    expect(isSubtipoSaidaManual('inexistente')).toBe(false);
  });
});

describe('NIVEL_APROVACAO_POR_SUBTIPO — regras de autoridade', () => {
  it('comodato exige diretor', () => {
    expect(NIVEL_APROVACAO_POR_SUBTIPO.comodato).toBe('diretor');
  });

  it('saidas normais exigem gestor', () => {
    expect(NIVEL_APROVACAO_POR_SUBTIPO.transf_intra_cnpj).toBe('gestor');
    expect(NIVEL_APROVACAO_POR_SUBTIPO.amostra).toBe('gestor');
    expect(NIVEL_APROVACAO_POR_SUBTIPO.descarte).toBe('gestor');
    expect(NIVEL_APROVACAO_POR_SUBTIPO.quebra).toBe('gestor');
    expect(NIVEL_APROVACAO_POR_SUBTIPO.inventario_menos).toBe('gestor');
  });
});

describe('saida-manual#registrarSaidaManual — validacoes', () => {
  beforeEach(() => vi.clearAllMocks());

  const inputBase = {
    subtipo: 'descarte' as const,
    produtoCodigoAcxe: 1234,
    galpao: '11',
    empresa: 'q2p' as const,
    quantidadeOriginal: 1000,
    unidade: 'kg' as const,
    observacoes: 'teste',
    userId: 'u1',
  };

  it('rejeita motivo vazio', async () => {
    await expect(registrarSaidaManual({ ...inputBase, observacoes: '' })).rejects.toThrow(/motivo|obrigatorio/i);
  });

  it('rejeita motivo apenas com whitespace', async () => {
    await expect(registrarSaidaManual({ ...inputBase, observacoes: '   ' })).rejects.toThrow(/motivo|obrigatorio/i);
  });

  it('rejeita subtipo invalido', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registrarSaidaManual({ ...inputBase, subtipo: 'venda' as any }),
    ).rejects.toThrow(SubtipoInvalidoError);
  });

  it('comodato exige dtPrevistaRetorno', async () => {
    await expect(
      registrarSaidaManual({
        ...inputBase,
        subtipo: 'comodato',
        empresa: 'q2p',
        cliente: 'Cliente X',
      }),
    ).rejects.toThrow(ComodatoDadosObrigatoriosError);
  });

  it('comodato exige cliente', async () => {
    await expect(
      registrarSaidaManual({
        ...inputBase,
        subtipo: 'comodato',
        empresa: 'q2p',
        dtPrevistaRetorno: '2026-12-31',
      }),
    ).rejects.toThrow(ComodatoDadosObrigatoriosError);
  });

  it('rejeita quando solicitado > saldo OMIE - reservas (SaldoInsuficienteError)', async () => {
    const { getDb } = await import('@atlas/core');
    // saldo 5000 kg - reservado 1000 = 4000 disponivel; pediu 6000 → rejeita
    vi.mocked(getDb).mockReturnValue(criarDbMockSaldo(5000, 1000) as never);

    await expect(
      registrarSaidaManual({ ...inputBase, quantidadeOriginal: 6000 }),
    ).rejects.toThrow(SaldoInsuficienteError);
  });

  it('aceita quando solicitado <= saldo disponivel', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(criarDbMockSaldo(5000, 0) as never);

    const res = await registrarSaidaManual({ ...inputBase, quantidadeOriginal: 4000 });
    expect(res).toMatchObject({ status: 'aguardando_aprovacao' });
  });

  it('transf_intra_cnpj exige galpao destino diferente da origem', async () => {
    await expect(
      registrarSaidaManual({
        ...inputBase,
        subtipo: 'transf_intra_cnpj',
        galpao: '11',
        galpaoDestino: '11',
      }),
    ).rejects.toThrow(/destino/i);
  });
});
