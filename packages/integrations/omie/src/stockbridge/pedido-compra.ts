import { callOmie, isMockMode, type OmieCnpj } from "../client.js";
import { mockAlterarPedidoCompra, mockConsultarPedidoCompra } from "./mock.js";

export interface AlterarPedidoCompraInput {
  /** Identificação do pedido: cCodIntPed (código de integração) e/ou nCodPed (id OMIE). */
  cCodIntPed?: string;
  nCodPed?: number;
  dDtPrevisao: string; // dd/MM/yyyy
  cCodParc?: string;
  nQtdeParc?: string | number;
  nCodFor: number;
  cCodIntFor?: string;
  cCodCateg?: string;
  nCodCompr?: string | number;
  cContato?: string;
  cContrato?: string;
  nCodCC?: string | number;
  nCodIntCC?: string;
  nCodProj?: string | number;
  cObs?: string;
  cObsInt?: string;
  produto: {
    /**
     * Identificação do item: cCodIntItem (integração) e/ou nCodItem (id OMIE).
     * ACXEGDP-344: os pedidos Q2P espelhados da ACXE vêm SEM cCodIntItem —
     * o nCodItem é a chave que sempre existe.
     */
    cCodIntItem?: string;
    cCodIntProd?: string;
    nCodProd: number;
    nCodItem: string | number;
    cProduto: string;
    cDescricao?: string;
    cNCM?: string;
    cUnidade?: string;
    cEAN?: string;
    nPesoLiq?: string | number;
    nPesoBruto?: string | number;
    nQtde: number;
    nValUnit?: string | number;
    nDesconto?: string | number;
    codigoLocalEstoque?: string;
  };
  frete?: Record<string, unknown>;
}

export interface AlterarPedidoCompraResponse {
  status: string;
  descricao: string;
  codigoPedido?: number;
}

/**
 * Altera um pedido de compra no OMIE Q2P, reduzindo a quantidade conforme consumo do estoque.
 * Herdado do legado PHP — endpoint produtos/pedidocompra/ -> AlteraPedCompra.
 * Excecao documentada ao Principio II.
 *
 * ATENÇÃO: `nQtde` é ABSOLUTO (nova quantidade do item), não um delta. O OMIE
 * rejeita quantidade 0 — o legado (e o Atlas, ACXEGDP-344) usam a sentinela
 * 0,1 kg para "pedido zerado" (ver QTD_SENTINELA_PEDIDO_ZERADO no StockBridge).
 */
export async function alterarPedidoCompra(
  cnpj: OmieCnpj,
  input: AlterarPedidoCompraInput,
): Promise<AlterarPedidoCompraResponse> {
  if (isMockMode()) {
    return mockAlterarPedidoCompra(cnpj, input);
  }
  if (!input.cCodIntPed && input.nCodPed == null) {
    throw new Error("alterarPedidoCompra exige cCodIntPed ou nCodPed");
  }

  const params: Record<string, unknown> = {
    cabecalho_alterar: semUndefined({
      nCodPed: input.nCodPed,
      cCodIntPed: input.cCodIntPed,
      dDtPrevisao: input.dDtPrevisao,
      cCodParc: input.cCodParc,
      nQtdeParc: input.nQtdeParc,
      nCodFor: input.nCodFor,
      cCodIntFor: input.cCodIntFor,
      cCodCateg: input.cCodCateg,
      nCodCompr: input.nCodCompr,
      cContato: input.cContato,
      cContrato: input.cContrato,
      nCodCC: input.nCodCC,
      nCodIntCC: input.nCodIntCC,
      nCodProj: input.nCodProj,
      cObs: input.cObs,
      cObsInt: input.cObsInt,
    }),
    frete_alterar: input.frete ?? {},
    produtos_alterar: [
      semUndefined({
        cCodIntItem: input.produto.cCodIntItem,
        cCodIntProd: input.produto.cCodIntProd,
        nCodProd: input.produto.nCodProd,
        nCodItem: input.produto.nCodItem,
        cProduto: input.produto.cProduto,
        cDescricao: input.produto.cDescricao,
        cNCM: input.produto.cNCM,
        cUnidade: input.produto.cUnidade,
        cEAN: input.produto.cEAN,
        nPesoLiq: input.produto.nPesoLiq,
        nPesoBruto: input.produto.nPesoBruto,
        nQtde: input.produto.nQtde,
        nValUnit: input.produto.nValUnit,
        nDesconto: input.produto.nDesconto,
        codigo_local_estoque: input.produto.codigoLocalEstoque,
      }),
    ],
  };

  const raw = await callOmie<{
    codigo_status?: string;
    descricao_status?: string;
    codigo_pedido?: number;
    cCodStatus?: string;
    cDescStatus?: string;
    nCodPed?: number;
  }>(cnpj, {
    endpoint: "produtos/pedidocompra/",
    method: "AlteraPedCompra",
    params,
  });

  return {
    status: raw.cCodStatus ?? raw.codigo_status ?? "ok",
    descricao: raw.cDescStatus ?? raw.descricao_status ?? "",
    codigoPedido: raw.nCodPed ?? raw.codigo_pedido,
  };
}

