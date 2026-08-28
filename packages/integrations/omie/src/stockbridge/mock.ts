import type { OmieCnpj } from '../client.js';
import type { ConsultarNFResponse } from './nf.js';
import type { IncluirAjusteEstoqueInput, IncluirAjusteEstoqueResponse } from './ajuste-estoque.js';
import type {
  AlterarPedidoCompraInput,
  AlterarPedidoCompraResponse,
  PedidoCompraConsultado,
} from './pedido-compra.js';
import type {
  ListarAjusteEstoqueInput,
  ListarAjusteEstoqueResponse,
  AjusteEstoqueListado,
} from './listar-ajuste-estoque.js';

/**
 * Implementacao mock da API OMIE para dev sem credenciais (OMIE_MODE=mock).
 * Retorna respostas sinteticas deterministicas.
 */

let mockIdSeq = 1_000_000;
function nextMockId(): string { mockIdSeq += 1; return String(mockIdSeq); }

interface MockAjusteRegistrado extends AjusteEstoqueListado {
  cnpj: OmieCnpj;
}

const ajustesRegistrados: MockAjusteRegistrado[] = [];

/**
 * Limpa o estado do mock. Use entre testes para evitar vazamento.
 */
export function __resetMockState(): void {
  ajustesRegistrados.length = 0;
  pedidosRegistrados.length = 0;
  mockIdSeq = 1_000_000;
}

/**
 * Injeta um ajuste pre-existente no mock. Util em testes que precisam simular
 * "esse cod_int_ajuste ja foi processado em uma chamada anterior".
 */
export function __injectMockAjuste(cnpj: OmieCnpj, ajuste: AjusteEstoqueListado): void {
  ajustesRegistrados.push({ ...ajuste, cnpj });
}

/**
 * Fixtures de NF por final do numero (feature 013 — multi-item):
 *  - final 2 → 2 itens (ambos com correlato: PEAD 5502 + PP RAFIA)
 *  - final 3 → 3 itens (PEAD 5502 + PP RAFIA + "PRODUTO SEM CORRELATO MOCK")
 *  - demais  → 1 item (PEAD 5502 — comportamento historico, single-item)
 * Card ACXEGDP-301: qCom=25 com uCom='t' (25 t = 25.000 kg) exercita a
 * conversao de unidade real (converterParaKg) em dev.
 */
export function mockConsultarNF(cnpj: OmieCnpj, numeroNota: number): ConsultarNFResponse {
  const localEstoque = cnpj === 'acxe' ? '4498926337' : '8115873874';
  const itemPead = {
    nCodProd: cnpj === 'acxe' ? 4_452_881_285 : 3_033_098_357,
    codigoLocalEstoque: localEstoque,
    qCom: 25,
    uCom: 't',
    xProd: 'PEAD 5502',
    vUnCom: 1.2,
  };
  const itemPpRafia = {
    nCodProd: cnpj === 'acxe' ? 4_452_881_290 : 3_033_098_360,
    codigoLocalEstoque: localEstoque,
    qCom: 10,
    uCom: 't',
    xProd: 'PP RAFIA',
    vUnCom: 1.5,
  };
  const itemSemCorrelato = {
    nCodProd: 4_452_889_999,
    codigoLocalEstoque: localEstoque,
    qCom: 5,
    uCom: 't',
    xProd: 'PRODUTO SEM CORRELATO MOCK',
    vUnCom: 2,
  };

  const final = numeroNota % 10;
  const itens =
    final === 2 ? [itemPead, itemPpRafia]
    : final === 3 ? [itemPead, itemPpRafia, itemSemCorrelato]
    : [itemPead];

  // vNF proporcional ao valor comercial (mantendo os 30_000 historicos p/ 1 item
  // de 25 t — os testes single-item existentes dependem desse numero).
  const somaComercial = itens.reduce((acc, it) => acc + it.vUnCom * it.qCom * 1000, 0);
  const vNF = Math.round(somaComercial);

  return {
    nNF: numeroNota,
    cChaveNFe: `MOCK-CHAVE-${cnpj}-${numeroNota}`,
    dEmi: '15/04/2026',
    vNF,
    nCodCli: 12345,
    cRazao: 'FORNECEDOR MOCK',
    itens,
  };
}

