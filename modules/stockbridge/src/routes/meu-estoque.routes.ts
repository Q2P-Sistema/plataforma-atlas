import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireOperador } from '../middleware/role.js';
import {
  listarMeuEstoque,
  getGalpoesDoUsuario,
  type EmpresaFiltro,
} from '../services/meu-estoque.service.js';

const logger = createLogger('stockbridge:meu-estoque');
const router: Router = Router();

const QuerySchema = z.object({
  empresa: z.enum(['ACXE', 'Q2P', 'Ambos']).optional(),
  galpao: z.string().optional(), // override pra gestor/diretor escolher um galpao
});

/**
 * GET /api/v1/stockbridge/meu-estoque
 *  - operador: filtra automaticamente pelos galpoes vinculados (user_galpao)
 *  - gestor/diretor: ve todos por padrao; aceita ?galpao=11 pra restringir
 *  - ?empresa=ACXE|Q2P|Ambos (default Q2P pra evitar duplicatas em espelhados)
 */
router.get('/api/v1/stockbridge/meu-estoque', requireOperador, async (req: Request, res: Response) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      data: null,
      error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => i.message).join('; ') },
    });
    return;
  }

  const empresa: EmpresaFiltro = parsed.data.empresa ?? 'Q2P';
  const userId = req.user?.id;
  const role = req.user?.role ?? 'operador';

  let galpoes: string[];

  if (parsed.data.galpao) {
    // Override explicito
    galpoes = [parsed.data.galpao];
  } else if (role === 'operador' && userId) {
    galpoes = await getGalpoesDoUsuario(userId);
    if (galpoes.length === 0) {
      res.status(403).json({
        data: null,
        error: {
          code: 'SEM_GALPAO_VINCULADO',
          message: 'Operador sem galpao vinculado. Solicite atribuicao ao gestor.',
        },
      });
      return;
    }
  } else {
    // gestor/diretor sem ?galpao= ve todos
    galpoes = [];
  }

  try {
    const data = await listarMeuEstoque(galpoes, empresa);
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar meu-estoque');
    res.status(500).json({
      data: null,
      error: { code: 'MEU_ESTOQUE_FAIL', message: (err as Error).message },
    });
  }
});

export default router;
