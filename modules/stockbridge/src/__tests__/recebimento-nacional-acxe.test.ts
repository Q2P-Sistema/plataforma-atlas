import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — processarRecebimentoNacionalPorNf para NF da ACXE.
// O detalhe (montarDetalheNfNacional), o fiscal (concluirRecebimentoFiscal) e o correspondente do produto
// na Q2P (resolverGemeosQ2p) sao mockados — cada um tem teste proprio. Aqui se prova o que o POST faz com a
// empresa da NF: produto/estoque validados no portao 1 (ANTES do fiscal), o que e gravado (produto da ACXE;
// produto da Q2P so no estoque que entra nas duas empresas), idempotencia pelos dois indices, a trava de estoque
// ja lancado consultando o OMIE da ACXE, e que a Q2P nao e tocada.

const poolQuerySpy = vi.fn();
const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
let falhaInsertMov: (() => unknown) | null = null;

const spies = vi.hoisted(() => ({
  detalhe: vi.fn(),
  fiscal: vi.fn(),
  gemeos: vi.fn(),
  consultarRecebimento: vi.fn(),
  digest: vi.fn(),
  registrarUso: vi.fn(),
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
  getConfig: () => ({ STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE: '2026-09-11', STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED: true }),
  getDb: () => ({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: (table: { __id: string }) => ({
          values: (v: Record<string, unknown>) => ({
            returning: async () => {
              if (table.__id === 'movimentacao' && falhaInsertMov) {
                const err = falhaInsertMov();
                falhaInsertMov = null;
                throw err;
              }
              inserts.push({ table: table.__id, values: v });
              return [{ id: `${table.__id}-${inserts.length}`, ...v }];
            },
          }),
        }),
      };
      return fn(tx);
    },
  }),
}));

vi.mock('@atlas/db', () => ({
  movimentacao: { __id: 'movimentacao' },
  aprovacao: { __id: 'aprovacao' },
  users: { __id: 'users' },
}));

vi.mock('@atlas/integration-omie', () => ({
  consultarRecebimentoNfe: (...a: unknown[]) => spies.consultarRecebimento(...a),
  alterarRecebimentoNfeItens: vi.fn(),
  concluirRecebimentoNfe: vi.fn(),
  consultarPedidoCompra: vi.fn(),
  incluirAjusteEstoque: vi.fn(),
  listarAjusteEstoque: vi.fn(),
  consultarNF: vi.fn(),
  isMockMode: () => false,
}));

vi.mock('../services/notificacao.service.js', () => ({
  enviarAlertaRecebimentoNacionalLote: (a: unknown) => spies.digest(a),
  enviarAvisoComprasNfSemPc: vi.fn().mockResolvedValue('enviado'),
}));

vi.mock('../services/correlacao-produto.service.js', () => ({
  registrarUsoCorrelacao: (a: unknown) => spies.registrarUso(a),
  sugerirProdutosEmLote: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('../services/produto-gemeo-q2p.js', () => ({
  resolverGemeosQ2p: (c: number[]) => spies.gemeos(c),
}));

vi.mock('../services/fila-nacional.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/fila-nacional.service.js')>('../services/fila-nacional.service.js');
  return { ...real, montarDetalheNfNacional: (c: string) => spies.detalhe(c) };
});

vi.mock('../services/recebimento-fiscal.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/recebimento-fiscal.service.js')>('../services/recebimento-fiscal.service.js');
  return { ...real, concluirRecebimentoFiscal: (i: unknown) => spies.fiscal(i) };
});

// D21 da 017 (fiscal revertido no portal): o ledger/sinal/marcacao tem testes proprios (recebimento-nacional-revertido,
// recebimento-fiscal, fiscal-revertido). Aqui a D21 fica DESLIGADA: o clique de "fiscal ja feito" segue so a D7 (leitura
// ao vivo apenas sem a conclusao confirmada localmente) e nao depende do que o pool simulado devolve ao information_schema.
vi.mock('../services/fiscal-revertido.js', async () => {
  const real = await vi.importActual<typeof import('../services/fiscal-revertido.js')>('../services/fiscal-revertido.js');
  return { ...real, fiscalRevertidoHabilitado: async () => false };
});

