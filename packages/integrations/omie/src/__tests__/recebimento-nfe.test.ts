import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  consultarRecebimentoNfe,
  alterarRecebimentoNfeItens,
  concluirRecebimentoNfe,
  validarItensRecebimentoEditar,
  parseRecebimentoNfeConsultado,
} from '../stockbridge/recebimento-nfe.js';
import { __resetMockState, __injectMockRecebimentoNfe, __getMockRecebimentoNfe } from '../stockbridge/mock.js';
import { OmieApiError } from '../client.js';

// Feature 016 (ACXEGDP-395): o Atlas conclui o recebimento FISCAL da NF nacional
// no OMIE sem movimentar estoque. A receita e EDITAR (ajustes) -> IGNORAR (sem
// ajustes) -> ConcluirRecebimento (etapa 60), em tres chamadas — testado em
// producao na NF 6842 (02/10/2026). O mock guarda estado para o ciclo inteiro.
//
// Feature 017 (ACXEGDP-437): o item pode estar vinculado a um item de pedido de
// compra (nIdPedido/nIdItPedido). O parser le o vinculo, ASSOCIAR-PEDIDO o grava
// (itensIde, sem itensAjustes) e IGNORAR o desfaz — ver NFs 7813 e 7736 (21/10/2026).

describe('OMIE recebimento de NF-e — mock mode (ACXEGDP-395)', () => {
  const originalMode = process.env.OMIE_MODE;

  beforeEach(() => {
    process.env.OMIE_MODE = 'mock';
    __resetMockState();
  });
  afterEach(() => {
    process.env.OMIE_MODE = originalMode;
  });

  it('consultarRecebimentoNfe por nIdReceb sem fixture devolve recebimento sintetico na etapa 40, nao recebido, 1 item', async () => {
    const rec = await consultarRecebimentoNfe('q2p', { nIdReceb: 8510564869 });
    expect(rec.nIdReceb).toBe(8510564869);
    expect(rec.cEtapa).toBe('40');
    expect(rec.cRecebido).toBe('N');
    expect(rec.cCancelada).toBe('N');
    expect(rec.itens).toHaveLength(1);
    expect(rec.itens[0]!.cDescricaoProduto).toBe('SUCATA PLASTICO');
    expect(rec.itens[0]!.cCFOPEntrada).toBe('1.102');
    expect(rec.itens[0]!.vTotalItem).toBe(203_400);
    expect(rec.itens[0]!.cNaoGerarMovEstoque).toBe('N');
    expect(rec.itens[0]!.cIgnorarItem).toBe('N');
  });

  it('consultarRecebimentoNfe por cChaveNfe acha o mesmo recebimento que a consulta por nIdReceb', async () => {
    const porId = await consultarRecebimentoNfe('q2p', { nIdReceb: 123 });
    const porChave = await consultarRecebimentoNfe('q2p', { cChaveNfe: porId.cChaveNFe });
    expect(porChave.nIdReceb).toBe(123);
    expect(porChave.cChaveNFe).toBe(porId.cChaveNFe);
    // A consulta devolve copia — mutar o retorno nao altera o estado do mock.
    porChave.cEtapa = '99';
    expect(__getMockRecebimentoNfe('q2p', 123)!.cEtapa).toBe('40');
  });

  it('EDITAR aplica cNaoGerarMovEstoque/cNaoGerarFinanceiro no item e a consulta seguinte reflete', async () => {
    const base = await consultarRecebimentoNfe('q2p', { nIdReceb: 500 });
    const res = await alterarRecebimentoNfeItens('q2p', {
      nIdReceb: 500,
      itens: base.itens.map((it) => ({
        nSequencia: it.nSequencia,
        cAcao: 'EDITAR' as const,
        itensAjustes: { cNaoGerarMovEstoque: 'S' as const, cNaoGerarFinanceiro: 'N' as const },
      })),
    });
    expect(res.cCodStatus).toBe('0');
    const depois = await consultarRecebimentoNfe('q2p', { nIdReceb: 500 });
    expect(depois.itens[0]!.cNaoGerarMovEstoque).toBe('S');
    expect(depois.itens[0]!.cNaoGerarFinanceiro).toBe('N');
    // EDITAR nao ignora nem conclui.
    expect(depois.itens[0]!.cIgnorarItem).toBe('N');
    expect(depois.cRecebido).toBe('N');
  });

  it('IGNORAR com itensAjustes e recusado ANTES de chamar o OMIE (erro 151 do OMIE real)', async () => {
    await consultarRecebimentoNfe('q2p', { nIdReceb: 600 });
    await expect(
      alterarRecebimentoNfeItens('q2p', {
        nIdReceb: 600,
        itens: [{ nSequencia: 1, cAcao: 'IGNORAR', itensAjustes: { cNaoGerarMovEstoque: 'S' } }],
      }),
    ).rejects.toThrow(/Client-151/);
    // Nada mudou no estado.
    expect(__getMockRecebimentoNfe('q2p', 600)!.itens[0]!.cIgnorarItem).toBe('N');
    // A validacao e local e sincrona — serve ao service antes de montar a sequencia.
    expect(() => validarItensRecebimentoEditar([{ nSequencia: 1, cAcao: 'IGNORAR', itensAjustes: {} }])).toThrow(/Client-151/);
    expect(() => validarItensRecebimentoEditar([])).toThrow(/ao menos um item/);
    expect(() => validarItensRecebimentoEditar([{ nSequencia: 1, cAcao: 'IGNORAR' }])).not.toThrow();
  });

  it('ASSOCIAR-PEDIDO sem os ids e recusado ANTES do mock e nao altera o recebimento', async () => {
    await consultarRecebimentoNfe('q2p', { nIdReceb: 650 });
    await expect(
      alterarRecebimentoNfeItens('q2p', { nIdReceb: 650, itens: [{ nSequencia: 1, cAcao: 'ASSOCIAR-PEDIDO' }] }),
    ).rejects.toThrow(/exige nIdPedidoExistente e nIdItPedidoExistente/);
    const item = __getMockRecebimentoNfe('q2p', 650)!.itens[0]!;
    expect(item.cAssociarExistente).toBe('N');
    expect(item.nIdPedido).toBeNull();
  });

  it('sequencia EDITAR -> IGNORAR -> Concluir leva a cEtapa 60, cRecebido S, item ignorado sem vinculo e sem movimento de estoque', async () => {
    const base = await consultarRecebimentoNfe('q2p', { nIdReceb: 700 });
    const seqs = base.itens.map((it) => it.nSequencia);

    await alterarRecebimentoNfeItens('q2p', {
      nIdReceb: 700,
      itens: seqs.map((n) => ({ nSequencia: n, cAcao: 'EDITAR' as const, itensAjustes: { cNaoGerarMovEstoque: 'S' as const, cNaoGerarFinanceiro: 'N' as const } })),
    });
    await alterarRecebimentoNfeItens('q2p', { nIdReceb: 700, itens: seqs.map((n) => ({ nSequencia: n, cAcao: 'IGNORAR' as const })) });
    const fim = await concluirRecebimentoNfe('q2p', { nIdReceb: 700 });
    expect(fim.cDescStatus).toMatch(/concluído com sucesso/);

    const depois = await consultarRecebimentoNfe('q2p', { nIdReceb: 700 });
    expect(depois.cEtapa).toBe('60');
    expect(depois.cRecebido).toBe('S');
    expect(depois.cUsuarioRec).toBe('WEBSERVICE');
    const item = depois.itens[0]!;
    expect(item.cIgnorarItem).toBe('S');
    expect(item.cAssociarExistente).toBe('N');
    expect(item.nIdProduto).toBe(0);
    expect(item.cNaoGerarMovEstoque).toBe('S');
    expect(item.cNaoGerarFinanceiro).toBe('N');
    // A descricao original do item e preservada (o ponto da feature — ACXEGDP-394).
    expect(item.cDescricaoProduto).toBe('SUCATA PLASTICO');
  });

  it('Concluir em recebimento ja concluido lanca OmieApiError; EDITAR em concluido tambem', async () => {
    await consultarRecebimentoNfe('q2p', { nIdReceb: 800 });
    await concluirRecebimentoNfe('q2p', { nIdReceb: 800 });
    await expect(concluirRecebimentoNfe('q2p', { nIdReceb: 800 })).rejects.toBeInstanceOf(OmieApiError);
    await expect(
      alterarRecebimentoNfeItens('q2p', { nIdReceb: 800, itens: [{ nSequencia: 1, cAcao: 'EDITAR', itensAjustes: { cNaoGerarMovEstoque: 'S' } }] }),
    ).rejects.toBeInstanceOf(OmieApiError);
  });

  it('chaves diferentes sem fixture viram recebimentos DIFERENTES no mock (concluir uma nao conclui a outra)', async () => {
    const a = await consultarRecebimentoNfe('q2p', { cChaveNfe: '1'.repeat(44) });
    const b = await consultarRecebimentoNfe('q2p', { cChaveNfe: '2'.repeat(44) });
    expect(a.nIdReceb).not.toBe(b.nIdReceb);
    await concluirRecebimentoNfe('q2p', { nIdReceb: a.nIdReceb });
    expect((await consultarRecebimentoNfe('q2p', { cChaveNfe: '2'.repeat(44) })).cRecebido).toBe('N');
    // estavel: a mesma chave volta ao mesmo id
    expect((await consultarRecebimentoNfe('q2p', { cChaveNfe: '1'.repeat(44) })).nIdReceb).toBe(a.nIdReceb);
  });

  it('__injectMockRecebimentoNfe substitui o estado; __resetMockState limpa', async () => {
    const rec = await consultarRecebimentoNfe('q2p', { nIdReceb: 900 });
    __injectMockRecebimentoNfe('q2p', { ...rec, cRecebido: 'S', cEtapa: '60' });
    expect((await consultarRecebimentoNfe('q2p', { nIdReceb: 900 })).cRecebido).toBe('S');
    __resetMockState();
    expect(__getMockRecebimentoNfe('q2p', 900)).toBeNull();
    // Apos o reset, a consulta recria o sintetico pendente.
    expect((await consultarRecebimentoNfe('q2p', { nIdReceb: 900 })).cRecebido).toBe('N');
  });
});

