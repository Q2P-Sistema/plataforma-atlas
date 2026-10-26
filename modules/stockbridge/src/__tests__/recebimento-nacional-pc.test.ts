import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017 (ACXEGDP-437), T036 — portao 1 do POST por-nf com pedido de compra (PC).
// O detalhe (montarDetalheNfNacional) e o fiscal (concluirRecebimentoFiscal) sao
// mockados — a sugestao e o fiscal tem testes proprios. Aqui se prova a REGRA do
// portao 1: NF sem PC nos dois modos de STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC,
// PC nao escolhido, copia de PCs defasada, estoque ja lancado pelo OMIE (inclusive
// com a leitura ao vivo da NF fora do espelho) e o que segue para o fiscal.

const poolQuerySpy = vi.fn();
const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
const config: Record<string, unknown> = {
  STOCKBRIDGE_RECEBIMENTO_NACIONAL_DATA_CORTE: '2026-09-11',
  STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED: true,
  STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC: true,
  STOCKBRIDGE_PC_TOLERANCIA_QTD_PCT: 2,
  STOCKBRIDGE_PC_TOLERANCIA_PRECO_PCT: 1,
};

const spies = vi.hoisted(() => ({
  detalhe: vi.fn(),
  fiscal: vi.fn(),
  aviso: vi.fn(),
  consultarRecebimento: vi.fn(),
  // D21 da 017 (fiscal revertido no portal) — a matriz inteira esta em recebimento-nacional-revertido.test.ts
  d21Habilitado: vi.fn(),
  ledgerVigente: vi.fn(),
  marcar: vi.fn(),
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getPool: () => ({ query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params) }),
  getConfig: () => config,
  getDb: () => ({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: (table: { __id: string }) => ({
          values: (v: Record<string, unknown>) => ({
            returning: async () => {
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
  enviarAlertaRecebimentoNacionalLote: vi.fn().mockResolvedValue(undefined),
  enviarAvisoComprasNfSemPc: (a: unknown) => spies.aviso(a),
}));

vi.mock('../services/correlacao-produto.service.js', () => ({
  registrarUsoCorrelacao: vi.fn().mockResolvedValue({ criada: true }),
  sugerirProdutosEmLote: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('../services/fila-nacional.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/fila-nacional.service.js')>('../services/fila-nacional.service.js');
  return { ...real, montarDetalheNfNacional: (c: string) => spies.detalhe(c) };
});

vi.mock('../services/recebimento-fiscal.service.js', async () => {
  const real = await vi.importActual<typeof import('../services/recebimento-fiscal.service.js')>('../services/recebimento-fiscal.service.js');
  return { ...real, concluirRecebimentoFiscal: (i: unknown) => spies.fiscal(i) };
});

// D21: desligada por default (o clique de "fiscal ja feito" segue so a D7); ligada em teste proprio, abaixo.
vi.mock('../services/fiscal-revertido.js', async () => {
  const real = await vi.importActual<typeof import('../services/fiscal-revertido.js')>('../services/fiscal-revertido.js');
  return {
    ...real,
    fiscalRevertidoHabilitado: (...a: unknown[]) => spies.d21Habilitado(...a),
    ledgerFiscalVigente: (...a: unknown[]) => spies.ledgerVigente(...a),
    marcarLedgerRevertido: (...a: unknown[]) => spies.marcar(...a),
  };
});

import {
  processarRecebimentoNacionalPorNf,
  avisarComprasNfSemPc,
  AvisoComprasNaoAplicavelError,
  VerificacaoEstoqueOmieError,
  ValidacaoRecebimentoNacionalError,
} from '../services/recebimento-nacional.service.js';
import { EstoqueJaLancadoPeloOmieError } from '../services/fila-nacional.service.js';
import {
  CopiaPcsDefasadaError,
  NfSemPcError,
  PcJustificativaObrigatoriaError,
  PcNaoElegivelError,
  PcNaoEscolhidoError,
  type ItemParaSugestao,
  type PcCandidato,
  type PcDoItem,
  type ResultadoPcItem,
} from '../services/pc-sugestao.service.js';
import { RecebimentoFiscalError, RecebimentoFiscalSemFornecedorError } from '../services/recebimento-fiscal.service.js';
import { converterItemNfParaKg } from '../services/unidade-nf.js';
import type { DetalheNfNacional, DetalheNfNacionalInterno, ItemNfNacional } from '../services/fila-nacional.service.js';

const CHAVE = '35261011111111000111550010000078131000078131';
const LOC_A = '11111111-1111-4111-8111-111111111111';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FORNECEDOR = 'REPLAS COMERCIAL LTDA';
const DESC = 'SUCATA PLASTICO';

const PC304: PcCandidato = {
  nCodPed: 8516905979, nCodItem: 8516907022, pcNumero: '304', produtoDescricao: 'PS CRISTAL B', qtdPedidaKg: 18000,
  saldoKg: 18000, precoUnit: 11.3, precoNfKgComparado: 11.3, dtPrevisao: '2026-10-20', etapa: '15', dentroTolerancia: true,
  casaNumeroPedidoNf: false, semDadosLocais: false, motivo: 'Quantidade e preço compatíveis',
  outroCadastro: false, cnpjCadastro: '', dadosEmCache: false, unidade: 'KG',
};
const PC310: PcCandidato = { ...PC304, nCodPed: 8516900310, nCodItem: 8516900311, pcNumero: '310', precoUnit: 11.7, dentroTolerancia: false, motivo: 'Preço da NF 3,4% abaixo do PC' };
const PC305: PcCandidato = { ...PC304, nCodPed: 8516900305, nCodItem: 8516900306, pcNumero: '305', etapa: '10', motivo: 'Aguardando aprovação' };

function item(o: Partial<ItemNfNacional> = {}): ItemNfNacional {
  const conv = converterItemNfParaKg(18000, 'KG', 203400);
  return {
    indice: 0, descricaoFornecedor: DESC, descricaoNormalizada: DESC, cfop: '1.102', quantidadeNf: 18000, unidadeOriginal: 'KG',
    quantidadeNfKg: 18000, valorUnitarioBrl: 11.3, valorTotalItemBrl: 203400, rsPorKg: 11.3, linhasAgregadas: 1, produtosSugeridos: [],
    bloqueio: 'sem_correlacao', bloqueioMensagem: null, jaRecebido: false, quantidadeNfJaAtribuidaKg: 0, quantidadeConferidaJaGravadaKg: 0,
    quantidadeRestanteKg: 18000, baixadoComoExterno: false, baixaSolicitada: false, conversao: conv, sequenciasRecebimento: [1], pc: null,
    ...o,
  };
}

function detalhe(over: Partial<DetalheNfNacional> = {}): DetalheNfNacional {
  return {
    nfChaveAcesso: CHAVE, notaFiscal: '7813', fornecedorNome: FORNECEDOR, fornecedorCnpj: '11.111.111/0001-11',
    dtEmissao: '2026-10-20', diasDesdeEmissao: 1, cfop: '1.102', valorTotalBrl: 203400, valorNotaBrl: 203400, itens: [item()],
    linhasForaDoRecorte: 0, fiscal: 'pendente', nIdReceb: 8517930857, dispensavel: true,
    empresa: 'q2p', exigePc: true, estoqueLancadoPeloOmie: false, copiaPcsDefasada: false, itensSemAvaliacaoPc: [],
    pcsDaNf: { pcs: [], preSelecionado: null },
    ...over,
  };
}

const entrada = (o: Partial<ItemParaSugestao> = {}): ItemParaSugestao => ({
  indice: 0, descricao: DESC, quantidadeKg: 18000, unidadeNf: 'KG', fatorUnidadeNf: 1, precoNfKg: 11.3, precoItemKg: null,
  numeroPedidoNf: null, vinculos: [], sequencias: [1], kgPorSequencia: { 1: 18000 }, ...o,
});

const pcVazio: PcDoItem = {
  vinculoOmie: null, vinculoOmieElegivel: false, alertaVinculoOmie: null, vinculosDivergentes: false, candidatos: [],
  outrosDoFornecedor: [], aguardandoAprovacao: [], unidadeIncompativel: [], preSelecionado: null, semPcMotivo: null, vinculadoNoOmie: null,
};

const comCandidato = (): ResultadoPcItem => ({
  pc: { ...pcVazio, candidatos: [PC304], outrosDoFornecedor: [PC310] },
  possivel: true, motivoSemPc: null, situacao: 'sugerido',
});
const semPc = (motivo: 'sem_pc' | 'pc_aguardando_aprovacao' | 'vinculo_invalido' = 'sem_pc'): ResultadoPcItem => ({
  pc: {
    ...pcVazio,
    aguardandoAprovacao: motivo === 'pc_aguardando_aprovacao' ? [PC305] : [],
    vinculoOmie: motivo === 'vinculo_invalido' ? { ...PC304, pcNumero: '251' } : null,
    semPcMotivo: 'O fornecedor não tem pedido de compra aprovado com saldo para este item.',
  },
  possivel: false, motivoSemPc: motivo, situacao: motivo === 'pc_aguardando_aprovacao' ? 'aguardando_aprovacao' : 'sem_pc',
});

let det: DetalheNfNacional;
let interno: DetalheNfNacionalInterno;
const usarPc = (r: ResultadoPcItem | null, e: Partial<ItemParaSugestao> = {}) => {
  interno = { fornecedorCodigo: 1111, espelhoConfirmaConclusao: true, pcPorIndice: new Map([[0, { entrada: entrada(e), resultado: r }]]) };
};

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

const post = (pc?: Record<string, unknown> | null) => ({
  nfChaveAcesso: CHAVE,
  userId: USER,
  itens: [{ indice: 0, descricaoFornecedor: DESC, produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 18000, localidadeId: LOC_A }], ...(pc !== undefined ? { pc } : {}) }],
});

const fiscalOk = (o: Record<string, unknown> = {}) => ({
  status: 'concluido', concluidoEm: '2026-10-22T10:00:00.000Z', ledgerId: 'ledger-1', itensTotal: 1, vinculos: [], semVinculo: [], ...o,
});

const movOuAprovacao = () => inserts.filter((i) => i.table === 'movimentacao' || i.table === 'aprovacao');

beforeEach(() => {
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) => Promise.resolve(poolPadrao(sql, params)));
  inserts.length = 0;
  config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
  config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC = true;
  det = detalhe();
  usarPc(comCandidato());
  spies.detalhe.mockReset();
  spies.detalhe.mockImplementation(async () => ({ detalhe: det, interno }));
  spies.fiscal.mockReset();
  spies.fiscal.mockResolvedValue(fiscalOk());
  spies.aviso.mockReset();
  spies.aviso.mockResolvedValue('enviado');
  spies.consultarRecebimento.mockReset();
  spies.d21Habilitado.mockReset().mockResolvedValue(false);
  spies.ledgerVigente.mockReset().mockResolvedValue(null);
  spies.marcar.mockReset().mockResolvedValue([]);
});

describe('NF sem PC possivel (D6, FR-019/FR-020)', () => {
  it('EXIGE_PC=true: 422 NF_SEM_PC, nenhum INSERT em movimentacao/aprovacao, fiscal nao roda, compras avisado', async () => {
    usarPc(semPc('sem_pc'));
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(NfSemPcError);
    expect(movOuAprovacao()).toHaveLength(0);
    expect(spies.fiscal).not.toHaveBeenCalled();
    expect(spies.aviso).toHaveBeenCalledTimes(1);
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({
      motivo: 'sem_pc', nfChaveAcesso: CHAVE, notaFiscal: '7813', fornecedorNome: FORNECEDOR, disparadoPor: USER,
      itens: [{ nSequencia: 1, descricao: DESC, qtdKg: 18000, precoUnit: 11.3 }],
    });
  });

  it('a mensagem do NF_SEM_PC cita a NF, o fornecedor e o item, sem codigo OMIE', async () => {
    usarPc(semPc('sem_pc'));
    const err = await processarRecebimentoNacionalPorNf(post()).catch((e: Error) => e);
    expect((err as Error).message).toContain('NF 7813');
    expect((err as Error).message).toContain(FORNECEDOR);
    expect((err as Error).message).toContain(DESC);
    expect((err as Error).message).not.toMatch(/\d{10}/);
  });

  it('item so com PC na etapa 10: NF_SEM_PC e aviso com motivo pc_aguardando_aprovacao (com o numero do PC)', async () => {
    usarPc(semPc('pc_aguardando_aprovacao'));
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(NfSemPcError);
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({ motivo: 'pc_aguardando_aprovacao', pcsAguardandoAprovacao: ['305'] });
  });

  it('EXIGE_PC=false: segue sem vinculo — o fiscal recebe as sequencias sem PC e compras e avisado depois (recebida_sem_vinculo)', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC = false;
    usarPc(semPc('sem_pc'));
    spies.fiscal.mockResolvedValue(fiscalOk({ semVinculo: [1] }));
    const r = await processarRecebimentoNacionalPorNf(post());
    expect(spies.fiscal).toHaveBeenCalledTimes(1);
    expect(spies.fiscal.mock.calls[0]![0]).toMatchObject({ vinculos: [], sequenciasSemVinculo: [1], fornecedorCodigo: 1111 });
    expect(movOuAprovacao().length).toBeGreaterThan(0);
    expect(spies.aviso).toHaveBeenCalledTimes(1);
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({ motivo: 'recebida_sem_vinculo' });
    expect(r.fiscal).toMatchObject({ status: 'concluido', semVinculo: [1], avisoCompras: true });
  });

  it('EXIGE_PC=false com vinculo do OMIE que nao serve e sem outro PC: recusado (nunca ignorado — FR-011a)', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC = false;
    usarPc(semPc('vinculo_invalido'));
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(NfSemPcError);
    expect(spies.fiscal).not.toHaveBeenCalled();
    expect(movOuAprovacao()).toHaveLength(0);
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({ motivo: 'sem_pc' });
  });
});

describe('escolha do PC no portao 1 (T023)', () => {
  it('item com PC possivel e sem escolha: 422 PC_NAO_ESCOLHIDO, nos dois modos, sem aviso a compras', async () => {
    for (const exige of [true, false]) {
      config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC = exige;
      await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(PcNaoEscolhidoError);
    }
    expect(spies.aviso).not.toHaveBeenCalled();
    expect(spies.fiscal).not.toHaveBeenCalled();
    expect(movOuAprovacao()).toHaveLength(0);
  });

  it('candidato dentro da tolerancia: o fiscal recebe a escolha validada (origem sugestao, por sequencia)', async () => {
    const r = await processarRecebimentoNacionalPorNf(post({ n_cod_ped: PC304.nCodPed, n_cod_item: PC304.nCodItem, n_cod_item_omie_visto: null }));
    const input = spies.fiscal.mock.calls[0]![0] as { vinculos: Array<Record<string, unknown>>; sequenciasSemVinculo: number[] };
    expect(input.sequenciasSemVinculo).toEqual([]);
    expect(input.vinculos).toHaveLength(1);
    expect(input.vinculos[0]).toMatchObject({
      indice: 0, sequencias: [1], origem: 'sugestao', dentroTolerancia: true, justificativa: null,
      nCodPedOmieAnterior: null, nCodItemOmieVisto: null, qtdNfKg: 18000, precoNfKg: 11.3, kgPorSequencia: { 1: 18000 },
    });
    expect((input.vinculos[0]!.candidato as PcCandidato).pcNumero).toBe('304');
    expect(r.fiscal.status).toBe('concluido');
  });

  it('falha do fiscal no ASSOCIAR-PEDIDO: o erro sobe e nenhum INSERT em movimentacao/aprovacao (T031)', async () => {
    spies.fiscal.mockImplementation(async () => {
      throw new RecebimentoFiscalError('associar', '7813', FORNECEDOR);
    });
    const err = await processarRecebimentoNacionalPorNf(post({ n_cod_ped: PC304.nCodPed, n_cod_item: PC304.nCodItem })).catch((e: Error) => e);
    expect(err).toBeInstanceOf(RecebimentoFiscalError);
    expect((err as RecebimentoFiscalError).passo).toBe('associar');
    expect(movOuAprovacao()).toHaveLength(0);
    expect(spies.aviso).not.toHaveBeenCalled();
  });

  it('PC fora das listas: 422 PC_NAO_ELEGIVEL; PC aguardando aprovacao tambem', async () => {
    await expect(processarRecebimentoNacionalPorNf(post({ n_cod_ped: 1, n_cod_item: 2 }))).rejects.toBeInstanceOf(PcNaoElegivelError);
    usarPc({ ...comCandidato(), pc: { ...comCandidato().pc, aguardandoAprovacao: [PC305] } });
    const err = await processarRecebimentoNacionalPorNf(post({ n_cod_ped: PC305.nCodPed, n_cod_item: PC305.nCodItem })).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PcNaoElegivelError);
    expect((err as Error).message).toContain('aguardando aprovação');
    expect(spies.fiscal).not.toHaveBeenCalled();
  });

  it('outro PC do fornecedor sem justificativa: 422 PC_JUSTIFICATIVA_OBRIGATORIA; com justificativa vai como manual', async () => {
    await expect(processarRecebimentoNacionalPorNf(post({ n_cod_ped: PC310.nCodPed, n_cod_item: PC310.nCodItem }))).rejects.toBeInstanceOf(
      PcJustificativaObrigatoriaError,
    );
    await processarRecebimentoNacionalPorNf(post({ n_cod_ped: PC310.nCodPed, n_cod_item: PC310.nCodItem, justificativa: 'Preço renegociado com o fornecedor' }));
    const input = spies.fiscal.mock.calls[0]![0] as { vinculos: Array<Record<string, unknown>> };
    expect(input.vinculos[0]).toMatchObject({ origem: 'manual', dentroTolerancia: false, justificativa: 'Preço renegociado com o fornecedor' });
  });

  // Trava de unidade (22/10/2026): o portao 1 passa a unidade da NF ao validar a escolha, e a escolha validada
  // leva unidadeNf/fatorUnidadeNf ate o fiscal -> releitura ao vivo (recusa ou conversao).
  it('a escolha validada leva a unidade da NF e o fator ate o fiscal (a releitura ao vivo decide a trava)', async () => {
    usarPc(comCandidato(), { unidadeNf: 'TON', fatorUnidadeNf: 1000 });
    await processarRecebimentoNacionalPorNf(post({ n_cod_ped: PC304.nCodPed, n_cod_item: PC304.nCodItem }));
    const input = spies.fiscal.mock.calls[0]![0] as { vinculos: Array<Record<string, unknown>> };
    expect(input.vinculos[0]).toMatchObject({ unidadeNf: 'TON', fatorUnidadeNf: 1000 });
  });

  // Research D20: o peso conferido do item inteiro vai na escolha validada (a releitura decide o que vai ao PC).
  it('sem divergencia: a escolha validada leva o peso conferido igual ao da NF', async () => {
    await processarRecebimentoNacionalPorNf(post({ n_cod_ped: PC304.nCodPed, n_cod_item: PC304.nCodItem }));
    const input = spies.fiscal.mock.calls[0]![0] as { vinculos: Array<Record<string, unknown>> };
    expect(input.vinculos[0]).toMatchObject({ qtdNfKg: 18000, qtdConferidaKg: 18000 });
  });

  it('peso a mais com motivo: a escolha validada leva o peso da balanca do item (18.500), nao a NF', async () => {
    const corpo = post({ n_cod_ped: PC304.nCodPed, n_cod_item: PC304.nCodItem });
    corpo.itens[0] = {
      ...corpo.itens[0]!,
      quantidadeConferidaKg: 18500,
      motivoDivergencia: '9 paletes fechados de 1.500 kg mais sobra',
      produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 18500, localidadeId: LOC_A }],
    } as (typeof corpo.itens)[number];
    await processarRecebimentoNacionalPorNf(corpo);
    const input = spies.fiscal.mock.calls[0]![0] as { vinculos: Array<Record<string, unknown>> };
    expect(input.vinculos[0]).toMatchObject({ qtdNfKg: 18000, qtdConferidaKg: 18500 });
  });

  it('NF em kg: unidadeNf KG e fator 1 no que vai ao fiscal', async () => {
    await processarRecebimentoNacionalPorNf(post({ n_cod_ped: PC304.nCodPed, n_cod_item: PC304.nCodItem }));
    const input = spies.fiscal.mock.calls[0]![0] as { vinculos: Array<Record<string, unknown>> };
    expect(input.vinculos[0]).toMatchObject({ unidadeNf: 'KG', fatorUnidadeNf: 1 });
  });

  it('PC da lista de unidade incompativel escolhido (chamada direta): 422 PC_NAO_ELEGIVEL "está em kg e a nota em toneladas", sem fiscal e sem gravar', async () => {
    const pc306Kg: PcCandidato = { ...PC304, nCodPed: 8516900306, nCodItem: 8516900307, pcNumero: '306', unidade: 'KG', motivo: 'PC em kg e nota em toneladas' };
    usarPc({ ...comCandidato(), pc: { ...comCandidato().pc, candidatos: [], outrosDoFornecedor: [], unidadeIncompativel: [pc306Kg] } }, { unidadeNf: 'TON', fatorUnidadeNf: 1000 });
    const err = (await processarRecebimentoNacionalPorNf(post({ n_cod_ped: pc306Kg.nCodPed, n_cod_item: pc306Kg.nCodItem })).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(PcNaoElegivelError);
    expect(err.message).toContain('O PC 306 não pode ser vinculado');
    expect(err.message).toContain('está em kg e a nota em toneladas');
    expect(err.message).not.toMatch(/\d{10}/);
    expect(spies.fiscal).not.toHaveBeenCalled();
    expect(movOuAprovacao()).toHaveLength(0);
  });

  it('PC enviado para NF com fiscal ja feito: ignorado (o fiscal nao roda; o fisico segue)', async () => {
    det = detalhe({ fiscal: 'concluido' });
    usarPc(null);
    const r = await processarRecebimentoNacionalPorNf(post({ n_cod_ped: PC304.nCodPed, n_cod_item: PC304.nCodItem }));
    expect(spies.fiscal).not.toHaveBeenCalled();
    expect(r.fiscal.status).toBe('nao_aplicavel');
    expect(movOuAprovacao().length).toBeGreaterThan(0);
  });
});

