import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — `retentavelQ2p` na listagem de Movimentacoes: a perna Q2P de uma
// entrada ficou pendente DEPOIS da decisao do gestor (status_omie 'pendente_q2p' e nenhuma aprovacao pendente
// ligada a movimentacao). A tela mostra "Retentar Q2P" (gestor+) so quando e true.

const executeSpy = vi.fn();
vi.mock('@atlas/core', () => ({ getDb: () => ({ execute: (q: unknown) => executeSpy(q) }) }));

import { listar } from '../services/movimentacao.service.js';

const linha = (over: Record<string, unknown> = {}) => ({
  id: 'm1', nota_fiscal: '937', tipo_movimento: 'entrada_manual', subtipo: 'compra_nacional', recebida_por_nf: true,
  quantidade_kg: '26000.000', observacoes: null, created_at: '2026-10-22T12:00:00.000Z',
  mv_acxe: 1, dt_acxe: '2026-10-22T12:05:00.000Z', id_movest_acxe: 'MOV-ACXE', id_user_acxe: 'u1', user_acxe_nome: 'Gestor',
  mv_q2p: null, dt_q2p: null, id_movest_q2p: null, id_user_q2p: null, user_q2p_nome: null,
  lote_codigo: null, produto_codigo_acxe: 4001, produto_descricao: 'PP PRETO Q35', galpao: '21.1', empresa: 'acxe',
  criado_por: 'u0', criado_por_nome: 'Operador', status_omie: 'pendente_q2p', retentavel_q2p: true, baixa_pedido_q2p: null,
  aprovado_por: 'u1', aprovado_por_nome: 'Gestor', aprovado_em: '2026-10-22T12:05:00.000Z',
  ...over,
});

beforeEach(() => {
  executeSpy.mockReset();
});

function sqlDaListagem(): string {
  const q = executeSpy.mock.calls[0]![0] as { queryChunks?: unknown[] };
  return JSON.stringify(q.queryChunks ?? q);
}

describe('listar — retentavelQ2p', () => {
  it('devolve true quando a perna Q2P ficou pendente depois da aprovacao e false nas demais', async () => {
    executeSpy
      .mockResolvedValueOnce({
        rows: [
          linha({ id: 'pendente-apos-aprovacao', retentavel_q2p: true }),
          linha({ id: 'aguardando-gestor', status_omie: 'pendente_q2p', retentavel_q2p: false }),
          linha({ id: 'concluida', status_omie: 'concluida', retentavel_q2p: false }),
          linha({ id: 'sem-coluna', retentavel_q2p: undefined }),
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: '4' }] });
    const r = await listar({});
    expect(Object.fromEntries(r.items.map((i) => [i.id, i.retentavelQ2p]))).toEqual({
      'pendente-apos-aprovacao': true,
      'aguardando-gestor': false,
      concluida: false,
      'sem-coluna': false,
    });
    expect(r.total).toBe(4);
  });

  it('o SQL: pendente_q2p E nenhuma aprovacao PENDENTE ligada pelo movimentacao_id', async () => {
    executeSpy.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: '0' }] });
    await listar({});
    const sql = sqlDaListagem();
    expect(sql).toContain("m.status_omie = 'pendente_q2p'");
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('ap_pend.movimentacao_id = m.id AND ap_pend.status = \'pendente\'');
    expect(sql).toContain('AS retentavel_q2p');
  });

  it('o restante do item nao muda (empresa, galpao, lados, status)', async () => {
    executeSpy.mockResolvedValueOnce({ rows: [linha()] }).mockResolvedValueOnce({ rows: [{ total: '1' }] });
    const [i] = (await listar({})).items;
    expect(i).toMatchObject({
      id: 'm1', empresa: 'acxe', galpao: '21.1', statusOmie: 'pendente_q2p', recebidaPorNf: true, retentavelQ2p: true,
      ladoAcxe: { status: 'Sucesso', idMovest: 'MOV-ACXE' }, ladoQ2p: { status: null, idMovest: null },
    });
  });
});
