import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feature 013 (ACXEGDP-115): consultarNF mapeia TODOS os det[] para itens[].
// Historico: o det[0] silencioso (pre-STK-10) inflava valor e perdia itens 2..n;
// o STK-10 bloqueava multi-item; a 013 destrava — cada det vira um ItemNF.

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

import { consultarNF } from '../stockbridge/nf.js';

function rawNf(itens: number) {
  const det = Array.from({ length: itens }, (_, i) => ({
    prod: {
      codigo_local_estoque: '4498926337',
      qCom: 25_000,
      uCom: 'KG',
      xProd: `PRODUTO ${i + 1}`,
      vUnCom: 1.2 + i,
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

describe('consultarNF — itens[] (feature 013)', () => {
  beforeEach(() => callOmieSpy.mockReset());

  it('NF de item único vira itens[] de tamanho 1', async () => {
    callOmieSpy.mockResolvedValue(rawNf(1));

    const res = await consultarNF('acxe', 300);

    expect(res.itens).toHaveLength(1);
    expect(res.itens[0]!.nCodProd).toBe(1000);
    expect(res.itens[0]!.qCom).toBe(25_000);
    expect(res.vNF).toBe(30_000);
  });

  it('NF com 3 itens mapeia todos, na ordem do det[], sem lançar', async () => {
    callOmieSpy.mockResolvedValue(rawNf(3));

    const res = await consultarNF('acxe', 300);

    expect(res.itens).toHaveLength(3);
    expect(res.itens.map((i) => i.nCodProd)).toEqual([1000, 1001, 1002]);
    expect(res.itens.map((i) => i.xProd)).toEqual(['PRODUTO 1', 'PRODUTO 2', 'PRODUTO 3']);
    expect(res.itens.map((i) => i.vUnCom)).toEqual([1.2, 2.2, 3.2]);
  });

  it('NF sem itens (det vazio) → erro de estrutura inválida', async () => {
    callOmieSpy.mockResolvedValue({ ...rawNf(1), det: [] });

    await expect(consultarNF('acxe', 300)).rejects.toThrow(/nao possui itens/);
  });

  it('det com linha malformada (sem prod/nfProdInt) é descartada; demais seguem', async () => {
    const raw = rawNf(2);
    (raw.det as unknown[]).push({ prod: null, nfProdInt: null });
    callOmieSpy.mockResolvedValue(raw);

    const res = await consultarNF('acxe', 300);

    expect(res.itens).toHaveLength(2);
  });
});