describe('copia de PCs defasada (D13, FR-030)', () => {
  it('503 COPIA_PCS_DEFASADA: nada gravado, sem aviso a compras, fiscal nao roda', async () => {
    det = detalhe({ copiaPcsDefasada: true });
    usarPc(null);
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(CopiaPcsDefasadaError);
    expect(movOuAprovacao()).toHaveLength(0);
    expect(spies.aviso).not.toHaveBeenCalled();
    expect(spies.fiscal).not.toHaveBeenCalled();
  });

  it('NF com fiscal ja feito nao depende da copia: segue normal', async () => {
    det = detalhe({ fiscal: 'concluido', copiaPcsDefasada: true });
    usarPc(null);
    const r = await processarRecebimentoNacionalPorNf(post());
    expect(r.fiscal.status).toBe('nao_aplicavel');
    expect(movOuAprovacao().length).toBeGreaterThan(0);
  });
});

describe('estoque ja lancado pelo OMIE (D7, FR-021a)', () => {
  it('detalhe marca estoqueLancadoPeloOmie: 409, nada gravado — tambem com a chave da 016 desligada', async () => {
    for (const chave of [true, false]) {
      config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = chave;
      det = detalhe({ fiscal: 'concluido', estoqueLancadoPeloOmie: true });
      usarPc(null);
      await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(EstoqueJaLancadoPeloOmieError);
    }
    expect(movOuAprovacao()).toHaveLength(0);
    expect(spies.consultarRecebimento).not.toHaveBeenCalled();
  });

  it('NF "fiscal ja feito" sem conclusao confirmada (fora do espelho, linha defasada ou nao casada): le ao vivo por chave; concluido COM estoque -> 409', async () => {
    det = detalhe({ fiscal: 'concluido' });
    usarPc(null);
    interno.espelhoConfirmaConclusao = false;
    spies.consultarRecebimento.mockResolvedValue({
      cRecebido: 'S',
      itens: [{ nSequencia: 1, cIgnorarItem: 'N', cNaoGerarMovEstoque: 'N' }],
    });
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(EstoqueJaLancadoPeloOmieError);
    expect(spies.consultarRecebimento).toHaveBeenCalledWith('q2p', { cChaveNfe: CHAVE });
    expect(movOuAprovacao()).toHaveLength(0);
  });

  it('leitura ao vivo SEM estoque (nao movimentar ou ignorado) segue; recebimento inexistente no OMIE tambem', async () => {
    det = detalhe({ fiscal: 'concluido' });
    usarPc(null);
    interno.espelhoConfirmaConclusao = false;
    spies.consultarRecebimento.mockResolvedValueOnce({ cRecebido: 'S', itens: [{ nSequencia: 1, cIgnorarItem: 'N', cNaoGerarMovEstoque: 'S' }] });
    await processarRecebimentoNacionalPorNf(post());
    expect(movOuAprovacao().length).toBeGreaterThan(0);

    inserts.length = 0;
    spies.consultarRecebimento.mockRejectedValueOnce(new Error('SOAP-ENV:Client-5001: Recebimento não encontrado para a chave informada'));
    await processarRecebimentoNacionalPorNf(post());
    expect(movOuAprovacao().length).toBeGreaterThan(0);
  });

  it('leitura ao vivo falhou por outro motivo: 502 sem gravar (nao da para saber se o estoque entrou)', async () => {
    det = detalhe({ fiscal: 'concluido' });
    usarPc(null);
    interno.espelhoConfirmaConclusao = false;
    spies.consultarRecebimento.mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(VerificacaoEstoqueOmieError);
    expect(movOuAprovacao()).toHaveLength(0);
  });

  it('conclusao confirmada pelo espelho (c_recebido S), sem fiscal concluido pelo Atlas no ledger: nenhuma leitura ao vivo (Principio II)', async () => {
    det = detalhe({ fiscal: 'concluido' });
    usarPc(null);
    spies.d21Habilitado.mockResolvedValue(true); // D21 ligada, mas sem ledger vigente (spies.ledgerVigente → null)
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.ledgerVigente).toHaveBeenCalledWith(CHAVE);
    expect(spies.consultarRecebimento).not.toHaveBeenCalled();
  });

  it('conclusao confirmada pelo ledger do Atlas com a D21 DESLIGADA (chave da 016, kill switch ou migration 0060): nenhuma leitura ao vivo, como na 017', async () => {
    det = detalhe({ fiscal: 'concluido' });
    usarPc(null);
    spies.d21Habilitado.mockResolvedValue(false);
    spies.ledgerVigente.mockResolvedValue({ id: 'l-1', status: 'concluido', empresa: 'q2p', nIdReceb: 8517930857, notaFiscal: '7813', fornecedorNome: FORNECEDOR, finalizadoEm: new Date(Date.now() - 3600_000).toISOString() });
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.ledgerVigente).not.toHaveBeenCalled();
    expect(spies.consultarRecebimento).not.toHaveBeenCalled();
  });

  // D21 (ACXEGDP-437): antes, o ledger concluido bastava para NAO ler (o teste dizia "ou pelo ledger"). Agora, com a D21 ligada, o
  // fiscal que o Atlas concluiu ha 75 s ou mais e conferido numa leitura ao vivo — o recebimento pode ter sido desfeito no portal.
  it('fiscal concluido pelo Atlas (ledger) com a D21 LIGADA: UMA leitura ao vivo por nIdReceb; OMIE ainda concluido sem estoque -> segue', async () => {
    det = detalhe({ fiscal: 'concluido' });
    usarPc(null);
    spies.d21Habilitado.mockResolvedValue(true);
    spies.ledgerVigente.mockResolvedValue({ id: 'l-1', status: 'concluido', empresa: 'q2p', nIdReceb: 8517930857, notaFiscal: '7813', fornecedorNome: FORNECEDOR, finalizadoEm: new Date(Date.now() - 3600_000).toISOString() });
    spies.consultarRecebimento.mockResolvedValue({ cRecebido: 'S', cCancelada: 'N', itens: [{ nSequencia: 1, cIgnorarItem: 'N', cNaoGerarMovEstoque: 'S' }] });
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.consultarRecebimento).toHaveBeenCalledTimes(1);
    // o ledger confirma a conclusao (a D7 nao exige a leitura): so a conferencia da reversao, sem retry
    expect(spies.consultarRecebimento).toHaveBeenCalledWith('q2p', { nIdReceb: 8517930857 }, { retries: 0 });
    expect(spies.marcar).not.toHaveBeenCalled();
    expect(movOuAprovacao().length).toBeGreaterThan(0);
  });
});