import {
  processarRecebimentoNacionalPorNf,
  processarRecebimentoNacional,
  ProdutoSemCorrelatoQ2pError,
  ProdutoCorrelatoQ2pRepetidoError,
  ProdutoNaoEncontradoError,
  LocalidadeNaoElegivelError,
  ValidacaoRecebimentoNacionalError,
} from '../services/recebimento-nacional.service.js';
import { EstoqueJaLancadoPeloOmieError } from '../services/fila-nacional.service.js';
import { RecebimentoFiscalError } from '../services/recebimento-fiscal.service.js';
import { converterItemNfParaKg } from '../services/unidade-nf.js';
import type { DetalheNfNacional, DetalheNfNacionalInterno, ItemNfNacional } from '../services/fila-nacional.service.js';
import type { ProdutoAcxeComGemeo } from '../services/produto-gemeo-q2p.js';

const CHAVE = '35261011111111000111550010000009370000009370';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FORNECEDOR = 'SOLUTEC PLASTICOS LTDA';
const DESC = 'PP PRETO Q35';

// Locais da ACXE no Atlas: 21.1 (tambem da Q2P), 20.0.7 (so ACXE), 11.2 (so Q2P — nao e destino da ACXE), 90.0.2 (virtual).
const LOC_21_1 = '21111111-1111-4111-8111-111111111111';
const LOC_20_0_7 = '20000000-0000-4000-8000-000000000007';
const LOC_Q2P = '11222222-2222-4222-8222-222222222222';
const LOC_VIRTUAL = '90000000-0000-4000-8000-000000000002';

const PROD_PP_PRETO = 4001; // tem gemeo na Q2P
const PROD_SEM_GEMEO = 4002; // sem gemeo na Q2P
const PROD_PP_PRETO_B = 4003; // outro produto da ACXE com o MESMO gemeo de 4001
const GEMEO_PP_PRETO = 9001;

function item(o: Partial<ItemNfNacional> = {}): ItemNfNacional {
  const conv = converterItemNfParaKg(26000, 'KG', 124800);
  return {
    indice: 0, descricaoFornecedor: DESC, descricaoNormalizada: DESC, cfop: '1.101', quantidadeNf: 26000, unidadeOriginal: 'KG',
    quantidadeNfKg: 26000, valorUnitarioBrl: 4.8, valorTotalItemBrl: 124800, rsPorKg: 4.8, linhasAgregadas: 1, produtosSugeridos: [],
    bloqueio: 'sem_correlacao', bloqueioMensagem: null, jaRecebido: false, quantidadeNfJaAtribuidaKg: 0, quantidadeConferidaJaGravadaKg: 0,
    quantidadeRestanteKg: 26000, baixadoComoExterno: false, baixaSolicitada: false, conversao: conv, sequenciasRecebimento: [1], pc: null,
    ...o,
  };
}

function detalhe(over: Partial<DetalheNfNacional> = {}): DetalheNfNacional {
  return {
    nfChaveAcesso: CHAVE, notaFiscal: '937', fornecedorNome: FORNECEDOR, fornecedorCnpj: '11.111.111/0001-11',
    dtEmissao: '2026-10-20', diasDesdeEmissao: 2, cfop: '1.101', valorTotalBrl: 124800, valorNotaBrl: 124800, itens: [item()],
    linhasForaDoRecorte: 0, fiscal: 'concluido', nIdReceb: 8517930857, dispensavel: true,
    empresa: 'acxe', exigePc: false, estoqueLancadoPeloOmie: false, copiaPcsDefasada: false, itensSemAvaliacaoPc: [],
    pcsDaNf: { pcs: [], preSelecionado: null },
    ...over,
  };
}

function produtoAcxe(codigo: number, descricao: string, gemeo: { codigo: number; descricao: string } | null, ativo = true): ProdutoAcxeComGemeo {
  return { codigoAcxe: codigo, descricaoAcxe: descricao, ativoAcxe: ativo, unidadeAcxe: 'KG', emKgAcxe: true, gemeoQ2p: gemeo };
}

