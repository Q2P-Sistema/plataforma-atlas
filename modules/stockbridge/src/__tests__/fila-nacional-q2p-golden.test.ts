import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Feature 017, Historia 5 (ACXEGDP-437) — a Q2P NAO muda quando a compra nacional da ACXE esta desligada.
//
// Garantia de projeto da Fase 2: com STOCKBRIDGE_RECEBIMENTO_NACIONAL_ACXE_ENABLED desligada (ou com a fila
// restrita a `empresa=q2p`), o SQL e os parametros da fila, do detalhe e das consultas de saude sao os de ANTES
// da Historia 5, byte a byte — varias suites comparam fragmentos do texto e o deploy da Fase 2 nao pode mexer no
// comportamento da Q2P (que esta em producao desde 22/10/2026).
//
// Como a garantia e provada: os arquivos de `golden/fila-nacional-q2p/` foram gerados pelo codigo do commit
// a62ea88 (a main, ANTES da Historia 5), rodando ESTE MESMO arquivo de teste dentro de uma copia daquele commit
// com UPDATE_GOLDEN=1. Aqui o codigo de hoje roda os mesmos cenarios e o texto tem de ser igual (so o espaco no FIM do
// arquivo e ignorado). Primeira de duas diferencas de proposito em relacao a a62ea88: a exclusao de fornecedor da consulta so da Q2P
// ganhou `AND fe.empresa = 'q2p'` (sem ela, um CNPJ excluido so na fila da ACXE sumiria tambem da fila da Q2P — defeito
// achado por fila-nacional-acxe-db.test.ts); os 5 .sql que tem o NOT EXISTS foram regenerados com essa linha a mais.
// Segunda diferenca de proposito (23/10/2026, NF 67988): as duas fontes ganharam `q_com_xml`/`u_com_xml` (quantidade e
// unidade do XML, do espelho de recebimentos) e a pendencia por restante da fila olha as duas quantidades oficiais — a
// nota de entrada do OMIE (quantidade RECEBIDA, editavel no portal) e a via do XML (`nf_kg_xml`, o XML so na faixa
// comparavel, metade a dobro da nota de entrada) —: o restante e a menor distancia ate uma delas ainda nao atingida
// (RESTANTE_PENDENCIA_SQL). Os 6 .sql foram regenerados com isso.
// Terceira diferenca de proposito (28/10/2026, T102 da 017): o espelho de itens de NF passou a guardar cada linha da NF
// (chave `(n_id_nf, n_item)`), e o OMIE da o mesmo `n_cod_item` as linhas ligadas ao mesmo item de PC. `sequenciaItemNfSql`
// liga a linha da NF a sequencia do recebimento pela ordem dentro do mesmo codigo (antes todas ganhavam a maior) e usa a posicao
// tambem quando o OMIE registra a NF de novo com ids novos (antes so com o recebimento sem nenhum id); o detalhe e o selo do PC
// desempatam a ordem por `n_seq`. Os 9 .sql com a fonte (a) foram regenerados com isso.
//
// Se o SQL da Q2P mudar DE PROPOSITO (outra feature), regenere:
//   UPDATE_GOLDEN=1 pnpm --filter @atlas/stockbridge exec vitest run src/__tests__/fila-nacional-q2p-golden.test.ts
// e revise o diff dos .sql no PR. Nao regenere para "fazer o teste passar" sem entender a diferenca.
//
// Fora do golden, de proposito: o SQL de `carregarContextoPc` e do upsert do cache de PCs vistos — eles GANHARAM
// colunas (ncodprod / codigo_local_estoque) para as duas empresas; cobertos em pc-sugestao-acxe e pc-visto-acxe.
//
// D21 da 017 (25/10/2026, NF 19252 — recebimento fiscal REVERTIDO no portal do OMIE): NAO e uma terceira diferenca em relacao
// aos goldens acima. Os `*-desligado` e `*-ligado` seguem byte a byte (e os .params.json tambem): o SQL da D21 so entra com
// `comRevertido` (chave da 016 + kill switch STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED + migration 0060), e os cenarios de sempre rodam
// com o kill switch DESLIGADO — esse e o contrato "D21 desligada = SQL de antes". Com a D21 ligada o SQL e outro de proposito e
// fica travado em goldens NOVOS, gerados junto da D21 (sem commit anterior que os prove: a prova e o diff contra o `*-ligado` de
// mesmo nome e a execucao em PROD somente leitura): fila-fiscal-ligado-revertido, detalhe-fiscal-ligado-revertido,
// fila-pc-situacao-revertido e detalhe-fiscal-revertido-em (a consulta da hora da reversao, que so o detalhe de NF revertida faz).
// Sem bind novo: os .params.json dos `*-revertido` sao os dos `*-ligado`.

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  config: {} as Record<string, unknown>,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => mocks.logger,
  getDb: vi.fn(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => mocks.poolQuery(sql, params) }),
  getConfig: () => mocks.config,
}));
vi.mock('@atlas/integration-omie', () => ({ consultarPedidoCompra: vi.fn() }));
vi.mock('../services/correlacao-produto.service.js', () => ({ sugerirProdutosEmLote: vi.fn().mockResolvedValue(new Map()) }));
// cache de PCs vistos (0057): dublê — o SQL dele nao entra no golden
vi.mock('../services/pc-visto.service.js', () => ({
  registrarPcsVistosSeVencido: vi.fn().mockResolvedValue(undefined),
  lerPcsVistos: vi.fn().mockResolvedValue([]),
}));

