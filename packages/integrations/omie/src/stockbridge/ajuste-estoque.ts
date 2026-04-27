import { callOmie, isMockMode, type OmieCnpj } from '../client.js';
import { mockIncluirAjusteEstoque } from './mock.js';

export type AjusteTipo = 'TRF' | 'ENT';
export type AjusteMotivo = 'TRF' | 'INI';
export type AjusteOrigem = 'AJU';

export interface IncluirAjusteEstoqueInput {
  codigoLocalEstoque: string;
  idProduto: number;
  dataAtual: string; // formato dd/MM/yyyy
  quantidade: number;
  observacao: string;
  origem: AjusteOrigem;
  tipo: AjusteTipo;
  motivo: AjusteMotivo;
  valor: number;
  codigoLocalEstoqueDestino?: string;
  /**
   * Codigo de integracao com sistemas legados (cod_int_ajuste, ate 60 chars).
   * Usado pelo StockBridge como chave de idempotencia: derivado de op_id da
   * movimentacao + sufixo (acxe-trf, q2p-ent, acxe-faltando). Permite que
   * retentativas sejam detectadas via ListarAjusteEstoque sem duplicar.
   */
  codIntAjuste?: string;
}

export interface IncluirAjusteEstoqueResponse {
  idMovest: string;
  idAjuste: string;
  descricaoStatus: string;
}

/**
 * Inclui um ajuste de estoque no OMIE (transferencia ou entrada).
 * Herdado do legado PHP — endpoint estoque/ajuste/ -> IncluirAjusteEstoque.
 * Excecao documentada ao Principio II (escrita no OMIE).
 */
export async function incluirAjusteEstoque(
  cnpj: OmieCnpj,
  input: IncluirAjusteEstoqueInput,
): Promise<IncluirAjusteEstoqueResponse> {
  if (isMockMode()) {
    return mockIncluirAjusteEstoque(cnpj, input);
  }

  const params: Record<string, unknown> = {
    codigo_local_estoque: input.codigoLocalEstoque,
    id_prod: input.idProduto,
    data: input.dataAtual,
    quan: input.quantidade,
    obs: input.observacao,
    origem: input.origem,
    tipo: input.tipo,
    motivo: input.motivo,
    valor: input.valor,
  };
  if (input.codigoLocalEstoqueDestino) {
    params.codigo_local_estoque_destino = input.codigoLocalEstoqueDestino;
  }
  if (input.codIntAjuste) {
    params.cod_int_ajuste = input.codIntAjuste;
  }

  const raw = await callOmie<{ id_movest: string; id_ajuste: string; descricao_status: string }>(cnpj, {
    endpoint: 'estoque/ajuste/',
    method: 'IncluirAjusteEstoque',
    params,
  });

  return {
    idMovest: raw.id_movest,
    idAjuste: raw.id_ajuste,
    descricaoStatus: raw.descricao_status,
  };
}
