import { describe, it, expect, vi, beforeAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: any[]) => args),
  and: vi.fn((...args: any[]) => args),
  gt: vi.fn((...args: any[]) => args),
  gte: vi.fn((...args: any[]) => args),
  lte: vi.fn((...args: any[]) => args),
  desc: vi.fn((col: any) => col),
  isNull: vi.fn(() => null),
  sql: Object.assign(vi.fn(), {
    // Support tagged template usage: sql`count(*)::int`
    raw: vi.fn((s: string) => s),
  }),
}));

vi.mock('@atlas/db', () => ({
  users: {
    id: 'id',
    email: 'email',
    role: 'role',
    status: 'status',
    deletedAt: 'deletedAt',
  },
  sessions: {
    id: 'id',
    userId: 'userId',
  },
  auditLog: {
    id: 'id',
    ts: 'ts',
    schemaName: 'schemaName',
    tableName: 'tableName',
    operation: 'operation',
    recordId: 'recordId',
    userId: 'userId',
    oldValues: 'oldValues',
    newValues: 'newValues',
    ipAddress: 'ipAddress',
  },
}));

const mockDiretor = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Admin Diretor',
  email: 'admin@test.com',
  passwordHash: 'hash',
  role: 'diretor' as const,
  status: 'active' as const,
  totpSecret: null,
  totpEnabled: false,
  passwordResetToken: null,
  passwordResetExpires: null,
  lastLoginAt: null,
  failedLoginAttempts: 0,
  lockedUntil: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

const mockOperador = {
  ...mockDiretor,
  id: '00000000-0000-0000-0000-000000000099',
  name: 'Operador',
  email: 'operador@test.com',
  role: 'operador' as const,
};

const mockCreatedUser = {
  id: '00000000-0000-0000-0000-000000000010',
  name: 'Novo User',
  email: 'novo@test.com',
  role: 'operador' as const,
  status: 'active' as const,
  totpEnabled: false,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  passwordHash: 'hash',
  totpSecret: null,
  passwordResetToken: null,
  passwordResetExpires: null,
  failedLoginAttempts: 0,
  lockedUntil: null,
};

const mockAuditRows = [
  {
    id: 1,
    ts: new Date(),
    schemaName: 'atlas',
    tableName: 'users',
    operation: 'INSERT',
    recordId: mockCreatedUser.id,
    userId: mockDiretor.id,
    oldValues: null,
    newValues: { name: 'Novo User', email: 'novo@test.com', role: 'operador' },
    ipAddress: '127.0.0.1',
  },
];

