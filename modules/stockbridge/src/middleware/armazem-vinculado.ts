import type { Request, Response, NextFunction } from 'express';

/**
 * Middleware que garante que o operador tenha um armazem vinculado em atlas.users.armazem_id.
 * Gestor/Diretor passam livremente (nao precisam de armazem fixo).
 *
 * Aplicar apos requireAuth — depende de req.user.
 */
export function requireArmazemVinculado(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED', message: 'Sessao nao encontrada' } });
    return;
  }

  if (user.role !== 'operador') {
    next();
    return;
  }

  // armazem_id e adicionado ao atlas.users via migration 0010
  const armazemId = (user as unknown as { armazemId?: string | null }).armazemId;
  if (!armazemId) {
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
}
