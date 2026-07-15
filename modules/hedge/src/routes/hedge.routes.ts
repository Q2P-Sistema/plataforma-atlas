import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, requireModule, csrfProtection } from '@atlas/auth';
import { createLogger, cached, invalidate, sendSuccess, sendError } from '@atlas/core';
import { calcularPosicao, recalcularBuckets } from '../services/posicao.service.js';
import { calcularMotor } from '../services/motor.service.js';
import { getVariacao30d } from '../services/ptax.service.js';
import { criarNdf, ativarNdf, liquidarNdf, cancelarNdf, listarNdfs, NdfError } from '../services/ndf.service.js';
import { getHistoricoPtax } from '../services/ptax.service.js';
import { simularMargem } from '../services/simulacao.service.js';
import { getEstoque, getLocalidades, salvarLocalidadesAtivas } from '../services/estoque.service.js';
import { listarAlertas, marcarLido, resolver, gerarAlertas } from '../services/alerta.service.js';
import { getConfig, updateConfig, getTaxasNdf, inserirTaxaNdf, ConfigInvalidaError } from '../services/config.service.js';


const logger = createLogger('hedge:routes');
const router: Router = Router();

// All hedge routes require authentication + module access
router.use('/api/v1/hedge', requireAuth, csrfProtection, requireModule('hedge'));

// MOD-16 (ACXEGDP-280): validação Zod nas rotas de escrita/cálculo — antes o
// body cru chegava aos services e input inválido virava 500 (deveria ser 400).
// Mensagens já saem em pt-BR pelo errorMap global (PTB-1).
function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, req: Request, res: Response): T | null {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendError(
      res,
      'VALIDATION_ERROR',
      parsed.error.errors.map((e) => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).join('; '),
      400,
    );
    return null;
  }
  return parsed.data;
}

const DATA_CIVIL = /^\d{4}-\d{2}-\d{2}$/;

// ── Dashboard & Position ───────────────────────────────────

// GET /api/v1/hedge/posicao
router.get('/api/v1/hedge/posicao', async (req: Request, res: Response) => {
  try {
    const empresa = req.query.empresa as 'acxe' | 'q2p' | undefined;
    const cacheKey = `atlas:hedge:posicao:${empresa ?? 'all'}`;

    const { data, hit } = await cached(cacheKey, 300, async () => {
      // Recalculate buckets from OMIE view before returning position
      await recalcularBuckets();
      const result = await calcularPosicao({ empresa });

      // Generate alerts for sub-hedged buckets (GAP-13)
      gerarAlertas(result.buckets).catch((err) => logger.warn({ err }, 'Erro ao gerar alertas'));

      // PTAX 30d variation (non-blocking)
      const variacao30d = await getVariacao30d().catch(() => 0);

      return {
        kpis: {
          exposure_usd: result.kpis.exposure_usd,
          cobertura_pct: result.kpis.cobertura_pct,
          ndf_ativo_usd: result.kpis.ndf_ativo_usd,
          gap_usd: result.kpis.gap_usd,
          ptax_atual: result.kpis.ptax_atual,
          variacao_30d_pct: variacao30d,
          ...result.kpis.resumo,
        },
        buckets: result.buckets.map((b) => ({
          id: b.id,
          mes_ref: b.mesRef,
          empresa: b.empresa,
          pagar_usd: Number(b.pagarUsd),
          est_nao_pago_usd: b.est_nao_pago_usd,
          exposicao_usd: b.exposicao_usd,
          ndf_usd: Number(b.ndfUsd),
          cobertura_pct: Number(b.coberturaPct),
          status: b.status,
        })),
      };
    });

    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    sendSuccess(res, data);
  } catch (err) {
    logger.error({ err }, 'Erro ao calcular posicao');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao calcular posicao', 500);
  }
});

// MOD-06 (ACXEGDP-277): GET /posicao/historico removido — o endpoint lia
// hedge.posicao_snapshot, que nada popula (salvarSnapshot nao tinha chamador) e
// nenhum frontend consome. Codigo morto ponta a ponta; a tabela permanece para
// uma futura feature de historico de exposicao.

// ── Motor de Minima Variancia ──────────────────────────────

const MotorCalcularSchema = z.object({
  lambda: z.number().min(0).max(1).default(0.5),
  pct_estoque_nao_pago: z.number().min(0).max(1).default(0),
});