describe('parseRecebimentoNfeConsultado — forma real do OMIE (NF 6842, 02/10/2026)', () => {
  it('mapeia cabec/infoCadastro/itensRecebimento, inclusive cCFOPEntrada de itensAjustes e vTotalItem', () => {
    const rec = parseRecebimentoNfeConsultado({
      cabec: {
        cCNPJ_CPF: '14.555.032/0007-53', cChaveNFe: '35261014555032000753550010000068421827355174', cEtapa: '40',
        cNumeroNFe: '000006842', cRazaoSocial: 'REPLAS COMERCIAL LTDA', dEmissaoNFe: '01/10/2026',
        nIdFornecedor: 8498397152, nIdReceb: 8510564869, nValorNFe: 203400,
      },
      infoCadastro: { cCancelada: 'N', cRecebido: 'N', cFaturado: 'S' },
      itensRecebimento: [
        {
          itensCabec: { cAdicionarNovo: 'S', cAssociarExistente: 'N', cCFOP: '5.102', cCodigoProduto: 'SUCPLA', cDescricaoProduto: 'SUCATA PLASTICO', cIgnorarItem: 'N', cNCM: '3915.90.00', cUnidadeNfe: 'KG', nIdItem: 0, nIdProduto: 0, nPrecoUnit: 11.3, nQtdeNFe: 18000, nSequencia: 1, vTotalItem: 203400 },
          itensAjustes: { cCFOPEntrada: '1.102', cNaoGerarFinanceiro: 'N', cNaoGerarMovEstoque: 'N', nQtdeRecebida: 18000 },
        },
      ],
    });
    expect(rec.nIdReceb).toBe(8510564869);
    expect(rec.cNumeroNFe).toBe('000006842');
    expect(rec.cRecebido).toBe('N');
    expect(rec.cUsuarioRec).toBeNull();
    expect(rec.itens[0]).toMatchObject({ nSequencia: 1, cCFOP: '5.102', cCFOPEntrada: '1.102', vTotalItem: 203400, cUnidadeNfe: 'KG' });
  });

  it('recusa bloco sem nIdReceb/cChaveNFe (estrutura invalida)', () => {
    expect(() => parseRecebimentoNfeConsultado({ cabec: { cEtapa: '40' } })).toThrow(/estrutura invalida/);
  });

  it('fornecedor nao cadastrado — forma REAL do OMIE (NF 1257, sonda 02/10/2026): nIdFornecedor 0 vira null, sem CNPJ/razao', () => {
    // Bloco devolvido pela ListarRecebimentos (exec 444213 da sonda YN2YubdFHpvheA99):
    // o OMIE manda nIdFornecedor: 0 — NAO omite o campo nem manda null.
    const rec = parseRecebimentoNfeConsultado({
      cabec: {
        cChaveNFe: '31261038467346000258550010000012571279398231', cEtapa: '40', cNumeroNFe: '000001257',
        dEmissaoNFe: '01/10/2026', nIdFornecedor: 0, nIdReceb: 8510558859, nValorNFe: 34050,
      },
      infoCadastro: { cRecebido: 'N', cCancelada: 'N', cFaturado: 'S' },
      itensRecebimento: [{ itensCabec: { nSequencia: 1, cDescricaoProduto: 'APARA', nQtdeNFe: 1500, cUnidadeNfe: 'KG', vTotalItem: 34050 }, itensAjustes: { cCFOPEntrada: '2.102' } }],
    });
    expect(rec.nIdFornecedor).toBeNull();
    expect(rec.cRazaoSocial).toBeNull();
    expect(rec.cCNPJ_CPF).toBeNull();
    expect(rec.cBloqueado).toBeNull();
    expect(rec.itens[0]).toMatchObject({ cCFOPEntrada: '2.102', vTotalItem: 34050 });
  });

  it('nIdFornecedor positivo e preservado; cBloqueado/cDevolvido sao lidos do infoCadastro', () => {
    const rec = parseRecebimentoNfeConsultado({
      cabec: { nIdReceb: 2, cChaveNFe: '4'.repeat(44), nIdFornecedor: 8498397152 },
      infoCadastro: { cRecebido: 'N', cCancelada: 'N', cBloqueado: 'S', cDevolvido: 'N' },
      itensRecebimento: [],
    });
    expect(rec.nIdFornecedor).toBe(8498397152);
    expect(rec.cBloqueado).toBe('S');
    expect(rec.cDevolvido).toBe('N');
  });

  it('sem infoCadastro.cRecebido a estrutura e recusada (falha fechado — nao assume "nao recebido")', () => {
    expect(() => parseRecebimentoNfeConsultado({ cabec: { nIdReceb: 3, cChaveNFe: '5'.repeat(44) } })).toThrow(/infoCadastro\.cRecebido/);
    expect(() => parseRecebimentoNfeConsultado({ cabec: { nIdReceb: 3, cChaveNFe: '5'.repeat(44) }, infoCadastro: { cCancelada: 'N' } })).toThrow(/estrutura invalida/);
  });
});

