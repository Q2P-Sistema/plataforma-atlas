import { Router, type Request, type Response } from 'express';
import { createLogger } from '@atlas/core';
import { requireDiretor } from '../middleware/role.js';
import { getCockpitExecutivo } from '../services/cockpit-executivo.service.js';

const logger = createLogger('stockbridge:cockpit-executivo');
const router: Router = Router();

// Visão executiva "onde está o dinheiro" (ACXEGDP-314). Diretor-only no MVP —
// segue o protótipo v5 do dono, onde custos eram visíveis apenas ao Diretor.
router.get(
  '/api/v1/stockbridge/cockpit-executivo',
  requireDiretor,
  async (_req: Request, res: Response) => {
    try {
      const data = await getCockpitExecutivo();
      res.json({ data, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro ao montar cockpit executivo');
      res.status(500).json({
        data: null,
        error: { code: 'COCKPIT_EXECUTIVO_FAIL', message: (err as Error).message },
      });
    }
  },
);

export default router;
