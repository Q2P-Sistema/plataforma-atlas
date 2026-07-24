import { callOmie, isMockMode, type OmieCnpj } from '../client.js';
import { mockAlterarPedidoCompra } from './mock.js';

export interface AlterarPedidoCompraInput {
  cCodIntPed: string;
  dDtPrevisao: string; // dd/MM/yyyy
  cCodParc?: string;
  nQtdeParc?: string;
  nCodFor: number;
  cCodIntFor?: string;
  cCodCateg?: string;
  nCodCompr?: string;
  cContato?: string;
  cContrato?: string;
  nCodCC?: string;
  nCodIntCC?: string;
  nCodProj?: string;
  cObs?: string;
  cObsInt?: string;
  produto: {
    cCodIntItem: string;
    cCodIntProd?: string;
    nCodProd: number;
    nCodItem: string;
    cProduto: string;
    cDescricao?: string;
    cNCM?: string;
    cUnidade?: string;
    cEAN?: string;
    nPesoLiq?: string;
    nPesoBruto?: string;
    nQtde: number;
    nValUnit?: string;
    nDesconto?: string;
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
 */
export async function alterarPedidoCompra(
  cnpj: OmieCnpj,
  input: AlterarPedidoCompraInput,
): Promise<AlterarPedidoCompraResponse> {
  if (isMockMode()) {
    return mockAlterarPedidoCompra(cnpj, input);
  }

  const params: Record<string, unknown> = {
    cabecalho_alterar: {
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
    },
    frete_alterar: input.frete ?? {},
    produtos_alterar: [
      {
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
      },
    ],
  };

  const raw = await callOmie<{ codigo_status?: string; descricao_status?: string; codigo_pedido?: number }>(cnpj, {
    endpoint: 'produtos/pedidocompra/',
    method: 'AlteraPedCompra',
    params,
  });

  return {
    status: raw.codigo_status ?? 'ok',
    descricao: raw.descricao_status ?? '',
    codigoPedido: raw.codigo_pedido,
  };
}
