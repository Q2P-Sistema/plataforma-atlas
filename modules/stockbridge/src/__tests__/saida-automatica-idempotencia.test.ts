import { describe, it, expect, vi, beforeEach } from 'vitest';

// STK-09 (ACXEGDP-288): a chave de idempotencia da saida automatica passa a
// incluir a EMPRESA emissora — a numeracao de NF e por emissor, entao a NF 300
// da Q2P nao pode ser engolida como "ja processada" porque a ACXE emitiu uma
// NF 300. O insert persiste `empresa` (participa do indice da migration 0044).

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
  movimentacao: { __id: 'movimentacao' },
  divergencia: { __id: 'divergencia' },
  localidade: { id: {}, cnpj: {} },
  localidadeCorrelacao: { codigoLocalEstoqueAcxe: {}, codigoLocalEstoqueQ2p: {}, localidadeId: {} },
  lote: { __id: 'lote' },
  aprovacao: { __id: 'aprovacao' },
  users: { __id: 'users' },
}));

import { getDb } from '@atlas/core';
import { processarSaidaAutomatica } from '../services/saida-automatica.service.js';

/**
 * Mock minimo do fluxo: idempotencia (select movimentacao → configuravel),
 * localidade fisica (select innerJoin → localidade ACXE fixa) e tx.insert
 * com captura de values.
 */
function montarDb(opts: { jaExiste?: boolean } = {}) {
  const valuesSpy = vi.fn(() => ({ returning: () => Promise.resolve([{ id: 'nova-mov' }]) }));
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(opts.jaExiste ? [{ id: 'mov-existente' }] : [])),
        })),
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([{ localidadeId: 'loc-1', cnpj: 'Acxe Matriz' }])),
          })),
        })),
      })),
    })),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ insert: vi.fn(() => ({ values: valuesSpy })) }),
  };
  return { db, valuesSpy };
}

const inputBase = {
  nf: '00000300',
  tipoOmie: 'venda' as const,
  cnpjEmissor: 'acxe' as const,
  produtoCodigo: 123,
  quantidadeOriginal: 500,
  unidade: 'kg' as const,
  localidadeOrigemCodigo: 4498926337,
  dtEmissao: '20/04/2026',
  idMovestOmie: '7777777',
};

describe('processarSaidaAutomatica — idempotência por empresa (STK-09)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('insert persiste empresa = cnpj emissor (acxe)', async () => {
    const { db, valuesSpy } = montarDb();
    vi.mocked(getDb).mockReturnValue(db as never);

    const res = await processarSaidaAutomatica({ ...inputBase, cnpjEmissor: 'acxe' });

    expect(res.idempotente).toBe(false);
    const movValues = valuesSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(movValues.empresa).toBe('acxe');
    expect(movValues.notaFiscal).toBe('00000300');
  });

  it('insert persiste empresa = cnpj emissor (q2p)', async () => {
    const { db, valuesSpy } = montarDb();
    vi.mocked(getDb).mockReturnValue(db as never);

    // Localidade fisica ACXE + emissor Q2P = debito cruzado — flui igual,
    // o que importa aqui e a coluna empresa no insert da movimentacao.
    const res = await processarSaidaAutomatica({ ...inputBase, cnpjEmissor: 'q2p' });

    expect(res.idempotente).toBe(false);
    const movValues = valuesSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(movValues.empresa).toBe('q2p');
  });

  it('registro existente da MESMA empresa continua idempotente (sem insert)', async () => {
    const { db, valuesSpy } = montarDb({ jaExiste: true });
    vi.mocked(getDb).mockReturnValue(db as never);

    const res = await processarSaidaAutomatica(inputBase);

    expect(res.idempotente).toBe(true);
    expect(res.movimentacaoId).toBe('mov-existente');
    expect(valuesSpy).not.toHaveBeenCalled();
  });
});