// ── ConsultarPedCompra (ACXEGDP-344) ───────────────────────────────────────────

export interface ItemPedidoCompra {
  nCodItem: number;
  cCodIntItem: string | null;
  nCodProd: number;
  cCodIntProd: string | null;
  cProduto: string;
  cDescricao: string | null;
  cNCM: string | null;
  cUnidade: string | null;
  cEAN: string | null;
  nPesoLiq: number | null;
  nPesoBruto: number | null;
  /** Quantidade ATUAL do item (o legado/Atlas reduzem este campo a cada recebimento). */
  nQtde: number;
  nQtdeRec: number | null;
  nValUnit: number | null;
  nDesconto: number | null;
  codigoLocalEstoque: string | null;
}

export interface PedidoCompraConsultado {
  nCodPed: number;
  cCodIntPed: string | null;
  cNumero: string | null;
  cEtapa: string | null;
  dDtPrevisao: string | null; // dd/MM/yyyy (como o OMIE devolve)
  dIncData: string | null;
  nCodFor: number;
  cCodIntFor: string | null;
  cCodParc: string | null;
  nQtdeParc: number | null;
  cCodCateg: string | null;
  nCodCompr: number | null;
  cContato: string | null;
  cContrato: string | null;
  nCodCC: number | null;
  nCodIntCC: string | null;
  nCodProj: number | null;
  cObs: string | null;
  cObsInt: string | null;
  frete: Record<string, unknown>;
  produtos: ItemPedidoCompra[];
}

type RawPedido = {
  cabecalho_consulta?: Record<string, unknown>;
  frete_consulta?: Record<string, unknown>;
  produtos_consulta?: Array<Record<string, unknown>>;
};

/**
 * Consulta um pedido de compra por id OMIE (nCodPed) ou código de integração.
 * Endpoint produtos/pedidocompra/ -> ConsultarPedCompra. Leitura idempotente —
 * retry em falha transiente (STK-23).
 *
 * Por que consultar ao vivo (exceção ao Princípio II, justificada em
 * ACXEGDP-344): o espelho `public."tbl_pedidosCompras_Q2P"` sincroniza 1×/dia;
 * a baixa do pedido precisa do saldo ATUAL (dois recebimentos do mesmo produto
 * no mesmo dia calculariam o saldo errado a partir do espelho). O AlteraPedCompra
 * envia quantidade absoluta, então ler desatualizado = corromper o pedido.
 *
 * Formato do retorno: o mesmo bloco `cabecalho_consulta` / `frete_consulta` /
 * `produtos_consulta` que o PesquisarPedCompra devolve em `pedidos_pesquisa[]`
 * (é o que o workflow n8n de sincronização do espelho consome). O parser
 * aceita o bloco na raiz, em `pedido_compra_produto` ou como 1º item de
 * `pedidos_pesquisa`.
 */
