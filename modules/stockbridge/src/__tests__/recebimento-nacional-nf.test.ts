import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 015 (ACXEGDP-328) — processarRecebimentoNacionalPorNf (T027, T027a; cobre
// T017/T018 e o backend de US2/US4: divergencia, distribuicao 1:N, rateio D25).
// O detalhe da NF e mockado (fila-nacional.service tem teste proprio); aqui o foco
// e o que o servico GRAVA e como traduz cada desfecho por produto.

const poolQuerySpy = vi.fn();
const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
let transacoes = 0;
/** Faz o PROXIMO insert em `movimentacao` falhar com este erro (uma vez). */
let falhaInsertMov: (() => unknown) | null = null;
/** Faz a N-esima insercao em `movimentacao` (1-based) falhar com 'disk full'. */
let falharMovNaChamada: number | null = null;
let chamadasMov = 0;

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
  getConfig: () => ({ STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE: '2026-09-11' }),
  getDb: () => ({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      transacoes++;
      const tx = {
        insert: (table: { __id: string }) => ({
          values: (v: Record<string, unknown>) => ({
            returning: async () => {
              if (table.__id === 'movimentacao') {
                chamadasMov++;
                if (falhaInsertMov) {
                  const err = falhaInsertMov();
                  falhaInsertMov = null;
                  throw err;
                }
                if (falharMovNaChamada === chamadasMov) {
                  falharMovNaChamada = null;
                  throw new Error('disk full');
                }
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
  sendEmail: vi.fn().mockResolvedValue(undefined),
  buildEmailLayout: (o: { titulo?: string }) => ({ html: String(o?.titulo ?? ''), text: '' }),
  escapeHtml: (v: unknown) => String(v ?? ''),
  emailDataList: () => '',
  emailActionBox: (h: string) => h,
}));

vi.mock('@atlas/db', () => ({
  movimentacao: { __id: 'movimentacao' },
  aprovacao: { __id: 'aprovacao' },
  users: { __id: 'users' },
}));

vi.mock('@atlas/integration-omie', () => ({
  incluirAjusteEstoque: vi.fn(),
  listarAjusteEstoque: vi.fn(),
  consultarNF: vi.fn(),
  isMockMode: () => false,
}));

const notificacaoSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/notificacao.service.js', () => ({
  enviarAlertaRecebimentoNacionalLote: (a: unknown) => notificacaoSpy(a),
}));

const registrarUsoSpy = vi.fn().mockResolvedValue({ criada: true });
vi.mock('../services/correlacao-produto.service.js', () => ({
  registrarUsoCorrelacao: (a: unknown) => registrarUsoSpy(a),
}));

const detalheMock = vi.fn();
vi.mock('../services/fila-nacional.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/fila-nacional.service.js')>('../services/fila-nacional.service.js');
  return { ...real, getDetalheNfNacional: (c: string) => detalheMock(c) };
});

import {
  processarRecebimentoNacionalPorNf,
  ValidacaoRecebimentoNacionalError,
  NfNacionalJaProcessadaError,
  LocalidadeNaoElegivelError,
  ProdutoNaoEncontradoError,
} from '../services/recebimento-nacional.service.js';
import { converterItemNfParaKg } from '../services/unidade-nf.js';
import type { DetalheNfNacional, ItemNfNacional } from '../services/fila-nacional.service.js';

const CHAVE = '35260868176072000128550010000667241693158505';
const LOC_A = '11111111-1111-4111-8111-111111111111';
const LOC_ESPELHADA = '22222222-2222-4222-8222-222222222222';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function item(o: Partial<ItemNfNacional> & { descricao?: string; q?: number; u?: string; v?: number }): ItemNfNacional {
  const q = o.q ?? 13160, u = o.u ?? 'KG', v = o.v ?? 156604;
  const desc = o.descricao ?? 'SUCATA  PSAI MOIDO MESCLADO GROSSO';
  const conv = converterItemNfParaKg(q, u, v);
  const nfKg = conv.ok ? conv.quantidadeKg : null;
  return {
    indice: 0, descricaoFornecedor: desc, descricaoNormalizada: desc.trim().replace(/\s+/g, ' ').toUpperCase(),
    cfop: '1.102', quantidadeNf: q, unidadeOriginal: u, quantidadeNfKg: nfKg, valorUnitarioBrl: v / q, valorTotalItemBrl: v,
    rsPorKg: conv.ok ? conv.rsPorKg : null, linhasAgregadas: 1, produtosSugeridos: [],
    bloqueio: conv.ok ? 'sem_correlacao' : conv.motivo === 'unidade_incoerente' ? 'unidade_incoerente' : 'unidade_nao_conversivel',
    bloqueioMensagem: conv.ok ? null : conv.mensagem, jaRecebido: false,
    quantidadeNfJaAtribuidaKg: 0, quantidadeConferidaJaGravadaKg: 0,
    quantidadeRestanteKg: nfKg, baixadoComoExterno: false, baixaSolicitada: false, conversao: conv,
    ...o,
  };
}

function detalhe(itens: ItemNfNacional[]): DetalheNfNacional {
  return {
    nfChaveAcesso: CHAVE, notaFiscal: '66724', fornecedorNome: 'ISOFORMA PLASTICOS INDUSTRIAIS LTDA', fornecedorCnpj: '68.176.072/0001-28',
    dtEmissao: '2026-08-06', diasDesdeEmissao: 42, cfop: '1.102',
    valorTotalBrl: itens.reduce((s, i) => s + i.valorTotalItemBrl, 0), itens, linhasForaDoRecorte: 0,
  };
}

/** Localidades e catalogo respondidos pelo pool conforme o SQL. */
function poolPadrao(sql: string, params?: unknown[]) {
  if (sql.includes('stockbridge.localidade l')) {
    const ids = (params?.[0] as string[]) ?? [];
    return {
      rows: ids.map((id) =>
        id === LOC_ESPELHADA
          ? { id, codigo: '11.1', codigo_acxe: '8115873874', codigo_q2p: '8115873875' } // espelhada (ambos)
          : { id, codigo: '11.2', codigo_acxe: null, codigo_q2p: '8123584710' },
      ),
    };
  }
  if (sql.includes('tbl_produtos_Q2P')) {
    const cods = (params?.[0] as number[]) ?? [];
    const nomes: Record<number, string> = { 3033097757: 'PS CRISTAL A', 3033097763: 'PS AI B', 3033097755: 'PS CRISTAL B' };
    return { rows: cods.filter((c) => nomes[c]).map((c) => ({ codigo_produto: String(c), descricao: nomes[c] })) };
  }
  return { rows: [] };
}

const base = (over: Partial<Parameters<typeof processarRecebimentoNacionalPorNf>[0]> = {}) => ({
  nfChaveAcesso: CHAVE,
  userId: USER,
  itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 13160, localidadeId: LOC_A }] }],
  ...over,
});

