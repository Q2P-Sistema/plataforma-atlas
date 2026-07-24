import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 014 (ACXEGDP-299): granularidade por produto em Pendências Fiscais
// (T014/T019) e na auto-desativação do mapa (T015/T020) — o cenário-chave é a
// NF filhote multi-produto PARCIALMENTE recebida (feature 013, resumível), que
// antes contava como recebida por inteiro com 1 de N produtos.

const poolQuerySpy = vi.fn();
const clientQuerySpy = vi.fn();

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getPool: () => ({
    query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params),
    connect: () =>
      Promise.resolve({
        query: (sql: string, params?: unknown[]) => clientQuerySpy(sql, params),
        release: vi.fn(),
      }),
  }),
  getConfig: () => ({ STOCKBRIDGE_FISCAL_CUTOFF_DATE: '2026-01-01' }),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  buildEmailLayout: (o: { titulo?: string }) => ({ html: String(o?.titulo ?? ''), text: String(o?.titulo ?? '') }),
  escapeHtml: (v: unknown) => (v == null ? '' : String(v)),
  emailDataList: () => '',
  emailActionBox: (html: string) => html,
}));

vi.mock('@atlas/db', () => ({
  lote: {},
  movimentacao: {},
  movimentacaoLegado: {},
  aprovacao: {},
  localidade: {},
  localidadeCorrelacao: {},
  users: {},
}));

import { getPendenciasFiscais } from '../services/pendencias-fiscais.service.js';
import { upsertNfPedidoMapa } from '../services/nf-pedido-mapa.service.js';

/** Row de filhote no shape da query (feature 014: com granularidade). */
function filhoteRow(overrides: Record<string, unknown>) {
  return {
    pedido_acxe_omie: '111',
    nf_filhote: '5378',
    posicao: 1,
    filhote_qtde_kg: 25_500,
    dias_desde_emissao: 6,
    nf_emitida: true,
    receb_omie: false,
    in_mov: false,
    in_legado: false,
    cancelada: false,
    produtos_total: 1,
    produtos_recebidos: 0,
    recebido_kg: null,
    ...overrides,
  };
}