const catalogoPadrao = (): Map<number, ProdutoAcxeComGemeo> =>
  new Map([
    [PROD_PP_PRETO, produtoAcxe(PROD_PP_PRETO, 'PP PRETO Q35', { codigo: GEMEO_PP_PRETO, descricao: 'PP PRETO Q35' })],
    [PROD_SEM_GEMEO, produtoAcxe(PROD_SEM_GEMEO, 'SUCATA DE PLASTICO', null)],
    [PROD_PP_PRETO_B, produtoAcxe(PROD_PP_PRETO_B, 'PP PRETO Q35', { codigo: GEMEO_PP_PRETO, descricao: 'PP PRETO Q35' })],
  ]);

/** Estoques da ACXE como a consulta do servidor os devolve: so os validos para a ACXE (ativos, nao virtuais, com codigo ACXE). */
function poolPadrao(sql: string, params?: unknown[]) {
  if (sql.includes('stockbridge.localidade l') && sql.includes("l.tipo NOT LIKE 'virtual%'")) {
    const ids = (params?.[0] as string[]) ?? [];
    const destinos: Record<string, { codigo: string; codigo_acxe: string; codigo_q2p: string | null }> = {
      [LOC_21_1]: { codigo: '21.1', codigo_acxe: '4553940001', codigo_q2p: '4553940002' },
      [LOC_20_0_7]: { codigo: '20.0.7', codigo_acxe: '4553940398', codigo_q2p: null },
    };
    return { rows: ids.filter((id) => destinos[id]).map((id) => ({ id, ...destinos[id]! })) };
  }
  return { rows: [] };
}

let det: DetalheNfNacional;
let interno: DetalheNfNacionalInterno;

const post = (produtos: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  nfChaveAcesso: CHAVE,
  userId: USER,
  itens: [{ indice: 0, descricaoFornecedor: DESC, produtos, ...extra }],
});
const produtoAcxeNoLocal = (produtoCodigoAcxe: number, localidadeId: string, quantidadeKg = 26000) => ({ produtoCodigoAcxe, quantidadeKg, localidadeId });

const movs = () => inserts.filter((i) => i.table === 'movimentacao').map((i) => i.values);
const aprs = () => inserts.filter((i) => i.table === 'aprovacao').map((i) => i.values);
const movOuAprovacao = () => inserts.filter((i) => i.table === 'movimentacao' || i.table === 'aprovacao');

beforeEach(() => {
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) => Promise.resolve(poolPadrao(sql, params)));
  inserts.length = 0;
  falhaInsertMov = null;
  det = detalhe();
  interno = { fornecedorCodigo: 1111, espelhoConfirmaConclusao: true, pcPorIndice: new Map() };
  spies.detalhe.mockReset();
  spies.detalhe.mockImplementation(async () => ({ detalhe: det, interno }));
  spies.fiscal.mockReset();
  spies.fiscal.mockResolvedValue({ status: 'concluido', concluidoEm: '2026-10-22T10:00:00.000Z', ledgerId: 'l-1', itensTotal: 1, vinculos: [], semVinculo: [] });
  spies.gemeos.mockReset();
  spies.gemeos.mockImplementation(async () => catalogoPadrao());
  spies.consultarRecebimento.mockReset();
  spies.digest.mockReset();
  spies.digest.mockResolvedValue(undefined);
  spies.registrarUso.mockReset();
  spies.registrarUso.mockResolvedValue({ criada: true });
});

