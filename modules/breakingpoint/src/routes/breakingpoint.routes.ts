import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, requireModule } from '@atlas/auth';
import { createLogger } from '@atlas/core';
import { getDadosMotor, listContas } from '../services/dados.service.js';
import { calcular } from '../services/motor.service.js';
import {
  getParams,
  upsertParams,
  listBancos,
  createBanco,
  updateBanco,
  deleteBanco,
  getLimitesAgregados,
  setContaIncluir,
  type Empresa,
} from '../services/config.service.js';
import { cached, invalidate } from '../services/cache.service.js';

const logger = createLogger('breakingpoint:routes');
const router: Router = Router();

function sendSuccess(res: Response, data: unknown, status = 200, meta?: Record<string, unknown>) {
  const body: Record<string, unknown> = { data, error: null };
  if (meta) body.meta = meta;
  res.status(status).json(body);
}

function sendError(res: Response, code: string, message: string, status = 400) {
  res.status(status).json({ data: null, error: { code, message } });
}

const EmpresaSchema = z.enum(['acxe', 'q2p']).default('acxe');

function parseEmpresa(req: Request): Empresa {
  return EmpresaSchema.parse(req.query.empresa ?? 'acxe');
}

router.use(
  '/api/v1/bp',
  requireAuth,
  requireModule('breakingpoint'),
  requireRole('gestor', 'diretor'),
);

// ── Projeção (US1) ─────────────────────────────────────────
router.get('/api/v1/bp/projecao', async (req: Request, res: Response) => {
  try {
    const empresa = parseEmpresa(req);
    const cacheKey = `atlas:bp:projecao:${empresa}`;

    const { data, hit } = await cached(cacheKey, 300, async () => {
      const params = (await getParams(empresa)) ?? {
        empresa,
        dup_antecip_usado: 0,
        markup_estoque: 0.22,
        alerta_gap_limiar: 300_000,
        cat_finimp_cod: null,
        updated_at: new Date().toISOString(),
      };
      const limites = await getLimitesAgregados(empresa);
      const dados = await getDadosMotor(empresa, params.cat_finimp_cod);

      const output = calcular({
        dados,
        data_base: new Date(),
        dup_antecip_usado: params.dup_antecip_usado,
        dup_antecip_limite: limites.dup_antecip_limite,
        dup_antecip_taxa: limites.dup_antecip_taxa,
        finimp_limite: limites.finimp_limite,
        finimp_garantia_pct: limites.finimp_garantia_pct,
        markup_estoque: params.markup_estoque,
        alerta_gap_limiar: params.alerta_gap_limiar,
        cat_finimp_cod_nulo: params.cat_finimp_cod === null,
      });

      return {
        ...output,
        sync_at: new Date().toISOString(),
      };
    });

    sendSuccess(res, data, 200, { cache_hit: hit });
  } catch (err) {
    logger.error({ err }, 'Erro ao calcular projeção');
    sendError(res, 'BP_PROJECAO_ERROR', 'Falha ao calcular projeção', 500);
  }
});

// ── Params (US2) ───────────────────────────────────────────
router.get('/api/v1/bp/params', async (req: Request, res: Response) => {
  try {
    const empresa = parseEmpresa(req);
    const params = await getParams(empresa);
    if (!params) return sendError(res, 'BP_PARAMS_NOT_FOUND', 'Parâmetros não encontrados', 404);
    sendSuccess(res, params);
  } catch (err) {
    logger.error({ err }, 'Erro ao ler params');
    sendError(res, 'BP_ERROR', 'Falha ao ler parâmetros', 500);
  }
});

const ParamsUpdateSchema = z.object({
  empresa: EmpresaSchema,
  dup_antecip_usado: z.number().min(0),
  markup_estoque: z.number().min(0).max(10),
  alerta_gap_limiar: z.number().min(0),
  cat_finimp_cod: z.string().regex(/^\S*$/).nullable(),
});

router.put('/api/v1/bp/params', async (req: Request, res: Response) => {
  try {
    const parsed = ParamsUpdateSchema.parse(req.body);
    const out = await upsertParams(parsed.empresa, parsed);
    await invalidate(`atlas:bp:projecao:${parsed.empresa}`);
    sendSuccess(res, out);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return sendError(res, 'BP_VALIDATION', err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '));
    }
    logger.error({ err }, 'Erro ao salvar params');
    sendError(res, 'BP_ERROR', 'Falha ao salvar parâmetros', 500);
  }
});