beforeEach(() => {
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) => Promise.resolve(poolPadrao(sql, params)));
  inserts.length = 0;
  transacoes = 0;
  falhaInsertMov = null;
  falharMovNaChamada = null;
  chamadasMov = 0;
  notificacaoSpy.mockClear();
  registrarUsoSpy.mockReset();
  registrarUsoSpy.mockResolvedValue({ criada: true });
  detalheMock.mockReset();
  detalheMock.mockResolvedValue(detalhe([item({})]));
});

const movs = () => inserts.filter((i) => i.table === 'movimentacao').map((i) => i.values);
const aprs = () => inserts.filter((i) => i.table === 'aprovacao').map((i) => i.values);

describe('caminho limpo 1:1 (T017/T027)', () => {
  it('grava 1 movimentacao + 1 aprovacao com os dados da NF, chave e descricao do item', async () => {
    const r = await processarRecebimentoNacionalPorNf(base());
    expect(r.resumo).toEqual({ enviadosParaAprovacao: 1, jaRecebidos: 0, bloqueados: 0, falhas: 0 });
    expect(r.produtos[0]!.status).toBe('aguardando_aprovacao');
    expect(r.produtos[0]!.produto).toBe('PS CRISTAL A');

    const [m] = movs();
    expect(m).toMatchObject({
      notaFiscal: '66724', // sem zeros a esquerda (formato das 145 linhas historicas)
      tipoMovimento: 'entrada_manual', subtipo: 'compra_nacional', empresa: 'q2p',
      produtoCodigoAcxe: null, produtoCodigoQ2p: 3033097757, galpao: '11.2',
      nfChaveAcesso: CHAVE,
      nfItemDescricao: 'SUCATA  PSAI MOIDO MESCLADO GROSSO',
      nfItemDescricaoNormalizada: 'SUCATA PSAI MOIDO MESCLADO GROSSO',
      quantidadeKg: '13160', quantidadeNfKg: '13160', quantidadeDivergenciaKg: '0',
      statusOmie: 'pendente_q2p', criadoPor: USER,
    });
    const [a] = aprs();
    expect(a).toMatchObject({
      tipoAprovacao: 'entrada_manual', precisaNivel: 'gestor', produtoCodigoQ2p: 3033097757, empresa: 'q2p', galpao: '11.2',
      quantidadePrevistaKg: '13160', quantidadeRecebidaKg: '13160', tipoDivergencia: null,
      nfChaveAcesso: CHAVE, notaFiscal: '66724', nfItemDescricao: 'SUCATA  PSAI MOIDO MESCLADO GROSSO',
      movimentacaoId: 'movimentacao-1', lancadoPor: USER,
    });
  });

  it('valor do item = valor do item na NF (custo_unitario x kg reproduz a NF, sem rateio digitado)', async () => {
    const r = await processarRecebimentoNacionalPorNf(base());
    const [m] = movs();
    expect(Number(m!.custoUnitarioBrl) * 13160).toBeCloseTo(156604, 1);
    expect(r.produtos[0]!.valorItemBrl).toBeCloseTo(156604, 2);
  });

  it('sem divergencia: quantidade_nf_kg e divergencia sao preenchidas mesmo assim (dado uniforme desde o MVP)', async () => {
    await processarRecebimentoNacionalPorNf(base());
    expect(movs()[0]).toMatchObject({ quantidadeNfKg: '13160', quantidadeDivergenciaKg: '0' });
  });

  it('notifica o gestor uma vez, por descricao de produto (nunca codigo)', async () => {
    await processarRecebimentoNacionalPorNf(base());
    expect(notificacaoSpy).toHaveBeenCalledTimes(1);
    const arg = notificacaoSpy.mock.calls[0]![0] as { itens: Array<{ produto: string }> };
    expect(arg.itens[0]!.produto).toBe('PS CRISTAL A');
  });
});

