import { Router, type Request, type Response } from 'express';
import { requireAuth } from '@atlas/auth';
import { createLogger } from '@atlas/core';
import { requireRole } from '@atlas/auth';
import { calcularPosicao, recalcularBuckets, getHistorico } from '../services/posicao.service.js';
import { calcularMotor } from '../services/motor.service.js';
import { criarNdf, ativarNdf, liquidarNdf, cancelarNdf, listarNdfs, NdfError } from '../services/ndf.service.js';
import { getHistoricoPtax } from '../services/ptax.service.js';
import { simularMargem } from '../services/simulacao.service.js';
import { getEstoque, getLocalidades, salvarLocalidadesAtivas } from '../services/estoque.service.js';
import { listarAlertas, marcarLido, resolver } from '../services/alerta.service.js';
import { getConfig, updateConfig, getTaxasNdf, inserirTaxaNdf } from '../services/config.service.js';

const logger = createLogger('hedge:routes');
const router: Router = Router();

function sendSuccess(res: Response, data: unknown, status = 200, meta?: Record<string, unknown>) {
  const body: Record<string, unknown> = { data, error: null };
  if (meta) body.meta = meta;
  res.status(status).json(body);
}

function sendError(res: Response, code: string, message: string, status = 400) {
  res.status(status).json({ data: null, error: { code, message } });
}

// All hedge routes require authentication
router.use('/api/v1/hedge', requireAuth);

// ── Dashboard & Position ───────────────────────────────────

// GET /api/v1/hedge/posicao
router.get('/api/v1/hedge/posicao', async (req: Request, res: Response) => {
  try {
    // Recalculate buckets from OMIE view before returning position
    await recalcularBuckets();
    const empresa = req.query.empresa as 'acxe' | 'q2p' | undefined;
    const result = await calcularPosicao({ empresa });

    sendSuccess(res, {
      kpis: {
        exposure_usd: result.kpis.exposure_usd,
        cobertura_pct: result.kpis.cobertura_pct,
        ndf_ativo_usd: result.kpis.ndf_ativo_usd,
        gap_usd: result.kpis.gap_usd,
        ptax_atual: result.kpis.ptax_atual,
        ...result.kpis.resumo,
      },
      buckets: result.buckets.map((b) => ({
        id: b.id,
        mes_ref: b.mesRef,
        empresa: b.empresa,
        pagar_usd: Number(b.pagarUsd),
        ndf_usd: Number(b.ndfUsd),
        cobertura_pct: Number(b.coberturaPct),
        status: b.status,
      })),
    });
  } catch (err) {
    logger.error({ err }, 'Erro ao calcular posicao');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao calcular posicao', 500);
  }
});

// GET /api/v1/hedge/posicao/historico
router.get('/api/v1/hedge/posicao/historico', async (req: Request, res: Response) => {
  try {
    const dias = parseInt(req.query.dias as string, 10) || 90;
    const snapshots = await getHistorico(dias);

    sendSuccess(
      res,
      snapshots.map((s) => ({
        data_ref: s.dataRef,
        exposure_usd: Number(s.exposureUsd),
        ndf_ativo_usd: Number(s.ndfAtivoUsd),
        gap_usd: Number(s.gapUsd),
        cobertura_pct: Number(s.coberturaPct),
        ptax_ref: Number(s.ptaxRef),
      })),
    );
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar historico');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao buscar historico', 500);
  }
});

// ── Motor de Minima Variancia ──────────────────────────────

// POST /api/v1/hedge/motor/calcular
router.post(
  '/api/v1/hedge/motor/calcular',
  requireRole('gestor', 'diretor'),
  async (req: Request, res: Response) => {
    try {
      const { lambda = 0.5, pct_estoque_nao_pago = 0 } = req.body;
      const result = await calcularMotor({ lambda, pct_estoque_nao_pago });
      sendSuccess(res, {
        camadas: result.camadas,
        recomendacoes: result.recomendacoes,
        cobertura_global_pct: result.cobertura_global_pct,
        gap_total_usd: result.gap_total_usd,
      });
    } catch (err) {
      logger.error({ err }, 'Erro ao calcular motor');
      sendError(res, 'INTERNAL_ERROR', 'Erro ao calcular motor', 500);
    }
  },
);

// ── PTAX ───────────────────────────────────────────────────

// GET /api/v1/hedge/ptax
router.get('/api/v1/hedge/ptax', async (req: Request, res: Response) => {
  try {
    const dias = parseInt(req.query.dias as string, 10) || 30;
    const result = await getHistoricoPtax(dias);
    sendSuccess(res, result);
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar PTAX');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao buscar PTAX', 500);
  }
});

