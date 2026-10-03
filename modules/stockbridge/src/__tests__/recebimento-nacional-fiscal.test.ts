import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 016 (ACXEGDP-395) — passo FISCAL dentro de processarRecebimentoNacionalPorNf (T023).
// O service do fiscal e mockado (tem teste proprio em recebimento-fiscal.test.ts);
// aqui se prova QUANDO ele e chamado (flag ligada + NF com fiscal pendente + ao
// menos um produto preparado), que roda ANTES de qualquer INSERT (FR-008/FR-012)
// e como o bloco `fiscal` do resultado e preenchido (data-model §7).

const poolQuerySpy = vi.fn();
const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
/** Linha do tempo fiscal x escrita, para provar a ordem. */
const ordem: string[] = [];
/** Faz TODO insert em `movimentacao` falhar (T038: fiscal ok + fisico falhou). */
let falharInserts = false;
const config: Record<string, unknown> = {
  STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE: '2026-09-11',
  STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED: true,
};

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
  getConfig: () => config,
  getDb: () => ({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      ordem.push('transacao');
      const tx = {
        insert: (table: { __id: string }) => ({
          values: (v: Record<string, unknown>) => ({
            returning: async () => {
              if (falharInserts && table.__id === 'movimentacao') throw new Error('disk full');
              inserts.push({ table: table.__id, values: v });
              ordem.push(`insert:${table.__id}`);
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
  consultarRecebimentoNfe: vi.fn(),
  alterarRecebimentoNfeItens: vi.fn(),
  concluirRecebimentoNfe: vi.fn(),
}));

vi.mock('../services/notificacao.service.js', () => ({
  enviarAlertaRecebimentoNacionalLote: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/correlacao-produto.service.js', () => ({
  registrarUsoCorrelacao: vi.fn().mockResolvedValue({ criada: true }),
  sugerirProdutosEmLote: vi.fn().mockResolvedValue(new Map()),
}));

const detalheMock = vi.fn();
vi.mock('../services/fila-nacional.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/fila-nacional.service.js')>('../services/fila-nacional.service.js');
  return { ...real, getDetalheNfNacional: (c: string) => detalheMock(c) };
});

const fiscalSpy = vi.fn();
vi.mock('../services/recebimento-fiscal.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/recebimento-fiscal.service.js')>('../services/recebimento-fiscal.service.js');
  return { ...real, concluirRecebimentoFiscal: (i: unknown) => fiscalSpy(i) };
});

import { processarRecebimentoNacionalPorNf } from '../services/recebimento-nacional.service.js';
import { RecebimentoFiscalError, RecebimentoFiscalEmAndamentoError, RecebimentoFiscalSemFornecedorError } from '../services/recebimento-fiscal.service.js';
import { NfNacionalDispensadaError } from '../services/fila-nacional.service.js';
import { converterItemNfParaKg } from '../services/unidade-nf.js';
import type { DetalheNfNacional, ItemNfNacional } from '../services/fila-nacional.service.js';

const CHAVE = '35261014555032000753550010000068421827355174';
const N_ID_RECEB = 8510564869;
const LOC_A = '11111111-1111-4111-8111-111111111111';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FORNECEDOR = 'REPLAS COMERCIAL LTDA';
const DESC = 'SUCATA PLASTICO';

function item(o: Partial<ItemNfNacional> & { q?: number; u?: string; v?: number } = {}): ItemNfNacional {
  const q = o.q ?? 18000, u = o.u ?? 'KG', v = o.v ?? 203400;
  const conv = converterItemNfParaKg(q, u, v);
  const nfKg = conv.ok ? conv.quantidadeKg : null;
  return {
    indice: 0, descricaoFornecedor: DESC, descricaoNormalizada: DESC,
    cfop: '1.102', quantidadeNf: q, unidadeOriginal: u, quantidadeNfKg: nfKg, valorUnitarioBrl: v / q, valorTotalItemBrl: v,
    rsPorKg: conv.ok ? conv.rsPorKg : null, linhasAgregadas: 1, produtosSugeridos: [],
    bloqueio: conv.ok ? 'sem_correlacao' : conv.motivo === 'unidade_incoerente' ? 'unidade_incoerente' : 'unidade_nao_conversivel',
    bloqueioMensagem: conv.ok ? null : conv.mensagem, jaRecebido: false,
    quantidadeNfJaAtribuidaKg: 0, quantidadeConferidaJaGravadaKg: 0,
    quantidadeRestanteKg: nfKg, baixadoComoExterno: false, baixaSolicitada: false, conversao: conv,
    ...o,
  };
}

function detalhe(itens: ItemNfNacional[], over: Partial<DetalheNfNacional> = {}): DetalheNfNacional {
  return {
    nfChaveAcesso: CHAVE, notaFiscal: '6842', fornecedorNome: FORNECEDOR, fornecedorCnpj: '14.555.032/0007-53',
    dtEmissao: '2026-10-01', diasDesdeEmissao: 1, cfop: '1.102',
    valorTotalBrl: itens.reduce((s, i) => s + i.valorTotalItemBrl, 0), itens, linhasForaDoRecorte: 0,
    fiscal: 'pendente', nIdReceb: N_ID_RECEB, dispensavel: true, valorNotaBrl: itens.reduce((s, i) => s + i.valorTotalItemBrl, 0),
    ...over,
  };
}

function poolPadrao(sql: string, params?: unknown[]) {
  if (sql.includes('stockbridge.localidade l')) {
    const ids = (params?.[0] as string[]) ?? [];
    return { rows: ids.map((id) => ({ id, codigo: '11.2', codigo_acxe: null, codigo_q2p: '8123584710' })) };
  }
  if (sql.includes('tbl_produtos_Q2P')) {
    const cods = (params?.[0] as number[]) ?? [];
    return { rows: cods.map((c) => ({ codigo_produto: String(c), descricao: `PRODUTO ${c}` })) };
  }
  return { rows: [] };
}

const base = (quantidadeKg = 18000) => ({
  nfChaveAcesso: CHAVE,
  userId: USER,
  itens: [{ indice: 0, descricaoFornecedor: DESC, produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg, localidadeId: LOC_A }] }],
});

