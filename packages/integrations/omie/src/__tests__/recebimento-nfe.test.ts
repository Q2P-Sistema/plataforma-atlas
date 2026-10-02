import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('fornecedor ausente (nao cadastrado no OMIE) vira null, nao string vazia', () => {
    const rec = parseRecebimentoNfeConsultado({
      cabec: { nIdReceb: 1, cChaveNFe: '3'.repeat(44), cNumeroNFe: '000001257', cEtapa: '40' },
      infoCadastro: { cRecebido: 'N', cCancelada: 'N' },
      itensRecebimento: [],
    });
    expect(rec.cRazaoSocial).toBeNull();
    expect(rec.cCNPJ_CPF).toBeNull();
    expect(rec.itens).toEqual([]);
  });
});
