import type { Request, Response, NextFunction } from 'express';
import { and, eq } from 'drizzle-orm';
import { getDb, getConfig } from '@atlas/core';
import { users, userModules, type User, type Session } from '@atlas/db';
import { validateSession } from './session.js';
import type { ModuleKey } from './modules.js';

declare global {
  namespace Express {
    interface Request {
      user?: User;
      session?: Session;
    }
  }
}

const SESSION_COOKIE = 'atlas_session';

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const sessionId = req.cookies?.[SESSION_COOKIE];
  if (!sessionId) {
    res.status(401).json({
      data: null,
      error: { code: 'UNAUTHENTICATED', message: 'Sessão não encontrada' },
    });
    return;
  }

  validateSession(sessionId)
    .then(async (session) => {
      if (!session) {
        res.clearCookie(SESSION_COOKIE);
        res.status(401).json({
          data: null,
          error: { code: 'SESSION_EXPIRED', message: 'Sessão expirada' },
        });
        return;
      }

      const db = getDb();
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1);

      if (!user || user.status !== 'active' || user.deletedAt) {
        res.clearCookie(SESSION_COOKIE);
        res.status(401).json({
          data: null,
          error: { code: 'ACCOUNT_INACTIVE', message: 'Conta desativada' },
        });
        return;
      }

      req.user = user;
      req.session = session;
      next();
    })
    .catch(next);
}

export function requireRole(...allowedRoles: Array<User['role']>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        data: null,
        error: { code: 'UNAUTHENTICATED', message: 'Não autenticado' },
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        data: null,
        error: {
          code: 'FORBIDDEN',
          message: 'Acesso não autorizado para este perfil',
        },
      });
      return;
    }

    next();
  };
}

const MODULE_ENV_FLAG: Record<ModuleKey, keyof ReturnType<typeof getConfig>> = {
  hedge: 'MODULE_HEDGE_ENABLED',
  stockbridge: 'MODULE_STOCKBRIDGE_ENABLED',
  breakingpoint: 'MODULE_BREAKINGPOINT_ENABLED',
  clevel: 'MODULE_CLEVEL_ENABLED',
  comexinsight: 'MODULE_COMEXINSIGHT_ENABLED',
  comexflow: 'MODULE_COMEXFLOW_ENABLED',
  forecast: 'MODULE_FORECAST_ENABLED',
};

export function isModuleEnabledGlobally(moduleKey: ModuleKey): boolean {
  const config = getConfig();
  const flag = MODULE_ENV_FLAG[moduleKey];
  return Boolean(config[flag]);
}

/**
 * Bloqueia rotas se o modulo nao esta habilitado globalmente OU
 * se o user nao tem grant explicito (diretor sempre passa).
 * Aplicar em todos os routers de modulo apos requireAuth.
 */
export function requireModule(moduleKey: ModuleKey) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        data: null,
        error: { code: 'UNAUTHENTICATED', message: 'Não autenticado' },
      });
      return;
    }

    if (!isModuleEnabledGlobally(moduleKey)) {
      res.status(404).json({
        data: null,
        error: { code: 'MODULE_DISABLED', message: 'Módulo não habilitado' },
      });
      return;
    }

    // Diretor: bypass automatico
    if (req.user.role === 'diretor') {
      next();
      return;
    }

    const db = getDb();
    db
      .select({ moduleKey: userModules.moduleKey })
      .from(userModules)
      .where(
        and(
          eq(userModules.userId, req.user.id),
          eq(userModules.moduleKey, moduleKey),
        ),
      )
      .limit(1)
      .then((rows) => {
        if (rows.length === 0) {
          res.status(403).json({
            data: null,
            error: {
              code: 'MODULE_FORBIDDEN',
              message: 'Sem acesso a este módulo',
            },
          });
          return;
        }
        next();
      })
      .catch(next);
  };
}
