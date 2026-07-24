import type { Request, Response, NextFunction } from 'express';

const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfProtection(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  // SEG-07: fail-CLOSED. Antes, ausência de csrfToken na sessão chamava next()
  // sem validar (fail-open) — dava falsa sensação de proteção. Como este
  // middleware só é montado após requireAuth, toda sessão válida tem csrfToken;
  // ausência aqui é anomalia e deve negar.
  const sessionCsrf = (req as any).session?.csrfToken;
  if (!sessionCsrf) {
    res.status(403).json({
      data: null,
      error: { code: 'CSRF_INVALID', message: 'Token CSRF inválido' },
    });
    return;
  }

  const headerToken = req.headers[CSRF_HEADER];
  if (!headerToken || headerToken !== sessionCsrf) {
    res.status(403).json({
      data: null,
      error: { code: 'CSRF_INVALID', message: 'Token CSRF inválido' },
    });
    return;
  }

  next();
}