// ── Bancos (US2/US3) ───────────────────────────────────────
router.get('/api/v1/bp/bancos', async (req: Request, res: Response) => {
  try {
    const empresa = parseEmpresa(req);
    sendSuccess(res, await listBancos(empresa));
  } catch (err) {
    logger.error({ err }, 'Erro ao listar bancos');
    sendError(res, 'BP_ERROR', 'Falha ao listar bancos', 500);
  }
});

const BancoSchema = z.object({
  empresa: EmpresaSchema,
  banco_id: z.string().min(1).max(50).regex(/^[a-z0-9_-]+$/),
  banco_nome: z.string().min(1).max(100),
  cor_hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  antecip_limite: z.number().min(0),
  antecip_usado: z.number().min(0),
  antecip_taxa: z.number().min(0).max(1),
  finimp_limite: z.number().min(0),
  finimp_usado: z.number().min(0),
  finimp_garantia_pct: z.number().min(0).max(1),
  cheque_limite: z.number().min(0),
  cheque_usado: z.number().min(0),
  ativo: z.boolean().optional(),
});

const BancoUpdateSchema = BancoSchema.omit({ empresa: true, banco_id: true });

router.post('/api/v1/bp/bancos', async (req: Request, res: Response) => {
  try {
    const parsed = BancoSchema.parse(req.body);
    const banco = await createBanco(parsed);
    await invalidate(`atlas:bp:projecao:${parsed.empresa}`);
    sendSuccess(res, banco, 201);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return sendError(res, 'BP_VALIDATION', err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '));
    }
    const msg = (err as Error).message || '';
    if (msg.includes('duplicate') || msg.includes('unique')) {
      return sendError(res, 'BP_BANCO_DUPLICATE', 'banco_id já existe para essa empresa', 409);
    }
    logger.error({ err }, 'Erro ao criar banco');
    sendError(res, 'BP_ERROR', 'Falha ao criar banco', 500);
  }
});

router.put('/api/v1/bp/bancos/:id', async (req: Request, res: Response) => {
  try {
    const parsed = BancoUpdateSchema.parse(req.body);
    const id = String(req.params.id);
    const banco = await updateBanco(id, parsed);
    if (!banco) return sendError(res, 'BP_BANCO_NOT_FOUND', 'Banco não encontrado', 404);
    await invalidate(`atlas:bp:projecao:${banco.empresa}`);
    sendSuccess(res, banco);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return sendError(res, 'BP_VALIDATION', err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '));
    }
    logger.error({ err }, 'Erro ao atualizar banco');
    sendError(res, 'BP_ERROR', 'Falha ao atualizar banco', 500);
  }
});

router.delete('/api/v1/bp/bancos/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const ok = await deleteBanco(id);
    if (!ok) return sendError(res, 'BP_BANCO_NOT_FOUND', 'Banco não encontrado', 404);
    await invalidate('atlas:bp:projecao:*');
    sendSuccess(res, { ok: true });
  } catch (err) {
    logger.error({ err }, 'Erro ao deletar banco');
    sendError(res, 'BP_ERROR', 'Falha ao deletar banco', 500);
  }
});

// ── Contas Correntes (US2) ─────────────────────────────────
router.get('/api/v1/bp/contas', async (req: Request, res: Response) => {
  try {
    const empresa = parseEmpresa(req);
    sendSuccess(res, await listContas(empresa));
  } catch (err) {
    logger.error({ err }, 'Erro ao listar contas');
    sendError(res, 'BP_ERROR', 'Falha ao listar contas', 500);
  }
});

const ContaToggleSchema = z.object({
  empresa: EmpresaSchema,
  incluir: z.boolean(),
});

router.put('/api/v1/bp/contas/:nCodCC', async (req: Request, res: Response) => {
  try {
    const nCodCC = Number(req.params.nCodCC);
    if (!Number.isFinite(nCodCC)) return sendError(res, 'BP_VALIDATION', 'nCodCC inválido');
    const parsed = ContaToggleSchema.parse(req.body);
    await setContaIncluir(nCodCC, parsed.empresa, parsed.incluir);
    await invalidate(`atlas:bp:projecao:${parsed.empresa}`);
    sendSuccess(res, { ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return sendError(res, 'BP_VALIDATION', err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '));
    }
    logger.error({ err }, 'Erro ao salvar toggle conta');
    sendError(res, 'BP_ERROR', 'Falha ao salvar toggle', 500);
  }
});

export default router;
