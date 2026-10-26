import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 017, research D21 (ACXEGDP-437) — recebimento fiscal REVERTIDO no portal do OMIE, no CLIQUE do recebimento.
//
// Caso real: NF 19252 (Zaraplast, 25/10/2026) — o Atlas concluiu o fiscal as 17:02, o usuario reverteu no portal as
// 17:13. Quando o espelho ainda nao percebeu (sync de ate ~30 min), a NF segue "fiscal ja feito" e o clique faria so o
// fisico. Com o ledger do Atlas (fiscal concluido por ele ha 75 s ou mais) a MESMA leitura ao vivo da D7 passa a
// conferir a reversao: recebimento nao concluido no OMIE -> ledger marcado 'revertido' ANTES do 409
// RECEBIMENTO_FISCAL_REVERTIDO, nada gravado; a nota recarregada volta como fiscal pendente.
//
// O detalhe (montarDetalheNfNacional), o fiscal (concluirRecebimentoFiscal) e o ledger/marcacao (fiscal-revertido) sao
// mockados — cada um tem teste proprio (fila-nacional-revertido, recebimento-fiscal, fiscal-revertido). Aqui se prova
// a REGRA do clique: quando le, com que corpo, o que decide, o que marca, o que nunca muda (D7, chave desligada,
// conclusao recente, falha da leitura) e a ORDEM (tudo antes de qualquer escrita).

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
  consultarRecebimento: vi.fn(),
  habilitado: vi.fn(),
  vigente: vi.fn(),
  marcar: vi.fn(),
  sinal: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: spies.loggerInfo, warn: spies.loggerWarn, error: spies.loggerError, debug: vi.fn() }),
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
  enviarAvisoComprasNfSemPc: vi.fn().mockResolvedValue('enviado'),
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

// A classe do erro e leituraAoVivoPodeDeclararReversao (a regra dos 75 s) sao as REAIS; o resto vira spy.
vi.mock('../services/fiscal-revertido.js', async () => {
  const real = await vi.importActual<typeof import('../services/fiscal-revertido.js')>('../services/fiscal-revertido.js');
  return {
    ...real,
    fiscalRevertidoHabilitado: (...a: unknown[]) => spies.habilitado(...a),
    ledgerFiscalVigente: (...a: unknown[]) => spies.vigente(...a),
    marcarLedgerRevertido: (...a: unknown[]) => spies.marcar(...a),
    nfComFiscalRevertido: (...a: unknown[]) => spies.sinal(...a),
  };
});

import {
  processarRecebimentoNacionalPorNf,
  VerificacaoEstoqueOmieError,
} from '../services/recebimento-nacional.service.js';
import { EstoqueJaLancadoPeloOmieError } from '../services/fila-nacional.service.js';
import { RecebimentoFiscalRevertidoError, type LedgerFiscalVigente } from '../services/fiscal-revertido.js';
import { converterItemNfParaKg } from '../services/unidade-nf.js';
import type { DetalheNfNacional, DetalheNfNacionalInterno, ItemNfNacional } from '../services/fila-nacional.service.js';

const CHAVE = '31261061827663002031550010000192521253216947';
const LOC_A = '11111111-1111-4111-8111-111111111111';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FORNECEDOR = 'ZARAPLAST S/A';
const DESC = 'PP NATURAL REPROCESSADO';
const ID_LEDGER = 'ledger-19252';
const N_ID_RECEB_LEDGER = 8518467850;
const N_ID_RECEB_DETALHE = 8518467851;

function item(o: Partial<ItemNfNacional> = {}): ItemNfNacional {
  const conv = converterItemNfParaKg(13750, 'KG', 145750.05);
  return {
    indice: 0, descricaoFornecedor: DESC, descricaoNormalizada: DESC, cfop: '1.101', quantidadeNf: 13750, unidadeOriginal: 'KG',
    quantidadeNfKg: 13750, valorUnitarioBrl: 10.6, valorTotalItemBrl: 145750.05, rsPorKg: 10.6, linhasAgregadas: 1, produtosSugeridos: [],
    bloqueio: 'sem_correlacao', bloqueioMensagem: null, jaRecebido: false, quantidadeNfJaAtribuidaKg: 0, quantidadeConferidaJaGravadaKg: 0,
    quantidadeRestanteKg: 13750, baixadoComoExterno: false, baixaSolicitada: false, conversao: conv, sequenciasRecebimento: [1], pc: null,
    ...o,
  };
}

