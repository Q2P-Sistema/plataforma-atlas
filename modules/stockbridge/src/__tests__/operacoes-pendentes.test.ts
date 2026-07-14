import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getDb: vi.fn(),
  getConfig: () => ({ SEED_ADMIN_EMAIL: 'admin@atlas.local' }),
  sendEmail: vi.fn(),
  buildEmailLayout: (o: { titulo?: string }) => ({ html: String(o?.titulo ?? ''), text: String(o?.titulo ?? '') }),
  emailDataList: () => '',
  emailActionBox: (html: string) => html,
  escapeHtml: (v: unknown) => (v == null ? '' : String(v)),
  getPool: () => ({ query: vi.fn() }),
}));

vi.mock('@atlas/db', () => ({
  movimentacao: { __id: 'movimentacao' },
  lote: { __id: 'lote' },
  localidadeCorrelacao: { __id: 'localidadeCorrelacao' },
  aprovacao: { __id: 'aprovacao' },
}));

vi.mock('@atlas/integration-omie', () => ({
  incluirAjusteEstoque: vi.fn(),
  listarAjusteEstoque: vi.fn(),
}));

// STK-03: o retry de saida manual resolve correlacoes via omie-saida.service
// (db.execute real) e o fallback de preco via aprovacao.service — mockados aqui
// pra manter o teste no nivel do dispatch/contrato OMIE.
vi.mock('../services/omie-saida.service.js', () => ({
  resolverCorrelacaoCompletaGalpao: vi.fn(),
  resolverCodigosLocaisTroca: vi.fn(),
  resolverCodigoProdutoOmie: vi.fn(),
}));
vi.mock('../services/aprovacao.service.js', () => ({
  consultarValorUnitarioProduto: vi.fn(),
}));

import {
  marcarComoFalhaDefinitiva,
  retentarOperacaoPendente,
  OperadorSemRetentativasError,
  OperacaoPendenteNaoEncontradaError,
  OperacaoNaoPendenteError,
} from '../services/operacoes-pendentes.service.js';

