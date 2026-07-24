import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireGestor } from '../middleware/role.js';
import {
  listarSnapshotCmc,
  listarTendenciaCmc,
  listarFiltrosCmc,
  type CmcFiltros,
  type CmcTendenciaFiltros,
} from '../services/cmc.service.js';

const logger = createLogger('stockbridge:cmc');
const router: Router = Router();

// Acesso: gestor+ (operador NÃO vê custo — FR-013). As rotas já herdam
// requireAuth + requireModule('stockbridge') do router agregador.

/** Aceita `?familia=a&familia=b` (array) ou `?familia=a,b` (CSV) → string[]. */
function toArray(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const arr = Array.isArray(v) ? v : v.split(',');
  const limpo = arr.map((s) => s.trim()).filter((s) => s.length > 0);
  return limpo.length > 0 ? limpo : undefined;
}

const multi = z.union([z.string(), z.array(z.string())]).optional();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'data deve ser YYYY-MM-DD')
  .optional();

const SnapshotQuery = z.object({
  data: isoDate,
  familia: multi,
  produto: multi,
  origem: z.enum(['IMPORTADO', 'NACIONAL']).optional(),
});

function badRequest(res: Response, message: string): void {
  res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message } });
}

/**
 * GET /api/v1/stockbridge/cmc/snapshot
 * Posição de CMC do snapshot mais recente, por família (com produtos) +
 * resumo global. Acesso gestor+.
 */
router.get('/api/v1/stockbridge/cmc/snapshot', requireGestor, async (req: Request, res: Response) => {
  const parsed = SnapshotQuery.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues.map((i) => i.message).join('; '));
    return;
  }

  const filtros: CmcFiltros = {
    data: parsed.data.data,
    familias: toArray(parsed.data.familia),
    produtos: toArray(parsed.data.produto),
    origem: parsed.data.origem,
  };

  try {
    const data = await listarSnapshotCmc(filtros);
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao montar snapshot de CMC');
    res.status(500).json({
      data: null,
      error: { code: 'CMC_FAIL', message: (err as Error).message },
    });
  }
});

const TendenciaQuery = z.object({
  de: isoDate,
  ate: isoDate,
  familia: multi,
  produto: multi,
  origem: z.enum(['IMPORTADO', 'NACIONAL']).optional(),
});

/**
 * GET /api/v1/stockbridge/cmc/tendencia
 * Série diária do CMC ponderado no período (lacuna em dias sem coleta). Acesso gestor+.
 */
router.get('/api/v1/stockbridge/cmc/tendencia', requireGestor, async (req: Request, res: Response) => {
  const parsed = TendenciaQuery.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues.map((i) => i.message).join('; '));
    return;
  }

  const filtros: CmcTendenciaFiltros = {
    de: parsed.data.de,
    ate: parsed.data.ate,
    familias: toArray(parsed.data.familia),
    produtos: toArray(parsed.data.produto),
    origem: parsed.data.origem,
  };

  try {
    const data = await listarTendenciaCmc(filtros);
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao montar tendência de CMC');
    res.status(500).json({ data: null, error: { code: 'CMC_FAIL', message: (err as Error).message } });
  }
});

const FiltrosQuery = z.object({ familia: multi });

/**
 * GET /api/v1/stockbridge/cmc/filtros
 * Opções dos combos (famílias + produtos do snapshot mais recente). Acesso gestor+.
 */
router.get('/api/v1/stockbridge/cmc/filtros', requireGestor, async (req: Request, res: Response) => {
  const parsed = FiltrosQuery.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues.map((i) => i.message).join('; '));
    return;
  }

  try {
    const data = await listarFiltrosCmc(toArray(parsed.data.familia));
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar filtros de CMC');
    res.status(500).json({ data: null, error: { code: 'CMC_FAIL', message: (err as Error).message } });
  }
});

export default router;