vi.mock('@atlas/core', () => ({
  // PR #72 moveu o envelope para @atlas/core — o mock precisa expor as funcoes
  // (puras, copiadas de packages/core/src/envelope.ts) ou as rotas quebram com
  // 'No "sendError" export is defined on the "@atlas/core" mock'.
  sendSuccess: (res: any, data: any, status = 200, meta?: any) => {
    const body: any = { data, error: null };
    if (meta) body.meta = meta;
    res.status(status).json(body);
  },
  sendError: (res: any, code: string, message: string, status = 400, fields?: any, traceId?: any) => {
    const error: any = { code, message };
    if (fields) error.fields = fields;
    if (traceId) error.traceId = traceId;
    res.status(status).json({ data: null, error });
  },
  loadConfig: () => ({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'test-secret-1234567890',
    API_PORT: 3005,
    NODE_ENV: 'test',
  }),
  getConfig: () => ({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'test-secret-1234567890',
    API_PORT: 3005,
    NODE_ENV: 'test',
    AUTH_2FA_ENABLED: true,
  }),
  getDb: () => {
    const makeWhere = () => ({
      limit: vi.fn(() => Promise.resolve([])),
      orderBy: vi.fn(() => ({
        limit: vi.fn(() => ({
          offset: vi.fn(() => Promise.resolve(mockAuditRows)),
        })),
      })),
    });
    const makeCountWhere = () => Promise.resolve([{ count: mockAuditRows.length }]);
    let selectCallCount = 0;
    return {
      select: vi.fn((...args: any[]) => {
        selectCallCount++;
        // If called with an object arg (count query), return count chain
        const isCountQuery = args.length > 0 && typeof args[0] === 'object';
        if (isCountQuery) {
          return {
            from: vi.fn(() => ({
              where: vi.fn(() => makeCountWhere()),
            })),
          };
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => makeWhere()),
          })),
        };
      }),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([mockCreatedUser])),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([mockCreatedUser])),
          })),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    };
  },
  getRedis: () => ({
    ping: vi.fn().mockResolvedValue('PONG'),
    setex: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
  }),
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('@atlas/auth', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
  requireAuth: vi.fn(),
  requireRole: vi.fn(() => vi.fn()),
  listUsers: vi.fn(() =>
    Promise.resolve([
      {
        id: mockDiretor.id,
        name: mockDiretor.name,
        email: mockDiretor.email,
        role: mockDiretor.role,
        status: mockDiretor.status,
        totpEnabled: false,
        lastLoginAt: null,
        createdAt: new Date(),
      },
    ]),
  ),
  createUser: vi.fn((_name: string, _email: string, _role: string) =>
    Promise.resolve({
      user: {
        id: mockCreatedUser.id,
        name: 'Novo User',
        email: 'novo@test.com',
        role: 'operador',
        status: 'active',
        totpEnabled: false,
        lastLoginAt: null,
        createdAt: new Date(),
      },
      temporaryPassword: 'temp-pass-123',
    }),
  ),
  updateUser: vi.fn((_id: string, _fields: any) =>
    Promise.resolve({
      id: mockCreatedUser.id,
      name: 'Updated',
      email: 'novo@test.com',
      role: 'gestor',
      status: 'active',
      totpEnabled: false,
      lastLoginAt: null,
      createdAt: new Date(),
    }),
  ),
  deactivateUser: vi.fn((_id: string) =>
    Promise.resolve({
      id: mockCreatedUser.id,
      name: 'Novo User',
      email: 'novo@test.com',
      role: 'operador',
      status: 'inactive',
      totpEnabled: false,
      lastLoginAt: null,
      createdAt: new Date(),
    }),
  ),
  reactivateUser: vi.fn((_id: string) =>
    Promise.resolve({
      id: mockCreatedUser.id,
      name: 'Novo User',
      email: 'novo@test.com',
      role: 'operador',
      status: 'active',
      totpEnabled: false,
      lastLoginAt: null,
      createdAt: new Date(),
    }),
  ),
  adminResetPassword: vi.fn((_id: string) =>
    Promise.resolve({ temporaryPassword: 'new-temp-pass-456' }),
  ),
  UserError: class UserError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'UserError';
    }
  },
  verifyPassword: vi.fn(() => Promise.resolve(true)),
  createSession: vi.fn(() =>
    Promise.resolve({
      id: 'session-id',
      userId: mockDiretor.id,
      csrfToken: 'csrf',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      lastActiveAt: new Date(),
    }),
  ),
  validateSession: vi.fn(),
  destroySession: vi.fn(() => Promise.resolve()),
  checkLoginRateLimit: vi.fn(() => Promise.resolve({ locked: false })),
  recordFailedLogin: vi.fn(() => Promise.resolve()),
  resetFailedLogins: vi.fn(() => Promise.resolve()),
  generateSecret: vi.fn(() => 'SECRET'),
  generateOtpauthUrl: vi.fn(() => 'otpauth://'),
  generateQRCodeDataUrl: vi.fn(() => Promise.resolve('data:image/png;base64,')),
  verifyCode: vi.fn(() => false),
}));

import {
  requireAuth as _requireAuth,
  requireRole as _requireRole,
  validateSession,
} from '@atlas/auth';