interface ChainMock {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

function chainComMov(
  mov: Record<string, unknown> | null,
  opts: {
    /**
     * Linhas devolvidas por selects em `aprovacao` — o guard de aprovacao do
     * retry de saida manual (STK-03). Default: uma aprovacao 'aprovada' existe.
     */
    aprovacaoRows?: unknown[];
    /**
     * Linhas devolvidas quando um select em movimentacao e aguardado SEM
     * .limit() — a busca do PAR baixa/entrada do retorno de comodato (STK-03b).
     */
    movsSemLimit?: unknown[];
  } = {},
): ChainMock {
  // db.select().from().where().limit(1) -> [mov?] (ou aprovacaoRows p/ tabela aprovacao)
  // db.select().from().where() aguardado direto -> movsSemLimit (busca do par, STK-03b)
  // db.update().set().where() -> Promise<void>
  // where() retorna chain (encadeavel) na select-chain; quando vier de set(), deve retornar promise.
  // Solucao: where retorna THIS, mas limit retorna a lista. set retorna um sub-chain com where=Promise.
  const limitResolved = mov ? [mov] : [];
  const aprovacaoRows = opts.aprovacaoRows ?? [{ id: 'apr-aprovada' }];
  let currentRows: unknown[] = limitResolved;
  const setSpy = vi.fn();
  const chain: ChainMock & { then?: unknown } = {
    select: vi.fn().mockReturnThis() as never,
    from: vi.fn((table: { __id?: string }) => {
      currentRows = table?.__id === 'aprovacao' ? aprovacaoRows : limitResolved;
      return chain;
    }) as never,
    where: vi.fn().mockReturnThis() as never,
    limit: vi.fn(() => Promise.resolve(currentRows)) as never,
    update: vi.fn().mockReturnThis() as never,
    set: setSpy as never,
  };
  // Thenable: permite `await db.select().from().where()` sem .limit() (par do retorno).
  chain.then = (resolve: (rows: unknown[]) => void) => resolve(opts.movsSemLimit ?? currentRows);
  setSpy.mockReturnValue({ where: vi.fn(() => Promise.resolve(undefined)) });
  return chain;
}

describe('marcarComoFalhaDefinitiva (US3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('atualiza status_omie=falha e registra motivo no ultimo_erro_omie', async () => {
    const { getDb } = await import('@atlas/core');
    const chain = chainComMov({
      id: 'mov-1',
      statusOmie: 'pendente_q2p',
      tentativasQ2p: 2,
    });
    vi.mocked(getDb).mockReturnValue(chain as never);

    const res = await marcarComoFalhaDefinitiva({
      movimentacaoId: 'mov-1',
      motivo: 'OMIE bloqueado, produto suspenso',
      ator: { userId: 'u1', role: 'gestor' },
    });

    expect(res).toEqual({ id: 'mov-1' });
    // set() recebeu statusOmie=falha + ultimoErroOmie estruturado
    const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    expect(setCalls[0]?.[0]).toMatchObject({
      statusOmie: 'falha',
      ultimoErroOmie: expect.objectContaining({
        lado: 'manual',
        mensagem: expect.stringContaining('OMIE bloqueado'),
      }),
    });
  });

  it('rejeita operador (apenas gestor/diretor)', async () => {
    await expect(
      marcarComoFalhaDefinitiva({
        movimentacaoId: 'mov-1',
        motivo: 'tentativa do operador',
        ator: { userId: 'op1', role: 'operador' },
      }),
    ).rejects.toBeInstanceOf(OperadorSemRetentativasError);
  });

  it('rejeita motivo vazio', async () => {
    await expect(
      marcarComoFalhaDefinitiva({
        movimentacaoId: 'mov-1',
        motivo: '   ',
        ator: { userId: 'u1', role: 'gestor' },
      }),
    ).rejects.toThrow(/Motivo obrigat[óo]rio/);
  });

  it('lanca OperacaoPendenteNaoEncontradaError quando movimentacao nao existe', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(chainComMov(null) as never);

    await expect(
      marcarComoFalhaDefinitiva({
        movimentacaoId: 'naoexiste',
        motivo: 'teste',
        ator: { userId: 'u1', role: 'diretor' },
      }),
    ).rejects.toBeInstanceOf(OperacaoPendenteNaoEncontradaError);
  });

  it('lanca OperacaoNaoPendenteError quando ja esta concluida', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(
      chainComMov({ id: 'mov-1', statusOmie: 'concluida' }) as never,
    );

    await expect(
      marcarComoFalhaDefinitiva({
        movimentacaoId: 'mov-1',
        motivo: 'teste',
        ator: { userId: 'u1', role: 'gestor' },
      }),
    ).rejects.toBeInstanceOf(OperacaoNaoPendenteError);
  });

  it('lanca OperacaoNaoPendenteError quando ja foi marcada como falha antes', async () => {
    const { getDb } = await import('@atlas/core');
    vi.mocked(getDb).mockReturnValue(
      chainComMov({ id: 'mov-1', statusOmie: 'falha' }) as never,
    );

    await expect(
      marcarComoFalhaDefinitiva({
        movimentacaoId: 'mov-1',
        motivo: 'teste',
        ator: { userId: 'u1', role: 'gestor' },
      }),
    ).rejects.toBeInstanceOf(OperacaoNaoPendenteError);
  });
});

