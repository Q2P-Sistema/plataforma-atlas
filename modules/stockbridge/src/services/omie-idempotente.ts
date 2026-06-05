import { createLogger } from '@atlas/core';
import {
  incluirAjusteEstoque,
  listarAjusteEstoque,
  type IncluirAjusteEstoqueInput,
  type AjusteEstoqueListado,
} from '@atlas/integration-omie';

const logger = createLogger('stockbridge:omie-idempotente');

export interface IncluirAjusteIdempotenteResult {
  idMovest: string;
  idAjuste: string;
  /** true se o ajuste ja existia no OMIE (detectado via ListarAjusteEstoque). */
  jaExistia: boolean;
}

/**
 * Inclui um ajuste de estoque no OMIE com protecao contra duplicacao via cod_int_ajuste.
 *
 * - verificarAntes=false (default): chama IncluirAjusteEstoque direto, passando codIntAjuste.
 *   Use no caminho feliz da primeira tentativa — evita custo de uma chamada extra.
 *
 * - verificarAntes=true: primeiro chama ListarAjusteEstoque filtrando por codIntAjuste.
 *   Se ja existe um ajuste com aquele codigo, retorna seus IDs sem chamar Incluir
 *   (idempotente). Se nao, chama Incluir normal. Use em retry de operacoes pendentes.
 *
 * O codIntAjuste deve ser unico por chamada — convencao do StockBridge:
 * `${op_id}:${sufixo}` onde sufixo e 'acxe-trf', 'q2p-ent' ou 'acxe-faltando'.
 */
export async function incluirAjusteIdempotente(
  cnpj: 'acxe' | 'q2p',
  codIntAjuste: string,
  input: Omit<IncluirAjusteEstoqueInput, 'codIntAjuste'>,
  opts: { verificarAntes: boolean } = { verificarAntes: false },
): Promise<IncluirAjusteIdempotenteResult> {
  if (opts.verificarAntes) {
    const existente = await buscarAjustePorCodIntAjuste(cnpj, codIntAjuste);
    if (existente) {
      logger.info(
        { cnpj, codIntAjuste, idMovest: existente.idMovest, idAjuste: existente.idAjuste },
        'Ajuste ja existia no OMIE — pulando IncluirAjusteEstoque (idempotente)',
      );
      return {
        idMovest: existente.idMovest,
        idAjuste: existente.idAjuste,
        jaExistia: true,
      };
    }
  }

  const res = await incluirAjusteEstoque(cnpj, { ...input, codIntAjuste });
  return {
    idMovest: res.idMovest,
    idAjuste: res.idAjuste,
    jaExistia: false,
  };
}

/**
 * Busca um ajuste OMIE pelo cod_int_ajuste. Retorna null se nao existe.
 * Usado em retries para detectar se a chamada anterior chegou a persistir
 * mesmo que tenha falhado a resposta HTTP.
 */
export async function buscarAjustePorCodIntAjuste(
  cnpj: 'acxe' | 'q2p',
  codIntAjuste: string,
): Promise<AjusteEstoqueListado | null> {
  const res = await listarAjusteEstoque(cnpj, {
    codIntAjuste,
    registrosPorPagina: 5,
  });
  if (res.ajustes.length === 0) return null;
  // Match exato — defensivo contra OMIE retornar prefix-match.
  return res.ajustes.find((a) => a.codIntAjuste === codIntAjuste) ?? null;
}
