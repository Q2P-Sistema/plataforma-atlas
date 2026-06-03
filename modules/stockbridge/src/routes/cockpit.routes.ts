import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger, getPool } from '@atlas/core';
import { requireGestor } from '../middleware/role.js';
import { getCockpit } from '../services/cockpit.service.js';

const logger = createLogger('stockbridge:cockpit');
const router: Router = Router();

const QuerySchema = z.object({
  familia: z.string().optional(),
  cnpj: z.enum(['acxe', 'q2p', 'ambos']).optional(),
  galpao: z.string().optional(),
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

// Lista de familias_atlas disponiveis (pra dropdown de filtro do cockpit).
// Vem do mapeamento familia_omie_atlas, filtrado por incluir_em_metricas=true.
router.get('/api/v1/stockbridge/familias', requireGestor, async (_req: Request, res: Response) => {
  try {
    const pool = getPool();
    const result = await pool.query<{ familia_atlas: string }>(
      `SELECT DISTINCT familia_atlas
         FROM stockbridge.familia_omie_atlas
         WHERE incluir_em_metricas = true
           AND familia_atlas IS NOT NULL
         ORDER BY familia_atlas`,
    );
    res.json({ data: result.rows.map((r) => r.familia_atlas), error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar familias');
    res.status(500).json({
      data: null,
      error: { code: 'FAMILIAS_FAIL', message: (err as Error).message },
    });
  }
});

export default router;