// STK-03 (ACXEGDP-283): retry Q2P para movimentacoes de saida manual (sem lote).
// Antes, retentarQ2p lancava incondicionalmente com loteId=null — a pendencia era
// irrecuperavel (ACXE debitado, Q2P nao). O dispatch reconstroi a chamada original
// por subtipo e usa verificarAntes=true (nada duplica se o OMIE ja persistiu).
describe('retentarOperacaoPendente — saida manual sem lote (STK-03)', () => {
  const movBase = {
    id: 'mov-sm-1',
    opId: 'op-sm-1',
    loteId: null,
    notaFiscal: 'SM-1',
    quantidadeKg: '-500',
    statusOmie: 'pendente_q2p',
    tentativasQ2p: 1,
    tentativasAcxeFaltando: 0,
    idMovestAcxe: 'M-ACXE',
    idAjusteAcxe: 'A-ACXE',
    subtipo: 'amostra',
    produtoCodigoAcxe: 1001,
    galpao: '11.1',
    galpaoDestino: null,
    custoUnitarioBrl: '2.50',
  };

  async function prepararMocks(mov: Record<string, unknown>) {
    const { getDb } = await import('@atlas/core');
    const omieSaida = await import('../services/omie-saida.service.js');
    const omie = await import('@atlas/integration-omie');
    const chain = chainComMov(mov);
    vi.mocked(getDb).mockReturnValue(chain as never);
    vi.mocked(omieSaida.resolverCorrelacaoCompletaGalpao).mockResolvedValue({ acxe: '111', q2p: '222' });
    vi.mocked(omieSaida.resolverCodigosLocaisTroca).mockResolvedValue({ acxe: '900', q2p: '901' });
    vi.mocked(omieSaida.resolverCodigoProdutoOmie).mockResolvedValue(2001);
    // Default: OMIE ainda nao tem o ajuste (listar vazio) e o incluir sucede.
    vi.mocked(omie.listarAjusteEstoque).mockResolvedValue({
      pagina: 1, totalDePaginas: 1, registros: 0, totalDeRegistros: 0, ajustes: [],
    } as never);
    vi.mocked(omie.incluirAjusteEstoque).mockResolvedValue({
      idMovest: 'M-Q2P-RETRY', idAjuste: 'A-Q2P-RETRY', descricaoStatus: 'ok',
    } as never);
    return { chain, omie, omieSaida };
  }

  beforeEach(() => vi.clearAllMocks());

  it('amostra: reconstroi SAI/PER com cod_int_ajuste identico ao da chamada original', async () => {
    const { chain, omie } = await prepararMocks({ ...movBase });

    const res = await retentarOperacaoPendente({
      movimentacaoId: 'mov-sm-1',
      ator: { userId: 'gestor-1', role: 'gestor' },
    });

    // verificarAntes=true: listar ANTES de incluir, pelo mesmo cod_int
    expect(omie.listarAjusteEstoque).toHaveBeenCalledWith('q2p', expect.objectContaining({
      codIntAjuste: 'op-sm-1:saida-per-q2p',
    }));
    expect(omie.incluirAjusteEstoque).toHaveBeenCalledWith('q2p', expect.objectContaining({
      codIntAjuste: 'op-sm-1:saida-per-q2p',
      codigoLocalEstoque: '222',
      idProduto: 2001,
      tipo: 'SAI',
      motivo: 'PER',
      quantidade: 500, // abs(-500)
      valor: 2.5, // custo_unitario_brl persistido na aprovacao — NAO preco vivo
    }));
    expect(res.statusOmie).toBe('concluida');

    const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    expect(setCalls.at(-1)?.[0]).toMatchObject({
      idMovestQ2p: 'M-Q2P-RETRY',
      idAjusteQ2p: 'A-Q2P-RETRY',
      mvQ2p: -1,
      idUserQ2p: 'gestor-1',
      statusOmie: 'concluida',
      ultimoErroOmie: null,
    });
  });

  it('ja existia no OMIE (falha so na resposta anterior): nao inclui de novo', async () => {
    const { omie } = await prepararMocks({ ...movBase });
    vi.mocked(omie.listarAjusteEstoque).mockResolvedValue({
      pagina: 1, totalDePaginas: 1, registros: 1, totalDeRegistros: 1,
      ajustes: [{
        idMovest: 'M-JA-EXISTIA', idAjuste: 'A-JA-EXISTIA',
        codIntAjuste: 'op-sm-1:saida-per-q2p',
        dataMovimento: '14/07/2026', codigoLocalEstoque: '222',
        idProduto: 2001, quantidade: 500, valor: 2.5, observacao: '',
      }],
    } as never);

    const res = await retentarOperacaoPendente({
      movimentacaoId: 'mov-sm-1',
      ator: { userId: 'gestor-1', role: 'gestor' },
    });

    expect(omie.incluirAjusteEstoque).not.toHaveBeenCalled();
    expect(res.jaExistiaNoOmie).toBe(true);
    expect(res.statusOmie).toBe('concluida');
  });

  it('inventario_menos: SAI/INV com sufixo saida-inv-q2p', async () => {
    const { omie } = await prepararMocks({ ...movBase, subtipo: 'inventario_menos' });

    await retentarOperacaoPendente({ movimentacaoId: 'mov-sm-1', ator: { userId: 'g', role: 'gestor' } });

    expect(omie.incluirAjusteEstoque).toHaveBeenCalledWith('q2p', expect.objectContaining({
      codIntAjuste: 'op-sm-1:saida-inv-q2p',
      tipo: 'SAI',
      motivo: 'INV',
    }));
  });

  it('transf_intra_cnpj: TRF com destino resolvido do galpao_destino persistido', async () => {
    const { omie, omieSaida } = await prepararMocks({
      ...movBase, subtipo: 'transf_intra_cnpj', galpaoDestino: '21.1',
    });
    vi.mocked(omieSaida.resolverCorrelacaoCompletaGalpao)
      .mockResolvedValueOnce({ acxe: '111', q2p: '222' }) // origem
      .mockResolvedValueOnce({ acxe: '333', q2p: '444' }); // destino

    await retentarOperacaoPendente({ movimentacaoId: 'mov-sm-1', ator: { userId: 'g', role: 'gestor' } });

    expect(omie.incluirAjusteEstoque).toHaveBeenCalledWith('q2p', expect.objectContaining({
      codIntAjuste: 'op-sm-1:trf-intra-q2p',
      tipo: 'TRF',
      motivo: 'TRF',
      codigoLocalEstoque: '222',
      codigoLocalEstoqueDestino: '444',
    }));
  });

  it('comodato: TRF para o TROCA (90.0.1) Q2P', async () => {
    const { omie } = await prepararMocks({ ...movBase, subtipo: 'comodato' });

    await retentarOperacaoPendente({ movimentacaoId: 'mov-sm-1', ator: { userId: 'g', role: 'gestor' } });

    expect(omie.incluirAjusteEstoque).toHaveBeenCalledWith('q2p', expect.objectContaining({
      codIntAjuste: 'op-sm-1:comodato-trf-q2p',
      tipo: 'TRF',
      motivo: 'TRF',
      codigoLocalEstoqueDestino: '901',
    }));
  });

  it('sem custo persistido: cai no preco vivo (fallback documentado) e avisa', async () => {
    const { omie } = await prepararMocks({ ...movBase, custoUnitarioBrl: null });
    const aprov = await import('../services/aprovacao.service.js');
    vi.mocked(aprov.consultarValorUnitarioProduto).mockResolvedValue(3.1);

    await retentarOperacaoPendente({ movimentacaoId: 'mov-sm-1', ator: { userId: 'g', role: 'gestor' } });

    expect(aprov.consultarValorUnitarioProduto).toHaveBeenCalledWith(1001, '11.1', 'q2p');
    expect(omie.incluirAjusteEstoque).toHaveBeenCalledWith('q2p', expect.objectContaining({ valor: 3.1 }));
  });

  it('sem custo persistido E sem saldo vivo: erro claro (OMIE rejeita valor 0)', async () => {
    await prepararMocks({ ...movBase, custoUnitarioBrl: null });
    const aprov = await import('../services/aprovacao.service.js');
    vi.mocked(aprov.consultarValorUnitarioProduto).mockResolvedValue(0);

    await expect(
      retentarOperacaoPendente({ movimentacaoId: 'mov-sm-1', ator: { userId: 'g', role: 'gestor' } }),
    ).rejects.toThrow(/valor unitário/i);
  });

  it('BLOQUEIA retry de saida manual ainda nao aprovada (mov nasce pendente_q2p na submissao)', async () => {
    // Sem este guard, o retry executaria o ajuste OMIE de uma operacao que o
    // gestor nunca aprovou (ou rejeitou) — contornando o fluxo de aprovacao.
    const { getDb } = await import('@atlas/core');
    const omieSaida = await import('../services/omie-saida.service.js');
    const omie = await import('@atlas/integration-omie');
    const chain = chainComMov({ ...movBase }, { aprovacaoRows: [] });
    vi.mocked(getDb).mockReturnValue(chain as never);
    vi.mocked(omieSaida.resolverCorrelacaoCompletaGalpao).mockResolvedValue({ acxe: '111', q2p: '222' });

    await expect(
      retentarOperacaoPendente({ movimentacaoId: 'mov-sm-1', ator: { userId: 'g', role: 'gestor' } }),
    ).rejects.toThrow(/aprova/i);
    expect(omie.incluirAjusteEstoque).not.toHaveBeenCalled();
    expect(omie.listarAjusteEstoque).not.toHaveBeenCalled();
  });

  it('retorno_comodato sem movimentacao_origem_id: erro claro (nao cai no fluxo generico)', async () => {
    // O dispatch do retorno (STK-03b) exige o par baixa/entrada via origem;
    // registro inconsistente falha com mensagem especifica, nao SAI/PER generico.
    await prepararMocks({ ...movBase, subtipo: 'retorno_comodato', movimentacaoOrigemId: null });

    await expect(
      retentarOperacaoPendente({ movimentacaoId: 'mov-sm-1', ator: { userId: 'g', role: 'gestor' } }),
    ).rejects.toThrow(/movimentacao_origem_id/);
  });

  it('falha do OMIE no retry: incrementa tentativas_q2p e registra ultimo erro', async () => {
    const { chain, omie } = await prepararMocks({ ...movBase, tentativasQ2p: 2 });
    vi.mocked(omie.incluirAjusteEstoque).mockRejectedValue(new Error('OMIE Q2P 503'));

    await expect(
      retentarOperacaoPendente({ movimentacaoId: 'mov-sm-1', ator: { userId: 'g', role: 'gestor' } }),
    ).rejects.toThrow('OMIE Q2P 503');

    const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    expect(setCalls.at(-1)?.[0]).toMatchObject({
      tentativasQ2p: 3,
      ultimoErroOmie: expect.objectContaining({
        lado: 'q2p',
        mensagem: expect.stringContaining('OMIE Q2P 503'),
      }),
    });
  });

  it('operador dentro do limite pode retentar saida manual (RBAC preservado)', async () => {
    const { omie } = await prepararMocks({ ...movBase, tentativasQ2p: 1 });

    const res = await retentarOperacaoPendente({
      movimentacaoId: 'mov-sm-1',
      ator: { userId: 'op-1', role: 'operador' },
    });

    expect(res.statusOmie).toBe('concluida');
    expect(omie.incluirAjusteEstoque).toHaveBeenCalledTimes(1);
  });

  it('operador acima do limite segue bloqueado (RBAC preservado)', async () => {
    await prepararMocks({ ...movBase, tentativasQ2p: 2 });

    await expect(
      retentarOperacaoPendente({ movimentacaoId: 'mov-sm-1', ator: { userId: 'op-1', role: 'operador' } }),
    ).rejects.toBeInstanceOf(OperadorSemRetentativasError);
  });
});

