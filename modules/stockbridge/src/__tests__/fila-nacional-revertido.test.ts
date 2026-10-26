import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  linhaDetalhe,
  linhaDetalheAcxe,
  linhaFila,
  linhaFilaAcxe,
  linhaPcFila,
  novoBanco,
  responder,
  type Banco,
} from './helpers/banco-nacional-acxe.js';

// Feature 017, D21 (ACXEGDP-437) — recebimento fiscal REVERTIDO no portal do OMIE, na FILA e no DETALHE da NF nacional.
//
// Caso real: NF 19252 (Zaraplast, Q2P, 25/10/2026). O Atlas concluiu o fiscal as 17:02 (ledger 'concluido'), o usuario o desfez no
// portal as 17:13 (etapa 40, cRecebido N) e a fila seguia mostrando "fiscal ja feito": a nota de entrada fica para sempre valida no
// espelho de NF (a 19252 tem 1 das 4 linhas do recebimento e nao traz o fornecedor) e o ledger seguia 'concluido'.
//
// O SINAL (fiscal-revertido.ts) compara horas de EVENTO do OMIE e e avaliado dentro das duas fontes de cada empresa; o contrato aqui:
//  - NF revertida = fiscal 'pendente' + `fiscalRevertido` (SituacaoFiscal continua binaria); a fonte (a) a solta inteira e a (b) a assume;
//  - com a D21 INDISPONIVEL (chave da 016 desligada, kill switch STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED ou migration 0060 ausente) o SQL e o de
//    antes, BYTE A BYTE (os goldens `*-desligado` e `*-ligado` de golden/fila-nacional-q2p); os `*-revertido` travam o SQL com a D21 ligada.
// O SQL de verdade (a execucao do sinal, a margem de 2 min, o fuso, h_alt malformado) so um Postgres prova: fila-nacional-acxe-db.test.ts (opt-in).
// Com DUMP_SQL_DIR definido, grava o SQL gerado para EXPLAIN / validacao em um banco real.

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  config: {} as Record<string, unknown>,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  sugerirProdutosEmLote: vi.fn(),
  registrarPcsVistosSeVencido: vi.fn(),
  lerPcsVistos: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => mocks.logger,
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => mocks.poolQuery(sql, params), connect: () => mocks.connect() }),
  getConfig: () => mocks.config,
}));
vi.mock('@atlas/integration-omie', () => ({ consultarPedidoCompra: vi.fn() }));
vi.mock('../services/correlacao-produto.service.js', () => ({ sugerirProdutosEmLote: (...a: unknown[]) => mocks.sugerirProdutosEmLote(...a) }));
vi.mock('../services/pc-visto.service.js', () => ({
  registrarPcsVistosSeVencido: (...a: unknown[]) => mocks.registrarPcsVistosSeVencido(...a),
  lerPcsVistos: (...a: unknown[]) => mocks.lerPcsVistos(...a),
}));

import { getFilaNacional, getDetalheNfNacional, montarDetalheNfNacional } from '../services/fila-nacional.service.js';
import { __resetEmpresaNacional } from '../services/empresa-nacional.js';
import {
  __resetColunaRevertido,
  conclusaoFiscalEmSql,
  fiscalRevertidoSql,
  marcadorRevertidoEmSql,
  pendenciaEspelhoEmSql,
  reversaoOmieDoLedgerEmSql,
} from '../services/fiscal-revertido.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'fila-nacional-q2p');
const golden = (nome: string): string => readFileSync(join(GOLDEN, nome), 'utf8').trimEnd();
const goldenParams = (nome: string): unknown => JSON.parse(readFileSync(join(GOLDEN, nome), 'utf8'));

const DUMP = process.env.DUMP_SQL_DIR;
function dump(nome: string, sql: string, params?: unknown[]): void {
  if (!DUMP) return;
  mkdirSync(DUMP, { recursive: true });
  writeFileSync(join(DUMP, nome), sql);
  if (params) writeFileSync(join(DUMP, nome.replace(/\.sql$/, '.params.json')), JSON.stringify(params));
}

/** NF 19252 da Zaraplast (PEBD EB): 4 linhas no recebimento, 13,75 TL = 13.750 kg, todas vinculadas ao mesmo item do PC 308. */
const CHAVE_19252 = '31261061827663002031550010000192521253216947';
const PC308 = { nCodPed: 8518524342, nCodItem: 8518524343, fornecedor: 8389982778 };
const LINHAS_19252 = [
  { seq: 1, qtde: 4.125, valor: 43725.01 },
  { seq: 2, qtde: 1.375, valor: 14575.01 },
  { seq: 3, qtde: 6.875, valor: 72875.02 },
  { seq: 4, qtde: 1.375, valor: 14575.01 },
];

interface Chamada {
  sql: string;
  params: unknown[];
}
const chamadas: Chamada[] = [];
let banco: Banco;
let colunaDa0060: boolean | 'erro' = true;
let reversaoEm: Date | string | null = null;
let falhaDaHoraDaReversao = false;
/** ledgerFiscalVigente: a tentativa do fiscal ainda 'concluido' no ledger (null = nenhuma) */
let ledgerVigente: Record<string, unknown> | null = null;

/** Chaves: a da 016 (fiscal pelo Atlas), o kill switch da D21 (undefined = o default, ligada) e a da ACXE. */
function configurar(o: { fiscal?: boolean; revertido?: boolean | undefined; acxe?: boolean } = {}): void {
  const { fiscal = true, revertido = undefined, acxe = false } = o;
  for (const k of Object.keys(mocks.config)) delete mocks.config[k];
  mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE = CORTE_Q2P;
  mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = fiscal;
  mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED = acxe;
  mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_DATA_CORTE = CORTE_ACXE;
  if (revertido !== undefined) mocks.config.STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED = revertido;
}

