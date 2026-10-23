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
  montarDetalheNfNacional,
  statusHealthModulo,
  limiteIdadeEspelhoMin,
  idadeEspelhoRecebimentos,
  NfNacionalDispensadaError,
  FilaNacionalIncompletaError,
  FORNECEDOR_NAO_IDENTIFICADO,
  CFOPS_RECEBIMENTO_NACIONAL,
  itemNfPendente,
  kgXmlComparavel,
  restantePendenciaKg,
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
    // 017 (FR-021/021a): a fonte (a) le o espelho de recebimentos SO por chave +
    // sequencia (vinculo com o PC e estoque ja lancado), tambem com a chave desligada.
    // A fonte (b) "fiscal pendente" continua fora: sem c_recebido = 'N' e sem UNION ALL.
    expect(sql).toContain('ri.n_sequencia = a.n_seq');
    expect(sql).not.toContain("r.c_recebido = 'N'");
    // a dispensa ativa vale com a chave desligada (achado fila-v01: a contencao da 017 trazia de
    // volta a fila NFs dispensadas — 6936/6937 em PROD, cujo fisico ja entrou pela NF 6923)
    expect(sql).toContain('stockbridge.nf_dispensa');
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

  it('coluna da 0055 ausente (42703 — imagem nova antes da migration, ACXEGDP-412): erro VISIVEL tambem com a flag desligada', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = false;
    poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) => {
      chamadas.push({ sql, params });
      if (sql.includes('information_schema')) return Promise.resolve({ rows: [{ ok: true }] });
      if (sql.includes('WITH nf_unificada')) return Promise.reject(Object.assign(new Error('column m.nf_item_sequencias does not exist'), { code: '42703' }));
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
  it('flag desligada: fiscal "concluido", dispensavel false (criar dispensa exige a chave), mas a dispensa ativa e consultada', async () => {
    detalheRows = [linhaDetalhe({ fiscal_pendente: false, n_id_receb: '123' })];
    const d = await getDetalheNfNacional(CHAVE);
    dump('detalhe-flag-off.sql', sqlDetalhe().sql);
    expect(d.fiscal).toBe('concluido');
    expect(d.nIdReceb).toBe(123);
    expect(d.dispensavel).toBe(false);
    // 017: o espelho de recebimentos entra so pela fonte (a) (vinculo/estoque); sem a fonte (b)
    expect(sqlDetalhe().sql).not.toContain('UNION ALL');
    expect(sqlDetalhe().sql).not.toContain("r.c_recebido = 'N'");
    expect(d.copiaPcsDefasada).toBe(false);
    expect(d.estoqueLancadoPeloOmie).toBe(false);
    expect(d.itens[0]!.pc).toBeNull();
    expect(chamadas.some((c) => c.sql.includes('FROM stockbridge.nf_dispensa'))).toBe(true);
    expect(d.itens).toHaveLength(1);
    expect(d.itens[0]!.quantidadeNfKg).toBe(18000);
  });


  it('flag desligada com dispensa ATIVA: o detalhe recusa (NF_DISPENSADA) — a contencao nao traz a NF de volta (achado fila-v01)', async () => {
    detalheRows = [linhaDetalhe({ fiscal_pendente: false })];
    dispensaRows = [{ dispensado_em: '2026-10-07 16:09:23-03' }];
    await expect(getDetalheNfNacional(CHAVE)).rejects.toBeInstanceOf(NfNacionalDispensadaError);
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

// ACXEGDP-412 (NF 36624, 06/10/2026): com o item pre-associado a um produto no
// OMIE, a fonte (b) trazia a descricao do PRODUTO e, depois do fiscal, as duas
// fontes passaram a trazer a do XML — o item recebido voltou inteiro a fila.
// A movimentacao passa a casar tambem pela sequencia do item no recebimento.
describe('identidade do item pela sequencia no recebimento (ACXEGDP-412)', () => {
  it('flag ligada: fonte (b) expoe ri.n_sequencia; fonte (a) liga o item pelo n_id_item e, so na janela entre syncs, pela ordem', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    await getFilaNacional();
    const { sql } = sqlFila();
    dump('fila-412.sql', sql);
    expect(sql).toContain('ri.n_sequencia::int                                  AS n_seq');
    // (a): ligacao exata pelo id do item (n_id_item do recebimento = n_cod_item da NF)
    expect(sql).toContain('MAX(ri.n_sequencia) FILTER (WHERE ri.n_id_item = i.n_cod_item)');
    expect(sql).toContain('WHERE r.c_chave_nfe = h.c_chave_nfe)');
    // ordem so quando o recebimento existe e ainda nao tem nenhum n_id_item (espelho de recebimentos atrasado)
    expect(sql).toContain('CASE WHEN COUNT(*) > 0 AND COUNT(*) FILTER (WHERE COALESCE(ri.n_id_item, 0) <> 0) = 0');
    expect(sql).toContain('i2.n_id_nf = i.n_id_nf AND i2.n_cod_item <= i.n_cod_item');
  });

  it('flag ligada: "ja recebido" e o restante atribuido casam por descricao OU sequencia', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    await getFilaNacional();
    const { sql } = sqlFila();
    const casamento = `(m.nf_item_descricao_normalizada = ${'upper(regexp_replace(btrim(unaccent(u.x_prod)), \'\\s+\', \' \', \'g\'))'} OR u.n_seq = ANY(m.nf_item_sequencias))`;
    // via 1 (recebido) + nf_atribuida
    expect(sql.split(casamento).length - 1).toBe(2);
  });

  it('flag desligada (017): fonte (a) calcula a sequencia e le o vinculo no espelho de recebimentos, sem a fonte (b)', async () => {
    await getFilaNacional();
    const { sql } = sqlFila();
    expect(sql).not.toContain('NULL::int  AS n_seq');
    expect(sql).toContain('ri.n_id_item = i.n_cod_item');
    expect(sql).toContain('ri.n_sequencia = a.n_seq');
    expect(sql).not.toContain('UNION ALL');
  });

  it('detalhe: somas do item casam pela sequencia tambem e o item carrega as sequencias das linhas', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [
      linhaDetalhe({ n_cod_item: '1', n_seq: 1, x_prod: 'SUCATA DE PP', desc_norm: 'SUCATA DE PP', q_com: 3000 }),
      linhaDetalhe({ n_cod_item: '3', n_seq: '3', x_prod: 'SUCATA DE PP', desc_norm: 'SUCATA DE PP', q_com: 3128 }),
      linhaDetalhe({ n_cod_item: '2', n_seq: null, x_prod: 'SUCATA PE', desc_norm: 'SUCATA PE' }),
    ];
    const d = await getDetalheNfNacional(CHAVE);
    const { sql } = sqlDetalhe();
    dump('detalhe-412.sql', sql);
    expect(sql).toContain('u.n_seq                                          AS n_seq');
    // nf_ja_atribuida_kg + conferida_ja_gravada_kg + via 1
    expect(sql.split('u.n_seq = ANY(m.nf_item_sequencias)').length - 1).toBe(3);
    expect(d.itens.find((i) => i.descricaoNormalizada === 'SUCATA DE PP')!.sequenciasRecebimento).toEqual([1, 3]);
    expect(d.itens.find((i) => i.descricaoNormalizada === 'SUCATA PE')!.sequenciasRecebimento).toEqual([]);
  });

  it('detalhe: NF 36624 depois do fiscal — descricao nova, mas a sequencia casa: item recebido e sem restante', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    // O banco ja devolve recebido/somas pela sequencia; aqui o que importa e o item NAO voltar pendente.
    detalheRows = [
      linhaDetalhe({
        fiscal_pendente: false, n_seq: 1, q_com: 6128, valor_item: 49024,
        x_prod: 'SUCATA DE PLASTICO   -   POS CONSUMO', desc_norm: 'SUCATA DE PLASTICO - POS CONSUMO',
        recebido: true, nf_ja_atribuida_kg: 6128, conferida_ja_gravada_kg: 6078,
      }),
    ];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.itens[0]).toMatchObject({ jaRecebido: true, quantidadeRestanteKg: 0, sequenciasRecebimento: [1] });
    expect(d.dispensavel).toBe(false);
  });
});

