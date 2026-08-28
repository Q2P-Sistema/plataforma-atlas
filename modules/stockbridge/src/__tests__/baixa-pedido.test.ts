import { describe, it, expect, vi, beforeEach } from "vitest";

// ACXEGDP-344: baixa do pedido de compra Q2P após recebimento de importação.
//  - alocador FIFO puro (preferido primeiro, sentinela 0,1 kg, resto)
//  - montagem do AlteraPedCompra (quantidade absoluta, obs anexada, nulls fora)
//  - fluxo: consulta ao vivo → ledger pendente → altera → ledger concluída
//  - idempotência: linha pendente cujo alvo já está no OMIE não desconta de novo
//  - desfechos: sem_saldo (alerta) e falha (alerta + retentável)

const poolQuerySpy = vi.fn();
const lockQuerySpy = vi.fn();
const consultarSpy = vi.fn();
const alterarSpy = vi.fn();
const alertaSpy = vi.fn();

vi.mock("@atlas/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getDb: vi.fn(),
  getPool: () => ({
    query: (sql: string, params?: unknown[]) => poolQuerySpy(sql, params),
    connect: () =>
      Promise.resolve({
        query: (sql: string, params?: unknown[]) => lockQuerySpy(sql, params),
        release: vi.fn(),
      }),
  }),
  getConfig: () => ({
    SEED_ADMIN_EMAIL: "admin@atlas.local",
    APP_URL: "https://atlas.test",
  }),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  buildEmailLayout: (o: { titulo?: string }) => ({
    html: String(o?.titulo ?? ""),
    text: String(o?.titulo ?? ""),
  }),
  escapeHtml: (v: unknown) => (v == null ? "" : String(v)),
  emailDataList: () => "",
  emailActionBox: (html: string) => html,
}));

vi.mock("@atlas/db", () => ({
  movimentacao: { __id: "movimentacao", id: {}, ativo: {} },
  lote: { __id: "lote", id: {} },
  baixaPedidoQ2p: {
    __id: "baixaPedidoQ2p",
    id: {},
    movimentacaoId: {},
    ativo: {},
  },
  users: { __id: "users" },
  userModules: { __id: "userModules" },
}));

vi.mock("@atlas/integration-omie", () => ({
  consultarPedidoCompra: (...args: unknown[]) => consultarSpy(...args),
  alterarPedidoCompra: (...args: unknown[]) => alterarSpy(...args),
  isMockMode: () => false,
}));

vi.mock("../services/notificacao.service.js", () => ({
  enviarAlertaBaixaPedidoQ2p: (...args: unknown[]) => alertaSpy(...args),
}));

import {
  planejarAlocacao,
  montarInputAlteracao,
  anexarObsBaixa,
  processarBaixaPedidoQ2p,
  listarPedidosAbertosQ2p,
  BaixaPedidoNaoAplicavelError,
  ETAPA_PEDIDO_Q2P_ABERTO,
} from "../services/baixa-pedido.service.js";
import { QTD_SENTINELA_PEDIDO_ZERADO_KG } from "../types.js";

// ── Alocador puro ──────────────────────────────────────────────────────────────

