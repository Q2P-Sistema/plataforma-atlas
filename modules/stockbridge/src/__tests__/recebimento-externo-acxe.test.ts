import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — a baixa por recebimento externo vale para a NF da empresa dela:
// a aprovacao 'recebimento_externo' e o e-mail ao gestor levam a empresa da NF (antes: 'q2p' fixo).

const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
const poolQuerySpy = vi.fn();

function fakeDb() {
  return {
    insert: (t: { __id?: string }) => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          inserts.push({ table: t.__id ?? '?', values: v });
          return [{ id: `ap-${inserts.length}`, ...v }];
        },
      }),
    }),
  };
}

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => fakeDb(),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
  getConfig: () => ({ STOCKBRIDGE_RECEBIMENTO_EXTERNO_ENABLED: true }),
}));
vi.mock('@atlas/db', () => ({ aprovacao: { __id: 'aprovacao' }, movimentacao: { __id: 'movimentacao' } }));

const digestSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/notificacao.service.js', () => ({ enviarAlertaRecebimentoNacionalLote: (a: unknown) => digestSpy(a) }));

const detalheMock = vi.fn();
vi.mock('../services/fila-nacional.service.js', () => ({
  getDetalheNfNacional: (c: string) => detalheMock(c),
  recebimentoFiscalHabilitado: () => false,
}));

import { solicitarRecebimentoExterno } from '../services/recebimento-externo.service.js';
import { converterItemNfParaKg } from '../services/unidade-nf.js';
import type { DetalheNfNacional, ItemNfNacional } from '../services/fila-nacional.service.js';

const CHAVE = '35261011111111000111550010000009370000009370';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function item(): ItemNfNacional {
  const conv = converterItemNfParaKg(26000, 'KG', 124800);
  return {
    indice: 0, descricaoFornecedor: 'PP PRETO Q35', descricaoNormalizada: 'PP PRETO Q35', cfop: '1.101', quantidadeNf: 26000, unidadeOriginal: 'KG',
    quantidadeNfKg: 26000, valorUnitarioBrl: 4.8, valorTotalItemBrl: 124800, rsPorKg: 4.8, linhasAgregadas: 1, produtosSugeridos: [],
    bloqueio: null, bloqueioMensagem: null, jaRecebido: false, quantidadeNfJaAtribuidaKg: 0, quantidadeConferidaJaGravadaKg: 0,
    quantidadeRestanteKg: 26000, baixadoComoExterno: false, baixaSolicitada: false, conversao: conv, sequenciasRecebimento: [], pc: null,
  };
}

const detalhe = (over: Partial<DetalheNfNacional> = {}): DetalheNfNacional =>
  ({
    nfChaveAcesso: CHAVE, notaFiscal: '937', fornecedorNome: 'SOLUTEC', fornecedorCnpj: '11.111.111/0001-11', dtEmissao: '2026-10-20',
    diasDesdeEmissao: 2, cfop: '1.101', valorTotalBrl: 124800, valorNotaBrl: 124800, itens: [item()], linhasForaDoRecorte: 0,
    fiscal: 'concluido', nIdReceb: null, dispensavel: true, ...over,
  }) as DetalheNfNacional;

beforeEach(() => {
  inserts.length = 0;
  poolQuerySpy.mockReset();
  poolQuerySpy.mockResolvedValue({ rows: [] });
  digestSpy.mockClear();
  detalheMock.mockReset();
});

describe('solicitarRecebimentoExterno — empresa da NF', () => {
  it('NF da ACXE: a aprovacao leva empresa acxe e o e-mail ao gestor tambem', async () => {
    detalheMock.mockResolvedValue(detalhe({ empresa: 'acxe' }));
    await solicitarRecebimentoExterno({ nfChaveAcesso: CHAVE, motivo: 'recebida direto no OMIE da ACXE em 20/10', userId: USER });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.values).toMatchObject({ empresa: 'acxe', tipoAprovacao: 'recebimento_externo', nfChaveAcesso: CHAVE, notaFiscal: '937', galpao: null, produtoCodigoAcxe: null, produtoCodigoQ2p: null });
    expect(digestSpy.mock.calls[0]![0]).toMatchObject({ itens: [{ empresa: 'acxe', galpao: '—' }] });
  });

  it('NF da Q2P, ou detalhe sem empresa: q2p, como sempre', async () => {
    detalheMock.mockResolvedValue(detalhe({ empresa: 'q2p' }));
    await solicitarRecebimentoExterno({ nfChaveAcesso: CHAVE, motivo: 'motivo', userId: USER });
    detalheMock.mockResolvedValue(detalhe());
    await solicitarRecebimentoExterno({ nfChaveAcesso: CHAVE, motivo: 'motivo', userId: USER });
    expect(inserts.map((i) => i.values.empresa)).toEqual(['q2p', 'q2p']);
    expect(digestSpy.mock.calls.map((c) => (c[0] as { itens: Array<{ empresa: string }> }).itens[0]!.empresa)).toEqual(['q2p', 'q2p']);
  });
});
