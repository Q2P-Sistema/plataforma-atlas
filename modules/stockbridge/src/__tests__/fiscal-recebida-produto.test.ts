import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 014 (ACXEGDP-299): granularidade POR PRODUTO na checagem "recebida".
// Parte 1 — unit das funções SQL (T004).
// Parte 2 — prova objetiva de que os SQLs do cockpit/cockpit-executivo usam o
// filtro por produto nos blocos de filhote recebida (T012/T013/T016/T017/T018):
// captura todos os SQLs executados e verifica a presença do predicado
// `m.produto_codigo_acxe = i.n_cod_prod` nos blocos corrigidos. A regressão
// single-item é estrutural: para NF de 1 produto, EXISTS(nf, produto) e
// EXISTS(nf) são logicamente equivalentes (a movimentação registrada é
// necessariamente daquele produto) — coberto pelo unit da Parte 1.

import {
  recebidaViaMovimentacaoSql,
  recebidaViaLegadoSql,
  produtoPendenteSql,
} from '../services/fiscal-recebida-sql.js';

describe('recebidaViaMovimentacaoSql — granularidade opcional (T004)', () => {
  it('sem produtoExpr: comportamento idêntico ao anterior (por NF)', () => {
    const sql = recebidaViaMovimentacaoSql('h.n_nf');
    expect(sql).toContain("m.subtipo = 'importacao'");
    expect(sql).toContain('m.nota_fiscal = h.n_nf');
    expect(sql).not.toContain('produto_codigo_acxe');
  });

  it('com produtoExpr: adiciona o filtro por produto', () => {
    const sql = recebidaViaMovimentacaoSql('h.n_nf', 'i.n_cod_prod');
    expect(sql).toContain('m.nota_fiscal = h.n_nf');
    expect(sql).toContain('m.produto_codigo_acxe = i.n_cod_prod');
  });

  it('legado permanece SEMPRE por NF (tabela sem coluna de produto)', () => {
    const sql = recebidaViaLegadoSql('h.n_nf');
    expect(sql).toContain('movimentacao_legado');
    expect(sql).not.toContain('produto_codigo_acxe');
  });
});

describe('produtoPendenteSql — combinação das 3 fontes (T004)', () => {
  const sql = produtoPendenteSql({
    nfExpr: "LPAD(f.nf_filhote, 8, '0')",
    produtoExpr: 'i.n_cod_prod',
    nIdRecebExpr: 'h.n_id_receb',
  });

  it('OMIE (n_id_receb) por NF, com COALESCE para header ausente', () => {
    expect(sql).toContain('COALESCE(h.n_id_receb, 0) > 0');
  });

  it('legado por NF; Atlas por PRODUTO', () => {
    expect(sql).toContain('movimentacao_legado');
    expect(sql).toContain('m.produto_codigo_acxe = i.n_cod_prod');
  });

  it('é uma negação (pendente = NOT recebido em nenhuma fonte)', () => {
    expect(sql.trimStart().startsWith('NOT (')).toBe(true);
  });
});

// ── Parte 2: SQLs dos cockpits usam o filtro por produto ────────────────────

const sqlsExecutados: string[] = [];

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getPool: () => ({
    query: (sql: string, _params?: unknown[]) => {
      sqlsExecutados.push(sql);
      // colunaCanceladaExiste consulta information_schema — responde true.
      if (typeof sql === 'string' && sql.includes('information_schema')) {
        return Promise.resolve({ rows: [{ ok: true }] });
      }
      return Promise.resolve({ rows: [] });
    },
  }),
  getConfig: () => ({
    STOCKBRIDGE_FISCAL_CUTOFF_DATE: '2026-01-01',
    MODULE_STOCKBRIDGE_ENABLED: true,
    APP_URL: 'https://atlas.test',
  }),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  buildEmailLayout: (o: { titulo?: string }) => ({ html: String(o?.titulo ?? ''), text: String(o?.titulo ?? '') }),
  escapeHtml: (v: unknown) => (v == null ? '' : String(v)),
  emailDataList: () => '',
  emailActionBox: (html: string) => html,
  cached: (_key: string, _ttl: number, fn: () => unknown) => fn(),
  invalidate: vi.fn(),
}));

