import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 016 (ACXEGDP-395), T029 — REGRESSAO com a flag DESLIGADA
// (STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=false, o default): o modulo tem de se
// comportar como a feature 015. Aqui o service do fiscal NAO e mockado — o que
// se prova e que nenhuma funcao de recebimento-nfe.ts chega a ser chamada, que
// a fila nao toca nas tabelas novas e que o shape do resultado da 015 segue
// inteiro (so ganha o bloco `fiscal` com status 'desligado').

const poolQuerySpy = vi.fn();
const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
const omie = {
  consultarRecebimentoNfe: vi.fn(),
  alterarRecebimentoNfeItens: vi.fn(),
  concluirRecebimentoNfe: vi.fn(),
};

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
  // flag AUSENTE (default do schema = false) — o cenario de PROD no go-live (research D12)
  getConfig: () => ({ STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE: '2026-09-11' }),
  getDb: () => ({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: (table: { __id: string }) => ({
          values: (v: Record<string, unknown>) => ({
            returning: async () => {
              inserts.push({ table: table.__id, values: v });
              return [{ id: `${table.__id}-${inserts.length}`, ...v }];
            },
          }),
        }),
      }),
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
  consultarRecebimentoNfe: (...a: unknown[]) => omie.consultarRecebimentoNfe(...a),
  alterarRecebimentoNfeItens: (...a: unknown[]) => omie.alterarRecebimentoNfeItens(...a),
  concluirRecebimentoNfe: (...a: unknown[]) => omie.concluirRecebimentoNfe(...a),
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

import { processarRecebimentoNacionalPorNf } from '../services/recebimento-nacional.service.js';
import { getFilaNacional, recebimentoFiscalHabilitado } from '../services/fila-nacional.service.js';
import { converterItemNfParaKg } from '../services/unidade-nf.js';
import type { DetalheNfNacional, ItemNfNacional } from '../services/fila-nacional.service.js';

const CHAVE = '35261014555032000753550010000068421827355174';
const LOC_A = '11111111-1111-4111-8111-111111111111';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DESC = 'SUCATA PLASTICO';

function item(): ItemNfNacional {
  const conv = converterItemNfParaKg(18000, 'KG', 203400);
  const nfKg = conv.ok ? conv.quantidadeKg : null;
  return {
    indice: 0, descricaoFornecedor: DESC, descricaoNormalizada: DESC, cfop: '1.102', quantidadeNf: 18000, unidadeOriginal: 'KG',
    quantidadeNfKg: nfKg, valorUnitarioBrl: 11.3, valorTotalItemBrl: 203400, rsPorKg: conv.ok ? conv.rsPorKg : null, linhasAgregadas: 1,
    produtosSugeridos: [], bloqueio: 'sem_correlacao', bloqueioMensagem: null, jaRecebido: false, quantidadeNfJaAtribuidaKg: 0,
    quantidadeConferidaJaGravadaKg: 0, quantidadeRestanteKg: nfKg, baixadoComoExterno: false, baixaSolicitada: false, conversao: conv,
  };
}

// Mesmo com a flag desligada, um detalhe "fiscal pendente" (so possivel se alguem
// ligou e desligou a flag no meio) NAO pode disparar escrita no OMIE.
const detalhe = (): DetalheNfNacional => ({
  nfChaveAcesso: CHAVE, notaFiscal: '6842', fornecedorNome: 'REPLAS COMERCIAL LTDA', fornecedorCnpj: '14.555.032/0007-53',
  dtEmissao: '2026-10-01', diasDesdeEmissao: 1, cfop: '1.102', valorTotalBrl: 203400, itens: [item()], linhasForaDoRecorte: 0,
  fiscal: 'pendente', nIdReceb: 8510564869, dispensavel: false, valorNotaBrl: 203400,
});

function poolPadrao(sql: string, params?: unknown[]) {
  if (sql.includes('information_schema')) return { rows: [{ ok: true }] };
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

beforeEach(() => {
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) => Promise.resolve(poolPadrao(sql, params)));
  inserts.length = 0;
  for (const f of Object.values(omie)) f.mockReset();
  detalheMock.mockReset();
  detalheMock.mockResolvedValue(detalhe());
});

describe('flag desligada — regressao para o comportamento da 015 (FR-020, SC-006)', () => {
  it('recebimentoFiscalHabilitado() e false com a variavel ausente (default do schema)', () => {
    expect(recebimentoFiscalHabilitado()).toBe(false);
  });

  it('a fila consulta so tbl_nf_header_Q2P/tbl_nf_itens_Q2P e nenhuma tabela da feature 016', async () => {
    await getFilaNacional();
    const sql = String(poolQuerySpy.mock.calls.find((c) => String(c[0]).includes('WITH nf_unificada'))![0]);
    expect(sql).toContain('public."tbl_nf_header_Q2P" h');
    for (const tabela of ['tbl_recebimentoNFe_Q2P', 'tbl_recebimentoNFe_itens_Q2P', 'stockbridge.recebimento_fiscal', 'stockbridge.nf_dispensa']) {
      expect(sql, tabela).not.toContain(tabela);
    }
    expect(sql).not.toContain('UNION ALL');
    // colunas novas sao constantes
    expect(sql).toContain("CASE WHEN bool_or(fiscal_pendente) THEN 'pendente' ELSE 'concluido' END AS fiscal");
    expect(sql).toContain('NULL::text');
    expect(sql).toContain('false                                                AS fiscal_pendente');
  });

  it('o POST por NF grava o fisico, nunca chama produtos/recebimentonfe/ e devolve fiscal.status desligado', async () => {
    const r = await processarRecebimentoNacionalPorNf({
      nfChaveAcesso: CHAVE,
      userId: USER,
      itens: [{ indice: 0, descricaoFornecedor: DESC, produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 18000, localidadeId: LOC_A }] }],
    });

    for (const f of Object.values(omie)) expect(f).not.toHaveBeenCalled();
    // nenhum ledger fiscal tocado
    expect(poolQuerySpy.mock.calls.some((c) => String(c[0]).includes('stockbridge.recebimento_fiscal'))).toBe(false);

    // shape da 015 intacto
    expect(inserts.filter((i) => i.table === 'movimentacao')).toHaveLength(1);
    expect(inserts.filter((i) => i.table === 'aprovacao')).toHaveLength(1);
    expect(r.nfChaveAcesso).toBe(CHAVE);
    expect(r.notaFiscal).toBe('6842');
    expect(r.produtos).toHaveLength(1);
    expect(r.produtos[0]!.status).toBe('aguardando_aprovacao');
    expect(r.resumo).toEqual({ enviadosParaAprovacao: 1, jaRecebidos: 0, bloqueados: 0, falhas: 0 });
    // bloco novo, inerte
    expect(r.fiscal).toEqual({
      status: 'desligado',
      concluidoEm: null,
      mensagem: 'O recebimento fiscal pelo Atlas está desligado neste ambiente — o fiscal segue sendo concluído no OMIE.',
    });
  });
});