// ── Feature 017 (ACXEGDP-437): vinculo do item com o pedido de compra ──────────

/**
 * Bloco de ConsultarRecebimento no formato do OMIE, com 1 item de 18.000 kg. Os ids
 * do vinculo sao os reais da NF 7813 (PC 304 — research D1); chave, nIdReceb e
 * valores sao sinteticos.
 */
const PC_304 = { nIdPedido: 8516905979, nIdItPedido: 8516907022 };

function blocoRecebimento(itensCabec: Record<string, unknown> = {}, itensInfoAdic?: Record<string, unknown>) {
  return {
    cabec: {
      cChaveNFe: '3'.repeat(44), cEtapa: '40', cNumeroNFe: '000007813', nIdFornecedor: 8498397152,
      nIdReceb: 8516900001, nValorNFe: 203400,
    },
    infoCadastro: { cCancelada: 'N', cRecebido: 'N' },
    itensRecebimento: [
      {
        itensCabec: {
          cDescricaoProduto: 'SUCATA PLASTICO', cIgnorarItem: 'N', cUnidadeNfe: 'KG', nQtdeNFe: 18000,
          nSequencia: 1, vTotalItem: 203400, ...itensCabec,
        },
        itensAjustes: { cCFOPEntrada: '1.102', cNaoGerarFinanceiro: 'N', cNaoGerarMovEstoque: 'N' },
        ...(itensInfoAdic ? { itensInfoAdic } : {}),
      },
    ],
  };
}

