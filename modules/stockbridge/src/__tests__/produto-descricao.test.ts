import { describe, it, expect, vi } from 'vitest';
import { resolverDescricaoProdutoAcxe } from '../services/produto-descricao.js';

function dbComRows(rows: Array<{ descricao?: string | null }>) {
  return { execute: vi.fn().mockResolvedValue({ rows }) };
}

describe('resolverDescricaoProdutoAcxe — EML-04/05', () => {
  it('retorna a descrição real quando o SKU existe no cadastro', async () => {
    const db = dbComRows([{ descricao: 'PP HOMOPOLIMERO H301' }]);
    await expect(resolverDescricaoProdutoAcxe(db, 819)).resolves.toBe('PP HOMOPOLIMERO H301');
  });

  it('cai no fallback "SKU nnn" quando o produto não existe', async () => {
    const db = dbComRows([]);
    await expect(resolverDescricaoProdutoAcxe(db, 819)).resolves.toBe('SKU 819');
  });

  it('cai no fallback quando a descrição é vazia/nula', async () => {
    const db = dbComRows([{ descricao: '   ' }]);
    await expect(resolverDescricaoProdutoAcxe(db, 42)).resolves.toBe('SKU 42');
  });

  it('não propaga erro de query — fallback "SKU nnn"', async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error('db down')) };
    await expect(resolverDescricaoProdutoAcxe(db, 7)).resolves.toBe('SKU 7');
  });
});