// ── NDFs / Contratos ───────────────────────────────────────

// GET /api/v1/hedge/ndfs
router.get('/api/v1/hedge/ndfs', async (req: Request, res: Response) => {
  try {
    const { status, empresa, limit, offset } = req.query;
    const ndfs = await listarNdfs({
      status: status as string | undefined,
      empresa: empresa as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    });

    sendSuccess(
      res,
      ndfs.map((n) => ({
        id: n.id,
        tipo: n.tipo,
        notional_usd: Number(n.notionalUsd),
        taxa_ndf: Number(n.taxaNdf),
        ptax_contratacao: Number(n.ptaxContratacao),
        prazo_dias: n.prazoDias,
        data_contratacao: n.dataContratacao,
        data_vencimento: n.dataVencimento,
        custo_brl: Number(n.custoBrl),
        resultado_brl: n.resultadoBrl ? Number(n.resultadoBrl) : null,
        status: n.status,
        empresa: n.empresa,
        observacao: n.observacao,
      })),
    );
  } catch (err) {
    logger.error({ err }, 'Erro ao listar NDFs');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao listar NDFs', 500);
  }
});

// POST /api/v1/hedge/ndfs
router.post('/api/v1/hedge/ndfs', async (req: Request, res: Response) => {
  try {
    const { tipo, notional_usd, taxa_ndf, prazo_dias, data_vencimento, empresa, observacao } = req.body;

    if (!tipo || !notional_usd || !taxa_ndf || !prazo_dias || !data_vencimento || !empresa) {
      sendError(res, 'VALIDATION_ERROR', 'Campos obrigatorios faltando', 400);
      return;
    }

    const ndf = await criarNdf({
      tipo, notional_usd, taxa_ndf, prazo_dias, data_vencimento, empresa, observacao,
    });

    sendSuccess(res, {
      id: ndf.id,
      tipo: ndf.tipo,
      notional_usd: Number(ndf.notionalUsd),
      custo_brl: Number(ndf.custoBrl),
      status: ndf.status,
    }, 201);
  } catch (err) {
    if (err instanceof NdfError) {
      sendError(res, err.code, err.message, 400);
      return;
    }
    logger.error({ err }, 'Erro ao criar NDF');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao criar NDF', 500);
  }
});

// PATCH /api/v1/hedge/ndfs/:id/ativar
router.patch('/api/v1/hedge/ndfs/:id/ativar', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    await ativarNdf(id);
    sendSuccess(res, { status: 'ativo' });
  } catch (err) {
    if (err instanceof NdfError) {
      sendError(res, err.code, err.message, err.code === 'NOT_FOUND' ? 404 : 400);
      return;
    }
    logger.error({ err }, 'Erro ao ativar NDF');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao ativar NDF', 500);
  }
});

// PATCH /api/v1/hedge/ndfs/:id/liquidar
router.patch('/api/v1/hedge/ndfs/:id/liquidar', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { ptax_liquidacao } = req.body;

    if (!ptax_liquidacao) {
      sendError(res, 'VALIDATION_ERROR', 'ptax_liquidacao e obrigatorio', 400);
      return;
    }

    const ndf = await liquidarNdf(id, ptax_liquidacao);
    sendSuccess(res, {
      status: 'liquidado',
      resultado_brl: Number(ndf.resultadoBrl),
    });
  } catch (err) {
    if (err instanceof NdfError) {
      sendError(res, err.code, err.message, err.code === 'NOT_FOUND' ? 404 : 400);
      return;
    }
    logger.error({ err }, 'Erro ao liquidar NDF');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao liquidar NDF', 500);
  }
});

// PATCH /api/v1/hedge/ndfs/:id/cancelar
router.patch('/api/v1/hedge/ndfs/:id/cancelar', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    await cancelarNdf(id);
    sendSuccess(res, { status: 'cancelado' });
  } catch (err) {
    if (err instanceof NdfError) {
      sendError(res, err.code, err.message, err.code === 'NOT_FOUND' ? 404 : 400);
      return;
    }
    logger.error({ err }, 'Erro ao cancelar NDF');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao cancelar NDF', 500);
  }
});

// ── Simulacao de Margem ────────────────────────────────────

