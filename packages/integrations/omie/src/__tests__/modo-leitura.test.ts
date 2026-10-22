import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callOmie, getOmieMode, OmieApiError, OmieEscritaBloqueadaError } from '../client.js';
import { incluirAjusteEstoque } from '../stockbridge/ajuste-estoque.js';
import { listarAjusteEstoque } from '../stockbridge/listar-ajuste-estoque.js';
import { alterarPedidoCompra, consultarPedidoCompra } from '../stockbridge/pedido-compra.js';
import {
  alterarRecebimentoNfeItens,
  concluirRecebimentoNfe,
  consultarRecebimentoNfe,
  parseRecebimentoNfeConsultado,
} from '../stockbridge/recebimento-nfe.js';
import { __resetMockState, registrarSombraRecebimentoNfe, sombraPedidoCompra } from '../stockbridge/mock.js';

// ACXEGDP-405: o UAT virou ambiente de testes, mas tem chaves OMIE de produção.
// OMIE_MODE=leitura: leituras vão ao OMIE real, escritas são simuladas e nunca
// saem do processo. O documento "escrito" fica numa sombra em memória que passa
// a responder às consultas dele (o fluxo reconsulta depois de escrever).

const mockFetch = vi.fn();

function respostaOk(body: unknown) {
  return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) };
}

/** Métodos OMIE efetivamente enviados pela rede. */
function metodosEnviados(): string[] {
  return mockFetch.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body).call as string);
}

const ENV_ORIGINAL = { ...process.env };

function ambienteUat(): void {
  process.env.NODE_ENV = 'production';
  process.env.ATLAS_ENV = 'uat';
  process.env.OMIE_MODE = 'leitura';
  process.env.OMIE_LEITURA_ACXE_KEY = 'leitura-acxe-key';
  process.env.OMIE_LEITURA_ACXE_SECRET = 'leitura-acxe-secret';
  process.env.OMIE_LEITURA_Q2P_KEY = 'leitura-q2p-key';
  process.env.OMIE_LEITURA_Q2P_SECRET = 'leitura-q2p-secret';
  delete process.env.OMIE_ACXE_KEY;
  delete process.env.OMIE_ACXE_SECRET;
  delete process.env.OMIE_Q2P_KEY;
  delete process.env.OMIE_Q2P_SECRET;
}

describe('getOmieMode — guardas de ambiente (STK-15 + ACXEGDP-405)', () => {
  beforeEach(() => {
    delete process.env.OMIE_MODE;
    delete process.env.ATLAS_ENV;
    process.env.NODE_ENV = 'test';
  });
  afterEach(() => {
    process.env = { ...ENV_ORIGINAL };
  });

  it('leitura com NODE_ENV=production é aceito só com ATLAS_ENV=uat', () => {
    process.env.NODE_ENV = 'production';
    process.env.OMIE_MODE = 'leitura';
    expect(() => getOmieMode()).toThrow(/OMIE_MODE=leitura com NODE_ENV=production/);
    process.env.ATLAS_ENV = 'uat';
    expect(getOmieMode()).toBe('leitura');
  });

  it('mock com NODE_ENV=production também é aceito no UAT', () => {
    process.env.NODE_ENV = 'production';
    process.env.ATLAS_ENV = 'uat';
    process.env.OMIE_MODE = 'mock';
    expect(getOmieMode()).toBe('mock');
  });

  it('ATLAS_ENV=uat proíbe o modo real — explícito ou por omissão', () => {
    process.env.ATLAS_ENV = 'uat';
    process.env.OMIE_MODE = 'real';
    expect(() => getOmieMode()).toThrow(/ATLAS_ENV=uat com OMIE_MODE=real/);
    delete process.env.OMIE_MODE;
    expect(() => getOmieMode()).toThrow(/ATLAS_ENV=uat com OMIE_MODE=real/);
  });

  it('valor desconhecido falha em vez de cair no modo real', () => {
    process.env.OMIE_MODE = 'leiture';
    expect(() => getOmieMode()).toThrow(/OMIE_MODE inválido: "leiture"/);
  });

  it('ignora caixa e espaços', () => {
    process.env.OMIE_MODE = ' Leitura ';
    expect(getOmieMode()).toBe('leitura');
  });
});