describe('NF da ACXE em estoque so da ACXE (20.0.7)', () => {
  it('grava movimentacao + aprovacao da ACXE: produto da ACXE, SEM produto da Q2P, custo da NF, status pendente_q2p, empresa acxe', async () => {
    const r = await processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7)]));
    expect(r.resumo).toEqual({ enviadosParaAprovacao: 1, jaRecebidos: 0, bloqueados: 0, falhas: 0 });

    expect(movs()).toHaveLength(1);
    expect(movs()[0]).toMatchObject({
      notaFiscal: '937', tipoMovimento: 'entrada_manual', subtipo: 'compra_nacional', loteId: null,
      produtoCodigoAcxe: PROD_PP_PRETO, produtoCodigoQ2p: null, galpao: '20.0.7', empresa: 'acxe',
      criadoPor: USER, quantidadeKg: '26000', nfChaveAcesso: CHAVE, nfItemDescricao: DESC, nfItemSequencias: [1],
      custoUnitarioBrl: '4.8', statusOmie: 'pendente_q2p',
    });
    expect(aprs()[0]).toMatchObject({
      loteId: null, produtoCodigoAcxe: PROD_PP_PRETO, produtoCodigoQ2p: null, galpao: '20.0.7', empresa: 'acxe',
      precisaNivel: 'gestor', tipoAprovacao: 'entrada_manual', movimentacaoId: 'movimentacao-1',
      quantidadePrevistaKg: '26000', quantidadeRecebidaKg: '26000', nfChaveAcesso: CHAVE, notaFiscal: '937', nfItemDescricao: DESC,
    });
  });

  it('o resultado traz entradaEm [acxe], o produto da ACXE e produtoCodigoQ2p nulo', async () => {
    const r = await processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7)]));
    expect(r.produtos[0]).toMatchObject({
      status: 'aguardando_aprovacao', produto: 'PP PRETO Q35', produtoCodigoAcxe: PROD_PP_PRETO, produtoCodigoQ2p: null, entradaEm: ['acxe'],
      quantidadeKg: 26000, valorItemBrl: 124800,
    });
  });

  it('a observacao diz "Empresa: ACXE · Estoque 20.0.7" (sem "espelhado") e o digest vai com a empresa ACXE', async () => {
    await processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7)]));
    const obs = String(movs()[0]!.observacoes);
    expect(obs).toContain('Produto: PP PRETO Q35 | Empresa: ACXE · Estoque 20.0.7');
    expect(obs).not.toMatch(/espelh/i);
    expect(spies.digest).toHaveBeenCalledTimes(1);
    expect(spies.digest.mock.calls[0]![0]).toMatchObject({ notaFiscal: '937', nivel: 'gestor', itens: [{ produto: 'PP PRETO Q35', empresa: 'ACXE', galpao: '20.0.7', quantidadeKg: 26000 }] });
  });

  it('produto sem correspondente na Q2P PODE entrar no estoque so da ACXE', async () => {
    const r = await processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_SEM_GEMEO, LOC_20_0_7)]));
    expect(r.resumo.enviadosParaAprovacao).toBe(1);
    expect(movs()[0]).toMatchObject({ produtoCodigoAcxe: PROD_SEM_GEMEO, produtoCodigoQ2p: null });
  });

  it('nao memoriza fornecedor x descricao (a memoria e so da Q2P)', async () => {
    await processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7)]));
    expect(spies.registrarUso).not.toHaveBeenCalled();
  });
});

