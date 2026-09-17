import cron from 'node-cron';
import { createLogger } from '@atlas/core';
import { processarAlertasComodatoVencido } from '../services/cron-comodato.service.js';
import { reprocessarBaixasAguardandoVinculo } from '../services/baixa-pedido.service.js';

const logger = createLogger('stockbridge:cron');

let started = false;

/**
 * Registra os crons do StockBridge. Idempotente — multiplas chamadas no boot
 * (HMR, testes) sao ignoradas. Cada job tem timezone explicito BR.
 *
 * Jobs:
 *   - alerta-comodato-vencido: 08:00 BR todos os dias. Dispara emails pros
 *     responsaveis em D+1 (operador+gestor) e a cada 15 dias depois disso
 *     (operador+gestor+diretor). Detalhes em cron-comodato.service.ts.
 */
export function iniciarCronsStockBridge(): void {
  if (started) {
    logger.warn('Crons do StockBridge ja iniciados — ignorando');
    return;
  }
  started = true;

  cron.schedule(
    '0 8 * * *',
    () => {
      void processarAlertasComodatoVencido();
    },
    { timezone: 'America/Sao_Paulo' },
  );
  logger.info('Cron registrado: alerta-comodato-vencido (0 8 * * * BR)');

  // ACXEGDP-344: baixa do pedido Q2P sem FIFO — quem ficou 'aguardando_vinculo'
  // e tenta de novo a cada hora (o n8n carrega o mapa NF->pedido da FUP de hora
  // em hora, em :00). Roda em :10 para pegar a carga recem-feita. Digest de
  // atrasadas (> 3 dias) so na rodada das 08h.
  cron.schedule(
    '10 * * * *',
    () => {
      const horaBr = new Date().toLocaleString('en-US', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        hour12: false,
      });
      void reprocessarBaixasAguardandoVinculo({ enviarDigest: horaBr === '08' });
    },
    { timezone: 'America/Sao_Paulo' },
  );
  logger.info('Cron registrado: baixa-pedido-aguardando-vinculo (10 * * * * BR)');
}