function detalhe(over: Partial<DetalheNfNacional> = {}): DetalheNfNacional {
  return {
    nfChaveAcesso: CHAVE, notaFiscal: '19252', fornecedorNome: FORNECEDOR, fornecedorCnpj: '61.827.663/0020-31',
    dtEmissao: '2026-10-24', diasDesdeEmissao: 1, cfop: '1.101', valorTotalBrl: 145750.05, valorNotaBrl: 145750.05, itens: [item()],
    linhasForaDoRecorte: 0, fiscal: 'concluido', fiscalRevertido: false, fiscalRevertidoEm: null, nIdReceb: N_ID_RECEB_DETALHE, dispensavel: true,
    empresa: 'q2p', exigePc: true, estoqueLancadoPeloOmie: false, copiaPcsDefasada: false, itensSemAvaliacaoPc: [],
    pcsDaNf: { pcs: [], preSelecionado: null },
    ...over,
  };
}

/** Ledger do fiscal concluido pelo Atlas; `ha(ms)` = quanto tempo atras a conclusao aconteceu. */
const ha = (ms: number): string => new Date(Date.now() - ms).toISOString();
const MIN = 60 * 1000;
function vigente(over: Partial<LedgerFiscalVigente> = {}): LedgerFiscalVigente {
  return {
    id: ID_LEDGER, status: 'concluido', empresa: 'q2p', nIdReceb: N_ID_RECEB_LEDGER, notaFiscal: '19252', fornecedorNome: FORNECEDOR,
    finalizadoEm: ha(20 * MIN), ...over,
  };
}

/** O que a ConsultarRecebimento devolve (so os campos que o clique le). */
const recebimentoOmie = (o: { cRecebido?: 'S' | 'N'; cCancelada?: 'S' | 'N'; cNaoGerarMovEstoque?: 'S' | 'N'; cIgnorarItem?: 'S' | 'N' } = {}) => ({
  cRecebido: o.cRecebido ?? 'S',
  cCancelada: o.cCancelada ?? 'N',
  itens: [{ nSequencia: 1, cIgnorarItem: o.cIgnorarItem ?? 'N', cNaoGerarMovEstoque: o.cNaoGerarMovEstoque ?? 'S' }],
});

let det: DetalheNfNacional;
let interno: DetalheNfNacionalInterno;
/** `espelhoConfirmaConclusao`: o ledger sozinho confirma a conclusao (regra da D7 com o ledger vigente). */
const usar = (espelhoConfirmaConclusao: boolean) => {
  interno = { fornecedorCodigo: 1111, espelhoConfirmaConclusao, pcPorIndice: new Map() };
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

const post = () => ({
  nfChaveAcesso: CHAVE,
  userId: USER,
  itens: [{ indice: 0, descricaoFornecedor: DESC, produtos: [{ produtoCodigoQ2p: 3033097757, quantidadeKg: 13750, localidadeId: LOC_A }] }],
});

const gravacoes = () => inserts.filter((i) => i.table === 'movimentacao' || i.table === 'aprovacao');
const erroDe = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('a chamada deveria ter lançado');
};

