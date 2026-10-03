import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Feature 016 (ACXEGDP-395) — fila nacional com DUAS fontes (T019).
// Prova pelo SQL gerado (padrao fila-pendente.test.ts, getPool mockado):
//  - flag desligada: query da 015 (so tbl_nf_header_Q2P), nenhuma tabela nova;
//  - flag ligada: UNION com tbl_recebimentoNFe_Q2P, precedencia da fonte (a),
//    exclusao de dispensa, fiscal_pendente consultando o ledger, mapeamento de
//    colunas da fonte (b) (v_total_item, c_cfop_entrada, c_descricao_produto...).
// Com DUMP_SQL_DIR definido, grava o SQL gerado para EXPLAIN num banco real.

const poolQuerySpy = vi.fn();
const config: Record<string, unknown> = {
  STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE: '2026-09-11',
  STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED: false,
};

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
  getConfig: () => config,
}));

vi.mock('../services/correlacao-produto.service.js', () => ({
  sugerirProdutosEmLote: vi.fn().mockResolvedValue(new Map()),
}));

import {
  getFilaNacional,
  getDetalheNfNacional,
  statusHealthModulo,
  limiteIdadeEspelhoMin,
  idadeEspelhoRecebimentos,
  NfNacionalDispensadaError,
  FilaNacionalIncompletaError,
  FORNECEDOR_NAO_IDENTIFICADO,
  CFOPS_RECEBIMENTO_NACIONAL,
} from '../services/fila-nacional.service.js';

const CHAVE = '35261014555032000753550010000068421827355174';
const DUMP = process.env.DUMP_SQL_DIR;

function dump(nome: string, sql: string) {
  if (!DUMP) return;
  mkdirSync(DUMP, { recursive: true });
  writeFileSync(join(DUMP, nome), sql);
}

interface Chamada {
  sql: string;
  params?: unknown[];
}
const chamadas: Chamada[] = [];
let filaRows: Record<string, unknown>[] = [];
let detalheRows: Record<string, unknown>[] = [];
let dispensaRows: Record<string, unknown>[] = [];

function responder(sql: string) {
  if (sql.includes('information_schema')) return { rows: [{ ok: true }] };
  if (sql.includes('FROM stockbridge.nf_dispensa') && sql.trimStart().startsWith('SELECT dispensado_em')) return { rows: dispensaRows };
  if (sql.includes('WITH nf_unificada') && sql.includes('HAVING COUNT(*) FILTER (WHERE pendente) > 0')) return { rows: filaRows };
  if (sql.includes('WITH nf_unificada')) return { rows: detalheRows };
  return { rows: [] };
}

const sqlFila = () => chamadas.find((c) => c.sql.includes('HAVING COUNT(*) FILTER (WHERE pendente) > 0'))!;
const sqlDetalhe = () => chamadas.find((c) => c.sql.includes('WITH nf_unificada') && !c.sql.includes('HAVING COUNT(*)'))!;

const linhaDetalhe = (over: Record<string, unknown> = {}) => ({
  nf_chave_acesso: CHAVE,
  n_nf: '000006842',
  nota_fiscal: '6842',
  fornecedor_nome: 'REPLAS COMERCIAL LTDA',
  fornecedor_cnpj: '14.555.032/0007-53',
  dt_emissao: '2026-10-01',
  dias_desde_emissao: 1,
  cancelada: false,
  deletada: false,
  fornecedor_excluido: false,
  fiscal_pendente: true,
  n_id_receb: '8510564869', // bigint volta string no pg
  n_cod_item: '1',
  x_prod: 'SUCATA PLASTICO',
  desc_norm: 'SUCATA PLASTICO',
  cfop: '1.102',
  q_com: 18000,
  u_com: 'KG',
  valor_item: 203400,
  recebido: false,
  baixado_externo: false,
  baixa_solicitada: false,
  nf_ja_atribuida_kg: 0,
  conferida_ja_gravada_kg: 0,
  ...over,
});

beforeEach(() => {
  chamadas.length = 0;
  filaRows = [];
  detalheRows = [];
  dispensaRows = [];
  config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = false;
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) => {
    chamadas.push({ sql, params });
    return Promise.resolve(responder(sql));
  });
});