// ── Aviso a compras sem o formulario (achado A1 da revisao de UI, contrato §3b) ──
describe('avisarComprasNfSemPc', () => {
  it('NF aguardando PC (EXIGE_PC=true): avisa compras com o motivo e devolve a mensagem para a tela', async () => {
    usarPc(semPc('sem_pc'));
    const r = await avisarComprasNfSemPc({ nfChaveAcesso: CHAVE, userId: USER });
    expect(r).toMatchObject({ status: 'enviado', motivo: 'sem_pc', itens: [DESC] });
    expect(r.mensagem).toContain('A equipe de Compras foi avisada');
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({ motivo: 'sem_pc', nfChaveAcesso: CHAVE, disparadoPor: USER });
    expect(movOuAprovacao()).toHaveLength(0);
    expect(spies.fiscal).not.toHaveBeenCalled();
  });

  it('ja avisado nas ultimas 24 h: devolve deduplicado com mensagem propria', async () => {
    usarPc(semPc('pc_aguardando_aprovacao'));
    spies.aviso.mockResolvedValue('deduplicado');
    const r = await avisarComprasNfSemPc({ nfChaveAcesso: CHAVE, userId: USER });
    expect(r).toMatchObject({ status: 'deduplicado', motivo: 'pc_aguardando_aprovacao' });
    expect(r.mensagem).toContain('já foi avisada');
  });

  it('nao se aplica: chave desligada, fiscal ja feito, item com PC possivel, ou EXIGE_PC=false so com item sem PC', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = false;
    usarPc(semPc('sem_pc'));
    await expect(avisarComprasNfSemPc({ nfChaveAcesso: CHAVE, userId: USER })).rejects.toBeInstanceOf(AvisoComprasNaoAplicavelError);
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
    det = detalhe({ fiscal: 'concluido' });
    await expect(avisarComprasNfSemPc({ nfChaveAcesso: CHAVE, userId: USER })).rejects.toBeInstanceOf(AvisoComprasNaoAplicavelError);
    det = detalhe();
    usarPc(comCandidato());
    await expect(avisarComprasNfSemPc({ nfChaveAcesso: CHAVE, userId: USER })).rejects.toBeInstanceOf(AvisoComprasNaoAplicavelError);
    config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC = false;
    usarPc(semPc('sem_pc'));
    await expect(avisarComprasNfSemPc({ nfChaveAcesso: CHAVE, userId: USER })).rejects.toBeInstanceOf(AvisoComprasNaoAplicavelError);
    expect(spies.aviso).not.toHaveBeenCalled();
  });

  it('vinculo do OMIE que nao serve, sem outro PC: avisa tambem com EXIGE_PC=false (FR-011a)', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC = false;
    usarPc(semPc('vinculo_invalido'));
    const r = await avisarComprasNfSemPc({ nfChaveAcesso: CHAVE, userId: USER });
    expect(r.status).toBe('enviado');
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({ motivo: 'sem_pc' });
  });

  it('item ja recebido ou bloqueado por unidade nao conta; copia defasada da 503', async () => {
    usarPc(semPc('sem_pc'));
    det = detalhe({ itens: [item({ jaRecebido: true, quantidadeNfJaAtribuidaKg: 18000, quantidadeRestanteKg: 0 })] });
    await expect(avisarComprasNfSemPc({ nfChaveAcesso: CHAVE, userId: USER })).rejects.toBeInstanceOf(AvisoComprasNaoAplicavelError);
    det = detalhe({ copiaPcsDefasada: true });
    await expect(avisarComprasNfSemPc({ nfChaveAcesso: CHAVE, userId: USER })).rejects.toBeInstanceOf(CopiaPcsDefasadaError);
    expect(spies.aviso).not.toHaveBeenCalled();
  });
});

