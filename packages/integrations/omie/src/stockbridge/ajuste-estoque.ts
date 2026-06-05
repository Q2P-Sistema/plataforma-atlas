import { createLogger } from '@atlas/core';
import { callOmie, isMockMode, OmieApiError, type OmieCnpj } from '../client.js';
import { mockIncluirAjusteEstoque } from './mock.js';
import { listarAjusteEstoque } from './listar-ajuste-estoque.js';

const logger = createLogger('omie-ajuste-estoque');

// Tipos OMIE IncluirAjusteEstoque (estoque/ajuste/):
//   ENT — entrada no estoque (motivos: INV, OPE, PDV, INI)
//   SAI — saida do estoque, debit sem destino (motivos: INV, PER, OPS, PDV)
//   SLD — ajuste de saldo (motivos: INV, INI, CMC, PDV)
//   TRF — transferencia entre locais, requer codigoLocalEstoqueDestino (motivos: TPQ, TRF)
export type AjusteTipo = 'TRF' | 'ENT' | 'SAI' | 'SLD';
export type AjusteMotivo = 'TRF' | 'INI' | 'INV' | 'PER' | 'OPS' | 'OPE' | 'PDV' | 'CMC' | 'TPQ';
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

  try {
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
  } catch (err) {
    // Idempotencia: OMIE retorna 1035 (Já existe um ajuste de estoque para o
    // codigo de integracao [X] com o ID [Y]) quando o cod_int_ajuste ja foi
    // registrado em chamada anterior — comum em retentativas apos falha parcial.
    // Resolve em 2 etapas:
    //   1) consulta ListarAjusteEstoque pelo cod_int (caminho ideal — pega
    //      idMovest + idAjuste reais)
    //   2) se listar nao acha (delay OMIE / cod_int truncado / etc), fallback
    //      regex extrai idMovest direto da faultstring.
    const ehDuplicado =
      err instanceof OmieApiError &&
      (err.omieCode === 'SOAP-ENV:Client-1035' || /Já existe um ajuste de estoque/i.test(err.message));

    if (input.codIntAjuste && ehDuplicado) {
      try {
        const existente = await listarAjusteEstoque(cnpj, {
          codIntAjuste: input.codIntAjuste,
          registrosPorPagina: 1,
        });
        const ajuste = existente.ajustes[0];
        if (ajuste) {
          logger.info(
            { codInt: input.codIntAjuste, idMovest: ajuste.idMovest, idAjuste: ajuste.idAjuste },
            'OMIE 1035 recuperado via ListarAjusteEstoque',
          );
          return {
            idMovest: ajuste.idMovest,
            idAjuste: ajuste.idAjuste,
            descricaoStatus: 'recuperado-por-idempotencia',
          };
        }
        logger.warn(
          { codInt: input.codIntAjuste, totalRegistros: existente.totalDeRegistros },
          'ListarAjusteEstoque nao retornou registros pro cod_int duplicado — tentando fallback regex',
        );
      } catch (listErr) {
        logger.warn(
          { codInt: input.codIntAjuste, listErr: (listErr as Error).message },
          'ListarAjusteEstoque falhou — tentando fallback regex',
        );
      }

      // Fallback: extrai idMovest da faultstring. id_ajuste nao vem na
      // mensagem — usamos o cod_int como placeholder (e marcamos no status).
      const m = (err as OmieApiError).message.match(/com o ID \[(\d+)\]/);
      const idMovest = m?.[1];
      if (idMovest) {
        logger.info(
          { codInt: input.codIntAjuste, idMovest },
          'OMIE 1035 recuperado via regex (idAjuste indisponivel — usando cod_int)',
        );
        return {
          idMovest,
          idAjuste: input.codIntAjuste,
          descricaoStatus: 'recuperado-por-idempotencia-regex',
        };
      }
    }
    throw err;
  }
}