describe('NF da ACXE em estoque que tambem e da Q2P (21.1)', () => {
  it('grava o produto da ACXE E o correspondente da Q2P (a marca da entrada nas duas empresas)', async () => {
    const r = await processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_21_1)]));
    expect(movs()[0]).toMatchObject({ produtoCodigoAcxe: PROD_PP_PRETO, produtoCodigoQ2p: GEMEO_PP_PRETO, galpao: '21.1', empresa: 'acxe', custoUnitarioBrl: '4.8', statusOmie: 'pendente_q2p' });
    expect(aprs()[0]).toMatchObject({ produtoCodigoAcxe: PROD_PP_PRETO, produtoCodigoQ2p: GEMEO_PP_PRETO, galpao: '21.1', empresa: 'acxe' });
    expect(r.produtos[0]).toMatchObject({ produtoCodigoAcxe: PROD_PP_PRETO, produtoCodigoQ2p: GEMEO_PP_PRETO, entradaEm: ['acxe', 'q2p'] });
  });

  it('a observacao diz "Empresa: ACXE + Q2P · Estoque 21.1" e o digest vai com "ACXE + Q2P"', async () => {
    await processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_21_1)]));
    expect(String(movs()[0]!.observacoes)).toContain('Produto: PP PRETO Q35 | Empresa: ACXE + Q2P · Estoque 21.1');
    expect(spies.digest.mock.calls[0]![0]).toMatchObject({ itens: [{ empresa: 'ACXE + Q2P', galpao: '21.1' }] });
  });

  it('produto SEM correspondente na Q2P: 422 PRODUTO_SEM_CORRELATO_Q2P no portao 1 — nenhum INSERT e o fiscal nao roda', async () => {
    const err = await processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_SEM_GEMEO, LOC_21_1)])).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ProdutoSemCorrelatoQ2pError);
    expect((err as Error).message).toBe(
      'O produto "SUCATA DE PLASTICO" não tem correspondente na Q2P, então não pode entrar em estoque que também é da Q2P. Escolha um estoque só da ACXE ou peça o cadastro do produto na Q2P.',
    );
    expect(movOuAprovacao()).toHaveLength(0);
    expect(spies.fiscal).not.toHaveBeenCalled();
  });

  it('o portao 1 roda ANTES do fiscal mesmo com o fiscal pendente (o fiscal e irreversivel)', async () => {
    det = detalhe({ fiscal: 'pendente' });
    await expect(processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_SEM_GEMEO, LOC_21_1)]))).rejects.toBeInstanceOf(ProdutoSemCorrelatoQ2pError);
    expect(spies.fiscal).not.toHaveBeenCalled();
    expect(movOuAprovacao()).toHaveLength(0);
  });

  it('dois produtos da ACXE da MESMA linha com o MESMO correspondente, ambos em estoque que entra nas duas: 422 PRODUTO_CORRELATO_Q2P_REPETIDO', async () => {
    const err = await processarRecebimentoNacionalPorNf(
      post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_21_1, 13000), produtoAcxeNoLocal(PROD_PP_PRETO_B, LOC_21_1, 13000)]),
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ProdutoCorrelatoQ2pRepetidoError);
    expect((err as Error).message).toContain('"PP PRETO Q35"');
    expect(movOuAprovacao()).toHaveLength(0);
    expect(spies.fiscal).not.toHaveBeenCalled();
  });

  it('o mesmo correspondente com um dos produtos em estoque so da ACXE NAO e repetido (so um vai para a Q2P)', async () => {
    const r = await processarRecebimentoNacionalPorNf(
      post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_21_1, 13000), produtoAcxeNoLocal(PROD_PP_PRETO_B, LOC_20_0_7, 13000)]),
    );
    expect(r.resumo.enviadosParaAprovacao).toBe(2);
    const porProduto = Object.fromEntries(movs().map((m) => [String(m.produtoCodigoAcxe), m.produtoCodigoQ2p]));
    expect(porProduto).toEqual({ [PROD_PP_PRETO]: GEMEO_PP_PRETO, [PROD_PP_PRETO_B]: null });
  });
});

describe('estoque de destino (portao 1)', () => {
  it('estoque so da Q2P (11.2) numa NF da ACXE: LocalidadeNaoElegivelError, nada gravado', async () => {
    const err = await processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_Q2P)])).catch((e: Error) => e);
    expect(err).toBeInstanceOf(LocalidadeNaoElegivelError);
    expect((err as Error).message).toContain('estoques da ACXE');
    expect(movOuAprovacao()).toHaveLength(0);
  });

  it('estoque virtual (90.0.2 TRANSITO, com os dois codigos) tambem e recusado: a consulta filtra por tipo, nao por codigo', async () => {
    await expect(processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_VIRTUAL)]))).rejects.toBeInstanceOf(LocalidadeNaoElegivelError);
    const sqlDestinos = poolQuerySpy.mock.calls.map((c) => String(c[0])).find((q) => q.includes("l.tipo NOT LIKE 'virtual%'"));
    expect(sqlDestinos).toBeDefined();
    expect(sqlDestinos).toContain('l.ativo = true');
    expect(sqlDestinos).toContain('lc.codigo_local_estoque_acxe IS NOT NULL');
    // o servidor nao usa a lista de espelhadas/proprio: nada de tipo = 'proprio' nem 90.0.1
    expect(sqlDestinos).not.toContain("'proprio'");
  });

  it('produto fora do cadastro da ACXE (ou inativo): ProdutoNaoEncontradoError, nada gravado', async () => {
    await expect(processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(999999, LOC_20_0_7)]))).rejects.toBeInstanceOf(ProdutoNaoEncontradoError);
    spies.gemeos.mockResolvedValue(new Map([[PROD_PP_PRETO, produtoAcxe(PROD_PP_PRETO, 'PP PRETO Q35', null, false)]]));
    await expect(processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7)]))).rejects.toBeInstanceOf(ProdutoNaoEncontradoError);
    expect(movOuAprovacao()).toHaveLength(0);
  });
});

