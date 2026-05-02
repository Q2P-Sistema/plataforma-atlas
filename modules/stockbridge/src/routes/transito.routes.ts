import { Router, type Request, type Response } from 'express';
import { createLogger } from '@atlas/core';
import { requireOperador } from '../middleware/role.js';
import { listarPorEstagio } from '../services/transito.service.js';
import type { Perfil } from '../types.js';

const logger = createLogger('stockbridge:transito');
const router: Router = Router();

// GET /transito — todos os perfis (filtro de visibilidade aplicado no service)
// Modulo e read-only: dados vem do FUP de Comex via stockbridge.refresh_lotes_em_transito_se_stale.
// Sem PATCH/avancar — quem orquestra o pipeline e quem mantem a planilha FUP.
router.get('/api/v1/stockbridge/transito', requireOperador, async (req: Request, res: Response) => {
  try {
    const perfil = (req.user?.role ?? 'operador') as Perfil;
    const data = await listarPorEstagio(perfil);
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar transito');
    res.status(500).json({ data: null, error: { code: 'TRANSITO_FAIL', message: (err as Error).message } });
  }
});

export default router;
