import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — cenarios do POST por NF da ACXE que complementam
// recebimento-nacional-acxe.test.ts (o caminho feliz e os portoes). Aqui: o 23505 embrulhado do Drizzle nos DOIS
// indices, a escrita best-effort por produto, o rateio de uma linha entre estoques de naturezas diferentes
// (compartilhado x so ACXE), a divergencia de peso, NF incompleta ANTES de qualquer consulta da ACXE, a baixa do
// pedido (344) que o POST nunca dispara e o formato anterior (detalhe sem `empresa` = Q2P).
// O detalhe (montarDetalheNfNacional), o fiscal e o correspondente do produto na Q2P sao mockados — cada um tem
// teste proprio; o banco e substituido por um fake que registra os INSERTs.

const poolQuerySpy = vi.fn();
const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
/** erros a lancar nos proximos INSERTs de movimentacao (um por insert, na ordem) */
let falhasInsertMov: Array<(() => unknown) | null> = [];

const spies = vi.hoisted(() => ({
  detalhe: vi.fn(),
  fiscal: vi.fn(),
  gemeos: vi.fn(),
  consultarRecebimento: vi.fn(),
  digest: vi.fn(),
  registrarUso: vi.fn(),
  baixa: vi.fn(),
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
              if (table.__id === 'movimentacao' && falhasInsertMov.length > 0) {
                const f = falhasInsertMov.shift();
                if (f) throw f();
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

// a baixa do pedido de compra Q2P (344) so existe para a importacao: o POST nao pode chama-la
vi.mock('../services/baixa-pedido.service.js', () => ({ dispararBaixaPedidoQ2p: (a: unknown) => spies.baixa(a) }));

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
  ValidacaoRecebimentoNacionalError,
  LocalidadeNaoElegivelError,
  type ProcessarRecebimentoPorNfInput,
} from '../services/recebimento-nacional.service.js';
import { converterItemNfParaKg } from '../services/unidade-nf.js';
import type { DetalheNfNacional, DetalheNfNacionalInterno, ItemNfNacional } from '../services/fila-nacional.service.js';
import type { ProdutoAcxeComGemeo } from '../services/produto-gemeo-q2p.js';

const CHAVE = '35261011111111000111550010000009370000009370';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DESC = 'SUCATA PP CLASSIFICADA';

const LOC_21_1 = '21111111-1111-4111-8111-111111111111';
const LOC_20_0_7 = '20000000-0000-4000-8000-000000000007';
const LOC_Q2P = '11222222-2222-4222-8222-222222222222';

const PROD_A = 4001; // grau A: tem gemeo na Q2P
const PROD_B = 4002; // grau B: mesmo gemeo de A (mesma descricao) — so pode ir a UM estoque compartilhado
const PROD_C = 4003; // grau C: sem gemeo
const GEMEO = 9001;

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
    nfChaveAcesso: CHAVE, notaFiscal: '937', fornecedorNome: 'SOLUTEC PLASTICOS LTDA', fornecedorCnpj: '11.111.111/0001-11',
    dtEmissao: '2026-10-20', diasDesdeEmissao: 2, cfop: '1.101', valorTotalBrl: 124800, valorNotaBrl: 124800, itens: [item()],
    linhasForaDoRecorte: 0, fiscal: 'concluido', nIdReceb: 8517930857, dispensavel: true,
    empresa: 'acxe', exigePc: false, estoqueLancadoPeloOmie: false, copiaPcsDefasada: false, itensSemAvaliacaoPc: [],
    pcsDaNf: { pcs: [], preSelecionado: null },
    ...over,
  };
}

const catalogo = (): Map<number, ProdutoAcxeComGemeo> =>
  new Map([
    [PROD_A, { codigoAcxe: PROD_A, descricaoAcxe: 'SUCATA PP GRAU A', ativoAcxe: true, unidadeAcxe: 'KG', emKgAcxe: true, gemeoQ2p: { codigo: GEMEO, descricao: 'SUCATA PP GRAU A' } }],
    [PROD_B, { codigoAcxe: PROD_B, descricaoAcxe: 'SUCATA PP GRAU A', ativoAcxe: true, unidadeAcxe: 'KG', emKgAcxe: true, gemeoQ2p: { codigo: GEMEO, descricao: 'SUCATA PP GRAU A' } }],
    [PROD_C, { codigoAcxe: PROD_C, descricaoAcxe: 'SUCATA PP GRAU C', ativoAcxe: true, unidadeAcxe: 'KG', emKgAcxe: true, gemeoQ2p: null }],
  ]);

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

const movs = () => inserts.filter((i) => i.table === 'movimentacao').map((i) => i.values);
const aprs = () => inserts.filter((i) => i.table === 'aprovacao').map((i) => i.values);
const post = (produtos: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  ({
    nfChaveAcesso: CHAVE,
    userId: USER,
    itens: [{ indice: 0, descricaoFornecedor: DESC, produtos, ...extra }],
  }) as unknown as ProcessarRecebimentoPorNfInput;
const acxe = (produtoCodigoAcxe: number, localidadeId: string, quantidadeKg: number) => ({ produtoCodigoAcxe, quantidadeKg, localidadeId });
const violacao = (constraint: string) => () => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint });

beforeEach(() => {
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) => Promise.resolve(poolPadrao(sql, params)));
  inserts.length = 0;
  falhasInsertMov = [];
  det = detalhe();
  interno = { fornecedorCodigo: 1111, espelhoConfirmaConclusao: true, pcPorIndice: new Map() };
  spies.detalhe.mockReset();
  spies.detalhe.mockImplementation(async () => ({ detalhe: det, interno }));
  spies.fiscal.mockReset();
  spies.fiscal.mockResolvedValue({ status: 'concluido', concluidoEm: '2026-10-22T10:00:00.000Z', ledgerId: 'l-1', itensTotal: 1, vinculos: [], semVinculo: [] });
  spies.gemeos.mockReset();
  spies.gemeos.mockImplementation(async () => catalogo());
  spies.consultarRecebimento.mockReset();
  spies.digest.mockReset();
  spies.digest.mockResolvedValue(undefined);
  spies.registrarUso.mockReset();
  spies.baixa.mockReset();
});

describe('idempotencia: o 23505 embrulhado pelo Drizzle (cause) nos DOIS indices', () => {
  // Em producao o erro do pg chega dentro de uma DrizzleQueryError: .code/.constraint ficam em .cause (as vezes mais
  // fundo). Com banco real isso e provado em auditoria-recebimento-nacional-acxe.test.ts; aqui, sem banco, o formato.
  const embrulhado = (constraint: string, niveis: number) => () => {
    let e: Record<string, unknown> = { code: '23505', constraint };
    for (let i = 0; i < niveis; i++) e = { cause: e };
    return Object.assign(new Error('Failed query: insert into "movimentacao" ...'), e);
  };

  it.each([
    ['0058 (ACXE)', 'movimentacao_nf_nacional_acxe_idempotencia_idx', 1],
    ['0052 (Q2P)', 'movimentacao_nf_nacional_idempotencia_idx', 1],
    ['0058 (ACXE), dois niveis de cause', 'movimentacao_nf_nacional_acxe_idempotencia_idx', 2],
  ])('indice %s -> ja_recebido (nao falha) e o produto da ACXE vai no resultado', async (_n, constraint, niveis) => {
    falhasInsertMov = [embrulhado(constraint, niveis)];
    const r = await processarRecebimentoNacionalPorNf(post([acxe(PROD_A, LOC_21_1, 26000)]));
    expect(r.produtos[0]).toMatchObject({ status: 'ja_recebido', produtoCodigoAcxe: PROD_A, produtoCodigoQ2p: GEMEO, entradaEm: ['acxe', 'q2p'] });
    expect(r.resumo).toMatchObject({ jaRecebidos: 1, falhas: 0, enviadosParaAprovacao: 0 });
    // nada de movimentacao/aprovacao quando o INSERT da movimentacao caiu no indice
    expect(inserts).toHaveLength(0);
    expect(spies.digest, 'sem nada gravado nao ha digest ao gestor').not.toHaveBeenCalled();
  });

  it('23505 de uma constraint de outra tabela/indice NAO e idempotencia: vira falha com mensagem pt-BR sem codigo OMIE', async () => {
    falhasInsertMov = [embrulhado('movimentacao_pkey', 1)];
    const r = await processarRecebimentoNacionalPorNf(post([acxe(PROD_A, LOC_21_1, 26000)]));
    expect(r.produtos[0]).toMatchObject({ status: 'falha' });
    expect(r.produtos[0]!.mensagemErro).toBe('Não foi possível registrar "SUCATA PP GRAU A". Tente novamente; o que já entrou não será duplicado.');
    expect(r.resumo).toMatchObject({ falhas: 1, enviadosParaAprovacao: 0 });
  });
});

