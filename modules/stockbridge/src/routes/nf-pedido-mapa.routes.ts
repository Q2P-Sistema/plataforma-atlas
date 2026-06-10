import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireGestor } from '../middleware/role.js';
import { upsertNfPedidoMapa, listNfPedidoMapa } from '../services/nf-pedido-mapa.service.js';

const logger = createLogger('stockbridge:nf-pedido-mapa');
const router: Router = Router();

const PostBodySchema = z.array(
  z.object({
    pedido: z.string().min(1, 'pedido obrigatório'),
    nf_mae: z.string().min(1, 'nf_mae obrigatória'),
    nf_filhotes: z.array(z.string().min(1)).max(12, 'máximo 12 filhotes por pedido').default([]),
  }),
).min(1, 'array deve ter ao menos 1 item').max(200, 'máximo 200 pedidos por envio');

// POST /admin/nf-pedido-mapa — upsert idempotente do mapa NF mãe/filhotes (gestor+)
router.post(
  '/api/v1/stockbridge/admin/nf-pedido-mapa',
  requireGestor,
  async (req: Request, res: Response) => {
    const parsed = PostBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: {
          code: 'INVALID_INPUT',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
      return;
    }

    try {
      const result = await upsertNfPedidoMapa(parsed.data);
      res.json({ data: result, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro ao upsert nf-pedido-mapa');
      res.status(500).json({
        data: null,
        error: { code: 'NF_MAPA_UPSERT_FAIL', message: (err as Error).message },
      });
    }
  },
);

// GET /admin/nf-pedido-mapa — lista mapas ativos para validação (gestor+)
router.get(
  '/api/v1/stockbridge/admin/nf-pedido-mapa',
  requireGestor,
  async (_req: Request, res: Response) => {
    try {
      const data = await listNfPedidoMapa();
      res.json({ data, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro ao listar nf-pedido-mapa');
      res.status(500).json({
        data: null,
        error: { code: 'NF_MAPA_LIST_FAIL', message: (err as Error).message },
      });
    }
  },
);

export default router;