describe('idempotencia e transacao por produto (T017/T018)', () => {
  it('23505 no indice nacional vira status ja_recebido, nao erro', async () => {
    falhaInsertMov = () => Object.assign(new Error('dup'), { code: '23505', constraint: 'movimentacao_nf_nacional_idempotencia_idx' });
    const r = await processarRecebimentoNacionalPorNf(base());
    expect(r.produtos[0]!.status).toBe('ja_recebido');
    expect(r.resumo.jaRecebidos).toBe(1);
  });

  it('23505 embrulhado em cause (drizzle) tambem e reconhecido', async () => {
    falhaInsertMov = () => Object.assign(new Error('wrapped'), { cause: { code: '23505', constraint: 'movimentacao_nf_nacional_idempotencia_idx' } });
    const r = await processarRecebimentoNacionalPorNf(base());
    expect(r.produtos[0]!.status).toBe('ja_recebido');
  });

  it('outro erro de banco vira status falha com mensagem sem codigo OMIE, e nao derruba os demais', async () => {
    detalheMock.mockResolvedValue(detalhe([item({}), item({ indice: 1, descricao: 'SUCATA PSAI MOIDO MESCLADO FINO', q: 13558, v: 156594.9 })]));
    falhaInsertMov = () => new Error('disk full');
    const r = await processarRecebimentoNacionalPorNf(base({
      itens: [
        { indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 13160, localidadeId: LOC_A }] },
        { indice: 1, descricaoFornecedor: 'SUCATA PSAI MOIDO MESCLADO FINO', produtos: [{ produtoCodigoQ2p: 3033097763, quantidadeKg: 13558, localidadeId: LOC_A }] },
      ],
    }));
    expect(r.resumo).toEqual({ enviadosParaAprovacao: 1, jaRecebidos: 0, bloqueados: 0, falhas: 1 });
    const falha = r.produtos.find((p) => p.status === 'falha')!;
    expect(falha.mensagemErro).toContain('PS CRISTAL A');
    expect(falha.mensagemErro).not.toMatch(/3033097757/);
  });

  it('uma transacao POR PRODUTO (nao uma por NF)', async () => {
    detalheMock.mockResolvedValue(detalhe([item({ descricao: 'SUCATA PSAI MOIDO MESCLADO GROSSO' })]));
    await processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA PSAI MOIDO MESCLADO GROSSO', produtos: [
        { produtoCodigoQ2p: 3033097757, quantidadeKg: 6000, localidadeId: LOC_A },
        { produtoCodigoQ2p: 3033097763, quantidadeKg: 4000, localidadeId: LOC_A },
        { produtoCodigoQ2p: 3033097755, quantidadeKg: 3160, localidadeId: LOC_A },
      ] }],
    }));
    expect(transacoes).toBe(3);
    expect(movs()).toHaveLength(3);
  });

  it('todos os itens pedidos ja recebidos -> NfNacionalJaProcessadaError (409)', async () => {
    detalheMock.mockResolvedValue(detalhe([item({ jaRecebido: true, quantidadeNfJaAtribuidaKg: 13160, quantidadeConferidaJaGravadaKg: 13500, quantidadeRestanteKg: 0 })]));
    await expect(processarRecebimentoNacionalPorNf(base())).rejects.toBeInstanceOf(NfNacionalJaProcessadaError);
    expect(inserts).toHaveLength(0);
  });

  it('recebido pelo formulario manual (match sem parcela atribuida) conta como integral', async () => {
    detalheMock.mockResolvedValue(detalhe([item({ jaRecebido: true, quantidadeNfJaAtribuidaKg: 0, quantidadeRestanteKg: 13160 })]));
    await expect(processarRecebimentoNacionalPorNf(base())).rejects.toBeInstanceOf(NfNacionalJaProcessadaError);
  });
});