describe("planejarAlocacao (FIFO, paridade com o legado)", () => {
  const cand = (ncodped: number, saldoKg: number, preferido = false) => ({
    ncodped,
    cnumero: String(ncodped),
    ncoditem: ncodped + 1,
    saldoKg,
    preferido,
  });

  it("desconta do primeiro pedido quando o saldo cobre tudo", () => {
    const plano = planejarAlocacao(25_000, [cand(1, 100_000), cand(2, 50_000)]);
    expect(plano.alocacoes).toHaveLength(1);
    expect(plano.alocacoes[0]).toMatchObject({
      ncodped: 1,
      kgAlocado: 25_000,
      saldoAnteriorKg: 100_000,
      saldoNovoKg: 75_000,
      zerado: false,
    });
    expect(plano.restanteKg).toBe(0);
  });

  it("zera o primeiro (sentinela 0,1) e segue para o próximo em FIFO", () => {
    const plano = planejarAlocacao(60_000, [cand(1, 50_000), cand(2, 50_000)]);
    expect(
      plano.alocacoes.map((a) => [
        a.ncodped,
        a.kgAlocado,
        a.saldoNovoKg,
        a.zerado,
      ]),
    ).toEqual([
      [1, 50_000, QTD_SENTINELA_PEDIDO_ZERADO_KG, true],
      [2, 10_000, 40_000, false],
    ]);
    expect(plano.restanteKg).toBe(0);
  });

  it("saldo exatamente igual ao recebido → pedido zerado com sentinela (nunca nQtde=0)", () => {
    const plano = planejarAlocacao(27_000, [cand(1, 27_000)]);
    expect(plano.alocacoes[0]!.saldoNovoKg).toBe(0.1);
    expect(plano.alocacoes[0]!.zerado).toBe(true);
  });

  it("pedido preferido (casado com o pedido ACXE da NF) vem antes mesmo estando depois na FIFO", () => {
    const plano = planejarAlocacao(10_000, [
      cand(1, 100_000),
      cand(2, 100_000, true),
    ]);
    expect(plano.alocacoes[0]!.ncodped).toBe(2);
    expect(plano.alocacoes[0]!.preferido).toBe(true);
  });

  it("pula pedidos já zerados (saldo <= sentinela) e devolve o resto sem pedido", () => {
    const plano = planejarAlocacao(1_000, [
      cand(1, 0.1),
      cand(2, 0),
      cand(3, 400),
    ]);
    expect(plano.alocacoes.map((a) => a.ncodped)).toEqual([3]);
    expect(plano.restanteKg).toBe(600);
  });

  it("mantém 3 casas decimais sem erro de ponto flutuante", () => {
    const plano = planejarAlocacao(0.3, [cand(1, 0.7)]);
    expect(plano.alocacoes[0]!.saldoNovoKg).toBe(0.4);
  });
});

// ── Montagem do AlteraPedCompra ────────────────────────────────────────────────

function pedidoFixture(overrides: Partial<ReturnType<typeof basePedido>> = {}) {
  return { ...basePedido(), ...overrides };
}
function basePedido() {
  return {
    nCodPed: 8444305527,
    cCodIntPed: "ITG536553742263605",
    cNumero: "193",
    cEtapa: "15",
    dDtPrevisao: "04/02/2026",
    dIncData: "14/03/2026",
    nCodFor: 3070534015,
    cCodIntFor: null,
    cCodParc: "000",
    nQtdeParc: 1,
    cCodCateg: "2.01.01",
    nCodCompr: 0,
    cContato: null,
    cContrato: null,
    nCodCC: 3010012043,
    nCodIntCC: null,
    nCodProj: 0,
    cObs: "Pedido original ACXE: 423",
    cObsInt: null,
    frete: { cTpFrete: "9" },
    produtos: [
      {
        nCodItem: 8444305528,
        cCodIntItem: null,
        nCodProd: 7853452187,
        cCodIntProd: null,
        cProduto: "PELBD-030",
        cDescricao: "PELBD LB1810E2",
        cNCM: "3901.10.30",
        cUnidade: "KG",
        cEAN: null,
        nPesoLiq: 1,
        nPesoBruto: 1,
        nQtde: 24125,
        nQtdeRec: 0,
        nValUnit: 0,
        nDesconto: 0,
        codigoLocalEstoque: "8429029971",
      },
    ],
  };
}

describe("montarInputAlteracao / anexarObsBaixa", () => {
  it("envia quantidade ABSOLUTA, identifica o item por nCodItem e omite nulls", () => {
    const pedido = pedidoFixture();
    const input = montarInputAlteracao({
      pedido,
      item: pedido.produtos[0]!,
      saldoAnteriorKg: 24125,
      saldoNovoKg: 4125,
      notaFiscal: "00005161",
    });
    expect(input.nCodPed).toBe(8444305527);
    expect(input.cCodIntPed).toBe("ITG536553742263605");
    expect(input.produto.nQtde).toBe(4125);
    expect(input.produto.nCodItem).toBe(8444305528);
    expect(input.produto.cCodIntItem).toBeUndefined(); // espelho vem sem cCodIntItem
    expect(input.cContato).toBeUndefined();
    expect(input.frete).toEqual({ cTpFrete: "9" });
    expect(input.cObs).toContain("Pedido original ACXE: 423");
    expect(input.cObs).toContain("NF 00005161");
    expect(input.cObs).toContain("24125 kg -> 4125 kg");
    expect(input.cObsInt).toContain("NF 00005161");
  });

  it("anexarObsBaixa preserva o texto anterior e limita o tamanho", () => {
    expect(anexarObsBaixa(null, "5161", 10, 5, "24/08/2026")).toMatch(
      /^Atlas — NF 5161/,
    );
    const longa = "x".repeat(5000);
    const out = anexarObsBaixa(longa, "5161", 10, 5, "24/08/2026");
    expect(out.length).toBeLessThanOrEqual(3000);
    expect(out.endsWith("10 kg -> 5 kg")).toBe(true);
  });
});

