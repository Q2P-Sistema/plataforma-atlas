import { Router, type Request, type Response } from 'express';
import { createLogger } from '@atlas/core';
import { requireDiretor } from '../middleware/role.js';
import { listarConfigProdutos } from '../services/config-produto.service.js';

const logger = createLogger('stockbridge:config');
const router: Router = Router();

/**
 * GET /api/v1/stockbridge/config/produtos
 * Lista config dos produtos ACXE ativos com mapping de familia.
 *
 * Read-only — toda a populacao e via migration 0017 + trigger AFTER INSERT em
 * tbl_produtos_ACXE. Diretor nao edita por aqui (sem ruido manual).
 */
router.get('/api/v1/stockbridge/config/produtos', requireDiretor, async (_req: Request, res: Response) => {
  try {
    const data = await listarConfigProdutos();
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar config produtos');
    res.status(500).json({ data: null, error: { code: 'CONFIG_FAIL', message: (err as Error).message } });
  }
});

export default router;
