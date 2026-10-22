import { createLogger } from '@atlas/core';
import { idadeCopiaPcs, idadeEspelhoRecebimentos, type IdadeEspelhoRecebimentos } from './fila-nacional.service.js';
import { enviarAlertaCopiaPcsDefasada, enviarAlertaEspelhoRecebimentosDefasado } from './notificacao.service.js';

const logger = createLogger('stockbridge:alerta-espelho-recebimentos');

/**
 * Feature 016 (revisao pre-UAT, ROT-6/SPEC016-10): a spec exige que a defasagem do
 * espelho de recebimentos seja visivel E alerte. O health do modulo mostra; este
 * job (cron a cada 30 min) avisa STOCKBRIDGE_OPS_EMAIL quando o espelho passa do
 * limite (STOCKBRIDGE_ESPELHO_RECEBIMENTOS_MAX_MIN), fica vazio ou inacessivel —
 * com a flag desligada nao faz nada. Reaviso a cada 6 h enquanto durar; o estado
 * e em memoria (uma replica no UAT; reiniciar a API pode reenviar uma vez).
 *
 * Feature 017 (research D13, FR-030): o mesmo job vigia a copia de pedidos de
 * compra (tbl_pedidosCompras_Q2P, limite STOCKBRIDGE_COPIA_PCS_MAX_MIN), com
 * controle de reaviso proprio — um alerta de um nao suprime o do outro.
 *
 * Feature 017 (infra-03): o reaviso de 6 h conta a partir da ENTREGA, nao da
 * tentativa. Os senders devolvem true so quando o sendEmail resolveu; com false o
 * job devolve 'falha' sem gravar o horario, e a rodada seguinte (30 min depois)
 * tenta de novo — um SendGrid fora do ar nao silencia o alerta por 6 h.
 */

export const REALERTA_ESPELHO_MS = 6 * 60 * 60 * 1000;

export type DesfechoVerificacaoEspelho = 'desligado' | 'ok' | 'alertado' | 'suprimido' | 'falha';

interface EstadoAlerta {
  ultimoAlertaEm: number | null;
}

const estadoEspelho: EstadoAlerta = { ultimoAlertaEm: null };
const estadoCopiaPcs: EstadoAlerta = { ultimoAlertaEm: null };

/** true = o e-mail foi entregue ao provedor (sendEmail resolveu); false = falhou. */
type EnviarAlerta = (a: { status: 'degraded' | 'sem_dados' | 'indisponivel'; idadeMin: number | null; limiteMin: number }) => Promise<boolean>;

async function verificar(
  estado: EstadoAlerta,
  idade: IdadeEspelhoRecebimentos,
  enviar: EnviarAlerta,
  rotulo: string,
  agora: number,
): Promise<DesfechoVerificacaoEspelho> {
  if (idade.status === 'desligado') return 'desligado';
  if (idade.status === 'ok') {
    if (estado.ultimoAlertaEm != null) logger.info({ idadeMin: idade.idadeMin }, `${rotulo} normalizado`);
    estado.ultimoAlertaEm = null;
    return 'ok';
  }
  if (estado.ultimoAlertaEm != null && agora - estado.ultimoAlertaEm < REALERTA_ESPELHO_MS) return 'suprimido';
  logger.warn({ status: idade.status, idadeMin: idade.idadeMin, limiteMin: idade.limiteMin }, `${rotulo} defasado — alertando`);
  let entregue = false;
  try {
    entregue = await enviar({ status: idade.status, idadeMin: idade.idadeMin, limiteMin: idade.limiteMin ?? 120 });
  } catch (err) {
    // os senders nao lancam; se um dia lancarem, o desfecho e o mesmo de uma falha de envio
    logger.error({ err }, `${rotulo}: erro inesperado ao enviar o alerta`);
  }
  if (!entregue) {
    logger.warn({ status: idade.status }, `${rotulo}: alerta nao entregue — nova tentativa na proxima rodada (reaviso nao suprimido)`);
    return 'falha';
  }
  estado.ultimoAlertaEm = agora;
  return 'alertado';
}

export async function verificarEspelhoRecebimentos(agora: number = Date.now()): Promise<DesfechoVerificacaoEspelho> {
  return verificar(estadoEspelho, await idadeEspelhoRecebimentos(), enviarAlertaEspelhoRecebimentosDefasado, 'Espelho de recebimentos de NF-e', agora);
}

/** Feature 017 (D13): copia de pedidos de compra, com reaviso proprio. */
export async function verificarCopiaPcs(agora: number = Date.now()): Promise<DesfechoVerificacaoEspelho> {
  return verificar(estadoCopiaPcs, await idadeCopiaPcs(), enviarAlertaCopiaPcsDefasada, 'Cópia de pedidos de compra', agora);
}

/** Somente testes. */
export function __resetAlertaEspelho(): void {
  estadoEspelho.ultimoAlertaEm = null;
  estadoCopiaPcs.ultimoAlertaEm = null;
}