import {
  getFilaNacional,
  getDetalheNfNacional,
  idadeEspelhoRecebimentos,
  idadeCopiaPcs,
} from '../services/fila-nacional.service.js';
import { itemNacionalRecebidoSql } from '../services/fiscal-recebida-sql.js';
import { __resetColunaRevertido } from '../services/fiscal-revertido.js';

const GOLDEN_DIR = process.env.GOLDEN_DIR ?? join(dirname(fileURLToPath(import.meta.url)), 'golden', 'fila-nacional-q2p');
const ATUALIZAR = process.env.UPDATE_GOLDEN === '1';

const CHAVE = '35261014555032000753550010000068421827355174';

interface Chamada {
  sql: string;
  params: unknown[];
}
const chamadas: Chamada[] = [];
let filaRows: Record<string, unknown>[] = [];
let detalheRows: Record<string, unknown>[] = [];
let pcFilaRows: Record<string, unknown>[] = [];

function responder(sql: string): { rows: unknown[] } {
  if (sql.includes('information_schema')) return { rows: [{ ok: true }] };
  if (sql.includes('MAX(data_atualizacao)') || sql.includes('MAX(synced_at)')) return { rows: [{ idade_min: '5.0' }] };
  if (sql.includes('HAVING COUNT(*) FILTER (WHERE pendente) > 0')) return { rows: filaRows };
  if (sql.includes('u.c_chave_nfe = ANY($3::text[])')) return { rows: pcFilaRows };
  if (sql.includes('WITH nf_unificada')) return { rows: detalheRows };
  return { rows: [] };
}

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
  fiscal_pendente: false,
  n_id_receb: '8510564869',
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
  n_seq: 1,
  preco_comercial: 11.3,
  fornecedor_codigo: '1111',
  n_id_pedido: null,
  n_id_it_pedido: null,
  n_num_ped_compra: null,
  c_ignorar_item: 'N',
  c_nao_gerar_mov_estoque: 'N',
  receb_recebido: 'N',
  ledger_concluido: false,
  ...over,
});

const linhaFila = (over: Record<string, unknown> = {}) => ({
  nf_chave_acesso: CHAVE,
  nota_fiscal: '6842',
  fornecedor_nome: 'REPLAS COMERCIAL LTDA',
  fornecedor_cnpj: '14.555.032/0007-53',
  dt_emissao: '2026-10-01',
  dias_desde_emissao: 1,
  itens_total: 1,
  itens_pendentes: 1,
  valor_total_brl: 203400,
  fiscal: 'pendente',
  fiscal_concluido_em: null,
  estoque_lancado: false,
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(mocks.config)) delete mocks.config[k];
  mocks.config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE = '2026-09-11';
  mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = false;
  mocks.config.STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED = false; // D21 desligada: os cenarios de sempre (ver o cabecalho)
  __resetColunaRevertido();
  chamadas.length = 0;
  filaRows = [];
  detalheRows = [];
  pcFilaRows = [];
  mocks.poolQuery.mockReset();
  mocks.poolQuery.mockImplementation((sql: string, params?: unknown[]) => {
    chamadas.push({ sql, params: params ?? [] });
    return Promise.resolve(responder(sql));
  });
});

