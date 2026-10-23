import { createLogger } from '@atlas/core';
import { idadeCopiaPcs, idadeEspelhoRecebimentos, type IdadeEspelhoRecebimentos } from './fila-nacional.service.js';
import { enviarAlertaCopiaPcsDefasada, enviarAlertaEspelhoRecebimentosDefasado } from './notificacao.service.js';
import { ROTULO_EMPRESA, type EmpresaNacional } from './empresa-nacional.js';

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
 *
 * Feature 017, Historia 5 (ACXEGDP-437): os dois espelhos (recebimentos e copia de PCs) se
 * vigiam por empresa, cada um com o seu estado de reaviso — a defasagem da ACXE nao suprime
 * a da Q2P nem o contrario. A ACXE so e vigiada com `recebimentoNacionalAcxeHabilitado()`
 * (`idade*('acxe')` devolve 'desligado' sem ela, e nada e enviado).
 */

export const REALERTA_ESPELHO_MS = 6 * 60 * 60 * 1000;

export type DesfechoVerificacaoEspelho = 'desligado' | 'ok' | 'alertado' | 'suprimido' | 'falha';

interface EstadoAlerta {
  ultimoAlertaEm: number | null;
}

const estadoEspelho: Record<EmpresaNacional, EstadoAlerta> = { q2p: { ultimoAlertaEm: null }, acxe: { ultimoAlertaEm: null } };
const estadoCopiaPcs: Record<EmpresaNacional, EstadoAlerta> = { q2p: { ultimoAlertaEm: null }, acxe: { ultimoAlertaEm: null } };

/** true = o e-mail foi entregue ao provedor (sendEmail resolveu); false = falhou. */
type EnviarAlerta = (
  a: { status: 'degraded' | 'sem_dados' | 'indisponivel'; idadeMin: number | null; limiteMin: number },
  empresa: EmpresaNacional,
) => Promise<boolean>;

async function verificar(
  estado: EstadoAlerta,
  idade: IdadeEspelhoRecebimentos,
  enviar: EnviarAlerta,
  rotulo: string,
  agora: number,
  empresa: EmpresaNacional,
): Promise<DesfechoVerificacaoEspelho> {
  if (idade.status === 'desligado') return 'desligado';
  if (idade.status === 'ok') {
    if (estado.ultimoAlertaEm != null) logger.info({ idadeMin: idade.idadeMin }, `${rotulo} normalizado`);
    estado.ultimoAlertaEm = null;
    return 'ok';
  }
  if (estado.ultimoAlertaEm != null && agora - estado.ultimoAlertaEm < REALERTA_ESPELHO_MS) return 'suprimido';
  logger.warn({ empresa, status: idade.status, idadeMin: idade.idadeMin, limiteMin: idade.limiteMin }, `${rotulo} defasado — alertando`);
  let entregue = false;
  try {
    entregue = await enviar({ status: idade.status, idadeMin: idade.idadeMin, limiteMin: idade.limiteMin ?? 120 }, empresa);
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

/**
 * Os dois parametros sao opcionais e aceitam as duas ordens: `(empresa, agora)` e a forma da
 * Historia 5; um primeiro argumento NUMERICO e o `agora` da assinatura anterior (so a Q2P).
 */
function resolverArgs(empresaOuAgora: EmpresaNacional | number | undefined, agora: number | undefined): { empresa: EmpresaNacional; agora: number } {
  if (typeof empresaOuAgora === 'number') return { empresa: 'q2p', agora: empresaOuAgora };
  return { empresa: empresaOuAgora ?? 'q2p', agora: agora ?? Date.now() };
}

const sufixoEmpresa = (empresa: EmpresaNacional): string => (empresa === 'q2p' ? '' : ` (${ROTULO_EMPRESA[empresa]})`);

export async function verificarEspelhoRecebimentos(
  empresaOuAgora?: EmpresaNacional | number,
  agoraOpcional?: number,
): Promise<DesfechoVerificacaoEspelho> {
  const { empresa, agora } = resolverArgs(empresaOuAgora, agoraOpcional);
  return verificar(
    estadoEspelho[empresa],
    await idadeEspelhoRecebimentos(empresa),
    enviarAlertaEspelhoRecebimentosDefasado,
    `Espelho de recebimentos de NF-e${sufixoEmpresa(empresa)}`,
    agora,
    empresa,
  );
}

/** Feature 017 (D13): copia de pedidos de compra, com reaviso proprio (e por empresa — Historia 5). */
export async function verificarCopiaPcs(
  empresaOuAgora?: EmpresaNacional | number,
  agoraOpcional?: number,
): Promise<DesfechoVerificacaoEspelho> {
  const { empresa, agora } = resolverArgs(empresaOuAgora, agoraOpcional);
  return verificar(
    estadoCopiaPcs[empresa],
    await idadeCopiaPcs(empresa),
    enviarAlertaCopiaPcsDefasada,
    `Cópia de pedidos de compra${sufixoEmpresa(empresa)}`,
    agora,
    empresa,
  );
}

/** Somente testes. */
export function __resetAlertaEspelho(): void {
  for (const e of ['q2p', 'acxe'] as const) {
    estadoEspelho[e].ultimoAlertaEm = null;
    estadoCopiaPcs[e].ultimoAlertaEm = null;
  }
}
