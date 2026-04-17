import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireDiretor } from '../middleware/role.js';
import { listarConfigProdutos, upsertConfigProduto } from '../services/config-produto.service.js';

const logger = createLogger('stockbridge:config');
const router: Router = Router();

router.get('/api/v1/stockbridge/config/produtos', requireDiretor, async (_req: Request, res: Response) => {
  try {
    const data = await listarConfigProdutos();
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar config produtos');
    res.status(500).json({ data: null, error: { code: 'CONFIG_FAIL', message: (err as Error).message } });
  }
});

const PatchSchema = z.object({
  consumo_medio_diario_t: z.number().nonnegative().nullable().optional(),
  lead_time_dias: z.number().int().min(0).nullable().optional(),
  familia_categoria: z.string().max(50).nullable().optional(),
  incluir_em_metricas: z.boolean().optional(),
});

router.patch('/api/v1/stockbridge/config/produtos/:codigo_acxe', requireDiretor, async (req: Request, res: Response) => {
  const userId = req.user?.id;
  const codigoStr = req.params.codigo_acxe as string | undefined;
  if (!userId || !codigoStr) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'usuario/codigo invalidos' } });
    return;
  }
  const codigo = Number(codigoStr);
  if (!Number.isFinite(codigo) || codigo <= 0) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'codigo_acxe invalido' } });
    return;
  }
  const parsed = PatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => i.message).join('; ') } });
    return;
  }
  try {
    const data = await upsertConfigProduto({
      produtoCodigoAcxe: codigo,
      consumoMedioDiarioT: parsed.data.consumo_medio_diario_t,
      leadTimeDias: parsed.data.lead_time_dias,
      familiaCategoria: parsed.data.familia_categoria,
      incluirEmMetricas: parsed.data.incluir_em_metricas,
      userId,
    });
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao upsert config produto');
    res.status(500).json({ data: null, error: { code: 'CONFIG_FAIL', message: (err as Error).message } });
  }
});

export default router;
