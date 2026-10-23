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

/**
 * Historia 5 (ACXEGDP-437): a exclusao e por empresa (fila de recebimento nacional da Q2P ou da ACXE).
 * Vem na query (GET) ou na query/corpo (POST); ausente = 'q2p', entao a tela atual nao muda.
 */
const EmpresaSchema = z.enum(['q2p', 'acxe']);

function lerEmpresa(req: Request): { ok: true; empresa: 'q2p' | 'acxe' | undefined } | { ok: false } {
  const bruto = (req.body as { empresa?: unknown } | undefined)?.empresa ?? req.query.empresa;
  if (bruto === undefined || bruto === null || bruto === '') return { ok: true, empresa: undefined };
  const parsed = EmpresaSchema.safeParse(bruto);
  return parsed.success ? { ok: true, empresa: parsed.data } : { ok: false };
}

const EMPRESA_INVALIDA = { data: null, error: { code: 'INVALID_INPUT', message: "empresa deve ser 'q2p' ou 'acxe'" } };

router.get('/api/v1/stockbridge/fornecedores', requireDiretor, async (req: Request, res: Response) => {
  const emp = lerEmpresa(req);
  if (!emp.ok) {
    res.status(400).json(EMPRESA_INVALIDA);
    return;
  }
  try {
    const data = await listarFornecedores(emp.empresa);
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar fornecedores');
    res.status(500).json({ data: null, error: { code: 'FORNECEDOR_FAIL', message: (err as Error).message } });
  }
});

// `empresa` e lida a parte (lerEmpresa): corpo ou query; o schema (nao estrito) descarta a chave.
const ExcluirSchema = z.object({ motivo: z.string().min(1).optional(), nome: z.string().min(1).optional() });

router.post('/api/v1/stockbridge/fornecedores/:cnpj/excluir', requireDiretor, async (req: Request, res: Response) => {
  const cnpj = req.params.cnpj as string | undefined;
  const userId = req.user?.id;
  if (!cnpj || !userId) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'cnpj/usuário inválidos' } });
    return;
  }
  const parsed = ExcluirSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'payload inválido' } });
    return;
  }
  const emp = lerEmpresa(req);
  if (!emp.ok) {
    res.status(400).json(EMPRESA_INVALIDA);
    return;
  }
  try {
    const result = await excluirFornecedor({
      cnpj,
      nome: parsed.data.nome ?? cnpj,
      motivo: parsed.data.motivo ?? null,
      usuarioId: userId,
      ...(emp.empresa ? { empresa: emp.empresa } : {}),
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
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'cnpj/usuário inválidos' } });
    return;
  }
  const emp = lerEmpresa(req);
  if (!emp.ok) {
    res.status(400).json(EMPRESA_INVALIDA);
    return;
  }
  try {
    const result = await reincluirFornecedor({ cnpj, usuarioId: userId, ...(emp.empresa ? { empresa: emp.empresa } : {}) });
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