// ── Achado fila-02: item que o Atlas nao recebe (unidade) e sem PC no OMIE ──
describe('item pendente que o Atlas nao recebe (unidade) e sem PC no OMIE (FR-011a/FR-020)', () => {
  const itemTampa = (): ItemNfNacional =>
    item({
      indice: 1, descricaoFornecedor: 'TAMPA', descricaoNormalizada: 'TAMPA', unidadeOriginal: 'UN', quantidadeNf: 300, quantidadeNfKg: null,
      rsPorKg: null, quantidadeRestanteKg: null, bloqueio: 'unidade_nao_conversivel', sequenciasRecebimento: [2],
      conversao: { ok: false, motivo: 'unidade_nao_conversivel', unidadeOriginal: 'UN', mensagem: 'Unidade UN não convertida para kg.' } as ItemNfNacional['conversao'],
    });
  const comTampa = () => {
    det = detalhe({ itens: [item(), itemTampa()], itensSemAvaliacaoPc: [{ indice: 1, descricao: 'TAMPA' }] });
    interno = {
      fornecedorCodigo: 1111,
      espelhoConfirmaConclusao: true,
      pcPorIndice: new Map([
        [0, { entrada: entrada(), resultado: comCandidato() }],
        [1, { entrada: entrada({ indice: 1, descricao: 'TAMPA', quantidadeKg: null, precoNfKg: null, sequencias: [2], kgPorSequencia: {} }), resultado: null }],
      ]),
    };
  };
  const postCom304 = () => post({ n_cod_ped: PC304.nCodPed, n_cod_item: PC304.nCodItem });

  it('EXIGE_PC=true: 422 NF_SEM_PC que orienta o fiscal — sem aviso a compras, sem fiscal e sem gravar', async () => {
    comTampa();
    const err = (await processarRecebimentoNacionalPorNf(postCom304()).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(NfSemPcError);
    expect(err.message).toContain('TAMPA');
    expect(err.message).toContain('unidade não convertida para kg');
    expect(err.message).not.toContain('Compras');
    expect(spies.aviso).not.toHaveBeenCalled();
    expect(spies.fiscal).not.toHaveBeenCalled();
    expect(movOuAprovacao()).toHaveLength(0);
  });

  it('EXIGE_PC=false: a sequencia do item segue "sem vinculo" no fiscal e compras e avisado depois', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC = false;
    comTampa();
    spies.fiscal.mockResolvedValue(fiscalOk({ semVinculo: [2] }));
    await processarRecebimentoNacionalPorNf(postCom304());
    expect(spies.fiscal.mock.calls[0]![0]).toMatchObject({ sequenciasSemVinculo: [2] });
    expect(spies.aviso).toHaveBeenCalledTimes(1);
    // achado fila-v04: sem kg, o aviso leva a quantidade nativa da NF — nunca "0 kg"
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({
      motivo: 'recebida_sem_vinculo',
      itens: [{ nSequencia: 2, descricao: 'TAMPA', qtdKg: null, quantidadeTexto: '300 UN' }],
    });
  });

  it('com a lista vazia (item de unidade COM vinculo no OMIE, ou fluxo sem PC) nada muda', async () => {
    comTampa();
    det.itensSemAvaliacaoPc = [];
    await processarRecebimentoNacionalPorNf(postCom304());
    expect(spies.fiscal.mock.calls[0]![0]).toMatchObject({ sequenciasSemVinculo: [] });
  });
});