// POST /api/v1/hedge/motor/calcular
router.post(
  '/api/v1/hedge/motor/calcular',
  async (req: Request, res: Response) => {
    try {
      const body = parseBody(MotorCalcularSchema, req, res);
      if (!body) return;
      const { lambda, pct_estoque_nao_pago } = body;
      const result = await calcularMotor({ lambda, pct_estoque_nao_pago });
      sendSuccess(res, {
        camadas: result.camadas,
        recomendacoes: result.recomendacoes,
        alertas: result.alertas,
        cobertura_global_pct: result.cobertura_global_pct,
        gap_total_usd: result.gap_total_usd,
        custo_acao_brl: result.custo_acao_brl,
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
        banco: n.banco,
        observacao: n.observacao,
      })),
    );
  } catch (err) {
    logger.error({ err }, 'Erro ao listar NDFs');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao listar NDFs', 500);
  }
});

const CriarNdfSchema = z.object({
  tipo: z.enum(['ndf', 'trava', 'acc']),
  notional_usd: z.number().positive(),
  taxa_ndf: z.number().positive(),
  prazo_dias: z.number().int().positive(),
  data_vencimento: z.string().regex(DATA_CIVIL, 'Data no formato AAAA-MM-DD'),
  empresa: z.enum(['acxe', 'q2p']),
  banco: z.string().min(1).optional(),
  observacao: z.string().optional(),
});

