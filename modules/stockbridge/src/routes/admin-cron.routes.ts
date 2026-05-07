import { Router, type Request, type Response } from 'express';
import { createLogger } from '@atlas/core';
import { requireGestor } from '../middleware/role.js';
import { processarAlertasComodatoVencido } from '../services/cron-comodato.service.js';

const logger = createLogger('stockbridge:admin-cron');
const router: Router = Router();

/**
 * POST /api/v1/stockbridge/admin/cron/comodato-vencido/run
 * Roda o cron de alerta de comodato vencido on-demand. Util pra testar/forcar
 * envio sem esperar o agendamento das 08:00 BR. Retorna o resumo da execucao.
 * Acesso: gestor+ (mesma exigencia do painel admin de galpoes).
 */
router.post(
  '/api/v1/stockbridge/admin/cron/comodato-vencido/run',
  requireGestor,
  async (_req: Request, res: Response) => {
    try {
      logger.info('Disparo manual do cron alerta-comodato-vencido');
      const resultado = await processarAlertasComodatoVencido();
      res.json({ data: resultado, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro ao disparar cron manual');
      res.status(500).json({
        data: null,
        error: { code: 'CRON_RUN_FAIL', message: (err as Error).message },
      });
    }
  },
);

export default router;
