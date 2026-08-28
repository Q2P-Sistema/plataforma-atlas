import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireGestor } from '../middleware/role.js';
import {
  listarBaixasPendentes,
  listarLedgerDaMovimentacao,
  retentarBaixaPedidoQ2p,
  BaixaPedidoMovimentacaoNaoEncontradaError,
  BaixaPedidoNaoAplicavelError,
} from '../services/baixa-pedido.service.js';
import type { Perfil } from '../types.js';

/**
 * Baixa do pedido de compra Q2P após recebimento (ACXEGDP-344).
 * Painel e retry — gestor/diretor. O disparo automático acontece no fluxo
 * (recebimento/aprovação/retry OMIE); aqui só o que ficou pendente/falhou.
 */
const logger = createLogger('stockbridge:baixa-pedido');
const router: Router = Router();

const ParamsSchema = z.object({ id: z.string().uuid() });
const RetentarBodySchema = z.object({ dryRun: z.boolean().optional() }).default({});

/** GET /api/v1/stockbridge/baixa-pedido/pendentes — movimentações com baixa pendente/falha/sem_saldo. */
router.get(
  '/api/v1/stockbridge/baixa-pedido/pendentes',
  requireGestor,
  async (_req: Request, res: Response) => {
    try {
      const data = await listarBaixasPendentes();
      res.json({ data, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro ao listar baixas de pedido pendentes');
      res.status(500).json({
        data: null,
        error: {
          code: 'LISTAR_BAIXAS_FAIL',
          message: (err as Error).message,
        },
      });
    }
  },
);

/** GET /api/v1/stockbridge/baixa-pedido/:id — ledger (pedidos descontados) de uma movimentação. */
router.get('/api/v1/stockbridge/baixa-pedido/:id', requireGestor, async (req: Request, res: Response) => {
  const params = ParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({
      data: null,
      error: { code: 'INVALID_INPUT', message: 'id deve ser um UUID' },
    });
    return;
  }
  try {
    const data = await listarLedgerDaMovimentacao(params.data.id);
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err, movimentacaoId: params.data.id }, 'Erro ao listar ledger da baixa');
    res.status(500).json({
      data: null,
      error: { code: 'LEDGER_BAIXA_FAIL', message: (err as Error).message },
    });
  }
});

/**
 * POST /api/v1/stockbridge/baixa-pedido/:id/retentar
 * Executa/retenta a baixa (idempotente pelo ledger). body.dryRun=true só simula.
 */
router.post(
  '/api/v1/stockbridge/baixa-pedido/:id/retentar',
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
    const body = RetentarBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({
        data: null,
        error: { code: 'INVALID_INPUT', message: 'dryRun deve ser booleano' },
      });
      return;
    }
    const userId = req.user?.id;
    const role = (req.user?.role ?? 'gestor') as Perfil;
    if (!userId) {
      res.status(401).json({
        data: null,
        error: { code: 'UNAUTHENTICATED', message: 'Sessão inválida' },
      });
      return;
    }
    try {
      const data = await retentarBaixaPedidoQ2p({
        movimentacaoId: params.data.id,
        ator: { userId, role },
        dryRun: body.data.dryRun,
      });
      res.json({ data, error: null });
    } catch (err) {
      if (err instanceof BaixaPedidoMovimentacaoNaoEncontradaError) {
        res.status(404).json({
          data: null,
          error: {
            code: 'MOVIMENTACAO_NAO_ENCONTRADA',
            message: err.message,
          },
        });
        return;
      }
      if (err instanceof BaixaPedidoNaoAplicavelError) {
        res.status(409).json({
          data: null,
          error: { code: 'BAIXA_NAO_APLICAVEL', message: err.message },
        });
        return;
      }
      logger.error({ err, movimentacaoId: params.data.id }, 'Erro ao retentar baixa de pedido Q2P');
      res.status(500).json({
        data: null,
        error: {
          code: 'RETENTAR_BAIXA_FAIL',
          message: (err as Error).message,
        },
      });
    }
  },
);

export default router;
