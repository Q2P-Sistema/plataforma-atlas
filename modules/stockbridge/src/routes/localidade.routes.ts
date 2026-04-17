import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@atlas/core';
import { requireOperador, requireGestor } from '../middleware/role.js';
import {
  listarLocalidades,
  criarLocalidade,
  atualizarLocalidade,
  desativarLocalidade,
  CodigoLocalidadeDuplicadoError,
  LocalidadeNaoEncontradaError,
  LocalidadeInvalidaError,
} from '../services/localidade.service.js';

const logger = createLogger('stockbridge:localidade');
const router: Router = Router();

const TipoLocalidade = z.enum(['proprio', 'tpl', 'porto_seco', 'virtual_transito', 'virtual_ajuste']);

const CreateSchema = z.object({
  codigo: z.string().min(1).max(50),
  nome: z.string().min(1).max(255),
  tipo: TipoLocalidade,
  cnpj: z.string().max(50).optional().nullable(),
  cidade: z.string().max(100).optional().nullable(),
  ativo: z.boolean().optional(),
});

const UpdateSchema = CreateSchema.partial();

// GET /localidades — operador pode listar (precisa pra saber UUID destino no recebimento)
router.get('/api/v1/stockbridge/localidades', requireOperador, async (req: Request, res: Response) => {
  const apenasAtivas = req.query.ativo === 'true';
  try {
    const data = await listarLocalidades(apenasAtivas);
    res.json({ data, error: null });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar localidades');
    res.status(500).json({ data: null, error: { code: 'LOCALIDADE_FAIL', message: (err as Error).message } });
  }
});

router.post('/api/v1/stockbridge/localidades', requireGestor, async (req: Request, res: Response) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => i.message).join('; ') } });
    return;
  }
  try {
    const data = await criarLocalidade(parsed.data);
    res.status(201).json({ data, error: null });
  } catch (err) {
    return tratarErro(res, err);
  }
});

router.patch('/api/v1/stockbridge/localidades/:id', requireGestor, async (req: Request, res: Response) => {
  const id = req.params.id as string | undefined;
  if (!id) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'id obrigatorio' } });
    return;
  }
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => i.message).join('; ') } });
    return;
  }
  try {
    const data = await atualizarLocalidade(id, parsed.data);
    res.json({ data, error: null });
  } catch (err) {
    return tratarErro(res, err);
  }
});

router.delete('/api/v1/stockbridge/localidades/:id', requireGestor, async (req: Request, res: Response) => {
  const id = req.params.id as string | undefined;
  if (!id) {
    res.status(400).json({ data: null, error: { code: 'INVALID_INPUT', message: 'id obrigatorio' } });
    return;
  }
  try {
    await desativarLocalidade(id);
    res.json({ data: { id }, error: null });
  } catch (err) {
    return tratarErro(res, err);
  }
});

function tratarErro(res: Response, err: unknown) {
  if (err instanceof CodigoLocalidadeDuplicadoError) {
    res.status(409).json({ data: null, error: { code: 'CODIGO_DUPLICADO', message: err.message } });
    return;
  }
  if (err instanceof LocalidadeNaoEncontradaError) {
    res.status(404).json({ data: null, error: { code: 'LOCALIDADE_NAO_ENCONTRADA', message: err.message } });
    return;
  }
  if (err instanceof LocalidadeInvalidaError) {
    res.status(400).json({ data: null, error: { code: 'LOCALIDADE_INVALIDA', message: err.message } });
    return;
  }
  logger.error({ err }, 'Erro em localidade');
  res.status(500).json({ data: null, error: { code: 'LOCALIDADE_FAIL', message: (err as Error).message } });
}

export default router;
