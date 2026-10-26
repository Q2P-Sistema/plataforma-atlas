import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CFOPS,
  CHAVE_ACXE,
  CHAVE_Q2P,
  CORTE_ACXE,
  CORTE_Q2P,
  falhaTabelaAcxe,
  itemPc580,
  linhaFila,
  linhaFilaAcxe,
  linhaPcFila,
  novoBanco,
  responder,
  erroSchema,
  type Banco,
} from './helpers/banco-nacional-acxe.js';

// Feature 017, Historia 5 (ACXEGDP-437) — a FILA de NF nacional com as duas empresas.
//
// getFilaNacional passa a trazer a Q2P e, habilitada, a ACXE na MESMA consulta: um UNION ALL por empresa
// (cada uma no proprio espelho), corte de emissao proprio da ACXE em parametro separado (depois dos filtros),
// exclusao de fornecedor e via 2 do "ja recebida" casando a EMPRESA da linha (o numero da NF colide entre os
// espelhos). A ACXE so entra com recebimentoNacionalAcxeHabilitado() e, faltando tabela do espelho da ACXE, sai
// da consulta sem derrubar a Q2P. Que a Q2P fica IDENTICA com a ACXE desligada esta em
// fila-nacional-q2p-golden.test.ts; o SQL executado de verdade, em fila-nacional-acxe-db.test.ts (opt-in).

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  config: {} as Record<string, unknown>,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  sugerirProdutosEmLote: vi.fn(),
  registrarPcsVistosSeVencido: vi.fn(),
  lerPcsVistos: vi.fn(),
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => mocks.logger,
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => mocks.poolQuery(sql, params) }),
  getConfig: () => mocks.config,
}));
vi.mock('@atlas/integration-omie', () => ({ consultarPedidoCompra: vi.fn() }));
vi.mock('../services/correlacao-produto.service.js', () => ({ sugerirProdutosEmLote: (...a: unknown[]) => mocks.sugerirProdutosEmLote(...a) }));
vi.mock('../services/pc-visto.service.js', () => ({
  registrarPcsVistosSeVencido: (...a: unknown[]) => mocks.registrarPcsVistosSeVencido(...a),
  lerPcsVistos: (...a: unknown[]) => mocks.lerPcsVistos(...a),
}));

import { getFilaNacional, ehTabelaAusente, FilaNacionalIncompletaError } from '../services/fila-nacional.service.js';
import { __resetEmpresaNacional } from '../services/empresa-nacional.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'fila-nacional-q2p');
const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);

interface Chamada {
  sql: string;
  params: unknown[];
}
const chamadas: Chamada[] = [];
let banco: Banco;

/**
 * Chaves da Q2P (flag da 016) e da ACXE: a ACXE exige as tres para entrar na fila.
 * D21 (fiscal revertido no OMIE): o kill switch fica DESLIGADO — este arquivo trava o SQL das duas empresas SEM a D21
 * (o texto de antes, byte a byte, inclusive o golden da Q2P). Com a D21 ligada: fila-nacional-revertido.test.ts.
 */
function configurar(opts: { acxe?: boolean; fiscal?: boolean; corteAcxe?: string | null } = {}): void {
  const { acxe = true, fiscal = true, corteAcxe = CORTE_ACXE } = opts;
  for (const k of Object.keys(mocks.config)) delete mocks.config[k];
  mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE = CORTE_Q2P;
  mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = fiscal;
  mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED = acxe;
  mocks.config.STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED = false;
  if (corteAcxe) mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE = corteAcxe;
}

beforeEach(() => {
  banco = novoBanco();
  chamadas.length = 0;
  configurar();
  __resetEmpresaNacional();
  for (const f of Object.values(mocks.logger)) f.mockClear();
  mocks.sugerirProdutosEmLote.mockReset();
  mocks.sugerirProdutosEmLote.mockResolvedValue(new Map());
  mocks.registrarPcsVistosSeVencido.mockReset();
  mocks.registrarPcsVistosSeVencido.mockResolvedValue(undefined);
  mocks.lerPcsVistos.mockReset();
  mocks.lerPcsVistos.mockResolvedValue([]);
  mocks.poolQuery.mockReset();
  mocks.poolQuery.mockImplementation((sql: string, params?: unknown[]) => {
    chamadas.push({ sql, params: params ?? [] });
    return responder(banco, sql, params ?? []);
  });
});

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const ehConsultaDaFila = (c: Chamada): boolean => c.sql.includes('HAVING COUNT(*) FILTER (WHERE pendente) > 0');
const consultasDaFila = (): Chamada[] => chamadas.filter(ehConsultaDaFila);
const sqlFila = (): Chamada => {
  const c = consultasDaFila()[0];
  if (!c) throw new Error('consulta da fila nao executada');
  return c;
};
const consultasDoSelo = (): Chamada[] => chamadas.filter((c) => c.sql.includes('u.c_chave_nfe = ANY($3::text[])'));

/** Os blocos do UNION ALL da fonte unificada (o ultimo leva o resto da consulta). */
const blocos = (sql: string): string[] => sql.split('UNION ALL');

