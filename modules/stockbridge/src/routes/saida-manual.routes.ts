import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireOperador } from '../middleware/role.js';
import {
  registrarSaidaManual,
  registrarRetornoComodato,
  LoteInvalidoError,
  SubtipoInvalidoError,
} from '../services/saida-manual.service.js';

const logger = createLogger('stockbridge:saida-manual');
const router: Router = Router();

const SaidaSchema = z.object({
  subtipo: z.enum(['transf_intra_cnpj', 'comodato', 'amostra', 'descarte', 'quebra', 'inventario_menos']),
  lote_id: z.string().uuid(),
  quantidade_original: z.number().positive(),
  unidade: z.enum(['t', 'kg', 'saco', 'bigbag']),
  localidade_destino_id: z.string().uuid().optional(),
  referencia: z.string().optional(),
  observacoes: z.string().min(1),
});

router.post('/api/v1/stockbridge/saida-manual', requireOperador, async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessao sem usuario' } });
    return;
  }
  const parsed = SaidaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      data: null,
      error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
    });
    return;
  }
  try {
    const result = await registrarSaidaManual({
      subtipo: parsed.data.subtipo,
      loteId: parsed.data.lote_id,
      quantidadeOriginal: parsed.data.quantidade_original,
      unidade: parsed.data.unidade,
      localidadeDestinoId: parsed.data.localidade_destino_id ?? null,
      referencia: parsed.data.referencia,
      observacoes: parsed.data.observacoes,
      userId,
    });
    res.status(201).json({ data: result, error: null });
  } catch (err) {
    if (err instanceof LoteInvalidoError) {
      res.status(409).json({ data: null, error: { code: 'LOTE_STATUS_INVALIDO', message: err.message } });
      return;
    }
    if (err instanceof SubtipoInvalidoError) {
      res.status(400).json({ data: null, error: { code: 'SUBTIPO_INVALIDO', message: err.message } });
      return;
    }
    logger.error({ err }, 'Erro em saida manual');
    res.status(500).json({ data: null, error: { code: 'SAIDA_MANUAL_FAIL', message: (err as Error).message } });
  }
});

const RetornoSchema = z.object({
  quantidade_retornada_t: z.number().positive(),
  observacoes: z.string().min(1),
});

router.post('/api/v1/stockbridge/comodato/:movimentacao_id/retorno', requireOperador, async (req: Request, res: Response) => {
  const userId = req.user?.id;
  const movimentacaoId = req.params.movimentacao_id as string | undefined;
  if (!userId || !movimentacaoId) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'dados invalidos' } });
    return;
  }
  const parsed = RetornoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => i.message).join('; ') } });
    return;
  }
  try {
    const result = await registrarRetornoComodato({
      movimentacaoOrigemId: movimentacaoId,
      quantidadeRetornadaT: parsed.data.quantidade_retornada_t,
      observacoes: parsed.data.observacoes,
      userId,
    });
    res.status(201).json({ data: result, error: null });
  } catch (err) {
    if (err instanceof LoteInvalidoError) {
      res.status(409).json({ data: null, error: { code: 'LOTE_STATUS_INVALIDO', message: err.message } });
      return;
    }
    logger.error({ err }, 'Erro em retorno comodato');
    res.status(500).json({ data: null, error: { code: 'RETORNO_COMODATO_FAIL', message: (err as Error).message } });
  }
});

export default router;