describe('escrita best-effort por produto (cada um na propria transacao)', () => {
  it('o 1o produto cai no indice (ja_recebido) e o 2o e gravado; o digest leva so o gravado', async () => {
    falhasInsertMov = [violacao('movimentacao_nf_nacional_acxe_idempotencia_idx')];
    const r = await processarRecebimentoNacionalPorNf(post([acxe(PROD_A, LOC_20_0_7, 13000), acxe(PROD_C, LOC_20_0_7, 13000)]));
    expect(r.resumo).toEqual({ enviadosParaAprovacao: 1, jaRecebidos: 1, bloqueados: 0, falhas: 0 });
    expect(movs()).toHaveLength(1);
    expect(movs()[0]).toMatchObject({ produtoCodigoAcxe: PROD_C, galpao: '20.0.7' });
    expect(spies.digest).toHaveBeenCalledTimes(1);
    expect(spies.digest.mock.calls[0]![0].itens).toHaveLength(1);
  });

  it('falha de infraestrutura num produto: status falha com entradaEm, o outro segue gravado', async () => {
    falhasInsertMov = [() => new Error('connection reset')];
    const r = await processarRecebimentoNacionalPorNf(post([acxe(PROD_A, LOC_20_0_7, 13000), acxe(PROD_C, LOC_20_0_7, 13000)]));
    const falha = r.produtos.find((p) => p.status === 'falha')!;
    expect(falha).toMatchObject({ produtoCodigoAcxe: PROD_A, entradaEm: ['acxe'], quantidadeKg: 13000 });
    expect(falha.mensagemErro).not.toMatch(/connection reset/); // erro tecnico nao vai ao operador
    expect(r.resumo).toMatchObject({ enviadosParaAprovacao: 1, falhas: 1 });
    expect(movs().map((m) => m.produtoCodigoAcxe)).toEqual([PROD_C]);
  });
});

describe('uma linha da NF em varios produtos e estoques de naturezas diferentes', () => {
  it('grau A no 21.1 (nas duas empresas) + grau C no 20.0.7 (so ACXE): rateio do valor, mesmo custo por kg, cada um com a sua marca', async () => {
    const r = await processarRecebimentoNacionalPorNf(post([acxe(PROD_A, LOC_21_1, 16000), acxe(PROD_C, LOC_20_0_7, 10000)]));
    expect(r.resumo.enviadosParaAprovacao).toBe(2);
    const porProduto = Object.fromEntries(movs().map((m) => [String(m.produtoCodigoAcxe), m]));
    expect(porProduto[String(PROD_A)]).toMatchObject({
      produtoCodigoQ2p: GEMEO, galpao: '21.1', quantidadeKg: '16000', quantidadeNfKg: '16000', custoUnitarioBrl: '4.8', empresa: 'acxe',
    });
    expect(porProduto[String(PROD_C)]).toMatchObject({
      produtoCodigoQ2p: null, galpao: '20.0.7', quantidadeKg: '10000', quantidadeNfKg: '10000', custoUnitarioBrl: '4.8', empresa: 'acxe',
    });
    // as duas aprovacoes (uma por produto) acompanham: produto da Q2P so na do estoque compartilhado
    const apr = Object.fromEntries(aprs().map((a) => [String(a.produtoCodigoAcxe), a]));
    expect(apr[String(PROD_A)]).toMatchObject({ produtoCodigoQ2p: GEMEO, galpao: '21.1', precisaNivel: 'gestor' });
    expect(apr[String(PROD_C)]).toMatchObject({ produtoCodigoQ2p: null, galpao: '20.0.7', precisaNivel: 'gestor' });
    // resultado ordenado pelo codigo do produto da ACXE; valor dos itens fecha no valor da linha da NF
    expect(r.produtos.map((p) => p.produtoCodigoAcxe)).toEqual([PROD_A, PROD_C]);
    expect(r.produtos.reduce((s, p) => s + (p.valorItemBrl ?? 0), 0)).toBeCloseTo(124800, 2);
    // o digest diz o destino de cada produto
    expect(spies.digest.mock.calls[0]![0].itens.map((i: { empresa: string; galpao: string }) => `${i.empresa}@${i.galpao}`).sort()).toEqual(['ACXE + Q2P@21.1', 'ACXE@20.0.7']);
  });

  it('o mesmo correspondente em estoque compartilhado E em estoque so da ACXE: o correspondente vai so para o compartilhado', async () => {
    const r = await processarRecebimentoNacionalPorNf(post([acxe(PROD_A, LOC_21_1, 13000), acxe(PROD_B, LOC_20_0_7, 13000)]));
    expect(r.resumo.enviadosParaAprovacao).toBe(2);
    expect(Object.fromEntries(movs().map((m) => [String(m.produtoCodigoAcxe), m.produtoCodigoQ2p]))).toEqual({ [PROD_A]: GEMEO, [PROD_B]: null });
  });

  it('a soma dos produtos tem de fechar com o que falta receber (DISTRIBUICAO_NAO_FECHA): nada consultado nem gravado', async () => {
    const err = await processarRecebimentoNacionalPorNf(post([acxe(PROD_A, LOC_21_1, 10000), acxe(PROD_C, LOC_20_0_7, 10000)])).catch((e: Error) => e);
    expect((err as ValidacaoRecebimentoNacionalError).code).toBe('DISTRIBUICAO_NAO_FECHA');
    expect(inserts).toHaveLength(0);
    expect(spies.gemeos).not.toHaveBeenCalled();
    expect(spies.fiscal).not.toHaveBeenCalled();
  });
});

