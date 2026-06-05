export { callOmie, isMockMode, OmieApiError, type OmieCnpj, type OmieEndpoint, type OmieCredentials } from './client.js';

// StockBridge integration
export { consultarNF, type ConsultarNFResponse } from './stockbridge/nf.js';
export {
  incluirAjusteEstoque,
  type AjusteTipo,
  type AjusteMotivo,
  type AjusteOrigem,
  type IncluirAjusteEstoqueInput,
  type IncluirAjusteEstoqueResponse,
} from './stockbridge/ajuste-estoque.js';
export {
  listarAjusteEstoque,
  type ListarAjusteEstoqueInput,
  type ListarAjusteEstoqueResponse,
  type AjusteEstoqueListado,
} from './stockbridge/listar-ajuste-estoque.js';
export {
  alterarPedidoCompra,
  type AlterarPedidoCompraInput,
  type AlterarPedidoCompraResponse,
} from './stockbridge/pedido-compra.js';
export { __resetMockState, __injectMockAjuste } from './stockbridge/mock.js';
