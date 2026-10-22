import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { consultarNF } from '../stockbridge/nf.js';
import { incluirAjusteEstoque } from '../stockbridge/ajuste-estoque.js';
import { alterarPedidoCompra, consultarPedidoCompra } from '../stockbridge/pedido-compra.js';
import {
  alterarRecebimentoNfeItens,
  concluirRecebimentoNfe,
  consultarRecebimentoNfe,
} from '../stockbridge/recebimento-nfe.js';
import { listarAjusteEstoque } from '../stockbridge/listar-ajuste-estoque.js';
import {
  __resetMockState,
  __injectMockPedidoCompra,
  __getMockPedidoCompra,
  __injectMockRecebimentoNfe,
} from '../stockbridge/mock.js';
import { OmieApiError, type OmieCnpj } from '../client.js';

describe('OMIE integration — mock mode', () => {
  const originalMode = process.env.OMIE_MODE;

  beforeEach(() => {
    process.env.OMIE_MODE = 'mock';
  });

  afterEach(() => {
    process.env.OMIE_MODE = originalMode;
  });

  it('consultarNF retorna payload sintetico deterministico (1 item)', async () => {
    const res = await consultarNF('acxe', 1234);
    expect(res.nNF).toBe(1234);
    expect(res.itens).toHaveLength(1);
    expect(res.itens[0]!.codigoLocalEstoque).toBe('4498926337'); // SANTO ANDRE 11.1 ACXE
    expect(res.itens[0]!.qCom).toBe(25);
    expect(res.itens[0]!.uCom).toBe('t');
    expect(res.vNF).toBe(30_000);
  });

  it('consultarNF para Q2P retorna codigo de localidade Q2P', async () => {
    const res = await consultarNF('q2p', 5678);
    expect(res.itens[0]!.codigoLocalEstoque).toBe('8115873874');
  });

  it('feature 013: NF com final 2 → 2 itens; final 3 → 3 itens (um sem correlato)', async () => {
    const nf2 = await consultarNF('acxe', 4302);
    expect(nf2.itens).toHaveLength(2);
    expect(nf2.itens.map((i) => i.xProd)).toEqual(['PEAD 5502', 'PP RAFIA']);

    const nf3 = await consultarNF('acxe', 4303);
    expect(nf3.itens).toHaveLength(3);
    expect(nf3.itens[2]!.xProd).toBe('PRODUTO SEM CORRELATO MOCK');
    // vNF = soma comercial das linhas (25t×1.2 + 10t×1.5 + 5t×2.0)
    expect(nf3.vNF).toBe(30_000 + 15_000 + 10_000);
  });

  it('incluirAjusteEstoque retorna idMovest e idAjuste sinteticos', async () => {
    const res = await incluirAjusteEstoque('acxe', {
      codigoLocalEstoque: '4498926337',
      idProduto: 123,
      dataAtual: '16/04/2026',
      quantidade: 25,
      observacao: 'teste',
      origem: 'AJU',
      tipo: 'ENT',
      motivo: 'INI',
      valor: 1200,
    });
    expect(res.idMovest).toMatch(/^MOCK-MOVEST-acxe-\d+$/);
    expect(res.idAjuste).toMatch(/^MOCK-AJUSTE-acxe-\d+$/);
    expect(res.descricaoStatus).toContain('mock');
  });

  it('incluirAjusteEstoque diferencia CNPJ no id retornado', async () => {
    const acxe = await incluirAjusteEstoque('acxe', {
      codigoLocalEstoque: '4498926337', idProduto: 1, dataAtual: '16/04/2026', quantidade: 10,
      observacao: '', origem: 'AJU', tipo: 'ENT', motivo: 'INI', valor: 100,
    });
    const q2p = await incluirAjusteEstoque('q2p', {
      codigoLocalEstoque: '8115873874', idProduto: 1, dataAtual: '16/04/2026', quantidade: 10,
      observacao: '', origem: 'AJU', tipo: 'ENT', motivo: 'INI', valor: 100,
    });
    expect(acxe.idMovest).toContain('acxe');
    expect(q2p.idMovest).toContain('q2p');
  });

  it('alterarPedidoCompra retorna sucesso mock', async () => {
    const res = await alterarPedidoCompra('q2p', {
      cCodIntPed: 'PED-123',
      dDtPrevisao: '16/04/2026',
      nCodFor: 999,
      produto: {
        cCodIntItem: 'ITEM-1',
        nCodProd: 12345,
        nCodItem: '1',
        cProduto: 'PP RAFIA',
        nQtde: 10,
      },
    });
    expect(res.status).toBe('ok');
    expect(res.descricao).toContain('PED-123');
    expect(res.descricao).toContain('q2p');
  });
});