function mockPendenciasQueries(filhotes: Array<Record<string, unknown>>) {
  poolQuerySpy.mockImplementation((sql: string) => {
    if (sql.includes('information_schema')) return Promise.resolve({ rows: [{ ok: true }] });
    // 1ª query: pedidos (cabeçalho)
    if (sql.includes('dias_exoneracao')) {
      return Promise.resolve({
        rows: [{
          mapa_id: 'm1', pedido_acxe_omie: '111', nf_mae: '5336', mae_emissao: '2026-07-07',
          dias_exoneracao: 9, qtde_pedido_kg: 51_000, estagio_fup: null, lote_em_transito: false,
        }],
      });
    }
    // 2ª query: filhotes
    if (sql.includes('nf_pedido_filhote')) {
      return Promise.resolve({ rows: filhotes });
    }
    // 3ª query: sem mapa
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  poolQuerySpy.mockReset();
  clientQuerySpy.mockReset();
});

describe('getPendenciasFiscais — granularidade por produto (T014/T019)', () => {
  it('T019 — filhote multi-produto PARCIAL: recebida=false, contagens expostas, pedido vira parcial', async () => {
    mockPendenciasQueries([
      filhoteRow({
        produtos_total: 2,
        produtos_recebidos: 1,
        recebido_kg: 15_300,
        in_mov: true, // 1 dos 2 produtos entrou via Atlas
        filhote_qtde_kg: 25_500,
      }),
    ]);

    const data = await getPendenciasFiscais();

    const pedido = data.pedidos[0]!;
    const filhote = pedido.filhotes[0]!;
    expect(filhote.recebida).toBe(false); // NÃO conta como recebida com 1 de 2
    expect(filhote.produtosTotal).toBe(2);
    expect(filhote.produtosRecebidos).toBe(1);
    // O kg recebido soma SÓ os produtos que entraram (15.300, não 25.500)
    expect(pedido.recebidoKg).toBe(15_300);
    expect(pedido.statusAgregado).toBe('parcial');
  });

  it('T014 — regressão single-item: filhote de 1 produto recebida via Atlas continua recebida (fonte movimentacao)', async () => {
    mockPendenciasQueries([
      filhoteRow({
        produtos_total: 1,
        produtos_recebidos: 1,
        recebido_kg: 25_500,
        in_mov: true,
      }),
    ]);

    const data = await getPendenciasFiscais();

    const filhote = data.pedidos[0]!.filhotes[0]!;
    expect(filhote.recebida).toBe(true);
    expect(filhote.fonteRecebimento).toBe('movimentacao');
    expect(data.pedidos[0]!.recebidoKg).toBe(25_500);
  });

  it('sinais por NF (OMIE/legado) seguem marcando a filhote inteira como recebida', async () => {
    mockPendenciasQueries([
      filhoteRow({
        produtos_total: 2,
        produtos_recebidos: 2, // n_id_receb>0 → produtoPendenteSql marca todos
        recebido_kg: 25_500,
        receb_omie: true,
      }),
    ]);

    const data = await getPendenciasFiscais();

    const filhote = data.pedidos[0]!.filhotes[0]!;
    expect(filhote.recebida).toBe(true);
    expect(filhote.fonteRecebimento).toBe('omie');
  });

  it('ACXEGDP-183 — filhote recebida via legado (n_id_receb=0 no OMIE): recebida, fonte movimentacao_legado', async () => {
    // Cenário do critério de aceite da issue: NF antiga cujo recebimento só
    // existe em stockbridge.movimentacao_legado — o OMIE nunca teve n_id_receb.
    mockPendenciasQueries([
      filhoteRow({
        receb_omie: false,
        in_legado: true,
        produtos_total: 1,
        produtos_recebidos: 1, // produtoPendenteSql aceita o legado (por NF)
        recebido_kg: 25_500,
      }),
    ]);

    const data = await getPendenciasFiscais();

    const pedido = data.pedidos[0]!;
    const filhote = pedido.filhotes[0]!;
    expect(filhote.recebida).toBe(true);
    expect(filhote.fonteRecebimento).toBe('movimentacao_legado');
    expect(pedido.recebidoKg).toBe(25_500);
    expect(pedido.statusAgregado).not.toBe('pendente');
  });

  it('cancelada nunca conta como recebida nem soma kg', async () => {
    mockPendenciasQueries([
      filhoteRow({
        cancelada: true,
        produtos_total: 1,
        produtos_recebidos: 1,
        recebido_kg: 25_500,
        in_mov: true,
      }),
    ]);

    const data = await getPendenciasFiscais();

    expect(data.pedidos[0]!.filhotes[0]!.recebida).toBe(false);
    expect(data.pedidos[0]!.recebidoKg).toBe(0);
  });

  it('seção sem-mapa: SQL filtra movimentação por PRODUTO (NF parcial mantém o produto que falta)', async () => {
    mockPendenciasQueries([]);
    await getPendenciasFiscais();

    const sqlSemMapa = poolQuerySpy.mock.calls
      .map((c) => c[0] as string)
      .find((s) => s.includes('em_metricas'));
    expect(sqlSemMapa).toBeDefined();
    expect(sqlSemMapa).toContain('m.produto_codigo_acxe = i.n_cod_prod');
  });

  it('ACXEGDP-183 — seção sem-mapa exclui NF reconciliada em movimentacao_legado', async () => {
    mockPendenciasQueries([]);
    await getPendenciasFiscais();

    const sqlSemMapa = poolQuerySpy.mock.calls
      .map((c) => c[0] as string)
      .find((s) => s.includes('em_metricas'));
    expect(sqlSemMapa).toBeDefined();
    expect(sqlSemMapa).toContain('stockbridge.movimentacao_legado');
  });
});

describe('upsertNfPedidoMapa — auto-desativação por produto (T015/T020)', () => {
  function mockUpsertQueries(args: { pendente: boolean }) {
    clientQuerySpy.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO stockbridge.nf_pedido_mapa')) {
        return Promise.resolve({ rows: [{ id: 'mapa-1', was_insert: true }] });
      }
      if (sql.includes('SELECT EXISTS')) {
        return Promise.resolve({ rows: [{ pendente: args.pendente }] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('T020 — produto pendente em qualquer filhote mantém o mapa ATIVO', async () => {
    mockUpsertQueries({ pendente: true });

    await upsertNfPedidoMapa([{ pedido: '111', nf_mae: '5336', nf_filhotes: ['5390', '5391'] }]);

    const desativacao = clientQuerySpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('SET ativo = false') && (c[0] as string).includes('nf_pedido_mapa'),
    );
    expect(desativacao).toBeUndefined();
  });

  it('T015 — sem pendência (todos os produtos recebidos): mapa é desativado, como antes', async () => {
    mockUpsertQueries({ pendente: false });

    await upsertNfPedidoMapa([{ pedido: '111', nf_mae: '5336', nf_filhotes: ['5390'] }]);

    const desativacao = clientQuerySpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('SET ativo = false') && (c[0] as string).includes('nf_pedido_mapa'),
    );
    expect(desativacao).toBeDefined();
  });

  it('a query de pendência junta os ITENS da NF e checa por produto', async () => {
    mockUpsertQueries({ pendente: true });

    await upsertNfPedidoMapa([{ pedido: '111', nf_mae: '5336', nf_filhotes: ['5390'] }]);

    const sqlPendencia = clientQuerySpy.mock.calls
      .map((c) => c[0] as string)
      .find((s) => typeof s === 'string' && s.includes('SELECT EXISTS'));
    expect(sqlPendencia).toBeDefined();
    expect(sqlPendencia).toContain('tbl_nf_itens_ACXE');
    expect(sqlPendencia).toContain('m.produto_codigo_acxe = i.n_cod_prod');
    // filhote não sincronizada continua pendente (comportamento preservado)
    expect(sqlPendencia).toContain('h.n_id_nf IS NULL');
  });

  it('ACXEGDP-183 — a auto-desativação aceita recebimento via OMIE, movimentacao E movimentacao_legado', async () => {
    mockUpsertQueries({ pendente: true });

    await upsertNfPedidoMapa([{ pedido: '111', nf_mae: '5336', nf_filhotes: ['5390'] }]);

    const sqlPendencia = clientQuerySpy.mock.calls
      .map((c) => c[0] as string)
      .find((s) => typeof s === 'string' && s.includes('SELECT EXISTS'));
    expect(sqlPendencia).toBeDefined();
    // As 3 fontes do critério canônico (fiscal-recebida-sql.ts): filhote antiga
    // recebida só no legado (n_id_receb=0 no OMIE) fecha o mapa como as demais.
    expect(sqlPendencia).toContain('COALESCE(h.n_id_receb, 0) > 0');
    expect(sqlPendencia).toContain('stockbridge.movimentacao m');
    expect(sqlPendencia).toContain('stockbridge.movimentacao_legado');
  });
});
