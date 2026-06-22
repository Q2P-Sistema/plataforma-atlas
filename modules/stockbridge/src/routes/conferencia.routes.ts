import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireGestor } from '../middleware/role.js';
import {
  listarConferencia,
  contarConferencia,
  type ConferenciaFiltros,
} from '../services/conferencia.service.js';

const logger = createLogger('stockbridge:conferencia');
const router: Router = Router();

// Acesso: gestor+ (ferramenta de auditoria/conferência). As rotas herdam
// requireAuth + requireModule('stockbridge') do router agregador.

const QuerySchema = z.object({
  status: z.enum(['divergente', 'negativo', 'problemas', 'ok']).optional(),
  tipo: z.enum(['ESPELHADO', 'INDIVIDUAL']).optional(),
  codigoEstoque: z.string().min(1).optional(),
  busca: z.string().min(1).optional(),
});

function badRequest(res: Response, message: string): void {
  res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message } });
}

/**
 * GET /api/v1/stockbridge/conferencia
 * Comparativo ACXE × Q2P da posição mais recente + resumo (KPIs). Acesso gestor+.
 * O `resumo` reflete sempre o universo completo; `itens` respeita os filtros.
 */
router.get('/api/v1/stockbridge/conferencia', requireGestor, async (req: Request, res: Response) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues.map((i) => i.message).join('; '));
    return;
  }

  const filtros: ConferenciaFiltros = parsed.data;

  try {
    const data = await listarConferencia(filtros);
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar conferência de estoque');
    res.status(500).json({ data: null, error: { code: 'CONFERENCIA_FAIL', message: (err as Error).message } });
  }
});

/**
 * GET /api/v1/stockbridge/conferencia/contagem
 * Contagem barata para o badge da navegação (itens com Status Geral != OK). Acesso gestor+.
 */
router.get('/api/v1/stockbridge/conferencia/contagem', requireGestor, async (_req: Request, res: Response) => {
  try {
    const data = await contarConferencia();
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao contar divergências da conferência');
    res.status(500).json({ data: null, error: { code: 'CONFERENCIA_FAIL', message: (err as Error).message } });
  }
});

export default router;