// Feature 017 (ACXEGDP-437): o mock reproduz o que o OMIE real fez nas NFs 7813 e
// 7736 (21/10/2026) — ASSOCIAR-PEDIDO grava o vinculo item x PC, EDITAR o preserva,
// IGNORAR o desfaz e ConcluirRecebimento soma a quantidade no nQtdeRec do PC.
describe('OMIE integration — mock mode: vinculo do item com o pedido de compra (ACXEGDP-437)', () => {
  const originalMode = process.env.OMIE_MODE;
  const NF = 8516900001; // nIdReceb sintetico
  const PC = 8516905979; // nCodPed do PC 304 (NF 7813)
  const ITEM_PC = 8516907022; // nCodItem do PC 304

  beforeEach(() => {
    process.env.OMIE_MODE = 'mock';
    __resetMockState();
  });
  afterEach(() => {
    if (originalMode === undefined) delete process.env.OMIE_MODE;
    else process.env.OMIE_MODE = originalMode;
  });

  const associar = (nSequencia: number, nIdPedidoExistente: number, nIdItPedidoExistente: number) => ({
    nSequencia,
    cAcao: 'ASSOCIAR-PEDIDO' as const,
    nIdPedidoExistente,
    nIdItPedidoExistente,
  });
  const editar = (nSequencia: number) => ({
    nSequencia,
    cAcao: 'EDITAR' as const,
    itensAjustes: { cNaoGerarMovEstoque: 'S' as const, cNaoGerarFinanceiro: 'N' as const },
  });
  const ignorar = (nSequencia: number) => ({ nSequencia, cAcao: 'IGNORAR' as const });

  /** Recebimento sintetico do mock: etapa 40, 1 item de 18.000 kg ("SUCATA PLASTICO"), sem vinculo. */
  const abrirRecebimento = (nIdReceb = NF) => consultarRecebimentoNfe('q2p', { nIdReceb });
  /** Item `nSequencia` do recebimento, como a consulta o devolve. */
  const item = async (nSequencia = 1, nIdReceb = NF) =>
    (await consultarRecebimentoNfe('q2p', { nIdReceb })).itens.find((i) => i.nSequencia === nSequencia)!;
  const alterar = (itens: Parameters<typeof alterarRecebimentoNfeItens>[1]['itens'], nIdReceb = NF) =>
    alterarRecebimentoNfeItens('q2p', { nIdReceb, itens });

  /** PC aberto (etapa 15) com 1 item de 18.000 kg ainda sem recebimento. */
  async function injetarPc(nCodPed: number, nCodItem: number, opts: { cnpj?: OmieCnpj; nQtdeRec?: number | null } = {}) {
    const cnpj = opts.cnpj ?? 'q2p';
    const pc = await consultarPedidoCompra(cnpj, { nCodPed });
    pc.produtos[0]!.nCodItem = nCodItem;
    pc.produtos[0]!.nQtde = 18_000;
    pc.produtos[0]!.nQtdeRec = opts.nQtdeRec === undefined ? 0 : opts.nQtdeRec;
    __injectMockPedidoCompra(cnpj, pc);
  }
  /** nQtdeRec do 1o item do PC no estado do mock. */
  const nQtdeRec = (nCodPed = PC, cnpj: OmieCnpj = 'q2p') => __getMockPedidoCompra(cnpj, nCodPed)!.produtos[0]!.nQtdeRec;

  it('ASSOCIAR-PEDIDO vincula o item e a consulta devolve o vinculo; o EDITAR seguinte preserva o vinculo', async () => {
    await abrirRecebimento();
    expect(await item()).toMatchObject({ cAssociarExistente: 'N', nIdPedido: null, nIdItPedido: null });

    const res = await alterar([associar(1, PC, ITEM_PC)]);
    expect(res.cCodStatus).toBe('0');
    expect(await item()).toMatchObject({ cAssociarExistente: 'S', cIgnorarItem: 'N', nIdPedido: PC, nIdItPedido: ITEM_PC });

    await alterar([editar(1)]);
    expect(await item()).toMatchObject({
      cAssociarExistente: 'S',
      cIgnorarItem: 'N',
      nIdPedido: PC,
      nIdItPedido: ITEM_PC,
      cNaoGerarMovEstoque: 'S',
      cNaoGerarFinanceiro: 'N',
    });
  });

  it('ASSOCIAR-PEDIDO substitui o vinculo anterior e reativa o item que estava ignorado', async () => {
    await abrirRecebimento();
    await alterar([associar(1, PC, ITEM_PC)]);
    await alterar([associar(1, 222, 2222)]);
    expect(await item()).toMatchObject({ nIdPedido: 222, nIdItPedido: 2222 });

    await alterar([ignorar(1)]);
    expect(await item()).toMatchObject({ cIgnorarItem: 'S' });
    await alterar([associar(1, PC, ITEM_PC)]);
    expect(await item()).toMatchObject({ cIgnorarItem: 'N', cAssociarExistente: 'S', nIdPedido: PC, nIdItPedido: ITEM_PC });
  });

  it('IGNORAR desfaz o vinculo (NF 7736) sem desfazer os ajustes ja gravados', async () => {
    await abrirRecebimento();
    await alterar([associar(1, PC, ITEM_PC)]);
    await alterar([editar(1)]);
    await alterar([ignorar(1)]);
    expect(await item()).toMatchObject({
      cIgnorarItem: 'S',
      cAssociarExistente: 'N',
      nIdPedido: null,
      nIdItPedido: null,
      nIdProduto: 0,
      cNaoGerarMovEstoque: 'S',
    });
  });

  it('ASSOCIAR-PEDIDO com o recebimento fora da etapa 40 falha e nao altera o recebimento', async () => {
    const rec = await abrirRecebimento();
    __injectMockRecebimentoNfe('q2p', { ...rec, cEtapa: '50' });
    const tentativa = () => alterar([associar(1, PC, ITEM_PC)]);
    await expect(tentativa()).rejects.toBeInstanceOf(OmieApiError);
    await expect(tentativa()).rejects.toThrow(/etapa 40 \(etapa atual: 50\)/);
    expect(await item()).toMatchObject({ cAssociarExistente: 'N', nIdPedido: null, nIdItPedido: null });
  });

  it('ASSOCIAR-PEDIDO em recebimento ja concluido falha como qualquer outra alteracao', async () => {
    const rec = await abrirRecebimento();
    __injectMockRecebimentoNfe('q2p', { ...rec, cEtapa: '60', cRecebido: 'S' });
    await expect(alterar([associar(1, PC, ITEM_PC)])).rejects.toThrow(/ja esta concluido/);
    expect(await item()).toMatchObject({ nIdPedido: null, nIdItPedido: null });
  });

  it('chamada recusada nao aplica nenhum item (o mock e atomico por chamada)', async () => {
    await abrirRecebimento();
    await expect(alterar([associar(1, PC, ITEM_PC), associar(9, PC, ITEM_PC)])).rejects.toThrow(/nSequencia=9/);
    expect(await item()).toMatchObject({ cAssociarExistente: 'N', nIdPedido: null, nIdItPedido: null });
  });

  it('concluir soma a quantidade do item no nQtdeRec do PC vinculado (0 -> 18000), sem tocar no resto do PC nem no estoque', async () => {
    await injetarPc(PC, ITEM_PC);
    await abrirRecebimento();
    await alterar([associar(1, PC, ITEM_PC)]);
    await alterar([editar(1)]);
    expect(nQtdeRec()).toBe(0); // so o Concluir atualiza o PC

    await concluirRecebimentoNfe('q2p', { nIdReceb: NF, cEtapa: '60' });

    const pc = await consultarPedidoCompra('q2p', { nCodPed: PC });
    expect(pc.produtos[0]).toMatchObject({ nCodItem: ITEM_PC, nQtde: 18_000, nQtdeRec: 18_000 });
    expect(pc.cEtapa).toBe('15');
    // o vinculo continua no recebimento concluido (NF 7813)
    expect(await item()).toMatchObject({ nIdPedido: PC, nIdItPedido: ITEM_PC });
    // nenhum ajuste de estoque nas duas empresas
    expect((await listarAjusteEstoque('q2p', {})).totalDeRegistros).toBe(0);
    expect((await listarAjusteEstoque('acxe', {})).totalDeRegistros).toBe(0);
  });

  it('item ja vinculado pelo OMIE (sem ASSOCIAR-PEDIDO) tambem atualiza o PC ao concluir', async () => {
    await injetarPc(PC, ITEM_PC);
    const rec = await abrirRecebimento();
    Object.assign(rec.itens[0]!, { cAssociarExistente: 'S', nIdPedido: PC, nIdItPedido: ITEM_PC, nNumPedCompra: '304' });
    __injectMockRecebimentoNfe('q2p', rec);

    await alterar([editar(1)]);
    await concluirRecebimentoNfe('q2p', { nIdReceb: NF });

    expect(nQtdeRec()).toBe(18_000);
  });

  it('nQtdeRec nulo conta como 0 e as somas acumulam entre recebimentos, sem ruido de ponto flutuante', async () => {
    await injetarPc(PC, ITEM_PC, { nQtdeRec: null });
    const concluirNf = async (nIdReceb: number, qtdeNfe: number) => {
      const rec = await abrirRecebimento(nIdReceb);
      rec.itens[0]!.nQtdeNFe = qtdeNfe;
      __injectMockRecebimentoNfe('q2p', rec);
      await alterar([associar(1, PC, ITEM_PC)], nIdReceb);
      await concluirRecebimentoNfe('q2p', { nIdReceb });
    };

    await concluirNf(NF, 0.1);
    expect(nQtdeRec()).toBe(0.1);
    await concluirNf(NF + 1, 0.2);
    expect(nQtdeRec()).toBe(0.3); // 0.1 + 0.2 puro daria 0.30000000000000004
    await concluirNf(NF + 2, 5_000);
    expect(nQtdeRec()).toBe(5_000.3);
  });

  it('item ignorado nao mexe no PC: o IGNORAR desfaz o vinculo antes de concluir', async () => {
    await injetarPc(PC, ITEM_PC);
    await injetarPc(222, 2222);
    const rec = await abrirRecebimento();
    rec.itens.push({ ...rec.itens[0]!, nSequencia: 2, cDescricaoProduto: 'APARA PLASTICO', nQtdeNFe: 5_000 });
    __injectMockRecebimentoNfe('q2p', rec);

    await alterar([associar(1, PC, ITEM_PC), associar(2, 222, 2222)]);
    await alterar([ignorar(2)]);
    await concluirRecebimentoNfe('q2p', { nIdReceb: NF });

    expect(nQtdeRec(PC)).toBe(18_000);
    expect(nQtdeRec(222)).toBe(0);
  });

  it('item marcado como ignorado nao conta mesmo que o registro traga um vinculo', async () => {
    await injetarPc(PC, ITEM_PC);
    const rec = await abrirRecebimento();
    Object.assign(rec.itens[0]!, { cIgnorarItem: 'S', cAssociarExistente: 'S', nIdPedido: PC, nIdItPedido: ITEM_PC });
    __injectMockRecebimentoNfe('q2p', rec);

    await concluirRecebimentoNfe('q2p', { nIdReceb: NF });

    expect(nQtdeRec()).toBe(0);
  });

  it('PC que o mock nao conhece: concluir funciona e nao cria o PC', async () => {
    await abrirRecebimento();
    await alterar([associar(1, PC, ITEM_PC)]);

    await expect(concluirRecebimentoNfe('q2p', { nIdReceb: NF })).resolves.toMatchObject({ cCodStatus: '0' });

    expect(__getMockPedidoCompra('q2p', PC)).toBeNull();
  });

  it('item de PC que nao existe no pedido: nada muda no PC', async () => {
    await injetarPc(PC, ITEM_PC);
    await abrirRecebimento();
    await alterar([associar(1, PC, 999_999)]);

    await concluirRecebimentoNfe('q2p', { nIdReceb: NF });

    expect(nQtdeRec()).toBe(0);
  });

  it('PC de outra empresa com o mesmo nCodPed e nCodItem nao e tocado', async () => {
    await injetarPc(PC, ITEM_PC, { cnpj: 'acxe' });
    await abrirRecebimento();
    await alterar([associar(1, PC, ITEM_PC)]);

    await concluirRecebimentoNfe('q2p', { nIdReceb: NF });

    expect(nQtdeRec(PC, 'acxe')).toBe(0);
  });
});

describe('OMIE integration — credenciais ausentes', () => {
  const originalMode = process.env.OMIE_MODE;
  const originalKey = process.env.OMIE_ACXE_KEY;
  const originalSecret = process.env.OMIE_ACXE_SECRET;

  beforeEach(() => {
    process.env.OMIE_MODE = 'real';
    delete process.env.OMIE_ACXE_KEY;
    delete process.env.OMIE_ACXE_SECRET;
  });

  afterEach(() => {
    process.env.OMIE_MODE = originalMode;
    if (originalKey !== undefined) process.env.OMIE_ACXE_KEY = originalKey;
    if (originalSecret !== undefined) process.env.OMIE_ACXE_SECRET = originalSecret;
  });

  it('chamada real sem credenciais lanca erro descritivo', async () => {
    await expect(consultarNF('acxe', 1)).rejects.toThrow(/OMIE_ACXE_KEY/);
  });
});