beforeEach(() => {
  banco = novoBanco();
  chamadas.length = 0;
  colunaDa0060 = true;
  reversaoEm = null;
  falhaDaHoraDaReversao = false;
  ledgerVigente = null;
  configurar();
  __resetEmpresaNacional();
  __resetColunaRevertido();
  for (const f of Object.values(mocks.logger)) f.mockClear();
  mocks.sugerirProdutosEmLote.mockReset();
  mocks.sugerirProdutosEmLote.mockResolvedValue(new Map());
  mocks.registrarPcsVistosSeVencido.mockReset();
  mocks.registrarPcsVistosSeVencido.mockResolvedValue(undefined);
  mocks.lerPcsVistos.mockReset();
  mocks.lerPcsVistos.mockResolvedValue([]);
  mocks.connect.mockReset();
  // a transacao de marcarLedgerRevertido (ao abrir a NF revertida com a tentativa antiga ainda 'concluido')
  mocks.connect.mockImplementation(async () => ({
    query: async (sql: string, params?: unknown[]) => {
      chamadas.push({ sql, params: params ?? [] });
      if (sql.startsWith('UPDATE stockbridge.recebimento_fiscal rf')) return { rows: [{ id: 'ledger-1', nf_chave_acesso: CHAVE_19252, nota_fiscal: '19252' }] };
      return { rows: [] };
    },
    release: () => {},
  }));
  mocks.poolQuery.mockReset();
  mocks.poolQuery.mockImplementation((sql: string, params?: unknown[]) => {
    chamadas.push({ sql, params: params ?? [] });
    // a coluna da migration 0060 (stockbridge.recebimento_fiscal.revertido_em): presente, ausente ou erro do banco
    if (sql.includes('information_schema') && sql.includes('revertido_em')) {
      return colunaDa0060 === 'erro' ? Promise.reject(new Error('connection reset')) : Promise.resolve({ rows: [{ ok: colunaDa0060 }] });
    }
    // a tentativa do fiscal ainda 'concluido' no ledger (ledgerFiscalVigente; so o detalhe de NF revertida a procura)
    if (sql.includes('SELECT id, status, empresa, n_id_receb, nota_fiscal, fornecedor_nome, finalizado_em')) {
      return Promise.resolve({ rows: ledgerVigente ? [ledgerVigente] : [] });
    }
    // a consulta da hora da reversao (so o detalhe de NF revertida a faz)
    if (/\bAS em\b/.test(sql)) return falhaDaHoraDaReversao ? Promise.reject(new Error('timeout')) : Promise.resolve({ rows: [{ em: reversaoEm }] });
    return responder(banco, sql, params ?? []);
  });
});

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const ehConsultaDaFila = (c: Chamada): boolean => c.sql.includes('HAVING COUNT(*) FILTER (WHERE pendente) > 0');
const sqlFila = (): Chamada => {
  const c = chamadas.find(ehConsultaDaFila);
  if (!c) throw new Error('consulta da fila nao executada');
  return c;
};
const sqlDetalhe = (): Chamada => {
  const c = chamadas.find((x) => x.sql.includes('WITH nf_unificada') && x.sql.includes('WHERE u.c_chave_nfe = $1'));
  if (!c) throw new Error('consulta do detalhe nao executada');
  return c;
};
const sqlSeloPc = (): Chamada | undefined => chamadas.find((c) => c.sql.includes('u.c_chave_nfe = ANY($3::text[])'));
const consultasDaHora = (): Chamada[] => chamadas.filter((c) => /\bAS em\b/.test(c.sql));
const consultasDaColuna0060 = (): Chamada[] => chamadas.filter((c) => c.sql.includes('information_schema') && c.sql.includes('revertido_em'));
/** Os blocos do UNION ALL da fonte unificada (o ultimo leva o resto da consulta). */
const blocos = (sql: string): string[] => sql.split('UNION ALL');

const semHeader = (empresa: 'q2p' | 'acxe'): string =>
  `NOT EXISTS (SELECT 1 FROM public."tbl_nf_header_${empresa === 'acxe' ? 'ACXE' : 'Q2P'}" h2 WHERE h2.c_chave_nfe = r.c_chave_nfe)`;

// ── A D21 LIGADA: o SQL da fila ───────────────────────────────────────────────────────────────────

