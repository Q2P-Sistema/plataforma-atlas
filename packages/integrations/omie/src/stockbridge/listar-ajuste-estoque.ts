import { callOmie, isMockMode, type OmieCnpj } from '../client.js';
import { mockListarAjusteEstoque } from './mock.js';
import type { AjusteTipo, AjusteMotivo, AjusteOrigem } from './ajuste-estoque.js';

export interface ListarAjusteEstoqueInput {
  pagina?: number;
  registrosPorPagina?: number;
  codIntAjuste?: string;
  codigoLocalEstoque?: string;
  idProduto?: number;
  tipo?: AjusteTipo;
  origem?: AjusteOrigem;
  motivo?: AjusteMotivo;
  dataMovimentoDe?: string; // dd/MM/yyyy
  dataMovimentoAte?: string; // dd/MM/yyyy
  apenasImportadoApi?: boolean;
}

export interface AjusteEstoqueListado {
  idMovest: string;
  idAjuste: string;
  codIntAjuste: string | null;
  dataMovimento: string;
  codigoLocalEstoque: string;
  idProduto: number;
  quantidade: number;
  valor: number;
  observacao: string;
}

export interface ListarAjusteEstoqueResponse {
  pagina: number;
  totalDePaginas: number;
  registros: number;
  totalDeRegistros: number;
  ajustes: AjusteEstoqueListado[];
}

interface RawAjusteListado {
  id_movest: string;
  id_ajuste: string;
  cod_int_ajuste: string | null;
  data: string;
  codigo_local_estoque: string | number;
  id_prod: number;
  quan: number;
  valor: number;
  obs: string | null;
}

interface RawListarResponse {
  pagina: number;
  total_de_paginas: number;
  registros: number;
  total_de_registros: number;
  ajustes: RawAjusteListado[];
}

/**
 * Lista ajustes de estoque registrados no OMIE com filtros.
 * Endpoint: estoque/ajuste/ -> ListarAjusteEstoque.
 * Uso primario no StockBridge: verificar se um cod_int_ajuste ja existe antes
 * de retentar IncluirAjusteEstoque (idempotencia).
 */
export async function listarAjusteEstoque(
  cnpj: OmieCnpj,
  input: ListarAjusteEstoqueInput,
): Promise<ListarAjusteEstoqueResponse> {
  if (isMockMode()) {
    return mockListarAjusteEstoque(cnpj, input);
  }

  const params: Record<string, unknown> = {
    pagina: input.pagina ?? 1,
    registros_por_pagina: input.registrosPorPagina ?? 50,
  };
  if (input.codIntAjuste) params.cod_int_ajuste = input.codIntAjuste;
  if (input.codigoLocalEstoque) params.codigo_local_estoque = input.codigoLocalEstoque;
  if (input.idProduto !== undefined) params.id_prod = input.idProduto;
  if (input.tipo) params.tipo = input.tipo;
  if (input.origem) params.origem = input.origem;
  if (input.motivo) params.motivo = input.motivo;
  if (input.dataMovimentoDe) params.data_movimento_de = input.dataMovimentoDe;
  if (input.dataMovimentoAte) params.data_movimento_ate = input.dataMovimentoAte;
  if (input.apenasImportadoApi !== undefined) params.apenas_importado_api = input.apenasImportadoApi ? 'S' : 'N';

  const raw = await callOmie<RawListarResponse>(cnpj, {
    endpoint: 'estoque/ajuste/',
    method: 'ListarAjusteEstoque',
    params,
  });

  return {
    pagina: raw.pagina,
    totalDePaginas: raw.total_de_paginas,
    registros: raw.registros,
    totalDeRegistros: raw.total_de_registros,
    ajustes: (raw.ajustes ?? []).map((a) => ({
      idMovest: a.id_movest,
      idAjuste: a.id_ajuste,
      codIntAjuste: a.cod_int_ajuste,
      dataMovimento: a.data,
      codigoLocalEstoque: String(a.codigo_local_estoque),
      idProduto: a.id_prod,
      quantidade: a.quan,
      valor: a.valor,
      observacao: a.obs ?? '',
    })),
  };
}
