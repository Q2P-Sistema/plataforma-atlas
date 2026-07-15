import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, requireModule, csrfProtection } from '@atlas/auth';
import { createLogger, cached, invalidate, sendSuccess, sendError } from '@atlas/core';
import { getFamilias } from '../services/familia.service.js';
import { getVendas12mByCodigo } from '../services/vendas.service.js';
import { calcularForecast, getFamiliasUrgentes } from '../services/forecast.service.js';
import { getSazonalidade, updateSazFactor } from '../services/sazonalidade.service.js';
import { getAllConfig, updateConfig, ConfigInvalidaError } from '../services/config.service.js';
import { getVendasMensais } from '../services/demanda.service.js';
import { getInsights } from '../services/insights.service.js';
import { analyzeShoppingList } from '../services/ai-analysis.service.js';

const logger = createLogger('forecast:routes');
const router: Router = Router();

// All forecast routes require authentication + module access
router.use('/api/v1/forecast', requireAuth, csrfProtection, requireModule('forecast'));

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

// MOD-10 (ACXEGDP-279): rotas de leitura pesadas passam pelo cache Redis
// (padrão do hedge/bp); PATCHes invalidam atlas:forecast:*.
const invalidarForecast = (): void => {
  invalidate('atlas:forecast:*').catch(() => {});
};

// ── Familias + Estoque ────────────────────────────────────

// GET /api/v1/forecast/familias
router.get('/api/v1/forecast/familias', async (_req: Request, res: Response) => {
  try {
    const { data, hit } = await cached('atlas:forecast:familias', 600, async () => {
      const [familias, vendasMap] = await Promise.all([
        getFamilias(),
        getVendas12mByCodigo(),
      ]);

      return familias.map((f) => {
        // f.skus tem uma entrada por local — deduplicar por codigo antes de somar
        // vendas, senao produto multi-local infla vendas12m 2x-4x (MOD-02).
        const codigosUnicos = [...new Set(f.skus.map((sk) => sk.codigo))];
        const vendas12m = codigosUnicos.reduce((s, codigo) => s + (vendasMap.get(codigo) ?? 0), 0);
        const vendaDiariaMedia = vendas12m > 0 ? Math.round(vendas12m / 365) : 0;
        const coberturaDias = vendaDiariaMedia > 0 ? Math.round(f.pool_total / vendaDiariaMedia) : 999;
        const status = coberturaDias <= 30 ? 'critico' : coberturaDias <= 60 ? 'atencao' : 'ok';

        return {
          familia_id: f.familia_id,
          familia_nome: f.familia_nome,
          is_internacional: f.is_internacional,
          pool_disponivel: f.pool_disponivel,
          pool_bloqueado: f.pool_bloqueado,
          pool_transito: f.pool_transito,
          pool_total: f.pool_total,
          cmc_medio: f.cmc_medio,
          vendas12m,
          venda_diaria_media: vendaDiariaMedia,
          cobertura_dias: coberturaDias,
          lt_efetivo: f.lt_efetivo,
          status,
          skus_count: f.skus.length,
          skus: f.skus,
        };
      });
    });

    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    sendSuccess(res, data);
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar familias');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao buscar familias', 500);
  }
});

// ── Forecast Engine ───────────────────────────────────────

const CalcularSchema = z.object({
  familia_id: z.string().min(1).optional(),
  ajustes_demanda: z.record(z.number()).optional(),
});

// POST /api/v1/forecast/calcular
router.post('/api/v1/forecast/calcular', async (req: Request, res: Response) => {
  try {
    const body = parseBody(CalcularSchema, req, res);
    if (!body) return;

    // Só o cálculo "cheio" (sem filtro nem ajustes) é cacheável — é o payload
    // default da tela, recalculado a cada clique antes do MOD-10.
    const semParametros = !body.familia_id && !Object.keys(body.ajustes_demanda ?? {}).length;
    if (semParametros) {
      const { data, hit } = await cached('atlas:forecast:calcular:all', 300, () => calcularForecast());
      res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
      sendSuccess(res, data);
      return;
    }

    const results = await calcularForecast(body.familia_id, body.ajustes_demanda ?? {});
    sendSuccess(res, results);
  } catch (err) {
    logger.error({ err }, 'Erro ao calcular forecast');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao calcular forecast', 500);
  }
});

// GET /api/v1/forecast/urgentes
router.get('/api/v1/forecast/urgentes', async (_req: Request, res: Response) => {
  try {
    const { data, hit } = await cached('atlas:forecast:urgentes', 300, () => getFamiliasUrgentes());
    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    sendSuccess(res, data);
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar urgentes');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao buscar urgentes', 500);
  }
});