// NF 67988 (Isoforma, 23/10/2026): recebida pelo Atlas com 13.500 kg conferidos de uma NF de 13.382 kg; depois o fiscal
// editou a quantidade RECEBIDA para 13.500 no portal e o OMIE refez a nota de entrada com 13.500 — o item voltou a fila com
// 118 kg "pendentes". A nota de entrada traz a quantidade RECEBIDA; o XML vem do espelho de recebimentos.
describe('quantidade recebida editada no portal (NF 67988): pendencia pelas duas quantidades oficiais (nota de entrada e XML)', () => {
  it('fila: as duas fontes expoem a quantidade e a unidade do XML, e a pendencia usa as duas quantidades', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    await getFilaNacional();
    const { sql } = sqlFila();
    expect(sql).toContain('rv.n_qtde_nfe                                        AS q_com_xml');
    expect(sql).toContain('rv.c_unidade_nfe                                     AS u_com_xml');
    expect(sql).toContain('ri.n_qtde_nfe                                        AS q_com_xml');
    expect(sql).toContain('ri.c_unidade_nfe                                     AS u_com_xml');
    // a via do XML so usa o XML na faixa comparavel (metade a dobro da nota de entrada); fora dela, a nota de entrada
    expect(sql).toMatch(/CASE WHEN \(u\.q_com_xml \* CASE upper\(btrim\(u\.u_com_xml\)\)[^;]*BETWEEN \(u\.q_com \* CASE upper\(btrim\(u\.u_com\)\)[^;]*\* 0\.5 AND [^;]*\* 2 THEN \(u\.q_com_xml[^;]*ELSE \(u\.q_com[^;]*END AS nf_kg_xml/);
    expect(sql).toContain('SUM(nf_kg_xml)');
    // restante = menor distancia para cima ate uma quantidade oficial ainda nao atingida
    expect(sql).toContain('CASE WHEN nf_kg >= nf_atribuida - 1 THEN nf_kg - nf_atribuida END');
    expect(sql).toContain('CASE WHEN nf_kg_xml >= nf_atribuida - 1 THEN nf_kg_xml - nf_atribuida END');
    expect(sql).not.toContain('nf_atribuida < nf_kg - 1');
  });

  it('fila com a chave da 016 desligada: so a fonte (a), que tambem le o XML pelo recebimento casado', async () => {
    await getFilaNacional();
    const { sql } = sqlFila();
    expect(sql).not.toContain('UNION ALL');
    expect(sql).toContain('rv.n_qtde_nfe                                        AS q_com_xml');
    expect(sql).toContain('AS nf_kg_xml');
  });

  it('detalhe: item recebido com 13.382 kg (o XML) e nota de entrada com 13.500 kg — sem restante, fora da pendencia', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [
      linhaDetalhe({
        fiscal_pendente: false, n_seq: 1, x_prod: 'PS CRISTAL B', desc_norm: 'PS CRISTAL B', q_com: 13500, q_com_xml: 13382, u_com_xml: 'KG',
        valor_item: 152554.8, recebido: true, nf_ja_atribuida_kg: 13382, conferida_ja_gravada_kg: 13500,
      }),
    ];
    const d = await getDetalheNfNacional(CHAVE);
    const { sql } = sqlDetalhe();
    expect(sql).toContain('u.q_com_xml::float8                              AS q_com_xml');
    expect(sql).toContain('u.u_com_xml                                      AS u_com_xml');
    expect(d.itens[0]).toMatchObject({ jaRecebido: true, quantidadeNfKg: 13500, quantidadeNfJaAtribuidaKg: 13382, quantidadeRestanteKg: 0 });
    expect(itemNfPendente(d.itens[0]!)).toBe(false);
  });

  it('detalhe: sem o XML no espelho vale a nota de entrada, como antes — a diferenca segue pendente', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [
      linhaDetalhe({
        fiscal_pendente: false, n_seq: null, x_prod: 'PS CRISTAL B', desc_norm: 'PS CRISTAL B', q_com: 13500, q_com_xml: null, u_com_xml: null,
        valor_item: 152554.8, recebido: true, nf_ja_atribuida_kg: 13382, conferida_ja_gravada_kg: 13500,
      }),
    ];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.itens[0]).toMatchObject({ jaRecebido: true, quantidadeRestanteKg: 118 });
    expect(itemNfPendente(d.itens[0]!)).toBe(true);
  });

  it('kgXmlComparavel: o XML na faixa comparavel, linha a linha, com a unidade de cada uma; fora dela, a nota de entrada', () => {
    expect(kgXmlComparavel([{ q_com: 13500, q_com_xml: 13382, u_com_xml: 'KG' }], 1)).toBe(13382);
    expect(kgXmlComparavel([{ q_com: 24700.005, q_com_xml: 24750, u_com_xml: 'KG' }], 1)).toBe(24750);
    // XML em toneladas (TL) e nota de entrada em kg (NF 60199): 8,25 TL = 8.250 kg
    expect(kgXmlComparavel([{ q_com: 8250, q_com_xml: 8.25, u_com_xml: ' tl ' }], 1)).toBe(8250);
    // sem XML, XML vazio ou unidade fora da tabela: a nota de entrada
    expect(kgXmlComparavel([{ q_com: 13500, q_com_xml: null, u_com_xml: null }], 1)).toBe(13500);
    expect(kgXmlComparavel([{ q_com: 13500, q_com_xml: '', u_com_xml: 'KG' }], 1)).toBe(13500);
    expect(kgXmlComparavel([{ q_com: 13500, q_com_xml: 13382, u_com_xml: 'SC' }], 1)).toBe(13500);
    // XML em toneladas rotulado KG (1,375) contra 1.375 kg na nota de entrada: unidade trocada, vale a nota de entrada
    expect(kgXmlComparavel([{ q_com: 1375, q_com_xml: 1.375, u_com_xml: 'KG' }], 1)).toBe(1375);
    // bordas da faixa: metade e dobro entram; logo fora, nao
    expect(kgXmlComparavel([{ q_com: 1000, q_com_xml: 500, u_com_xml: 'KG' }], 1)).toBe(500);
    expect(kgXmlComparavel([{ q_com: 1000, q_com_xml: 2000, u_com_xml: 'KG' }], 1)).toBe(2000);
    expect(kgXmlComparavel([{ q_com: 1000, q_com_xml: 499, u_com_xml: 'KG' }], 1)).toBe(1000);
    // cada linha decide a sua; fator da nota de entrada vem da conversao (TON)
    expect(kgXmlComparavel([{ q_com: 3000, q_com_xml: 2900, u_com_xml: 'KG' }, { q_com: '3000', q_com_xml: '3100', u_com_xml: 'KG' }], 1)).toBe(6000);
    expect(kgXmlComparavel([{ q_com: 8.25 }], 1000)).toBe(8250);
  });

  it('restantePendenciaKg: menor distancia, para cima, ate a quantidade oficial ainda nao atingida (tolerancia 1 kg)', () => {
    // NF 67988: o Atlas atribuiu o XML (13.382) e a nota de entrada foi editada para 13.500 depois: recebido
    expect(restantePendenciaKg(13500, 13382, 13382)).toBe(0);
    // revisao de 23/10 (achado da fila): nota de entrada editada para mais ANTES do fisico, gravacao parcial
    // ancorada nela (13.400 de 13.500): o restante continua 100, nao some atras do XML menor
    expect(restantePendenciaKg(13500, 13382, 13400)).toBe(100);
    // ancorada no XML (fonte "fiscal pendente") e gravacao parcial: o restante e o do XML
    expect(restantePendenciaKg(13500, 13382, 13282)).toBe(100);
    // completo pela nota de entrada; dentro da tolerancia; acima das duas
    expect(restantePendenciaKg(13500, 13382, 13500)).toBe(0);
    expect(restantePendenciaKg(13500, 13382, 13499.5)).toBe(0.5);
    expect(restantePendenciaKg(13500, 13382, 14000)).toBe(0);
    // sem XML (as duas iguais): a regra de antes
    expect(restantePendenciaKg(13500, 13500, 13382)).toBe(118);
    expect(restantePendenciaKg(13500, 13500, 0)).toBe(13500);
  });

  it('detalhe: gravacao parcial com XML de unidade trocada continua pendente pelo restante da nota de entrada', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [
      linhaDetalhe({
        fiscal_pendente: false, n_seq: 1, q_com: 1375, q_com_xml: 1.375, u_com_xml: 'KG', valor_item: 9625,
        recebido: true, nf_ja_atribuida_kg: 600, conferida_ja_gravada_kg: 600,
      }),
    ];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.itens[0]).toMatchObject({ quantidadeRestanteKg: 775 });
    expect(itemNfPendente(d.itens[0]!)).toBe(true);
  });

  it('detalhe: nota de entrada editada para mais antes do fisico e gravacao parcial (13.400 de 13.500): faltam 100 kg, segue pendente', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [
      linhaDetalhe({
        fiscal_pendente: false, n_seq: 1, x_prod: 'PS CRISTAL B', desc_norm: 'PS CRISTAL B', q_com: 13500, q_com_xml: 13382, u_com_xml: 'KG',
        valor_item: 152554.8, recebido: true, nf_ja_atribuida_kg: 13400, conferida_ja_gravada_kg: 13400,
      }),
    ];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.itens[0]).toMatchObject({ quantidadeRestanteKg: 100 });
    expect(itemNfPendente(d.itens[0]!)).toBe(true);
  });
});

