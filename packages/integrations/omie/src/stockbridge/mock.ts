import type { OmieCnpj } from '../client.js';
import type { ConsultarNFResponse } from './nf.js';
import type { IncluirAjusteEstoqueInput, IncluirAjusteEstoqueResponse } from './ajuste-estoque.js';
import type { AlterarPedidoCompraInput, AlterarPedidoCompraResponse } from './pedido-compra.js';
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

export function mockAlterarPedidoCompra(
  cnpj: OmieCnpj,
  input: AlterarPedidoCompraInput,
): AlterarPedidoCompraResponse {
  return {
    status: 'ok',
    descricao: `Pedido ${input.cCodIntPed} alterado (mock) em ${cnpj}`,
    codigoPedido: 99_999,
  };
}