describe('parseRecebimentoNfeConsultado — vinculo do item com o pedido de compra (ACXEGDP-437)', () => {
  it('item vinculado (NF 7813): le nIdPedido, nIdItPedido e itensInfoAdic', () => {
    const rec = parseRecebimentoNfeConsultado(
      blocoRecebimento({ cAssociarExistente: 'S', nIdItem: 0, ...PC_304 }, { nNumPedCompra: '304', cNumItPedCompra: 1 }),
    );
    expect(rec.itens[0]).toMatchObject({
      cAssociarExistente: 'S',
      nIdPedido: 8516905979,
      nIdItPedido: 8516907022,
      nNumPedCompra: '304',
      cNumItPedCompra: 1,
    });
  });

  const semPedido: Array<[string, Record<string, unknown>]> = [
    ['0', { nIdPedido: 0 }],
    ['"0" em texto', { nIdPedido: '0' }],
    ['null', { nIdPedido: null }],
    ['ausente', {}],
  ];
  it.each(semPedido)(
    'sem vinculo (NF 7736), nIdPedido %s: o nIdItPedido que repete o nIdItem vira null junto com o nIdPedido',
    (_rotulo, pedido) => {
      const nIdItem = 8516111222;
      const rec = parseRecebimentoNfeConsultado(
        blocoRecebimento({ cIgnorarItem: 'S', cAssociarExistente: 'N', nIdItem, nIdItPedido: nIdItem, ...pedido }),
      );
      expect(rec.itens[0]).toMatchObject({ nIdItem, nIdPedido: null, nIdItPedido: null });
    },
  );

  it('sem itensInfoAdic (ausente ou vazio): nNumPedCompra e cNumItPedCompra ficam null', () => {
    for (const rec of [parseRecebimentoNfeConsultado(blocoRecebimento()), parseRecebimentoNfeConsultado(blocoRecebimento({}, {}))]) {
      expect(rec.itens[0]).toMatchObject({ nNumPedCompra: null, cNumItPedCompra: null });
    }
  });

  it('nNumPedCompra: vazio ou so espacos vira null, espacos nas pontas sao aparados e numero vira texto', () => {
    const numero = (v: unknown) =>
      parseRecebimentoNfeConsultado(blocoRecebimento({}, { nNumPedCompra: v })).itens[0]!.nNumPedCompra;
    expect(numero('')).toBeNull();
    expect(numero('   ')).toBeNull();
    expect(numero(' 304 ')).toBe('304');
    expect(numero(304)).toBe('304');
  });

  it('cNumItPedCompra aceita numero em texto e vazio vira null', () => {
    const item = (v: unknown) =>
      parseRecebimentoNfeConsultado(blocoRecebimento({}, { cNumItPedCompra: v })).itens[0]!.cNumItPedCompra;
    expect(item('2')).toBe(2);
    expect(item('')).toBeNull();
  });

  it('cada item guarda o seu vinculo: um vinculado e outro sem', () => {
    const a = blocoRecebimento({ cAssociarExistente: 'S', ...PC_304 }, { nNumPedCompra: '304', cNumItPedCompra: 1 });
    const b = blocoRecebimento({ nSequencia: 2, cDescricaoProduto: 'APARA', nQtdeNFe: 5000, nIdItem: 7, nIdItPedido: 7 });
    const [vinculado, solto] = parseRecebimentoNfeConsultado({
      ...a,
      itensRecebimento: [...a.itensRecebimento, ...b.itensRecebimento],
    }).itens;
    expect(vinculado).toMatchObject({ nSequencia: 1, nIdPedido: 8516905979, nIdItPedido: 8516907022, nNumPedCompra: '304' });
    expect(solto).toMatchObject({ nSequencia: 2, nIdPedido: null, nIdItPedido: null, nNumPedCompra: null });
  });
});

