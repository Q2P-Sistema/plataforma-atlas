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

// ACXEGDP-316: gestor/diretor sem TOTP configurado recebe sessão PLENA no login
// (não há tempToken possível — o desafio 2FA exige segredo já cadastrado). Antes,
// a exigência de configurar o 2FA era só o redirect do ProtectedShell no front;
// qualquer chamada direta à API passava. A sessão desses perfis agora é tratada
// como RESTRITA aqui no middleware central: 403 TWO_FA_SETUP_REQUIRED em tudo,
// exceto nas rotas de bootstrap marcadas com requireAuthAllowPending2fa
// (setup-2fa, confirm-2fa, me, logout, modules). O estado é derivado do próprio
// usuário (recarregado a cada request) — confirm-2fa grava totp_enabled=true e a
// MESMA sessão volta a passar, sem novo login.
function isPending2faSetup(user: User): boolean {
  return (
    Boolean(getConfig().AUTH_2FA_ENABLED) &&
    (user.role === 'gestor' || user.role === 'diretor') &&
    !user.totpEnabled
  );
}

function buildRequireAuth(allowPending2faSetup: boolean) {
  return function (req: Request, res: Response, next: NextFunction): void {
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

        if (!allowPending2faSetup && isPending2faSetup(user)) {
          res.status(403).json({
            data: null,
            error: {
              code: 'TWO_FA_SETUP_REQUIRED',
              message:
                'Seu perfil exige autenticação em dois fatores. Conclua a configuração do 2FA para continuar.',
            },
          });
          return;
        }

        req.user = user;
        req.session = session;
        next();
      })
      .catch(next);
  };
}

/** Middleware padrão de autenticação — barra sessão com 2FA pendente (ACXEGDP-316). */
export const requireAuth: (
  req: Request,
  res: Response,
  next: NextFunction,
) => void = buildRequireAuth(false);

/**
 * Variante EXCLUSIVA das rotas de bootstrap do 2FA (setup-2fa, confirm-2fa,
 * me, logout, modules): autentica normalmente, mas aceita gestor/diretor que
 * ainda não concluiu o setup do TOTP. Não usar em rota de negócio.
 */
export const requireAuthAllowPending2fa: (
  req: Request,
  res: Response,
  next: NextFunction,
) => void = buildRequireAuth(true);

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