describe('divergencia de peso na NF da ACXE', () => {
  const conferida = (kg: number, extra: Record<string, unknown> = {}) =>
    post([acxe(PROD_A, LOC_21_1, kg)], { quantidadeConferidaKg: kg, ...extra });

  it('sem motivo: MOTIVO_DIVERGENCIA_OBRIGATORIO e nada gravado', async () => {
    const err = await processarRecebimentoNacionalPorNf(conferida(25900)).catch((e: Error) => e);
    expect((err as ValidacaoRecebimentoNacionalError).code).toBe('MOTIVO_DIVERGENCIA_OBRIGATORIO');
    expect(inserts).toHaveLength(0);
  });

  it('com motivo: custo = valor do item / kg CONFERIDO (6 casas), divergencia gravada e o motivo na observacao das duas gravacoes', async () => {
    const r = await processarRecebimentoNacionalPorNf(conferida(25900, { motivoDivergencia: 'Balança nova — conferido duas vezes' }));
    expect(r.produtos[0]).toMatchObject({ status: 'aguardando_aprovacao', quantidadeKg: 25900, quantidadeNfKg: 26000, divergenciaKg: -100 });
    expect(movs()[0]).toMatchObject({ quantidadeKg: '25900', quantidadeNfKg: '26000', quantidadeDivergenciaKg: '-100', custoUnitarioBrl: '4.818533' });
    expect(aprs()[0]).toMatchObject({ quantidadePrevistaKg: '26000', quantidadeRecebidaKg: '25900' });
    for (const texto of [String(movs()[0]!.observacoes), String(aprs()[0]!.observacoes)]) {
      expect(texto).toContain('Divergência: NF 26.000 kg × conferido 25.900 kg (-100 kg) — Balança nova — conferido duas vezes');
      expect(texto).toContain('Empresa: ACXE + Q2P · Estoque 21.1');
    }
  });

  it('dentro da tolerancia de 1 kg nao pede motivo', async () => {
    const r = await processarRecebimentoNacionalPorNf(conferida(25999.5));
    expect(r.resumo.enviadosParaAprovacao).toBe(1);
  });
});

