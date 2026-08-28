import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  alterarPedidoCompra,
  consultarPedidoCompra,
  parsePedidoCompraConsultado,
} from "../stockbridge/pedido-compra.js";
import {
  __resetMockState,
  __injectMockPedidoCompra,
  __getMockPedidoCompra,
} from "../stockbridge/mock.js";

// ACXEGDP-344: baixa do pedido de compra Q2P apos recebimento — o cliente
// precisa (1) consultar o saldo ATUAL do pedido e (2) alterar a quantidade
// absoluta do item. O mock guarda estado para o ciclo consulta→altera→consulta.

describe("OMIE pedido de compra — mock mode (ACXEGDP-344)", () => {
  const originalMode = process.env.OMIE_MODE;

  beforeEach(() => {
    process.env.OMIE_MODE = "mock";
    __resetMockState();
  });
  afterEach(() => {
    process.env.OMIE_MODE = originalMode;
  });

  it("consultarPedidoCompra sem fixture devolve pedido sintetico aberto (etapa 15) com 1 item", async () => {
    const ped = await consultarPedidoCompra("q2p", { nCodPed: 123 });
    expect(ped.nCodPed).toBe(123);
    expect(ped.cEtapa).toBe("15");
    expect(ped.produtos).toHaveLength(1);
    expect(ped.produtos[0]!.nQtde).toBe(100_000);
  });

  it("alterarPedidoCompra grava a nova quantidade e a consulta seguinte reflete (nQtde absoluto)", async () => {
    const base = await consultarPedidoCompra("q2p", { nCodPed: 555 });
    __injectMockPedidoCompra("q2p", base);

    const res = await alterarPedidoCompra("q2p", {
      nCodPed: 555,
      cCodIntPed: base.cCodIntPed ?? undefined,
      dDtPrevisao: base.dDtPrevisao ?? "01/01/2026",
      nCodFor: base.nCodFor,
      cObs: "Estoque alterado anterior: 100000 estoque atual: 75000",
      produto: {
        nCodItem: base.produtos[0]!.nCodItem,
        nCodProd: base.produtos[0]!.nCodProd,
        cProduto: base.produtos[0]!.cProduto,
        nQtde: 75_000,
      },
    });
    expect(res.status).toBe("ok");
    expect(res.codigoPedido).toBe(555);

    const depois = await consultarPedidoCompra("q2p", { nCodPed: 555 });
    expect(depois.produtos[0]!.nQtde).toBe(75_000);
    expect(depois.cObs).toContain("estoque atual: 75000");
    // A consulta devolve copia — mutar o retorno nao altera o estado do mock.
    depois.produtos[0]!.nQtde = 1;
    expect(__getMockPedidoCompra("q2p", 555)!.produtos[0]!.nQtde).toBe(75_000);
  });

  it("__resetMockState limpa os pedidos injetados", async () => {
    const base = await consultarPedidoCompra("q2p", { nCodPed: 777 });
    base.produtos[0]!.nQtde = 5;
    __injectMockPedidoCompra("q2p", base);
    expect(
      (await consultarPedidoCompra("q2p", { nCodPed: 777 })).produtos[0]!.nQtde,
    ).toBe(5);
    __resetMockState();
    expect(
      (await consultarPedidoCompra("q2p", { nCodPed: 777 })).produtos[0]!.nQtde,
    ).toBe(100_000);
  });
});

describe("parsePedidoCompraConsultado — formatos de retorno do OMIE", () => {
  const bloco = {
    cabecalho_consulta: {
      nCodPed: 8444305527,
      cCodIntPed: "ITG536553742263605",
      cNumero: "193",
      cEtapa: "15",
      dDtPrevisao: "04/02/2026",
      nCodFor: 3070534015,
      cObs: "Pedido original ACXE: 423|Obs original: 11",
    },
    frete_consulta: { cTpFrete: "9", nPesoLiq: 24125 },
    produtos_consulta: [
      {
        nCodItem: 8444305528,
        nCodProd: 7853452187,
        cProduto: "PELBD-030",
        cDescricao: "PELBD LB1810E2",
        cUnidade: "KG",
        nQtde: 24125,
        nQtdeRec: 0,
        nValUnit: 0,
        codigo_local_estoque: "8429029971",
      },
    ],
  };

  it("aceita o bloco na raiz", () => {
    const ped = parsePedidoCompraConsultado(bloco, { nCodPed: 8444305527 });
    expect(ped.cNumero).toBe("193");
    expect(ped.cEtapa).toBe("15");
    expect(ped.frete).toEqual({ cTpFrete: "9", nPesoLiq: 24125 });
    expect(ped.produtos[0]).toMatchObject({
      nCodItem: 8444305528,
      nCodProd: 7853452187,
      cCodIntItem: null,
      nQtde: 24125,
      codigoLocalEstoque: "8429029971",
    });
  });

  it("aceita o bloco como 1º item de pedidos_pesquisa e dentro de pedido_compra_produto", () => {
    expect(
      parsePedidoCompraConsultado({ pedidos_pesquisa: [bloco] }, { nCodPed: 1 })
        .cNumero,
    ).toBe("193");
    expect(
      parsePedidoCompraConsultado(
        { pedido_compra_produto: bloco },
        { nCodPed: 1 },
      ).cNumero,
    ).toBe("193");
  });

  it("converte numericos que chegam como string e falha claro sem cabecalho", () => {
    const ped = parsePedidoCompraConsultado(
      {
        cabecalho_consulta: { nCodPed: "10", nCodFor: "20" },
        produtos_consulta: [{ nCodItem: "1", nCodProd: "2", nQtde: "30.5" }],
      },
      { nCodPed: 10 },
    );
    expect(ped.nCodPed).toBe(10);
    expect(ped.produtos[0]!.nQtde).toBe(30.5);
    expect(() =>
      parsePedidoCompraConsultado({ foo: "bar" }, { cCodIntPed: "X" }),
    ).toThrow(/sem cabecalho_consulta/);
  });
});