// POST /api/v1/hedge/simulacao/margem
router.post(
  '/api/v1/hedge/simulacao/margem',
  requireRole('gestor', 'diretor'),
  async (req: Request, res: Response) => {
    try {
      const { faturamento_brl, outros_custos_brl, volume_usd, ndf_taxa_media = 5.50, pct_cobertura = 0 } = req.body;
      const cenarios = simularMargem(
        { faturamento_brl, outros_custos_brl, volume_usd },
        { ndf_taxa_media, pct_cobertura },
      );
      sendSuccess(res, { cenarios });
    } catch (err) {
      logger.error({ err }, 'Erro na simulacao');
      sendError(res, 'INTERNAL_ERROR', 'Erro na simulacao', 500);
    }
  },
);

// ── Estoque ────────────────────────────────────────────────

// GET /api/v1/hedge/estoque/localidades
router.get('/api/v1/hedge/estoque/localidades', async (_req: Request, res: Response) => {
  try {
    const data = await getLocalidades();
    sendSuccess(res, data);
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar localidades');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao buscar localidades', 500);
  }
});

// PUT /api/v1/hedge/estoque/localidades
router.put('/api/v1/hedge/estoque/localidades', async (req: Request, res: Response) => {
  try {
    const { localidades_ativas } = req.body;
    if (!Array.isArray(localidades_ativas)) {
      sendError(res, 'VALIDATION_ERROR', 'localidades_ativas deve ser um array', 400);
      return;
    }
    await salvarLocalidadesAtivas(localidades_ativas);
    sendSuccess(res, { localidades_ativas });
  } catch (err) {
    logger.error({ err }, 'Erro ao salvar localidades');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao salvar localidades', 500);
  }
});

router.get('/api/v1/hedge/estoque', async (req: Request, res: Response) => {
  try {
    const empresa = req.query.empresa as 'acxe' | 'q2p' | undefined;
    const data = await getEstoque({ empresa });
    sendSuccess(res, data);
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar estoque');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao buscar estoque', 500);
  }
});

// ── Alertas ────────────────────────────────────────────────

router.get('/api/v1/hedge/alertas', async (req: Request, res: Response) => {
  try {
    const resolvido = req.query.resolvido === 'true' ? true : req.query.resolvido === 'false' ? false : undefined;
    const data = await listarAlertas({ resolvido });
    sendSuccess(res, data.map((a) => ({
      id: a.id, tipo: a.tipo, severidade: a.severidade, mensagem: a.mensagem,
      bucket_id: a.bucketId, lido: a.lido, resolvido: a.resolvido,
      resolvido_at: a.resolvidoAt, created_at: a.createdAt,
    })));
  } catch (err) {
    logger.error({ err }, 'Erro ao listar alertas');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao listar alertas', 500);
  }
});

router.patch('/api/v1/hedge/alertas/:id/lido', async (req: Request, res: Response) => {
  try { await marcarLido(req.params.id as string); sendSuccess(res, { lido: true }); }
  catch (err) { sendError(res, 'INTERNAL_ERROR', 'Erro', 500); }
});

router.patch('/api/v1/hedge/alertas/:id/resolver', async (req: Request, res: Response) => {
  try { await resolver(req.params.id as string); sendSuccess(res, { resolvido: true }); }
  catch (err) { sendError(res, 'INTERNAL_ERROR', 'Erro', 500); }
});

// ── Config ─────────────────────────────────────────────────

router.get('/api/v1/hedge/config', requireRole('gestor', 'diretor'), async (_req: Request, res: Response) => {
  try { sendSuccess(res, await getConfig()); }
  catch (err) { sendError(res, 'INTERNAL_ERROR', 'Erro', 500); }
});

router.patch('/api/v1/hedge/config', requireRole('diretor'), async (req: Request, res: Response) => {
  try {
    const { chave, valor } = req.body;
    await updateConfig(chave, valor);
    sendSuccess(res, { chave, valor });
  } catch (err) { sendError(res, 'INTERNAL_ERROR', 'Erro', 500); }
});

router.get('/api/v1/hedge/taxas-ndf', async (req: Request, res: Response) => {
  try {
    const dataRef = req.query.data_ref as string | undefined;
    sendSuccess(res, await getTaxasNdf(dataRef));
  } catch (err) { sendError(res, 'INTERNAL_ERROR', 'Erro', 500); }
});

router.post('/api/v1/hedge/taxas-ndf', requireRole('gestor', 'diretor'), async (req: Request, res: Response) => {
  try {
    const { data_ref, prazo_dias, taxa } = req.body;
    await inserirTaxaNdf(data_ref, prazo_dias, taxa);
    sendSuccess(res, { data_ref, prazo_dias, taxa }, 201);
  } catch (err) { sendError(res, 'INTERNAL_ERROR', 'Erro', 500); }
});

export default router;
