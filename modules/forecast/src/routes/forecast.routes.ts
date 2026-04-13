import { Router, type Request, type Response } from 'express';
import { requireAuth } from '@atlas/auth';
import { createLogger } from '@atlas/core';
import { requireRole } from '@atlas/auth';
import { getFamilias } from '../services/familia.service.js';
import { getVendas12mByCodigo } from '../services/vendas.service.js';
import { calcularForecast, getFamiliasUrgentes } from '../services/forecast.service.js';
import { getSazonalidade, updateSazFactor } from '../services/sazonalidade.service.js';
import { getAllConfig, updateConfig } from '../services/config.service.js';

const logger = createLogger('forecast:routes');
const router: Router = Router();

function sendSuccess(res: Response, data: unknown, status = 200) {
  res.status(status).json({ data, error: null });
}

function sendError(res: Response, code: string, message: string, status = 400) {
  res.status(status).json({ data: null, error: { code, message } });
}

// All forecast routes require authentication
router.use('/api/v1/forecast', requireAuth);

// ── Familias + Estoque ────────────────────────────────────

// GET /api/v1/forecast/familias
router.get('/api/v1/forecast/familias', async (_req: Request, res: Response) => {
  try {
    const [familias, vendasMap] = await Promise.all([
      getFamilias(),
      getVendas12mByCodigo(),
    ]);

    const result = familias.map((f) => {
      const vendas12m = f.skus.reduce((s, sk) => s + (vendasMap.get(sk.codigo) ?? 0), 0);
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

    sendSuccess(res, result);
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar familias');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao buscar familias', 500);
  }
});

// ── Forecast Engine ───────────────────────────────────────

// POST /api/v1/forecast/calcular
router.post('/api/v1/forecast/calcular', async (req: Request, res: Response) => {
  try {
    const { familia_id, ajustes_demanda } = req.body;
    const results = await calcularForecast(familia_id, ajustes_demanda);
    sendSuccess(res, results);
  } catch (err) {
    logger.error({ err }, 'Erro ao calcular forecast');
    sendError(res, 'INTERNAL_ERROR', 'Erro ao calcular forecast', 500);
  }
});

// GET /api/v1/forecast/urgentes
router.get('/api/v1/forecast/urgentes', async (_req: Request, res: Response) => {
  try {
    const urgentes = await getFamiliasUrgentes();
    sendSuccess(res, urgentes);
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

// PATCH /api/v1/forecast/sazonalidade
router.patch('/api/v1/forecast/sazonalidade', async (req: Request, res: Response) => {
  try {
    const { familia_id, mes, fator } = req.body;
    if (!familia_id || !mes || fator == null) {
      sendError(res, 'VALIDATION_ERROR', 'familia_id, mes e fator sao obrigatorios');
      return;
    }
    if (fator < 0.1 || fator > 3.0) {
      sendError(res, 'VALIDATION_ERROR', 'fator deve estar entre 0.1 e 3.0');
      return;
    }
    const result = await updateSazFactor(familia_id, mes, fator);
    sendSuccess(res, { familia_id, mes, ...result });
  } catch (err) {
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

// PATCH /api/v1/forecast/config
router.patch('/api/v1/forecast/config', requireRole('gestor', 'diretor'), async (req: Request, res: Response) => {
  try {
    const { chave, valor } = req.body;
    await updateConfig(chave, valor);
    sendSuccess(res, { chave, valor });
  } catch (err) {
    sendError(res, 'INTERNAL_ERROR', 'Erro ao atualizar config', 500);
  }
});

export default router;
