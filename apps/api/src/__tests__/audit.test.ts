import { describe, it, expect, vi, beforeAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

const mockAuditRows = [
  {
    id: 1,
    ts: new Date('2026-04-12T10:00:00Z'),
    schemaName: 'atlas',
    tableName: 'users',
    operation: 'INSERT',
    recordId: '00000000-0000-0000-0000-000000000010',
    userId: '00000000-0000-0000-0000-000000000001',
    oldValues: null,
    newValues: { name: 'Novo User', email: 'novo@test.com', role: 'operador' },
    ipAddress: '127.0.0.1',
  },
  {
    id: 2,
    ts: new Date('2026-04-12T10:05:00Z'),
    schemaName: 'atlas',
    tableName: 'users',
    operation: 'UPDATE',
    recordId: '00000000-0000-0000-0000-000000000010',
    userId: '00000000-0000-0000-0000-000000000001',
    oldValues: { role: 'operador' },
    newValues: { role: 'gestor' },
    ipAddress: '127.0.0.1',
  },
];

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: any[]) => args),
  and: vi.fn((...args: any[]) => args),
  gt: vi.fn((...args: any[]) => args),
  gte: vi.fn((...args: any[]) => args),
  lte: vi.fn((...args: any[]) => args),
  desc: vi.fn((col: any) => col),
  isNull: vi.fn(() => null),
  sql: Object.assign(vi.fn(), {
    raw: vi.fn((s: string) => s),
  }),
}));

vi.mock('@atlas/db', () => ({
  users: { id: 'id', email: 'email', role: 'role', status: 'status', deletedAt: 'deletedAt' },
  sessions: { id: 'id', userId: 'userId' },
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
  name: 'Admin',
  email: 'admin@test.com',
  role: 'diretor' as const,
  status: 'active' as const,
};

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
  loadConfig: () => ({ NODE_ENV: 'test' }),
  getConfig: () => ({ NODE_ENV: 'test' }),
  getDb: () => ({
    select: vi.fn((...args: any[]) => {
      const isCountQuery = args.length > 0 && typeof args[0] === 'object';
      if (isCountQuery) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve([{ count: mockAuditRows.length }])),
          })),
        };
      }
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => ({
                offset: vi.fn(() => Promise.resolve(mockAuditRows)),
              })),
            })),
          })),
        })),
      };
    }),
  }),
  getRedis: () => ({ ping: vi.fn().mockResolvedValue('PONG') }),
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
  listUsers: vi.fn(() => Promise.resolve([])),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deactivateUser: vi.fn(),
  reactivateUser: vi.fn(),
  adminResetPassword: vi.fn(),
  UserError: class extends Error {
    code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
    }
  },
  verifyPassword: vi.fn(() => Promise.resolve(true)),
  createSession: vi.fn(),
  validateSession: vi.fn(),
  destroySession: vi.fn(),
  checkLoginRateLimit: vi.fn(() => Promise.resolve({ locked: false })),
  recordFailedLogin: vi.fn(),
  resetFailedLogins: vi.fn(),
  generateSecret: vi.fn(),
  generateOtpauthUrl: vi.fn(),
  generateQRCodeDataUrl: vi.fn(),
  verifyCode: vi.fn(),
}));

import { requireAuth as _requireAuth, requireRole as _requireRole } from '@atlas/auth';

vi.mocked(_requireAuth).mockImplementation(((req: any, res: any, next: any) => {
  const sessionId = req.cookies?.atlas_session;
  if (!sessionId) {
    res.status(401).json({ data: null, error: { code: 'UNAUTHENTICATED' } });
    return;
  }
  req.user = mockDiretor;
  req.session = { id: sessionId, csrfToken: 'csrf' };
  next();
}) as any);

vi.mocked(_requireRole).mockImplementation((...roles: any[]) => {
  return ((req: any, res: any, next: any) => {
    if (!roles.includes(req.user?.role)) {
      res.status(403).json({ data: null, error: { code: 'FORBIDDEN' } });
      return;
    }
    next();
  }) as any;
});

describe('Audit Log Routes', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: adminRouter } = await import('../routes/admin.routes.js');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(adminRouter);
  });

  it('returns audit entries with correct fields', async () => {
    const res = await request(app)
      .get('/api/v1/admin/audit-log')
      .set('Cookie', 'atlas_session=admin');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);

    const entry = res.body.data[0];
    expect(entry.schema_name).toBe('atlas');
    expect(entry.table_name).toBe('users');
    expect(entry.operation).toBe('INSERT');
    expect(entry.new_values).toEqual({
      name: 'Novo User',
      email: 'novo@test.com',
      role: 'operador',
    });
  });

  it('returns meta with total, limit, offset', async () => {
    const res = await request(app)
      .get('/api/v1/admin/audit-log?limit=10&offset=0')
      .set('Cookie', 'atlas_session=admin');

    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(10);
    expect(res.body.meta.offset).toBe(0);
  });

  it('supports schema and table filters', async () => {
    const res = await request(app)
      .get('/api/v1/admin/audit-log?schema=atlas&table=users')
      .set('Cookie', 'atlas_session=admin');

    expect(res.status).toBe(200);
    // Filters passed to DB query — we just verify it doesn't error
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/v1/admin/audit-log');
    expect(res.status).toBe(401);
  });
});
