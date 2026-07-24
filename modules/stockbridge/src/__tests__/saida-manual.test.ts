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
  buildEmailLayout: (o: { titulo?: string }) => ({ html: String(o?.titulo ?? ''), text: String(o?.titulo ?? '') }),
  emailDataList: () => '',
  emailActionBox: (html: string) => html,
  escapeHtml: (v: unknown) => (v == null ? '' : String(v)),
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
    // A mesma row serve à query de saldo (lê saldo_omie_kg/reservado_kg) e à de
    // descrição do produto (lê descricao) — EML-05.
    execute: vi.fn().mockResolvedValue({
      rows: [{ saldo_omie_kg: String(saldoKg), reservado_kg: String(reservadoKg), descricao: 'PP HOMOPOLIMERO H301' }],
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

  // EML-05: o e-mail de aprovação deve receber a DESCRIÇÃO do produto, não o SKU cru.
  it('notifica aprovação com a descrição do produto (não o SKU cru)', async () => {
    const { getDb } = await import('@atlas/core');
    const { enviarAlertaAprovacaoPendente } = await import('../services/notificacao.service.js');
    vi.mocked(getDb).mockReturnValue(criarDbMockSaldo(5000, 0) as never);

    await registrarSaidaManual({ ...inputBase, quantidadeOriginal: 4000 });

    const arg = vi.mocked(enviarAlertaAprovacaoPendente).mock.calls[0]![0];
    expect(arg.produto).toBe('PP HOMOPOLIMERO H301');
    expect(arg.loteCodigo).not.toContain(String(inputBase.produtoCodigoAcxe));
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

// STK-11 (ACXEGDP-289): o re-check de saldo dentro da tx nao protegia nada em
// READ COMMITTED (duas tx concorrentes nao veem a reserva uma da outra). O
// advisory lock transacional por (produto, galpao, empresa) serializa o trio.
describe('saida-manual#registrarSaidaManual — advisory lock (STK-11)', () => {
  beforeEach(() => vi.clearAllMocks());

  function sqlText(obj: unknown): string {
    const chunks = (obj as { queryChunks?: Array<{ value?: unknown }> })?.queryChunks;
    if (!chunks) return String(obj);
    return chunks
      .map((c) => {
        const v = c.value;
        if (Array.isArray(v)) return v.join('');
        if (typeof v === 'string') return v;
        return '';
      })
      .join('');
  }

  it('adquire pg_advisory_xact_lock do trio ANTES do re-check de saldo', async () => {
    const { getDb } = await import('@atlas/core');
    const txExecute = vi.fn().mockResolvedValue({ rows: [{ disp_kg: '5000' }] });
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
      execute: txExecute,
    };
    const db = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ saldo_omie_kg: '5000', reservado_kg: '0', descricao: 'PP H301' }],
      }),
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    vi.mocked(getDb).mockReturnValue(db as never);

    await registrarSaidaManual({
      subtipo: 'descarte',
      produtoCodigoAcxe: 1234,
      galpao: '11',
      empresa: 'q2p',
      quantidadeOriginal: 1000,
      unidade: 'kg',
      observacoes: 'teste lock',
      userId: 'u1',
    });

    // 1ª instrucao da tx = lock com a chave do trio; 2ª = re-check de saldo
    const primeira = sqlText(txExecute.mock.calls[0]![0]);
    expect(primeira).toContain('pg_advisory_xact_lock');
    expect(primeira).toContain('hashtextextended');
    // A chave do trio vai como parametro bound (chunk Param do drizzle)
    expect(JSON.stringify(txExecute.mock.calls[0]![0])).toContain('sb:reserva:1234:11:q2p');
    const segunda = sqlText(txExecute.mock.calls[1]![0]);
    expect(segunda).toContain('reserva_saldo');
  });
});
