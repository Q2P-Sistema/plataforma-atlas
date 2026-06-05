import { Router, type Request, type Response } from 'express';
import { sql, desc, gte, lte, eq, and, type SQL } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { auditLog } from '@atlas/db';
import {
  requireAuth,
  requireRole,
  listUsers,
  createUser,
  updateUser,
  deactivateUser,
  reactivateUser,
  adminResetPassword,
  adminReset2FA,
  getUserModules,
  setUserModules,
  UserError,
} from '@atlas/auth';
import { sendSuccess, sendError } from '../envelope.js';

const logger = createLogger('admin');
const router: Router = Router();

// All admin routes require auth + diretor role
router.use('/api/v1/admin', requireAuth, requireRole('diretor'));

// GET /api/v1/admin/users
router.get('/api/v1/admin/users', async (_req: Request, res: Response) => {
  try {
    const userList = await listUsers();
    sendSuccess(
      res,
      userList.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        status: u.status,
        totp_enabled: u.totpEnabled,
        last_login_at: u.lastLoginAt,
        created_at: u.createdAt,
      })),
      200,
      { total: userList.length },
    );
  } catch (err) {
    logger.error({ err }, 'List users error');
    sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
  }
});

// POST /api/v1/admin/users
router.post('/api/v1/admin/users', async (req: Request, res: Response) => {
  try {
    const { name, email, role } = req.body;

    if (!name || !email || !role) {
      sendError(
        res,
        'VALIDATION_ERROR',
        'Nome, e-mail e perfil são obrigatórios',
        400,
      );
      return;
    }

    const validRoles = ['operador', 'gestor', 'diretor'];
    if (!validRoles.includes(role)) {
      sendError(res, 'VALIDATION_ERROR', 'Perfil inválido', 400);
      return;
    }

    const { user, temporaryPassword } = await createUser(name, email, role);

    logger.info(
      { adminId: req.user!.id, newUserId: user.id, email },
      'User created by admin',
    );

    sendSuccess(
      res,
      {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        temporaryPassword,
      },
      201,
    );
  } catch (err) {
    if (err instanceof UserError) {
      sendError(res, err.code, err.message, 409);
      return;
    }
    logger.error({ err }, 'Create user error');
    sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
  }
});

// PATCH /api/v1/admin/users/:id
router.patch('/api/v1/admin/users/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { name, role } = req.body;

    const fields: Record<string, unknown> = {};
    if (name !== undefined) fields.name = name;
    if (role !== undefined) {
      const validRoles = ['operador', 'gestor', 'diretor'];
      if (!validRoles.includes(role)) {
        sendError(res, 'VALIDATION_ERROR', 'Perfil inválido', 400);
        return;
      }
      fields.role = role;
    }

    if (Object.keys(fields).length === 0) {
      sendError(res, 'VALIDATION_ERROR', 'Nenhum campo para atualizar', 400);
      return;
    }

    const updated = await updateUser(id, fields);

    logger.info(
      { adminId: req.user!.id, targetId: id, fields: Object.keys(fields) },
      'User updated by admin',
    );

    sendSuccess(res, updated);
  } catch (err) {
    if (err instanceof UserError) {
      sendError(res, err.code, err.message, 404);
      return;
    }
    logger.error({ err }, 'Update user error');
    sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
  }
});

// PATCH /api/v1/admin/users/:id/deactivate
router.patch(
  '/api/v1/admin/users/:id/deactivate',
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      await deactivateUser(id);

      logger.info(
        { adminId: req.user!.id, targetId: id },
        'User deactivated by admin',
      );

      sendSuccess(res, { status: 'inactive' });
    } catch (err) {
      if (err instanceof UserError) {
        sendError(res, err.code, err.message, 404);
        return;
      }
      logger.error({ err }, 'Deactivate user error');
      sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
    }
  },
);

// PATCH /api/v1/admin/users/:id/reactivate
router.patch(
  '/api/v1/admin/users/:id/reactivate',
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      await reactivateUser(id);

      logger.info(
        { adminId: req.user!.id, targetId: id },
        'User reactivated by admin',
      );

      sendSuccess(res, { status: 'active' });
    } catch (err) {
      if (err instanceof UserError) {
        sendError(res, err.code, err.message, 404);
        return;
      }
      logger.error({ err }, 'Reactivate user error');
      sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
    }
  },
);

