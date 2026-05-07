import cron from 'node-cron';
import { createLogger } from '@atlas/core';
import { processarAlertasComodatoVencido } from '../services/cron-comodato.service.js';

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
}
