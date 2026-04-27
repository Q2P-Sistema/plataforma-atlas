import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireOperador, requireGestor } from '../middleware/role.js';
import {
  retentarOperacaoPendente,
  listarPendentes,
  marcarComoFalhaDefinitiva,
  OperacaoPendenteNaoEncontradaError,
  OperacaoNaoPendenteError,
  OperadorSemRetentativasError,
} from '../services/operacoes-pendentes.service.js';
import { OmieAjusteError } from '../services/recebimento.service.js';
import { mapearErroOmieParaResposta } from '../services/erros-omie.js';
import type { Perfil } from '../types.js';

const logger = createLogger('stockbridge:operacoes-pendentes');
const router: Router = Router();

const ParamsSchema = z.object({ id: z.string().uuid() });

/**
 * GET /api/v1/stockbridge/operacoes-pendentes
 * Lista movimentacoes com OMIE pendente. Apenas gestor/diretor.
 */
router.get('/api/v1/stockbridge/operacoes-pendentes', requireGestor, async (_req: Request, res: Response) => {
  try {
    const data = await listarPendentes();
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar operacoes pendentes');
    res.status(500).json({
      data: null,
      error: { code: 'LISTAR_PENDENTES_FAIL', message: (err as Error).message },
    });
  }
});

/**
 * POST /api/v1/stockbridge/operacoes-pendentes/:id/marcar-falha
 * Marca pendencia como falha definitiva (nao-recuperavel). Apenas gestor/diretor.
 */
const MarcarFalhaSchema = z.object({ motivo: z.string().min(1) });
router.post(
  '/api/v1/stockbridge/operacoes-pendentes/:id/marcar-falha',
  requireGestor,
  async (req: Request, res: Response) => {
    const params = ParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({
        data: null,
        error: { code: 'INVALID_INPUT', message: 'id deve ser um UUID' },
      });
      return;
    }
    const body = MarcarFalhaSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        data: null,
        error: { code: 'INVALID_INPUT', message: 'motivo e obrigatorio' },
      });
      return;
    }
    const userId = req.user?.id;
    const role = (req.user?.role ?? 'gestor') as Perfil;
    if (!userId) {
      res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessao invalida' } });
      return;
    }
    try {
      const result = await marcarComoFalhaDefinitiva({
        movimentacaoId: params.data.id,
        motivo: body.data.motivo,
        ator: { userId, role },
      });
      res.json({ data: result, error: null });
    } catch (err) {
      if (err instanceof OperacaoPendenteNaoEncontradaError) {
        res.status(404).json({
          data: null,
          error: { code: 'OPERACAO_PENDENTE_NAO_ENCONTRADA', message: err.message },
        });
        return;
      }
      if (err instanceof OperacaoNaoPendenteError) {
        res.status(409).json({
          data: null,
          error: { code: 'OPERACAO_NAO_PENDENTE', message: err.message },
        });
        return;
      }
      logger.error({ err, movimentacaoId: params.data.id }, 'Erro ao marcar operacao como falha');
      res.status(500).json({
        data: null,
        error: { code: 'MARCAR_FALHA_FAIL', message: (err as Error).message },
      });
    }
  },
);

/**
 * POST /api/v1/stockbridge/operacoes-pendentes/:id/retentar
 *
 * Retenta o lado pendente de uma movimentacao OMIE.
 * - Operador: apenas pendente_q2p, ate o limite de tentativas (1 retry alem do inicial).
 * - Gestor/diretor: sem limite, ambos os lados.
 *
 * O middleware aceita qualquer ator autenticado; a regra fina vai pro service.
 */
router.post(
  '/api/v1/stockbridge/operacoes-pendentes/:id/retentar',
  requireOperador,
  async (req: Request, res: Response) => {
    const params = ParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({
        data: null,
        error: { code: 'INVALID_INPUT', message: 'id deve ser um UUID' },
      });
      return;
    }
    const userId = req.user?.id;
    const role = (req.user?.role ?? 'operador') as Perfil;
    if (!userId) {
      res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessao invalida' } });
      return;
    }

    try {
      const result = await retentarOperacaoPendente({
        movimentacaoId: params.data.id,
        ator: { userId, role },
      });
      res.json({ data: result, error: null });
    } catch (err) {
      if (err instanceof OperacaoPendenteNaoEncontradaError) {
        res.status(404).json({
          data: null,
          error: { code: 'OPERACAO_PENDENTE_NAO_ENCONTRADA', message: err.message },
        });
        return;
      }
      if (err instanceof OperacaoNaoPendenteError) {
        res.status(409).json({
          data: null,
          error: { code: 'OPERACAO_NAO_PENDENTE', message: err.message },
        });
        return;
      }
      if (err instanceof OperadorSemRetentativasError) {
        res.status(403).json({
          data: null,
          error: {
            code: 'OPERADOR_SEM_RETENTATIVAS',
            message: err.message,
            userMessage: 'Voce ja esgotou as retentativas permitidas. Acione um gestor/diretor.',
            userAction: 'contact_admin',
            retryable: false,
          },
        });
        return;
      }
      if (err instanceof OmieAjusteError) {
        const { httpStatus, body } = mapearErroOmieParaResposta(err, { role });
        res.status(httpStatus).json({ data: null, error: body });
        return;
      }
      logger.error({ err, movimentacaoId: params.data.id }, 'Erro inesperado em retentar operacao pendente');
      res.status(500).json({
        data: null,
        error: { code: 'RETENTAR_FAIL', message: (err as Error).message },
      });
    }
  },
);

export default router;