beforeEach(() => {
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation((sql: string, params?: unknown[]) => Promise.resolve(poolPadrao(sql, params)));
  inserts.length = 0;
  config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = true;
  det = detalhe();
  usar(true);
  spies.detalhe.mockReset();
  spies.detalhe.mockImplementation(async () => ({ detalhe: det, interno }));
  spies.fiscal.mockReset();
  spies.fiscal.mockResolvedValue({ status: 'concluido', concluidoEm: '2026-10-25T20:30:00.000Z', ledgerId: 'ledger-novo', itensTotal: 1, vinculos: [], semVinculo: [] });
  spies.consultarRecebimento.mockReset();
  spies.consultarRecebimento.mockResolvedValue(recebimentoOmie());
  spies.habilitado.mockReset().mockResolvedValue(true);
  spies.vigente.mockReset().mockResolvedValue(vigente());
  spies.marcar.mockReset().mockResolvedValue([{ id: ID_LEDGER, nfChaveAcesso: CHAVE, notaFiscal: '19252' }]);
  spies.sinal.mockReset().mockResolvedValue(false);
  spies.loggerWarn.mockReset();
  spies.loggerInfo.mockReset();
  spies.loggerError.mockReset();
});

describe('D21 — fiscal "ja feito" pelo Atlas: a leitura ao vivo confere a reversao no portal', () => {
  it('recebimento desfeito no portal (cRecebido N): 409 RECEBIMENTO_FISCAL_REVERTIDO, ledger marcado ANTES (origem omie_ao_vivo, a linha lida, quem clicou) e nada gravado', async () => {
    spies.consultarRecebimento.mockResolvedValue(recebimentoOmie({ cRecebido: 'N' }));
    const ordem: string[] = [];
    spies.marcar.mockImplementation(async () => {
      ordem.push('marcou');
      return [{ id: ID_LEDGER, nfChaveAcesso: CHAVE, notaFiscal: '19252' }];
    });

    const err = await erroDe(processarRecebimentoNacionalPorNf(post()).finally(() => ordem.push('rejeitou')));

    expect(err).toBeInstanceOf(RecebimentoFiscalRevertidoError);
    expect(ordem).toEqual(['marcou', 'rejeitou']);
    expect(spies.marcar).toHaveBeenCalledTimes(1);
    expect(spies.marcar).toHaveBeenCalledWith({ nfChaveAcesso: CHAVE, empresa: 'q2p', origem: 'omie_ao_vivo', ledgerId: ID_LEDGER, userId: USER });
    expect(gravacoes()).toHaveLength(0);
    expect(spies.fiscal).not.toHaveBeenCalled();
  });

  it('a mensagem do 409 cita a NF e o fornecedor, diz que a nota voltou para fiscal pendente e nao tem codigo OMIE', async () => {
    spies.consultarRecebimento.mockResolvedValue(recebimentoOmie({ cRecebido: 'N' }));
    const err = await erroDe(processarRecebimentoNacionalPorNf(post()));
    expect(err.message).toContain('NF 19252');
    expect(err.message).toContain(FORNECEDOR);
    expect(err.message).toMatch(/desfeito no OMIE/);
    // sem "recarregue": a tela recarrega a nota sozinha ao receber este 409
    expect(err.message).toMatch(/voltou para fiscal pendente/);
    expect(err.message).not.toMatch(/[Rr]ecarregue/);
    expect(err.message).not.toMatch(/\d{10}/);
  });

  it('a marcacao devolve 0 linhas (varredura do cron ou outro clique marcou antes): o 409 sai igual', async () => {
    spies.consultarRecebimento.mockResolvedValue(recebimentoOmie({ cRecebido: 'N' }));
    spies.marcar.mockResolvedValue([]);
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(RecebimentoFiscalRevertidoError);
    expect(gravacoes()).toHaveLength(0);
  });

  it('erro de banco ao marcar sobe como esta (nada de 409 enganoso, nada gravado): seguir faria so o fisico, o bug original', async () => {
    spies.consultarRecebimento.mockResolvedValue(recebimentoOmie({ cRecebido: 'N' }));
    spies.marcar.mockRejectedValue(new Error('connection terminated'));
    const err = await erroDe(processarRecebimentoNacionalPorNf(post()));
    expect(err).not.toBeInstanceOf(RecebimentoFiscalRevertidoError);
    expect(err.message).toBe('connection terminated');
    expect(gravacoes()).toHaveLength(0);
    expect(spies.fiscal).not.toHaveBeenCalled();
  });

  it('recebimento cancelado no OMIE (cRecebido N, cCancelada S) nao e reversao do fiscal: nao marca, e o fluxo segue como hoje', async () => {
    spies.consultarRecebimento.mockResolvedValue(recebimentoOmie({ cRecebido: 'N', cCancelada: 'S' }));
    const r = await processarRecebimentoNacionalPorNf(post());
    expect(spies.marcar).not.toHaveBeenCalled();
    expect(r.fiscal.status).toBe('nao_aplicavel');
    expect(gravacoes().length).toBeGreaterThan(0);
  });

  it('OMIE confirma cRecebido S sem estoque lancado: nada a fazer, o fisico segue (fiscal nao_aplicavel) e a marcacao nao e chamada', async () => {
    const r = await processarRecebimentoNacionalPorNf(post());
    expect(spies.marcar).not.toHaveBeenCalled();
    expect(spies.fiscal).not.toHaveBeenCalled();
    expect(r.fiscal.status).toBe('nao_aplicavel');
    expect(gravacoes().length).toBeGreaterThan(0);
  });

  it('OMIE confirma cRecebido S COM estoque lancado (concluido no portal sem "nao movimentar estoque"): 409 ESTOQUE_JA_LANCADO da D7, sem marcar', async () => {
    spies.consultarRecebimento.mockResolvedValue(recebimentoOmie({ cRecebido: 'S', cNaoGerarMovEstoque: 'N' }));
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(EstoqueJaLancadoPeloOmieError);
    expect(spies.marcar).not.toHaveBeenCalled();
    expect(gravacoes()).toHaveLength(0);
  });

  it('item ignorado no recebimento concluido (cRecebido S): nao e estoque lancado — segue', async () => {
    spies.consultarRecebimento.mockResolvedValue(recebimentoOmie({ cRecebido: 'S', cIgnorarItem: 'S', cNaoGerarMovEstoque: 'N' }));
    await processarRecebimentoNacionalPorNf(post());
    expect(gravacoes().length).toBeGreaterThan(0);
  });
});