describe('ordem dos portoes e o que o POST nunca faz', () => {
  it('NF incompleta (fiscal pendente = NF inteira): recusada ANTES de consultar produto/estoque da ACXE e do fiscal', async () => {
    det = detalhe({
      fiscal: 'pendente',
      itens: [item(), item({ indice: 1, descricaoFornecedor: 'OUTRO ITEM', descricaoNormalizada: 'OUTRO ITEM' })],
    });
    const err = await processarRecebimentoNacionalPorNf(post([acxe(PROD_A, LOC_21_1, 26000)])).catch((e: Error) => e);
    expect((err as ValidacaoRecebimentoNacionalError).code).toBe('NF_INCOMPLETA');
    expect((err as Error).message).toContain('"OUTRO ITEM"');
    expect(spies.gemeos).not.toHaveBeenCalled();
    expect(spies.fiscal).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it('estoque recusado pelo servidor: a mensagem ao operador nao traz UUID nem codigo do OMIE (ACXEGDP-313)', async () => {
    const err = await processarRecebimentoNacionalPorNf(post([acxe(PROD_A, LOC_Q2P, 26000)])).catch((e: Error) => e);
    expect(err).toBeInstanceOf(LocalidadeNaoElegivelError);
    expect((err as Error).message).not.toContain(LOC_Q2P);
    expect((err as Error).message).not.toMatch(/\d{7,}/);
  });

  it('o POST nunca baixa o pedido de compra da Q2P (344) nem memoriza fornecedor x descricao, mesmo com tudo gravado', async () => {
    await processarRecebimentoNacionalPorNf(post([acxe(PROD_A, LOC_21_1, 26000)]));
    expect(movs()).toHaveLength(1);
    expect(spies.baixa).not.toHaveBeenCalled();
    expect(spies.registrarUso).not.toHaveBeenCalled();
    // e nenhum dos INSERTs carrega marca de baixa (so a importacao grava baixa_pedido_q2p)
    for (const m of movs()) expect(m).not.toHaveProperty('baixaPedidoQ2p');
  });

  it('fiscal ja confirmado pelo espelho: o OMIE da ACXE nao e consultado ao vivo', async () => {
    interno = { ...interno, espelhoConfirmaConclusao: true };
    await processarRecebimentoNacionalPorNf(post([acxe(PROD_A, LOC_20_0_7, 26000)]));
    expect(spies.consultarRecebimento).not.toHaveBeenCalled();
    expect(spies.fiscal).not.toHaveBeenCalled(); // fiscal ja concluido: nada a fazer
  });

  it('a validacao dos estoques consulta o banco UMA vez por POST (nao por produto)', async () => {
    await processarRecebimentoNacionalPorNf(post([acxe(PROD_A, LOC_21_1, 13000), acxe(PROD_C, LOC_20_0_7, 13000)]));
    const consultasDestino = poolQuerySpy.mock.calls.filter((c) => String(c[0]).includes("l.tipo NOT LIKE 'virtual%'"));
    expect(consultasDestino).toHaveLength(1);
    expect(spies.gemeos).toHaveBeenCalledTimes(1);
    expect(spies.gemeos.mock.calls[0]![0].sort()).toEqual([PROD_A, PROD_C]);
  });
});

// Retomada da MESMA linha da NF num segundo POST com um produto B da ACXE de mesmo correspondente na Q2P que um produto A ja
// gravado (ambos em estoque compartilhado): batia no indice da 0052 (nf + linha + produto da Q2P) e virava `ja_recebido`,
// perdendo o peso em silencio. A 0058 restringiu esse indice a Q2P (empresa = 'q2p'); a linha da ACXE fica so com o indice
// por produto da ACXE. Coberto com banco real em auditoria-recebimento-nacional-acxe.test.ts ("a 0058 restringe o indice
// da 0052 a Q2P"). Dentro do MESMO POST a repeticao continua recusada (PRODUTO_CORRELATO_Q2P_REPETIDO, acima).

describe('formato anterior e Q2P', () => {
  it('detalhe SEM empresa (formato anterior) e tratado como Q2P: o produto da ACXE e recusado e o da Q2P segue o caminho de sempre', async () => {
    const { empresa: _e, ...semEmpresa } = detalhe();
    det = semEmpresa as DetalheNfNacional;
    const err = await processarRecebimentoNacionalPorNf(post([acxe(PROD_A, LOC_21_1, 26000)])).catch((e: Error) => e);
    expect((err as ValidacaoRecebimentoNacionalError).code).toBe('PRODUTO_EMPRESA_INCOMPATIVEL');
    expect((err as Error).message).toContain('é da Q2P');
    expect(spies.gemeos).not.toHaveBeenCalled();
  });
});
