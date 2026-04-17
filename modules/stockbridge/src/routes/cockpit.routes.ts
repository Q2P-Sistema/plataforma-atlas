import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireGestor } from '../middleware/role.js';
import { getCockpit } from '../services/cockpit.service.js';

const logger = createLogger('stockbridge:cockpit');
const router: Router = Router();

const QuerySchema = z.object({
  familia: z.string().optional(),
  cnpj: z.enum(['acxe', 'q2p', 'ambos']).optional(),
  criticidade: z.enum(['critico', 'alerta', 'ok', 'excesso', 'todas']).optional(),
});

router.get('/api/v1/stockbridge/cockpit', requireGestor, async (req: Request, res: Response) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      data: null,
      error: { code: 'INVALID_QUERY', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
    });
    return;
  }

  try {
    const data = await getCockpit(parsed.data);
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao montar cockpit');
    res.status(500).json({
      data: null,
      error: { code: 'COCKPIT_FAIL', message: (err as Error).message },
    });
  }
});

export default router;
