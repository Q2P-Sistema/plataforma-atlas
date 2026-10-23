import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — painel de pendencias OMIE (listarPendentes) com a compra nacional da ACXE:
// a movimentacao nao tem lote (o bloco `lote` vem vazio), entao a linha ganhou subtipo/empresa/galpao e o produto da
// PROPRIA movimentacao. O que ja era do painel (importacao com lote, pendente_acxe_faltando) segue igual.

let linhas: Array<Record<string, unknown>> = [];

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: () => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'leftJoin', 'where']) c[m] = () => c;
    c.orderBy = () => Promise.resolve(linhas);
    return c;
  },
  getConfig: () => ({}),
  getPool: () => ({ query: vi.fn() }),
}));
vi.mock('@atlas/db', () => ({
  movimentacao: new Proxy({ __id: 'movimentacao' }, { get: (t, p) => (p in t ? (t as never)[p] : {}) }),
  lote: { __id: 'lote', codigo: {}, fornecedorNome: {}, produtoCodigoAcxe: {} },
  localidade: { __id: 'localidade' },
  localidadeCorrelacao: { __id: 'localidadeCorrelacao' },
  aprovacao: { __id: 'aprovacao', id: {}, movimentacaoId: {}, status: {} },
}));
vi.mock('@atlas/integration-omie', () => ({ incluirAjusteEstoque: vi.fn(), listarAjusteEstoque: vi.fn() }));
vi.mock('../services/omie-saida.service.js', () => ({
  resolverCorrelacaoCompletaGalpao: vi.fn(),
  resolverCodigosLocaisTroca: vi.fn(),
  resolverCodigoProdutoOmie: vi.fn(),
}));
vi.mock('../services/aprovacao.service.js', () => ({ consultarValorUnitarioProduto: vi.fn() }));
vi.mock('../services/baixa-pedido.service.js', () => ({ dispararBaixaPedidoQ2p: vi.fn() }));

import { listarPendentes } from '../services/operacoes-pendentes.service.js';

const CRIADO = new Date('2026-10-22T15:00:00.000Z');
const base = {
  id: 'mov-1', opId: '5a1f0c52-0f6d-4d6b-9a41-3d0a8d0f1111', notaFiscal: '937', statusOmie: 'pendente_q2p', tentativasQ2p: 1,
  tentativasAcxeFaltando: 0, ultimoErroOmie: null, quantidadeKg: '26000.000', createdAt: CRIADO, loteId: null, loteCodigo: null,
  fornecedorNome: null, produtoCodigoAcxe: null, subtipo: 'compra_nacional', empresa: 'acxe', galpao: '21.1', produtoCodigoAcxeMov: 4001,
};

beforeEach(() => {
  linhas = [];
});

describe('listarPendentes — compra nacional da ACXE (sem lote)', () => {
  it('a pendencia da perna Q2P traz subtipo/empresa/galpao, o produto da PROPRIA movimentacao e o ultimo erro', async () => {
    linhas = [{ ...base, ultimoErroOmie: { lado: 'q2p', mensagem: 'OMIE Q2P fora do ar', timestamp: '2026-10-22T15:01:00.000Z' } }];
    const [p] = await listarPendentes();
    expect(p).toEqual({
      id: 'mov-1',
      opId: base.opId,
      notaFiscal: '937',
      ladoPendente: 'q2p',
      statusOmie: 'pendente_q2p',
      tentativas: 1,
      ultimoErro: { lado: 'q2p', mensagem: 'OMIE Q2P fora do ar', timestamp: '2026-10-22T15:01:00.000Z' },
      createdAt: CRIADO.toISOString(),
      subtipo: 'compra_nacional',
      empresa: 'acxe',
      galpao: '21.1',
      lote: { id: null, codigo: null, fornecedorNome: null, produtoCodigoAcxe: 4001, quantidadeKg: 26000 },
    });
  });

  it('o produto do lote tem prioridade (importacao); sem lote e sem produto na movimentacao, fica null', async () => {
    linhas = [
      { ...base, id: 'imp', loteId: 'l-1', loteCodigo: 'L-001', fornecedorNome: 'FORNECEDOR X', produtoCodigoAcxe: 777, produtoCodigoAcxeMov: 4001, subtipo: 'importacao', empresa: null, galpao: null },
      { ...base, id: 'sem-produto', produtoCodigoAcxeMov: null },
    ];
    const [imp, semProduto] = await listarPendentes();
    expect(imp).toMatchObject({ subtipo: 'importacao', empresa: null, galpao: null, lote: { id: 'l-1', codigo: 'L-001', fornecedorNome: 'FORNECEDOR X', produtoCodigoAcxe: 777 } });
    expect(semProduto!.lote.produtoCodigoAcxe).toBeNull();
  });

  it('pendente_acxe_faltando usa o contador e o lado proprios; erro parcial ganha valores padrao', async () => {
    linhas = [
      { ...base, id: 'faltando', statusOmie: 'pendente_acxe_faltando', tentativasQ2p: 0, tentativasAcxeFaltando: 3, ultimoErroOmie: { mensagem: 'so mensagem' } },
    ];
    const [p] = await listarPendentes();
    expect(p).toMatchObject({ ladoPendente: 'acxe-faltando', tentativas: 3, ultimoErro: { lado: 'desconhecido', mensagem: 'so mensagem', timestamp: '' } });
  });

  it('subtipo/empresa/galpao ausentes viram null (linhas antigas)', async () => {
    linhas = [{ ...base, subtipo: undefined, empresa: undefined, galpao: undefined }];
    const [p] = await listarPendentes();
    expect(p).toMatchObject({ subtipo: null, empresa: null, galpao: null });
  });

  it('lista vazia: []', async () => {
    expect(await listarPendentes()).toEqual([]);
  });
});