describe('divergencia de peso (FR-017..FR-020, D17)', () => {
  it('dentro de 1 kg: sem motivo, sem divergencia', async () => {
    await processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', quantidadeConferidaKg: 13160.8,
        produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 13160.8, localidadeId: LOC_A }] }],
    }));
    expect(movs()[0]).toMatchObject({ quantidadeKg: '13160.8', quantidadeDivergenciaKg: '0.8' });
    expect(String(aprs()[0]!.observacoes)).not.toContain('Divergência');
  });

  it('acima de 1 kg sem motivo -> MOTIVO_DIVERGENCIA_OBRIGATORIO, nada gravado', async () => {
    await expect(processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', quantidadeConferidaKg: 13500,
        produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 13500, localidadeId: LOC_A }] }],
    }))).rejects.toMatchObject({ code: 'MOTIVO_DIVERGENCIA_OBRIGATORIO' });
    expect(inserts).toHaveLength(0);
  });

  it('peso MAIOR que a NF e aceito com motivo (NF 66724: 13.160 -> 13.500) — ao contrario da importacao', async () => {
    const r = await processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', quantidadeConferidaKg: 13500, motivoDivergencia: 'balança acima',
        produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 13500, localidadeId: LOC_A }] }],
    }));
    expect(r.produtos[0]!.status).toBe('aguardando_aprovacao');
    expect(r.produtos[0]!.divergenciaKg).toBeCloseTo(340, 3);
    const [m] = movs();
    expect(m).toMatchObject({ quantidadeKg: '13500', quantidadeNfKg: '13160', quantidadeDivergenciaKg: '340' });
    const [a] = aprs();
    expect(a).toMatchObject({ quantidadePrevistaKg: '13160', quantidadeRecebidaKg: '13500', tipoDivergencia: null });
    expect(String(a!.observacoes)).toContain('balança acima');
    expect(String(a!.observacoes)).toContain('+340');
  });

  it('peso MENOR marca tipoDivergencia=faltando', async () => {
    await processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', quantidadeConferidaKg: 12900, motivoDivergencia: 'faltou',
        produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 12900, localidadeId: LOC_A }] }],
    }));
    expect(aprs()[0]).toMatchObject({ tipoDivergencia: 'faltando' });
    expect(movs()[0]).toMatchObject({ quantidadeDivergenciaKg: '-260' });
  });
});