describe('getFilaNacional — flag DESLIGADA (comportamento da 015, FR-020)', () => {
  it('consulta so o espelho de NF: nenhuma tabela da feature 016 no SQL', async () => {
    await getFilaNacional();
    const { sql, params } = sqlFila();
    dump('fila-flag-off.sql', sql);
    expect(sql).toContain('public."tbl_nf_header_Q2P" h');
    expect(sql).toContain('public."tbl_nf_itens_Q2P" i');
    expect(sql).not.toContain('tbl_recebimentoNFe_Q2P');
    expect(sql).not.toContain('tbl_recebimentoNFe_itens_Q2P');
    expect(sql).not.toContain('stockbridge.nf_dispensa');
    expect(sql).not.toContain('stockbridge.recebimento_fiscal');
    expect(sql).not.toContain('UNION ALL');
    // D26: valor do item e v_prod, nunca v_tot_item
    expect(sql).toContain('i.v_prod');
    expect(sql).not.toMatch(/i\.v_tot_item/);
    // mantem recorte, corte e pendencia por item
    expect(sql).toContain('u.cfop = ANY($1::text[])');
    expect(sql).toContain('h.d_emi >= $2::date');
    expect(sql).toContain('HAVING COUNT(*) FILTER (WHERE pendente) > 0');
    expect(sql).toContain('ORDER BY d_emi ASC, n_nf ASC');
    expect(params).toEqual([Array.from(CFOPS_RECEBIMENTO_NACIONAL), '2026-09-11']);
    // diferenca DELIBERADA em relacao a 015, tambem com a flag desligada: a via 2
    // (so o numero da NF) exige lancamento manual a partir da emissao (FILA-2)
    expect(sql).toContain('AND m.created_at >= (u.d_emi)::date');
  });

  it('coluna fiscal e constante: toda NF sai como "concluido" e sem data do Atlas', async () => {
    filaRows = [
      {
        nf_chave_acesso: CHAVE, nota_fiscal: '6842', fornecedor_nome: 'REPLAS COMERCIAL LTDA', fornecedor_cnpj: '14.555.032/0007-53',
        dt_emissao: '2026-10-01', dias_desde_emissao: 1, itens_total: 1, itens_pendentes: 1, valor_total_brl: 203400,
        fiscal: 'concluido', fiscal_concluido_em: null,
      },
    ];
    const fila = await getFilaNacional();
    expect(sqlFila().sql).toContain('NULL::text');
    expect(fila).toHaveLength(1);
    expect(fila[0]).toMatchObject({ notaFiscal: '6842', fiscal: 'concluido', fiscalConcluidoPeloAtlasEm: null, valorTotalBrl: 203400 });
  });
});