export async function consultarPedidoCompra(
  cnpj: OmieCnpj,
  ref: { nCodPed: number } | { cCodIntPed: string },
): Promise<PedidoCompraConsultado> {
  if (isMockMode()) {
    return mockConsultarPedidoCompra(cnpj, ref);
  }

  const raw = await callOmie<Record<string, unknown>>(
    cnpj,
    {
      endpoint: "produtos/pedidocompra/",
      method: "ConsultarPedCompra",
      params:
        "nCodPed" in ref
          ? { nCodPed: ref.nCodPed }
          : { cCodIntPed: ref.cCodIntPed },
    },
    { retries: 2 },
  );
  return parsePedidoCompraConsultado(raw, ref);
}

export function parsePedidoCompraConsultado(
  raw: Record<string, unknown>,
  ref: { nCodPed: number } | { cCodIntPed: string },
): PedidoCompraConsultado {
  const pesquisa = raw.pedidos_pesquisa;
  const candidato: RawPedido | undefined =
    Array.isArray(pesquisa) && pesquisa.length > 0
      ? (pesquisa[0] as RawPedido)
      : raw.pedido_compra_produto &&
          typeof raw.pedido_compra_produto === "object"
        ? (raw.pedido_compra_produto as RawPedido)
        : (raw as RawPedido);

  const cab = candidato?.cabecalho_consulta;
  if (!cab || typeof cab !== "object") {
    const refTxt =
      "nCodPed" in ref
        ? `nCodPed=${ref.nCodPed}`
        : `cCodIntPed=${ref.cCodIntPed}`;
    // Chaves de 1º nível na mensagem: se o OMIE devolver outro envelope, o erro
    // já diz qual — evita uma rodada só para capturar a resposta crua.
    const chaves = Object.keys(raw ?? {}).slice(0, 12).join(', ') || '(vazio)';
    throw new Error(
      `ConsultarPedCompra (${refTxt}): resposta sem cabecalho_consulta — chaves recebidas: ${chaves}`,
    );
  }
  const produtos = (candidato.produtos_consulta ?? []).map((p) => ({
    nCodItem: num(p.nCodItem) ?? 0,
    cCodIntItem: str(p.cCodIntItem),
    nCodProd: num(p.nCodProd) ?? 0,
    cCodIntProd: str(p.cCodIntProd),
    cProduto: str(p.cProduto) ?? "",
    cDescricao: str(p.cDescricao),
    cNCM: str(p.cNCM),
    cUnidade: str(p.cUnidade),
    cEAN: str(p.cEAN),
    nPesoLiq: num(p.nPesoLiq),
    nPesoBruto: num(p.nPesoBruto),
    nQtde: num(p.nQtde) ?? 0,
    nQtdeRec: num(p.nQtdeRec),
    nValUnit: num(p.nValUnit),
    nDesconto: num(p.nDesconto),
    codigoLocalEstoque: str(p.codigo_local_estoque),
  }));

  return {
    nCodPed: num(cab.nCodPed) ?? ("nCodPed" in ref ? ref.nCodPed : 0),
    cCodIntPed: str(cab.cCodIntPed),
    cNumero: str(cab.cNumero),
    cEtapa: str(cab.cEtapa),
    dDtPrevisao: str(cab.dDtPrevisao),
    dIncData: str(cab.dIncData),
    nCodFor: num(cab.nCodFor) ?? 0,
    cCodIntFor: str(cab.cCodIntFor),
    cCodParc: str(cab.cCodParc),
    nQtdeParc: num(cab.nQtdeParc),
    cCodCateg: str(cab.cCodCateg),
    nCodCompr: num(cab.nCodCompr),
    cContato: str(cab.cContato),
    cContrato: str(cab.cContrato),
    nCodCC: num(cab.nCodCC),
    nCodIntCC: str(cab.nCodIntCC),
    nCodProj: num(cab.nCodProj),
    cObs: str(cab.cObs),
    cObsInt: str(cab.cObsInt),
    frete: candidato.frete_consulta ?? {},
    produtos,
  };
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function semUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}
