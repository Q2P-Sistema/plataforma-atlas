import { Router, type Request, type Response } from 'express';
import { requireAuth } from '@atlas/auth';
import { createLogger } from '@atlas/core';
import filaRouter from './fila.routes.js';
import recebimentoRouter from './recebimento.routes.js';
import cockpitRouter from './cockpit.routes.js';

const logger = createLogger('stockbridge:routes');
const router: Router = Router();

// Todas as rotas do StockBridge exigem autenticacao
router.use('/api/v1/stockbridge', requireAuth);

// Health check
router.get('/api/v1/stockbridge/health', (_req: Request, res: Response) => {
  res.json({ data: { status: 'ok', module: 'stockbridge' }, error: null });
});

// US1 — Recebimento de NF com conferencia fisica
router.use(filaRouter);
router.use(recebimentoRouter);
// US2 — Cockpit de estoque por produto (gestor/diretor)
router.use(cockpitRouter);

logger.info('StockBridge router inicializado (US1 + US2 montadas)');

export default router;