// ── Fluxo com banco/OMIE mockados ──────────────────────────────────────────────

interface Cenario {
  mov: Record<string, unknown> | null;
  lote?: Record<string, unknown> | null;
  ledger?: Array<Record<string, unknown>>;
}

const inserts: Array<Record<string, unknown>> = [];
const updates: Array<{ table: string; set: Record<string, unknown> }> = [];

function montarDb(c: Cenario) {
  let tabela = "";
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn((t: { __id: string }) => {
    tabela = t.__id;
    return chain;
  });
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => {
    if (tabela === "movimentacao") return Promise.resolve(c.mov ? [c.mov] : []);
    if (tabela === "lote") return Promise.resolve(c.lote ? [c.lote] : []);
    return Promise.resolve([]);
  });
  // await db.select().from(baixaPedidoQ2p).where(...) sem limit → ledger
  chain.then = (resolve: (rows: unknown[]) => void) =>
    resolve(tabela === "baixaPedidoQ2p" ? (c.ledger ?? []) : []);
  chain.update = vi.fn((t: { __id: string }) => ({
    set: (valores: Record<string, unknown>) => {
      updates.push({ table: t.__id, set: valores });
      return { where: () => Promise.resolve(undefined) };
    },
  }));
  chain.insert = vi.fn(() => ({
    values: (v: Record<string, unknown>) => {
      inserts.push(v);
      return {
        returning: () => Promise.resolve([{ id: `ledger-${inserts.length}` }]),
        then: (r: (x: unknown) => void) => r(undefined),
      };
    },
  }));
  return chain;
}

const MOV_OK = {
  id: "mov-1",
  ativo: true,
  tipoMovimento: "entrada_nf",
  subtipo: "importacao",
  statusOmie: "concluida",
  baixaPedidoQ2p: "pendente",
  notaFiscal: "00005161",
  quantidadeKg: "27000.000",
  produtoCodigoQ2p: 7853452187,
  loteId: "lote-1",
};

function respostaPool(sql: string): { rows: unknown[] } {
  if (sql.includes("tbl_produtos_Q2P"))
    return { rows: [{ descricao: "PELBD LB1810E2" }] };
  if (sql.includes("nf_pedido_filhote")) return { rows: [] };
  if (sql.includes("tbl_pedidosCompras_Q2P")) {
    return {
      rows: [
        {
          ncodped: "100",
          cnumero: "193",
          ncoditem: "101",
          nqtde: "24125.00",
          pedido_acxe: "423",
        },
        {
          ncodped: "200",
          cnumero: "194",
          ncoditem: "201",
          nqtde: "50000.00",
          pedido_acxe: "424",
        },
      ],
    };
  }
  return { rows: [] };
}

function pedidoLive(nCodPed: number, nQtde: number) {
  const p = pedidoFixture({
    nCodPed,
    cNumero: nCodPed === 100 ? "193" : "194",
  });
  p.produtos[0] = { ...p.produtos[0]!, nCodItem: nCodPed + 1, nQtde };
  return p;
}

beforeEach(async () => {
  vi.clearAllMocks();
  inserts.length = 0;
  updates.length = 0;
  poolQuerySpy.mockImplementation((sql: string) =>
    Promise.resolve(respostaPool(sql)),
  );
  lockQuerySpy.mockResolvedValue({ rows: [] });
  consultarSpy.mockImplementation((_cnpj: string, ref: { nCodPed: number }) =>
    Promise.resolve(
      pedidoLive(ref.nCodPed, ref.nCodPed === 100 ? 24125 : 50000),
    ),
  );
  alterarSpy.mockResolvedValue({
    status: "ok",
    descricao: "ok",
    codigoPedido: 1,
  });
  const { getDb } = await import("@atlas/core");
  vi.mocked(getDb).mockReturnValue(
    montarDb({
      mov: MOV_OK,
      lote: {
        id: "lote-1",
        codigo: "L001",
        produtoCodigoQ2p: 7853452187,
        pedidoCompraAcxe: null,
      },
    }) as never,
  );
});