describe('getFilaNacional — ACXE habilitada: um bloco por empresa e por fonte', () => {
  it('4 blocos: (a) espelho de NF e (b) espelho de recebimentos da Q2P, depois os mesmos da ACXE — cada um so le o espelho da PROPRIA empresa', async () => {
    await getFilaNacional();
    const b = blocos(sqlFila().sql);
    expect(b).toHaveLength(4);
    const [qNf, qRec, aNf, aRec] = b as [string, string, string, string];

    expect(qNf).toContain('public."tbl_nf_header_Q2P" h');
    expect(qNf).toContain('public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf');
    expect(qRec).toContain('public."tbl_recebimentoNFe_Q2P" r');
    expect(aNf).toContain('public."tbl_nf_header_ACXE" h');
    expect(aNf).toContain('public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf');
    expect(aRec).toContain('public."tbl_recebimentoNFe_ACXE" r');
    expect(aRec).toContain('public."tbl_recebimentoNFe_itens_ACXE" ri ON ri.n_id_receb = r.n_id_receb');

    for (const bloco of [qNf, qRec]) expect(bloco).not.toContain('_ACXE"');
    for (const bloco of [aNf, aRec]) expect(bloco).not.toContain('_Q2P"');
  });

  it('a fonte (b) da ACXE tem a precedencia da (a) na PROPRIA empresa: chave que ja esta no espelho de NF da ACXE nao entra pelo de recebimentos', async () => {
    await getFilaNacional();
    const [, qRec, , aRec] = blocos(sqlFila().sql) as [string, string, string, string];
    expect(aRec).toContain('NOT EXISTS (SELECT 1 FROM public."tbl_nf_header_ACXE" h2 WHERE h2.c_chave_nfe = r.c_chave_nfe)');
    expect(qRec).toContain('NOT EXISTS (SELECT 1 FROM public."tbl_nf_header_Q2P" h2 WHERE h2.c_chave_nfe = r.c_chave_nfe)');
  });

  it('cada linha carrega a empresa de origem (literal por bloco) e o produto e o local que o OMIE associou ao item', async () => {
    await getFilaNacional();
    const [qNf, qRec, aNf, aRec] = blocos(sqlFila().sql).map(norm) as [string, string, string, string];
    for (const q of [qNf, qRec]) expect(q).toContain("'q2p'::text AS empresa");
    for (const a of [aNf, aRec]) expect(a).toContain("'acxe'::text AS empresa");
    for (const bloco of [qNf, aNf]) {
      expect(bloco).toContain('NULLIF(i.n_cod_prod, 0)::bigint AS produto_omie');
      expect(bloco).toContain('NULLIF(i.codigo_local_estoque, 0)::bigint AS local_omie');
    }
    for (const bloco of [qRec, aRec]) {
      expect(bloco).toContain('NULLIF(ri.n_id_produto, 0)::bigint AS produto_omie');
      expect(bloco).toContain('NULLIF(ri.codigo_local_estoque, 0)::bigint AS local_omie');
    }
  });

  it('a sequencia do item no recebimento (ACXEGDP-412) le o espelho da empresa do bloco, nao o da Q2P', async () => {
    await getFilaNacional();
    const [qNf, , aNf] = blocos(sqlFila().sql) as [string, string, string];
    expect(aNf).toContain('FROM public."tbl_nf_itens_ACXE" i2');
    expect(aNf).toContain('FROM public."tbl_recebimentoNFe_ACXE" r');
    expect(aNf).toContain('JOIN public."tbl_recebimentoNFe_itens_ACXE" ri ON ri.n_id_receb = r.n_id_receb');
    expect(qNf).toContain('FROM public."tbl_nf_itens_Q2P" i2');
  });

  it('corte de emissao PROPRIO: o da Q2P em $2 e o da ACXE em $3, cada um nas duas fontes da sua empresa', async () => {
    await getFilaNacional();
    const { sql, params } = sqlFila();
    const [qNf, qRec, aNf, aRec] = blocos(sql) as [string, string, string, string];
    expect(params).toEqual([CFOPS, CORTE_Q2P, CORTE_ACXE]);
    expect(qNf).toContain('h.d_emi >= $2::date');
    expect(qRec).toContain('r.d_emissao >= $2::date');
    expect(aNf).toContain('h.d_emi >= $3::date');
    expect(aRec).toContain('r.d_emissao >= $3::date');
    expect(aNf).not.toContain('$2');
    expect(aRec).not.toContain('$2');
  });

  it('com filtros, o corte da ACXE vai DEPOIS deles ($5) e a numeracao da Q2P e a de sempre ($2, $3, $4)', async () => {
    await getFilaNacional({ q: '937', fornecedor: 'SOLUTEC' });
    const { sql, params } = sqlFila();
    const [qNf, qRec, aNf, aRec] = blocos(sql) as [string, string, string, string];
    expect(params).toEqual([CFOPS, CORTE_Q2P, '%SOLUTEC%', '%937%', CORTE_ACXE]);
    expect(qNf).toContain('h.d_emi >= $2::date');
    expect(qRec).toContain('r.d_emissao >= $2::date');
    expect(aNf).toContain('h.d_emi >= $5::date');
    expect(aRec).toContain('r.d_emissao >= $5::date');
    const n = norm(sql);
    expect(n).toContain('(u.dest_cnpj_cpf ILIKE $3 OR u.dest_razao ILIKE $3)');
    expect(n).toContain("(ltrim(u.n_nf, '0') ILIKE $4 OR u.dest_razao ILIKE $4)");
    // o filtro e dado, nao texto de SQL
    expect(sql).not.toContain('SOLUTEC');
  });

  it('o recorte de CFOP, tp_nf = 0 e as demais exclusoes valem para as duas empresas', async () => {
    await getFilaNacional();
    const { sql } = sqlFila();
    const n = norm(sql);
    expect(n).toContain('u.cfop = ANY($1::text[])');
    expect(n.split('h.tp_nf = 0')).toHaveLength(3); // (a) da Q2P e (a) da ACXE
    expect(n.split('COALESCE(h.deletada, false) = false').length - 1).toBe(2);
    expect(n.split('COALESCE(h.cancelada, false) = false').length - 1).toBe(2);
    expect(n).toContain('NOT u.cancelada AND NOT u.deletada');
    expect(n).toContain('stockbridge.nf_dispensa d');
  });
});