describe('validarItensRecebimentoEditar — ASSOCIAR-PEDIDO (ACXEGDP-437)', () => {
  const associar = {
    nSequencia: 1,
    cAcao: 'ASSOCIAR-PEDIDO' as const,
    nIdPedidoExistente: 8516905979,
    nIdItPedidoExistente: 8516907022,
  };

  it('com os dois ids positivos passa, sozinho ou junto de EDITAR/IGNORAR em outros itens', () => {
    expect(() => validarItensRecebimentoEditar([associar])).not.toThrow();
    expect(() =>
      validarItensRecebimentoEditar([
        associar,
        { nSequencia: 2, cAcao: 'EDITAR', itensAjustes: { cNaoGerarMovEstoque: 'S' } },
        { nSequencia: 3, cAcao: 'IGNORAR' },
      ]),
    ).not.toThrow();
  });

  const idsInvalidos: Array<[string, Partial<typeof associar>]> = [
    ['sem ids', { nIdPedidoExistente: undefined, nIdItPedidoExistente: undefined }],
    ['so o nIdPedidoExistente', { nIdItPedidoExistente: undefined }],
    ['so o nIdItPedidoExistente', { nIdPedidoExistente: undefined }],
    ['nIdPedidoExistente 0', { nIdPedidoExistente: 0 }],
    ['nIdItPedidoExistente 0', { nIdItPedidoExistente: 0 }],
    ['id negativo', { nIdPedidoExistente: -5 }],
    ['id fracionario', { nIdItPedidoExistente: 1.5 }],
  ];
  it.each(idsInvalidos)('exige os dois ids positivos e inteiros: %s lanca', (_rotulo, ids) => {
    expect(() => validarItensRecebimentoEditar([{ ...associar, ...ids }])).toThrow(
      /exige nIdPedidoExistente e nIdItPedidoExistente/,
    );
  });

  it('aponta o item com problema quando so um dos itens da chamada esta invalido', () => {
    expect(() =>
      validarItensRecebimentoEditar([associar, { ...associar, nSequencia: 2, nIdItPedidoExistente: 0 }]),
    ).toThrow(/item 2/);
  });

  it('ASSOCIAR-PEDIDO + itensAjustes lanca (erro 151 do OMIE), mesmo com os ids certos', () => {
    expect(() =>
      validarItensRecebimentoEditar([{ ...associar, itensAjustes: { cNaoGerarMovEstoque: 'S' } }]),
    ).toThrow(/ASSOCIAR-PEDIDO.*Client-151/);
    // vazio tambem: o OMIE recusa a tag [itensAjustes], nao o conteudo dela
    expect(() => validarItensRecebimentoEditar([{ ...associar, itensAjustes: {} }])).toThrow(/Client-151/);
  });

  it('os ids sao exclusivos do ASSOCIAR-PEDIDO: EDITAR e IGNORAR com eles lancam', () => {
    expect(() =>
      validarItensRecebimentoEditar([{ nSequencia: 1, cAcao: 'EDITAR', nIdPedidoExistente: 8516905979 }]),
    ).toThrow(/so com ASSOCIAR-PEDIDO/);
    expect(() =>
      validarItensRecebimentoEditar([{ nSequencia: 1, cAcao: 'IGNORAR', nIdItPedidoExistente: 8516907022 }]),
    ).toThrow(/so com ASSOCIAR-PEDIDO/);
  });
});