/** Compara com o golden (ou o grava, com UPDATE_GOLDEN=1). O texto do SQL e comparado por inteiro, sem normalizar nada. */
function contraGolden(nome: string, sql: string, params?: unknown[]): void {
  const arqSql = join(GOLDEN_DIR, `${nome}.sql`);
  const arqParams = join(GOLDEN_DIR, `${nome}.params.json`);
  if (ATUALIZAR) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(arqSql, sql);
    if (params) writeFileSync(arqParams, `${JSON.stringify(params, null, 2)}\n`);
    return;
  }
  expect(existsSync(arqSql), `golden ausente: ${arqSql} (UPDATE_GOLDEN=1 para gerar)`).toBe(true);
  // so o espaco no FIM do arquivo e ignorado (um editor que acrescenta a quebra de linha final nao pode quebrar o teste)
  expect(sql.trimEnd()).toBe(readFileSync(arqSql, 'utf8').trimEnd());
  if (params) {
    expect(existsSync(arqParams), `golden de parametros ausente: ${arqParams}`).toBe(true);
    expect(JSON.parse(JSON.stringify(params))).toEqual(JSON.parse(readFileSync(arqParams, 'utf8')));
  }
}

const achar = (predicado: (c: Chamada) => boolean): Chamada => {
  const c = chamadas.find(predicado);
  if (!c) throw new Error('consulta esperada nao executada');
  return c;
};
const sqlFila = () => achar((c) => c.sql.includes('HAVING COUNT(*) FILTER (WHERE pendente) > 0'));
const sqlPcFila = () => achar((c) => c.sql.includes('u.c_chave_nfe = ANY($3::text[])'));
const sqlDetalhe = () => achar((c) => c.sql.includes('WITH nf_unificada') && c.sql.includes('WHERE u.c_chave_nfe = $1'));
const sqlNumerosPcs = () => achar((c) => c.sql.includes('FROM stockbridge.pedido_compra_visto') && c.sql.includes('ORDER BY 3'));

describe('golden da Q2P (SQL de a62ea88, antes da Historia 5)', () => {
  it('fila — chave da 016 desligada', async () => {
    await getFilaNacional();
    const c = sqlFila();
    contraGolden('fila-fiscal-desligado', c.sql, c.params);
    // a coluna `cancelada` do espelho de NF e consultada pela tabela da Q2P
    expect(achar((x) => x.sql.includes('information_schema')).params).toEqual(['tbl_nf_header_Q2P']);
  });

  it('fila — chave da 016 ligada (as duas fontes)', async () => {
    mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    await getFilaNacional();
    const c = sqlFila();
    contraGolden('fila-fiscal-ligado', c.sql, c.params);
  });

  it('fila — filtros q e fornecedor (parametros $3 e $4)', async () => {
    mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    await getFilaNacional({ q: '667', fornecedor: 'ISOFORMA' });
    const c = sqlFila();
    contraGolden('fila-fiscal-ligado-filtros', c.sql, c.params);
  });

  it('fila — consulta do selo do PC (NF com fiscal pendente)', async () => {
    mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    filaRows = [linhaFila()];
    await getFilaNacional();
    const c = sqlPcFila();
    contraGolden('fila-pc-situacao', c.sql, c.params);
  });

  it('detalhe — chave da 016 desligada', async () => {
    detalheRows = [linhaDetalhe()];
    await getDetalheNfNacional(CHAVE);
    const c = sqlDetalhe();
    contraGolden('detalhe-fiscal-desligado', c.sql, c.params);
  });

  it('detalhe — chave da 016 ligada, fiscal pendente', async () => {
    mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    detalheRows = [linhaDetalhe({ fiscal_pendente: true })];
    await getDetalheNfNacional(CHAVE);
    const c = sqlDetalhe();
    contraGolden('detalhe-fiscal-ligado', c.sql, c.params);
  });

  it('detalhe — numero dos PCs vinculados (NF com fiscal ja feito)', async () => {
    detalheRows = [linhaDetalhe({ n_id_pedido: '8516905979', n_id_it_pedido: '8516907022' })];
    await getDetalheNfNacional(CHAVE);
    const c = sqlNumerosPcs();
    contraGolden('detalhe-numeros-dos-pcs', c.sql, c.params);
  });

  it('saude — idade do espelho de recebimentos e da copia de PCs', async () => {
    mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    await idadeEspelhoRecebimentos();
    await idadeCopiaPcs();
    const espelho = achar((c) => c.sql.includes('MAX(synced_at)'));
    const copia = achar((c) => c.sql.includes('MAX(data_atualizacao)'));
    contraGolden('saude-idade-espelho', espelho.sql, espelho.params);
    contraGolden('saude-idade-copia-pcs', copia.sql, copia.params);
  });

  it('checagem "item ja recebido" (itemNacionalRecebidoSql) sem empresa — a via 2 casa a Q2P', () => {
    const base = {
      chaveExpr: 'u.c_chave_nfe',
      descricaoNormalizadaExpr: 'DESC_NORM',
      nfNumeroExpr: 'u.n_nf',
    };
    contraGolden('item-recebido-minimo', itemNacionalRecebidoSql(base));
    contraGolden(
      'item-recebido-completo',
      itemNacionalRecebidoSql({ ...base, dataEmissaoExpr: 'u.d_emi', sequenciaExpr: 'u.n_seq' }),
    );
  });
});