describe('getFilaNacional — flag LIGADA (duas fontes, research D8)', () => {
  beforeEach(() => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
  });

  it('une o espelho de NF (a) ao espelho de recebimentos (b) com precedencia de (a)', async () => {
    await getFilaNacional();
    const { sql } = sqlFila();
    dump('fila-flag-on.sql', sql);
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('public."tbl_recebimentoNFe_Q2P" r');
    expect(sql).toContain('public."tbl_recebimentoNFe_itens_Q2P" ri ON ri.n_id_receb = r.n_id_receb');
    // fonte (b): fiscal pendente ELEGIVEL explicito (etapa 40, 'N' explicitos — FILA-7/FISC-5)
    // OU ja concluido pelo Atlas e ainda fora do espelho de NF (janela entre syncs — FILA-1)
    expect(sql).toContain("(r.c_recebido = 'N' AND r.c_cancelada = 'N' AND r.c_etapa = '40'");
    // bloqueado/devolvido no OMIE nao e "fiscal pendente" (o POST recusaria com 422)
    expect(sql).toContain("COALESCE(r.c_bloqueado, 'N') <> 'S' AND COALESCE(r.c_devolvido, 'N') <> 'S'");
    expect(sql).toMatch(/OR EXISTS \(SELECT 1 FROM stockbridge\.recebimento_fiscal rf\s+WHERE rf\.nf_chave_acesso = r\.c_chave_nfe AND rf\.status IN \('concluido', 'ja_concluido'\)\)/);
    expect(sql).not.toContain("COALESCE(r.c_recebido, 'N')");
    // c_cancelada nulo (ramo do ledger) nao pode descartar a NF da fila enquanto o detalhe a mostra
    expect(sql).toContain("COALESCE(r.c_cancelada = 'S', false)                 AS cancelada");
    // precedencia: chave que ja esta no espelho de NF nao entra pela fonte (b)
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM public."tbl_nf_header_Q2P" h2 WHERE h2.c_chave_nfe = r.c_chave_nfe)');
    // corte de data nas duas fontes
    expect(sql).toContain('h.d_emi >= $2::date');
    expect(sql).toContain('r.d_emissao >= $2::date');
  });

  it('mapeia as colunas da fonte (b) para o shape unificado (CFOP de ENTRADA, v_total_item)', async () => {
    await getFilaNacional();
    const { sql } = sqlFila();
    for (const frag of [
      'r.c_numero_nfe AS n_nf',
      'r.c_razao_social AS dest_razao',
      'r.c_cnpj_cpf AS dest_cnpj_cpf',
      'r.d_emissao',
      'ri.n_sequencia::bigint',
      'ri.c_descricao_produto',
      'ri.c_cfop_entrada',
      'ri.n_qtde_nfe',
      'ri.c_unidade_nfe',
      'ri.v_total_item',
    ]) {
      expect(sql, frag).toContain(frag);
    }
    // o CFOP do fornecedor (c_cfop) NAO e usado no recorte
    expect(sql).not.toMatch(/ri\.c_cfop\b[^_]/);
  });

  it('fiscal_pendente consulta o ledger; fonte (a) e sempre fiscal concluido', async () => {
    await getFilaNacional();
    const { sql } = sqlFila();
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM stockbridge.recebimento_fiscal rf\n            WHERE rf.nf_chave_acesso = r.c_chave_nfe AND rf.status IN ('concluido', 'ja_concluido'))  AS fiscal_pendente");
    expect(sql).toContain('false                                                AS fiscal_pendente');
    expect(sql).toContain("CASE WHEN bool_or(fiscal_pendente) THEN 'pendente' ELSE 'concluido' END AS fiscal");
    // data da conclusao pelo Atlas vem do ledger
    expect(sql).toContain('SELECT MAX(rf.finalizado_em) FROM stockbridge.recebimento_fiscal rf');
    // "concluido pelo Atlas" so conta o ledger 'concluido' — 'ja_concluido' e fiscal feito no portal (SPEC016-8)
    expect(sql).toContain("WHERE rf.nf_chave_acesso = c_chave_nfe AND rf.status = 'concluido')::text");
  });

  it('via 2 da checagem "ja recebida" (so o numero da NF) exige lancamento a partir da emissao (colisao de numero entre fornecedores — FILA-2)', async () => {
    await getFilaNacional();
    const { sql } = sqlFila();
    expect(sql).toContain("AND ltrim(m.nota_fiscal, '0') = ltrim(u.n_nf, '0')\n                AND m.created_at >= (u.d_emi)::date)");
  });

  it('itens em ordem NUMERICA nas duas fontes (n_cod_item bigint — FILA-6)', async () => {
    await getFilaNacional();
    const { sql } = sqlFila();
    expect(sql).toContain('i.n_cod_item::bigint');
    expect(sql).toContain('ri.n_sequencia::bigint');
  });

  it('tabela da 0053 ausente (42P01 — flag ligada antes da migration): erro VISIVEL, nunca fila vazia em silencio (MIG-3)', async () => {
    poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) => {
      chamadas.push({ sql, params });
      if (sql.includes('information_schema')) return Promise.resolve({ rows: [{ ok: true }] });
      if (sql.includes('WITH nf_unificada')) return Promise.reject(Object.assign(new Error('relation "stockbridge.recebimento_fiscal" does not exist'), { code: '42P01' }));
      return Promise.resolve({ rows: [] });
    });
    await expect(getFilaNacional()).rejects.toBeInstanceOf(FilaNacionalIncompletaError);
    await expect(getDetalheNfNacional(CHAVE)).rejects.toBeInstanceOf(FilaNacionalIncompletaError);
  });

  it('outro erro de banco continua degradando a fila para [] (informativa)', async () => {
    poolQuerySpy.mockImplementation((sql: string) => {
      if (sql.includes('information_schema')) return Promise.resolve({ rows: [{ ok: true }] });
      return Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    });
    await expect(getFilaNacional()).resolves.toEqual([]);
  });

  it('exclui NF com dispensa ATIVA sobre a fonte unificada (vale para as duas fontes)', async () => {
    await getFilaNacional();
    const { sql } = sqlFila();
    expect(sql).toContain('SELECT 1 FROM stockbridge.nf_dispensa d');
    expect(sql).toContain('WHERE d.nf_chave_acesso = u.c_chave_nfe AND d.revertido_em IS NULL');
    // a clausula esta no WHERE da CTE `linhas`, que le de nf_unificada (a UNION b)
    const idxDispensa = sql.indexOf('stockbridge.nf_dispensa d');
    const idxFrom = sql.indexOf('FROM nf_unificada u');
    expect(idxDispensa).toBeGreaterThan(idxFrom);
  });

  it('mapeia fiscal pendente/concluido, data do Atlas e fornecedor nulo da fonte (b)', async () => {
    filaRows = [
      {
        nf_chave_acesso: CHAVE, nota_fiscal: '6842', fornecedor_nome: null, fornecedor_cnpj: null,
        dt_emissao: '2026-10-01', dias_desde_emissao: 1, itens_total: 1, itens_pendentes: 1, valor_total_brl: 203400,
        fiscal: 'pendente', fiscal_concluido_em: null,
      },
      {
        nf_chave_acesso: '3'.repeat(44), nota_fiscal: '7000', fornecedor_nome: 'ZARAPLAST', fornecedor_cnpj: '00.000.000/0001-00',
        dt_emissao: '2026-09-30', dias_desde_emissao: 2, itens_total: 2, itens_pendentes: 1, valor_total_brl: 1000,
        fiscal: 'concluido', fiscal_concluido_em: '2026-10-02 10:15:00+00',
      },
    ];
    const fila = await getFilaNacional();
    expect(fila[0]).toMatchObject({ fiscal: 'pendente', fiscalConcluidoPeloAtlasEm: null, fornecedorNome: FORNECEDOR_NAO_IDENTIFICADO, fornecedorCnpj: '' });
    expect(fila[1]!.fiscal).toBe('concluido');
    expect(fila[1]!.fiscalConcluidoPeloAtlasEm).toBe(new Date('2026-10-02 10:15:00+00').toISOString());
  });

  it('filtros q/fornecedor seguem sobre a fonte unificada', async () => {
    await getFilaNacional({ q: '6842', fornecedor: 'replas' });
    const { sql, params } = sqlFila();
    expect(sql).toContain("ltrim(u.n_nf, '0') ILIKE $4");
    expect(sql).toContain('u.dest_cnpj_cpf ILIKE $3 OR u.dest_razao ILIKE $3');
    expect(params).toEqual([Array.from(CFOPS_RECEBIMENTO_NACIONAL), '2026-09-11', '%replas%', '%6842%']);
  });
});