describe('fila — D21 ligada: o sinal nas duas fontes (Q2P)', () => {
  it('liga so depois de conferir a coluna da migration 0060 (uma vez, sem bind) e antes da consulta da fila', async () => {
    await getFilaNacional();
    const colunas = consultasDaColuna0060();
    expect(colunas).toHaveLength(1);
    expect(colunas[0]!.params).toEqual([]);
    expect(colunas[0]!.sql).toContain("table_schema = 'stockbridge' AND table_name = 'recebimento_fiscal' AND column_name = 'revertido_em'");
    expect(chamadas.indexOf(colunas[0]!)).toBeLessThan(chamadas.indexOf(sqlFila()));
    // conferida uma vez: a segunda fila nao pergunta de novo
    await getFilaNacional();
    expect(consultasDaColuna0060()).toHaveLength(1);
  });

  it('fonte (a): a NF revertida SAI inteira — sufixo AND NOT <sinal> colado em nfValida, sobre a chave do cabecalho; fiscal_revertido false e a ultima coluna', async () => {
    await getFilaNacional();
    const [a, b] = blocos(sqlFila().sql) as [string, string];
    expect(blocos(sqlFila().sql)).toHaveLength(2); // o sinal nao contem UNION ALL
    expect(a).toContain(`AND COALESCE(h.cancelada, false) = false AND NOT ${fiscalRevertidoSql('h.c_chave_nfe', 'q2p')}\n        ) a`);
    // sem sufixo na fonte (b) sobre o cabecalho, e a coluna nova fecha o SELECT da (a)
    expect(a).toContain(`rv.c_unidade_nfe                                     AS u_com_xml,\n               false                                                AS fiscal_revertido\n        FROM (`);
    expect(b).not.toContain('h.c_chave_nfe');
  });

  it('fonte (b): passa por cima da precedencia da (a), entra pelo sinal, sai com fiscal_pendente = NOT (ledger E NOT sinal) e leva fiscal_revertido por ULTIMO', async () => {
    await getFilaNacional();
    const [, b] = blocos(sqlFila().sql) as [string, string];
    const rev = fiscalRevertidoSql('r.c_chave_nfe', 'q2p');
    // precedencia: (NOT EXISTS h2 OR <sinal>); o texto do NOT EXISTS de antes segue como esta
    expect(b).toContain(`AND (${semHeader('q2p')} OR ${rev})`);
    // elegibilidade: acrescenta OR (<sinal>) DEPOIS do ramo do ledger (o marcador pode chegar com a linha do espelho ainda 'S'/etapa 60)
    expect(b).toContain(
      `OR EXISTS (SELECT 1 FROM stockbridge.recebimento_fiscal rf\n            WHERE rf.nf_chave_acesso = r.c_chave_nfe AND rf.status IN ('concluido', 'ja_concluido'))\n             OR (${rev})\n          )`,
    );
    // fiscal pendente: o ledger so vale se o fiscal nao foi revertido (fragmento NOVO; o texto do EXISTS de antes nao muda)
    expect(b).toContain(
      `NOT (EXISTS (SELECT 1 FROM stockbridge.recebimento_fiscal rf\n            WHERE rf.nf_chave_acesso = r.c_chave_nfe AND rf.status IN ('concluido', 'ja_concluido')) AND NOT ${rev})  AS fiscal_pendente,`,
    );
    // a coluna nova e a ULTIMA da fonte: depois de u_com_xml, logo antes do FROM
    expect(b).toContain(`ri.c_unidade_nfe                                     AS u_com_xml,\n               ${rev}  AS fiscal_revertido\n        FROM public."tbl_recebimentoNFe_Q2P" r`);
  });

  it('o sinal e a chave de acesso + horas de EVENTO do OMIE (d_alt/h_alt), com margem de 2 min e fuso explicito — nunca n_id_receb nem synced_at', async () => {
    await getFilaNacional();
    const { sql } = sqlFila();
    const rev = fiscalRevertidoSql('r.c_chave_nfe', 'q2p');
    expect(rev).toContain("interval '2 minutes'");
    expect(rev).toContain("AT TIME ZONE 'America/Sao_Paulo'");
    expect(rev).toContain('d_alt');
    expect(rev).toContain('h_alt');
    expect(rev).not.toMatch(/n_id_receb|synced_at/);
    // as 3 evidencias de conclusao + a pendencia do espelho + o marcador do ledger estao no SQL da fila
    expect(sql).toContain(conclusaoFiscalEmSql('r.c_chave_nfe', 'q2p'));
    expect(sql).toContain(pendenciaEspelhoEmSql('r.c_chave_nfe', 'q2p'));
    expect(sql).toContain(marcadorRevertidoEmSql('r.c_chave_nfe'));
    // o espelho da Q2P e o unico lido (a ACXE esta desligada)
    expect(sql).not.toContain('ACXE');
    // regra do arquivo fila-nacional.test.ts: h.n_id_receb so aparece no SELECT da fonte (a), uma vez
    expect(sql.match(/\bh\.n_id_receb\b/g) ?? []).toEqual(['h.n_id_receb']);
  });

  it('sem bind novo: os parametros sao exatamente os da fila sem a D21 (a numeracao $n e os .params.json nao mudam)', async () => {
    await getFilaNacional();
    expect(sqlFila().params).toEqual([CFOPS, CORTE_Q2P]);
    expect(sqlFila().params).toEqual(goldenParams('fila-fiscal-ligado.params.json'));
    chamadas.length = 0;
    await getFilaNacional({ q: '667', fornecedor: 'ISOFORMA' });
    expect(sqlFila().params).toEqual(goldenParams('fila-fiscal-ligado-filtros.params.json'));
    expect(sqlFila().sql).toContain("ltrim(u.n_nf, '0') ILIKE $4");
  });

  it('espelho de recebimentos defasado: o aviso do log diz que as reversoes tambem podem nao ser percebidas (sem a D21, o texto de antes)', async () => {
    banco.idadeEspelho.q2p = 500;
    await getFilaNacional();
    expect(mocks.logger.warn.mock.calls.some((c) => String(c[1]).endsWith('podem estar faltando na fila e reversões do fiscal no OMIE podem não ser percebidas'))).toBe(true);
    mocks.logger.warn.mockClear();
    configurar({ revertido: false });
    await getFilaNacional();
    expect(mocks.logger.warn.mock.calls.some((c) => String(c[1]).endsWith('NFs com fiscal pendente podem estar faltando na fila'))).toBe(true);
    expect(mocks.logger.warn.mock.calls.some((c) => String(c[1]).includes('reversões'))).toBe(false);
  });

  it('as CTEs carregam o sinal: linhas -> itens -> select final; estoque ja lancado ignora a linha revertida; a data do Atlas some', async () => {
    await getFilaNacional();
    const n = norm(sqlFila().sql);
    expect(n).toContain('u.fiscal_pendente, u.fiscal_revertido, upper(regexp_replace(');
    // D7: a linha do espelho de uma NF revertida pode estar defasada com 'S' — nao e estoque lancado
    expect(n).toContain("(NOT u.fiscal_revertido AND u.receb_recebido = 'S' AND u.c_ignorar_item = 'N' AND u.c_nao_gerar_mov_estoque = 'N') AS estoque_lancado");
    expect(n).toContain('bool_or(estoque_lancado) AS estoque_lancado, bool_or(fiscal_revertido) AS fiscal_revertido FROM linhas');
    expect(n).toContain('COALESCE(bool_or(fiscal_revertido), false) AS fiscal_revertido FROM itens_flag');
    expect(n).toContain("CASE WHEN bool_or(fiscal_revertido) THEN NULL::text ELSE (SELECT MAX(rf.finalizado_em) FROM stockbridge.recebimento_fiscal rf WHERE rf.nf_chave_acesso = c_chave_nfe AND rf.status = 'concluido')::text END AS fiscal_concluido_em");
    // a pendencia continua sendo FISICA (movimentacao ativa): o sinal nao entra em `pendente`
    expect(n).toContain('(NOT recebido OR (nf_kg IS NOT NULL AND nf_atribuida > 0 AND GREATEST(0, LEAST(');
    dump('fila-revertido-q2p.sql', sqlFila().sql, sqlFila().params);
  });

  it('a D21 so liga com a chave da 016 EM QUALQUER posicao do ACXE: a fila so da ACXE (sem a Q2P) tambem leva o sinal, do espelho da ACXE', async () => {
    configurar({ acxe: true });
    await getFilaNacional({ empresa: 'acxe' });
    const { sql, params } = sqlFila();
    const [aNf, aRec] = blocos(sql) as [string, string];
    expect(aNf).toContain(`AND NOT ${fiscalRevertidoSql('h.c_chave_nfe', 'acxe')}`);
    expect(aRec).toContain(`OR (${fiscalRevertidoSql('r.c_chave_nfe', 'acxe')})`);
    expect(sql).not.toContain('_Q2P"');
    expect(params).toEqual([CFOPS, CORTE_ACXE]);
  });
});

// ── Mapeamento da fila ─────────────────────────────────────────────────────────────────────────────

