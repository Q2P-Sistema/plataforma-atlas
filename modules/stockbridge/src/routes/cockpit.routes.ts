import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger, getPool } from '@atlas/core';
import { requireGestor } from '../middleware/role.js';
import { getCockpit } from '../services/cockpit.service.js';

const logger = createLogger('stockbridge:cockpit');
const router: Router = Router();

const QuerySchema = z.object({
  familia: z.string().optional(),
  cnpj: z.enum(['acxe', 'q2p', 'ambos']).optional(),
  galpao: z.string().optional(),
  criticidade: z.enum(['critico', 'alerta', 'ok', 'excesso', 'todas']).optional(),
});

router.get('/api/v1/stockbridge/cockpit', requireGestor, async (req: Request, res: Response) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      data: null,
      error: { code: 'INVALID_QUERY', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
    });
    return;
  }

  try {
    const data = await getCockpit(parsed.data);
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao montar cockpit');
    res.status(500).json({
      data: null,
      error: { code: 'COCKPIT_FAIL', message: (err as Error).message },
    });
  }
});

// Lista de familias disponiveis no Cockpit (pra dropdown de filtro).
// Usa descricao_familia bruta da tbl_produtos_ACXE — sem agregacao via
// familia_atlas. Mantem o filtro incluir_em_metricas para excluir categorias
// operacionais (USO E CONSUMO, ATIVO IMOBILIZADO, UNIFORMES, etc).
router.get('/api/v1/stockbridge/familias', requireGestor, async (_req: Request, res: Response) => {
  try {
    const pool = getPool();
    const result = await pool.query<{ familia: string }>(
      `SELECT DISTINCT p.descricao_familia AS familia
         FROM public."tbl_produtos_ACXE" p
         LEFT JOIN stockbridge.familia_omie_atlas f
           ON f.familia_omie = p.descricao_familia
         LEFT JOIN stockbridge.config_produto c
           ON c.produto_codigo_acxe = p.codigo_produto
         WHERE COALESCE(f.incluir_em_metricas, true) = true
           AND COALESCE(c.incluir_em_metricas, true) = true
           AND p.descricao_familia IS NOT NULL
           AND p.descricao_familia <> ''
         ORDER BY familia`,
    );
    res.json({ data: result.rows.map((r) => r.familia), error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar familias');
    res.status(500).json({
      data: null,
      error: { code: 'FAMILIAS_FAIL', message: (err as Error).message },
    });
  }
});

export default router;