export function mockIncluirAjusteEstoque(
  cnpj: OmieCnpj,
  input: IncluirAjusteEstoqueInput,
): IncluirAjusteEstoqueResponse {
  const idMovest = `MOCK-MOVEST-${cnpj}-${nextMockId()}`;
  const idAjuste = `MOCK-AJUSTE-${cnpj}-${nextMockId()}`;

  // Registra para que ListarAjusteEstoque consiga achar via cod_int_ajuste.
  ajustesRegistrados.push({
    cnpj,
    idMovest,
    idAjuste,
    codIntAjuste: input.codIntAjuste ?? null,
    dataMovimento: input.dataAtual,
    codigoLocalEstoque: input.codigoLocalEstoque,
    idProduto: input.idProduto,
    quantidade: input.quantidade,
    valor: input.valor,
    observacao: input.observacao,
  });

  return {
    idMovest,
    idAjuste,
    descricaoStatus: 'Ajuste registrado (mock)',
  };
}

export function mockListarAjusteEstoque(
  cnpj: OmieCnpj,
  input: ListarAjusteEstoqueInput,
): ListarAjusteEstoqueResponse {
  const filtrados = ajustesRegistrados
    .filter((a) => a.cnpj === cnpj)
    .filter((a) => (input.codIntAjuste ? a.codIntAjuste === input.codIntAjuste : true))
    .filter((a) => (input.codigoLocalEstoque ? a.codigoLocalEstoque === input.codigoLocalEstoque : true))
    .filter((a) => (input.idProduto !== undefined ? a.idProduto === input.idProduto : true))
    .filter((a) => (input.dataMovimentoDe ? a.dataMovimento >= input.dataMovimentoDe : true))
    .filter((a) => (input.dataMovimentoAte ? a.dataMovimento <= input.dataMovimentoAte : true));

  const registrosPorPagina = input.registrosPorPagina ?? 50;
  const pagina = input.pagina ?? 1;
  const inicio = (pagina - 1) * registrosPorPagina;
  const slice = filtrados.slice(inicio, inicio + registrosPorPagina);

  return {
    pagina,
    totalDePaginas: Math.max(1, Math.ceil(filtrados.length / registrosPorPagina)),
    registros: slice.length,
    totalDeRegistros: filtrados.length,
    ajustes: slice.map(({ cnpj: _cnpj, ...rest }) => rest),
  };
}

// ── Pedido de compra (ACXEGDP-344) ────────────────────────────────────────────

interface MockPedidoRegistrado {
  cnpj: OmieCnpj;
  pedido: PedidoCompraConsultado;
}

/**
 * Pedidos de compra em memória: ConsultarPedCompra lê daqui e AlteraPedCompra
 * grava a nova quantidade do item — assim o fluxo de baixa (consulta → altera →
 * consulta) é verificável em dev/teste sem OMIE real.
 */
const pedidosRegistrados: MockPedidoRegistrado[] = [];

/** Injeta um pedido pre-existente no mock (testes da baixa de pedido Q2P). */
export function __injectMockPedidoCompra(cnpj: OmieCnpj, pedido: PedidoCompraConsultado): void {
  const idx = pedidosRegistrados.findIndex((p) => p.cnpj === cnpj && p.pedido.nCodPed === pedido.nCodPed);
  const entry = { cnpj, pedido: structuredClone(pedido) };
  if (idx >= 0) pedidosRegistrados[idx] = entry;
  else pedidosRegistrados.push(entry);
}