describe('getFilaNacional — exclusao de fornecedor e via 2 do "ja recebida" casam a EMPRESA da linha', () => {
  it('a exclusao vale so para a fila da empresa dela: a contraparte intercompany da Q2P sai da fila da ACXE e a ACXE sai da fila da Q2P (o CNPJ se repete nas duas)', async () => {
    await getFilaNacional();
    const n = norm(sqlFila().sql);
    expect(n).toContain('fe.reincluido_em IS NULL AND fe.fornecedor_cnpj = u.dest_cnpj_cpf AND fe.empresa = u.empresa');
    expect(n).not.toContain("fe.empresa = 'q2p'");
  });

  it('a via 2 (historico do formulario manual, so pelo numero da NF) casa a empresa da linha, nao a Q2P fixa — NF 5832 existe nas duas', async () => {
    await getFilaNacional();
    const n = norm(sqlFila().sql);
    expect(n).toContain("AND m.nf_chave_acesso IS NULL AND m.empresa = u.empresa AND ltrim(m.nota_fiscal, '0') = ltrim(u.n_nf, '0') AND m.created_at >= (u.d_emi)::date");
    expect(n).not.toContain("m.empresa = 'q2p'");
  });

  it('a identidade do item (via 1, restante atribuido e baixa externa) segue pela chave de acesso, que e unica entre os espelhos', async () => {
    await getFilaNacional();
    const n = norm(sqlFila().sql);
    expect(n).toContain('m.nf_chave_acesso = u.c_chave_nfe AND (m.nf_item_descricao_normalizada =');
    expect(n).toContain("a.tipo_aprovacao = 'recebimento_externo' AND a.status = 'aprovada' AND a.nf_chave_acesso = u.c_chave_nfe");
  });

  it('a pendencia e agrupada por empresa tambem: GROUP BY e ORDER BY (a mesma data e o mesmo numero em empresas diferentes nao se misturam)', async () => {
    await getFilaNacional();
    const n = norm(sqlFila().sql);
    expect(n).toContain('GROUP BY c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi, desc_norm, empresa');
    expect(n).toContain('GROUP BY c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi, empresa HAVING');
    expect(n).toContain('ORDER BY d_emi ASC, n_nf ASC, empresa ASC');
    expect(n).toMatch(/AS estoque_lancado, empresa FROM itens_flag/);
  });
});

describe('getFilaNacional — a coluna `cancelada` do espelho de NF e consultada por empresa', () => {
  it('uma consulta ao information_schema para cada espelho de NF', async () => {
    await getFilaNacional();
    const info = chamadas.filter((c) => c.sql.includes('information_schema')).map((c) => c.params);
    expect(info).toEqual([['tbl_nf_header_Q2P'], ['tbl_nf_header_ACXE']]);
  });

  it('sem a coluna no espelho da ACXE (sync PROD -> UAT a derruba), so o bloco da ACXE perde o filtro; o da Q2P o mantem', async () => {
    mocks.poolQuery.mockImplementation((sql: string, params?: unknown[]) => {
      chamadas.push({ sql, params: params ?? [] });
      if (sql.includes('information_schema')) return Promise.resolve({ rows: [{ ok: (params?.[0] as string) !== 'tbl_nf_header_ACXE' }] });
      return responder(banco, sql, params ?? []);
    });
    await getFilaNacional();
    const [qNf, , aNf] = blocos(sqlFila().sql) as [string, string, string];
    expect(qNf).toContain('COALESCE(h.cancelada, false) = false');
    expect(aNf).not.toContain('h.cancelada');
    expect(aNf).toContain('COALESCE(h.deletada, false) = false');
  });
});