// STK-03b (ACXEGDP-283): retry do retorno de comodato — 2 pernas Q2P independentes
// (baixa TROCA + entrada destino) em 2 movimentacoes pareadas por movimentacao_origem_id.
// Os cod_int_ajuste derivam do opId da ENTRADA (mesmo contrato da aprovacao).
describe('retentarOperacaoPendente — retorno de comodato (STK-03b)', () => {
  const entradaRow = {
    id: 'mov-ent',
    opId: 'op-ent',
    loteId: null,
    notaFiscal: 'RET-ENT-X',
    quantidadeKg: '800',
    statusOmie: 'pendente_q2p',
    tentativasQ2p: 0,
    tentativasAcxeFaltando: 0,
    idMovestAcxe: 'ME-A',
    idAjusteAcxe: 'AE-A',
    subtipo: 'retorno_comodato',
    tipoMovimento: 'entrada_manual',
    produtoCodigoAcxe: 2002,
    galpao: '11.1',
    galpaoDestino: null,
    custoUnitarioBrl: '2.50',
    movimentacaoOrigemId: 'mov-orig',
  };
  const baixaRow = {
    ...entradaRow,
    id: 'mov-bx',
    opId: 'op-bx-proprio', // opId da baixa NAO e usado — as pernas usam o da entrada
    notaFiscal: 'RET-BAIXA-X',
    tipoMovimento: 'ajuste',
    produtoCodigoAcxe: 1001,
    galpao: '90',
    quantidadeKg: '-1000',
    custoUnitarioBrl: '2.00',
    idMovestAcxe: 'MB-A',
    idAjusteAcxe: 'AB-A',
  };

  async function prepararRetorno(opts: {
    clicada?: Record<string, unknown>;
    par?: unknown[];
    aprovacaoRows?: unknown[];
  } = {}) {
    const { getDb } = await import('@atlas/core');
    const omieSaida = await import('../services/omie-saida.service.js');
    const omie = await import('@atlas/integration-omie');
    const chain = chainComMov(opts.clicada ?? { ...entradaRow }, {
      movsSemLimit: opts.par ?? [{ ...baixaRow }, { ...entradaRow }],
      aprovacaoRows: opts.aprovacaoRows,
    });
    vi.mocked(getDb).mockReturnValue(chain as never);
    vi.mocked(omieSaida.resolverCorrelacaoCompletaGalpao).mockResolvedValue({ acxe: '111', q2p: '222' });
    vi.mocked(omieSaida.resolverCodigosLocaisTroca).mockResolvedValue({ acxe: '900', q2p: '901' });
    vi.mocked(omieSaida.resolverCodigoProdutoOmie).mockImplementation(
      async (cod: number) => (cod === 1001 ? 3001 : 4002),
    );
    vi.mocked(omie.listarAjusteEstoque).mockResolvedValue({
      pagina: 1, totalDePaginas: 1, registros: 0, totalDeRegistros: 0, ajustes: [],
    } as never);
    vi.mocked(omie.incluirAjusteEstoque).mockResolvedValue({
      idMovest: 'M-Q2P-RET', idAjuste: 'A-Q2P-RET', descricaoStatus: 'ok',
    } as never);
    return { chain, omie };
  }

  beforeEach(() => vi.clearAllMocks());

  it('ambas as pernas pendentes: executa baixa (SAI TROCA) e entrada (ENT destino) com opId da ENTRADA', async () => {
    const { chain, omie } = await prepararRetorno();

    const res = await retentarOperacaoPendente({
      movimentacaoId: 'mov-ent',
      ator: { userId: 'gestor-1', role: 'gestor' },
    });

    expect(res.statusOmie).toBe('concluida');
    expect(omie.incluirAjusteEstoque).toHaveBeenCalledTimes(2);
    expect(omie.incluirAjusteEstoque).toHaveBeenNthCalledWith(1, 'q2p', expect.objectContaining({
      codIntAjuste: 'op-ent:ret-baixa-q2p', // opId da ENTRADA, nao o da baixa
      codigoLocalEstoque: '901', // TROCA Q2P
      idProduto: 3001, // produto ORIGINAL correlacionado
      tipo: 'SAI',
      motivo: 'INV',
      quantidade: 1000,
      valor: 2, // custo persistido da baixa
    }));
    expect(omie.incluirAjusteEstoque).toHaveBeenNthCalledWith(2, 'q2p', expect.objectContaining({
      codIntAjuste: 'op-ent:ret-entrada-q2p',
      codigoLocalEstoque: '222', // destino Q2P
      idProduto: 4002, // produto RECEBIDO correlacionado
      tipo: 'ENT',
      motivo: 'INV',
      quantidade: 800,
      valor: 2.5, // custo persistido da entrada
    }));

    // Ambas as linhas atualizadas: baixa mvQ2p=-1, entrada mvQ2p=+1
    const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    const setBaixa = setCalls.find((c) => c[0]?.mvQ2p === -1);
    const setEntrada = setCalls.find((c) => c[0]?.mvQ2p === 1);
    expect(setBaixa?.[0]).toMatchObject({ statusOmie: 'concluida', idMovestQ2p: 'M-Q2P-RET' });
    expect(setEntrada?.[0]).toMatchObject({ statusOmie: 'concluida', idMovestQ2p: 'M-Q2P-RET' });
  });

  it('baixa ja concluida (falha original foi ENTRE as pernas): so a entrada roda', async () => {
    const { omie } = await prepararRetorno({
      par: [{ ...baixaRow, statusOmie: 'concluida' }, { ...entradaRow }],
    });

    await retentarOperacaoPendente({ movimentacaoId: 'mov-ent', ator: { userId: 'g', role: 'gestor' } });

    expect(omie.incluirAjusteEstoque).toHaveBeenCalledTimes(1);
    expect(omie.incluirAjusteEstoque).toHaveBeenCalledWith('q2p', expect.objectContaining({
      codIntAjuste: 'op-ent:ret-entrada-q2p',
    }));
  });

  it('clicar na BAIXA resolve a operacao inteira (par localizado pela origem)', async () => {
    const { omie } = await prepararRetorno({ clicada: { ...baixaRow } });

    const res = await retentarOperacaoPendente({
      movimentacaoId: 'mov-bx',
      ator: { userId: 'g', role: 'gestor' },
    });

    expect(res.movimentacaoId).toBe('mov-bx');
    expect(omie.incluirAjusteEstoque).toHaveBeenCalledTimes(2);
  });

  it('retorno nao aprovado: bloqueia sem tocar OMIE (movs nascem pendente_q2p na submissao)', async () => {
    const { omie } = await prepararRetorno({ aprovacaoRows: [] });

    await expect(
      retentarOperacaoPendente({ movimentacaoId: 'mov-ent', ator: { userId: 'g', role: 'gestor' } }),
    ).rejects.toThrow(/aprova/i);
    expect(omie.incluirAjusteEstoque).not.toHaveBeenCalled();
    expect(omie.listarAjusteEstoque).not.toHaveBeenCalled();
  });

  it('perna baixa falha: incrementa tentativas NA BAIXA, nao tenta a entrada, propaga', async () => {
    const { chain, omie } = await prepararRetorno();
    vi.mocked(omie.incluirAjusteEstoque).mockRejectedValueOnce(new Error('OMIE Q2P 503 na baixa'));

    await expect(
      retentarOperacaoPendente({ movimentacaoId: 'mov-ent', ator: { userId: 'g', role: 'gestor' } }),
    ).rejects.toThrow('OMIE Q2P 503 na baixa');

    expect(omie.incluirAjusteEstoque).toHaveBeenCalledTimes(1); // entrada NAO tentada
    const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    expect(setCalls.at(-1)?.[0]).toMatchObject({
      tentativasQ2p: 1,
      ultimoErroOmie: expect.objectContaining({ mensagem: expect.stringContaining('503 na baixa') }),
    });
  });
});