describe('distribuicao 1:N e rateio ancorado na NF (FR-021/FR-022, D25)', () => {
  const tres = [
    { produtoCodigoQ2p: 3033097757, quantidadeKg: 6000, localidadeId: LOC_A },
    { produtoCodigoQ2p: 3033097763, quantidadeKg: 4500, localidadeId: LOC_A },
    { produtoCodigoQ2p: 3033097755, quantidadeKg: 3000, localidadeId: LOC_A },
  ];

  it('soma que nao fecha -> DISTRIBUICAO_NAO_FECHA', async () => {
    await expect(processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', quantidadeConferidaKg: 13500, motivoDivergencia: 'x', produtos: tres.slice(0, 2) }],
    }))).rejects.toMatchObject({ code: 'DISTRIBUICAO_NAO_FECHA' });
  });

  it('produto repetido no item -> PRODUTO_REPETIDO_NO_ITEM (senao colide no indice e perde peso)', async () => {
    await expect(processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtos: [
        { produtoCodigoQ2p: 3033097757, quantidadeKg: 6000, localidadeId: LOC_A },
        { produtoCodigoQ2p: 3033097757, quantidadeKg: 7160, localidadeId: LOC_A },
      ] }],
    }))).rejects.toMatchObject({ code: 'PRODUTO_REPETIDO_NO_ITEM' });
  });

  it('N produtos: Σ valor = valor do item, Σ quantidade_nf_kg = nf do item, custo unitario = valor_item/conferida', async () => {
    const r = await processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', quantidadeConferidaKg: 13500, motivoDivergencia: 'balança', produtos: tres }],
    }));
    expect(r.resumo.enviadosParaAprovacao).toBe(3);
    const ms = movs();
    const somaValor = ms.reduce((s, m) => s + Number(m.custoUnitarioBrl) * Number(m.quantidadeKg), 0);
    expect(somaValor).toBeCloseTo(156604, 0);
    const somaNf = ms.reduce((s, m) => s + Number(m.quantidadeNfKg), 0);
    expect(somaNf).toBeCloseTo(13160, 2);
    for (const m of ms) expect(Number(m.custoUnitarioBrl)).toBeCloseTo(156604 / 13500, 5);
    expect(r.produtos.reduce((s, p) => s + (p.valorItemBrl ?? 0), 0)).toBeCloseTo(156604, 1);
  });

  it('RETOMADA em duas levas: a soma dos valores fecha no valor do item, nao no dobro (defeito R1 corrigido)', async () => {
    // 1a leva: item distribuido em 2 produtos (6.580 + 6.580); a gravacao do 2o FALHA.
    falharMovNaChamada = 2;
    const r1 = await processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtos: [
        { produtoCodigoQ2p: 3033097757, quantidadeKg: 6580, localidadeId: LOC_A },
        { produtoCodigoQ2p: 3033097763, quantidadeKg: 6580, localidadeId: LOC_A },
      ] }],
    }));
    expect(r1.resumo).toEqual({ enviadosParaAprovacao: 1, jaRecebidos: 0, bloqueados: 0, falhas: 1 });
    expect(movs()).toHaveLength(1);

    // 2a leva: o detalhe reflete o que ja foi gravado (6.580 dos 13.160 kg); reenvia so o que faltou.
    detalheMock.mockResolvedValue(detalhe([item({ jaRecebido: true, quantidadeNfJaAtribuidaKg: 6580, quantidadeConferidaJaGravadaKg: 6580, quantidadeRestanteKg: 6580 })]));
    const r2 = await processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtos: [{ produtoCodigoQ2p: 3033097763, quantidadeKg: 6580, localidadeId: LOC_A }] }],
    }));
    expect(r2.resumo.enviadosParaAprovacao).toBe(1);

    const ms = movs();
    expect(ms).toHaveLength(2);
    const somaValor = ms.reduce((s, m) => s + Number(m.custoUnitarioBrl) * Number(m.quantidadeKg), 0);
    expect(somaValor).toBeCloseTo(156604, 0); // NAO 313.208
    expect(ms.reduce((s, m) => s + Number(m.quantidadeNfKg), 0)).toBeCloseTo(13160, 2);
  });

  it('retomada pede so o que falta: soma igual a conferida inteira e recusada', async () => {
    detalheMock.mockResolvedValue(detalhe([item({ jaRecebido: true, quantidadeNfJaAtribuidaKg: 6580, quantidadeConferidaJaGravadaKg: 6580, quantidadeRestanteKg: 6580 })]));
    await expect(processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtos: [{ produtoCodigoQ2p: 3033097763, quantidadeKg: 13160, localidadeId: LOC_A }] }],
    }))).rejects.toMatchObject({ code: 'DISTRIBUICAO_NAO_FECHA' });
  });
});