// requireAuth: diretor session for valid cookie, operador for operador cookie
vi.mocked(_requireAuth).mockImplementation(((req: any, res: any, next: any) => {
  const sessionId = req.cookies?.atlas_session;
  if (!sessionId) {
    res.status(401).json({
      data: null,
      error: { code: 'UNAUTHENTICATED', message: 'Sessao nao encontrada' },
    });
    return;
  }
  if (sessionId === 'operador-session') {
    req.user = mockOperador;
    req.session = { id: sessionId, csrfToken: 'csrf' };
    next();
    return;
  }
  req.user = mockDiretor;
  req.session = { id: sessionId, csrfToken: 'csrf' };
  next();
}) as any);

// requireRole: check user role
vi.mocked(_requireRole).mockImplementation((...allowedRoles: any[]) => {
  return ((req: any, res: any, next: any) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        data: null,
        error: { code: 'FORBIDDEN', message: 'Acesso nao autorizado' },
      });
      return;
    }
    next();
  }) as any;
});

describe('Admin Routes', () => {
  let app: express.Express;
  const ADMIN_COOKIE = 'atlas_session=admin-session';

  beforeAll(async () => {
    const { default: adminRouter } = await import('../routes/admin.routes.js');
    // Also load auth routes (for the login/logout endpoints)
    const { default: authRouter } = await import('../routes/auth.routes.js');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(authRouter);
    app.use(adminRouter);
  });

  describe('GET /api/v1/admin/users', () => {
    it('returns user list for diretor', async () => {
      const res = await request(app)
        .get('/api/v1/admin/users')
        .set('Cookie', ADMIN_COOKIE);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
    });

    it('returns 403 for operador', async () => {
      const res = await request(app)
        .get('/api/v1/admin/users')
        .set('Cookie', 'atlas_session=operador-session');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('returns 401 without session', async () => {
      const res = await request(app).get('/api/v1/admin/users');

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/admin/users', () => {
    it('creates user and returns 201 with temporary password', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set('Cookie', ADMIN_COOKIE)
        .send({ name: 'Novo User', email: 'novo@test.com', role: 'operador' });

      expect(res.status).toBe(201);
      expect(res.body.data.email).toBe('novo@test.com');
      expect(res.body.data.temporaryPassword).toBeDefined();
    });

    it('returns 400 with missing fields', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set('Cookie', ADMIN_COOKIE)
        .send({ name: 'Only Name' });

      expect(res.status).toBe(400);
    });

    it('returns 400 with invalid role', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set('Cookie', ADMIN_COOKIE)
        .send({ name: 'Test', email: 'test@test.com', role: 'superadmin' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('PATCH /api/v1/admin/users/:id', () => {
    it('updates user fields', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/users/${mockCreatedUser.id}`)
        .set('Cookie', ADMIN_COOKIE)
        .send({ role: 'gestor' });

      expect(res.status).toBe(200);
    });
  });

  describe('PATCH /api/v1/admin/users/:id/deactivate', () => {
    it('deactivates user and returns inactive status', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/users/${mockCreatedUser.id}/deactivate`)
        .set('Cookie', ADMIN_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('inactive');
    });
  });

  describe('PATCH /api/v1/admin/users/:id/reactivate', () => {
    it('reactivates user', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/users/${mockCreatedUser.id}/reactivate`)
        .set('Cookie', ADMIN_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('active');
    });
  });

  describe('POST /api/v1/admin/users/:id/reset-password', () => {
    it('resets password and returns temporary password', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/users/${mockCreatedUser.id}/reset-password`)
        .set('Cookie', ADMIN_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body.data.temporaryPassword).toBeDefined();
    });
  });

  describe('GET /api/v1/admin/audit-log', () => {
    it('returns audit log entries', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit-log')
        .set('Cookie', ADMIN_COOKIE);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toBeDefined();
    });
  });
});