// ── Trava de unidade (22/10/2026): so ha PC em unidade diferente da NF ──
describe('aviso a compras com PC em unidade diferente da nota (NF 60199 x PC 306)', () => {
  /** NF em toneladas (8,25 t) e o unico PC do fornecedor em kg: o OMIE baixaria o PC com 8,25, nao 8.250. */
  const NF_EM_TON = (): void => {
    det = detalhe({ itens: [item({ unidadeOriginal: 'TON', quantidadeNf: 18, quantidadeNfKg: 18000 })] });
  };
  const PC306_KG: PcCandidato = { ...PC304, nCodPed: 8516900306, nCodItem: 8516900307, pcNumero: '306', unidade: 'KG', motivo: 'PC em kg e nota em toneladas' };
  const semPcDeUnidade = (extra: Partial<PcDoItem> = {}): ResultadoPcItem => ({
    pc: {
      ...pcVazio,
      unidadeIncompativel: [PC306_KG],
      semPcMotivo: 'O PC 306 está em kg e a nota em toneladas: o OMIE baixaria o pedido na unidade da nota, sem converter.',
      ...extra,
    },
    possivel: false, motivoSemPc: 'unidade_pc', situacao: 'sem_pc',
  });

  it('o aviso leva a unidade da nota, o PC em unidade diferente e o item; o motivo segue sem_pc', async () => {
    NF_EM_TON();
    usarPc(semPcDeUnidade());
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(NfSemPcError);
    expect(spies.aviso).toHaveBeenCalledTimes(1);
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({
      motivo: 'sem_pc',
      unidadeIncompativel: { unidadeNf: 'TON', pcs: ['306'], itens: [DESC] },
    });
    expect(spies.aviso.mock.calls[0]![0]).not.toHaveProperty('pcsOutroCadastro');
    expect(spies.aviso.mock.calls[0]![0]).not.toHaveProperty('cnpjNf');
    expect(spies.fiscal).not.toHaveBeenCalled();
    expect(movOuAprovacao()).toHaveLength(0);
  });

  it('a mensagem do NF_SEM_PC pede o pedido na unidade da nota e nunca leva código do OMIE', async () => {
    NF_EM_TON();
    usarPc(semPcDeUnidade());
    const err = (await processarRecebimentoNacionalPorNf(post()).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(NfSemPcError);
    expect(err.message).toContain('em unidade diferente da nota');
    expect(err.message).toContain(DESC);
    expect(err.message).toContain('A equipe de Compras foi avisada para lançar o pedido na unidade da nota');
    expect(err.message).not.toMatch(/\d{10}/);
  });

  it('o aviso pedido pela tela leva o mesmo', async () => {
    NF_EM_TON();
    usarPc(semPcDeUnidade());
    const r = await avisarComprasNfSemPc({ nfChaveAcesso: CHAVE, userId: USER });
    expect(r.status).toBe('enviado');
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({ motivo: 'sem_pc', unidadeIncompativel: { unidadeNf: 'TON', pcs: ['306'], itens: [DESC] } });
  });

  it('vínculo do OMIE inelegível por unidade (sem outro PC): o PC do vínculo entra na lista do aviso', async () => {
    NF_EM_TON();
    usarPc(
      semPcDeUnidade({
        unidadeIncompativel: [],
        vinculoOmie: { ...PC306_KG, motivo: 'Vínculo do OMIE' },
        vinculoOmieElegivel: false,
        alertaVinculoOmie: 'O PC 306 vinculado no OMIE está em kg e a nota em toneladas',
      }),
    );
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(NfSemPcError);
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({ unidadeIncompativel: { pcs: ['306'], itens: [DESC] } });
  });

  it('PC com número em branco não entra na lista de PCs do aviso (a lista pode ir vazia; o e-mail diz "o pedido de compra deste fornecedor")', async () => {
    NF_EM_TON();
    usarPc(semPcDeUnidade({ unidadeIncompativel: [{ ...PC306_KG, pcNumero: '' }] }));
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(NfSemPcError);
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({ unidadeIncompativel: { pcs: [], itens: [DESC] } });
  });

  /** POST dos dois itens da NF: o 1º (18.000 kg) e o 2º, "SUCATA PP" (9.000 kg). */
  const postDoisItens = () => ({
    ...post(),
    itens: [post().itens[0]!, { indice: 1, descricaoFornecedor: 'SUCATA PP', produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 9000, localidadeId: LOC_A }] }],
  });

  it('o mesmo PC em dois itens da NF sai uma vez só e os dois itens ficam na lista', async () => {
    const item2 = item({ indice: 1, descricaoFornecedor: 'SUCATA PP', descricaoNormalizada: 'SUCATA PP', unidadeOriginal: 'TON', sequenciasRecebimento: [2], quantidadeNfKg: 9000, quantidadeRestanteKg: 9000 });
    det = detalhe({ itens: [item({ unidadeOriginal: 'TON' }), item2] });
    interno = {
      fornecedorCodigo: 1111,
      espelhoConfirmaConclusao: true,
      pcPorIndice: new Map([
        [0, { entrada: entrada({ unidadeNf: 'TON', fatorUnidadeNf: 1000 }), resultado: semPcDeUnidade() }],
        [1, { entrada: entrada({ indice: 1, descricao: 'SUCATA PP', quantidadeKg: 9000, sequencias: [2], kgPorSequencia: { 2: 9000 }, unidadeNf: 'TON', fatorUnidadeNf: 1000 }), resultado: semPcDeUnidade() }],
      ]),
    };
    await expect(processarRecebimentoNacionalPorNf(postDoisItens())).rejects.toBeInstanceOf(NfSemPcError);
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({ unidadeIncompativel: { pcs: ['306'], itens: [DESC, 'SUCATA PP'] } });
  });

  it('item sem PC de verdade + item com PC em unidade diferente: o aviso e o erro separam os dois (a lista de unidade só leva o segundo)', async () => {
    const item2 = item({ indice: 1, descricaoFornecedor: 'SUCATA PP', descricaoNormalizada: 'SUCATA PP', unidadeOriginal: 'TON', sequenciasRecebimento: [2], quantidadeNfKg: 9000, quantidadeRestanteKg: 9000 });
    det = detalhe({ itens: [item(), item2] });
    interno = {
      fornecedorCodigo: 1111,
      espelhoConfirmaConclusao: true,
      pcPorIndice: new Map([
        [0, { entrada: entrada(), resultado: semPc('sem_pc') }],
        [1, { entrada: entrada({ indice: 1, descricao: 'SUCATA PP', quantidadeKg: 9000, sequencias: [2], kgPorSequencia: { 2: 9000 }, unidadeNf: 'TON', fatorUnidadeNf: 1000 }), resultado: semPcDeUnidade() }],
      ]),
    };
    const err = (await processarRecebimentoNacionalPorNf(postDoisItens()).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(NfSemPcError);
    expect(err.message).toContain('tem item sem pedido de compra no OMIE (SUCATA PLASTICO)');
    expect(err.message).toContain('Para SUCATA PP, o pedido de compra do fornecedor está em unidade diferente da nota');
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({ motivo: 'sem_pc', unidadeIncompativel: { itens: ['SUCATA PP'] } });
    expect((spies.aviso.mock.calls[0]![0] as { itens: unknown[] }).itens).toHaveLength(2);
  });

  it('sem_pc comum (sem PC nenhum): unidadeIncompativel null', async () => {
    usarPc(semPc('sem_pc'));
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(NfSemPcError);
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({ unidadeIncompativel: null });
  });

  it('EXIGE_PC=false e PC só em unidade diferente (sem vínculo no OMIE): recebe sem vínculo, como qualquer item sem PC possível, e avisa depois', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC = false;
    NF_EM_TON();
    usarPc(semPcDeUnidade());
    spies.fiscal.mockResolvedValue(fiscalOk({ semVinculo: [1] }));
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.fiscal.mock.calls[0]![0]).toMatchObject({ vinculos: [], sequenciasSemVinculo: [1] });
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({ motivo: 'recebida_sem_vinculo' });
  });

  // O item que VEIO vinculado no OMIE a um PC de unidade diferente tambem sai com motivoSemPc 'unidade_pc'
  // (montarPcDoItem, vinculoPorUnidade). "Seguir sem vinculo" ignoraria (IGNORAR) um item com vinculo VIVO no OMIE
  // (FR-011a) — e o fiscal so barraria depois, com 409 VINCULO_OMIE_MUDOU ("ganhou vínculo no OMIE"), mensagem
  // enganosa. Recusa no portao 1, como o 'vinculo_invalido', nos dois modos.
  it.each([true, false])('EXIGE_PC=%s e vínculo do OMIE em PC de unidade diferente: recusa no portão 1 (NF_SEM_PC), sem seguir como "sem vínculo"', async (exige) => {
    config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC = exige;
    NF_EM_TON();
    usarPc(
      semPcDeUnidade({ vinculoOmie: PC306_KG, vinculoOmieElegivel: false, alertaVinculoOmie: 'PC em kg e nota em toneladas' }),
      { unidadeNf: 'TON', fatorUnidadeNf: 1000, vinculos: [{ nSequencia: 1, nIdPedido: PC306_KG.nCodPed, nIdItPedido: PC306_KG.nCodItem }] },
    );
    const err = (await processarRecebimentoNacionalPorNf(post()).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(NfSemPcError);
    expect(spies.fiscal).not.toHaveBeenCalled();
    expect(movOuAprovacao()).toHaveLength(0);
    // o aviso a compras sai nos dois modos, com o quadro de unidade
    expect(spies.aviso.mock.calls[0]![0]).toMatchObject({ motivo: 'sem_pc', unidadeIncompativel: { pcs: ['306'], itens: [DESC] } });
  });

  it('EXIGE_PC=false e PC de unidade diferente SEM vínculo no OMIE continua seguindo sem vínculo (o caso acima é só o vínculo vivo)', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC = false;
    NF_EM_TON();
    usarPc(semPcDeUnidade(), { unidadeNf: 'TON', fatorUnidadeNf: 1000 });
    spies.fiscal.mockResolvedValue(fiscalOk({ semVinculo: [1] }));
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.fiscal.mock.calls[0]![0]).toMatchObject({ vinculos: [], sequenciasSemVinculo: [1] });
  });
});