describe('D21 — uma unica leitura, com o corpo certo', () => {
  it('le por nIdReceb DO LEDGER na empresa da NF (o fiscal usa cChaveNfe: corpo diferente, cache separado no OMIE), sem retry', async () => {
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.consultarRecebimento).toHaveBeenCalledTimes(1);
    // so a conferencia da reversao: sem retry (com ele a trava de consumo redundante seguraria o clique por ate ~2 min)
    expect(spies.consultarRecebimento).toHaveBeenCalledWith('q2p', { nIdReceb: N_ID_RECEB_LEDGER }, { retries: 0 });
  });

  it('ledger sem nIdReceb: usa o do detalhe; sem nenhum dos dois, a chave de acesso', async () => {
    spies.vigente.mockResolvedValue(vigente({ nIdReceb: null }));
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.consultarRecebimento).toHaveBeenLastCalledWith('q2p', { nIdReceb: N_ID_RECEB_DETALHE }, { retries: 0 });

    inserts.length = 0;
    det = detalhe({ nIdReceb: null });
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.consultarRecebimento).toHaveBeenLastCalledWith('q2p', { cChaveNfe: CHAVE }, { retries: 0 });
  });

  it('a MESMA leitura serve a D7 e a reversao quando o espelho nao confirma a conclusao: uma chamada so, por nIdReceb, com os retries de sempre', async () => {
    usar(false);
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.consultarRecebimento).toHaveBeenCalledTimes(1);
    // a D7 exige a leitura (fail-closed): mantem o retry padrao do cliente
    expect(spies.consultarRecebimento).toHaveBeenCalledWith('q2p', { nIdReceb: N_ID_RECEB_LEDGER });

    // ... e na mesma leitura, a reversao tambem e percebida
    spies.consultarRecebimento.mockClear();
    spies.consultarRecebimento.mockResolvedValue(recebimentoOmie({ cRecebido: 'N' }));
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(RecebimentoFiscalRevertidoError);
    expect(spies.consultarRecebimento).toHaveBeenCalledTimes(1);
  });

  it('NF da ACXE: le o OMIE da ACXE e marca com a empresa da NF', async () => {
    det = detalhe({ empresa: 'acxe' });
    spies.vigente.mockResolvedValue(vigente({ empresa: 'acxe' }));
    spies.consultarRecebimento.mockResolvedValue(recebimentoOmie({ cRecebido: 'N' }));
    const corpoAcxe = { ...post(), itens: [{ indice: 0, descricaoFornecedor: DESC, produtos: [{ produtoCodigoAcxe: 4001, quantidadeKg: 13750, localidadeId: LOC_A }] }] };
    await expect(processarRecebimentoNacionalPorNf(corpoAcxe)).rejects.toBeInstanceOf(RecebimentoFiscalRevertidoError);
    expect(spies.consultarRecebimento).toHaveBeenCalledWith('acxe', { nIdReceb: N_ID_RECEB_LEDGER }, { retries: 0 });
    expect(spies.marcar).toHaveBeenCalledWith(expect.objectContaining({ empresa: 'acxe', origem: 'omie_ao_vivo', ledgerId: ID_LEDGER }));
  });
});

