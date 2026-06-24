import type { ConsultarNFResponse } from '@atlas/integration-omie';
import { CNPJ_ACXE } from '../types.js';

/**
 * Engine pura de validação da NF no recebimento (feature 012 — ACXEGDP-204 + 205).
 *
 * Decide se uma NF retornada pela consulta OMIE ao vivo pode ser recebida:
 *  - cancelada/inutilizada/denegada  → bloqueada (ACXEGDP-204)
 *  - no contexto ACXE, NF de entrada de terceiro (numeração coincidente)
 *    → bloqueada (ACXEGDP-205); o contexto Q2P não aplica esse filtro
 *  - sinal necessário ausente → indeterminada (fail-open + alerta no call-site, FR-010)
 *
 * Função SEM I/O — toda a regra de negócio vive aqui, coberta por Vitest
 * (Princípio III). Os call-sites (getFilaOmie / processarRecebimento) traduzem
 * o resultado em erro tipado (bloqueada) ou fail-open (indeterminada).
 *
 * A leitura dos campos vem do MESMO retorno ao vivo de `consultarNF`
 * (`produtos/nfconsultar/`) — exceção ao Princípio II já documentada (007 §2).
 */

export type MotivoBloqueio = 'cancelada' | 'nao_emitida_acxe';
export type MotivoIndeterminado = 'cancelamento_desconhecido' | 'emitente_desconhecido';

export type ResultadoValidacaoNf =
  | { status: 'ok' }
  | { status: 'bloqueada'; motivo: MotivoBloqueio }
  | { status: 'indeterminada'; motivo: MotivoIndeterminado };

export interface ContextoValidacao {
  cnpj: 'acxe' | 'q2p';
}

export function validarNfRecebivel(
  nf: ConsultarNFResponse,
  contexto: ContextoValidacao,
): ResultadoValidacaoNf {
  // 1) Cancelamento — vale para qualquer contexto e é avaliado PRIMEIRO, de modo
  //    que uma NF da ACXE porém cancelada seja bloqueada por cancelamento.
  if (nf.cancelada === true) {
    return { status: 'bloqueada', motivo: 'cancelada' };
  }

  // 2) Emitente — restrito ao contexto ACXE (clarify). Discriminador primário é
  //    tpNF (1=saída/emissão própria; 0=entrada de terceiro). Fallback: emitente
  //    textual vs. CNPJ_ACXE. Sem nenhum sinal → indeterminado (fail-open).
  if (contexto.cnpj === 'acxe') {
    if (nf.tpNF === 1) return { status: 'ok' };
    if (nf.tpNF === 0) return { status: 'bloqueada', motivo: 'nao_emitida_acxe' };
    if (nf.cnpjEmitente != null && nf.cnpjEmitente !== '') {
      return nf.cnpjEmitente === CNPJ_ACXE
        ? { status: 'ok' }
        : { status: 'bloqueada', motivo: 'nao_emitida_acxe' };
    }
    return { status: 'indeterminada', motivo: 'emitente_desconhecido' };
  }

  return { status: 'ok' };
}
