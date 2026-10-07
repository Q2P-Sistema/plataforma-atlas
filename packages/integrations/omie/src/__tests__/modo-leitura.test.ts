import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callOmie, getOmieMode, OmieEscritaBloqueadaError } from '../client.js';
import { incluirAjusteEstoque } from '../stockbridge/ajuste-estoque.js';
import { listarAjusteEstoque } from '../stockbridge/listar-ajuste-estoque.js';
import { alterarPedidoCompra, consultarPedidoCompra } from '../stockbridge/pedido-compra.js';
import {
  alterarRecebimentoNfeItens,
  concluirRecebimentoNfe,
  consultarRecebimentoNfe,
} from '../stockbridge/recebimento-nfe.js';
import { __resetMockState } from '../stockbridge/mock.js';

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