describe('produto XOR: o campo e o da empresa da NF', () => {
  it('NF da ACXE com produto da Q2P: 400 PRODUTO_EMPRESA_INCOMPATIVEL, nada consultado nem gravado', async () => {
    const err = await processarRecebimentoNacionalPorNf(post([{ produtoCodigoQ2p: 3033097757, quantidadeKg: 26000, localidadeId: LOC_20_0_7 }])).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidacaoRecebimentoNacionalError);
    expect((err as ValidacaoRecebimentoNacionalError).code).toBe('PRODUTO_EMPRESA_INCOMPATIVEL');
    expect((err as Error).message).toContain('é da ACXE');
    expect(movOuAprovacao()).toHaveLength(0);
    expect(spies.fiscal).not.toHaveBeenCalled();
  });

  it('NF da ACXE com os dois codigos: tambem incompativel', async () => {
    const err = await processarRecebimentoNacionalPorNf(
      post([{ produtoCodigoAcxe: PROD_PP_PRETO, produtoCodigoQ2p: 3033097757, quantidadeKg: 26000, localidadeId: LOC_20_0_7 }]),
    ).catch((e: Error) => e);
    expect((err as ValidacaoRecebimentoNacionalError).code).toBe('PRODUTO_EMPRESA_INCOMPATIVEL');
  });

  it('NF da Q2P com produto da ACXE: 400 PRODUTO_EMPRESA_INCOMPATIVEL', async () => {
    det = detalhe({ empresa: 'q2p' });
    const err = await processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7)])).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidacaoRecebimentoNacionalError);
    expect((err as ValidacaoRecebimentoNacionalError).code).toBe('PRODUTO_EMPRESA_INCOMPATIVEL');
    expect((err as Error).message).toContain('é da Q2P');
  });

  it('a empresa vem da NF, nao do corpo: o produto repetido na linha da ACXE usa o codigo da ACXE', async () => {
    const err = await processarRecebimentoNacionalPorNf(
      post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7, 13000), produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7, 13000)]),
    ).catch((e: Error) => e);
    expect((err as ValidacaoRecebimentoNacionalError).code).toBe('PRODUTO_REPETIDO_NO_ITEM');
  });
});

describe('desfechos antecipados da NF da ACXE (bloqueado, ja recebido)', () => {
  it('item ja recebido e item pendente na mesma NF: o recebido volta ja_recebido com o produto da ACXE; o outro e gravado', async () => {
    const recebido = item({ indice: 0, descricaoFornecedor: 'ITEM RECEBIDO', descricaoNormalizada: 'ITEM RECEBIDO', jaRecebido: true, quantidadeNfJaAtribuidaKg: 26000, quantidadeRestanteKg: 0 });
    const pendente = item({ indice: 1 });
    det = detalhe({ itens: [recebido, pendente] });
    const r = await processarRecebimentoNacionalPorNf({
      nfChaveAcesso: CHAVE,
      userId: USER,
      itens: [
        { indice: 0, descricaoFornecedor: 'ITEM RECEBIDO', produtos: [produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7)] },
        { indice: 1, descricaoFornecedor: DESC, produtos: [produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7)] },
      ],
    });
    expect(r.resumo).toEqual({ enviadosParaAprovacao: 1, jaRecebidos: 1, bloqueados: 0, falhas: 0 });
    const recebidoRes = r.produtos.find((p) => p.status === 'ja_recebido')!;
    expect(recebidoRes).toMatchObject({ indice: 0, produtoCodigoAcxe: PROD_PP_PRETO, produtoCodigoQ2p: null });
    expect(movs()).toHaveLength(1);
  });

  it('item bloqueado por unidade: bloqueado_unidade com o produto da ACXE, sem gravar', async () => {
    const conv = converterItemNfParaKg(100, 'XX', 1000);
    const bloqueado = item({ conversao: conv, quantidadeNfKg: null, quantidadeRestanteKg: null, bloqueio: 'unidade_nao_conversivel', bloqueioMensagem: 'unidade desconhecida' });
    const ok = item({ indice: 1, descricaoFornecedor: 'OUTRO ITEM', descricaoNormalizada: 'OUTRO ITEM' });
    det = detalhe({ itens: [bloqueado, ok] });
    const r = await processarRecebimentoNacionalPorNf({
      nfChaveAcesso: CHAVE,
      userId: USER,
      itens: [
        { indice: 0, descricaoFornecedor: DESC, produtos: [produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7, 100)] },
        { indice: 1, descricaoFornecedor: 'OUTRO ITEM', produtos: [produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7)] },
      ],
    });
    const bl = r.produtos.find((p) => p.status === 'bloqueado_unidade')!;
    expect(bl).toMatchObject({ indice: 0, produtoCodigoAcxe: PROD_PP_PRETO, produtoCodigoQ2p: null, quantidadeKg: 100 });
    expect(movs()).toHaveLength(1);
  });
});