describe('D21 — quando NAO le (comportamento de antes, exatamente)', () => {
  it('conclusao ha menos de 75 s: a ConsultarRecebimento ainda pode devolver o cache de antes do Concluir — sem leitura, sem marcacao', async () => {
    spies.vigente.mockResolvedValue(vigente({ finalizadoEm: ha(20 * 1000) }));
    spies.consultarRecebimento.mockResolvedValue(recebimentoOmie({ cRecebido: 'N' })); // se fosse lida, "revertia"
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.consultarRecebimento).not.toHaveBeenCalled();
    expect(spies.marcar).not.toHaveBeenCalled();
    expect(gravacoes().length).toBeGreaterThan(0);
  });

  it('exatamente na borda: 74 s nao le; 76 s le', async () => {
    spies.vigente.mockResolvedValue(vigente({ finalizadoEm: ha(74 * 1000) }));
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.consultarRecebimento).not.toHaveBeenCalled();
    spies.vigente.mockResolvedValue(vigente({ finalizadoEm: ha(76 * 1000) }));
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.consultarRecebimento).toHaveBeenCalledTimes(1);
  });

  it('conclusao recente MAS a D7 exige a leitura (espelho nao confirma): le por chave, como hoje, e cRecebido N nao marca nem lanca', async () => {
    usar(false);
    spies.vigente.mockResolvedValue(vigente({ finalizadoEm: ha(20 * 1000) }));
    spies.consultarRecebimento.mockResolvedValue(recebimentoOmie({ cRecebido: 'N' }));
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.consultarRecebimento).toHaveBeenCalledTimes(1);
    expect(spies.consultarRecebimento).toHaveBeenCalledWith('q2p', { cChaveNfe: CHAVE });
    expect(spies.marcar).not.toHaveBeenCalled();
  });

  it('D21 indisponivel (chave da 016, kill switch ou migration 0060): nem consulta o ledger; ledger confirmando a conclusao = sem leitura (Principio II)', async () => {
    spies.habilitado.mockResolvedValue(false);
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.vigente).not.toHaveBeenCalled();
    expect(spies.consultarRecebimento).not.toHaveBeenCalled();
    expect(spies.marcar).not.toHaveBeenCalled();
    expect(gravacoes().length).toBeGreaterThan(0);
  });

  it('D21 indisponivel e a D7 exigindo a leitura: le por chave e so confere estoque lancado, como na 017 (cRecebido N nao faz nada)', async () => {
    spies.habilitado.mockResolvedValue(false);
    usar(false);
    spies.consultarRecebimento.mockResolvedValue(recebimentoOmie({ cRecebido: 'N' }));
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.consultarRecebimento).toHaveBeenCalledWith('q2p', { cChaveNfe: CHAVE });
    expect(spies.marcar).not.toHaveBeenCalled();

    spies.consultarRecebimento.mockResolvedValue(recebimentoOmie({ cRecebido: 'S', cNaoGerarMovEstoque: 'N' }));
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(EstoqueJaLancadoPeloOmieError);
  });

  it('sem fiscal concluido pelo Atlas (sem ledger vigente) e espelho confirmando: nenhuma leitura ao vivo', async () => {
    spies.vigente.mockResolvedValue(null);
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.vigente).toHaveBeenCalledWith(CHAVE);
    expect(spies.consultarRecebimento).not.toHaveBeenCalled();
    expect(spies.marcar).not.toHaveBeenCalled();
  });

  it('sem ledger vigente e o espelho NAO confirmando (fiscal feito no portal, fora do espelho): leitura da D7 por chave; cRecebido N nao e tratado como reversao', async () => {
    spies.vigente.mockResolvedValue(null);
    usar(false);
    spies.consultarRecebimento.mockResolvedValue(recebimentoOmie({ cRecebido: 'N' }));
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.consultarRecebimento).toHaveBeenCalledTimes(1);
    expect(spies.consultarRecebimento).toHaveBeenCalledWith('q2p', { cChaveNfe: CHAVE });
    expect(spies.marcar).not.toHaveBeenCalled();
    expect(gravacoes().length).toBeGreaterThan(0);
  });

  it('NF com fiscal pendente (a revertida que a fila ja reconheceu): nada de leitura da D7 nem da D21 — segue para o fiscal', async () => {
    det = detalhe({ fiscal: 'pendente', fiscalRevertido: true, fiscalRevertidoEm: ha(10 * MIN) });
    interno = { fornecedorCodigo: 1111, espelhoConfirmaConclusao: false, pcPorIndice: new Map() };
    const r = await processarRecebimentoNacionalPorNf(post());
    expect(spies.vigente).not.toHaveBeenCalled();
    expect(spies.consultarRecebimento).not.toHaveBeenCalled();
    expect(spies.marcar).not.toHaveBeenCalled();
    expect(r.fiscal.status).toBe('concluido');
    expect(spies.fiscal).toHaveBeenCalledTimes(1);
  });
});

