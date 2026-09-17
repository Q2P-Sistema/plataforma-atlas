export { callOmie, isMockMode, OmieApiError, type OmieCnpj, type OmieEndpoint, type OmieCredentials } from './client.js';

// StockBridge integration
export { consultarNF, type ConsultarNFResponse, type ItemNF } from './stockbridge/nf.js';
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
  consultarPedidoCompra,
  parsePedidoCompraConsultado,
  type AlterarPedidoCompraInput,
  type AlterarPedidoCompraResponse,
  type PedidoCompraConsultado,
  type ItemPedidoCompra,
} from './stockbridge/pedido-compra.js';
export {
  __resetMockState,
  __injectMockAjuste,
  __injectMockPedidoCompra,
  __getMockPedidoCompra,
} from './stockbridge/mock.js';