// ── Verificacao das correcoes (22/10/2026): fornecedor nao cadastrado, NF incompleta ──
describe('NF com fornecedor não cadastrado no OMIE (NF 1257 — achados sugestao-v02/fila-v02)', () => {
  it.each([true, false])('EXIGE_PC=%s: RECEBIMENTO_FISCAL_SEM_FORNECEDOR antes das regras de PC — sem aviso a compras, sem fiscal, sem gravar', async (exige) => {
    config.STOCKBRIDGE_RECEBIMENTO_NACIONAL_EXIGE_PC = exige;
    det = detalhe({ fornecedorCnpj: '', fornecedorNome: 'Fornecedor não identificado no OMIE' });
    usarPc(semPc('sem_pc'));
    interno.fornecedorCodigo = null;
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(RecebimentoFiscalSemFornecedorError);
    expect(spies.aviso).not.toHaveBeenCalled();
    expect(spies.fiscal).not.toHaveBeenCalled();
    expect(movOuAprovacao()).toHaveLength(0);
  });

  it('o aviso pedido pela tela não se aplica (o problema é o cadastro, não o PC)', async () => {
    det = detalhe({ fornecedorCnpj: '' });
    usarPc(semPc('sem_pc'));
    interno.fornecedorCodigo = null;
    const err = (await avisarComprasNfSemPc({ nfChaveAcesso: CHAVE, userId: USER }).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(AvisoComprasNaoAplicavelError);
    expect(err.message).toContain('não está cadastrado no OMIE');
    expect(spies.aviso).not.toHaveBeenCalled();
  });
});

describe('NF recebida por inteiro com o fiscal pelo Atlas (D27 — achado fila-v03)', () => {
  const item2 = () =>
    item({ indice: 1, descricaoFornecedor: 'SUCATA PP', descricaoNormalizada: 'SUCATA PP', sequenciasRecebimento: [2], quantidadeNfKg: 9000, quantidadeRestanteKg: 9000 });

  it('POST sem um item pendente (chamada direta com subconjunto): 400 NF_INCOMPLETA, nada gravado nem concluído', async () => {
    det = detalhe({ itens: [item(), item2()] });
    const err = (await processarRecebimentoNacionalPorNf(post({ n_cod_ped: PC304.nCodPed, n_cod_item: PC304.nCodItem })).catch((e: Error) => e)) as ValidacaoRecebimentoNacionalError;
    expect(err).toBeInstanceOf(ValidacaoRecebimentoNacionalError);
    expect(err.code).toBe('NF_INCOMPLETA');
    expect(err.message).toContain('"SUCATA PP"');
    expect(spies.fiscal).not.toHaveBeenCalled();
    expect(movOuAprovacao()).toHaveLength(0);
  });

  it('item com baixa externa solicitada ou já recebido não precisa ir no POST (a tela também não o manda)', async () => {
    det = detalhe({ itens: [item(), item2(), item({ indice: 2, descricaoFornecedor: 'SUCATA PE', descricaoNormalizada: 'SUCATA PE', jaRecebido: true, quantidadeNfJaAtribuidaKg: 0 })] });
    det.itens[1]!.baixaSolicitada = true;
    await processarRecebimentoNacionalPorNf(post({ n_cod_ped: PC304.nCodPed, n_cod_item: PC304.nCodItem }));
    expect(spies.fiscal).toHaveBeenCalledTimes(1);
  });

  it('fiscal já feito (sem o fiscal pelo Atlas): subconjunto continua aceito — o re-POST completa itens', async () => {
    det = detalhe({ itens: [item(), item2()], fiscal: 'concluido' });
    usarPc(null);
    await processarRecebimentoNacionalPorNf(post());
    expect(movOuAprovacao().length).toBeGreaterThan(0);
  });
});
