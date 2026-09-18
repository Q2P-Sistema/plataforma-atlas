import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireOperador } from '../middleware/role.js';
import { requireArmazemVinculado } from '../middleware/armazem-vinculado.js';
import {
  listarLocalidadesNacional,
  buscarProdutosNacional,
  processarRecebimentoNacional,
  processarRecebimentoNacionalPorNf,
  LocalidadeNaoElegivelError,
  ProdutoNaoEncontradoError,
  ValidacaoRecebimentoNacionalError,
  NfNacionalJaProcessadaError,
} from '../services/recebimento-nacional.service.js';
import {
  getFilaNacional,
  getDetalheNfNacional,
  DataCorteNaoConfiguradaError,
  NfNacionalNaoEncontradaError,
  NfNacionalCanceladaError,
  FornecedorExcluidoError,
} from '../services/fila-nacional.service.js';

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

// ═══════════════════════════════════════════════════════════════════════════
// Feature 015 (ACXEGDP-328) — recebimento nacional A PARTIR DA NF (espelho)
// As tres rotas acima (localidades/produtos/POST manual) permanecem intactas.
// ═══════════════════════════════════════════════════════════════════════════

/** Erros de dominio da fila/detalhe → HTTP. Mensagens ja em pt-BR, sem codigo OMIE. */
function responderErroFilaNacional(res: Response, err: unknown): boolean {
  if (err instanceof DataCorteNaoConfiguradaError) {
    res.status(503).json({ data: null, error: { code: 'FILA_NACIONAL_NAO_CONFIGURADA', userMessage: err.message, message: err.message } });
    return true;
  }
  if (err instanceof NfNacionalNaoEncontradaError) {
    res.status(404).json({ data: null, error: { code: 'NF_NAO_ENCONTRADA', userMessage: err.message, message: err.message } });
    return true;
  }
  if (err instanceof NfNacionalCanceladaError) {
    res.status(422).json({ data: null, error: { code: 'NF_CANCELADA', userMessage: err.message, message: err.message } });
    return true;
  }
  if (err instanceof FornecedorExcluidoError) {
    res.status(422).json({ data: null, error: { code: 'FORNECEDOR_EXCLUIDO', userMessage: err.message, message: err.message } });
    return true;
  }
  return false;
}

const FilaNacionalQuerySchema = z.object({
  q: z.string().max(100).optional(),
  fornecedor: z.string().max(100).optional(),
});

// A data de corte NAO e parametro de requisicao (invariante 10 do contrato):
// e configuracao do ambiente — expor como query permitiria puxar historico que
// a feature decidiu nao cobrir.
router.get(
  '/api/v1/stockbridge/recebimento/nacional/fila',
  requireOperador,
  requireArmazemVinculado,
  async (req: Request, res: Response) => {
    const parsed = FilaNacionalQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ data: null, error: { code: 'INVALID_QUERY', message: parsed.error.issues.map((i) => i.message).join('; ') } });
      return;
    }
    try {
      const data = await getFilaNacional({ q: parsed.data.q ?? null, fornecedor: parsed.data.fornecedor ?? null });
      res.json({ data, error: null });
    } catch (err) {
      if (responderErroFilaNacional(res, err)) return;
      logger.error({ err }, 'Erro ao listar fila nacional');
      res.status(500).json({ data: null, error: { code: 'FILA_NACIONAL_FAIL', message: (err as Error).message } });
    }
  },
);

const ChaveAcessoSchema = z.string().regex(/^\d{44}$/, 'chave de acesso deve ter 44 dígitos');

router.get(
  '/api/v1/stockbridge/recebimento/nacional/fila/:chaveAcesso',
  requireOperador,
  requireArmazemVinculado,
  async (req: Request, res: Response) => {
    const parsed = ChaveAcessoSchema.safeParse(req.params.chaveAcesso);
    if (!parsed.success) {
      res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => i.message).join('; ') } });
      return;
    }
    try {
      const data = await getDetalheNfNacional(parsed.data);
      res.json({ data, error: null });
    } catch (err) {
      if (responderErroFilaNacional(res, err)) return;
      logger.error({ err, chave: parsed.data }, 'Erro ao detalhar NF nacional');
      res.status(500).json({ data: null, error: { code: 'DETALHE_NF_FAIL', message: (err as Error).message } });
    }
  },
);