/** Snapshot (cópia) de um pedido registrado no mock — para asserts em teste. */
export function __getMockPedidoCompra(cnpj: OmieCnpj, nCodPed: number): PedidoCompraConsultado | null {
  const found = pedidosRegistrados.find((p) => p.cnpj === cnpj && p.pedido.nCodPed === nCodPed);
  return found ? structuredClone(found.pedido) : null;
}

function acharPedidoMock(
  cnpj: OmieCnpj,
  ref: { nCodPed?: number; cCodIntPed?: string },
): MockPedidoRegistrado | undefined {
  return pedidosRegistrados.find(
    (p) =>
      p.cnpj === cnpj &&
      ((ref.nCodPed != null && p.pedido.nCodPed === ref.nCodPed) ||
        (ref.cCodIntPed != null && p.pedido.cCodIntPed === ref.cCodIntPed)),
  );
}

export function mockConsultarPedidoCompra(
  cnpj: OmieCnpj,
  ref: { nCodPed: number } | { cCodIntPed: string },
): PedidoCompraConsultado {
  const found = acharPedidoMock(cnpj, ref);
  if (found) return structuredClone(found.pedido);
  // Sem fixture injetada: pedido sintetico com 1 item de 100.000 kg do produto
  // PEAD 5502 (mesmo nCodProd do mockConsultarNF), etapa 15 (aberto).
  const nCodPed = 'nCodPed' in ref ? ref.nCodPed : 88_000_001;
  return {
    nCodPed,
    cCodIntPed: 'cCodIntPed' in ref ? ref.cCodIntPed : `MOCK-PED-${nCodPed}`,
    cNumero: String(nCodPed % 1000),
    cEtapa: '15',
    dDtPrevisao: '15/04/2026',
    dIncData: '01/04/2026',
    nCodFor: 12345,
    cCodIntFor: null,
    cCodParc: '000',
    nQtdeParc: 1,
    cCodCateg: '2.01.01',
    nCodCompr: 0,
    cContato: null,
    cContrato: null,
    nCodCC: null,
    nCodIntCC: null,
    nCodProj: 0,
    cObs: 'Pedido original ACXE: 1',
    cObsInt: null,
    frete: {},
    produtos: [
      {
        nCodItem: nCodPed + 1,
        cCodIntItem: null,
        nCodProd: cnpj === 'acxe' ? 4_452_881_285 : 3_033_098_357,
        cCodIntProd: null,
        cProduto: 'PEAD-001',
        cDescricao: 'PEAD 5502',
        cNCM: '3901.20.29',
        cUnidade: 'KG',
        cEAN: null,
        nPesoLiq: 1,
        nPesoBruto: 1,
        nQtde: 100_000,
        nQtdeRec: 0,
        nValUnit: 0,
        nDesconto: 0,
        codigoLocalEstoque: cnpj === 'acxe' ? '4498926337' : '8115873874',
      },
    ],
  };
}

export function mockAlterarPedidoCompra(
  cnpj: OmieCnpj,
  input: AlterarPedidoCompraInput,
): AlterarPedidoCompraResponse {
  const found = acharPedidoMock(cnpj, { nCodPed: input.nCodPed, cCodIntPed: input.cCodIntPed });
  if (found) {
    const item = found.pedido.produtos.find(
      (p) => String(p.nCodItem) === String(input.produto.nCodItem) || p.nCodProd === input.produto.nCodProd,
    );
    if (item) item.nQtde = input.produto.nQtde;
    if (input.cObs !== undefined) found.pedido.cObs = input.cObs;
    if (input.cObsInt !== undefined) found.pedido.cObsInt = input.cObsInt;
    if (input.dDtPrevisao) found.pedido.dDtPrevisao = input.dDtPrevisao;
  }
  return {
    status: 'ok',
    descricao: `Pedido ${input.cCodIntPed ?? input.nCodPed} alterado (mock) em ${cnpj}`,
    codigoPedido: found?.pedido.nCodPed ?? input.nCodPed ?? 99_999,
  };
}