describe('getFilaNacional — restringir por empresa', () => {
  it('empresa=q2p com a ACXE ligada gera EXATAMENTE a consulta da Q2P de sempre (mesmo texto e mesmos parametros do golden de a62ea88)', async () => {
    await getFilaNacional({ empresa: 'q2p' });
    const { sql, params } = sqlFila();
    expect(sql.trimEnd()).toBe(readFileSync(join(GOLDEN, 'fila-fiscal-ligado.sql'), 'utf8').trimEnd());
    expect(params).toEqual(JSON.parse(readFileSync(join(GOLDEN, 'fila-fiscal-ligado.params.json'), 'utf8')));
    expect(params).toEqual([CFOPS, CORTE_Q2P]);
    expect(sql).not.toContain('ACXE');
    // o espelho da ACXE nem e consultado (nem a coluna `cancelada`, nem a idade)
    expect(chamadas.some((c) => c.sql.includes('_ACXE"') || c.params.includes('tbl_nf_header_ACXE'))).toBe(false);
  });

  it('empresa=q2p com filtros: a numeracao e a de antes da Historia 5', async () => {
    await getFilaNacional({ empresa: 'q2p', q: '667', fornecedor: 'ISOFORMA' });
    expect(sqlFila().params).toEqual([CFOPS, CORTE_Q2P, '%ISOFORMA%', '%667%']);
  });

  it('empresa=acxe: so os dois blocos da ACXE, com o corte dela em $2 e a coluna `empresa` nas linhas', async () => {
    await getFilaNacional({ empresa: 'acxe' });
    const { sql, params } = sqlFila();
    const b = blocos(sql);
    expect(b).toHaveLength(2);
    expect(sql).not.toContain('_Q2P"');
    expect(params).toEqual([CFOPS, CORTE_ACXE]);
    expect(b[0]).toContain('h.d_emi >= $2::date');
    expect(b[1]).toContain('r.d_emissao >= $2::date');
    expect(norm(sql)).toContain("'acxe'::text AS empresa");
    // a fila so da ACXE tambem leva a empresa nas linhas (a exclusao e a via 2 casam por ela)
    expect(norm(sql)).toContain('fe.empresa = u.empresa');
  });

  it('empresa=acxe com filtros: o corte da ACXE vem depois dos filtros ($4)', async () => {
    await getFilaNacional({ empresa: 'acxe', q: '937', fornecedor: 'SOLUTEC' });
    const { sql, params } = sqlFila();
    expect(params).toEqual([CFOPS, '%SOLUTEC%', '%937%', CORTE_ACXE]);
    expect(blocos(sql)[0]).toContain('h.d_emi >= $4::date');
  });

  it('empresa=acxe consulta so o espelho de NF da ACXE (information_schema) e so a idade da ACXE', async () => {
    await getFilaNacional({ empresa: 'acxe' });
    expect(chamadas.filter((c) => c.sql.includes('information_schema')).map((c) => c.params)).toEqual([['tbl_nf_header_ACXE']]);
    const idades = chamadas.filter((c) => c.sql.includes('MAX(synced_at)'));
    expect(idades).toHaveLength(1);
    expect(idades[0]!.sql).toContain('"tbl_recebimentoNFe_ACXE"');
  });

  it('sem filtro de empresa a ordem das empresas na consulta e a Q2P primeiro', async () => {
    await getFilaNacional({ empresa: null });
    const { sql } = sqlFila();
    expect(sql.indexOf('"tbl_nf_header_Q2P"')).toBeGreaterThan(-1);
    expect(sql.indexOf('"tbl_nf_header_Q2P"')).toBeLessThan(sql.indexOf('"tbl_nf_header_ACXE"'));
  });
});