describe('getDetalheNfNacional — feature 016', () => {
  it('flag desligada: fiscal "concluido", dispensavel false, nenhuma consulta a nf_dispensa', async () => {
    detalheRows = [linhaDetalhe({ fiscal_pendente: false, n_id_receb: '123' })];
    const d = await getDetalheNfNacional(CHAVE);
    dump('detalhe-flag-off.sql', sqlDetalhe().sql);
    expect(d.fiscal).toBe('concluido');
    expect(d.nIdReceb).toBe(123);
    expect(d.dispensavel).toBe(false);
    expect(sqlDetalhe().sql).not.toContain('tbl_recebimentoNFe_Q2P');
    expect(chamadas.some((c) => c.sql.includes('FROM stockbridge.nf_dispensa'))).toBe(false);
    expect(d.itens).toHaveLength(1);
    expect(d.itens[0]!.quantidadeNfKg).toBe(18000);
  });

  it('detalhe ordena os itens pelo codigo NUMERICO (ORDER BY u.n_cod_item sobre bigint)', async () => {
    detalheRows = [linhaDetalhe()];
    await getDetalheNfNacional(CHAVE);
    expect(sqlDetalhe().sql).toContain('ORDER BY u.n_cod_item');
    expect(sqlDetalhe().sql).toContain('i.n_cod_item::bigint');
  });

  it('flag ligada: NF so na fonte (b) sai com fiscal pendente, nIdReceb numerico e dispensavel', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [linhaDetalhe()];
    const d = await getDetalheNfNacional(CHAVE);
    dump('detalhe-flag-on.sql', sqlDetalhe().sql);
    expect(sqlDetalhe().sql).toContain('UNION ALL');
    expect(sqlDetalhe().params).toEqual([CHAVE, '2026-09-11']);
    expect(d).toMatchObject({ notaFiscal: '6842', fiscal: 'pendente', nIdReceb: 8510564869, dispensavel: true, fornecedorNome: 'REPLAS COMERCIAL LTDA' });
    expect(d.itens[0]).toMatchObject({ descricaoFornecedor: 'SUCATA PLASTICO', cfop: '1.102', jaRecebido: false });
  });

  it('flag ligada: fornecedor nulo (nao cadastrado no OMIE) vira rotulo e CNPJ vazio', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [linhaDetalhe({ fornecedor_nome: null, fornecedor_cnpj: null })];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.fornecedorNome).toBe(FORNECEDOR_NAO_IDENTIFICADO);
    expect(d.fornecedorCnpj).toBe('');
    // sem CNPJ nao ha como sugerir correlacao — segue sem pre-selecao
    expect(d.itens[0]!.produtosSugeridos).toEqual([]);
  });

  it('flag ligada: item todo recebido nao e dispensavel; NF dispensada e recusada com a data', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [linhaDetalhe({ fiscal_pendente: false, recebido: true, nf_ja_atribuida_kg: 18000, conferida_ja_gravada_kg: 18000 })];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.fiscal).toBe('concluido');
    expect(d.dispensavel).toBe(false);

    dispensaRows = [{ dispensado_em: '2026-10-02 09:00:00+00' }];
    detalheRows = [linhaDetalhe()];
    await expect(getDetalheNfNacional(CHAVE)).rejects.toBeInstanceOf(NfNacionalDispensadaError);
    await expect(getDetalheNfNacional(CHAVE)).rejects.toThrow(/NF 6842 foi dispensada da fila pelo gestor em 02\/10\/2026.*desfazer a dispensa em Aprovações/);
  });

  it('valorNotaBrl soma TODAS as linhas (inclusive fora do recorte); valorTotalBrl so as do recorte (SPEC016-7)', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [linhaDetalhe(), linhaDetalhe({ n_cod_item: '2', x_prod: 'EMBALAGEM', desc_norm: 'EMBALAGEM', cfop: '1.556', valor_item: 6600, q_com: 10, u_com: 'UN' })];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.valorTotalBrl).toBe(203400);
    expect(d.valorNotaBrl).toBe(210000);
    expect(d.linhasForaDoRecorte).toBe(1);
  });
});