describe('OMIE recebimento de NF-e — corpo enviado no modo real (ACXEGDP-437)', () => {
  const mockFetch = vi.fn();
  const ENV_ORIGINAL = { ...process.env };

  function respostaOk(body: unknown) {
    return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) };
  }
  /** Corpo (JSON) da n-esima chamada que saiu pela rede. */
  function corpoEnviado(n = 0) {
    return JSON.parse((mockFetch.mock.calls[n]![1] as { body: string }).body) as {
      call: string;
      param: Array<Record<string, unknown>>;
    };
  }
  /** `itensRecebimentoEditar` do AlterarRecebimento enviado na n-esima chamada. */
  function itensEnviados(n = 0): Array<Record<string, unknown>> {
    return corpoEnviado(n).param[0]!.itensRecebimentoEditar as Array<Record<string, unknown>>;
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    delete process.env.ATLAS_ENV;
    process.env.OMIE_MODE = 'real';
    process.env.OMIE_Q2P_KEY = 'q2p-key';
    process.env.OMIE_Q2P_SECRET = 'q2p-secret';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ENV_ORIGINAL };
  });

  const statusOk = { nIdReceb: 8516900001, cCodStatus: '0', cDescStatus: 'Recebimento alterado com sucesso!' };

  it('ASSOCIAR-PEDIDO leva os ids do pedido dentro de itensIde e nao leva itensAjustes', async () => {
    mockFetch.mockResolvedValue(respostaOk(statusOk));

    const res = await alterarRecebimentoNfeItens('q2p', {
      nIdReceb: 8516900001,
      itens: [{ nSequencia: 1, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente: 8516905979, nIdItPedidoExistente: 8516907022 }],
    });

    expect(res).toEqual(statusOk);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const corpo = corpoEnviado();
    expect(corpo.call).toBe('AlterarRecebimento');
    expect(corpo.param[0]).toEqual({
      ide: { nIdReceb: 8516900001 },
      itensRecebimentoEditar: [
        {
          itensIde: {
            nSequencia: 1, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente: 8516905979, nIdItPedidoExistente: 8516907022,
          },
        },
      ],
    });
    expect(itensEnviados()[0]).not.toHaveProperty('itensAjustes');
  });

  it('EDITAR leva itensAjustes e nenhum id de pedido; IGNORAR leva so o itensIde', async () => {
    mockFetch.mockResolvedValue(respostaOk(statusOk));

    await alterarRecebimentoNfeItens('q2p', {
      nIdReceb: 8516900001,
      itens: [{ nSequencia: 1, cAcao: 'EDITAR', itensAjustes: { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' } }],
    });
    await alterarRecebimentoNfeItens('q2p', { nIdReceb: 8516900001, itens: [{ nSequencia: 1, cAcao: 'IGNORAR' }] });

    expect(itensEnviados(0)).toEqual([
      { itensIde: { nSequencia: 1, cAcao: 'EDITAR' }, itensAjustes: { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' } },
    ]);
    expect(itensEnviados(1)).toEqual([{ itensIde: { nSequencia: 1, cAcao: 'IGNORAR' } }]);
  });

  it('varios itens na mesma chamada: cada itensIde leva os ids do seu proprio pedido', async () => {
    mockFetch.mockResolvedValue(respostaOk(statusOk));

    await alterarRecebimentoNfeItens('q2p', {
      nIdReceb: 8516900001,
      itens: [
        { nSequencia: 1, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente: 111, nIdItPedidoExistente: 1111 },
        { nSequencia: 2, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente: 222, nIdItPedidoExistente: 2222 },
      ],
    });

    expect(itensEnviados()).toEqual([
      { itensIde: { nSequencia: 1, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente: 111, nIdItPedidoExistente: 1111 } },
      { itensIde: { nSequencia: 2, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente: 222, nIdItPedidoExistente: 2222 } },
    ]);
  });

  it('ASSOCIAR-PEDIDO invalido (sem ids ou com itensAjustes) e recusado antes da rede', async () => {
    await expect(
      alterarRecebimentoNfeItens('q2p', { nIdReceb: 8516900001, itens: [{ nSequencia: 1, cAcao: 'ASSOCIAR-PEDIDO' }] }),
    ).rejects.toThrow(/exige nIdPedidoExistente e nIdItPedidoExistente/);
    await expect(
      alterarRecebimentoNfeItens('q2p', {
        nIdReceb: 8516900001,
        itens: [
          {
            nSequencia: 1, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente: 1, nIdItPedidoExistente: 2,
            itensAjustes: { cNaoGerarMovEstoque: 'S' },
          },
        ],
      }),
    ).rejects.toThrow(/Client-151/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fault do OMIE no ASSOCIAR-PEDIDO propaga como OmieApiError e a escrita nao e repetida (sem retry)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () =>
        Promise.resolve(
          JSON.stringify({ faultcode: 'SOAP-ENV:Client-102', faultstring: 'ERROR: Pedido de compra invalido para o item!' }),
        ),
    });

    const tentativa = alterarRecebimentoNfeItens('q2p', {
      nIdReceb: 8516900001,
      itens: [{ nSequencia: 1, cAcao: 'ASSOCIAR-PEDIDO', nIdPedidoExistente: 8516905979, nIdItPedidoExistente: 8516907022 }],
    });
    await expect(tentativa).rejects.toBeInstanceOf(OmieApiError);
    await expect(tentativa).rejects.toThrow(/Pedido de compra invalido/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('ConsultarRecebimento real devolve o vinculo do item (parse ponta a ponta)', async () => {
    mockFetch.mockResolvedValue(
      respostaOk(blocoRecebimento({ cAssociarExistente: 'S', ...PC_304 }, { nNumPedCompra: '304', cNumItPedCompra: 1 })),
    );

    const rec = await consultarRecebimentoNfe('q2p', { nIdReceb: 8516900001 });

    expect(corpoEnviado().call).toBe('ConsultarRecebimento');
    expect(corpoEnviado().param[0]).toEqual({ nIdReceb: 8516900001 });
    expect(rec.itens[0]).toMatchObject({ nIdPedido: 8516905979, nIdItPedido: 8516907022, nNumPedCompra: '304' });
  });
});
