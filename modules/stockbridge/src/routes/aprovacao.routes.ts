import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireGestor, requireOperador } from '../middleware/role.js';
import {
  listarPendencias,
  aprovar,
  rejeitar,
  resubmeter,
  AprovacaoNaoEncontradaError,
  AprovacaoNivelInsuficienteError,
  AprovacaoStatusInvalidoError,
} from '../services/aprovacao.service.js';
import type { Perfil } from '../types.js';

const logger = createLogger('stockbridge:aprovacao');
const router: Router = Router();

// GET /api/v1/stockbridge/aprovacoes — gestor e diretor
router.get('/api/v1/stockbridge/aprovacoes', requireGestor, async (req: Request, res: Response) => {
  try {
    const perfil = (req.user?.role ?? 'gestor') as Perfil;
    const data = await listarPendencias(perfil);
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar aprovacoes');
    res.status(500).json({ data: null, error: { code: 'LISTAR_FAIL', message: (err as Error).message } });
  }
});

// POST /api/v1/stockbridge/aprovacoes/:id/aprovar
router.post('/api/v1/stockbridge/aprovacoes/:id/aprovar', requireGestor, async (req: Request, res: Response) => {
  const id = req.params.id as string | undefined;
  const userId = req.user?.id;
  const perfil = (req.user?.role ?? 'gestor') as Perfil;
  if (!userId || !id) {
    res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessao invalida' } });
    return;
  }
  try {
    const result = await aprovar({ id, usuarioId: userId, perfilUsuario: perfil });
    res.json({ data: result, error: null });
  } catch (err) {
    tratarErro(res, err);
  }
});

// POST /api/v1/stockbridge/aprovacoes/:id/rejeitar
const RejeitarSchema = z.object({ motivo: z.string().min(1) });
router.post('/api/v1/stockbridge/aprovacoes/:id/rejeitar', requireGestor, async (req: Request, res: Response) => {
  const id = req.params.id as string | undefined;
  const userId = req.user?.id;
  const perfil = (req.user?.role ?? 'gestor') as Perfil;
  if (!userId || !id) {
    res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessao invalida' } });
    return;
  }
  const parsed = RejeitarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'motivo e obrigatorio' } });
    return;
  }
  try {
    const result = await rejeitar({ id, usuarioId: userId, perfilUsuario: perfil, motivo: parsed.data.motivo });
    res.json({ data: result, error: null });
  } catch (err) {
    tratarErro(res, err);
  }
});

// POST /api/v1/stockbridge/aprovacoes/:id/resubmeter — operador
const ResubmeterSchema = z.object({
  quantidade_recebida_t: z.number().positive(),
  observacoes: z.string().min(1),
});
router.post('/api/v1/stockbridge/aprovacoes/:id/resubmeter', requireOperador, async (req: Request, res: Response) => {
  const id = req.params.id as string | undefined;
  const userId = req.user?.id;
  if (!userId || !id) {
    res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessao invalida' } });
    return;
  }
  const parsed = ResubmeterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      data: null,
      error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
    });
    return;
  }
  try {
    const result = await resubmeter({
      id,
      usuarioId: userId,
      quantidadeRecebidaT: parsed.data.quantidade_recebida_t,
      observacoes: parsed.data.observacoes,
    });
    res.json({ data: result, error: null });
  } catch (err) {
    tratarErro(res, err);
  }
});

function tratarErro(res: Response, err: unknown) {
  if (err instanceof AprovacaoNaoEncontradaError) {
    res.status(404).json({ data: null, error: { code: 'APROVACAO_NAO_ENCONTRADA', message: err.message } });
    return;
  }
  if (err instanceof AprovacaoNivelInsuficienteError) {
    res.status(403).json({ data: null, error: { code: 'APROVACAO_NIVEL_INSUFICIENTE', message: err.message } });
    return;
  }
  if (err instanceof AprovacaoStatusInvalidoError) {
    res.status(409).json({ data: null, error: { code: 'APROVACAO_STATUS_INVALIDO', message: err.message } });
    return;
  }
  logger.error({ err }, 'Erro inesperado em aprovacao');
  res.status(500).json({ data: null, error: { code: 'APROVACAO_FAIL', message: (err as Error).message } });
}

export default router;
