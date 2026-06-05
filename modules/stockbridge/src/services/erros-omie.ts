import type { Perfil } from '../types.js';
import { OmieAjusteError } from './recebimento.service.js';

export type UserAction = 'retry' | 'retry_q2p' | 'contact_admin' | 'wait';

export interface OmieErroResposta {
  code: 'OMIE_ACXE_FAIL' | 'OMIE_Q2P_FAIL';
  /** Mensagem tecnica (debug). */
  message: string;
  /** Mensagem em PT-BR para UI (sempre presente). */
  userMessage: string;
  /** Sugestao de proxima acao para o usuario. */
  userAction: UserAction;
  /** O usuario pode clicar "tentar novamente"? */
  retryable: boolean;
  /**
   * O estado em ambos os ERPs e consistente (nada foi gravado parcialmente)?
   * - true: ACXE-fail (nada escrito).
   * - false: Q2P-fail (ACXE escreveu, Q2P pendente).
   */
  stateClean: boolean;
  opId?: string;
  movimentacaoId?: string;
  tentativasRestantes?: number;
}

export interface MapearErroOmieResult {
  httpStatus: number;
  body: OmieErroResposta;
}

const MSG_ACXE = 'OMIE ACXE indisponivel no momento. Nada foi registrado — pode tentar novamente.';
const MSG_Q2P_RECOVERAVEL =
  'Recebimento parcial: ACXE registrado, Q2P pendente. Voce pode tentar novamente uma vez ou aguardar o admin.';
const MSG_Q2P_OPERADOR_ESGOTOU =
  'Voce ja esgotou as retentativas. A pendencia foi escalada para um gestor/diretor.';
const MSG_Q2P_ADMIN =
  'OMIE Q2P ainda indisponivel. Voce pode retentar quantas vezes precisar.';

/**
 * Mapeia um OmieAjusteError para a resposta HTTP estruturada (US5).
 * Centraliza a logica de userAction/retryable/stateClean para garantir
 * consistencia entre as 3 rotas que podem propagar este erro:
 * recebimento, aprovacao, operacoes-pendentes.
 */
export function mapearErroOmieParaResposta(
  err: OmieAjusteError,
  ator?: { role: Perfil },
): MapearErroOmieResult {
  if (err.lado === 'acxe') {
    return {
      httpStatus: 502,
      body: {
        code: 'OMIE_ACXE_FAIL',
        message: err.message,
        userMessage: MSG_ACXE,
        userAction: 'retry',
        retryable: true,
        stateClean: true,
        opId: err.opId,
        movimentacaoId: err.movimentacaoId,
      },
    };
  }

  // lado === 'q2p'
  const role = ator?.role;
  const adminAtor = role === 'gestor' || role === 'diretor';
  const tentativasRestantes = err.tentativasRestantes;

  // Operador esgotou retentativas — frontend deve direcionar para contact_admin.
  const operadorEsgotou =
    role === 'operador' && tentativasRestantes !== undefined && tentativasRestantes <= 0;

  return {
    httpStatus: 502,
    body: {
      code: 'OMIE_Q2P_FAIL',
      message: err.message,
      userMessage: adminAtor
        ? MSG_Q2P_ADMIN
        : operadorEsgotou
          ? MSG_Q2P_OPERADOR_ESGOTOU
          : MSG_Q2P_RECOVERAVEL,
      userAction: operadorEsgotou ? 'contact_admin' : 'retry_q2p',
      retryable: operadorEsgotou ? false : true,
      stateClean: false,
      opId: err.opId,
      movimentacaoId: err.movimentacaoId,
      tentativasRestantes: err.tentativasRestantes,
    },
  };
}
