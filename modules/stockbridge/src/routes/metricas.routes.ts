import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireDiretor } from '../middleware/role.js';
import { getKPIs, getEvolucao, getTabelaAnalitica } from '../services/metricas.service.js';

const logger = createLogger('stockbridge:metricas');
const router: Router = Router();

router.get('/api/v1/stockbridge/metricas', requireDiretor, async (_req: Request, res: Response) => {
  try {
    const data = await getKPIs();
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro em metricas/kpis');
    res.status(500).json({ data: null, error: { code: 'METRICAS_FAIL', message: (err as Error).message } });
  }
});

const EvolucaoSchema = z.object({ meses: z.coerce.number().int().min(1).max(24).default(6) });

router.get('/api/v1/stockbridge/metricas/evolucao', requireDiretor, async (req: Request, res: Response) => {
  const parsed = EvolucaoSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'INVALID_QUERY', message: 'meses deve ser entre 1 e 24' } });
    return;
  }
  try {
    const data = await getEvolucao(parsed.data.meses);
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro em metricas/evolucao');
    res.status(500).json({ data: null, error: { code: 'METRICAS_FAIL', message: (err as Error).message } });
  }
});

router.get('/api/v1/stockbridge/metricas/tabela-analitica', requireDiretor, async (_req: Request, res: Response) => {
  try {
    const data = await getTabelaAnalitica();
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro em tabela-analitica');
    res.status(500).json({ data: null, error: { code: 'METRICAS_FAIL', message: (err as Error).message } });
  }
});

export default router;
