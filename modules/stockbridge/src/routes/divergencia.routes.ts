import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireGestor } from '../middleware/role.js';
import { listarDivergencias } from '../services/divergencia.service.js';

const logger = createLogger('stockbridge:divergencia');
const router: Router = Router();

const QuerySchema = z.object({
  status: z.enum(['aberta', 'regularizada', 'descartada']).optional(),
  tipo: z.enum(['faltando', 'varredura', 'cruzada', 'fiscal_pendente']).optional(),
  cnpj: z.enum(['acxe', 'q2p']).optional(),
  produto_codigo_acxe: z.coerce.number().int().positive().optional(),
});

router.get('/api/v1/stockbridge/divergencias', requireGestor, async (req: Request, res: Response) => {
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
    const data = await listarDivergencias({
      status: parsed.data.status,
      tipo: parsed.data.tipo,
      cnpj: parsed.data.cnpj,
      produtoCodigoAcxe: parsed.data.produto_codigo_acxe,
    });
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar divergências');
    res.status(500).json({
      data: null,
      error: { code: 'DIVERGENCIAS_FAIL', message: (err as Error).message },
    });
  }
});

export default router;
