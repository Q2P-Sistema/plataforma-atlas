import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireGestor } from '../middleware/role.js';
import { getPendenciasFiscais } from '../services/pendencias-fiscais.service.js';

const logger = createLogger('stockbridge:pendencias-fiscais');
const router: Router = Router();

const QuerySchema = z.object({
  status: z.enum(['recebida', 'parcial', 'pendente', 'todas']).optional(),
  incluir_metricas: z.coerce.boolean().optional(),
});

// Aba "Pendências Fiscais" (US4 / ACXEGDP-183) — somente leitura, gestor+.
router.get(
  '/api/v1/stockbridge/pendencias-fiscais',
  requireGestor,
  async (req: Request, res: Response) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: {
          code: 'INVALID_QUERY',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
      return;
    }

    try {
      const data = await getPendenciasFiscais({
        status: parsed.data.status,
        incluirMetricas: parsed.data.incluir_metricas,
      });
      res.json({ data, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro ao listar pendencias fiscais');
      res.status(500).json({
        data: null,
        error: { code: 'PENDENCIAS_FISCAIS_FAIL', message: (err as Error).message },
      });
    }
  },
);

export default router;