// POST /api/v1/admin/users/:id/reset-password
router.post(
  '/api/v1/admin/users/:id/reset-password',
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const { temporaryPassword } = await adminResetPassword(id);

      logger.info(
        { adminId: req.user!.id, targetId: id },
        'Password reset by admin',
      );

      sendSuccess(res, { temporaryPassword });
    } catch (err) {
      if (err instanceof UserError) {
        sendError(res, err.code, err.message, 404);
        return;
      }
      logger.error({ err }, 'Reset password error');
      sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
    }
  },
);

// POST /api/v1/admin/users/:id/reset-2fa
router.post(
  '/api/v1/admin/users/:id/reset-2fa',
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      await adminReset2FA(id);

      logger.info(
        { adminId: req.user!.id, targetId: id },
        '2FA reset by admin',
      );

      sendSuccess(res, { totp_enabled: false });
    } catch (err) {
      if (err instanceof UserError) {
        sendError(res, err.code, err.message, 404);
        return;
      }
      logger.error({ err }, 'Reset 2FA error');
      sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
    }
  },
);

// GET /api/v1/admin/users/:id/modules
router.get(
  '/api/v1/admin/users/:id/modules',
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const modules = await getUserModules(id);
      sendSuccess(res, { modules });
    } catch (err) {
      logger.error({ err }, 'Get user modules error');
      sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
    }
  },
);

// PUT /api/v1/admin/users/:id/modules
router.put(
  '/api/v1/admin/users/:id/modules',
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const { modules } = req.body as { modules?: unknown };

      if (!Array.isArray(modules) || modules.some((m) => typeof m !== 'string')) {
        sendError(
          res,
          'VALIDATION_ERROR',
          'Campo "modules" deve ser array de strings',
          400,
        );
        return;
      }

      const result = await setUserModules(id, modules as string[], req.user!.id);

      logger.info(
        { adminId: req.user!.id, targetId: id, modules: result },
        'User modules updated by admin',
      );

      sendSuccess(res, { modules: result });
    } catch (err) {
      if (err instanceof UserError) {
        sendError(res, err.code, err.message, 404);
        return;
      }
      logger.error({ err }, 'Set user modules error');
      sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
    }
  },
);

// GET /api/v1/admin/audit-log
router.get('/api/v1/admin/audit-log', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const {
      schema: schemaFilter,
      table: tableFilter,
      user_id: userIdFilter,
      from: fromDate,
      to: toDate,
      limit: limitStr,
      offset: offsetStr,
    } = req.query;

    const limit = Math.min(parseInt(limitStr as string, 10) || 50, 200);
    const offset = parseInt(offsetStr as string, 10) || 0;

    const conditions: SQL[] = [];
    if (schemaFilter) {
      conditions.push(eq(auditLog.schemaName, schemaFilter as string));
    }
    if (tableFilter) {
      conditions.push(eq(auditLog.tableName, tableFilter as string));
    }
    if (userIdFilter) {
      conditions.push(eq(auditLog.userId, userIdFilter as string));
    }
    if (fromDate) {
      conditions.push(gte(auditLog.ts, new Date(fromDate as string)));
    }
    if (toDate) {
      conditions.push(lte(auditLog.ts, new Date(toDate as string)));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, [countResult]] = await Promise.all([
      db
        .select()
        .from(auditLog)
        .where(whereClause)
        .orderBy(desc(auditLog.ts))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(whereClause),
    ]);

    sendSuccess(
      res,
      rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        schema_name: r.schemaName,
        table_name: r.tableName,
        operation: r.operation,
        record_id: r.recordId,
        user_id: r.userId,
        old_values: r.oldValues,
        new_values: r.newValues,
        ip_address: r.ipAddress,
      })),
      200,
      { total: countResult?.count ?? 0, limit, offset },
    );
  } catch (err) {
    logger.error({ err }, 'Audit log query error');
    sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
  }
});

export default router;