describe('bloqueios e validacoes de entrada', () => {
  it('item bloqueado por unidade incoerente vira status por produto (nao erro) e nada e gravado', async () => {
    detalheMock.mockResolvedValue(detalhe([item({ q: 1.375, u: 'KG', v: 19731.26 })]));
    const r = await processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 1375, localidadeId: LOC_A }] }],
    }));
    expect(r.produtos[0]!.status).toBe('bloqueado_unidade_incoerente');
    expect(r.resumo.bloqueados).toBe(1);
    expect(inserts).toHaveLength(0);
  });

  it('NF mista: item bloqueado nao impede os demais', async () => {
    detalheMock.mockResolvedValue(detalhe([item({ u: 'UN', q: 9040, v: 4520 }), item({ indice: 1, descricao: 'SUCATA PSAI MOIDO MESCLADO FINO', q: 13558, v: 156594.9 })]));
    const r = await processarRecebimentoNacionalPorNf(base({
      itens: [
        { indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 9040, localidadeId: LOC_A }] },
        { indice: 1, descricaoFornecedor: 'SUCATA PSAI MOIDO MESCLADO FINO', produtos: [{ produtoCodigoQ2p: 3033097763, quantidadeKg: 13558, localidadeId: LOC_A }] },
      ],
    }));
    expect(r.resumo).toEqual({ enviadosParaAprovacao: 1, jaRecebidos: 0, bloqueados: 1, falhas: 0 });
  });

  it('item que nao corresponde a nenhuma linha da NF -> ITEM_NAO_ENCONTRADO', async () => {
    await expect(processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'OUTRA COISA', produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 1, localidadeId: LOC_A }] }],
    }))).rejects.toMatchObject({ code: 'ITEM_NAO_ENCONTRADO' });
  });

  it('localidade ESPELHADA e recusada no servidor mesmo que o cliente envie (FR-011, T027a)', async () => {
    await expect(processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 13160, localidadeId: LOC_ESPELHADA }] }],
    }))).rejects.toBeInstanceOf(LocalidadeNaoElegivelError);
    expect(inserts).toHaveLength(0);
  });

  it('produto fora do catalogo -> ProdutoNaoEncontradoError, mensagem sem codigo OMIE', async () => {
    const p = processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtos: [{ produtoCodigoQ2p: 999, quantidadeKg: 13160, localidadeId: LOC_A }] }],
    }));
    await expect(p).rejects.toBeInstanceOf(ProdutoNaoEncontradoError);
    await p.catch((e: Error) => expect(e.message).not.toContain('999'));
  });

  it('validacao e tudo-ou-nada: erro em um item impede escrita de todos', async () => {
    detalheMock.mockResolvedValue(detalhe([item({}), item({ indice: 1, descricao: 'SUCATA PSAI MOIDO MESCLADO FINO', q: 13558, v: 156594.9 })]));
    await expect(processarRecebimentoNacionalPorNf(base({
      itens: [
        { indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 13160, localidadeId: LOC_A }] },
        { indice: 1, descricaoFornecedor: 'SUCATA PSAI MOIDO MESCLADO FINO', quantidadeConferidaKg: 14000, produtos: [{ produtoCodigoQ2p: 3033097763, quantidadeKg: 14000, localidadeId: LOC_A }] },
      ],
    }))).rejects.toBeInstanceOf(ValidacaoRecebimentoNacionalError);
    expect(inserts).toHaveLength(0);
  });
});

