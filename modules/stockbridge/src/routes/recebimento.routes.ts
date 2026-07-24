import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireOperador } from '../middleware/role.js';
import { requireArmazemVinculado } from '../middleware/armazem-vinculado.js';
import {
  processarRecebimento,
  NotaFiscalJaProcessadaError,
  NotaFiscalCanceladaError,
  NotaFiscalNaoEmitidaPelaAcxeError,
  ImportacaoApenasAcxeError,
  ValidacaoRecebimentoError,
  ProdutosSemCorrelatoError,
  QuantidadeExcedeNfError,
  OmieAjusteError,
} from '../services/recebimento.service.js';
import { CorrelacaoNaoEncontradaError } from '../services/correlacao.service.js';
import { mapearErroOmieParaResposta } from '../services/erros-omie.js';
import type { Perfil } from '../types.js';

const logger = createLogger('stockbridge:recebimento');
const router: Router = Router();

// Feature 013 (ACXEGDP-115): o corpo carrega SEMPRE itens[] (1..N) — NF de item
// único é um array de um. Cada produto da NF entra uma única vez no array.
const ItemSchema = z.object({
  produto_codigo_acxe: z.number().int().positive(),
  quantidade_input: z.number().positive(),
  unidade_input: z.enum(['t', 'kg', 'saco', 'bigbag']),
  localidade_id: z.string().uuid(),
  observacoes: z.string().optional(),
  tipo_divergencia: z.enum(['faltando', 'varredura']).optional(),
});

const BodySchema = z
  .object({
    nf: z.string().min(1),
    cnpj: z.enum(['acxe', 'q2p']),
    itens: z.array(ItemSchema).min(1),
  })
  .refine(
    (b) => new Set(b.itens.map((i) => i.produto_codigo_acxe)).size === b.itens.length,
    { message: 'itens: produto repetido — cada produto da NF entra uma única vez', path: ['itens'] },
  );

router.post('/api/v1/stockbridge/recebimento', requireOperador, requireArmazemVinculado, async (req: Request, res: Response) => {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      data: null,
      error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
    });
    return;
  }

  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessão sem usuário' } });
    return;
  }

  try {
    const result = await processarRecebimento({
      nf: parsed.data.nf,
      cnpj: parsed.data.cnpj,
      itens: parsed.data.itens.map((i) => ({
        produtoCodigoAcxe: i.produto_codigo_acxe,
        quantidadeInput: i.quantidade_input,
        unidadeInput: i.unidade_input,
        localidadeId: i.localidade_id,
        observacoes: i.observacoes,
        tipoDivergencia: i.tipo_divergencia,
      })),
      userId,
    });
    // Feature 013: passou o Portão 1 → 201 sempre; o desfecho de cada produto
    // (provisorio | aguardando_aprovacao | pendente_q2p | falha_acxe | ja_recebido)
    // vai em data.itens[] + data.resumo. Falha parcial de OMIE é estado
    // recuperável por item, não erro do lote.
    res.status(201).json({ data: result, error: null });
  } catch (err) {
    if (err instanceof NotaFiscalJaProcessadaError) {
      res.status(409).json({ data: null, error: { code: 'NF_JA_PROCESSADA', message: err.message } });
      return;
    }
    if (err instanceof NotaFiscalCanceladaError) {
      res.status(422).json({ data: null, error: { code: 'NF_CANCELADA', userMessage: err.message, message: err.message } });
      return;
    }
    if (err instanceof ImportacaoApenasAcxeError) {
      res.status(422).json({ data: null, error: { code: 'IMPORTACAO_APENAS_ACXE', userMessage: err.message, message: err.message } });
      return;
    }
    if (err instanceof NotaFiscalNaoEmitidaPelaAcxeError) {
      res.status(422).json({ data: null, error: { code: 'NF_NAO_EMITIDA_ACXE', userMessage: err.message, message: err.message } });
      return;
    }
    if (err instanceof QuantidadeExcedeNfError) {
      res.status(422).json({ data: null, error: { code: 'QUANTIDADE_EXCEDE_NF', userMessage: err.message, message: err.message } });
      return;
    }
    if (err instanceof ValidacaoRecebimentoError) {
      res.status(422).json({ data: null, error: { code: 'RECEBIMENTO_INVALIDO', userMessage: err.message, message: err.message } });
      return;
    }
    // Tudo-ou-nada (feature 013): um ou mais produtos sem correlato Q2P bloqueiam
    // a NF inteira. Mantém o code do single-item p/ compatibilidade do front.
    if (err instanceof ProdutosSemCorrelatoError || err instanceof CorrelacaoNaoEncontradaError) {
      res.status(409).json({ data: null, error: { code: 'PRODUTO_SEM_CORRELATO', userMessage: err.message, message: err.message } });
      return;
    }
    if (err instanceof OmieAjusteError) {
      // Defesa em profundidade: o fluxo por item não deve propagar OmieAjusteError,
      // mas caminhos legados (retry/aprovação) compartilham o helper dual.
      const role = (req.user?.role ?? 'operador') as Perfil;
      const { httpStatus, body } = mapearErroOmieParaResposta(err, { role });
      res.status(httpStatus).json({ data: null, error: body });
      return;
    }
    logger.error({ err, nf: parsed.data.nf }, 'Erro inesperado em recebimento');
    res.status(500).json({ data: null, error: { code: 'RECEBIMENTO_FAIL', message: (err as Error).message } });
  }
});

export default router;