// ── Sazonalidade ──────────────────────────────────────────

// GET /api/v1/forecast/sazonalidade
router.get('/api/v1/forecast/sazonalidade', async (_req: Request, res: Response) => {
  try {
    const saz = await getSazonalidade();
    sendSuccess(res, saz);
  } catch (err) {
    sendError(res, 'INTERNAL_ERROR', 'Erro ao buscar sazonalidade', 500);
  }
});

const SazonalidadeSchema = z.object({
  familia_id: z.string().min(1),
  mes: z.number().int().min(1).max(12),
  fator: z.number().min(0.1).max(3.0),
});

// PATCH /api/v1/forecast/sazonalidade
router.patch('/api/v1/forecast/sazonalidade', async (req: Request, res: Response) => {
  try {
    const body = parseBody(SazonalidadeSchema, req, res);
    if (!body) return;
    // MOD-25: passa o usuário para a trilha de auditoria (sazonalidade_log.usuario);
    // sem isso todo ajuste manual de sazonalidade ficava gravado como usuario=null.
    const result = await updateSazFactor(body.familia_id, body.mes, body.fator, req.user?.id);
    invalidarForecast();
    sendSuccess(res, { familia_id: body.familia_id, mes: body.mes, ...result });
  } catch (err) {
    logger.error({ err }, 'Erro ao atualizar sazonalidade');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao atualizar sazonalidade', 500);
  }
});

// ── Config ────────────────────────────────────────────────

// GET /api/v1/forecast/config
router.get('/api/v1/forecast/config', async (_req: Request, res: Response) => {
  try {
    sendSuccess(res, await getAllConfig());
  } catch (err) {
    sendError(res, 'INTERNAL_ERROR', 'Erro ao buscar config', 500);
  }
});

const ConfigSchema = z.object({
  chave: z.string().min(1),
  valor: z.unknown(),
});

// PATCH /api/v1/forecast/config
router.patch('/api/v1/forecast/config', requireRole('gestor', 'diretor'), async (req: Request, res: Response) => {
  try {
    const body = parseBody(ConfigSchema, req, res);
    if (!body) return;
    await updateConfig(body.chave, body.valor);
    invalidarForecast();
    sendSuccess(res, { chave: body.chave, valor: body.valor });
  } catch (err) {
    if (err instanceof ConfigInvalidaError) {
      sendError(res, 'VALIDATION_ERROR', err.message, 400);
      return;
    }
    logger.error({ err }, 'Erro ao atualizar config');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao atualizar config', 500);
  }
});

// ── Demanda Mensal ───────────────────────────────────────

// GET /api/v1/forecast/demanda
router.get('/api/v1/forecast/demanda', async (_req: Request, res: Response) => {
  try {
    const { data, hit } = await cached('atlas:forecast:demanda', 900, () => getVendasMensais());
    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    sendSuccess(res, data);
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar demanda mensal');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao buscar demanda mensal', 500);
  }
});

// ── Business Insights ────────────────────────────────────

// GET /api/v1/forecast/insights
router.get('/api/v1/forecast/insights', async (_req: Request, res: Response) => {
  try {
    const { data, hit } = await cached('atlas:forecast:insights', 900, () => getInsights());
    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    sendSuccess(res, data);
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar insights');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao buscar insights', 500);
  }
});

// ── Shopping List AI Analysis ────────────────────────────

const ShoppingListSchema = z.object({
  itens: z
    .array(
      z.object({
        familia: z.string(),
        qtd_kg: z.number(),
        valor_brl: z.number(),
        ruptura_dias: z.number(),
        lt_dias: z.number(),
        cobertura_dias: z.number(),
        is_local: z.boolean(),
      }),
    )
    .min(1),
});

// POST /api/v1/forecast/shopping-list/analyze
router.post('/api/v1/forecast/shopping-list/analyze', async (req: Request, res: Response) => {
  try {
    const body = parseBody(ShoppingListSchema, req, res);
    if (!body) return;
    const result = await analyzeShoppingList(body.itens);
    if (!result) {
      sendError(res, 'LLM_UNAVAILABLE', 'Servico de analise temporariamente indisponivel. Tente novamente em alguns minutos.', 503);
      return;
    }
    sendSuccess(res, result);
  } catch (err) {
    logger.error({ err }, 'Erro na analise IA');
    sendError(res, 'INTERNAL_ERROR', 'Erro na analise', 500);
  }
});

export default router;