describe('D21 — falha da leitura ao vivo', () => {
  it('ledger confirma a conclusao (a D7 nao exigia a leitura): fail-open — segue com aviso no log; a varredura do cron cobre depois', async () => {
    spies.consultarRecebimento.mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    const r = await processarRecebimentoNacionalPorNf(post());
    expect(r.fiscal.status).toBe('nao_aplicavel');
    expect(gravacoes().length).toBeGreaterThan(0);
    expect(spies.marcar).not.toHaveBeenCalled();
    expect(spies.loggerWarn).toHaveBeenCalledWith(expect.objectContaining({ nf: '19252' }), expect.stringContaining('reversão do fiscal no OMIE não foi conferida'));
  });

  it('a D7 exigia a leitura (espelho nao confirma): fail-closed — VerificacaoEstoqueOmieError, nada gravado (como hoje)', async () => {
    usar(false);
    spies.consultarRecebimento.mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    const err = await erroDe(processarRecebimentoNacionalPorNf(post()));
    expect(err).toBeInstanceOf(VerificacaoEstoqueOmieError);
    expect(err.message).toContain('NF 19252');
    expect(gravacoes()).toHaveLength(0);
    expect(spies.marcar).not.toHaveBeenCalled();
  });

  it('recebimento inexistente no OMIE ("nao encontrado"): nada lancado por ele e nada a reverter — segue, sem marcar', async () => {
    spies.consultarRecebimento.mockRejectedValue(new Error('SOAP-ENV:Client-5001: Recebimento não encontrado para o id informado'));
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.marcar).not.toHaveBeenCalled();
    expect(gravacoes().length).toBeGreaterThan(0);
  });

  it('ledger ilegivel (banco): a conferencia extra nunca derruba o clique — segue como antes, com aviso no log', async () => {
    spies.vigente.mockRejectedValue(new Error('connection terminated'));
    const r = await processarRecebimentoNacionalPorNf(post());
    expect(spies.consultarRecebimento).not.toHaveBeenCalled();
    expect(r.fiscal.status).toBe('nao_aplicavel');
    expect(spies.loggerWarn).toHaveBeenCalledWith(expect.objectContaining({ nf: '19252' }), expect.stringContaining('Ledger do fiscal ilegível'));

    // e se a D7 exigia a leitura, ela continua valendo (por chave, sem ledger)
    usar(false);
    spies.consultarRecebimento.mockRejectedValue(new Error('timeout'));
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(VerificacaoEstoqueOmieError);
  });
});

