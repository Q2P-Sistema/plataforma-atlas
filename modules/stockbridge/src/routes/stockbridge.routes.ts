import { Router, type Request, type Response } from 'express';
import { requireAuth } from '@atlas/auth';
import { createLogger } from '@atlas/core';

const logger = createLogger('stockbridge:routes');
const router: Router = Router();

/**
 * Router raiz do StockBridge. Monta sub-routers por area funcional.
 *
 * Fase 2 (Foundational): apenas health check e auth.
 * Sub-routers das user stories (fila, recebimento, cockpit, etc.) sao montados em fases posteriores.
 */

router.use('/api/v1/stockbridge', requireAuth);

router.get('/api/v1/stockbridge/health', (_req: Request, res: Response) => {
  res.json({ data: { status: 'ok', module: 'stockbridge', phase: 'foundational' }, error: null });
});

logger.info('StockBridge router inicializado (Phase 2 — foundational only)');

export default router;
