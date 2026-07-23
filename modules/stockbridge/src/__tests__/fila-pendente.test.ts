import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 014 (ACXEGDP-299): fila de recebimento em modo real — o "Caso 2" de
// getFilaOmie que era um stub (`return []`). Fonte: nf_pedido_mapa/filhote
// cruzados ao vivo com o espelho OMIE, granularidade por produto.
//  - US1 (T005/T006/T007): itens reais, mapeamento de rows, NF recebida fora.
//  - US3 (T025-T028): exclusões estruturais (mãe/cancelada/não-sincronizada) e
//    ordenação — provadas pelo SQL gerado (JOINs/filtros/ORDER BY).

const poolQuerySpy = vi.fn();

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  buildEmailLayout: (o: { titulo?: string }) => ({ html: String(o?.titulo ?? ''), text: String(o?.titulo ?? '') }),
  escapeHtml: (v: unknown) => (v == null ? '' : String(v)),
  emailDataList: () => '',
  emailActionBox: (html: string) => html,
}));

vi.mock('@atlas/db', () => ({
  lote: { __id: 'lote' },
  movimentacao: { __id: 'movimentacao' },
  movimentacaoLegado: { __id: 'movimentacaoLegado' },
  aprovacao: { __id: 'aprovacao' },
  localidade: { __id: 'localidade' },
  localidadeCorrelacao: { __id: 'localidadeCorrelacao' },
  users: { __id: 'users' },
}));

vi.mock('@atlas/integration-omie', () => ({
  incluirAjusteEstoque: vi.fn(),
  listarAjusteEstoque: vi.fn(),
  consultarNF: vi.fn(),
  isMockMode: () => false,
}));

import { getFilaPendente } from '../services/recebimento.service.js';

function respostaPadrao(sql: string) {
  if (sql.includes('information_schema')) {
    return { rows: [{ ok: true }] };
  }
  return { rows: [] };
}

beforeEach(() => {
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation((sql: string) => Promise.resolve(respostaPadrao(sql)));
});

describe('getFilaPendente — US1 (T005/T006/T007)', () => {
  it('mapeia as rows do banco para FilaQueueItem (conversões numéricas)', async () => {
    poolQuerySpy.mockImplementation((sql: string) => {
      if (sql.includes('information_schema')) return Promise.resolve({ rows: [{ ok: true }] });
      return Promise.resolve({
        rows: [
          {
            nf_filhote: '5390',
            pedido_acxe_omie: '12345',
            produtos_total: 1,
            produtos_pendentes: 1,
            quantidade_pendente_kg: 25500,
            dt_emissao: '2026-07-16',
            dias_desde_emissao: 0,
          },
          {
            nf_filhote: '5378',
            pedido_acxe_omie: '12340',
            produtos_total: 2,
            produtos_pendentes: 1,
            quantidade_pendente_kg: 10200,
            dt_emissao: '2026-07-10',
            dias_desde_emissao: 6,
          },
        ],
      });
    });

    const fila = await getFilaPendente();

    expect(fila).toHaveLength(2);
    expect(fila[0]).toEqual({
      nfFilhote: '5390',
      pedidoAcxeOmie: '12345',
      produtosTotal: 1,
      produtosPendentes: 1,
      quantidadePendenteKg: 25500,
      dtEmissao: '2026-07-16',
      diasDesdeEmissao: 0,
    });
    // NF parcialmente recebida (feature 013, resumível): contagem por produto
    expect(fila[1]!.produtosTotal).toBe(2);
    expect(fila[1]!.produtosPendentes).toBe(1);
  });

  it('fila vazia (nenhuma pendência) devolve []', async () => {
    const fila = await getFilaPendente();
    expect(fila).toEqual([]);
  });

  it('falha de banco não derruba a tela — loga e devolve [] (fila é informativa)', async () => {
    poolQuerySpy.mockImplementation((sql: string) => {
      if (sql.includes('information_schema')) return Promise.resolve({ rows: [{ ok: true }] });
      return Promise.reject(new Error('conexão caiu'));
    });
    const fila = await getFilaPendente();
    expect(fila).toEqual([]);
  });
});

describe('getFilaPendente — US3: exclusões e ordenação provadas pelo SQL (T025-T028)', () => {
  async function capturarSqlDaFila(): Promise<string> {
    await getFilaPendente();
    const sql = poolQuerySpy.mock.calls
      .map((c) => c[0] as string)
      .find((s) => s.includes('nf_pedido_filhote'));
    expect(sql).toBeDefined();
    return sql!;
  }

  it('T025 — NF mãe nunca vira item: a query itera SOMENTE nf_pedido_filhote', async () => {
    const sql = await capturarSqlDaFila();
    // nf_mae não aparece como coluna selecionada nem como fonte de item
    expect(sql).not.toContain('nf_mae');
    expect(sql).toContain('f.nf_filhote');
  });

  it('T026 — cancelada/deletada fora (nfValidaSql aplicado ao header)', async () => {
    const sql = await capturarSqlDaFila();
    expect(sql).toContain('COALESCE(h.deletada, false) = false');
    expect(sql).toContain('COALESCE(h.cancelada, false) = false');
  });

  it('T027 — não sincronizada fora: JOIN (não LEFT JOIN) com tbl_nf_header', async () => {
    const sql = await capturarSqlDaFila();
    expect(sql).toMatch(/JOIN public\."tbl_nf_header_ACXE" h/);
    expect(sql).not.toMatch(/LEFT JOIN public\."tbl_nf_header_ACXE" h/);
  });

  it('T028 — ordenação: emissão mais antiga primeiro', async () => {
    const sql = await capturarSqlDaFila();
    expect(sql).toContain('ORDER BY h.d_emi ASC');
  });

  it('granularidade por produto: pendência via produtoPendenteSql + HAVING > 0', async () => {
    const sql = await capturarSqlDaFila();
    expect(sql).toContain('m.produto_codigo_acxe = i.n_cod_prod');
    expect(sql).toMatch(/HAVING COUNT\(\*\) FILTER/);
  });

  it('ACXEGDP-183 — NF recebida via movimentacao_legado não entra na fila', async () => {
    const sql = await capturarSqlDaFila();
    // produtoPendenteSql combina as 3 fontes; a do legado (por NF) precisa
    // estar presente — sem ela, filhote antiga recebida no legado reapareceria.
    expect(sql).toContain('stockbridge.movimentacao_legado');
    expect(sql).toContain('COALESCE(h.n_id_receb, 0) > 0');
  });
});
