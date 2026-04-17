import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireDiretor } from '../middleware/role.js';
import {
  listarFornecedores,
  excluirFornecedor,
  reincluirFornecedor,
  FornecedorJaExcluidoError,
  ExclusaoNaoEncontradaError,
} from '../services/fornecedor.service.js';

const logger = createLogger('stockbridge:fornecedor');
const router: Router = Router();

router.get('/api/v1/stockbridge/fornecedores', requireDiretor, async (_req: Request, res: Response) => {
  try {
    const data = await listarFornecedores();
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar fornecedores');
    res.status(500).json({ data: null, error: { code: 'FORNECEDOR_FAIL', message: (err as Error).message } });
  }
});

const ExcluirSchema = z.object({ motivo: z.string().min(1).optional(), nome: z.string().min(1).optional() });

router.post('/api/v1/stockbridge/fornecedores/:cnpj/excluir', requireDiretor, async (req: Request, res: Response) => {
  const cnpj = req.params.cnpj as string | undefined;
  const userId = req.user?.id;
  if (!cnpj || !userId) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'cnpj/usuario invalidos' } });
    return;
  }
  const parsed = ExcluirSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'payload invalido' } });
    return;
  }
  try {
    const result = await excluirFornecedor({
      cnpj,
      nome: parsed.data.nome ?? cnpj,
      motivo: parsed.data.motivo ?? null,
      usuarioId: userId,
    });
    res.status(201).json({ data: result, error: null });
  } catch (err) {
    if (err instanceof FornecedorJaExcluidoError) {
      res.status(409).json({ data: null, error: { code: 'FORNECEDOR_JA_EXCLUIDO', message: err.message } });
      return;
    }
    logger.error({ err }, 'Erro ao excluir fornecedor');
    res.status(500).json({ data: null, error: { code: 'FORNECEDOR_FAIL', message: (err as Error).message } });
  }
});

router.post('/api/v1/stockbridge/fornecedores/:cnpj/reincluir', requireDiretor, async (req: Request, res: Response) => {
  const cnpj = req.params.cnpj as string | undefined;
  const userId = req.user?.id;
  if (!cnpj || !userId) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'cnpj/usuario invalidos' } });
    return;
  }
  try {
    const result = await reincluirFornecedor({ cnpj, usuarioId: userId });
    res.json({ data: result, error: null });
  } catch (err) {
    if (err instanceof ExclusaoNaoEncontradaError) {
      res.status(404).json({ data: null, error: { code: 'EXCLUSAO_NAO_ENCONTRADA', message: err.message } });
      return;
    }
    logger.error({ err }, 'Erro ao reincluir fornecedor');
    res.status(500).json({ data: null, error: { code: 'FORNECEDOR_FAIL', message: (err as Error).message } });
  }
});

export default router;