describe('getFilaNacional — ACXE desligada (ou sem alguma das tres condicoes): a fila e so da Q2P', () => {
  it('chave da ACXE desligada: nenhuma tabela da ACXE no SQL e nenhum aviso no log', async () => {
    configurar({ acxe: false });
    await getFilaNacional();
    expect(sqlFila().sql).not.toContain('ACXE');
    expect(sqlFila().params).toEqual([CFOPS, CORTE_Q2P]);
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it('empresa=acxe com a ACXE desligada devolve lista vazia SEM consultar o banco (a tela filtra por empresa e nao pode quebrar)', async () => {
    configurar({ acxe: false });
    await expect(getFilaNacional({ empresa: 'acxe' })).resolves.toEqual([]);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('chave da ACXE ligada SEM a chave do fiscal pelo Atlas: ACXE fora, a Q2P segue com o SQL da Q2P e o log diz o que falta', async () => {
    configurar({ acxe: true, fiscal: false });
    await getFilaNacional();
    expect(sqlFila().sql).not.toContain('ACXE');
    expect(sqlFila().params).toEqual([CFOPS, CORTE_Q2P]);
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    expect(mocks.logger.error.mock.calls[0]![0]).toEqual({ fiscalPeloAtlas: false, corteAcxe: CORTE_ACXE });
  });

  it('chave da ACXE ligada SEM o corte proprio da ACXE: ACXE fora (entrariam as NFs ja recebidas no portal), Q2P normal', async () => {
    configurar({ acxe: true, corteAcxe: null });
    await getFilaNacional();
    expect(sqlFila().sql).not.toContain('ACXE');
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    expect(mocks.logger.error.mock.calls[0]![0]).toEqual({ fiscalPeloAtlas: true, corteAcxe: null });
  });
});

describe('getFilaNacional — resultado: a empresa de cada NF', () => {
  it('mapeia a empresa da linha (a ACXE so aparece com a consulta que a inclui); linha sem empresa e da Q2P; a ordem e a do banco', async () => {
    banco.fila = [
      linhaFila({ nf_chave_acesso: CHAVE_Q2P, nota_fiscal: '5832', fornecedor_nome: 'FDMA', empresa: 'q2p', dt_emissao: '2026-10-01' }),
      linhaFilaAcxe({ nota_fiscal: '5832', fornecedor_nome: 'ACXE', dt_emissao: '2026-10-01' }),
      linhaFilaAcxe({ nf_chave_acesso: 'x'.repeat(44), nota_fiscal: '937', dt_emissao: '2026-10-02' }),
    ];
    const fila = await getFilaNacional();
    expect(fila.map((f) => [f.notaFiscal, f.empresa, f.fornecedorNome])).toEqual([
      ['5832', 'q2p', 'FDMA'],
      ['5832', 'acxe', 'ACXE'],
      ['937', 'acxe', 'SOLUTEC PLASTICOS LTDA'],
    ]);
    // o mesmo numero de NF nas duas empresas sao duas linhas, nao uma
    expect(new Set(fila.map((f) => f.nfChaveAcesso)).size).toBe(3);
  });

  it('a Q2P sem a coluna `empresa` (consulta so da Q2P) segue com empresa "q2p"', async () => {
    configurar({ acxe: false });
    banco.fila = [linhaFila()];
    const [f] = await getFilaNacional();
    expect(f).toMatchObject({ empresa: 'q2p', notaFiscal: '6842', fiscal: 'concluido', estoqueLancadoPeloOmie: false, pcSituacao: 'nao_aplicavel' });
  });

  it('converte os tipos do Postgres (dias, contagens e valor) e trata fornecedor nulo, tambem para a ACXE', async () => {
    banco.fila = [
      linhaFilaAcxe({ dias_desde_emissao: '12', itens_total: '3', itens_pendentes: '2', valor_total_brl: '124800.5', fornecedor_nome: null, fornecedor_cnpj: null, estoque_lancado: true }),
    ];
    const [f] = await getFilaNacional();
    expect(f).toMatchObject({
      empresa: 'acxe',
      diasDesdeEmissao: 12,
      itensTotal: 3,
      itensPendentes: 2,
      valorTotalBrl: 124800.5,
      fornecedorNome: 'Fornecedor não identificado no OMIE',
      fornecedorCnpj: '',
      estoqueLancadoPeloOmie: true,
    });
  });

  it('data de conclusao do fiscal pelo Atlas vira ISO (ledger); nula continua nula', async () => {
    banco.fila = [
      linhaFilaAcxe({ fiscal: 'concluido', fiscal_concluido_em: '2026-10-22 10:15:00+00' }),
      linhaFila({ fiscal: 'concluido', fiscal_concluido_em: null, empresa: 'q2p' }),
    ];
    const fila = await getFilaNacional();
    expect(fila[0]!.fiscalConcluidoPeloAtlasEm).toBe(new Date('2026-10-22 10:15:00+00').toISOString());
    expect(fila[1]!.fiscalConcluidoPeloAtlasEm).toBeNull();
  });
});

describe('getFilaNacional — espelho da ACXE ausente nao derruba a Q2P', () => {
  const erroDaAcxe = (codigo: '42P01' | '42703') => ({
    quando: (sql: string) => sql.includes('HAVING COUNT(*) FILTER (WHERE pendente) > 0') && sql.includes('_ACXE"'),
    erro: () => erroSchema(codigo, codigo === '42P01' ? 'relation "public.tbl_recebimentoNFe_ACXE" does not exist' : 'column ri.n_id_pedido does not exist'),
    restantes: 99,
  });

  it.each(['42P01', '42703'] as const)('erro %s na consulta com a ACXE: repete so com a Q2P e devolve a fila da Q2P', async (codigo) => {
    banco.falhas.push(erroDaAcxe(codigo));
    banco.fila = [linhaFila({ fiscal: 'concluido' })];
    const fila = await getFilaNacional();
    expect(fila).toHaveLength(1);
    expect(fila[0]).toMatchObject({ notaFiscal: '6842', empresa: 'q2p' });

    const tentativas = consultasDaFila();
    expect(tentativas).toHaveLength(2);
    expect(tentativas[0]!.sql).toContain('_ACXE"');
    // a segunda e a consulta da Q2P de sempre
    expect(tentativas[1]!.sql.trimEnd()).toBe(readFileSync(join(GOLDEN, 'fila-fiscal-ligado.sql'), 'utf8').trimEnd());
    expect(tentativas[1]!.params).toEqual([CFOPS, CORTE_Q2P]);
  });

  it('as idades do espelho so sao conferidas para as empresas que de fato responderam', async () => {
    banco.falhas.push(erroDaAcxe('42P01'));
    await getFilaNacional();
    const idades = chamadas.filter((c) => c.sql.includes('MAX(synced_at)'));
    expect(idades).toHaveLength(1);
    expect(idades[0]!.sql).toContain('"tbl_recebimentoNFe_Q2P"');
  });

  it('pedido SO da ACXE (empresa=acxe) com a tabela ausente nao tem Q2P para confirmar de quem e o defeito: erro visivel (503), nunca fila vazia', async () => {
    banco.falhas.push(erroDaAcxe('42P01'));
    await expect(getFilaNacional({ empresa: 'acxe' })).rejects.toBeInstanceOf(FilaNacionalIncompletaError);
    expect(consultasDaFila()).toHaveLength(1);
  });

  it('se a repeticao so com a Q2P TAMBEM falha por tabela ausente, o defeito e da Q2P: erro visivel e nenhum aviso de "ACXE fora da fila"', async () => {
    banco.falhas.push({
      quando: (sql) => sql.includes('HAVING COUNT(*) FILTER (WHERE pendente) > 0'),
      erro: () => erroSchema('42P01', 'relation "stockbridge.recebimento_fiscal" does not exist'),
      restantes: 99,
    });
    await expect(getFilaNacional()).rejects.toBeInstanceOf(FilaNacionalIncompletaError);
    expect(consultasDaFila()).toHaveLength(2);
    expect(mocks.logger.error.mock.calls.some((c) => String(c[1]).includes('Consulta da ACXE falhou'))).toBe(false);
  });

  it('outro erro de banco com as duas empresas (timeout): repete so com a Q2P; se a Q2P tambem falha, fila vazia como sempre', async () => {
    // revisao da Fase 2: QUALQUER falha da consulta com a ACXE tira so a ACXE (um corte invalido, por exemplo, dava
    // 22008 e esvaziava a fila da Q2P). Aqui a Q2P sozinha tambem falha: o defeito nao e da ACXE e nao ha aviso dela.
    banco.falhas.push({
      quando: (sql) => sql.includes('HAVING COUNT(*) FILTER (WHERE pendente) > 0'),
      erro: () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
      restantes: 99,
    });
    await expect(getFilaNacional()).resolves.toEqual([]);
    expect(consultasDaFila()).toHaveLength(2);
    expect(mocks.logger.error.mock.calls.some((c) => String(c[1]).includes('Consulta da ACXE falhou'))).toBe(false);
  });

  it('erro que so a consulta com a ACXE dispara (ex.: corte da ACXE invalido, 22008): a Q2P responde sozinha (o aviso tem os testes dele abaixo)', async () => {
    banco.falhas.push({
      quando: (sql) => sql.includes('HAVING COUNT(*) FILTER (WHERE pendente) > 0') && sql.includes('_ACXE"'),
      erro: () => Object.assign(new Error('date/time field value out of range: "2026-02-30"'), { code: '22008' }),
      restantes: 99,
    });
    await getFilaNacional();
    expect(consultasDaFila()).toHaveLength(2);
    expect(consultasDaFila()[1]!.sql).not.toContain('_ACXE"');
  });

  it('tabela ausente so da Q2P (sem ACXE no pedido) continua sendo erro visivel, como sempre', async () => {
    configurar({ acxe: false });
    banco.falhas.push({
      quando: (sql) => sql.includes('HAVING COUNT(*) FILTER (WHERE pendente) > 0'),
      erro: () => erroSchema('42P01', 'relation "stockbridge.recebimento_fiscal" does not exist'),
      restantes: 99,
    });
    await expect(getFilaNacional()).rejects.toBeInstanceOf(FilaNacionalIncompletaError);
    expect(consultasDaFila()).toHaveLength(1);
  });

  it('com todas as tabelas da ACXE ausentes (nada criado pelo n8n) a Q2P continua inteira, inclusive o selo do PC', async () => {
    banco.falhas.push(falhaTabelaAcxe());
    banco.fila = [linhaFila({ fiscal: 'pendente' })];
    banco.pcFila.q2p = [linhaPcFila({ c_chave_nfe: CHAVE_Q2P, x_prod: 'SUCATA PLASTICO', desc_norm: 'SUCATA PLASTICO', q_com: 18000, valor_item: 203400, preco_comercial: 11.3, fornecedor_codigo: '1111' })];
    const fila = await getFilaNacional();
    expect(fila).toHaveLength(1);
    expect(fila[0]).toMatchObject({ empresa: 'q2p', fiscal: 'pendente', pcSituacao: 'sem_pc' });
  });
});

describe('ehTabelaAusente — o que a fila trata como "espelho ausente" (tabela 42P01 ou coluna 42703, tambem dentro de `cause`)', () => {
  it('reconhece o codigo direto e o aninhado em cause (drizzle embrulha o erro do driver)', () => {
    expect(ehTabelaAusente({ code: '42P01' })).toBe(true);
    expect(ehTabelaAusente({ code: '42703' })).toBe(true);
    expect(ehTabelaAusente(new Error('x', { cause: { code: '42P01' } }))).toBe(true);
    expect(ehTabelaAusente({ cause: { cause: { code: '42703' } } })).toBe(true);
  });

  it('timeout, conexao, permissao, erro sem codigo e valores que nao sao objeto NAO sao "ausente"', () => {
    expect(ehTabelaAusente({ code: '57014' })).toBe(false);
    expect(ehTabelaAusente({ code: '42501' })).toBe(false);
    expect(ehTabelaAusente(new Error('boom'))).toBe(false);
    expect(ehTabelaAusente(null)).toBe(false);
    expect(ehTabelaAusente(undefined)).toBe(false);
    expect(ehTabelaAusente('42P01')).toBe(false);
  });
});

describe('getFilaNacional — o aviso de "ACXE fora da fila" e limitado a um a cada 10 minutos', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  /** O controle do aviso e estado do modulo: cada teste precisa do seu, entao o servico e importado de novo. */
  async function carregar() {
    vi.resetModules();
    return import('../services/fila-nacional.service.js');
  }
  const avisos = () => mocks.logger.error.mock.calls.filter((c) => String(c[1]).includes('Consulta da ACXE falhou'));

  it('a falta e logada como erro (o health mostra "indisponivel"), com o erro original, e so DEPOIS de a Q2P responder', async () => {
    const svc = await carregar();
    banco.falhas.push(falhaTabelaAcxe());
    await svc.getFilaNacional();
    expect(avisos()).toHaveLength(1);
    expect(avisos()[0]![0]).toMatchObject({ onde: 'fila' });
    expect(String((avisos()[0]![0] as { err: string }).err)).toContain('does not exist');
    expect(String(avisos()[0]![1])).toContain('a fila da Q2P segue normal');
  });

  it('se a Q2P tambem falha, nao ha aviso de "ACXE fora da fila" (o defeito nao e da ACXE) e o controle do aviso nao e gasto', async () => {
    const svc = await carregar();
    banco.falhas.push({
      quando: (sql) => sql.includes('HAVING COUNT(*) FILTER (WHERE pendente) > 0'),
      erro: () => erroSchema('42P01', 'relation "stockbridge.recebimento_fiscal" does not exist'),
      restantes: 2,
    });
    await expect(svc.getFilaNacional()).rejects.toBeInstanceOf(svc.FilaNacionalIncompletaError);
    expect(avisos()).toHaveLength(0);
    // a Q2P volta; a ACXE continua sem tabela: agora sim o aviso, na primeira vez
    banco.falhas.push(falhaTabelaAcxe());
    await svc.getFilaNacional();
    expect(avisos()).toHaveLength(1);
  });

  it('a falta persistente da tabela nao enche o log: 1 aviso, silencio ate 10 minutos, de novo depois', async () => {
    const svc = await carregar();
    banco.falhas.push(falhaTabelaAcxe());
    await svc.getFilaNacional();
    await svc.getFilaNacional();
    expect(avisos()).toHaveLength(1);

    vi.setSystemTime(T0 + 9 * 60_000 + 59_000);
    await svc.getFilaNacional();
    expect(avisos()).toHaveLength(1);

    vi.setSystemTime(T0 + 10 * 60_000);
    await svc.getFilaNacional();
    expect(avisos()).toHaveLength(2);
  });

  it('o detalhe e a fila dividem o mesmo controle (um aviso por janela, venha de onde vier)', async () => {
    const svc = await carregar();
    banco.falhas.push(falhaTabelaAcxe());
    banco.detalhe = [];
    await svc.getFilaNacional();
    await svc.getDetalheNfNacional(CHAVE_Q2P).catch(() => undefined);
    expect(avisos()).toHaveLength(1);
    expect(avisos()[0]![0]).toMatchObject({ onde: 'fila' });
  });
});

describe('getFilaNacional — selo do PC por empresa (fiscal pendente)', () => {
  const pendenteQ2p = () => linhaFila({ fiscal: 'pendente', empresa: 'q2p' });
  const pendenteAcxe = () => linhaFilaAcxe({ fiscal: 'pendente' });
  const itemQ2p = () =>
    linhaPcFila({ c_chave_nfe: CHAVE_Q2P, x_prod: 'SUCATA PLASTICO', desc_norm: 'SUCATA PLASTICO', q_com: 18000, valor_item: 203400, preco_comercial: 11.3, fornecedor_codigo: '1111' });

  it('uma leitura da copia de PCs por empresa, cada uma com o corte e as tabelas da propria empresa', async () => {
    banco.fila = [pendenteQ2p(), pendenteAcxe()];
    banco.pcFila.q2p = [itemQ2p()];
    banco.pcFila.acxe = [linhaPcFila()];
    banco.copiaPcs.acxe = [itemPc580()];
    await getFilaNacional();

    const selos = consultasDoSelo();
    expect(selos).toHaveLength(2);
    const daQ2p = selos.find((c) => !c.sql.includes('_ACXE"'))!;
    const daAcxe = selos.find((c) => c.sql.includes('_ACXE"'))!;
    expect(daQ2p.params).toEqual([CFOPS, CORTE_Q2P, [CHAVE_Q2P]]);
    expect(daAcxe.params).toEqual([CFOPS, CORTE_ACXE, [CHAVE_ACXE]]);
    expect(daAcxe.sql).not.toContain('_Q2P"');
    expect(daQ2p.sql).not.toContain('_ACXE"');
    // a copia de PCs lida e a da empresa da NF
    const copias = chamadas.filter((c) => c.sql.includes('FROM public.') && c.sql.includes('tbl_pedidosCompras_') && c.sql.includes(' pc') && !c.sql.includes('MAX('));
    expect(copias.map((c) => (c.sql.includes('_ACXE"') ? 'acxe' : 'q2p')).sort()).toEqual(['acxe', 'q2p']);
  });

  it('o selo vem do PC da copia da empresa: ACXE com o PC 580 = sugerido; Q2P sem PC = sem_pc', async () => {
    banco.fila = [pendenteQ2p(), pendenteAcxe()];
    banco.pcFila.q2p = [itemQ2p()];
    banco.pcFila.acxe = [linhaPcFila()];
    banco.copiaPcs.acxe = [itemPc580()];
    const fila = await getFilaNacional();
    expect(fila.map((f) => [f.empresa, f.pcSituacao])).toEqual([
      ['q2p', 'sem_pc'],
      ['acxe', 'sugerido'],
    ]);
  });

  it('a copia de PCs defasada de UMA empresa tira so o selo dela (a outra segue)', async () => {
    banco.fila = [pendenteQ2p(), pendenteAcxe()];
    banco.pcFila.q2p = [itemQ2p()];
    banco.pcFila.acxe = [linhaPcFila()];
    banco.copiaPcs.acxe = [itemPc580()];
    banco.idadeCopia.acxe = 500; // limite de 120 min
    const fila = await getFilaNacional();
    expect(fila.map((f) => [f.empresa, f.pcSituacao])).toEqual([
      ['q2p', 'sem_pc'],
      ['acxe', 'nao_aplicavel'],
    ]);
    // modo seguro: a copia velha nem e lida
    expect(consultasDoSelo().some((c) => c.sql.includes('_ACXE"'))).toBe(false);
  });

  it('falha de banco ao ler os itens de UMA empresa tira so o selo dela e loga com a empresa (a fila e informativa)', async () => {
    banco.fila = [pendenteQ2p(), pendenteAcxe()];
    banco.pcFila.q2p = [itemQ2p()];
    banco.pcFila.acxe = [linhaPcFila()];
    banco.falhas.push({
      quando: (sql) => sql.includes('u.c_chave_nfe = ANY($3::text[])') && sql.includes('_ACXE"'),
      erro: () => new Error('connection reset'),
      restantes: 1,
    });
    const fila = await getFilaNacional();
    expect(fila.map((f) => [f.empresa, f.pcSituacao])).toEqual([
      ['q2p', 'sem_pc'],
      ['acxe', 'nao_aplicavel'],
    ]);
    const aviso = mocks.logger.warn.mock.calls.find((c) => String(c[1]).includes('Situação de PC da fila indisponível'));
    expect(aviso![0]).toMatchObject({ empresa: 'acxe' });
  });

  it('NF com fiscal ja feito nao pede selo (nenhuma leitura de PC)', async () => {
    banco.fila = [linhaFila({ fiscal: 'concluido' }), linhaFilaAcxe({ fiscal: 'concluido' })];
    const fila = await getFilaNacional();
    expect(consultasDoSelo()).toHaveLength(0);
    expect(fila.every((f) => f.pcSituacao === 'nao_aplicavel')).toBe(true);
  });

  it('fila so da ACXE: so a leitura da ACXE', async () => {
    banco.fila = [pendenteAcxe()];
    banco.pcFila.acxe = [linhaPcFila()];
    banco.copiaPcs.acxe = [itemPc580()];
    const fila = await getFilaNacional({ empresa: 'acxe' });
    expect(fila).toHaveLength(1);
    expect(fila[0]).toMatchObject({ empresa: 'acxe', pcSituacao: 'sugerido' });
    expect(consultasDoSelo()).toHaveLength(1);
  });

  it('NF da ACXE sem fornecedor no OMIE (fornecedor_codigo nulo): selo nao_aplicavel (o fiscal pelo Atlas a recusa antes do PC)', async () => {
    banco.fila = [pendenteAcxe()];
    banco.pcFila.acxe = [linhaPcFila({ fornecedor_codigo: null })];
    const [f] = await getFilaNacional();
    expect(f).toMatchObject({ empresa: 'acxe', pcSituacao: 'nao_aplicavel' });
  });
});

describe('getFilaNacional — defasagem do espelho de recebimentos por empresa (warn)', () => {
  it('espelho velho da ACXE avisa com a empresa; o da Q2P em dia nao avisa', async () => {
    banco.idadeEspelho.acxe = 300;
    banco.idadeEspelho.q2p = 10;
    await getFilaNacional();
    const avisos = mocks.logger.warn.mock.calls.filter((c) => String(c[1]).includes('Espelho de recebimentos de NF-e defasado'));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]![0]).toMatchObject({ empresa: 'acxe', status: 'degraded', idadeMin: 300, limiteMin: 120 });
  });

  it('espelho da ACXE vazio tambem avisa (o n8n da ACXE existe e esta inativo ate o go-live)', async () => {
    banco.idadeEspelho.acxe = null;
    await getFilaNacional();
    const avisos = mocks.logger.warn.mock.calls.filter((c) => String(c[1]).includes('Espelho de recebimentos de NF-e defasado'));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]![0]).toMatchObject({ empresa: 'acxe', status: 'sem_dados' });
  });

  it('as duas em dia: nenhum aviso', async () => {
    await getFilaNacional();
    expect(mocks.logger.warn.mock.calls.filter((c) => String(c[1]).includes('defasado'))).toHaveLength(0);
  });
});

