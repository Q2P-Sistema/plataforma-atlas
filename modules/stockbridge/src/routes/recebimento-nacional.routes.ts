import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireOperador } from '../middleware/role.js';
import { requireArmazemVinculado } from '../middleware/armazem-vinculado.js';
import {
  listarLocalidadesNacional,
  buscarProdutosNacional,
  processarRecebimentoNacional,
  LocalidadeNaoElegivelError,
  ProdutoNaoEncontradoError,
} from '../services/recebimento-nacional.service.js';

const logger = createLogger('stockbridge:recebimento-nacional');
const router: Router = Router();

const EmpresaSchema = z.enum(['acxe', 'q2p']);

const LocalidadesQuerySchema = z.object({
  empresa: EmpresaSchema,
});

router.get(
  '/api/v1/stockbridge/recebimento/nacional/localidades',
  requireOperador,
  async (req: Request, res: Response) => {
    const parsed = LocalidadesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => i.message).join('; ') },
      });
      return;
    }
    try {
      const data = await listarLocalidadesNacional(parsed.data.empresa);
      res.json({ data, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro ao listar localidades nacional');
      res.status(500).json({
        data: null,
        error: { code: 'LOCALIDADES_NACIONAL_FAIL', message: (err as Error).message },
      });
    }
  },
);

const ProdutosQuerySchema = z.object({
  empresa: EmpresaSchema,
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

router.get(
  '/api/v1/stockbridge/recebimento/nacional/produtos',
  requireOperador,
  async (req: Request, res: Response) => {
    const parsed = ProdutosQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        data: null,
        error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => i.message).join('; ') },
      });
      return;
    }
    try {
      const data = await buscarProdutosNacional({
        empresa: parsed.data.empresa,
        q: parsed.data.q ?? null,
        limit: parsed.data.limit ?? 50,
      });
      res.json({ data, error: null });
    } catch (err) {
      logger.error({ err }, 'Erro ao buscar produtos nacional');
      res.status(500).json({
        data: null,
        error: { code: 'PRODUTOS_NACIONAL_FAIL', message: (err as Error).message },
      });
    }
  },
);

const ItemSchema = z
  .object({
    produto_codigo_acxe: z.number().int().positive().optional().nullable(),
    produto_codigo_q2p: z.number().int().positive().optional().nullable(),
    empresa: EmpresaSchema,
    localidade_id: z.string().uuid(),
    quantidade: z.number().positive(),
    unidade: z.enum(['t', 'kg', 'saco', 'bigbag']),
    // Peso do rateio (ACXEGDP-178) — não é o custo final do item, só a referência
    // usada para distribuir valor_total_nf_brl proporcionalmente entre os itens.
    valor_unitario_referencia_brl: z.number().positive(),
  })
  .refine(
    (d) =>
      (d.empresa === 'acxe' && d.produto_codigo_acxe != null) ||
      (d.empresa === 'q2p' && d.produto_codigo_q2p != null),
    { message: 'produto_codigo_acxe obrigatório para acxe; produto_codigo_q2p obrigatório para q2p' },
  );

const BodySchema = z.object({
  nf: z.string().min(1).max(50),
  // Valor total da NF (com impostos), informado uma única vez no cabeçalho e
  // rateado entre os itens pelo peso (valor unitário de referência × Kg).
  valor_total_nf_brl: z.number().positive(),
  observacoes: z.string().optional(),
  itens: z.array(ItemSchema).min(1),
});

router.post(
  '/api/v1/stockbridge/recebimento/nacional',
  requireOperador,
  requireArmazemVinculado,
  async (req: Request, res: Response) => {
    const parsed = BodySchema.safeParse(req.body);
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

    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessão sem usuário' } });
      return;
    }

    try {
      const result = await processarRecebimentoNacional({
        notaFiscal: parsed.data.nf,
        valorTotalNfBrl: parsed.data.valor_total_nf_brl,
        observacoes: parsed.data.observacoes ?? null,
        itens: parsed.data.itens.map((it) => ({
          produtoCodigoAcxe: it.produto_codigo_acxe ?? null,
          produtoCodigoQ2p: it.produto_codigo_q2p ?? null,
          empresa: it.empresa,
          localidadeId: it.localidade_id,
          quantidade: it.quantidade,
          unidade: it.unidade,
          valorUnitarioReferenciaBrl: it.valor_unitario_referencia_brl,
        })),
        userId,
      });
      res.status(201).json({ data: result, error: null });
    } catch (err) {
      if (err instanceof LocalidadeNaoElegivelError) {
        res.status(400).json({
          data: null,
          error: { code: 'LOCALIDADE_NAO_ELEGIVEL', message: err.message },
        });
        return;
      }
      if (err instanceof ProdutoNaoEncontradoError) {
        res.status(404).json({
          data: null,
          error: { code: 'PRODUTO_NAO_ENCONTRADO', message: err.message },
        });
        return;
      }
      logger.error({ err, nf: parsed.data.nf }, 'Erro inesperado em recebimento nacional');
      res.status(500).json({
        data: null,
        error: { code: 'RECEBIMENTO_NACIONAL_FAIL', message: (err as Error).message },
      });
    }
  },
);

export default router;
