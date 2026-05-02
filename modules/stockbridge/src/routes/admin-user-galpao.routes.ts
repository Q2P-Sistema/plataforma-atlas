import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireDiretor, requireGestor } from '../middleware/role.js';
import {
  listarUsuariosComGalpoes,
  setGalpoesDoUsuario,
  listarGalpoesDisponiveis,
} from '../services/admin-user-galpao.service.js';

const logger = createLogger('stockbridge:admin-user-galpao');
const router: Router = Router();

// GET /admin/user-galpao — lista todos os usuarios com seus galpoes vinculados
router.get(
  '/api/v1/stockbridge/admin/user-galpao',
  requireDiretor,
  async (_req: Request, res: Response) => {
    try {
      const data = await listarUsuariosComGalpoes();
      res.json({ data, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro ao listar user-galpao');
      res.status(500).json({
        data: null,
        error: { code: 'USER_GALPAO_LIST_FAIL', message: (err as Error).message },
      });
    }
  },
);

// GET /admin/galpoes-disponiveis — lista galpoes (de stockbridge.localidade)
// requireGestor (em vez de requireDiretor) porque o Cockpit/MeuEstoque consomem
// essa lista pra popular o filtro de galpao — nao e dado sensivel.
router.get(
  '/api/v1/stockbridge/admin/galpoes-disponiveis',
  requireGestor,
  async (_req: Request, res: Response) => {
    try {
      const data = await listarGalpoesDisponiveis();
      res.json({ data, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro ao listar galpoes disponiveis');
      res.status(500).json({
        data: null,
        error: { code: 'GALPOES_LIST_FAIL', message: (err as Error).message },
      });
    }
  },
);

const PutBodySchema = z.object({
  galpoes: z.array(z.string().min(1)).max(20),
});

// PUT /admin/user-galpao/:user_id — substitui completamente os galpoes do usuario
router.put(
  '/api/v1/stockbridge/admin/user-galpao/:user_id',
  requireDiretor,
  async (req: Request, res: Response) => {
    const userId = req.params.user_id as string | undefined;
    if (!userId) {
      res.status(400).json({
        data: null,
        error: { code: 'INVALID_INPUT', message: 'user_id obrigatorio' },
      });
      return;
    }
    const parsed = PutBodySchema.safeParse(req.body);
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
      await setGalpoesDoUsuario(userId, parsed.data.galpoes);
      res.json({ data: { userId, galpoes: parsed.data.galpoes }, error: null });
    } catch (err) {
      logger.error({ err, userId }, 'Erro ao atualizar galpoes do usuario');
      res.status(500).json({
        data: null,
        error: { code: 'USER_GALPAO_UPDATE_FAIL', message: (err as Error).message },
      });
    }
  },
);

export default router;