describe('memoria da correlacao ao concluir (FR-007, T041)', () => {
  it('produto gravado -> registrarUsoCorrelacao com fornecedor da NF, descricao do item, produto e operador', async () => {
    await processarRecebimentoNacionalPorNf(base());
    expect(registrarUsoSpy).toHaveBeenCalledTimes(1);
    expect(registrarUsoSpy).toHaveBeenCalledWith({
      fornecedorCnpj: '68.176.072/0001-28', fornecedorNome: 'ISOFORMA PLASTICOS INDUSTRIAIS LTDA',
      descricaoNf: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtoCodigoQ2p: 3033097757, produtoDescricao: 'PS CRISTAL A', userId: USER,
    });
  });

  it('1:N: um registro por produto do item (o conjunto vira memoria, D18)', async () => {
    await processarRecebimentoNacionalPorNf(base({
      itens: [{ indice: 0, descricaoFornecedor: 'SUCATA  PSAI MOIDO MESCLADO GROSSO', produtos: [
        { produtoCodigoQ2p: 3033097757, quantidadeKg: 8000, localidadeId: LOC_A },
        { produtoCodigoQ2p: 3033097763, quantidadeKg: 5160, localidadeId: LOC_A },
      ] }],
    }));
    expect(registrarUsoSpy.mock.calls.map((c) => (c[0] as { produtoCodigoQ2p: number }).produtoCodigoQ2p)).toEqual([3033097757, 3033097763]);
  });

  it('so o que foi GRAVADO vira memoria: produto que falhou na escrita nao e memorizado', async () => {
    falharMovNaChamada = 1;
    const r = await processarRecebimentoNacionalPorNf(base());
    expect(r.produtos[0]!.status).toBe('falha');
    expect(registrarUsoSpy).not.toHaveBeenCalled();
  });

  it('falha ao memorizar NAO desfaz o recebimento (best-effort)', async () => {
    registrarUsoSpy.mockRejectedValue(new Error('relation does not exist'));
    const r = await processarRecebimentoNacionalPorNf(base());
    expect(r.resumo.enviadosParaAprovacao).toBe(1);
    expect(movs()).toHaveLength(1);
  });
});