describe('health do espelho de recebimentos (revisao pre-UAT, ROT-6)', () => {
  it('statusHealthModulo: degraded para espelho velho, vazio ou inacessivel; ok para ok/desligado', () => {
    expect(statusHealthModulo({ idadeMin: 300, status: 'degraded' })).toBe('degraded');
    expect(statusHealthModulo({ idadeMin: null, status: 'sem_dados' })).toBe('degraded');
    expect(statusHealthModulo({ idadeMin: null, status: 'indisponivel' })).toBe('degraded');
    expect(statusHealthModulo({ idadeMin: 10, status: 'ok' })).toBe('ok');
    expect(statusHealthModulo({ idadeMin: null, status: 'desligado' })).toBe('ok');
  });

  it('limite configuravel (STOCKBRIDGE_ESPELHO_RECEBIMENTOS_MAX_MIN, default 120) decide ok x degraded', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    expect(limiteIdadeEspelhoMin()).toBe(120);
    poolQuerySpy.mockImplementation(() => Promise.resolve({ rows: [{ idade_min: '200.0' }] }));
    expect(await idadeEspelhoRecebimentos()).toEqual({ idadeMin: 200, status: 'degraded', limiteMin: 120 });
    config.STOCKBRIDGE_ESPELHO_RECEBIMENTOS_MAX_MIN = 360;
    expect(await idadeEspelhoRecebimentos()).toEqual({ idadeMin: 200, status: 'ok', limiteMin: 360 });
    delete config.STOCKBRIDGE_ESPELHO_RECEBIMENTOS_MAX_MIN;
    poolQuerySpy.mockImplementation(() => Promise.resolve({ rows: [{ idade_min: null }] }));
    expect((await idadeEspelhoRecebimentos()).status).toBe('sem_dados');
    poolQuerySpy.mockImplementation(() => Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' })));
    expect((await idadeEspelhoRecebimentos()).status).toBe('indisponivel');
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = false;
    expect(await idadeEspelhoRecebimentos()).toEqual({ idadeMin: null, status: 'desligado' });
  });
});