describe('fila — D21 ligada: o que a tela recebe', () => {
  it('NF revertida (19252): fiscal pendente + fiscalRevertido, SEM a data de conclusao do Atlas (mesmo que a consulta a devolvesse)', async () => {
    banco.fila = [
      linhaFila({
        nf_chave_acesso: CHAVE_19252, nota_fiscal: '19252', fornecedor_nome: 'ZARAPLAST SA', fiscal: 'pendente', fiscal_revertido: true,
        fiscal_concluido_em: '2026-10-25 20:02:01.437994+00', itens_total: 1, itens_pendentes: 1, valor_total_brl: 145750.05,
      }),
    ];
    const [f] = await getFilaNacional();
    expect(f).toMatchObject({ notaFiscal: '19252', fiscal: 'pendente', fiscalRevertido: true, fiscalConcluidoPeloAtlasEm: null, empresa: 'q2p', valorTotalBrl: 145750.05 });
  });

  it('NF NAO revertida: igual a hoje — fiscal ja feito pelo Atlas mantem a data e fiscalRevertido e false', async () => {
    banco.fila = [
      linhaFila({ fiscal: 'concluido', fiscal_revertido: false, fiscal_concluido_em: '2026-10-02 10:15:00+00' }),
      linhaFila({ nf_chave_acesso: '3'.repeat(44), nota_fiscal: '7000', fiscal: 'pendente', fiscal_revertido: false, fiscal_concluido_em: null }),
    ];
    const fila = await getFilaNacional();
    expect(fila[0]).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false, fiscalConcluidoPeloAtlasEm: new Date('2026-10-02 10:15:00+00').toISOString() });
    expect(fila[1]).toMatchObject({ fiscal: 'pendente', fiscalRevertido: false });
  });

  it('fiscalRevertido sai SEMPRE no item, false quando a coluna nao veio (D21 desligada ou backend de outra versao)', async () => {
    banco.fila = [linhaFila({ fiscal: 'concluido' })];
    expect((await getFilaNacional())[0]!.fiscalRevertido).toBe(false);
    configurar({ revertido: false });
    banco.fila = [linhaFila({ fiscal: 'concluido', fiscal_revertido: true })]; // dado impossivel com a D21 desligada: so true literal vale
    expect((await getFilaNacional())[0]!.fiscalRevertido).toBe(true);
    banco.fila = [linhaFila({ fiscal: 'concluido', fiscal_revertido: null })];
    expect((await getFilaNacional())[0]!.fiscalRevertido).toBe(false);
  });

  it('o selo do PC enxerga a NF revertida (fiscal pendente): a consulta dos itens leva o MESMO sinal e filtra u.fiscal_pendente', async () => {
    configurar({ revertido: undefined });
    mocks.config.STOCKBRIDGE_PC_UNIDADE_DIFERENTE = 'converter'; // o fiscal da 19252 rodou em modo converter (PC em kg, nota em toneladas)
    banco.fila = [linhaFila({ nf_chave_acesso: CHAVE_19252, nota_fiscal: '19252', fiscal: 'pendente', fiscal_revertido: true })];
    banco.pcFila.q2p = LINHAS_19252.map((l) =>
      linhaPcFila({
        c_chave_nfe: CHAVE_19252, x_prod: 'PEBD EB', desc_norm: 'PEBD EB', q_com: l.qtde, u_com: 'TL', valor_item: l.valor, preco_comercial: 10095.24, n_seq: l.seq,
        n_id_pedido: String(PC308.nCodPed), n_id_it_pedido: String(PC308.nCodItem), fornecedor_codigo: String(PC308.fornecedor),
      }),
    );
    banco.copiaPcs.q2p = [itemPc308()];
    const [f] = await getFilaNacional();
    expect(f).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true, pcSituacao: 'vinculado_omie' });
    const selo = sqlSeloPc()!;
    expect(selo.params).toEqual([CFOPS, CORTE_Q2P, [CHAVE_19252]]);
    expect(selo.sql).toContain(`NOT (EXISTS (SELECT 1 FROM stockbridge.recebimento_fiscal rf`);
    expect(selo.sql).toContain(`AND NOT ${fiscalRevertidoSql('h.c_chave_nfe', 'q2p')}`);
    expect(selo.sql).toContain('WHERE u.c_chave_nfe = ANY($3::text[]) AND u.fiscal_pendente');
    dump('fila-revertido-pc-situacao.sql', selo.sql, selo.params);
  });
});

// ── O DETALHE ────────────────────────────────────────────────────────────────────────────────────────

/** Item de PC da copia: o PC 308 da Zaraplast, em KG (a nota vem em toneladas), 13.750 kg a R$ 10,60. */
const itemPc308 = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  itemPc580({
    ncodped: String(PC308.nCodPed), ncoditem: String(PC308.nCodItem), cnumero: '308', ncodfor: String(PC308.fornecedor), nqtde: 13750, nvalunit: 10.6,
    valor_total_pc: 145750, cdescricao: 'PEBD EB', cproduto: 'PEBDEB', cnpj_cadastro: '61827663002031', ncodprod: null, codigo_local_estoque: null, ...over,
  });

/** As 4 linhas da 19252 como a fonte (b) as devolve com o fiscal revertido (recebimento N/40, itens com "nao movimentar estoque" e vinculo com o PC). */
const detalhe19252 = (over: Record<string, unknown> = {}): Array<Record<string, unknown>> =>
  LINHAS_19252.map((l) =>
    linhaDetalhe({
      nf_chave_acesso: CHAVE_19252, n_nf: '000019252', nota_fiscal: '19252', fornecedor_nome: 'ZARAPLAST SA', fornecedor_cnpj: '61.827.663/0020-31',
      n_id_receb: '8518467850', n_cod_item: String(l.seq), n_seq: l.seq, x_prod: 'PEBD EB', desc_norm: 'PEBD EB', cfop: '2.102', q_com: l.qtde, u_com: 'TL',
      valor_item: l.valor, preco_comercial: 10095.24, fornecedor_codigo: String(PC308.fornecedor), n_id_pedido: String(PC308.nCodPed),
      n_id_it_pedido: String(PC308.nCodItem), c_nao_gerar_mov_estoque: 'S', receb_recebido: 'N', fiscal_pendente: true, fiscal_revertido: true, ledger_concluido: false,
      ...over,
    }),
  );

