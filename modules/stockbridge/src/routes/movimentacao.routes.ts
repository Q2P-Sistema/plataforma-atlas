import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireGestor } from '../middleware/role.js';
import { listar } from '../services/movimentacao.service.js';

const logger = createLogger('stockbridge:movimentacao');
const router: Router = Router();

const QuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
  nf: z.string().optional(),
  tipoMovimento: z.string().optional(),
  cnpj: z.enum(['acxe', 'q2p', 'ambos']).optional(),
  dtInicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dtFim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

router.get('/api/v1/stockbridge/movimentacoes', requireGestor, async (req: Request, res: Response) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'INVALID_QUERY', message: parsed.error.issues.map((i) => i.message).join('; ') } });
    return;
  }
  try {
    const result = await listar(parsed.data);
    res.json({
      data: result.items,
      meta: { total: result.total, page: result.page, pageSize: result.pageSize },
      error: null,
    });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar movimentacoes');
    res.status(500).json({ data: null, error: { code: 'MOVIMENTACAO_FAIL', message: (err as Error).message } });
  }
});

export default router;