describe('idempotencia da NF da ACXE (indices da 0052 e da 0058)', () => {
  const violacao = (constraint: string) => () => Object.assign(new Error('duplicate key'), { code: '23505', constraint });

  it.each([
    ['indice da ACXE (0058)', 'movimentacao_nf_nacional_acxe_idempotencia_idx'],
    ['indice da Q2P (0052) — entrada nas duas empresas', 'movimentacao_nf_nacional_idempotencia_idx'],
  ])('23505 no %s vira ja_recebido, nao falha', async (_n, constraint) => {
    falhaInsertMov = violacao(constraint);
    const r = await processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_21_1)]));
    expect(r.produtos[0]).toMatchObject({ status: 'ja_recebido', produtoCodigoAcxe: PROD_PP_PRETO, entradaEm: ['acxe', 'q2p'] });
    expect(r.resumo).toMatchObject({ jaRecebidos: 1, falhas: 0 });
  });

  it('23505 de outro indice continua sendo falha (nao e "ja recebido")', async () => {
    falhaInsertMov = violacao('outro_indice_qualquer');
    const r = await processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7)]));
    expect(r.produtos[0]!.status).toBe('falha');
  });
});

describe('estoque ja lancado pelo OMIE: a trava consulta o OMIE da EMPRESA da NF (CRITICO)', () => {
  it('NF da ACXE concluida fora do Atlas e nao confirmada pelo espelho: le o recebimento na ACXE, nao na Q2P', async () => {
    interno = { ...interno, espelhoConfirmaConclusao: false };
    spies.consultarRecebimento.mockResolvedValue({ cRecebido: 'S', itens: [{ nSequencia: 1, cIgnorarItem: 'N', cNaoGerarMovEstoque: 'N' }] });
    await expect(processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7)]))).rejects.toBeInstanceOf(EstoqueJaLancadoPeloOmieError);
    expect(spies.consultarRecebimento).toHaveBeenCalledTimes(1);
    expect(spies.consultarRecebimento).toHaveBeenCalledWith('acxe', { cChaveNfe: CHAVE });
    expect(movOuAprovacao()).toHaveLength(0);
  });

  it('sem estoque lancado no recebimento da ACXE: segue e grava', async () => {
    interno = { ...interno, espelhoConfirmaConclusao: false };
    spies.consultarRecebimento.mockResolvedValue({ cRecebido: 'S', itens: [{ nSequencia: 1, cIgnorarItem: 'S', cNaoGerarMovEstoque: 'N' }] });
    const r = await processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7)]));
    expect(r.resumo.enviadosParaAprovacao).toBe(1);
    expect(spies.consultarRecebimento).toHaveBeenCalledWith('acxe', { cChaveNfe: CHAVE });
  });

  it('o espelho ja diz que o estoque foi lancado (estoqueLancadoPeloOmie): recusa sem chamar o OMIE', async () => {
    det = detalhe({ estoqueLancadoPeloOmie: true });
    await expect(processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_20_0_7)]))).rejects.toBeInstanceOf(EstoqueJaLancadoPeloOmieError);
    expect(spies.consultarRecebimento).not.toHaveBeenCalled();
  });
});

describe('fiscal da NF da ACXE', () => {
  it('fiscal pendente: concluirRecebimentoFiscal recebe a empresa acxe e roda DEPOIS do portao 1', async () => {
    det = detalhe({ fiscal: 'pendente' });
    const r = await processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_21_1)]));
    expect(spies.fiscal).toHaveBeenCalledTimes(1);
    expect(spies.fiscal.mock.calls[0]![0]).toMatchObject({ nfChaveAcesso: CHAVE, empresa: 'acxe', notaFiscal: '937', fornecedorCodigo: 1111 });
    expect(r.fiscal.status).toBe('concluido');
    expect(movs()).toHaveLength(1);
  });

  it('falha do fiscal: o erro sobe e nenhum INSERT (estoque nem aprovacao)', async () => {
    det = detalhe({ fiscal: 'pendente' });
    spies.fiscal.mockRejectedValue(new RecebimentoFiscalError('concluir', '937', FORNECEDOR));
    await expect(processarRecebimentoNacionalPorNf(post([produtoAcxeNoLocal(PROD_PP_PRETO, LOC_21_1)]))).rejects.toBeInstanceOf(RecebimentoFiscalError);
    expect(movOuAprovacao()).toHaveLength(0);
  });
});