// POST /api/v1/hedge/ndfs
router.post('/api/v1/hedge/ndfs', async (req: Request, res: Response) => {
  try {
    const body = parseBody(CriarNdfSchema, req, res);
    if (!body) return;

    const ndf = await criarNdf({
      tipo: body.tipo,
      notional_usd: body.notional_usd,
      taxa_ndf: body.taxa_ndf,
      prazo_dias: body.prazo_dias,
      data_vencimento: body.data_vencimento,
      empresa: body.empresa,
      banco: body.banco,
      observacao: body.observacao,
    });

    invalidate('atlas:hedge:posicao:*').catch(() => {});
    sendSuccess(res, {
      id: ndf.id,
      tipo: ndf.tipo,
      notional_usd: Number(ndf.notionalUsd),
      custo_brl: Number(ndf.custoBrl),
      status: ndf.status,
      banco: ndf.banco,
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
    invalidate('atlas:hedge:posicao:*').catch(() => {});
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

const LiquidarNdfSchema = z
  .object({
    ptax_liquidacao: z.number().positive().optional(),
    resultado_brl: z.number().optional(),
  })
  .refine((d) => d.ptax_liquidacao != null || d.resultado_brl != null, {
    message: 'ptax_liquidacao ou resultado_brl e obrigatorio',
  });

// PATCH /api/v1/hedge/ndfs/:id/liquidar
router.patch('/api/v1/hedge/ndfs/:id/liquidar', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const body = parseBody(LiquidarNdfSchema, req, res);
    if (!body) return;

    const ndf = await liquidarNdf(id, { ptax_liquidacao: body.ptax_liquidacao, resultado_brl: body.resultado_brl });
    invalidate('atlas:hedge:posicao:*').catch(() => {});
    sendSuccess(res, {
      status: 'liquidado',
      resultado_brl: Number(ndf.resultadoBrl),
      ptax_liquidacao: ndf.ptaxLiquidacao ? Number(ndf.ptaxLiquidacao) : null,
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
    invalidate('atlas:hedge:posicao:*').catch(() => {});
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

const SimulacaoMargemSchema = z.object({
  faturamento_brl: z.number().positive(),
  outros_custos_brl: z.number().min(0),
  volume_usd: z.number().min(0).optional(),
  pct_custo_importado: z.number().min(0).max(100).optional(),
  ndf_taxa_media: z.number().positive().default(5.5),
  pct_cobertura: z.number().min(0).max(100).optional(),
  l1: z.number().min(0).max(100).optional(),
  l2: z.number().min(0).max(100).optional(),
});

// POST /api/v1/hedge/simulacao/margem
router.post(
  '/api/v1/hedge/simulacao/margem',
  async (req: Request, res: Response) => {
    try {
      const body = parseBody(SimulacaoMargemSchema, req, res);
      if (!body) return;
      const { faturamento_brl, outros_custos_brl, volume_usd, pct_custo_importado, ndf_taxa_media, pct_cobertura, l1, l2 } = body;
      const cenarios = simularMargem(
        { faturamento_brl, outros_custos_brl, volume_usd, pct_custo_importado },
        { ndf_taxa_media, pct_cobertura, l1, l2 },
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
    const { data, hit } = await cached('atlas:hedge:localidades', 3600, () => getLocalidades());
    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    sendSuccess(res, data);
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar localidades');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao buscar localidades', 500);
  }
});

const LocalidadesSchema = z.object({
  localidades_ativas: z.array(z.string()),
});

// PUT /api/v1/hedge/estoque/localidades
router.put('/api/v1/hedge/estoque/localidades', async (req: Request, res: Response) => {
  try {
    const body = parseBody(LocalidadesSchema, req, res);
    if (!body) return;
    const { localidades_ativas } = body;
    await salvarLocalidadesAtivas(localidades_ativas);
    invalidate('atlas:hedge:localidades').catch(() => {});
    invalidate('atlas:hedge:posicao:*').catch(() => {});
    // MOD-14 (ACXEGDP-278): getEstoque filtra por localidades_ativas — sem esta
    // invalidacao a tela de estoque mostrava o agregado antigo por ate 1h (TTL 3600).
    invalidate('atlas:hedge:estoque:*').catch(() => {});
    sendSuccess(res, { localidades_ativas });
  } catch (err) {
    logger.error({ err }, 'Erro ao salvar localidades');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao salvar localidades', 500);
  }
});

router.get('/api/v1/hedge/estoque', async (req: Request, res: Response) => {
  try {
    const empresa = req.query.empresa as 'acxe' | 'q2p' | undefined;
    const cacheKey = `atlas:hedge:estoque:${empresa ?? 'all'}`;
    const { data, hit } = await cached(cacheKey, 3600, () => getEstoque({ empresa }));
    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
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
  catch (err) { logger.error({ err }, 'Erro ao marcar alerta como lido'); sendError(res, 'INTERNAL_ERROR', 'Erro', 500); }
});

router.patch('/api/v1/hedge/alertas/:id/resolver', async (req: Request, res: Response) => {
  try { await resolver(req.params.id as string); sendSuccess(res, { resolvido: true }); }
  catch (err) { logger.error({ err }, 'Erro ao resolver alerta'); sendError(res, 'INTERNAL_ERROR', 'Erro', 500); }
});

// ── Config ─────────────────────────────────────────────────

router.get('/api/v1/hedge/config', async (_req: Request, res: Response) => {
  try { sendSuccess(res, await getConfig()); }
  catch (err) { logger.error({ err }, 'Erro ao buscar config do hedge'); sendError(res, 'INTERNAL_ERROR', 'Erro', 500); }
});

const ConfigSchema = z.object({
  chave: z.string().min(1),
  valor: z.unknown(),
});

router.patch('/api/v1/hedge/config', requireRole('diretor'), async (req: Request, res: Response) => {
  try {
    const body = parseBody(ConfigSchema, req, res);
    if (!body) return;
    const { chave, valor } = body;
    await updateConfig(chave, valor);
    sendSuccess(res, { chave, valor });
  } catch (err) {
    if (err instanceof ConfigInvalidaError) {
      sendError(res, 'VALIDATION_ERROR', err.message, 400);
      return;
    }
    logger.error({ err }, 'Erro ao atualizar config do hedge');
    sendError(res, 'INTERNAL_ERROR', 'Erro', 500);
  }
});

router.get('/api/v1/hedge/taxas-ndf', async (req: Request, res: Response) => {
  try {
    const dataRef = req.query.data_ref as string | undefined;
    sendSuccess(res, await getTaxasNdf(dataRef));
  } catch (err) { logger.error({ err }, 'Erro ao buscar taxas NDF'); sendError(res, 'INTERNAL_ERROR', 'Erro', 500); }
});

const TaxaNdfSchema = z.object({
  data_ref: z.string().regex(DATA_CIVIL, 'Data no formato AAAA-MM-DD'),
  prazo_dias: z.number().int().positive(),
  taxa: z.number().positive(),
});

router.post('/api/v1/hedge/taxas-ndf', requireRole('gestor', 'diretor'), async (req: Request, res: Response) => {
  try {
    const body = parseBody(TaxaNdfSchema, req, res);
    if (!body) return;
    await inserirTaxaNdf(body.data_ref, body.prazo_dias, body.taxa);
    sendSuccess(res, { data_ref: body.data_ref, prazo_dias: body.prazo_dias, taxa: body.taxa }, 201);
  } catch (err) { logger.error({ err }, 'Erro ao inserir taxa NDF'); sendError(res, 'INTERNAL_ERROR', 'Erro', 500); }
});

export default router;