describe('OMIE_MODE=leitura — transporte (ACXEGDP-405)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    ambienteUat();
    __resetMockState();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ENV_ORIGINAL };
  });

  it('escrita que chegue ao transporte é bloqueada antes da rede', async () => {
    await expect(
      callOmie('acxe', { endpoint: 'estoque/ajuste/', method: 'IncluirAjusteEstoque', params: {} }),
    ).rejects.toBeInstanceOf(OmieEscritaBloqueadaError);
    await expect(
      callOmie('q2p', { endpoint: 'produtos/pedidocompra/', method: 'IncluirPedCompra', params: {} }),
    ).rejects.toBeInstanceOf(OmieEscritaBloqueadaError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('leitura usa as chaves OMIE_LEITURA_*, nunca OMIE_<EMPRESA>_KEY', async () => {
    process.env.OMIE_ACXE_KEY = 'chave-de-escrita';
    process.env.OMIE_ACXE_SECRET = 'segredo-de-escrita';
    mockFetch.mockResolvedValue(respostaOk({ ok: true }));

    await callOmie('acxe', { endpoint: 'produtos/nfconsultar/', method: 'ConsultarNF', params: {} });

    const payload = JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body);
    expect(payload.app_key).toBe('leitura-acxe-key');
    expect(payload.app_secret).toBe('leitura-acxe-secret');
  });

  it('sem OMIE_LEITURA_* não chama o OMIE, mesmo com as chaves de produção presentes', async () => {
    delete process.env.OMIE_LEITURA_Q2P_KEY;
    process.env.OMIE_Q2P_KEY = 'chave-de-escrita';
    process.env.OMIE_Q2P_SECRET = 'segredo-de-escrita';
    await expect(
      callOmie('q2p', { endpoint: 'produtos/nfconsultar/', method: 'ConsultarNF', params: {} }),
    ).rejects.toThrow(/OMIE_LEITURA_Q2P_KEY\/SECRET nao configuradas/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('OMIE_MODE=leitura — escritas simuladas com sombra (ACXEGDP-405)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    ambienteUat();
    __resetMockState();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ENV_ORIGINAL };
  });

  it('IncluirAjusteEstoque não sai do processo e a idempotência do retry o enxerga', async () => {
    const res = await incluirAjusteEstoque('acxe', {
      codigoLocalEstoque: '4498926337',
      codigoLocalEstoqueDestino: '4004166399',
      idProduto: 4452881285,
      dataAtual: '05/10/2026',
      quantidade: 25000,
      observacao: 'teste UAT',
      origem: 'AJU',
      tipo: 'TRF',
      motivo: 'TRF',
      valor: 30000,
      codIntAjuste: 'op-1:acxe-trf',
    });
    expect(res.idMovest).toMatch(/^MOCK-MOVEST-acxe-/);

    const listado = await listarAjusteEstoque('acxe', { codIntAjuste: 'op-1:acxe-trf' });
    expect(listado.ajustes[0]?.idMovest).toBe(res.idMovest);
    expect(mockFetch).not.toHaveBeenCalled();

    // cod_int que não foi simulado aqui é consultado no OMIE real
    mockFetch.mockResolvedValue(
      respostaOk({ pagina: 1, total_de_paginas: 1, registros: 0, total_de_registros: 0, ajustes: [] }),
    );
    await listarAjusteEstoque('acxe', { codIntAjuste: 'op-2:acxe-trf' });
    expect(metodosEnviados()).toEqual(['ListarAjusteEstoque']);
  });

  it('AlteraPedCompra parte do pedido real e a reconsulta devolve a quantidade simulada', async () => {
    mockFetch.mockResolvedValue(
      respostaOk({
        cabecalho_consulta: { nCodPed: 8444305527, cCodIntPed: 'ITG1', cNumero: '193', cEtapa: '15', cObs: 'Pedido original ACXE: 423' },
        produtos_consulta: [
          { nCodItem: 8444305528, nCodProd: 7853452187, cProduto: 'PELBD-030', cDescricao: 'PELBD LB1810E2', cUnidade: 'KG', nQtde: 24125, nQtdeRec: 0, nValUnit: 0, codigo_local_estoque: '8429029971' },
        ],
      }),
    );

    const antes = await consultarPedidoCompra('q2p', { nCodPed: 8444305527 });
    expect(antes.produtos[0]!.nQtde).toBe(24125);

    await alterarPedidoCompra('q2p', {
      nCodPed: 8444305527,
      dDtPrevisao: '04/02/2026',
      nCodFor: 3070534015,
      produto: { nCodItem: 8444305528, nCodProd: 7853452187, cProduto: 'PELBD-030', nQtde: 125 },
    });

    const depois = await consultarPedidoCompra('q2p', { nCodPed: 8444305527 });
    expect(depois.produtos[0]!.nQtde).toBe(125);
    // Uma leitura só: a sombra nasce da consulta que o fluxo acabou de fazer —
    // relê-la com o mesmo corpo dispararia a trava de consumo redundante do OMIE.
    expect(metodosEnviados()).toEqual(['ConsultarPedCompra']);
  });

  it('AlteraPedCompra sem leitura recente consulta o pedido real uma vez para semear a sombra', async () => {
    mockFetch.mockResolvedValue(
      respostaOk({
        cabecalho_consulta: { nCodPed: 777, cEtapa: '15' },
        produtos_consulta: [{ nCodItem: 778, nCodProd: 1, cProduto: 'P', nQtde: 1000 }],
      }),
    );
    await alterarPedidoCompra('q2p', {
      nCodPed: 777,
      dDtPrevisao: '04/02/2026',
      nCodFor: 1,
      produto: { nCodItem: 778, nCodProd: 1, cProduto: 'P', nQtde: 400 },
    });
    expect((await consultarPedidoCompra('q2p', { nCodPed: 777 })).produtos[0]!.nQtde).toBe(400);
    expect(metodosEnviados()).toEqual(['ConsultarPedCompra']);
  });

  it('recebimento fiscal: EDITAR → IGNORAR → concluir simulados; a reconsulta enxerga a etapa 60', async () => {
    const chave = '35261014555032000753550010000068421827355174';
    mockFetch.mockResolvedValue(
      respostaOk({
        cabec: { cChaveNFe: chave, cEtapa: '40', cNumeroNFe: '000006842', nIdFornecedor: 8498397152, nIdReceb: 8510564869, nValorNFe: 203400 },
        infoCadastro: { cCancelada: 'N', cRecebido: 'N' },
        itensRecebimento: [
          {
            itensCabec: { cDescricaoProduto: 'SUCATA PLASTICO', cIgnorarItem: 'N', nSequencia: 1, nQtdeNFe: 18000, vTotalItem: 203400 },
            itensAjustes: { cCFOPEntrada: '1.102', cNaoGerarFinanceiro: 'N', cNaoGerarMovEstoque: 'N' },
          },
        ],
      }),
    );

    const rec = await consultarRecebimentoNfe('q2p', { cChaveNfe: chave });
    expect(rec.cRecebido).toBe('N');

    await alterarRecebimentoNfeItens('q2p', {
      nIdReceb: rec.nIdReceb,
      itens: [{ nSequencia: 1, cAcao: 'EDITAR', itensAjustes: { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N' } }],
    });
    await alterarRecebimentoNfeItens('q2p', { nIdReceb: rec.nIdReceb, itens: [{ nSequencia: 1, cAcao: 'IGNORAR' }] });
    await concluirRecebimentoNfe('q2p', { nIdReceb: rec.nIdReceb, cEtapa: '60' });

    const porId = await consultarRecebimentoNfe('q2p', { nIdReceb: rec.nIdReceb });
    const porChave = await consultarRecebimentoNfe('q2p', { cChaveNfe: chave });
    expect(porId.cRecebido).toBe('S');
    expect(porId.cEtapa).toBe('60');
    expect(porId.itens[0]!.cNaoGerarMovEstoque).toBe('S');
    expect(porId.itens[0]!.cIgnorarItem).toBe('S');
    expect(porChave.cEtapa).toBe('60');

    // Só a consulta inicial saiu: a sombra nasceu dela.
    expect(metodosEnviados()).toEqual(['ConsultarRecebimento']);
  });
});

// Feature 017 (ACXEGDP-437): o ASSOCIAR-PEDIDO do AlterarRecebimento também é escrita
// — fica simulado no UAT. A sombra do recebimento guarda o vínculo item x PC e, ao
// concluir, o nQtdeRec do PC (que o OMIE real atualiza sozinho — NF 7813) é
// refletido na sombra do PC. Nada disso relê o OMIE: reler o mesmo corpo dispararia a
// trava de consumo redundante, que vale para a chave do PROD.
describe('OMIE_MODE=leitura — vínculo do item com o PC na sombra (ACXEGDP-437)', () => {
  // Ids do vínculo = os reais da NF 7813 (PC 304); chaves, nIdReceb e valores são sintéticos.
  const CHAVE = '35261014555032000753550010000078131827355174';
  const CHAVE_B = '35261014555032000753550010000078141827355175';
  const NID_RECEB = 8516900001;
  const NID_RECEB_B = 8516900002;
  const PC = 8516905979;
  const ITEM_PC = 8516907022;

  const ASSOCIAR = { nSequencia: 1, cAcao: 'ASSOCIAR-PEDIDO' as const, nIdPedidoExistente: PC, nIdItPedidoExistente: ITEM_PC };
  const EDITAR = {
    nSequencia: 1,
    cAcao: 'EDITAR' as const,
    itensAjustes: { cNaoGerarMovEstoque: 'S' as const, cNaoGerarFinanceiro: 'N' as const },
  };

  /** Bloco de ConsultarRecebimento: 1 item de `qtd` kg, com ou sem o vínculo do OMIE ao PC 304. */
  function blocoRecebimento(
    o: {
      nIdReceb?: number;
      chave?: string;
      etapa?: string;
      recebido?: 'S' | 'N';
      vinculado?: boolean;
      /** Vínculo com nIdPedido mas sem nIdItPedido. */
      semItemDePedido?: boolean;
      /** Item marcado como ignorado (cIgnorarItem 'S'). */
      ignorado?: boolean;
      qtd?: number;
    } = {},
  ) {
    const {
      nIdReceb = NID_RECEB, chave = CHAVE, etapa = '40', recebido = 'N', vinculado = false, semItemDePedido = false,
      ignorado = false, qtd = 18000,
    } = o;
    return {
      cabec: { cChaveNFe: chave, cEtapa: etapa, cNumeroNFe: '000007813', nIdFornecedor: 8498397152, nIdReceb, nValorNFe: 203400 },
      infoCadastro: { cCancelada: 'N', cRecebido: recebido },
      itensRecebimento: [
        {
          itensCabec: {
            cDescricaoProduto: 'SUCATA PLASTICO', cIgnorarItem: ignorado ? 'S' : 'N', cAssociarExistente: vinculado ? 'S' : 'N',
            nSequencia: 1, nQtdeNFe: qtd, vTotalItem: 203400, nIdPedido: vinculado ? PC : 0,
            ...(vinculado && !semItemDePedido ? { nIdItPedido: ITEM_PC } : {}),
          },
          itensAjustes: { cCFOPEntrada: '1.102', cNaoGerarFinanceiro: 'N', cNaoGerarMovEstoque: 'N' },
        },
      ],
    };
  }

  /** Bloco de ConsultarPedCompra: PC 304 aberto, 1 item de 18.000 kg com `nQtdeRec` já recebido. */
  function blocoPedido(nQtdeRec = 0) {
    return {
      cabecalho_consulta: { nCodPed: PC, cCodIntPed: 'ITG304', cNumero: '304', cEtapa: '15', nCodFor: 8498397152 },
      produtos_consulta: [
        { nCodItem: ITEM_PC, nCodProd: 8123584999, cProduto: 'PSCRIST-001', cDescricao: 'PS CRISTAL B', cUnidade: 'KG', nQtde: 18000, nQtdeRec, nValUnit: 11.3 },
      ],
    };
  }

  type Resposta = Record<string, unknown> | ((param: Record<string, unknown>) => Record<string, unknown>);
  /** Responde cada método OMIE pelo nome; método fora do mapa é chamada inesperada à rede (falha o teste). */
  function responder(respostas: Record<string, Resposta>): void {
    mockFetch.mockImplementation((_url: string, init: { body: string }) => {
      const { call, param } = JSON.parse(init.body) as { call: string; param: Array<Record<string, unknown>> };
      const resposta = respostas[call];
      if (resposta === undefined) return Promise.reject(new Error(`chamada inesperada ao OMIE: ${call}`));
      return Promise.resolve(respostaOk(typeof resposta === 'function' ? resposta(param[0] ?? {}) : resposta));
    });
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    ambienteUat();
    __resetMockState();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    process.env = { ...ENV_ORIGINAL };
  });

  it('AlterarRecebimento ASSOCIAR-PEDIDO não chega ao transporte: é bloqueado antes da rede', async () => {
    await expect(
      callOmie('q2p', {
        endpoint: 'produtos/recebimentonfe/',
        method: 'AlterarRecebimento',
        params: { itensRecebimentoEditar: [{ itensIde: { cAcao: 'ASSOCIAR-PEDIDO' } }] },
      }),
    ).rejects.toBeInstanceOf(OmieEscritaBloqueadaError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('ASSOCIAR-PEDIDO é simulado: a sombra guarda o vínculo, o EDITAR o preserva e só a leitura que semeou a sombra sai pela rede', async () => {
    responder({ ConsultarRecebimento: blocoRecebimento() });

    const rec = await consultarRecebimentoNfe('q2p', { cChaveNfe: CHAVE });
    expect(rec.itens[0]).toMatchObject({ cAssociarExistente: 'N', nIdPedido: null, nIdItPedido: null });

    const res = await alterarRecebimentoNfeItens('q2p', { nIdReceb: rec.nIdReceb, itens: [ASSOCIAR] });
    expect(res.cCodStatus).toBe('0');
    await alterarRecebimentoNfeItens('q2p', { nIdReceb: rec.nIdReceb, itens: [EDITAR] });

    const porId = await consultarRecebimentoNfe('q2p', { nIdReceb: rec.nIdReceb });
    const porChave = await consultarRecebimentoNfe('q2p', { cChaveNfe: CHAVE });
    for (const sombra of [porId, porChave]) {
      expect(sombra.itens[0]).toMatchObject({
        cAssociarExistente: 'S', cIgnorarItem: 'N', nIdPedido: PC, nIdItPedido: ITEM_PC, cNaoGerarMovEstoque: 'S',
      });
    }
    // O ASSOCIAR/EDITAR não saíram: só a leitura inicial foi ao OMIE.
    expect(metodosEnviados()).toEqual(['ConsultarRecebimento']);
  });

  it('com a sombra do recebimento já semeada, ASSOCIAR-PEDIDO não faz nenhuma chamada HTTP', async () => {
    registrarSombraRecebimentoNfe('q2p', parseRecebimentoNfeConsultado(blocoRecebimento()));

    await alterarRecebimentoNfeItens('q2p', { nIdReceb: NID_RECEB, itens: [ASSOCIAR] });

    const depois = await consultarRecebimentoNfe('q2p', { nIdReceb: NID_RECEB });
    expect(depois.itens[0]).toMatchObject({ cAssociarExistente: 'S', nIdPedido: PC, nIdItPedido: ITEM_PC });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('ASSOCIAR-PEDIDO em recebimento que o OMIE real já concluiu: a simulação recusa como o OMIE, sem rede', async () => {
    responder({ ConsultarRecebimento: blocoRecebimento({ etapa: '60', recebido: 'S' }) });
    const rec = await consultarRecebimentoNfe('q2p', { nIdReceb: NID_RECEB });

    await expect(alterarRecebimentoNfeItens('q2p', { nIdReceb: rec.nIdReceb, itens: [ASSOCIAR] })).rejects.toBeInstanceOf(
      OmieApiError,
    );
    expect(metodosEnviados()).toEqual(['ConsultarRecebimento']);
  });

  const receitas: Array<[string, boolean]> = [
    ['item sem vínculo: ASSOCIAR-PEDIDO, EDITAR e concluir', false],
    ['item já vinculado pelo OMIE: EDITAR e concluir', true],
  ];
  it.each(receitas)(
    'Concluir soma a quantidade no nQtdeRec da sombra do PC lido há pouco, sem reler o PC — %s',
    async (_rotulo, vinculado) => {
      responder({ ConsultarRecebimento: blocoRecebimento({ vinculado }), ConsultarPedCompra: blocoPedido() });

      // O fluxo lê o PC (confirmação do vínculo) antes de escrever.
      const antes = await consultarPedidoCompra('q2p', { nCodPed: PC });
      expect(antes.produtos[0]).toMatchObject({ nCodItem: ITEM_PC, nQtde: 18000, nQtdeRec: 0 });

      const rec = await consultarRecebimentoNfe('q2p', { cChaveNfe: CHAVE });
      if (!vinculado) await alterarRecebimentoNfeItens('q2p', { nIdReceb: rec.nIdReceb, itens: [ASSOCIAR] });
      await alterarRecebimentoNfeItens('q2p', { nIdReceb: rec.nIdReceb, itens: [EDITAR] });
      await concluirRecebimentoNfe('q2p', { nIdReceb: rec.nIdReceb, cEtapa: '60' });

      const depois = await consultarPedidoCompra('q2p', { nCodPed: PC });
      expect(depois.produtos[0]).toMatchObject({ nCodItem: ITEM_PC, nQtde: 18000, nQtdeRec: 18000 });
      expect(depois.cEtapa).toBe('15');
      // O Concluir não releu o PC (nem a consulta seguinte, que respondeu pela sombra).
      expect(metodosEnviados()).toEqual(['ConsultarPedCompra', 'ConsultarRecebimento']);
    },
  );

  it('EDITAR com nQtdeRecebida (trava de unidade, modo converter) é simulado: a sombra guarda a quantidade e a reconsulta a enxerga, sem rede', async () => {
    responder({ ConsultarRecebimento: blocoRecebimento({ vinculado: true, qtd: 8.25 }), ConsultarPedCompra: blocoPedido() });
    const rec = await consultarRecebimentoNfe('q2p', { cChaveNfe: CHAVE });
    expect(rec.itens[0]!.nQtdeRecebida ?? null).toBeNull();

    await alterarRecebimentoNfeItens('q2p', {
      nIdReceb: rec.nIdReceb,
      itens: [{ nSequencia: 1, cAcao: 'EDITAR', itensAjustes: { cNaoGerarMovEstoque: 'S', cNaoGerarFinanceiro: 'N', nQtdeRecebida: 8250 } }],
    });

    const depois = await consultarRecebimentoNfe('q2p', { nIdReceb: rec.nIdReceb });
    expect(depois.itens[0]).toMatchObject({ nQtdeNFe: 8.25, nQtdeRecebida: 8250, cNaoGerarMovEstoque: 'S', nIdPedido: PC, nIdItPedido: ITEM_PC });
    // só a consulta inicial saiu pela rede; o AlterarRecebimento nunca
    expect(metodosEnviados()).toEqual(['ConsultarRecebimento']);
  });

  it('Concluir soma sobre a sombra do PC que já existe, em vez de semeá-la de novo da leitura antiga', async () => {
    responder({
      ConsultarRecebimento: (param) =>
        param.cChaveNfe === CHAVE_B
          ? blocoRecebimento({ nIdReceb: NID_RECEB_B, chave: CHAVE_B, vinculado: true, qtd: 5000 })
          : blocoRecebimento({ vinculado: true }),
      ConsultarPedCompra: blocoPedido(),
    });
    await consultarPedidoCompra('q2p', { nCodPed: PC }); // leitura real: nQtdeRec 0

    for (const chave of [CHAVE, CHAVE_B]) {
      const rec = await consultarRecebimentoNfe('q2p', { cChaveNfe: chave });
      await alterarRecebimentoNfeItens('q2p', { nIdReceb: rec.nIdReceb, itens: [EDITAR] });
      await concluirRecebimentoNfe('q2p', { nIdReceb: rec.nIdReceb });
    }

    expect((await consultarPedidoCompra('q2p', { nCodPed: PC })).produtos[0]!.nQtdeRec).toBe(23000);
    expect(metodosEnviados()).toEqual(['ConsultarPedCompra', 'ConsultarRecebimento', 'ConsultarRecebimento']);
  });

  it('Concluir sem leitura recente do PC não cria sombra nem consulta o PC: o PC segue o do OMIE real', async () => {
    responder({ ConsultarRecebimento: blocoRecebimento({ vinculado: true }), ConsultarPedCompra: blocoPedido() });
    const rec = await consultarRecebimentoNfe('q2p', { cChaveNfe: CHAVE });
    await alterarRecebimentoNfeItens('q2p', { nIdReceb: rec.nIdReceb, itens: [EDITAR] });

    await concluirRecebimentoNfe('q2p', { nIdReceb: rec.nIdReceb });

    expect(metodosEnviados()).toEqual(['ConsultarRecebimento']);
    expect(sombraPedidoCompra('q2p', { nCodPed: PC })).toBeNull();
    // A simulação não tocou o PC: a leitura seguinte vai ao OMIE real e traz o saldo de lá.
    expect((await consultarPedidoCompra('q2p', { nCodPed: PC })).produtos[0]!.nQtdeRec).toBe(0);
    expect(metodosEnviados()).toEqual(['ConsultarRecebimento', 'ConsultarPedCompra']);
  });

  it('vínculo com nIdPedido mas sem nIdItPedido: não há item de PC a atualizar, então Concluir não cria sombra do PC', async () => {
    responder({
      ConsultarRecebimento: blocoRecebimento({ vinculado: true, semItemDePedido: true }),
      ConsultarPedCompra: blocoPedido(),
    });
    await consultarPedidoCompra('q2p', { nCodPed: PC });
    const rec = await consultarRecebimentoNfe('q2p', { cChaveNfe: CHAVE });
    expect(rec.itens[0]).toMatchObject({ nIdPedido: PC, nIdItPedido: null });
    await alterarRecebimentoNfeItens('q2p', { nIdReceb: rec.nIdReceb, itens: [EDITAR] });

    await concluirRecebimentoNfe('q2p', { nIdReceb: rec.nIdReceb });

    expect(sombraPedidoCompra('q2p', { nCodPed: PC })).toBeNull();
  });

  it('item ignorado, mesmo com vínculo registrado: Concluir não cria sombra do PC', async () => {
    responder({
      ConsultarRecebimento: blocoRecebimento({ vinculado: true, ignorado: true }),
      ConsultarPedCompra: blocoPedido(),
    });
    await consultarPedidoCompra('q2p', { nCodPed: PC });
    const rec = await consultarRecebimentoNfe('q2p', { cChaveNfe: CHAVE });

    await concluirRecebimentoNfe('q2p', { nIdReceb: rec.nIdReceb });

    expect(sombraPedidoCompra('q2p', { nCodPed: PC })).toBeNull();
  });

  it('Concluir de recebimento que o OMIE real já concluiu: a simulação recusa e não cria sombra do PC', async () => {
    responder({
      ConsultarRecebimento: blocoRecebimento({ etapa: '60', recebido: 'S', vinculado: true }),
      ConsultarPedCompra: blocoPedido(18000),
    });
    await consultarPedidoCompra('q2p', { nCodPed: PC });
    const rec = await consultarRecebimentoNfe('q2p', { cChaveNfe: CHAVE });

    await expect(concluirRecebimentoNfe('q2p', { nIdReceb: rec.nIdReceb })).rejects.toBeInstanceOf(OmieApiError);

    expect(sombraPedidoCompra('q2p', { nCodPed: PC })).toBeNull();
    expect(metodosEnviados()).toEqual(['ConsultarPedCompra', 'ConsultarRecebimento']);
  });

  it('leitura do PC com mais de 10 min está expirada: Concluir também não cria a sombra', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    responder({ ConsultarRecebimento: blocoRecebimento({ vinculado: true }), ConsultarPedCompra: blocoPedido() });
    await consultarPedidoCompra('q2p', { nCodPed: PC });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const rec = await consultarRecebimentoNfe('q2p', { cChaveNfe: CHAVE }); // leitura fresca do recebimento
    await alterarRecebimentoNfeItens('q2p', { nIdReceb: rec.nIdReceb, itens: [EDITAR] });

    await concluirRecebimentoNfe('q2p', { nIdReceb: rec.nIdReceb });

    expect(sombraPedidoCompra('q2p', { nCodPed: PC })).toBeNull();
    expect(metodosEnviados()).toEqual(['ConsultarPedCompra', 'ConsultarRecebimento']);
  });
});