const fiscalOk = (status: 'concluido' | 'ja_concluido' = 'concluido') => ({
  status,
  concluidoEm: '2026-10-02T13:00:00.000Z',
  ledgerId: 'ledger-1',
  itensTotal: status === 'concluido' ? 1 : 0,
});

beforeEach(() => {
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) => Promise.resolve(poolPadrao(sql, params)));
  inserts.length = 0;
  ordem.length = 0;
  falharInserts = false;
  config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
  detalheMock.mockReset();
  detalheMock.mockResolvedValue(detalhe([item()]));
  fiscalSpy.mockReset();
  fiscalSpy.mockImplementation(async () => {
    ordem.push('fiscal');
    return fiscalOk();
  });
});

const movs = () => inserts.filter((i) => i.table === 'movimentacao');

describe('processarRecebimentoNacionalPorNf — passo fiscal (research D10)', () => {
  it('fiscal pendente + flag ligada + produto preparado: chama o fiscal UMA vez, ANTES de qualquer INSERT, e grava depois', async () => {
    const r = await processarRecebimentoNacionalPorNf(base());

    expect(fiscalSpy).toHaveBeenCalledTimes(1);
    expect(fiscalSpy).toHaveBeenCalledWith({ nfChaveAcesso: CHAVE, nIdReceb: N_ID_RECEB, notaFiscal: '6842', fornecedorNome: FORNECEDOR, userId: USER });
    // ordem: fiscal -> transacao -> inserts
    expect(ordem[0]).toBe('fiscal');
    expect(ordem.indexOf('fiscal')).toBeLessThan(ordem.indexOf('transacao'));
    expect(movs()).toHaveLength(1);

    expect(r.fiscal).toEqual({
      status: 'concluido',
      concluidoEm: '2026-10-02T13:00:00.000Z',
      mensagem: `Recebimento fiscal da NF 6842 (${FORNECEDOR}) concluído no OMIE.`,
    });
    expect(r.resumo.enviadosParaAprovacao).toBe(1);
  });

  it('OMIE ja mostrava concluido (ja_concluido): segue gravando e o resultado diz que nada havia a fazer', async () => {
    fiscalSpy.mockImplementation(async () => {
      ordem.push('fiscal');
      return fiscalOk('ja_concluido');
    });
    const r = await processarRecebimentoNacionalPorNf(base());
    expect(r.fiscal.status).toBe('ja_concluido');
    expect(r.fiscal.concluidoEm).toBe('2026-10-02T13:00:00.000Z');
    expect(r.fiscal.mensagem).toContain('já estava concluído no OMIE');
    expect(movs()).toHaveLength(1);
  });

  it('NF com fiscal ja feito (fonte do espelho de NF): nao chama o fiscal; nao_aplicavel', async () => {
    detalheMock.mockResolvedValue(detalhe([item()], { fiscal: 'concluido', nIdReceb: 500, dispensavel: true }));
    const r = await processarRecebimentoNacionalPorNf(base());
    expect(fiscalSpy).not.toHaveBeenCalled();
    expect(r.fiscal.status).toBe('nao_aplicavel');
    expect(r.fiscal.concluidoEm).toBeNull();
    expect(r.fiscal.mensagem).toContain('NF 6842');
    expect(r.fiscal.mensagem).toContain('já estava concluído');
    expect(movs()).toHaveLength(1);
  });

  it('flag desligada: nunca chama o fiscal mesmo com NF pendente; status desligado (comportamento da 015)', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = false;
    const r = await processarRecebimentoNacionalPorNf(base());
    expect(fiscalSpy).not.toHaveBeenCalled();
    expect(r.fiscal.status).toBe('desligado');
    expect(r.fiscal.mensagem).toContain('desligado');
    expect(movs()).toHaveLength(1);
  });

  it('todos os itens bloqueados por unidade: nenhuma chamada ao fiscal, nada gravado, nao_aplicavel (edge case da spec)', async () => {
    // 1,375 KG a R$ 19.731,26 -> R$/kg absurdo -> unidade incoerente -> bloqueado
    detalheMock.mockResolvedValue(detalhe([item({ q: 1.375, u: 'KG', v: 19731.26 })]));
    const r = await processarRecebimentoNacionalPorNf(base(1375));
    expect(fiscalSpy).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(r.produtos[0]!.status).toBe('bloqueado_unidade_incoerente');
    expect(r.fiscal.status).toBe('nao_aplicavel');
    expect(r.fiscal.mensagem).toContain('o recebimento fiscal não foi alterado');
  });

  it('fiscal falha no OMIE: o erro propaga ANTES de qualquer INSERT/transacao (FR-012)', async () => {
    fiscalSpy.mockImplementation(async () => {
      ordem.push('fiscal');
      throw new RecebimentoFiscalError('concluir', '6842', FORNECEDOR);
    });
    await expect(processarRecebimentoNacionalPorNf(base())).rejects.toBeInstanceOf(RecebimentoFiscalError);
    expect(inserts).toHaveLength(0);
    expect(ordem).toEqual(['fiscal']);
  });

  it('outra confirmacao em andamento: RecebimentoFiscalEmAndamentoError propaga sem gravar', async () => {
    fiscalSpy.mockImplementation(async () => {
      throw new RecebimentoFiscalEmAndamentoError('6842');
    });
    await expect(processarRecebimentoNacionalPorNf(base())).rejects.toBeInstanceOf(RecebimentoFiscalEmAndamentoError);
    expect(inserts).toHaveLength(0);
  });

  it('NF fiscal pendente SEM CNPJ de fornecedor no espelho (fornecedor nao cadastrado no OMIE, ex.: NF 1257): recusa ANTES do fiscal — nem ledger nem OMIE, zero INSERT', async () => {
    detalheMock.mockResolvedValue(detalhe([item()], { fornecedorCnpj: '', fornecedorNome: 'Fornecedor não identificado no OMIE', notaFiscal: '1257' }));
    await expect(processarRecebimentoNacionalPorNf(base())).rejects.toBeInstanceOf(RecebimentoFiscalSemFornecedorError);
    await expect(processarRecebimentoNacionalPorNf(base())).rejects.toThrow('NF 1257');
    expect(fiscalSpy).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it('NF com fiscal ja feito e sem CNPJ nao e barrada pela guarda (o fiscal nao roda)', async () => {
    detalheMock.mockResolvedValue(detalhe([item()], { fiscal: 'concluido', fornecedorCnpj: '' }));
    const r = await processarRecebimentoNacionalPorNf(base());
    expect(r.fiscal.status).toBe('nao_aplicavel');
    expect(movs()).toHaveLength(1);
  });

  it('NF dispensada pelo gestor DEPOIS de este POST ler o detalhe: 404 NF_DISPENSADA antes do fiscal, zero INSERT (ROT-3)', async () => {
    poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) =>
      Promise.resolve(String(sql).includes('FROM stockbridge.nf_dispensa') ? { rows: [{ dispensado_em: '2026-10-02 12:00:00+00' }] } : poolPadrao(sql, params)),
    );
    await expect(processarRecebimentoNacionalPorNf(base())).rejects.toBeInstanceOf(NfNacionalDispensadaError);
    expect(fiscalSpy).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it('flag desligada: a dispensa nao e consultada (comportamento da 015)', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = false;
    await processarRecebimentoNacionalPorNf(base());
    expect(poolQuerySpy.mock.calls.some((c) => String(c[0]).includes('stockbridge.nf_dispensa'))).toBe(false);
  });

  it('nIdReceb nulo no detalhe e repassado como null (o service do fiscal resolve pela consulta)', async () => {
    detalheMock.mockResolvedValue(detalhe([item()], { nIdReceb: null }));
    await processarRecebimentoNacionalPorNf(base());
    expect(fiscalSpy.mock.calls[0]![0]).toMatchObject({ nIdReceb: null });
  });
});

describe('processarRecebimentoNacionalPorNf — T038 (US3): fiscal ok, fisico falhou', () => {
  it('fiscal concluido + falha no INSERT de todos os produtos: resultado traz fiscal.status=concluido e produtos falha; nada e desfeito no fiscal', async () => {
    falharInserts = true;
    const r = await processarRecebimentoNacionalPorNf(base());
    expect(fiscalSpy).toHaveBeenCalledTimes(1);
    expect(r.fiscal.status).toBe('concluido');
    expect(r.produtos.every((p) => p.status === 'falha')).toBe(true);
    expect(r.resumo.falhas).toBe(1);
    expect(r.resumo.enviadosParaAprovacao).toBe(0);
    expect(inserts).toHaveLength(0);
    // A NF volta a fila como "fiscal ja feito" pelo ledger (fonte b + ledger concluido) —
    // a fila le o ledger, nao este resultado; aqui so se garante que nada tentou revert-lo.
  });
});