describe('a Q2P nao muda', () => {
  it('NF da Q2P continua gravando produto da Q2P, produto da ACXE nulo, empresa q2p e entradaEm [q2p]', async () => {
    det = detalhe({ empresa: 'q2p' });
    poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('stockbridge.localidade l')) {
        return Promise.resolve({ rows: ((params?.[0] as string[]) ?? []).map((id) => ({ id, codigo: '11.2', codigo_acxe: null, codigo_q2p: '8123584710' })) });
      }
      if (sql.includes('tbl_produtos_Q2P')) {
        return Promise.resolve({ rows: ((params?.[0] as number[]) ?? []).map((c) => ({ codigo_produto: String(c), descricao: 'PS CRISTAL A' })) });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await processarRecebimentoNacionalPorNf(post([{ produtoCodigoQ2p: 3033097757, quantidadeKg: 26000, localidadeId: LOC_Q2P }]));
    expect(movs()[0]).toMatchObject({ produtoCodigoAcxe: null, produtoCodigoQ2p: 3033097757, empresa: 'q2p', galpao: '11.2' });
    expect(aprs()[0]).toMatchObject({ produtoCodigoAcxe: null, produtoCodigoQ2p: 3033097757, empresa: 'q2p' });
    expect(r.produtos[0]).toMatchObject({ produtoCodigoQ2p: 3033097757, entradaEm: ['q2p'] });
    expect(r.produtos[0]!.produtoCodigoAcxe).toBeUndefined();
    expect(spies.gemeos).not.toHaveBeenCalled(); // o correspondente so e consultado para a ACXE
    expect(spies.registrarUso).toHaveBeenCalledTimes(1); // a memoria de correlacao segue para a Q2P
    expect(spies.digest.mock.calls[0]![0]).toMatchObject({ itens: [{ empresa: 'q2p' }] });
  });
});

describe('formulario manual (POST /recebimento/nacional): empresa acxe lanca SO na ACXE', () => {
  // processarRecebimentoNacional (015, caminho manual) usa transaction + catalogo; aqui so se prova a sanitizacao
  // do produto da Q2P — a marca da entrada nas duas empresas so o POST por NF a grava.
  it('com empresa acxe, produto_codigo_q2p do corpo e descartado (null na movimentacao e na aprovacao)', async () => {
    poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('stockbridge.localidade l')) {
        return Promise.resolve({ rows: ((params?.[0] as string[]) ?? []).map((id) => ({ id, codigo: '21.2', codigo_acxe: '4553940399', codigo_q2p: null })) });
      }
      if (sql.includes('tbl_produtos_ACXE')) {
        return Promise.resolve({ rows: ((params?.[0] as number[]) ?? []).map((c) => ({ codigo_produto: String(c), descricao: 'PP PRETO Q35' })) });
      }
      return Promise.resolve({ rows: [] });
    });
    await processarRecebimentoNacional({
      notaFiscal: '12345',
      valorTotalNfBrl: 1000,
      userId: USER,
      itens: [
        { empresa: 'acxe', produtoCodigoAcxe: PROD_PP_PRETO, produtoCodigoQ2p: 3033097757, localidadeId: LOC_20_0_7, quantidade: 100, unidade: 'kg', valorUnitarioReferenciaBrl: 10 },
      ],
    });
    expect(movs()[0]).toMatchObject({ empresa: 'acxe', produtoCodigoAcxe: PROD_PP_PRETO, produtoCodigoQ2p: null });
    expect(aprs()[0]).toMatchObject({ empresa: 'acxe', produtoCodigoAcxe: PROD_PP_PRETO, produtoCodigoQ2p: null });
    // sem chave de acesso: nunca "espelhada" (entradaNacionalEspelhada exige a chave)
    expect(movs()[0]).not.toHaveProperty('nfChaveAcesso');
  });
});