describe('detalhe — D21 ligada', () => {
  it('SQL: ledger_concluido so vale se NAO revertido e a coluna fiscal_revertido fecha o SELECT; a fonte unificada leva o sinal; a chave valida vem antes', async () => {
    banco.detalhe = detalhe19252();
    await getDetalheNfNacional(CHAVE_19252);
    const { sql, params } = sqlDetalhe();
    const n = norm(sql);
    expect(n).toContain("(EXISTS (SELECT 1 FROM stockbridge.recebimento_fiscal rf WHERE rf.nf_chave_acesso = u.c_chave_nfe AND rf.status IN ('concluido', 'ja_concluido')) AND NOT u.fiscal_revertido) AS ledger_concluido, u.fiscal_revertido AS fiscal_revertido FROM nf_unificada u");
    // o detalhe nao aplica nfValida (le as flags): o sufixo do sinal vem sozinho na linha do WHERE
    expect(sql).toContain(`AND h.d_emi >= $2::date\n            AND NOT ${fiscalRevertidoSql('h.c_chave_nfe', 'q2p')}\n        ) a`);
    expect(sql).toContain(`AND (${semHeader('q2p')} OR ${fiscalRevertidoSql('r.c_chave_nfe', 'q2p')})`);
    expect(params).toEqual([CHAVE_19252, CORTE_Q2P]);
    expect(params).toEqual([CHAVE_19252, ...(goldenParams('detalhe-fiscal-ligado.params.json') as unknown[]).slice(1)]);
    dump('detalhe-revertido-q2p.sql', sql, params);
  });

  it('NF 19252 revertida PELO ESPELHO: fiscal pendente + fiscalRevertido, as 4 linhas (13.750 kg) e o vinculo do OMIE com o PC 308; a hora vem do espelho', async () => {
    mocks.config.STOCKBRIDGE_PC_UNIDADE_DIFERENTE = 'converter';
    reversaoEm = new Date('2026-10-25T20:13:36.000Z'); // 17:13:36 em Brasilia
    banco.detalhe = detalhe19252();
    banco.copiaPcs.q2p = [itemPc308()];
    const d = await getDetalheNfNacional(CHAVE_19252);
    expect(d).toMatchObject({
      notaFiscal: '19252', empresa: 'q2p', fiscal: 'pendente', fiscalRevertido: true, fiscalRevertidoEm: '2026-10-25T20:13:36.000Z',
      nIdReceb: 8518467850, dispensavel: true, estoqueLancadoPeloOmie: false, copiaPcsDefasada: false,
    });
    // 4 linhas da mesma descricao agregadas num item: 13,75 TL = 13.750 kg
    expect(d.itens).toHaveLength(1);
    expect(d.itens[0]).toMatchObject({ descricaoFornecedor: 'PEBD EB', linhasAgregadas: 4, jaRecebido: false, sequenciasRecebimento: [1, 2, 3, 4], unidadeOriginal: 'TL' });
    expect(d.itens[0]!.quantidadeNfKg).toBeCloseTo(13750, 3);
    expect(d.itens[0]!.valorTotalItemBrl).toBeCloseTo(145750.05, 2);
    expect(d.valorTotalBrl).toBeCloseTo(145750.05, 2);
    // o vinculo do OMIE com o PC 308 (preservado pela reversao) e a sugestao de PC voltam: a NF e tratada como qualquer fiscal pendente
    expect(d.itens[0]!.pc!.vinculoOmie).toMatchObject({ pcNumero: '308', dentroTolerancia: true });
    expect(d.itens[0]!.pc!.preSelecionado).toEqual({ nCodPed: PC308.nCodPed, nCodItem: PC308.nCodItem });
    expect(d.pcsDaNf.preSelecionado).toBe(PC308.nCodPed);
    // a hora: UMA consulta, para a chave da NF, nos espelhos da Q2P
    expect(consultasDaHora()).toHaveLength(1);
    expect(consultasDaHora()[0]!.params).toEqual([CHAVE_19252]);
    expect(consultasDaHora()[0]!.sql).toContain('"tbl_recebimentoNFe_Q2P"');
    expect(consultasDaHora()[0]!.sql).not.toContain('_ACXE"');
  });

  it('a hora da reversao: o espelho quando e posterior a conclusao (margem de 2 min), senao o marcador do ledger — nunca a hora de ANTES da conclusao', async () => {
    banco.detalhe = detalhe19252();
    await getDetalheNfNacional(CHAVE_19252);
    const { sql } = consultasDaHora()[0]!;
    const pend = pendenciaEspelhoEmSql('$1::text', 'q2p');
    expect(sql).toContain(`CASE WHEN ${pend} - interval '2 minutes' > ${conclusaoFiscalEmSql('$1::text', 'q2p')}`);
    expect(sql).toContain(`THEN ${pend}`);
    // sem a hora do espelho, so a hora do OMIE gravada pela marcacao (nula na leitura ao vivo: a hora do clique nao e a da reversao)
    expect(sql).toContain(`ELSE ${reversaoOmieDoLedgerEmSql('$1::text')} END AS em`);
    dump('detalhe-revertido-em.sql', sql, consultasDaHora()[0]!.params);
  });

  it('a hora da reversao aceita o texto do driver e some (null) se o banco nao a trouxer ou falhar — o detalhe nunca cai por causa dela', async () => {
    banco.detalhe = detalhe19252();
    reversaoEm = '2026-10-25 17:13:36-03';
    expect((await getDetalheNfNacional(CHAVE_19252)).fiscalRevertidoEm).toBe('2026-10-25T20:13:36.000Z');
    reversaoEm = null;
    expect((await getDetalheNfNacional(CHAVE_19252)).fiscalRevertidoEm).toBeNull();
    reversaoEm = 'nao e data';
    expect((await getDetalheNfNacional(CHAVE_19252)).fiscalRevertidoEm).toBeNull();
    falhaDaHoraDaReversao = true;
    const d = await getDetalheNfNacional(CHAVE_19252);
    expect(d).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true, fiscalRevertidoEm: null });
    expect(mocks.logger.warn.mock.calls.some((c) => String(c[1]).includes('Hora da reversão do fiscal indisponível'))).toBe(true);
  });

  it('revertida PELO MARCADOR do ledger com a linha do espelho ainda "S"/etapa 60: nao e estoque lancado pelo OMIE (a linha esta defasada) — a mesma linha sem o sinal e', async () => {
    const defasada = { receb_recebido: 'S', c_ignorar_item: 'N', c_nao_gerar_mov_estoque: 'N' };
    banco.detalhe = detalhe19252(defasada);
    const d = await getDetalheNfNacional(CHAVE_19252);
    expect(d).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true, estoqueLancadoPeloOmie: false });
    // controle: NF de fiscal concluido no portal COM movimento de estoque (sem sinal) continua bloqueando o recebimento (D7)
    banco.detalhe = detalhe19252({ ...defasada, fiscal_pendente: false, fiscal_revertido: false });
    expect((await getDetalheNfNacional(CHAVE_19252)).estoqueLancadoPeloOmie).toBe(true);
  });

  it('NF NAO revertida: igual a hoje — fiscalRevertido false, fiscalRevertidoEm null e a consulta da hora NEM roda', async () => {
    banco.detalhe = [linhaDetalhe({ fiscal_pendente: false, fiscal_revertido: false, ledger_concluido: true, receb_recebido: 'S', c_nao_gerar_mov_estoque: 'S' })];
    const d = await getDetalheNfNacional(CHAVE_Q2P);
    expect(d).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false, fiscalRevertidoEm: null, estoqueLancadoPeloOmie: false });
    expect(consultasDaHora()).toHaveLength(0);
    // e o fiscal pendente comum (NF nova da SEFAZ) tambem
    banco.detalhe = [linhaDetalhe({ fiscal_revertido: false })];
    expect(await getDetalheNfNacional(CHAVE_Q2P)).toMatchObject({ fiscal: 'pendente', fiscalRevertido: false, fiscalRevertidoEm: null });
    expect(consultasDaHora()).toHaveLength(0);
  });

  it('ledger_concluido (linha do detalhe) continua confirmando a conclusao: espelhoConfirmaConclusao nao mudou (regra da D7)', async () => {
    const confirma = async (over: Record<string, unknown>): Promise<boolean> => {
      banco.detalhe = [linhaDetalhe({ fiscal_pendente: false, fiscal_revertido: false, c_nao_gerar_mov_estoque: 'S', ...over })];
      return (await montarDetalheNfNacional(CHAVE_Q2P)).interno.espelhoConfirmaConclusao;
    };
    expect(await confirma({ receb_recebido: 'N', ledger_concluido: true })).toBe(true);
    expect(await confirma({ receb_recebido: 'N', ledger_concluido: false })).toBe(false);
    expect(await confirma({ receb_recebido: 'S', ledger_concluido: false })).toBe(true);
  });

  it('NF revertida SEM item a receber (a entrada fisica ja foi lancada): o detalhe responde com fiscalRevertido, para a tela avisar que o fiscal precisa ser refeito', async () => {
    banco.detalhe = detalhe19252({ recebido: true, nf_ja_atribuida_kg: 13750, conferida_ja_gravada_kg: 13750 });
    const d = await getDetalheNfNacional(CHAVE_19252);
    expect(d).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true, dispensavel: false });
    expect(d.itens[0]).toMatchObject({ jaRecebido: true, quantidadeRestanteKg: 0 });
  });

  it('o resto do POST segue o fiscal pendente: o detalhe interno da NF revertida traz o PC por item, como qualquer fiscal pendente', async () => {
    mocks.config.STOCKBRIDGE_PC_UNIDADE_DIFERENTE = 'converter';
    banco.detalhe = detalhe19252();
    banco.copiaPcs.q2p = [itemPc308()];
    const { detalhe, interno } = await montarDetalheNfNacional(CHAVE_19252);
    expect(detalhe.fiscal).toBe('pendente');
    expect(interno.fornecedorCodigo).toBe(PC308.fornecedor);
    expect(Array.from(interno.pcPorIndice.keys())).toEqual([0]);
    expect(interno.pcPorIndice.get(0)!.resultado).not.toBeNull();
  });
});