// Defeito achado ao executar o SQL num Postgres real (fila-nacional-acxe-db.test.ts) e corrigido: a consulta SO da Q2P (ACXE
// desligada, ou `?empresa=q2p` com a ACXE ligada) era identica byte a byte a de antes da Historia 5, e o
// `NOT EXISTS (… stockbridge.fornecedor_exclusao fe …)` dela nao filtrava a empresa da exclusao, como a consulta com a ACXE
// faz (`fe.empresa = u.empresa`). Desde a 0058 a tabela guarda exclusoes de empresa 'acxe' (o seed da Q2P matriz e filial, e as
// que o gestor fizer so para a ACXE), que esconderiam a NF da Q2P. Agora a consulta so da Q2P filtra `fe.empresa = 'q2p'`
// (o golden da Q2P foi regenerado com essa unica diferenca).
describe('a exclusao de fornecedor feita so para a ACXE nao vaza para a consulta so da Q2P', () => {
  it('ACXE desligada: a exclusao de fornecedor da consulta da Q2P filtra a empresa (fe.empresa)', async () => {
    configurar({ acxe: false });
    await getFilaNacional();
    expect(norm(sqlFila().sql)).toMatch(/fe\.empresa = (u\.empresa|'q2p')/);
  });

  it('?empresa=q2p com a ACXE ligada: idem (a mesma NF nao pode sumir so porque o filtro foi aplicado)', async () => {
    await getFilaNacional({ empresa: 'q2p' });
    expect(norm(sqlFila().sql)).toMatch(/fe\.empresa = (u\.empresa|'q2p')/);
  });
});
