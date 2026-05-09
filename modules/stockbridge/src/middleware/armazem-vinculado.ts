import type { Request, Response, NextFunction } from 'express';
import { getPool } from '@atlas/core';

/**
 * Middleware que garante que o operador tenha pelo menos um galpao vinculado
 * em stockbridge.user_galpao (modelo N:N introduzido na migration 0025).
 * Gestor/Diretor passam livremente (nao precisam de galpao fixo).
 *
 * Aplicar apos requireAuth — depende de req.user.
 */
export async function requireArmazemVinculado(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = req.user;
  if (!user) {
    res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessao nao encontrada' } });
    return;
  }

  if (user.role !== 'operador') {
    next();
    return;
  }

  try {
    const { rows } = await getPool().query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM stockbridge.user_galpao WHERE user_id = $1',
      [user.id],
    );
    if (Number(rows[0]?.count ?? 0) === 0) {
      res.status(403).json({
        data: null,
        error: {
          code: 'OPERADOR_ARMAZEM_NAO_VINCULADO',
          message: 'Operador nao esta vinculado a um armazem. Contate o administrador.',
        },
      });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}
