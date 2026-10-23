import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — a sugestao de pedido de compra (PC) para a NF da ACXE.
//
// O que a Historia 5 acrescentou em pc-sugestao.service.ts, sem rede e sem banco:
//  - a copia (`tbl_pedidosCompras_<empresa>`) e o cadastro sao os da empresa da NF;
//  - o item do PC carrega o produto (`ncodprod`) e o LOCAL (`codigo_local_estoque`, varchar na copia: so entra se
//    for numerico) — a NF da ACXE pre-seleciona o produto e o estoque de entrada por eles;
//  - o PC-espelho da importacao (fornecedor = a propria ACXE, valor < R$ 200) so existe na copia da Q2P;
//  - `resolverLocaisAcxePorCodigoOmie` traduz o local do OMIE para a localidade ATIVA e NAO virtual do Atlas, e
//    `PcCandidato`/`PcDaNfItem` levam `localidadeId` e `localDescricao` ("20.0.7 · PRODUÇÃO") — o codigo de 10
//    digitos do OMIE so serve de chave, nunca vai para a tela (ACXEGDP-313);
//  - `sugerirPcPorItensComContexto` devolve tambem o contexto lido (o detalhe usa o `ncodprod` do PC).
// O resto do modulo (tolerancias, listas, ordenacao, vinculo do OMIE) e coberto em pc-sugestao.test.ts.

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  config: {} as Record<string, unknown>,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
vi.mock('../services/pc-visto.service.js', () => ({
  registrarPcsVistosSeVencido: (...a: unknown[]) => mocks.registrarPcsVistosSeVencido(...a),
  lerPcsVistos: (...a: unknown[]) => mocks.lerPcsVistos(...a),
}));

import {
  carregarContextoPc,
  montarPcDoItem,
  montarPcsDaNf,
  resolverLocaisAcxePorCodigoOmie,
  sugerirPcPorItens,
  sugerirPcPorItensComContexto,
  tabelaCadastro,
  tabelaPcs,
  type ContextoPc,
  type ItemParaSugestao,
  type LocalPcResolvido,
  type PcCopia,
} from '../services/pc-sugestao.service.js';

const AGORA = Date.UTC(2026, 9, 23, 15, 0, 0);
const SYNC = AGORA - 5 * 60_000;
const CHAVE_NF = '35261012345678000190550010000009371000009370';
const TOL = { qtd: 0.02, preco: 0.01 };

const FORNECEDOR = 4700001001; // Solutec no cadastro da ACXE
const LOCAL_2007_OMIE = 4553940398; // 20.0.7 PRODUCAO
const LOCAL_111_OMIE = 4498926337; // 11.1 SANTO ANDRE (IMPORTADO) — tambem da Q2P
const LOCAL_TRANSITO_OMIE = 4503767789; // 90.0.2 TRANSITO (virtual)
const PRODUTO_PP = 4501234567;

const ID_2007 = '5b1a1c2e-7d1f-4d0e-9a53-0a7c6e0b2007';
const ID_111 = '0f5e5a4d-1e2f-4b6a-8a71-5d3c9e0b0111';
const LOCAIS = new Map<number, LocalPcResolvido>([
  [LOCAL_2007_OMIE, { id: ID_2007, codigo: '20.0.7', nome: 'PRODUÇÃO' }],
  [LOCAL_111_OMIE, { id: ID_111, codigo: '11.1', nome: 'SANTO ANDRÉ (IMPORTADO)' }],
]);