describe("processarBaixaPedidoQ2p — fluxo", () => {
  it("FIFO: zera o pedido 193 (sentinela) e desconta o resto do 194; ledger pendente→concluída; movimentação concluída", async () => {
    const res = await processarBaixaPedidoQ2p({
      movimentacaoId: "mov-1",
      origem: "fluxo",
    });

    expect(res.status).toBe("concluida");
    expect(res.restanteKg).toBe(0);
    expect(
      res.alocacoes.map((a) => [a.ncodped, a.kgAlocado, a.saldoNovoKg]),
    ).toEqual([
      [100, 24125, 0.1],
      [200, 2875, 47125],
    ]);
    // Consulta AO VIVO de cada pedido antes de alterar
    expect(consultarSpy).toHaveBeenCalledTimes(2);
    expect(consultarSpy).toHaveBeenNthCalledWith(1, "q2p", { nCodPed: 100 });
    // AlteraPedCompra com quantidade absoluta
    expect(alterarSpy).toHaveBeenCalledTimes(2);
    expect(alterarSpy.mock.calls[0]![1]).toMatchObject({
      nCodPed: 100,
      produto: { nCodItem: 101, nQtde: 0.1 },
    });
    expect(alterarSpy.mock.calls[1]![1]).toMatchObject({
      nCodPed: 200,
      produto: { nCodItem: 201, nQtde: 47125 },
    });
    // Ledger: insert 'pendente' antes, update 'concluida' depois, para cada pedido
    expect(
      inserts.map((i) => [i.ncodped, i.status, i.quantidadeKg, i.saldoNovoKg]),
    ).toEqual([
      [100, "pendente", "24125", "0.1"],
      [200, "pendente", "2875", "47125"],
    ]);
    const ledgerUpdates = updates
      .filter((u) => u.table === "baixaPedidoQ2p")
      .map((u) => u.set.status);
    expect(ledgerUpdates).toEqual(["concluida", "concluida"]);
    const movUpdate = updates.find((u) => u.table === "movimentacao");
    expect(movUpdate?.set).toMatchObject({ baixaPedidoQ2p: "concluida" });
    // Lock consultivo por produto adquirido e liberado
    expect(lockQuerySpy.mock.calls[0]![0]).toContain("pg_advisory_lock");
    expect(lockQuerySpy.mock.calls.at(-1)![0]).toContain("pg_advisory_unlock");
    expect(alertaSpy).not.toHaveBeenCalled();
  });

  it("pedido casado com o pedido ACXE da NF (mapa) é descontado primeiro", async () => {
    poolQuerySpy.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes("nf_pedido_filhote")
          ? { rows: [{ pedido_acxe_omie: "424" }] }
          : respostaPool(sql),
      ),
    );
    const res = await processarBaixaPedidoQ2p({
      movimentacaoId: "mov-1",
      origem: "fluxo",
    });
    expect(res.pedidosAcxePreferidos).toEqual(["424"]);
    expect(res.alocacoes.map((a) => a.ncodped)).toEqual([200]);
    expect(res.alocacoes[0]).toMatchObject({
      preferido: true,
      saldoNovoKg: 23000,
    });
  });

  it("sem pedido aberto suficiente → sem_saldo, linha sem_pedido no ledger e alerta ops", async () => {
    consultarSpy.mockImplementation((_c: string, ref: { nCodPed: number }) =>
      Promise.resolve(pedidoLive(ref.nCodPed, 10_000)),
    );
    const res = await processarBaixaPedidoQ2p({
      movimentacaoId: "mov-1",
      origem: "fluxo",
    });
    expect(res.status).toBe("sem_saldo");
    expect(res.restanteKg).toBe(7000);
    expect(inserts.at(-1)).toMatchObject({
      ncodped: null,
      status: "sem_pedido",
      quantidadeKg: "7000",
    });
    expect(updates.find((u) => u.table === "movimentacao")?.set).toMatchObject({
      baixaPedidoQ2p: "sem_saldo",
    });
    expect(alertaSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        motivo: "sem_saldo",
        restanteKg: 7000,
        notaFiscal: "00005161",
      }),
    );
  });

  it("OMIE falha no AlteraPedCompra → ledger falha, movimentação falha, alerta; pedidos anteriores ficam concluídos", async () => {
    alterarSpy
      .mockResolvedValueOnce({ status: "ok", descricao: "ok" })
      .mockRejectedValueOnce(new Error("OMIE q2p 500: SOAP-ENV:Client"));
    const res = await processarBaixaPedidoQ2p({
      movimentacaoId: "mov-1",
      origem: "fluxo",
    });
    expect(res.status).toBe("falha");
    expect(res.erro).toContain("194");
    expect(res.alocacoes).toHaveLength(1); // só o primeiro concluiu
    const statusLedger = updates
      .filter((u) => u.table === "baixaPedidoQ2p")
      .map((u) => u.set.status);
    expect(statusLedger).toEqual(["concluida", "falha"]);
    expect(updates.find((u) => u.table === "movimentacao")?.set).toMatchObject({
      baixaPedidoQ2p: "falha",
    });
    expect(alertaSpy).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: "falha" }),
    );
  });

  it("retry: linha pendente cujo alvo já está no OMIE vira concluída SEM nova chamada (quantidade absoluta não é descontada 2x)", async () => {
    const { getDb } = await import("@atlas/core");
    vi.mocked(getDb).mockReturnValue(
      montarDb({
        mov: { ...MOV_OK, baixaPedidoQ2p: "falha" },
        lote: { id: "lote-1", codigo: "L001", produtoCodigoQ2p: 7853452187 },
        ledger: [
          {
            id: "l-1",
            ncodped: 100,
            status: "concluida",
            quantidadeKg: "24125",
            saldoAnteriorKg: "24125",
            saldoNovoKg: "0.1",
            tentativas: 1,
          },
          // a chamada do 194 "falhou" na resposta mas persistiu: saldo ao vivo == alvo
          {
            id: "l-2",
            ncodped: 200,
            status: "falha",
            quantidadeKg: "2875",
            saldoAnteriorKg: "50000",
            saldoNovoKg: "47125",
            tentativas: 1,
          },
        ],
      }) as never,
    );
    consultarSpy.mockImplementation((_c: string, ref: { nCodPed: number }) =>
      Promise.resolve(
        pedidoLive(ref.nCodPed, ref.nCodPed === 200 ? 47125 : 0.1),
      ),
    );

    const res = await processarBaixaPedidoQ2p({
      movimentacaoId: "mov-1",
      origem: "retry",
      ator: { userId: "u1", role: "gestor" },
    });
    expect(res.status).toBe("concluida");
    expect(res.kgJaDescontadoAntes).toBe(27000);
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(
      updates
        .filter((u) => u.table === "baixaPedidoQ2p")
        .map((u) => u.set.status),
    ).toEqual(["concluida"]);
  });

  it("retry: linha falha cujo alvo NÃO está no OMIE reaproveita a linha (tentativas+1) e chama de novo", async () => {
    const { getDb } = await import("@atlas/core");
    vi.mocked(getDb).mockReturnValue(
      montarDb({
        mov: { ...MOV_OK, baixaPedidoQ2p: "falha" },
        lote: { id: "lote-1", codigo: "L001", produtoCodigoQ2p: 7853452187 },
        ledger: [
          {
            id: "l-1",
            ncodped: 100,
            status: "concluida",
            quantidadeKg: "24125",
            saldoAnteriorKg: "24125",
            saldoNovoKg: "0.1",
            tentativas: 1,
          },
          {
            id: "l-2",
            ncodped: 200,
            status: "falha",
            quantidadeKg: "2875",
            saldoAnteriorKg: "50000",
            saldoNovoKg: "47125",
            tentativas: 1,
          },
        ],
      }) as never,
    );
    const res = await processarBaixaPedidoQ2p({
      movimentacaoId: "mov-1",
      origem: "retry",
    });
    expect(res.status).toBe("concluida");
    expect(alterarSpy).toHaveBeenCalledTimes(1);
    expect(alterarSpy.mock.calls[0]![1]).toMatchObject({
      nCodPed: 200,
      produto: { nQtde: 47125 },
    });
    expect(inserts).toHaveLength(0);
    const reuso = updates.find(
      (u) => u.table === "baixaPedidoQ2p" && u.set.status === "pendente",
    );
    expect(reuso?.set).toMatchObject({ tentativas: 2, origem: "retry" });
  });

  it("dry-run: consulta ao vivo, simula com saldos encadeados e não escreve nada", async () => {
    const simulacao = new Map<number, number>([[100, 5000]]); // NF anterior já "gastou" o 193
    const res = await processarBaixaPedidoQ2p({
      movimentacaoId: "mov-1",
      origem: "backfill",
      dryRun: true,
      simulacaoSaldos: simulacao,
    });
    expect(res.status).toBe("simulado");
    expect(res.statusPrevisto).toBe("concluida");
    expect(
      res.alocacoes.map((a) => [a.ncodped, a.saldoAnteriorKg, a.saldoNovoKg]),
    ).toEqual([
      [100, 5000, 0.1],
      [200, 50000, 28000],
    ]);
    expect(simulacao.get(200)).toBe(28000);
    expect(alterarSpy).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(lockQuerySpy).not.toHaveBeenCalled();
  });

  it("ajuste dual ainda pendente → aguardando_omie (nada consultado)", async () => {
    const { getDb } = await import("@atlas/core");
    vi.mocked(getDb).mockReturnValue(
      montarDb({ mov: { ...MOV_OK, statusOmie: "pendente_q2p" } }) as never,
    );
    const res = await processarBaixaPedidoQ2p({
      movimentacaoId: "mov-1",
      origem: "fluxo",
    });
    expect(res.status).toBe("aguardando_omie");
    expect(consultarSpy).not.toHaveBeenCalled();
  });

  it("já concluída → idempotente, sem chamadas", async () => {
    const { getDb } = await import("@atlas/core");
    vi.mocked(getDb).mockReturnValue(
      montarDb({ mov: { ...MOV_OK, baixaPedidoQ2p: "concluida" } }) as never,
    );
    const res = await processarBaixaPedidoQ2p({
      movimentacaoId: "mov-1",
      origem: "retry",
    });
    expect(res.status).toBe("concluida");
    expect(consultarSpy).not.toHaveBeenCalled();
  });

  it("saída/nacional → BaixaPedidoNaoAplicavelError", async () => {
    const { getDb } = await import("@atlas/core");
    vi.mocked(getDb).mockReturnValue(
      montarDb({
        mov: { ...MOV_OK, tipoMovimento: "saida_manual", subtipo: "amostra" },
      }) as never,
    );
    await expect(
      processarBaixaPedidoQ2p({ movimentacaoId: "mov-1", origem: "fluxo" }),
    ).rejects.toBeInstanceOf(BaixaPedidoNaoAplicavelError);
  });

  it("produto sem correlato Q2P (nem na movimentação nem no lote) → falha registrada", async () => {
    const { getDb } = await import("@atlas/core");
    vi.mocked(getDb).mockReturnValue(
      montarDb({
        mov: { ...MOV_OK, produtoCodigoQ2p: null },
        lote: { id: "lote-1", codigo: "L001", produtoCodigoQ2p: null },
      }) as never,
    );
    const res = await processarBaixaPedidoQ2p({
      movimentacaoId: "mov-1",
      origem: "fluxo",
    });
    expect(res.status).toBe("falha");
    expect(res.erro).toContain("correlato");
    expect(updates.find((u) => u.table === "movimentacao")?.set).toMatchObject({
      baixaPedidoQ2p: "falha",
    });
  });
});

describe("listarPedidosAbertosQ2p — SQL do espelho", () => {
  it("filtra etapa aberta, saldo acima da sentinela, ordena por previsão e marca o preferido pelo cobs", async () => {
    const out = await listarPedidosAbertosQ2p(7853452187, new Set(["424"]));
    const [sql, params] = poolQuerySpy.mock.calls.find((c) =>
      String(c[0]).includes("tbl_pedidosCompras_Q2P"),
    )!;
    expect(sql).toContain("cetapa = $2");
    expect(sql).toContain("nqtde > $3");
    expect(sql).toContain("ORDER BY p.ddtprevisao");
    expect(sql).toContain("Pedido original ACXE");
    expect(params).toEqual([
      7853452187,
      ETAPA_PEDIDO_Q2P_ABERTO,
      QTD_SENTINELA_PEDIDO_ZERADO_KG,
    ]);
    expect(out.map((c) => [c.ncodped, c.saldoKg, c.preferido])).toEqual([
      [100, 24125, false],
      [200, 50000, true],
    ]);
  });
});
