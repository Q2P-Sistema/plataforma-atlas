import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireOperador } from '../middleware/role.js';
import {
  registrarSaidaManual,
  registrarRetornoComodato,
  consultarSaldoDisponivel,
  listarComodatosAbertos,
  buscarProdutosQ2P,
  SaldoInsuficienteError,
  SubtipoInvalidoError,
  ComodatoDadosObrigatoriosError,
} from '../services/saida-manual.service.js';

const logger = createLogger('stockbridge:saida-manual');
const router: Router = Router();

const SaidaSchema = z.object({
  subtipo: z.enum(['transf_intra_cnpj', 'comodato', 'amostra', 'descarte', 'quebra', 'inventario_menos']),
  produto_codigo_acxe: z.number().int().positive(),
  galpao: z.string().min(1).max(10),
  empresa: z.enum(['acxe', 'q2p']),
  quantidade_original: z.number().positive(),
  unidade: z.enum(['t', 'kg', 'saco', 'bigbag']),
  galpao_destino: z.string().min(1).max(10).optional().nullable(),
  observacoes: z.string().min(1),
  dt_prevista_retorno: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  cliente: z.string().min(1).optional().nullable(),
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
      error: {
        code: 'INVALID_INPUT',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      },
    });
    return;
  }
  try {
    const result = await registrarSaidaManual({
      subtipo: parsed.data.subtipo,
      produtoCodigoAcxe: parsed.data.produto_codigo_acxe,
      galpao: parsed.data.galpao,
      empresa: parsed.data.empresa,
      quantidadeOriginal: parsed.data.quantidade_original,
      unidade: parsed.data.unidade,
      galpaoDestino: parsed.data.galpao_destino ?? null,
      observacoes: parsed.data.observacoes,
      dtPrevistaRetorno: parsed.data.dt_prevista_retorno ?? null,
      cliente: parsed.data.cliente ?? null,
      userId,
    });
    res.status(201).json({ data: result, error: null });
  } catch (err) {
    if (err instanceof SaldoInsuficienteError) {
      res.status(409).json({ data: null, error: { code: 'SALDO_INSUFICIENTE', message: err.message } });
      return;
    }
    if (err instanceof SubtipoInvalidoError) {
      res.status(400).json({ data: null, error: { code: 'SUBTIPO_INVALIDO', message: err.message } });
      return;
    }
    if (err instanceof ComodatoDadosObrigatoriosError) {
      res.status(400).json({ data: null, error: { code: 'COMODATO_DADOS_OBRIGATORIOS', message: err.message } });
      return;
    }
    logger.error({ err }, 'Erro em saida manual');
    res.status(500).json({ data: null, error: { code: 'SAIDA_MANUAL_FAIL', message: (err as Error).message } });
  }
});

// GET /saida-manual/saldo-disponivel?empresa=&galpao=&produto_codigo_acxe=
const SaldoQuerySchema = z.object({
  empresa: z.enum(['acxe', 'q2p']),
  galpao: z.string().min(1).max(10),
  produto_codigo_acxe: z.coerce.number().int().positive(),
});

router.get(
  '/api/v1/stockbridge/saida-manual/saldo-disponivel',
  requireOperador,
  async (req: Request, res: Response) => {
    const parsed = SaldoQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => i.message).join('; ') },
      });
      return;
    }
    try {
      const data = await consultarSaldoDisponivel(
        parsed.data.produto_codigo_acxe,
        parsed.data.galpao,
        parsed.data.empresa,
      );
      res.json({ data, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro ao consultar saldo disponivel');
      res.status(500).json({ data: null, error: { code: 'SALDO_QUERY_FAIL', message: (err as Error).message } });
    }
  },
);

// GET /produtos-q2p?q=&limit= — busca produtos por descricao (combobox retorno comodato)
const ProdutosQ2PQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

router.get(
  '/api/v1/stockbridge/produtos-q2p',
  requireOperador,
  async (req: Request, res: Response) => {
    const parsed = ProdutosQ2PQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => i.message).join('; ') },
      });
      return;
    }
    try {
      const data = await buscarProdutosQ2P(parsed.data.q ?? null, parsed.data.limit ?? 50);
      res.json({ data, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro ao buscar produtos Q2P');
      res.status(500).json({ data: null, error: { code: 'PRODUTOS_Q2P_FAIL', message: (err as Error).message } });
    }
  },
);

// GET /comodato/abertos — lista comodatos pendentes de retorno
router.get(
  '/api/v1/stockbridge/comodato/abertos',
  requireOperador,
  async (_req: Request, res: Response) => {
    try {
      const data = await listarComodatosAbertos();
      res.json({ data, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro ao listar comodatos abertos');
      res.status(500).json({ data: null, error: { code: 'COMODATOS_LIST_FAIL', message: (err as Error).message } });
    }
  },
);

const RetornoSchema = z.object({
  produto_codigo_acxe_recebido: z.number().int().positive(),
  galpao_destino: z.string().min(1).max(10),
  quantidade_kg_recebida: z.number().positive(),
  observacoes: z.string().min(1),
});

router.post(
  '/api/v1/stockbridge/comodato/:movimentacao_id/retorno',
  requireOperador,
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    const movimentacaoId = req.params.movimentacao_id as string | undefined;
    if (!userId || !movimentacaoId) {
      res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'dados invalidos' } });
      return;
    }
    const parsed = RetornoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => i.message).join('; ') },
      });
      return;
    }
    try {
      const result = await registrarRetornoComodato({
        movimentacaoOrigemId: movimentacaoId,
        produtoCodigoAcxeRecebido: parsed.data.produto_codigo_acxe_recebido,
        galpaoDestino: parsed.data.galpao_destino,
        quantidadeKgRecebida: parsed.data.quantidade_kg_recebida,
        observacoes: parsed.data.observacoes,
        userId,
      });
      res.status(201).json({ data: result, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro em retorno comodato');
      res.status(500).json({ data: null, error: { code: 'RETORNO_COMODATO_FAIL', message: (err as Error).message } });
    }
  },
);

export default router;