describe('D21 — ordem: a conferencia vem antes de qualquer escrita', () => {
  it('estoqueLancadoPeloOmie do espelho continua primeiro (409 sem ler o ledger nem o OMIE)', async () => {
    det = detalhe({ estoqueLancadoPeloOmie: true });
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(EstoqueJaLancadoPeloOmieError);
    expect(spies.vigente).not.toHaveBeenCalled();
    expect(spies.consultarRecebimento).not.toHaveBeenCalled();
  });

  it('a reversao percebida no clique nao toca o fiscal nem grava movimentacao/aprovacao, e nao avisa ninguem', async () => {
    spies.consultarRecebimento.mockResolvedValue(recebimentoOmie({ cRecebido: 'N' }));
    await expect(processarRecebimentoNacionalPorNf(post())).rejects.toBeInstanceOf(RecebimentoFiscalRevertidoError);
    expect(gravacoes()).toHaveLength(0);
    expect(spies.fiscal).not.toHaveBeenCalled();
    expect(poolQuerySpy.mock.calls.some((c) => String(c[0]).includes('nf_dispensa'))).toBe(false); // nem chegou na conferencia da dispensa
  });

  it('chave da 016 desligada: nenhuma D21 (fiscalRevertidoHabilitado e false por construcao) — o fluxo da 015 intacto', async () => {
    config.STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED = false;
    spies.habilitado.mockResolvedValue(false); // o real devolve false sem a chave da 016
    det = detalhe({ fiscal: 'concluido' });
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.vigente).not.toHaveBeenCalled();
    expect(spies.consultarRecebimento).not.toHaveBeenCalled();
    expect(gravacoes().length).toBeGreaterThan(0);
  });
});

describe('D21 — reversao marcada por OUTRA requisicao entre o retrato do detalhe e o clique (revisao)', () => {
  it('sem ledger vigente (outro clique, a abertura do detalhe ou a varredura ja marcou) e o sinal ligado: o mesmo 409, sem marcar de novo, sem ler o OMIE e sem gravar', async () => {
    spies.vigente.mockResolvedValue(null);
    spies.sinal.mockResolvedValue(true);
    const err = await erroDe(processarRecebimentoNacionalPorNf(post()));
    expect(err).toBeInstanceOf(RecebimentoFiscalRevertidoError);
    expect(spies.sinal).toHaveBeenCalledWith(CHAVE, 'q2p');
    expect(spies.marcar).not.toHaveBeenCalled();
    expect(spies.consultarRecebimento).not.toHaveBeenCalled();
    expect(gravacoes()).toHaveLength(0);
  });

  it('sem ledger vigente e o sinal desligado (fiscal concluido no portal, nada revertido): segue como antes', async () => {
    spies.vigente.mockResolvedValue(null);
    spies.sinal.mockResolvedValue(false);
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.sinal).toHaveBeenCalledTimes(1);
    expect(spies.consultarRecebimento).not.toHaveBeenCalled();
    expect(gravacoes().length).toBeGreaterThan(0);
  });

  it('D21 indisponivel: nem avalia o sinal', async () => {
    spies.habilitado.mockResolvedValue(false);
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.sinal).not.toHaveBeenCalled();
  });

  it('com ledger vigente o sinal nao e avaliado aqui: quem decide e a leitura ao vivo', async () => {
    await processarRecebimentoNacionalPorNf(post());
    expect(spies.sinal).not.toHaveBeenCalled();
    expect(spies.consultarRecebimento).toHaveBeenCalledTimes(1);
  });
});

