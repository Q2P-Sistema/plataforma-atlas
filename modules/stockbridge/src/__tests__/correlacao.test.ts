import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCorrelacao, CorrelacaoNaoEncontradaError } from '../services/correlacao.service.js';

vi.mock('@atlas/core', () => ({
  getPool: vi.fn(),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('correlacao.service#getCorrelacao', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retorna correlacao ACXE → Q2P quando produtos tem descricao identica', async () => {
    const { getPool } = await import('@atlas/core');
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockResolvedValue({
        rows: [{
          codigo_produto_acxe: 12345,
          codigo_produto_q2p: 67890,
          descricao: 'PP RAFIA',
          codigo_local_estoque_acxe: 4498926337,
          codigo_local_estoque_q2p: 8115873874,
        }],
      }),
    } as never);

    const result = await getCorrelacao(12345, 4498926337);
    expect(result).toEqual({
      codigoProdutoAcxe: 12345,
      codigoProdutoQ2p: 67890,
      descricao: 'PP RAFIA',
      codigoLocalEstoqueAcxe: 4498926337,
      codigoLocalEstoqueQ2p: 8115873874,
    });
  });

  it('lanca CorrelacaoNaoEncontradaError quando produto nao tem correlato', async () => {
    const { getPool } = await import('@atlas/core');
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as never);

    await expect(getCorrelacao(99_999, 4498926337)).rejects.toThrow(CorrelacaoNaoEncontradaError);
  });

  it('mensagem de erro traz descrição do produto e local legível — nunca o código OMIE (ACXEGDP-313)', async () => {
    const { getPool } = await import('@atlas/core');
    const queryMock = vi
      .fn()
      // 1a chamada: correlacao nao encontrada
      .mockResolvedValueOnce({ rows: [] })
      // 2a chamada: enriquecimento com rotulos legiveis
      .mockResolvedValueOnce({
        rows: [{ produto_label: 'PP RAFIA CINZA', local_label: '11.1 — GALPÃO SJC' }],
      });
    vi.mocked(getPool).mockReturnValue({ query: queryMock } as never);

    const err = (await getCorrelacao(4475057315, 4498926337).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(CorrelacaoNaoEncontradaError);
    expect(err.message).toContain('"PP RAFIA CINZA"');
    expect(err.message).toContain('11.1 — GALPÃO SJC');
    expect(err.message).not.toContain('4475057315');
    expect(err.message).not.toContain('4498926337');
  });

  it('match de descricao e case-sensitive (comportamento legado)', async () => {
    const { getPool } = await import('@atlas/core');
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    vi.mocked(getPool).mockReturnValue({ query: queryMock } as never);

    await expect(getCorrelacao(1, 1)).rejects.toThrow(CorrelacaoNaoEncontradaError);
    // Validamos que a query usa match exato (=) e nao LOWER/ILIKE — preserva comportamento legado
    const calledSql = queryMock.mock.calls[0]?.[0] as string;
    expect(calledSql).toMatch(/a\.descricao\s*=\s*q\.descricao/i);
    expect(calledSql).not.toMatch(/LOWER|ILIKE/i);
  });
});
