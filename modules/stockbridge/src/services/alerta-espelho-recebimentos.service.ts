import { createLogger } from '@atlas/core';
import { idadeEspelhoRecebimentos } from './fila-nacional.service.js';
import { enviarAlertaEspelhoRecebimentosDefasado } from './notificacao.service.js';

const logger = createLogger('stockbridge:alerta-espelho-recebimentos');

/**
 * Feature 016 (revisao pre-UAT, ROT-6/SPEC016-10): a spec exige que a defasagem do
 * espelho de recebimentos seja visivel E alerte. O health do modulo mostra; este
 * job (cron a cada 30 min) avisa STOCKBRIDGE_OPS_EMAIL quando o espelho passa do
 * limite (STOCKBRIDGE_ESPELHO_RECEBIMENTOS_MAX_MIN), fica vazio ou inacessivel —
 * com a flag desligada nao faz nada. Reaviso a cada 6 h enquanto durar; o estado
 * e em memoria (uma replica no UAT; reiniciar a API pode reenviar uma vez).
 */

export const REALERTA_ESPELHO_MS = 6 * 60 * 60 * 1000;

let ultimoAlertaEm: number | null = null;

export type DesfechoVerificacaoEspelho = 'desligado' | 'ok' | 'alertado' | 'suprimido';

export async function verificarEspelhoRecebimentos(agora: number = Date.now()): Promise<DesfechoVerificacaoEspelho> {
  const idade = await idadeEspelhoRecebimentos();
  if (idade.status === 'desligado') return 'desligado';
  if (idade.status === 'ok') {
    if (ultimoAlertaEm != null) logger.info({ idadeMin: idade.idadeMin }, 'Espelho de recebimentos de NF-e normalizado');
    ultimoAlertaEm = null;
    return 'ok';
  }
  if (ultimoAlertaEm != null && agora - ultimoAlertaEm < REALERTA_ESPELHO_MS) return 'suprimido';
  ultimoAlertaEm = agora;
  logger.warn({ status: idade.status, idadeMin: idade.idadeMin, limiteMin: idade.limiteMin }, 'Espelho de recebimentos de NF-e defasado — alertando');
  await enviarAlertaEspelhoRecebimentosDefasado({ status: idade.status, idadeMin: idade.idadeMin, limiteMin: idade.limiteMin ?? 120 });
  return 'alertado';
}

/** Somente testes. */
export function __resetAlertaEspelho(): void {
  ultimoAlertaEm = null;
}
