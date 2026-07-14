import { describe, it, expect, vi, beforeEach } from 'vitest';

// STK-10 (ACXEGDP-289): consultarNF lia so det[0] silenciosamente — NF
// multi-item inflava o valor unitario (vNF total / qtd do item 1) e os itens
// 2..n nunca entravam em estoque. Agora rejeita explicito com erro tipado.

vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const callOmieSpy = vi.fn();
vi.mock('../client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../client.js')>();
  return {
    ...real,
    callOmie: (...args: unknown[]) => callOmieSpy(...args),
    isMockMode: () => false,
  };
});

import { consultarNF, NotaFiscalMultiItemError } from '../stockbridge/nf.js';

function rawNf(itens: number) {
  const det = Array.from({ length: itens }, (_, i) => ({
    prod: {
      codigo_local_estoque: '4498926337',
      qCom: 25_000,
      uCom: 'KG',
      xProd: `PRODUTO ${i + 1}`,
      vUnCom: 1.2,
    },
    nfProdInt: { nCodProd: 1000 + i },
  }));
  return {
    ide: { nNF: 300, dEmi: '15/04/2026' },
    compl: { cChaveNFe: 'CHAVE' },
    det,
    total: { ICMSTot: { vNF: 30_000 } },
    nfDestInt: { nCodCli: 1, cRazao: 'FORNECEDOR' },
  };
}

describe('consultarNF — NF multi-item (STK-10)', () => {
  beforeEach(() => callOmieSpy.mockReset());

  it('NF de item único segue funcionando', async () => {
    callOmieSpy.mockResolvedValue(rawNf(1));

    const res = await consultarNF('acxe', 300);

    expect(res.nCodProd).toBe(1000);
    expect(res.qCom).toBe(25_000);
  });

  it('NF com 2+ itens → NotaFiscalMultiItemError (não lê det[0] silenciosamente)', async () => {
    callOmieSpy.mockResolvedValue(rawNf(3));

    await expect(consultarNF('acxe', 300)).rejects.toThrow(NotaFiscalMultiItemError);
    await expect(consultarNF('acxe', 300)).rejects.toThrow(/3 itens/);
  });

  it('erro carrega nf e totalItens para o alerta admin', async () => {
    callOmieSpy.mockResolvedValue(rawNf(2));

    const err = await consultarNF('acxe', 555).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotaFiscalMultiItemError);
    expect((err as NotaFiscalMultiItemError).notaFiscal).toBe(555);
    expect((err as NotaFiscalMultiItemError).totalItens).toBe(2);
  });
});
