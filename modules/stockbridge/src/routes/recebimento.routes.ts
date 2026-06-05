import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireOperador } from '../middleware/role.js';
import { requireArmazemVinculado } from '../middleware/armazem-vinculado.js';
import {
  processarRecebimento,
  NotaFiscalJaProcessadaError,
  OmieAjusteError,
} from '../services/recebimento.service.js';
import { CorrelacaoNaoEncontradaError } from '../services/correlacao.service.js';
import { mapearErroOmieParaResposta } from '../services/erros-omie.js';
import type { Perfil } from '../types.js';

const logger = createLogger('stockbridge:recebimento');
const router: Router = Router();

const BodySchema = z.object({
  nf: z.string().min(1),
  cnpj: z.enum(['acxe', 'q2p']),
  quantidade_input: z.number().positive(),
  unidade_input: z.enum(['t', 'kg', 'saco', 'bigbag']),
  localidade_id: z.string().uuid(),
  observacoes: z.string().optional(),
  tipo_divergencia: z.enum(['faltando', 'varredura']).optional(),
});

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
    res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessao sem usuario' } });
    return;
  }

  try {
    const result = await processarRecebimento({
      nf: parsed.data.nf,
      cnpj: parsed.data.cnpj,
      quantidadeInput: parsed.data.quantidade_input,
      unidadeInput: parsed.data.unidade_input,
      localidadeId: parsed.data.localidade_id,
      observacoes: parsed.data.observacoes,
      tipoDivergencia: parsed.data.tipo_divergencia,
      userId,
    });
    res.status(201).json({ data: result, error: null });
  } catch (err) {
    if (err instanceof NotaFiscalJaProcessadaError) {
      res.status(409).json({ data: null, error: { code: 'NF_JA_PROCESSADA', message: err.message } });
      return;
    }
    if (err instanceof CorrelacaoNaoEncontradaError) {
      res.status(409).json({ data: null, error: { code: 'PRODUTO_SEM_CORRELATO', message: err.message } });
      return;
    }
    if (err instanceof OmieAjusteError) {
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
