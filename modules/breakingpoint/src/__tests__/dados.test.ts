import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @atlas/core: capturamos o SQL passado a db.execute e controlamos as rows.
const mockExecute = vi.fn();
vi.mock('@atlas/core', () => ({
  getDb: () => ({ execute: mockExecute }),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { getPagamentosSemanais, getRecebimentosSemanais } from '../services/dados.service.js';

// Reconstrói a string de um objeto SQL do drizzle criado via sql.raw(...).
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

beforeEach(() => {
  mockExecute.mockReset();
});

describe('MOD-03 — projeção de caixa inclui títulos vencidos', () => {
  it('getPagamentosSemanais: SQL não exclui vencidos (sem limite inferior de vencimento)', async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    await getPagamentosSemanais('acxe', null, 26);

    const sqlStr = sqlText(mockExecute.mock.calls[0]![0]);
    // O bug excluía vencidos com BETWEEN CURRENT_DATE AND ...; o fix usa só o teto.
    expect(sqlStr).not.toMatch(/BETWEEN\s+CURRENT_DATE\s+AND/i);
    expect(sqlStr).toMatch(/data_vencimento\s*<=\s*CURRENT_DATE\s*\+/i);
  });

  it('getRecebimentosSemanais: SQL não exclui vencidos', async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    await getRecebimentosSemanais('acxe', 26);

    const sqlStr = sqlText(mockExecute.mock.calls[0]![0]);
    expect(sqlStr).not.toMatch(/BETWEEN\s+CURRENT_DATE\s+AND/i);
    expect(sqlStr).toMatch(/data_vencimento\s*<=\s*CURRENT_DATE\s*\+/i);
  });

  it('pagamentos: título vencido (semana negativa) é agregado na semana 0', async () => {
    // Com o fix, o banco passa a retornar linhas com semana < 0 (vencidos).
    mockExecute.mockResolvedValue({
      rows: [
        { semana: -3, total: '1000', finimp_total: '0' }, // atrasado 3 semanas
        { semana: 0, total: '250', finimp_total: '0' },
        { semana: 2, total: '500', finimp_total: '0' },
      ],
    });
    const out = await getPagamentosSemanais('acxe', null, 26);

    expect(out).toHaveLength(26);
    // vencido (-3) + o que já era semana 0 → 1000 + 250 = 1250 na semana 0
    expect(out[0]!.total).toBe(1250);
    expect(out[2]!.total).toBe(500);
  });

  it('recebimentos: título vencido (semana negativa) é agregado na semana 0', async () => {
    mockExecute.mockResolvedValue({
      rows: [
        { semana: -5, total: '9000' },
        { semana: 1, total: '400' },
      ],
    });
    const out = await getRecebimentosSemanais('acxe', 26);

    expect(out).toHaveLength(26);
    expect(out[0]!.total).toBe(9000);
    expect(out[1]!.total).toBe(400);
  });
});
