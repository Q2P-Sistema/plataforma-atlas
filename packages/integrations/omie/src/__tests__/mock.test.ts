import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { consultarNF } from '../stockbridge/nf.js';
import { incluirAjusteEstoque } from '../stockbridge/ajuste-estoque.js';
import { alterarPedidoCompra } from '../stockbridge/pedido-compra.js';

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