// D21 (fiscal revertido no OMIE): o SQL com o sinal ligado. Goldens NOVOS (ver o cabecalho); o conjunto de parametros e o mesmo
// dos `*-ligado`, porque o sinal e a expressao da chave de acesso e nao tem bind.
describe('golden da Q2P com a D21 ligada (fiscal revertido no OMIE)', () => {
  const GOLDEN_DO_REPO = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'fila-nacional-q2p');
  const paramsDe = (nome: string): unknown => JSON.parse(readFileSync(join(GOLDEN_DO_REPO, `${nome}.params.json`), 'utf8'));

  beforeEach(() => {
    mocks.config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    mocks.config.STOCKBRIDGE_FISCAL_REVERTIDO_ENABLED = true;
  });

  it('a D21 so liga com a coluna da migration 0060: confere no information_schema (uma vez, sem bind) antes da fila', async () => {
    await getFilaNacional();
    const c = achar((x) => x.sql.includes('information_schema') && x.sql.includes('revertido_em'));
    expect(c.sql).toContain("table_schema = 'stockbridge' AND table_name = 'recebimento_fiscal' AND column_name = 'revertido_em'");
    expect(c.params).toEqual([]);
  });

  it('fila — as duas fontes com o sinal de reversao', async () => {
    await getFilaNacional();
    const c = sqlFila();
    contraGolden('fila-fiscal-ligado-revertido', c.sql, c.params);
    expect(c.params).toEqual(paramsDe('fila-fiscal-ligado'));
  });

  it('fila — consulta do selo do PC (NF com fiscal pendente, revertida inclusive)', async () => {
    filaRows = [linhaFila()];
    await getFilaNacional();
    const c = sqlPcFila();
    contraGolden('fila-pc-situacao-revertido', c.sql, c.params);
    expect(c.params).toEqual(paramsDe('fila-pc-situacao'));
  });

  it('detalhe — chave da 016 ligada, fiscal pendente', async () => {
    detalheRows = [linhaDetalhe({ fiscal_pendente: true })];
    await getDetalheNfNacional(CHAVE);
    const c = sqlDetalhe();
    contraGolden('detalhe-fiscal-ligado-revertido', c.sql, c.params);
    expect(c.params).toEqual(paramsDe('detalhe-fiscal-ligado'));
  });

  it('detalhe — NF com o fiscal revertido: a consulta da hora da reversao (so o detalhe de NF revertida a faz)', async () => {
    detalheRows = [linhaDetalhe({ fiscal_pendente: true, fiscal_revertido: true })];
    await getDetalheNfNacional(CHAVE);
    const c = achar((x) => /\bAS em\b/.test(x.sql));
    contraGolden('detalhe-fiscal-revertido-em', c.sql, c.params);
  });
});