// .strict() em todos os niveis: valor de item, valor total, unidade ou qualquer
// campo que o cliente nao deva mandar e REJEITADO — o ponto da feature e que
// esses dados nao passam pelo cliente (SC-001, invariante 2 do contrato).
const ProdutoDistribuicaoSchema = z
  .object({
    produto_codigo_q2p: z.number().int().positive(),
    quantidade_kg: z.number().positive(),
    localidade_id: z.string().uuid(),
  })
  .strict();

const ItemPorNfSchema = z
  .object({
    indice: z.number().int().min(0),
    descricao_fornecedor: z.string().min(1).max(500),
    quantidade_conferida_kg: z.number().positive().optional().nullable(),
    motivo_divergencia: z.string().max(1000).optional().nullable(),
    observacoes: z.string().max(1000).optional().nullable(),
    produtos: z.array(ProdutoDistribuicaoSchema).min(1).max(20),
  })
  .strict();

const PorNfBodySchema = z
  .object({
    nf_chave_acesso: ChaveAcessoSchema,
    observacoes: z.string().max(1000).optional().nullable(),
    itens: z.array(ItemPorNfSchema).min(1).max(100),
  })
  .strict();

router.post(
  '/api/v1/stockbridge/recebimento/nacional/por-nf',
  requireOperador,
  requireArmazemVinculado,
  async (req: Request, res: Response) => {
    const parsed = PorNfBodySchema.safeParse(req.body);
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
      const result = await processarRecebimentoNacionalPorNf({
        nfChaveAcesso: parsed.data.nf_chave_acesso,
        observacoes: parsed.data.observacoes ?? null,
        itens: parsed.data.itens.map((it) => ({
          indice: it.indice,
          descricaoFornecedor: it.descricao_fornecedor,
          quantidadeConferidaKg: it.quantidade_conferida_kg ?? null,
          motivoDivergencia: it.motivo_divergencia ?? null,
          observacoes: it.observacoes ?? null,
          produtos: it.produtos.map((p) => ({
            produtoCodigoQ2p: p.produto_codigo_q2p,
            quantidadeKg: p.quantidade_kg,
            localidadeId: p.localidade_id,
          })),
        })),
        userId,
      });
      // 201 sempre que passa o portao de validacao — o desfecho e por produto.
      res.status(201).json({ data: result, error: null });
    } catch (err) {
      if (responderErroFilaNacional(res, err)) return;
      if (err instanceof ValidacaoRecebimentoNacionalError) {
        res.status(400).json({ data: null, error: { code: err.code, userMessage: err.message, message: err.message } });
        return;
      }
      if (err instanceof LocalidadeNaoElegivelError) {
        res.status(400).json({ data: null, error: { code: 'LOCALIDADE_NAO_ELEGIVEL', userMessage: err.message, message: err.message } });
        return;
      }
      if (err instanceof ProdutoNaoEncontradoError) {
        res.status(404).json({ data: null, error: { code: 'PRODUTO_NAO_ENCONTRADO', userMessage: err.message, message: err.message } });
        return;
      }
      if (err instanceof NfNacionalJaProcessadaError) {
        res.status(409).json({ data: null, error: { code: 'NF_JA_PROCESSADA', userMessage: err.message, message: err.message } });
        return;
      }
      logger.error({ err, chave: parsed.data.nf_chave_acesso }, 'Erro inesperado em recebimento nacional por NF');
      res.status(500).json({ data: null, error: { code: 'RECEBIMENTO_NACIONAL_NF_FAIL', message: (err as Error).message } });
    }
  },
);

export default router;