beforeEach(() => {
  for (const k of Object.keys(mocks.config)) delete mocks.config[k];
  for (const f of Object.values(mocks.logger)) f.mockClear();
  mocks.poolQuery.mockReset();
  mocks.registrarPcsVistosSeVencido.mockReset();
  mocks.registrarPcsVistosSeVencido.mockResolvedValue(undefined);
  mocks.lerPcsVistos.mockReset();
  mocks.lerPcsVistos.mockResolvedValue([]);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
});
afterEach(() => {
  vi.useRealTimers();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Item de PC da copia da ACXE como o servico o entrega: PC 580 da Solutec (26.000 kg a R$ 4,80, etapa 15, local 20.0.7). */
function pcCopia(over: Partial<PcCopia> = {}): PcCopia {
  return {
    nCodPed: 8516990580,
    nCodItem: 8516990581,
    pcNumero: '580',
    etapa: '15',
    nCodFor: FORNECEDOR,
    produtoDescricao: 'PP PRETO Q35',
    qtdPedidaKg: 26000,
    saldoCopiaKg: 26000,
    precoKg: 4.8,
    unidade: 'KG',
    dtPrevisao: '2026-10-30',
    atualizadoEmMs: SYNC,
    pcEspelho: false,
    cnpjCadastro: '11222333000181',
    raizCnpj: '11222333',
    fonte: 'copia',
    nCodProd: PRODUTO_PP,
    codigoLocalEstoque: LOCAL_2007_OMIE,
    ...over,
  };
}

function itemNf(over: Partial<ItemParaSugestao> = {}): ItemParaSugestao {
  return {
    indice: 0,
    descricao: 'PP PRETO Q35',
    quantidadeKg: 26000,
    unidadeNf: 'KG',
    fatorUnidadeNf: 1,
    precoNfKg: 4.8,
    precoItemKg: null,
    numeroPedidoNf: null,
    vinculos: [],
    sequencias: [1],
    kgPorSequencia: { 1: 26000 },
    ...over,
  };
}

const contexto = (pcs: PcCopia[], locais?: Map<number, LocalPcResolvido>): ContextoPc => ({
  pcs,
  usos: [],
  agoraMs: AGORA,
  raizPorFornecedor: new Map(),
  ...(locais ? { locais } : {}),
});

interface LinhaPcBanco {
  ncodped: string;
  ncoditem: string;
  cnumero: string | null;
  cetapa: string | null;
  ncodfor: string | null;
  nqtde: number | string | null;
  nqtderec: number | string | null;
  nvalunit: number | string | null;
  cunidade: string | null;
  ddtprevisao: string | null;
  cdescricao: string | null;
  cproduto: string | null;
  atualizado_ms: number | string | null;
  valor_total_pc: number | string | null;
  fornecedor_acxe: boolean | null;
  cnpj_cadastro: string | null;
  ncodprod?: string | null;
  codigo_local_estoque?: string | null;
}

/** Linha da copia como o Postgres a devolve: ids em texto (bigint), o local em varchar. */
function linhaBanco(over: Partial<LinhaPcBanco> = {}): LinhaPcBanco {
  return {
    ncodped: '8516990580',
    ncoditem: '8516990581',
    cnumero: '580',
    cetapa: '15',
    ncodfor: String(FORNECEDOR),
    nqtde: 26000,
    nqtderec: 0,
    nvalunit: 4.8,
    cunidade: 'KG',
    ddtprevisao: '2026-10-30',
    cdescricao: 'PP PRETO Q35',
    cproduto: 'PPQ35',
    atualizado_ms: SYNC,
    valor_total_pc: 124800,
    fornecedor_acxe: false,
    cnpj_cadastro: '11222333000181',
    ncodprod: String(PRODUTO_PP),
    codigo_local_estoque: String(LOCAL_2007_OMIE),
    ...over,
  };
}

interface Locais {
  rows?: Array<{ codigo_omie: string; id: string; codigo: string; nome: string }>;
  erro?: Error;
}

/** Responde a copia de PCs, o cadastro (raiz do CNPJ), o ledger e a correlacao de locais. */
function banco(pcs: LinhaPcBanco[], locais: Locais = {}): void {
  mocks.poolQuery.mockImplementation((sql: string) => {
    if (sql.includes('tbl_pedidosCompras_')) return Promise.resolve({ rows: pcs });
    if (sql.includes('AS codigo') && sql.includes('tbl_cadastroFornecedoresClientes_')) return Promise.resolve({ rows: [] });
    if (sql.includes('stockbridge.recebimento_fiscal_pc')) return Promise.resolve({ rows: [] });
    if (sql.includes('stockbridge.localidade_correlacao')) return locais.erro ? Promise.reject(locais.erro) : Promise.resolve({ rows: locais.rows ?? [] });
    return Promise.reject(new Error(`SQL inesperado: ${sql.slice(0, 80)}`));
  });
}
const linhaLocal2007 = { codigo_omie: String(LOCAL_2007_OMIE), id: ID_2007, codigo: '20.0.7', nome: 'PRODUÇÃO' };
const linhaLocal111 = { codigo_omie: String(LOCAL_111_OMIE), id: ID_111, codigo: '11.1', nome: 'SANTO ANDRÉ (IMPORTADO)' };

const norm = (sql: unknown): string => String(sql).replace(/\s+/g, ' ').trim();
const chamada = (trecho: string) => mocks.poolQuery.mock.calls.find((c) => String(c[0]).includes(trecho));

// ═══ tabelas por empresa ═════════════════════════════════════════════════════

describe('tabelaPcs / tabelaCadastro — vem do espelho da empresa', () => {
  it.each([
    ['q2p', '"tbl_pedidosCompras_Q2P"', '"tbl_cadastroFornecedoresClientes_Q2P"'],
    ['acxe', '"tbl_pedidosCompras_ACXE"', '"tbl_cadastroFornecedoresClientes_ACXE"'],
  ] as const)('%s', (empresa, pcs, cadastro) => {
    expect(tabelaPcs(empresa)).toBe(pcs);
    expect(tabelaCadastro(empresa)).toBe(cadastro);
  });
});

// ═══ resolverLocaisAcxePorCodigoOmie ═════════════════════════════════════════

describe('resolverLocaisAcxePorCodigoOmie — local do OMIE da ACXE -> localidade do Atlas', () => {
  it('sem codigo valido nao consulta o banco (zero, negativo, NaN, infinito)', async () => {
    expect((await resolverLocaisAcxePorCodigoOmie([])).size).toBe(0);
    expect((await resolverLocaisAcxePorCodigoOmie([0, -1, Number.NaN, Number.POSITIVE_INFINITY])).size).toBe(0);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('consulta a correlacao pelo codigo da ACXE: so localidade ATIVA e NAO virtual, uma por codigo, na ordem do codigo do Atlas', async () => {
    banco([], { rows: [linhaLocal111, linhaLocal2007] });
    await resolverLocaisAcxePorCodigoOmie([LOCAL_2007_OMIE, LOCAL_111_OMIE]);
    const [sql, params] = chamada('localidade_correlacao')!;
    const n = norm(sql);
    expect(n).toContain('FROM stockbridge.localidade_correlacao lc JOIN stockbridge.localidade l ON l.id = lc.localidade_id');
    expect(n).toContain('lc.codigo_local_estoque_acxe = ANY($1::bigint[])');
    expect(n).toContain('l.ativo = true');
    expect(n).toContain("l.tipo NOT LIKE 'virtual%'");
    expect(n).toContain('ORDER BY l.codigo');
    expect(params).toEqual([[LOCAL_2007_OMIE, LOCAL_111_OMIE]]);
  });

  it('devolve id, codigo e nome da localidade, chaveado pelo codigo numerico do OMIE; ids repetidos viram uma consulta de ids unicos', async () => {
    banco([], { rows: [linhaLocal2007, linhaLocal111] });
    const mapa = await resolverLocaisAcxePorCodigoOmie([LOCAL_2007_OMIE, LOCAL_111_OMIE, LOCAL_2007_OMIE, 0]);
    expect(chamada('localidade_correlacao')![1]).toEqual([[LOCAL_2007_OMIE, LOCAL_111_OMIE]]);
    expect(mapa.get(LOCAL_2007_OMIE)).toEqual({ id: ID_2007, codigo: '20.0.7', nome: 'PRODUÇÃO' });
    expect(mapa.get(LOCAL_111_OMIE)).toEqual({ id: ID_111, codigo: '11.1', nome: 'SANTO ANDRÉ (IMPORTADO)' });
  });

  it('local sem localidade ativa e nao virtual (o banco nao devolve a linha) fica fora do mapa', async () => {
    banco([], { rows: [linhaLocal2007] });
    const mapa = await resolverLocaisAcxePorCodigoOmie([LOCAL_2007_OMIE, LOCAL_TRANSITO_OMIE]);
    expect(mapa.has(LOCAL_TRANSITO_OMIE)).toBe(false);
    expect(mapa.size).toBe(1);
  });

  it('havendo mais de uma localidade para o mesmo codigo do OMIE (nao deveria), vale a de menor codigo — a primeira da ordenacao', async () => {
    banco([], {
      rows: [
        { codigo_omie: String(LOCAL_2007_OMIE), id: 'a', codigo: '20.0.7', nome: 'PRODUÇÃO' },
        { codigo_omie: String(LOCAL_2007_OMIE), id: 'b', codigo: '20.0.9', nome: 'OUTRA' },
      ],
    });
    const mapa = await resolverLocaisAcxePorCodigoOmie([LOCAL_2007_OMIE]);
    expect(mapa.get(LOCAL_2007_OMIE)).toEqual({ id: 'a', codigo: '20.0.7', nome: 'PRODUÇÃO' });
  });

  it('falha de banco sobe (quem chama decide: o contexto de PC trata como "sem local")', async () => {
    banco([], { erro: new Error('connection terminated') });
    await expect(resolverLocaisAcxePorCodigoOmie([LOCAL_2007_OMIE])).rejects.toThrow('connection terminated');
  });
});

// ═══ carregarContextoPc ══════════════════════════════════════════════════════

describe('carregarContextoPc — NF da ACXE', () => {
  it('le a copia e o cadastro da ACXE e seleciona o produto e o local do item do PC', async () => {
    banco([linhaBanco()], { rows: [linhaLocal2007] });
    await carregarContextoPc('acxe', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    const sql = norm(chamada('tbl_pedidosCompras_')![0]);
    expect(sql).toContain('FROM public."tbl_pedidosCompras_ACXE" pc');
    expect(sql).toContain('public."tbl_cadastroFornecedoresClientes_ACXE" c');
    expect(sql).toContain('pc.ncodprod::text AS ncodprod, pc.codigo_local_estoque');
    expect(sql).not.toContain('_Q2P"');
  });

  it('o item do PC traz o produto e o local como numeros do OMIE (a copia guarda o local em varchar)', async () => {
    banco([linhaBanco()], { rows: [linhaLocal2007] });
    const ctx = await carregarContextoPc('acxe', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs).toHaveLength(1);
    expect(ctx.pcs[0]).toMatchObject({ pcNumero: '580', nCodProd: PRODUTO_PP, codigoLocalEstoque: LOCAL_2007_OMIE, fonte: 'copia' });
  });

  it.each([
    ['vazio', ''],
    ['so espacos', '   '],
    ['nulo', null],
    ['texto', 'ESTOQUE PRODUCAO'],
    ['zero', '0'],
    ['negativo', '-5'],
    ['decimal', '455.39'],
    ['com sufixo', '4553940398A'],
    ['grande demais (> 18 digitos)', '12345678901234567890'],
  ])('local %s nao e um id do OMIE: o item fica SEM local (nunca NaN nem 0)', async (_nome, local) => {
    banco([linhaBanco({ codigo_local_estoque: local })]);
    const ctx = await carregarContextoPc('acxe', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs[0]).not.toHaveProperty('codigoLocalEstoque');
    // sem local nenhum, a correlacao nem e consultada e o contexto nao leva mapa de locais
    expect(chamada('localidade_correlacao')).toBeUndefined();
    expect(ctx).not.toHaveProperty('locais');
  });

  it('o local com espacos nas pontas vale (varchar da copia)', async () => {
    banco([linhaBanco({ codigo_local_estoque: ` ${LOCAL_2007_OMIE} ` })], { rows: [linhaLocal2007] });
    const ctx = await carregarContextoPc('acxe', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs[0]!.codigoLocalEstoque).toBe(LOCAL_2007_OMIE);
  });

  it.each([[null], [''], ['0'], ['abc']])('produto invalido (%j): o item fica SEM nCodProd', async (produto) => {
    banco([linhaBanco({ ncodprod: produto })], { rows: [linhaLocal2007] });
    const ctx = await carregarContextoPc('acxe', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs[0]).not.toHaveProperty('nCodProd');
  });

  it('resolve os locais UMA vez para todos os PCs lidos (copia + cache), so os codigos que existem, sem repeticao', async () => {
    banco(
      [
        linhaBanco(),
        linhaBanco({ ncoditem: '8516990582', codigo_local_estoque: String(LOCAL_2007_OMIE) }),
        linhaBanco({ ncoditem: '8516990583', codigo_local_estoque: null }),
      ],
      { rows: [linhaLocal2007, linhaLocal111] },
    );
    mocks.lerPcsVistos.mockResolvedValue([
      { ...pcCopia({ nCodPed: 77, nCodItem: 78, pcNumero: '306', codigoLocalEstoque: LOCAL_111_OMIE }), fonte: undefined, vistoEmMs: SYNC },
    ]);
    const ctx = await carregarContextoPc('acxe', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    const consultas = mocks.poolQuery.mock.calls.filter((c) => String(c[0]).includes('localidade_correlacao'));
    expect(consultas).toHaveLength(1);
    expect(consultas[0]![1]).toEqual([[LOCAL_2007_OMIE, LOCAL_111_OMIE]]);
    expect(ctx.locais).toEqual(new Map([[LOCAL_2007_OMIE, { id: ID_2007, codigo: '20.0.7', nome: 'PRODUÇÃO' }], [LOCAL_111_OMIE, { id: ID_111, codigo: '11.1', nome: 'SANTO ANDRÉ (IMPORTADO)' }]]));
  });

  it('nenhuma localidade correspondente: o contexto fica sem mapa de locais', async () => {
    banco([linhaBanco()], { rows: [] });
    const ctx = await carregarContextoPc('acxe', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(chamada('localidade_correlacao')).toBeDefined();
    expect(ctx).not.toHaveProperty('locais');
  });

  it('falha ao resolver os locais: o contexto sai sem eles (candidatos sem local), com aviso no log — nunca derruba a sugestao', async () => {
    banco([linhaBanco()], { erro: new Error('deadlock detected') });
    const ctx = await carregarContextoPc('acxe', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(ctx.pcs).toHaveLength(1);
    expect(ctx).not.toHaveProperty('locais');
    const aviso = mocks.logger.warn.mock.calls.find((c) => String(c[1]).includes('Locais dos pedidos de compra indisponíveis'));
    expect(aviso![0]).toMatchObject({ err: 'deadlock detected' });
  });

  it('pcEspelho e SEMPRE falso na copia da ACXE (o PC-espelho da importacao so existe na da Q2P), mesmo com o CNPJ da ACXE e valor baixo', async () => {
    banco([
      linhaBanco({ ncoditem: '1', fornecedor_acxe: true, valor_total_pc: 150 }),
      linhaBanco({ ncoditem: '2', fornecedor_acxe: true, valor_total_pc: 199.99 }),
      linhaBanco({ ncoditem: '3', fornecedor_acxe: false, valor_total_pc: 50 }),
    ]);
    const ctx = await carregarContextoPc('acxe', { fornecedores: [9], nCodPedsVinculo: [] });
    expect(ctx.pcs.map((p) => p.pcEspelho)).toEqual([false, false, false]);
  });

  it('o mesmo dado na copia da Q2P continua sendo PC-espelho (a regra da importacao nao mudou)', async () => {
    banco([
      linhaBanco({ ncoditem: '1', fornecedor_acxe: true, valor_total_pc: 150 }),
      linhaBanco({ ncoditem: '2', fornecedor_acxe: true, valor_total_pc: 203400 }),
    ]);
    const ctx = await carregarContextoPc('q2p', { fornecedores: [9], nCodPedsVinculo: [] });
    expect(ctx.pcs.map((p) => p.pcEspelho)).toEqual([true, false]);
  });

  it('cache de PCs vistos: o PC que saiu da lista de pendentes mantem o produto e o local, e o local e resolvido como o da copia', async () => {
    banco([], { rows: [linhaLocal2007] });
    mocks.lerPcsVistos.mockResolvedValue([
      { ...pcCopia({ pcNumero: '580' }), vistoEmMs: SYNC - 60_000 },
    ]);
    const ctx = await carregarContextoPc('acxe', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(mocks.lerPcsVistos).toHaveBeenCalledWith('acxe', expect.objectContaining({ fornecedores: [FORNECEDOR] }));
    expect(mocks.registrarPcsVistosSeVencido).toHaveBeenCalledWith('acxe', AGORA);
    expect(ctx.pcs[0]).toMatchObject({ pcNumero: '580', fonte: 'cache', nCodProd: PRODUTO_PP, codigoLocalEstoque: LOCAL_2007_OMIE });
    expect(ctx.locais!.get(LOCAL_2007_OMIE)!.codigo).toBe('20.0.7');
  });
});

describe('carregarContextoPc — NF da Q2P nao resolve locais (so a ACXE usa o local do PC)', () => {
  it('mesmo com o local no item do PC, a correlacao de locais NAO e consultada e o contexto nao leva mapa', async () => {
    banco([linhaBanco({ codigo_local_estoque: '8115873874' })]);
    const ctx = await carregarContextoPc('q2p', { fornecedores: [FORNECEDOR], nCodPedsVinculo: [] });
    expect(chamada('localidade_correlacao')).toBeUndefined();
    expect(ctx).not.toHaveProperty('locais');
    // o item ainda carrega o local do PC (dado cru); so a resolucao para a localidade e da ACXE
    expect(ctx.pcs[0]!.codigoLocalEstoque).toBe(8115873874);
    const sql = norm(chamada('tbl_pedidosCompras_')![0]);
    expect(sql).toContain('FROM public."tbl_pedidosCompras_Q2P" pc');
  });
});

// ═══ candidatos com local ════════════════════════════════════════════════════

describe('montarPcDoItem — local de entrada do item do PC', () => {
  const montar = (item: ItemParaSugestao, pcs: PcCopia[], locais?: Map<number, LocalPcResolvido>) =>
    montarPcDoItem(item, contexto(pcs, locais), FORNECEDOR, CHAVE_NF, TOL);

  it('candidato dentro da tolerancia: localidadeId e localDescricao ("20.0.7 · PRODUÇÃO")', () => {
    const r = montar(itemNf(), [pcCopia()], LOCAIS);
    expect(r.pc.candidatos).toHaveLength(1);
    expect(r.pc.candidatos[0]).toMatchObject({ pcNumero: '580', localidadeId: ID_2007, localDescricao: '20.0.7 · PRODUÇÃO' });
  });

  it('a descricao usa o ponto medio (U+00B7) entre o codigo e o nome — o formato da tela', () => {
    const r = montar(itemNf(), [pcCopia({ codigoLocalEstoque: LOCAL_111_OMIE })], LOCAIS);
    expect(r.pc.candidatos[0]!.localDescricao).toBe('11.1 · SANTO ANDRÉ (IMPORTADO)');
    expect(r.pc.candidatos[0]!.localDescricao).toContain('·');
  });

  it('cada PC leva o local do PROPRIO item: dois PCs do fornecedor em locais diferentes', () => {
    const outro = pcCopia({ nCodPed: 8516990600, nCodItem: 8516990601, pcNumero: '581', codigoLocalEstoque: LOCAL_111_OMIE });
    const r = montar(itemNf(), [pcCopia(), outro], LOCAIS);
    const porNumero = Object.fromEntries(r.pc.candidatos.map((c) => [c.pcNumero, c.localidadeId]));
    expect(porNumero).toEqual({ '580': ID_2007, '581': ID_111 });
  });

  it('PC fora da tolerancia ("outros do fornecedor"), aguardando aprovacao e em unidade incompativel tambem levam o local', () => {
    const fora = pcCopia({ nCodPed: 1, nCodItem: 11, pcNumero: '601', precoKg: 6.5 }); // preco 35% acima
    const aguardando = pcCopia({ nCodPed: 2, nCodItem: 12, pcNumero: '602', etapa: '10' });
    const emTon = pcCopia({ nCodPed: 3, nCodItem: 13, pcNumero: '603', unidade: 'TON', precoKg: 4.8 });
    const r = montar(itemNf(), [fora, aguardando, emTon], LOCAIS);
    expect(r.pc.outrosDoFornecedor.map((c) => [c.pcNumero, c.localidadeId, c.localDescricao])).toEqual([['601', ID_2007, '20.0.7 · PRODUÇÃO']]);
    expect(r.pc.aguardandoAprovacao.map((c) => [c.pcNumero, c.localidadeId])).toEqual([['602', ID_2007]]);
    expect(r.pc.unidadeIncompativel.map((c) => [c.pcNumero, c.localidadeId])).toEqual([['603', ID_2007]]);
  });

  it('o vinculo que o proprio OMIE fez tambem mostra o local do item do PC', () => {
    const r = montar(itemNf({ vinculos: [{ nSequencia: 1, nIdPedido: 8516990580, nIdItPedido: 8516990581 }] }), [pcCopia()], LOCAIS);
    expect(r.pc.vinculoOmie).toMatchObject({ pcNumero: '580', localidadeId: ID_2007, localDescricao: '20.0.7 · PRODUÇÃO' });
  });

  it('vinculo para um PC fora da copia e do cache (nao ha dado local): sem local, nunca inventado', () => {
    const r = montar(itemNf({ vinculos: [{ nSequencia: 1, nIdPedido: 999, nIdItPedido: 1000 }] }), [], LOCAIS);
    expect(r.pc.vinculoOmie).toMatchObject({ semDadosLocais: true, localidadeId: null, localDescricao: null });
  });

  it('PC cujo local nao esta no mapa (virtual/inativo/sem cadastro no Atlas): localidadeId e localDescricao nulos, o PC continua sugerido', () => {
    const r = montar(itemNf(), [pcCopia({ codigoLocalEstoque: LOCAL_TRANSITO_OMIE })], LOCAIS);
    expect(r.pc.candidatos).toHaveLength(1);
    expect(r.pc.candidatos[0]).toMatchObject({ localidadeId: null, localDescricao: null });
  });

  it('PC sem local nenhum: nulos', () => {
    const semLocal = pcCopia();
    delete (semLocal as { codigoLocalEstoque?: number }).codigoLocalEstoque;
    const r = montar(itemNf(), [semLocal], LOCAIS);
    expect(r.pc.candidatos[0]).toMatchObject({ localidadeId: null, localDescricao: null });
  });

  it('contexto SEM mapa de locais (NF da Q2P): nulos mesmo que o PC tenha local — a NF da Q2P nao muda', () => {
    const r = montar(itemNf(), [pcCopia({ codigoLocalEstoque: LOCAL_2007_OMIE })]);
    expect(r.pc.candidatos[0]).toMatchObject({ pcNumero: '580', localidadeId: null, localDescricao: null });
  });

  it('o codigo OMIE do local nunca aparece em texto da tela (ACXEGDP-313)', () => {
    const r = montar(itemNf({ vinculos: [{ nSequencia: 1, nIdPedido: 8516990580, nIdItPedido: 8516990581 }] }), [pcCopia()], LOCAIS);
    const textos = [r.pc.alertaVinculoOmie ?? '', r.pc.semPcMotivo ?? '', ...[r.pc.vinculoOmie, ...r.pc.candidatos].flatMap((c) => (c ? [c.motivo, c.localDescricao ?? '', c.pcNumero] : []))];
    for (const t of textos) expect(t).not.toMatch(new RegExp(`${LOCAL_2007_OMIE}|\\d{10}`));
  });
});

// ═══ PC por NF ═══════════════════════════════════════════════════════════════

describe('montarPcsDaNf — o local do item do PC atribuido a cada item da nota', () => {
  const tolerancias = { qtd: 0.02, preco: 0.01 };

  it('cada item da NF carrega o local do item do PC que lhe foi atribuido (dois itens, dois locais)', () => {
    const itens = [
      itemNf({ indice: 0, descricao: 'PP PRETO Q35', quantidadeKg: 10000, precoNfKg: 4.8, sequencias: [1], kgPorSequencia: { 1: 10000 } }),
      itemNf({ indice: 1, descricao: 'PS BRANCO', quantidadeKg: 6000, precoNfKg: 6.0, sequencias: [2], kgPorSequencia: { 2: 6000 } }),
    ];
    const pcs = [
      pcCopia({ nCodPed: 50, nCodItem: 51, pcNumero: '700', qtdPedidaKg: 10000, saldoCopiaKg: 10000, precoKg: 4.8, codigoLocalEstoque: LOCAL_2007_OMIE }),
      pcCopia({ nCodPed: 50, nCodItem: 52, pcNumero: '700', qtdPedidaKg: 6000, saldoCopiaKg: 6000, precoKg: 6.0, codigoLocalEstoque: LOCAL_111_OMIE, produtoDescricao: 'PS BRANCO' }),
    ];
    const ctx = contexto(pcs, LOCAIS);
    const paraNf = itens.map((it) => ({ indice: it.indice, quantidadeKg: it.quantidadeKg!, resultado: montarPcDoItem(it, ctx, FORNECEDOR, CHAVE_NF, tolerancias) }));
    const { pcs: pcsDaNf } = montarPcsDaNf(paraNf, tolerancias);
    expect(pcsDaNf).toHaveLength(1);
    const atrib = pcsDaNf[0]!.itens;
    expect(atrib.map((a) => [a.indice, a.nCodItem, a.localidadeId, a.localDescricao])).toEqual([
      [0, 51, ID_2007, '20.0.7 · PRODUÇÃO'],
      [1, 52, ID_111, '11.1 · SANTO ANDRÉ (IMPORTADO)'],
    ]);
  });

  it('sem mapa de locais (NF da Q2P) a atribuicao sai sem local', () => {
    const it = itemNf();
    const ctx = contexto([pcCopia()]);
    const { pcs } = montarPcsDaNf([{ indice: 0, quantidadeKg: 26000, resultado: montarPcDoItem(it, ctx, FORNECEDOR, CHAVE_NF, tolerancias) }], tolerancias);
    expect(pcs[0]!.itens[0]).toMatchObject({ nCodItem: 8516990581, localidadeId: null, localDescricao: null });
  });
});

// ═══ sugerirPcPorItensComContexto ════════════════════════════════════════════

describe('sugerirPcPorItensComContexto / sugerirPcPorItens', () => {
  it('devolve o resultado por item E o contexto lido (copia + cache + ledger + locais): o detalhe da NF da ACXE usa o produto do PC', async () => {
    banco([linhaBanco()], { rows: [linhaLocal2007] });
    const { resultados, ctx } = await sugerirPcPorItensComContexto('acxe', FORNECEDOR, CHAVE_NF, [itemNf()]);
    expect(resultados.get(0)!.pc.candidatos[0]).toMatchObject({ pcNumero: '580', localidadeId: ID_2007 });
    expect(ctx.pcs.map((p) => [p.pcNumero, p.nCodProd, p.codigoLocalEstoque])).toEqual([['580', PRODUTO_PP, LOCAL_2007_OMIE]]);
    expect(ctx.locais!.size).toBe(1);
  });

  it('sugerirPcPorItens continua devolvendo so o mapa de resultados, igual ao do contexto', async () => {
    banco([linhaBanco()], { rows: [linhaLocal2007] });
    const soMapa = await sugerirPcPorItens('acxe', FORNECEDOR, CHAVE_NF, [itemNf()]);
    banco([linhaBanco()], { rows: [linhaLocal2007] });
    const { resultados } = await sugerirPcPorItensComContexto('acxe', FORNECEDOR, CHAVE_NF, [itemNf()]);
    expect(soMapa).toBeInstanceOf(Map);
    expect(soMapa).toEqual(resultados);
  });

  it('fornecedor nulo: contexto vazio e nenhum PC (sem consulta)', async () => {
    const { resultados, ctx } = await sugerirPcPorItensComContexto('acxe', null, CHAVE_NF, [itemNf()]);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
    expect(ctx.pcs).toEqual([]);
    expect(resultados.get(0)!.pc.candidatos).toEqual([]);
    expect(resultados.get(0)!.situacao).toBe('sem_pc');
  });

  it('NF da Q2P pelo mesmo caminho: sem local nos candidatos', async () => {
    banco([linhaBanco({ codigo_local_estoque: '8115873874' })]);
    const { resultados, ctx } = await sugerirPcPorItensComContexto('q2p', FORNECEDOR, CHAVE_NF, [itemNf()]);
    expect(ctx).not.toHaveProperty('locais');
    expect(resultados.get(0)!.pc.candidatos[0]).toMatchObject({ pcNumero: '580', localidadeId: null, localDescricao: null });
  });
});