vi.mock('@atlas/db', () => ({
  lote: {},
  movimentacao: {},
  movimentacaoLegado: {},
  aprovacao: {},
  localidade: {},
  localidadeCorrelacao: {},
  users: {},
  userModules: {},
}));

describe('cockpit.service — blocos de filhote recebida por PRODUTO (T012/T016/T017)', () => {
  beforeEach(() => {
    sqlsExecutados.length = 0;
  });

  it('getCockpit: os 2 blocos "recebida" e a Parte B filtram por produto', async () => {
    const { getCockpit } = await import('../services/cockpit.service.js');
    await getCockpit({});

    const sqlCockpit = sqlsExecutados.find((s) => s.includes('transito_recebido_filhotes'));
    expect(sqlCockpit).toBeDefined();
    // Bloco 1 (transito_recebido_filhotes) + bloco 2 (Parte A rec) + Parte B:
    // todos os EXISTS de movimentacao com filtro por produto.
    const ocorrencias = (sqlCockpit!.match(/m\.produto_codigo_acxe = i\.n_cod_prod/g) ?? []).length;
    expect(ocorrencias).toBeGreaterThanOrEqual(3);
    // (Legado por NF é garantido pelo unit de recebidaViaLegadoSql acima —
    // a função não aceita produtoExpr.)
  });
});

describe('cockpit-executivo.service — trânsito valorizado por PRODUTO (T013/T018)', () => {
  beforeEach(() => {
    sqlsExecutados.length = 0;
  });

  it('getCockpitExecutivo: o bloco transito_recebido_filhotes filtra por produto', async () => {
    const { getCockpitExecutivo } = await import('../services/cockpit-executivo.service.js');
    await getCockpitExecutivo();

    const sqlTransito = sqlsExecutados.find((s) => s.includes('transito_recebido_filhotes'));
    expect(sqlTransito).toBeDefined();
    expect(sqlTransito).toContain('m.produto_codigo_acxe = i.n_cod_prod');
  });
});

// ── ACXEGDP-183 (Parte A): o critério estendido de "recebida" aceita
// movimentacao E movimentacao_legado — filhote antiga recebida no legado
// (n_id_receb nunca preenchido no OMIE) não pode voltar a contar como
// pendente. Estes testes travam a PRESENÇA do predicado do legado nos SQLs:
// sem eles, remover o `OR recebidaViaLegadoSql(...)` de um consumidor não
// quebraria teste nenhum (o unit do helper continuaria verde). ─────────────

describe('posição fiscal — critério estendido aceita movimentacao_legado (ACXEGDP-183 Parte A)', () => {
  beforeEach(() => {
    sqlsExecutados.length = 0;
  });

  it('getCockpit: os 3 blocos de importação consultam movimentacao_legado além do n_id_receb', async () => {
    const { getCockpit } = await import('../services/cockpit.service.js');
    await getCockpit({});

    const sqlCockpit = sqlsExecutados.find((s) => s.includes('transito_recebido_filhotes'));
    expect(sqlCockpit).toBeDefined();
    // transito_recebido_filhotes + Parte A (rec) + Parte B (fallback):
    const ocorrenciasLegado = (sqlCockpit!.match(/stockbridge\.movimentacao_legado/g) ?? []).length;
    expect(ocorrenciasLegado).toBeGreaterThanOrEqual(3);
    // OMIE segue sendo uma das fontes (OR entre as 3, não substituição).
    expect(sqlCockpit).toContain('n_id_receb > 0');
  });

  it('getCockpitExecutivo: o desconto de filhotes recebidas também aceita o legado', async () => {
    const { getCockpitExecutivo } = await import('../services/cockpit-executivo.service.js');
    await getCockpitExecutivo();

    const sqlTransito = sqlsExecutados.find((s) => s.includes('transito_recebido_filhotes'));
    expect(sqlTransito).toBeDefined();
    expect(sqlTransito).toContain('stockbridge.movimentacao_legado');
  });
});