describe('fila — D21: a NF revertida com a tentativa antiga ainda "concluido" e marcada antes do selo do PC', () => {
  const vigente = { id: 'ledger-1', status: 'concluido', empresa: 'q2p', n_id_receb: '8518467850', nota_fiscal: '19252', fornecedor_nome: 'ZARAPLAST SA', finalizado_em: '2026-10-25T20:02:01.437Z' };

  it('com a tentativa vigente: marca (re-conferindo o sinal) ANTES da consulta do selo do PC; NF nao revertida: nada', async () => {
    ledgerVigente = vigente;
    banco.fila = [linhaFila({ nf_chave_acesso: CHAVE_19252, fiscal: 'pendente', fiscal_revertido: true })];
    await getFilaNacional();
    const marcacao = chamadas.findIndex((c) => c.sql.startsWith('UPDATE stockbridge.recebimento_fiscal rf'));
    expect(marcacao).toBeGreaterThan(chamadas.indexOf(sqlFila()));
    const selo = sqlSeloPc();
    if (selo) expect(marcacao).toBeLessThan(chamadas.indexOf(selo));
    const upd = chamadas[marcacao]!;
    expect(upd.params).toEqual([CHAVE_19252, 'espelho', null]);
    // o UPDATE re-confere o sinal no espelho da empresa da linha da fila
    expect(norm(upd.sql)).toContain(`AND ${norm(fiscalRevertidoSql('rf.nf_chave_acesso', 'q2p'))}`);
    expect(upd.sql).not.toContain('_ACXE"');
  });

  it('NF revertida da ACXE: a marcacao re-confere o sinal no espelho da ACXE (a empresa vem da linha da fila)', async () => {
    configurar({ acxe: true });
    ledgerVigente = { ...vigente, empresa: 'acxe' };
    banco.fila = [linhaFilaAcxe({ fiscal: 'pendente', fiscal_revertido: true })];
    await getFilaNacional();
    const upd = chamadas.find((c) => c.sql.startsWith('UPDATE stockbridge.recebimento_fiscal rf'))!;
    expect(upd.params).toEqual([CHAVE_ACXE, 'espelho', null]);
    expect(norm(upd.sql)).toContain(`AND ${norm(fiscalRevertidoSql('rf.nf_chave_acesso', 'acxe'))}`);
    expect(upd.sql).not.toContain('_Q2P"');
  });

  it('NF nao revertida na fila: nem procura a tentativa vigente', async () => {
    ledgerVigente = vigente;
    banco.fila = [linhaFila({ fiscal: 'pendente', fiscal_revertido: false })];
    await getFilaNacional();
    expect(chamadas.some((c) => c.sql.includes('SELECT id, status, empresa, n_id_receb'))).toBe(false);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});

describe('detalhe — D21: a tentativa antiga do fiscal ainda "concluido" e marcada ao abrir a NF revertida', () => {
  const vigente = { id: 'ledger-1', status: 'concluido', empresa: 'q2p', n_id_receb: '8518467850', nota_fiscal: '19252', fornecedor_nome: 'ZARAPLAST SA', finalizado_em: '2026-10-25T20:02:01.437Z' };
  const idx = (pred: (c: Chamada) => boolean): number => chamadas.findIndex(pred);
  const ehMarcacao = (c: Chamada): boolean => c.sql.startsWith('UPDATE stockbridge.recebimento_fiscal rf');
  const ehVinculosDaMarcacao = (c: Chamada): boolean => c.sql.includes('UPDATE stockbridge.recebimento_fiscal_pc');

  it('com a tentativa ainda vigente: marca (re-conferindo o sinal) ANTES da sugestao de PC — os vinculos dela saem do saldo do PC', async () => {
    mocks.config.STOCKBRIDGE_PC_UNIDADE_DIFERENTE = 'converter';
    ledgerVigente = vigente;
    banco.detalhe = detalhe19252();
    banco.copiaPcs.q2p = [itemPc308()];
    const d = await getDetalheNfNacional(CHAVE_19252);
    expect(d).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true });
    const i = idx(ehMarcacao);
    expect(i).toBeGreaterThan(-1);
    const upd = chamadas[i]!;
    expect(upd.params).toEqual([CHAVE_19252, 'espelho', null]);
    expect(norm(upd.sql)).toContain(`AND ${norm(fiscalRevertidoSql('rf.nf_chave_acesso', 'q2p'))}`);
    expect(idx(ehVinculosDaMarcacao)).toBeGreaterThan(i);
    // a marcacao vem depois da consulta do detalhe e antes de qualquer leitura do ledger de PC (saldo/reservas da sugestao)
    expect(i).toBeGreaterThan(chamadas.indexOf(sqlDetalhe()));
    const primeiraDoLedgerDePc = idx((c) => !ehVinculosDaMarcacao(c) && c.sql.includes('recebimento_fiscal_pc'));
    if (primeiraDoLedgerDePc > -1) expect(i).toBeLessThan(primeiraDoLedgerDePc);
  });

  it('sem tentativa vigente (ja marcada pelo clique ou pela varredura): nada a marcar, nenhuma transacao aberta', async () => {
    banco.detalhe = detalhe19252();
    await getDetalheNfNacional(CHAVE_19252);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(idx(ehMarcacao)).toBe(-1);
  });

  it('NF NAO revertida: nem procura a tentativa vigente', async () => {
    ledgerVigente = vigente;
    banco.detalhe = [linhaDetalhe({ fiscal_pendente: false, fiscal_revertido: false, ledger_concluido: true, receb_recebido: 'S', c_nao_gerar_mov_estoque: 'S' })];
    await getDetalheNfNacional(CHAVE_Q2P);
    expect(chamadas.some((c) => c.sql.includes('SELECT id, status, empresa, n_id_receb'))).toBe(false);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('a marcacao falhou: o detalhe segue (o clique e a varredura marcam depois), com aviso no log', async () => {
    ledgerVigente = vigente;
    mocks.connect.mockRejectedValue(new Error('too many clients'));
    banco.detalhe = detalhe19252();
    const d = await getDetalheNfNacional(CHAVE_19252);
    expect(d).toMatchObject({ fiscal: 'pendente', fiscalRevertido: true });
    expect(mocks.logger.warn.mock.calls.some((c) => String(c[1]).includes('tentativa antiga do fiscal ao abrir a NF'))).toBe(true);
  });
});

// ── D21 INDISPONIVEL: o SQL e o de antes, byte a byte ─────────────────────────────────────────────────

describe('D21 indisponivel — nenhum fragmento novo: o SQL e o de antes', () => {
  const igualAoGolden = (sql: string, params: unknown[], nomeSql: string, nomeParams: string): void => {
    expect(sql.trimEnd()).toBe(golden(nomeSql));
    expect(params).toEqual(goldenParams(nomeParams));
  };

  it('sem a migration 0060 (coluna ausente): fila e detalhe saem IGUAIS aos goldens *-ligado, o erro vai ao log e fiscalRevertido e false', async () => {
    colunaDa0060 = false;
    banco.fila = [linhaFila({ fiscal: 'pendente' })];
    banco.detalhe = [linhaDetalhe()];
    const [f] = await getFilaNacional();
    expect(f).toMatchObject({ fiscal: 'pendente', fiscalRevertido: false });
    igualAoGolden(sqlFila().sql, sqlFila().params, 'fila-fiscal-ligado.sql', 'fila-fiscal-ligado.params.json');
    const d = await getDetalheNfNacional(CHAVE_Q2P);
    expect(d).toMatchObject({ fiscal: 'pendente', fiscalRevertido: false, fiscalRevertidoEm: null });
    igualAoGolden(sqlDetalhe().sql, sqlDetalhe().params, 'detalhe-fiscal-ligado.sql', 'detalhe-fiscal-ligado.params.json');
    expect(mocks.logger.error.mock.calls.some((c) => String(c[0]).includes('revertido_em ausente'))).toBe(true);
    expect(consultasDaHora()).toHaveLength(0);
  });

  it('erro do banco ao conferir a coluna: tratada como ausente (SQL de antes) — a fila nunca cai por isso', async () => {
    colunaDa0060 = 'erro';
    banco.fila = [linhaFila({ fiscal: 'concluido' })];
    const [f] = await getFilaNacional();
    expect(f!.fiscalRevertido).toBe(false);
    igualAoGolden(sqlFila().sql, sqlFila().params, 'fila-fiscal-ligado.sql', 'fila-fiscal-ligado.params.json');
  });

  it('kill switch STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED=false: nem pergunta pela coluna da 0060 e o SQL e o dos goldens *-ligado', async () => {
    configurar({ revertido: false });
    banco.detalhe = [linhaDetalhe()];
    await getFilaNacional();
    await getDetalheNfNacional(CHAVE_Q2P);
    expect(consultasDaColuna0060()).toHaveLength(0);
    igualAoGolden(sqlFila().sql, sqlFila().params, 'fila-fiscal-ligado.sql', 'fila-fiscal-ligado.params.json');
    igualAoGolden(sqlDetalhe().sql, sqlDetalhe().params, 'detalhe-fiscal-ligado.sql', 'detalhe-fiscal-ligado.params.json');
  });

  it('chave da 016 DESLIGADA (a D21 depende dela): nenhum fragmento novo, nenhuma consulta a coluna da 0060 — SQL dos goldens *-desligado', async () => {
    configurar({ fiscal: false });
    banco.detalhe = [linhaDetalhe({ fiscal_pendente: false })];
    await getFilaNacional();
    await getDetalheNfNacional(CHAVE_Q2P);
    expect(consultasDaColuna0060()).toHaveLength(0);
    igualAoGolden(sqlFila().sql, sqlFila().params, 'fila-fiscal-desligado.sql', 'fila-fiscal-desligado.params.json');
    igualAoGolden(sqlDetalhe().sql, sqlDetalhe().params, 'detalhe-fiscal-desligado.sql', 'detalhe-fiscal-desligado.params.json');
    // (nf_dispensa.revertido_em e a reversao da DISPENSA, de outra feature: o marcador do ledger e o alias rfr)
    expect(sqlFila().sql).not.toMatch(/fiscal_revertido|rfr\.|d_alt|h_alt/);
    expect(sqlDetalhe().sql).not.toMatch(/fiscal_revertido|rfr\.|d_alt|h_alt/);
  });

  it('a D21 ligada gera os goldens *-revertido (e so eles): o mesmo codigo, o kill switch no default', async () => {
    banco.fila = [linhaFila({ fiscal: 'pendente' })]; // fiscal pendente: e ele que dispara a consulta do selo do PC
    banco.detalhe = [linhaDetalhe()];
    await getFilaNacional();
    await getDetalheNfNacional(CHAVE_Q2P);
    expect(sqlFila().sql.trimEnd()).toBe(golden('fila-fiscal-ligado-revertido.sql'));
    expect(sqlFila().sql.trimEnd()).not.toBe(golden('fila-fiscal-ligado.sql'));
    expect(sqlDetalhe().sql.trimEnd()).toBe(golden('detalhe-fiscal-ligado-revertido.sql'));
    expect(sqlSeloPc()?.sql.trimEnd()).toBe(golden('fila-pc-situacao-revertido.sql'));
  });
});

// ── As duas empresas ─────────────────────────────────────────────────────────────────────────────────

describe('D21 com a ACXE habilitada: o sinal e do espelho da PROPRIA empresa do bloco', () => {
  beforeEach(() => configurar({ acxe: true }));

  it('fila: 4 blocos (UNION ALL nao entra no sinal), cada sinal no espelho da sua empresa, corte da ACXE em $3 e parametros de sempre', async () => {
    await getFilaNacional();
    const { sql, params } = sqlFila();
    const b = blocos(sql);
    expect(b).toHaveLength(4);
    expect(params).toEqual([CFOPS, CORTE_Q2P, CORTE_ACXE]);
    const [qNf, qRec, aNf, aRec] = b as [string, string, string, string];
    for (const [bloco, empresa, alias] of [[qNf, 'q2p', 'h'], [qRec, 'q2p', 'r'], [aNf, 'acxe', 'h'], [aRec, 'acxe', 'r']] as const) {
      expect(bloco).toContain(fiscalRevertidoSql(`${alias}.c_chave_nfe`, empresa));
      expect(bloco).toContain('fiscal_revertido');
    }
    for (const q of [qNf, qRec]) expect(q).not.toContain('_ACXE"');
    for (const a of [aNf, aRec]) expect(a).not.toContain('_Q2P"');
    // (a) false literal e (b) o sinal, como ULTIMA coluna, em cada empresa
    expect(norm(qNf)).toContain("rv.c_unidade_nfe AS u_com_xml, false AS fiscal_revertido FROM (");
    expect(norm(aNf)).toContain("rv.c_unidade_nfe AS u_com_xml, false AS fiscal_revertido FROM (");
    expect(norm(qRec)).toMatch(/ri\.c_unidade_nfe AS u_com_xml, COALESCE\(GREATEST\(.*AS fiscal_revertido FROM public\."tbl_recebimentoNFe_Q2P" r/);
    expect(norm(aRec)).toMatch(/ri\.c_unidade_nfe AS u_com_xml, COALESCE\(GREATEST\(.*AS fiscal_revertido FROM public\."tbl_recebimentoNFe_ACXE" r/);
    // os tokens contados por fila-nacional-acxe.test.ts nao mudam: o sinal usa outros aliases (hnc, rrp, rrc)
    const n = norm(sql);
    expect(n.split('h.tp_nf = 0')).toHaveLength(3);
    expect(n.split('COALESCE(h.deletada, false) = false').length - 1).toBe(2);
    expect(n.split('COALESCE(h.cancelada, false) = false').length - 1).toBe(2);
    expect(n).toContain('GROUP BY c_chave_nfe, n_nf, dest_razao, dest_cnpj_cpf, d_emi, desc_norm, empresa');
    expect(n).toMatch(/AS estoque_lancado, COALESCE\(bool_or\(fiscal_revertido\), false\) AS fiscal_revertido, empresa FROM itens_flag/);
    dump('fila-revertido-q2p-acxe.sql', sql, params);
  });

  it('information_schema: UMA consulta pela coluna da 0060 (sem bind, antes das outras) e uma por espelho de NF para a coluna `cancelada`, como antes', async () => {
    await getFilaNacional();
    const info = chamadas.filter((c) => c.sql.includes('information_schema')).map((c) => c.params);
    expect(info).toEqual([[], ['tbl_nf_header_Q2P'], ['tbl_nf_header_ACXE']]);
    // a fila so da ACXE: a coluna da 0060 (conferida de novo: o cache do modulo foi zerado) + o espelho de NF da ACXE
    chamadas.length = 0;
    __resetColunaRevertido();
    await getFilaNacional({ empresa: 'acxe' });
    expect(chamadas.filter((c) => c.sql.includes('information_schema')).map((c) => c.params)).toEqual([[], ['tbl_nf_header_ACXE']]);
  });

  it('fila: so a Q2P (empresa=q2p com a ACXE ligada) e o SQL da Q2P com a D21 — o golden *-revertido, byte a byte', async () => {
    await getFilaNacional({ empresa: 'q2p' });
    expect(sqlFila().sql.trimEnd()).toBe(golden('fila-fiscal-ligado-revertido.sql'));
    expect(sqlFila().params).toEqual(goldenParams('fila-fiscal-ligado.params.json'));
  });

  it('espelho da ACXE ausente (42P01): a repeticao so com a Q2P mantem a D21 da Q2P (golden *-revertido) e o aviso de ACXE fora da fila', async () => {
    banco.falhas.push(falhaTabelaAcxe());
    await getFilaNacional();
    const tentativas = chamadas.filter(ehConsultaDaFila);
    expect(tentativas).toHaveLength(2);
    expect(tentativas[0]!.sql).toContain('_ACXE"');
    expect(tentativas[1]!.sql.trimEnd()).toBe(golden('fila-fiscal-ligado-revertido.sql'));
    expect(tentativas[1]!.params).toEqual(goldenParams('fila-fiscal-ligado.params.json'));
    expect(mocks.logger.error.mock.calls.some((c) => String(c[1]).includes('Consulta da ACXE falhou'))).toBe(true);
  });

  it('fila: NF revertida da ACXE chega com empresa acxe, fiscal pendente e o selo do PC vem da copia da ACXE', async () => {
    banco.fila = [
      linhaFilaAcxe({ fiscal: 'pendente', fiscal_revertido: true, fiscal_concluido_em: '2026-10-25 20:02:01+00' }),
      linhaFila({ fiscal: 'concluido', fiscal_revertido: false }),
    ];
    banco.pcFila.acxe = [linhaPcFila({ n_id_pedido: '8516990580', n_id_it_pedido: '8516990581' })];
    banco.copiaPcs.acxe = [itemPc580()];
    const fila = await getFilaNacional();
    const acxe = fila.find((f) => f.empresa === 'acxe')!;
    expect(acxe).toMatchObject({ notaFiscal: '937', fiscal: 'pendente', fiscalRevertido: true, fiscalConcluidoPeloAtlasEm: null });
    expect(fila.find((f) => f.empresa === 'q2p')).toMatchObject({ fiscal: 'concluido', fiscalRevertido: false });
    const selo = sqlSeloPc()!;
    expect(selo.sql).toContain(fiscalRevertidoSql('h.c_chave_nfe', 'acxe'));
    expect(selo.sql).not.toContain('_Q2P"');
  });

  it('detalhe: 4 blocos com o sinal por empresa; a hora da reversao e lida no espelho DA EMPRESA da NF (ACXE), nunca no da Q2P', async () => {
    reversaoEm = new Date('2026-10-26T13:00:00.000Z');
    banco.detalhe = [linhaDetalheAcxe({ fiscal_pendente: true, fiscal_revertido: true, ledger_concluido: false })];
    banco.copiaPcs.acxe = [itemPc580()];
    const d = await getDetalheNfNacional(CHAVE_ACXE);
    expect(d).toMatchObject({ empresa: 'acxe', fiscal: 'pendente', fiscalRevertido: true, fiscalRevertidoEm: '2026-10-26T13:00:00.000Z' });
    const { sql, params } = sqlDetalhe();
    expect(params).toEqual([CHAVE_ACXE, CORTE_Q2P, CORTE_ACXE]);
    const b = blocos(sql);
    expect(b).toHaveLength(4);
    for (const q of [b[0]!, b[1]!]) expect(q).not.toContain('_ACXE"');
    for (const a of [b[2]!, b[3]!]) expect(a).not.toContain('_Q2P"');
    expect(norm(sql)).toContain("AND NOT u.fiscal_revertido) AS ledger_concluido, u.empresa AS empresa, u.produto_omie::text AS produto_omie, u.fiscal_revertido AS fiscal_revertido FROM nf_unificada u");
    const hora = consultasDaHora();
    expect(hora).toHaveLength(1);
    expect(hora[0]!.sql).toContain('"tbl_recebimentoNFe_ACXE"');
    expect(hora[0]!.sql).toContain('"tbl_nf_header_ACXE"');
    expect(hora[0]!.sql).not.toContain('_Q2P"');
    dump('detalhe-revertido-q2p-acxe.sql', sql, params);
  });

  it('a NF da Q2P revertida, com a ACXE ligada, le a hora no espelho da Q2P', async () => {
    banco.detalhe = detalhe19252({ empresa: 'q2p', produto_omie: null });
    await getDetalheNfNacional(CHAVE_19252);
    expect(consultasDaHora()[0]!.sql).toContain('"tbl_recebimentoNFe_Q2P"');
    expect(consultasDaHora()[0]!.sql).not.toContain('_ACXE"');
  });
});