// ── Feature 017 (ACXEGDP-437), T021 — vinculo com o pedido de compra na fila e no detalhe ──
describe('017 — pedido de compra na fila e no detalhe', () => {
  const PC_ROWS = [
    {
      ncodped: '8516905979', ncoditem: '8516907022', cnumero: '304', cetapa: '15', ncodfor: '1111', nqtde: 18000, nqtderec: 0, nvalunit: 11.3,
      cunidade: 'KG', ddtprevisao: '2026-10-20', cdescricao: 'PS CRISTAL B', cproduto: 'PSCB', atualizado_ms: Date.now() - 60_000,
      valor_total_pc: 203400, fornecedor_acxe: false,
    },
  ];
  let idadeCopiaMin: number | null = 5;
  let pcFilaRows: Record<string, unknown>[] = [];
  let numerosRows: Record<string, unknown>[] = [];
  let ledgerPcRows: Record<string, unknown>[] = [];
  let pcRows: Record<string, unknown>[] = PC_ROWS;

  const linhaPc = (over: Record<string, unknown> = {}) =>
    linhaDetalhe({
      preco_comercial: 11.3, fornecedor_codigo: '1111', n_seq: 1, n_id_pedido: null, n_id_it_pedido: null, n_num_ped_compra: null,
      c_ignorar_item: 'N', c_nao_gerar_mov_estoque: 'N', receb_recebido: 'N', ledger_concluido: false, ...over,
    });

  beforeEach(() => {
    delete config.STOCKBRIDGE_PC_UNIDADE_DIFERENTE; // o modo da trava de unidade nao vaza entre testes
    idadeCopiaMin = 5;
    pcFilaRows = [];
    numerosRows = [];
    ledgerPcRows = [];
    pcRows = PC_ROWS;
    poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) => {
      chamadas.push({ sql, params });
      if (sql.includes('MAX(data_atualizacao)')) return Promise.resolve({ rows: [{ idade_min: idadeCopiaMin }] });
      if (sql.includes('MAX(synced_at)')) return Promise.resolve({ rows: [{ idade_min: 5 }] });
      if (sql.includes('FROM public."tbl_pedidosCompras_Q2P" pc')) return Promise.resolve({ rows: pcRows });
      if (sql.includes('UNION ALL') && sql.includes('pc_numero')) return Promise.resolve({ rows: numerosRows });
      if (sql.includes('JOIN stockbridge.recebimento_fiscal rf')) return Promise.resolve({ rows: ledgerPcRows });
      if (sql.includes('FROM stockbridge.recebimento_fiscal_pc')) return Promise.resolve({ rows: [] });
      if (sql.includes('u.c_chave_nfe = ANY($3::text[])')) return Promise.resolve({ rows: pcFilaRows });
      return Promise.resolve(responder(sql));
    });
  });

  it('as duas fontes levam o vinculo com o PC, o preco comercial e o c_recebido do recebimento (T017)', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    await getFilaNacional();
    const { sql } = sqlFila();
    // fonte (a): vinculo por chave + sequencia no espelho de recebimentos, preco v_un_com (sem tributos)
    expect(sql).toContain('ri.n_sequencia = a.n_seq');
    expect(sql).toContain('CASE WHEN COALESCE(rv.n_id_pedido, 0) > 0 THEN rv.n_id_pedido END');
    expect(sql).toContain('i.v_un_com                                           AS preco_comercial');
    expect(sql).toContain('rv.c_recebido                                        AS receb_recebido');
    // fonte (b): direto do item do recebimento, com o fornecedor do OMIE
    expect(sql).toContain('CASE WHEN COALESCE(ri.n_id_pedido, 0) > 0 THEN ri.n_id_it_pedido END');
    expect(sql).toContain('ri.n_preco_unit                                      AS preco_comercial');
    expect(sql).toContain('NULLIF(r.n_id_fornecedor, 0)                         AS fornecedor_codigo');
    // estoque ja lancado (D7), so entre os itens pendentes
    expect(sql).toContain("(u.receb_recebido = 'S' AND u.c_ignorar_item = 'N' AND u.c_nao_gerar_mov_estoque = 'N') AS estoque_lancado");
    expect(sql).toContain('COALESCE(bool_or(estoque_lancado) FILTER (WHERE pendente), false) AS estoque_lancado');
  });

  it('pcSituacao por NF: so com fiscal pendente; vinculo do OMIE valido -> vinculado_omie; fiscal ja feito -> nao_aplicavel', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    const CHAVE_B = CHAVE.replace(/4$/, '5');
    filaRows = [
      { nf_chave_acesso: CHAVE, nota_fiscal: '7813', fornecedor_nome: 'REPLAS', fornecedor_cnpj: 'x', dt_emissao: '2026-10-20', dias_desde_emissao: 1, itens_total: 1, itens_pendentes: 1, valor_total_brl: 203400, fiscal: 'pendente', fiscal_concluido_em: null, estoque_lancado: false },
      { nf_chave_acesso: CHAVE_B, nota_fiscal: '7736', fornecedor_nome: 'REPLAS', fornecedor_cnpj: 'x', dt_emissao: '2026-10-20', dias_desde_emissao: 1, itens_total: 1, itens_pendentes: 1, valor_total_brl: 151872, fiscal: 'concluido', fiscal_concluido_em: null, estoque_lancado: true },
    ];
    pcFilaRows = [
      { c_chave_nfe: CHAVE, x_prod: 'SUCATA PLASTICO', desc_norm: 'SUCATA PLASTICO', q_com: 18000, u_com: 'KG', valor_item: 203400, preco_comercial: 11.3,
        n_seq: 1, n_id_pedido: '8516905979', n_id_it_pedido: '8516907022', n_num_ped_compra: '304', fornecedor_codigo: '1111', recebido: false },
    ];
    const fila = await getFilaNacional();
    expect(fila.find((f) => f.notaFiscal === '7813')).toMatchObject({ pcSituacao: 'vinculado_omie', empresa: 'q2p', estoqueLancadoPeloOmie: false });
    expect(fila.find((f) => f.notaFiscal === '7736')).toMatchObject({ pcSituacao: 'nao_aplicavel', estoqueLancadoPeloOmie: true });
    // a consulta de itens so pede as NFs com fiscal pendente
    const itensSql = chamadas.find((c) => c.sql.includes('u.c_chave_nfe = ANY($3::text[])'))!;
    expect(itensSql.params![2]).toEqual([CHAVE]);
  });

  it('copia de PCs defasada: pcSituacao nao_aplicavel (a fila nao decide nada — D13)', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    idadeCopiaMin = 500;
    filaRows = [
      { nf_chave_acesso: CHAVE, nota_fiscal: '7813', fornecedor_nome: 'REPLAS', fornecedor_cnpj: 'x', dt_emissao: '2026-10-20', dias_desde_emissao: 1, itens_total: 1, itens_pendentes: 1, valor_total_brl: 203400, fiscal: 'pendente', fiscal_concluido_em: null, estoque_lancado: false },
    ];
    const [f] = await getFilaNacional();
    expect(f!.pcSituacao).toBe('nao_aplicavel');
    expect(chamadas.some((c) => c.sql.includes('u.c_chave_nfe = ANY($3::text[])'))).toBe(false);
  });

  it('detalhe com fiscal pendente: pc por item (vinculo do OMIE pre-selecionado), exigePc e copia em dia', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [linhaPc({ n_id_pedido: '8516905979', n_id_it_pedido: '8516907022', n_num_ped_compra: '304' })];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d).toMatchObject({ empresa: 'q2p', exigePc: true, copiaPcsDefasada: false, estoqueLancadoPeloOmie: false });
    const pc = d.itens[0]!.pc!;
    expect(pc.vinculoOmie).toMatchObject({ pcNumero: '304', saldoKg: 18000, precoUnit: 11.3, dentroTolerancia: true });
    expect(pc.preSelecionado).toEqual({ nCodPed: 8516905979, nCodItem: 8516907022 });
    expect(pc.vinculadoNoOmie).toBeNull();
  });

  it('detalhe com a copia defasada: copiaPcsDefasada true e nada a escolher no item', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    idadeCopiaMin = 500;
    detalheRows = [linhaPc()];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.copiaPcsDefasada).toBe(true);
    expect(d.itens[0]!.pc).toMatchObject({ vinculoOmie: null, candidatos: [], outrosDoFornecedor: [], preSelecionado: null });
    expect(chamadas.some((c) => c.sql.includes('FROM public."tbl_pedidosCompras_Q2P" pc'))).toBe(false);
  });

  it('fiscal ja feito com a chave DESLIGADA: PC vinculado a vista (FR-021), numero pela copia ou pelo ledger', async () => {
    detalheRows = [linhaPc({ fiscal_pendente: false, receb_recebido: 'S', c_nao_gerar_mov_estoque: 'S', n_id_pedido: '8516999999', n_id_it_pedido: '8516999998', n_num_ped_compra: '200001909863465' })];
    numerosRows = [{ ncodped: '8516999999', numero: '999', prio: 2 }];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.itens[0]!.pc).toMatchObject({ vinculadoNoOmie: { pcNumero: '999' }, candidatos: [] });
    expect(d.copiaPcsDefasada).toBe(false);
  });

  // ── PC por NF (22/10/2026): DetalheNfNacional.pcsDaNf ──

  it('detalhe com fiscal pendente: pcsDaNf lista o PC que atende a nota; o vinculo do OMIE vira o PC pre-selecionado da nota', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [linhaPc({ n_id_pedido: '8516905979', n_id_it_pedido: '8516907022', n_num_ped_compra: '304' })];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.pcsDaNf.preSelecionado).toBe(8516905979);
    expect(d.pcsDaNf.pcs).toHaveLength(1);
    expect(d.pcsDaNf.pcs[0]).toMatchObject({ nCodPed: 8516905979, pcNumero: '304', cobreTodos: true, vinculoOmie: true, dentroTolerancia: true, justificativaNecessaria: false });
    expect(d.pcsDaNf.pcs[0]!.itens).toEqual([
      expect.objectContaining({ indice: 0, nCodItem: 8516907022, origem: 'omie', dentroTolerancia: true, justificativaNecessaria: false }),
    ]);
  });

  it('detalhe sem vinculo: o unico candidato dentro da tolerancia e o PC pre-selecionado da nota', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [linhaPc()];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.pcsDaNf.pcs.map((p) => [p.pcNumero, p.cobreTodos, p.vinculoOmie])).toEqual([['304', true, false]]);
    expect(d.pcsDaNf.preSelecionado).toBe(8516905979);
  });

  it('so os itens a receber entram no PC por NF: item ja recebido, com baixa solicitada ou sem unidade convertida fica de fora', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [
      linhaPc(),
      linhaPc({ n_cod_item: '2', x_prod: 'RECEBIDO', desc_norm: 'RECEBIDO', n_seq: 2, recebido: true }),
      linhaPc({ n_cod_item: '3', x_prod: 'BAIXA', desc_norm: 'BAIXA', n_seq: 3, baixa_solicitada: true }),
      linhaPc({ n_cod_item: '4', x_prod: 'TAMPA', desc_norm: 'TAMPA', u_com: 'UN', q_com: 300, valor_item: 900, preco_comercial: 3, n_seq: 4 }),
    ];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.pcsDaNf.pcs).toHaveLength(1);
    expect(d.pcsDaNf.pcs[0]!.itens.map((i) => i.indice)).toEqual([0]);
    expect(d.pcsDaNf.pcs[0]!.cobreTodos).toBe(true);
  });

  it('copia defasada, fiscal ja feito ou chave desligada: pcsDaNf vazio e sem pre-selecao', async () => {
    const vazio = { pcs: [], preSelecionado: null };
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    idadeCopiaMin = 500;
    detalheRows = [linhaPc()];
    expect((await getDetalheNfNacional(CHAVE)).pcsDaNf).toEqual(vazio);
    idadeCopiaMin = 5;
    detalheRows = [linhaPc({ fiscal_pendente: false, receb_recebido: 'S', c_nao_gerar_mov_estoque: 'S' })];
    expect((await getDetalheNfNacional(CHAVE)).pcsDaNf).toEqual(vazio);
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = false;
    detalheRows = [linhaPc()];
    expect((await getDetalheNfNacional(CHAVE)).pcsDaNf).toEqual(vazio);
  });

  // ── Trava de unidade no detalhe e na fila (STOCKBRIDGE_PC_UNIDADE_DIFERENTE) ──

  /** Item da NF em TONELADAS: 18 t (18.000 kg), R$ 11.300 por tonelada = R$ 11,30/kg. O PC da copia (304) e em KG. */
  const itemEmTon = () => linhaPc({ q_com: 18, u_com: 'TON', valor_item: 203400, preco_comercial: 11300 });

  it('detalhe, modo bloquear (padrao): NF em toneladas e PC em kg -> o PC vai para unidadeIncompativel, item sem PC possivel e pcsDaNf vazio', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [itemEmTon()];
    const d = await getDetalheNfNacional(CHAVE);
    const pc = d.itens[0]!.pc!;
    expect(pc.candidatos).toEqual([]);
    expect(pc.unidadeIncompativel.map((c) => [c.pcNumero, c.unidade])).toEqual([['304', 'KG']]);
    expect(pc.unidadeIncompativel[0]!.motivo).toBe('PC em kg e nota em toneladas: o OMIE baixaria o pedido com 18 em vez de 18.000 kg');
    expect(pc.semPcMotivo).toContain('O PC 304 está em kg e a nota em toneladas');
    expect(d.pcsDaNf).toEqual({ pcs: [], preSelecionado: null });
  });

  it("detalhe, modo 'converter': o mesmo PC em kg e candidato e a nota o pre-seleciona", async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    config.STOCKBRIDGE_PC_UNIDADE_DIFERENTE = 'converter';
    detalheRows = [itemEmTon()];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.itens[0]!.pc!.unidadeIncompativel).toEqual([]);
    expect(d.itens[0]!.pc!.candidatos.map((c) => c.pcNumero)).toEqual(['304']);
    expect(d.pcsDaNf.preSelecionado).toBe(8516905979);
  });

  it('detalhe com NF em kg e PC em kg (o caso comum): a trava nao muda nada', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [linhaPc()];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.itens[0]!.pc!.unidadeIncompativel).toEqual([]);
    expect(d.itens[0]!.pc!.candidatos).toHaveLength(1);
  });

  it('fila: pcSituacao da NF em toneladas com PC so em kg e sem_pc no modo bloquear e sugerido no modo converter', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    filaRows = [
      { nf_chave_acesso: CHAVE, nota_fiscal: '7813', fornecedor_nome: 'REPLAS', fornecedor_cnpj: 'x', dt_emissao: '2026-10-20', dias_desde_emissao: 1, itens_total: 1, itens_pendentes: 1, valor_total_brl: 203400, fiscal: 'pendente', fiscal_concluido_em: null, estoque_lancado: false },
    ];
    pcFilaRows = [
      { c_chave_nfe: CHAVE, x_prod: 'SUCATA PLASTICO', desc_norm: 'SUCATA PLASTICO', q_com: 18, u_com: 'TON', valor_item: 203400, preco_comercial: 11300,
        n_seq: 1, n_id_pedido: null, n_id_it_pedido: null, n_num_ped_compra: null, fornecedor_codigo: '1111', recebido: false },
    ];
    expect((await getFilaNacional())[0]!.pcSituacao).toBe('sem_pc');
    config.STOCKBRIDGE_PC_UNIDADE_DIFERENTE = 'converter';
    expect((await getFilaNacional())[0]!.pcSituacao).toBe('sugerido');
  });

  // 0057 (cache de PCs vistos): o PC que saiu da lista de pendentes (ou foi recebido por inteiro) deixa de estar na
  // copia, mas o cache guarda o numero. A consulta unica de `numerosDosPcs` tem 3 fontes, ordenadas por prioridade.
  const PC_VINCULADO = { fiscal_pendente: false, receb_recebido: 'S', c_nao_gerar_mov_estoque: 'S', n_id_pedido: '8516999999', n_id_it_pedido: '8516999998', n_num_ped_compra: '200001909863465' };

  it('fiscal ja feito: o numero do PC vem do cache de PCs vistos (3a fonte) quando nem a copia nem o ledger o tem', async () => {
    detalheRows = [linhaPc(PC_VINCULADO)];
    numerosRows = [{ ncodped: '8516999999', numero: '306', prio: 3 }];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.itens[0]!.pc!.vinculadoNoOmie).toEqual({ pcNumero: '306' });
  });

  it('a consulta de numeros une copia (1), ledger (2) e cache (3) e ordena pela prioridade; o cache e so da Q2P e ignora numero em branco', async () => {
    detalheRows = [linhaPc(PC_VINCULADO)];
    await getDetalheNfNacional(CHAVE);
    const c = chamadas.find((x) => x.sql.includes('UNION ALL') && x.sql.includes('pc_numero'))!;
    const sql = c.sql.replace(/\s+/g, ' ');
    expect(sql).toContain('FROM public."tbl_pedidosCompras_Q2P" WHERE ncodped = ANY($1::bigint[]) GROUP BY ncodped');
    expect(sql).toContain("FROM stockbridge.recebimento_fiscal_pc WHERE n_cod_ped = ANY($1::bigint[]) AND status = 'concluido' GROUP BY n_cod_ped");
    expect(sql).toContain("SELECT n_cod_ped::text, MIN(NULLIF(btrim(pc_numero), '')), 3 FROM stockbridge.pedido_compra_visto WHERE empresa = 'q2p' AND n_cod_ped = ANY($1::bigint[]) GROUP BY n_cod_ped");
    expect(sql).toMatch(/ORDER BY 3$/);
    expect(c.params).toEqual([[8516999999]]);
  });

  it('o mesmo PC em varias fontes: a de menor prioridade (copia) vence o cache, mesmo se o cache vier primeiro nas linhas', async () => {
    detalheRows = [linhaPc(PC_VINCULADO)];
    numerosRows = [
      { ncodped: '8516999999', numero: '1', prio: 1 },
      { ncodped: '8516999999', numero: '2', prio: 2 },
      { ncodped: '8516999999', numero: '3', prio: 3 },
    ];
    expect((await getDetalheNfNacional(CHAVE)).itens[0]!.pc!.vinculadoNoOmie).toEqual({ pcNumero: '1' });
    // copia sem numero (vazio) -> cai para a proxima fonte que tem
    numerosRows = [
      { ncodped: '8516999999', numero: '', prio: 1 },
      { ncodped: '8516999999', numero: null, prio: 2 },
      { ncodped: '8516999999', numero: '306', prio: 3 },
    ];
    expect((await getDetalheNfNacional(CHAVE)).itens[0]!.pc!.vinculadoNoOmie).toEqual({ pcNumero: '306' });
  });

  it('numero em branco tambem no cache: numero vazio (a tela mostra "PC vinculado no OMIE" sem numero)', async () => {
    detalheRows = [linhaPc(PC_VINCULADO)];
    numerosRows = [{ ncodped: '8516999999', numero: null, prio: 3 }];
    expect((await getDetalheNfNacional(CHAVE)).itens[0]!.pc!.vinculadoNoOmie).toEqual({ pcNumero: '' });
  });

  it('cache ausente (tabela da 0057 nao aplicada): a consulta unica falha, o detalhe NAO cai e o numero fica vazio', async () => {
    detalheRows = [linhaPc(PC_VINCULADO)];
    const base = poolQuerySpy.getMockImplementation()!;
    poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) =>
      sql.includes('UNION ALL') && sql.includes('pc_numero') ? Promise.reject(new Error('relation "stockbridge.pedido_compra_visto" does not exist')) : base(sql, params),
    );
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.itens[0]!.pc!.vinculadoNoOmie).toEqual({ pcNumero: '' });
  });

  it('fiscal ja feito sem numero na copia nem no ledger: numero vazio — nunca o xPed do fornecedor', async () => {
    detalheRows = [linhaPc({ fiscal_pendente: false, receb_recebido: 'S', c_nao_gerar_mov_estoque: 'S', n_id_pedido: '8516999999', n_id_it_pedido: '8516999998', n_num_ped_compra: '200001909863465' })];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.itens[0]!.pc!.vinculadoNoOmie).toEqual({ pcNumero: '' });
  });

  it('fiscal ja feito sem vinculo: pc null', async () => {
    detalheRows = [linhaPc({ fiscal_pendente: false, receb_recebido: 'S', c_ignorar_item: 'S' })];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.itens[0]!.pc).toBeNull();
  });

  it('estoque ja lancado pelo OMIE (D7): item pendente concluido sem "nao movimentar estoque"; item ja recebido nao conta', async () => {
    detalheRows = [linhaPc({ fiscal_pendente: false, receb_recebido: 'S', c_ignorar_item: 'N', c_nao_gerar_mov_estoque: 'N' })];
    expect((await getDetalheNfNacional(CHAVE)).estoqueLancadoPeloOmie).toBe(true);
    detalheRows = [linhaPc({ fiscal_pendente: false, receb_recebido: 'S', c_ignorar_item: 'N', c_nao_gerar_mov_estoque: 'N', recebido: true })];
    expect((await getDetalheNfNacional(CHAVE)).estoqueLancadoPeloOmie).toBe(false);
  });

  it('descricao trocada pelo vinculo nao devolve a NF a fila: a sequencia tambem casa com a chave desligada (FR-016, ACXEGDP-412)', async () => {
    await getFilaNacional();
    const { sql } = sqlFila();
    expect(sql).not.toContain('NULL::int  AS n_seq');
    expect(sql).toContain('nf_item_sequencias');
  });
  // ── Correcoes da revisao adversarial de 22/10/2026 ──

  it('conclusao CONFIRMADA (FR-021a, achado fila-01): espelho com c_recebido S nas linhas a receber, ou o ledger do Atlas; defasada ou nao casada, nao', async () => {
    const confirma = async (over: Record<string, unknown>) => {
      detalheRows = [linhaPc({ fiscal_pendente: false, c_nao_gerar_mov_estoque: 'S', ...over })];
      return (await montarDetalheNfNacional(CHAVE)).interno.espelhoConfirmaConclusao;
    };
    expect(await confirma({ receb_recebido: 'S' })).toBe(true);
    expect(await confirma({ receb_recebido: 'N' })).toBe(false); // linha do espelho defasada
    expect(await confirma({ receb_recebido: null })).toBe(false); // linha ausente ou nao casada
    expect(await confirma({ receb_recebido: 'N', ledger_concluido: true })).toBe(true); // o Atlas concluiu (e conferiu)
    expect(await confirma({ receb_recebido: 'N', recebido: true })).toBe(true); // nada a receber
    // o SQL do detalhe le o ledger em vez de so testar a existencia da NF no espelho
    expect(sqlDetalhe().sql).toContain('AS ledger_concluido');
    expect(sqlDetalhe().sql).not.toContain('receb_no_espelho');
  });

  it('itensSemAvaliacaoPc (FR-011a/FR-020, achado fila-02): item pendente com unidade nao convertida e SEM vinculo, so com o fluxo de PC', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [
      linhaPc(),
      linhaPc({ n_cod_item: '2', x_prod: 'TAMPA', desc_norm: 'TAMPA', u_com: 'UN', q_com: 300, valor_item: 900, preco_comercial: 3, n_seq: 2 }),
      linhaPc({ n_cod_item: '3', x_prod: 'ROTULO', desc_norm: 'ROTULO', u_com: 'UN', q_com: 10, valor_item: 50, preco_comercial: 5, n_seq: 3, n_id_pedido: '8516905979', n_id_it_pedido: '8516907022' }),
    ];
    const d = await getDetalheNfNacional(CHAVE);
    expect(d.itensSemAvaliacaoPc).toEqual([{ indice: 1, descricao: 'TAMPA' }]);
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = false;
    expect((await getDetalheNfNacional(CHAVE)).itensSemAvaliacaoPc).toEqual([]);
  });

  it('fiscal ja feito PELO ATLAS: o PC do ledger tem precedencia sobre o espelho (troca ainda nao refletida — achado fila-04)', async () => {
    ledgerPcRows = [{ n_sequencia: 1, pc_numero: '304' }];
    numerosRows = [{ ncodped: '8516900302', numero: '302', prio: 1 }];
    // espelho defasado ainda com o PC antigo (302)
    detalheRows = [linhaPc({ fiscal_pendente: false, ledger_concluido: true, n_id_pedido: '8516900302', n_id_it_pedido: '8516900303' })];
    expect((await getDetalheNfNacional(CHAVE)).itens[0]!.pc!.vinculadoNoOmie).toEqual({ pcNumero: '304' });
    // espelho ainda sem vinculo nenhum
    detalheRows = [linhaPc({ fiscal_pendente: false, ledger_concluido: true })];
    expect((await getDetalheNfNacional(CHAVE)).itens[0]!.pc!.vinculadoNoOmie).toEqual({ pcNumero: '304' });
    // a consulta do ledger junta o fiscal da NF (concluido/ja_concluido) e so linhas concluido
    const sqlLedger = chamadas.find((c) => c.sql.includes('JOIN stockbridge.recebimento_fiscal rf'))!;
    expect(sqlLedger.sql).toContain("rf.status IN ('concluido', 'ja_concluido') AND p.status = 'concluido'");
    expect(sqlLedger.params).toEqual([CHAVE]);
  });

  it('fiscal ja feito FORA do Atlas: segue o espelho e nem consulta o ledger', async () => {
    ledgerPcRows = [{ n_sequencia: 1, pc_numero: '304' }];
    numerosRows = [{ ncodped: '8516900302', numero: '302', prio: 1 }];
    detalheRows = [linhaPc({ fiscal_pendente: false, receb_recebido: 'S', c_nao_gerar_mov_estoque: 'S', n_id_pedido: '8516900302', n_id_it_pedido: '8516900303' })];
    expect((await getDetalheNfNacional(CHAVE)).itens[0]!.pc!.vinculadoNoOmie).toEqual({ pcNumero: '302' });
    expect(chamadas.some((c) => c.sql.includes('JOIN stockbridge.recebimento_fiscal rf'))).toBe(false);
  });

  it('pcSituacao da fila ignora item bloqueado por unidade e e nao_aplicavel sem fornecedor no OMIE (achado tela-05)', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    const CHAVE_B = CHAVE.replace(/4$/, '5');
    const nf = (chave: string, numero: string) => ({
      nf_chave_acesso: chave, nota_fiscal: numero, fornecedor_nome: 'REPLAS', fornecedor_cnpj: 'x', dt_emissao: '2026-10-20', dias_desde_emissao: 1,
      itens_total: 2, itens_pendentes: 2, valor_total_brl: 1, fiscal: 'pendente', fiscal_concluido_em: null, estoque_lancado: false,
    });
    filaRows = [nf(CHAVE, '7813'), nf(CHAVE_B, '9001')];
    const linha = (chave: string, over: Record<string, unknown>) => ({
      c_chave_nfe: chave, x_prod: 'SUCATA PLASTICO', desc_norm: 'SUCATA PLASTICO', q_com: 18000, u_com: 'KG', valor_item: 203400, preco_comercial: 11.3,
      n_seq: 1, n_id_pedido: null, n_id_it_pedido: null, n_num_ped_compra: null, fornecedor_codigo: '1111', recebido: false, ...over,
    });
    pcFilaRows = [
      linha(CHAVE, { n_id_pedido: '8516905979', n_id_it_pedido: '8516907022' }),
      linha(CHAVE, { x_prod: 'TAMPA', desc_norm: 'TAMPA', q_com: 300, u_com: 'UN', valor_item: 900, preco_comercial: 3, n_seq: 2 }),
      linha(CHAVE_B, { fornecedor_codigo: null }),
    ];
    const fila = await getFilaNacional();
    expect(fila.find((f) => f.notaFiscal === '7813')!.pcSituacao).toBe('vinculado_omie');
    expect(fila.find((f) => f.notaFiscal === '9001')!.pcSituacao).toBe('nao_aplicavel');
  });

  it('preco da NF nas duas bases (research D3 revisto): PC lancado com o preco COM IPI vira candidato pelo valor do item', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    pcRows = [{ ...PC_ROWS[0], nqtde: 13750, nvalunit: 10.8, valor_total_pc: 148500 }];
    detalheRows = [linhaPc({ x_prod: 'MC PEAD ES', desc_norm: 'MC PEAD ES', q_com: 13750, valor_item: 149187.58, preco_comercial: 10.50848 })];
    const pc = (await getDetalheNfNacional(CHAVE)).itens[0]!.pc!;
    expect(pc.candidatos.map((c) => c.pcNumero)).toEqual(['304']);
    expect(pc.candidatos[0]!.precoNfKgComparado).toBeCloseTo(10.850006, 5);
  });
});
