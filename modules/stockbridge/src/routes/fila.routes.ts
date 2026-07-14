import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireOperador } from '../middleware/role.js';
import { requireArmazemVinculado } from '../middleware/armazem-vinculado.js';
import { NotaFiscalMultiItemError } from '@atlas/integration-omie';
import {
  getFilaOmie,
  NotaFiscalCanceladaError,
  NotaFiscalNaoEmitidaPelaAcxeError,
  ImportacaoApenasAcxeError,
} from '../services/recebimento.service.js';

const logger = createLogger('stockbridge:fila');
const router: Router = Router();

const QuerySchema = z.object({
  nf: z.string().min(1).optional(),
  cnpj: z.enum(['acxe', 'q2p']).optional(),
});

router.get('/api/v1/stockbridge/fila', requireOperador, requireArmazemVinculado, async (req: Request, res: Response) => {
  try {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ data: null, error: { code: 'INVALID_QUERY', message: parsed.error.issues.map((i) => i.message).join(', ') } });
      return;
    }
    const items = await getFilaOmie({
      nf: parsed.data.nf,
      cnpj: parsed.data.cnpj,
    });
    res.json({ data: items, error: null });
  } catch (err) {
    if (err instanceof NotaFiscalCanceladaError) {
      res.status(422).json({ data: null, error: { code: 'NF_CANCELADA', userMessage: err.message, message: err.message } });
      return;
    }
    if (err instanceof ImportacaoApenasAcxeError) {
      res.status(422).json({ data: null, error: { code: 'IMPORTACAO_APENAS_ACXE', userMessage: err.message, message: err.message } });
      return;
    }
    if (err instanceof NotaFiscalMultiItemError) {
      res.status(422).json({ data: null, error: { code: 'NF_MULTI_ITEM', userMessage: err.message, message: err.message } });
      return;
    }
    if (err instanceof NotaFiscalNaoEmitidaPelaAcxeError) {
      res.status(422).json({ data: null, error: { code: 'NF_NAO_EMITIDA_ACXE', userMessage: err.message, message: err.message } });
      return;
    }
    logger.error({ err }, 'Erro ao consultar fila OMIE');
    res.status(500).json({
      data: null,
      error: { code: 'FILA_FAIL', message: (err as Error).message },
    });
  }
});

export default router;
