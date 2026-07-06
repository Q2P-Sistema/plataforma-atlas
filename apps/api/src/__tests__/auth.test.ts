import { describe, it, expect, vi, beforeAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: any[]) => args),
  and: vi.fn((...args: any[]) => args),
  gt: vi.fn((...args: any[]) => args),
}));

vi.mock('@atlas/db', () => ({
  users: {
    id: 'id',
    email: 'email',
    role: 'role',
    status: 'status',
  },
  sessions: {
    id: 'id',
    userId: 'userId',
    expiresAt: 'expiresAt',
    lastActiveAt: 'lastActiveAt',
  },
}));

const mockUser = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Test Admin',
  email: 'admin@test.com',
  passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$hash',
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

// Session store reserved for future test expansions
const _mockSessionStore: Record<string, any> = {}; void _mockSessionStore;

vi.mock('@atlas/core', () => ({
  loadConfig: () => ({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'test-secret-1234567890',
    API_PORT: 3005,
    NODE_ENV: 'test',
    MODULE_HEDGE_ENABLED: false,
    MODULE_STOCKBRIDGE_ENABLED: false,
    MODULE_BREAKINGPOINT_ENABLED: false,
    MODULE_CLEVEL_ENABLED: false,
    MODULE_COMEXINSIGHT_ENABLED: false,
    MODULE_COMEXFLOW_ENABLED: false,
    MODULE_FORECAST_ENABLED: false,
  }),
  getConfig: () => ({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'test-secret-1234567890',
    APP_URL: 'http://localhost:5173',
    API_PORT: 3005,
    NODE_ENV: 'test',
    MODULE_HEDGE_ENABLED: false,
    MODULE_STOCKBRIDGE_ENABLED: false,
    MODULE_BREAKINGPOINT_ENABLED: false,
    MODULE_CLEVEL_ENABLED: false,
    MODULE_COMEXINSIGHT_ENABLED: false,
    MODULE_COMEXFLOW_ENABLED: false,
    MODULE_FORECAST_ENABLED: false,
  }),
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([mockUser]),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () =>
          Promise.resolve([
            {
              id: '00000000-0000-0000-0000-session000001',
              userId: mockUser.id,
              csrfToken: 'test-csrf-token',
              ipAddress: '127.0.0.1',
              userAgent: 'test',
              createdAt: new Date(),
              expiresAt: new Date(Date.now() + 86400000),
              lastActiveAt: new Date(),
            },
          ]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
  }),
  getPool: () => ({
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
  }),
  getRedis: () => ({
    ping: vi.fn().mockResolvedValue('PONG'),
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
  verifyPassword: vi.fn((_hash: string, password: string) =>
    Promise.resolve(password === 'correct-password'),
  ),
  createSession: vi.fn(() =>
    Promise.resolve({
      id: '00000000-0000-0000-0000-session000001',
      userId: mockUser.id,
      csrfToken: 'test-csrf-token',
      ipAddress: '127.0.0.1',
      userAgent: 'test',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      lastActiveAt: new Date(),
    }),
  ),
  validateSession: vi.fn((sessionId: string) => {
    if (sessionId === '00000000-0000-0000-0000-session000001') {
      return Promise.resolve({
        id: sessionId,
        userId: mockUser.id,
        csrfToken: 'test-csrf-token',
        ipAddress: '127.0.0.1',
        userAgent: 'test',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        lastActiveAt: new Date(),
      });
    }
    return Promise.resolve(null);
  }),
  destroySession: vi.fn(() => Promise.resolve()),
  requireAuth: vi.fn(),
  checkLoginRateLimit: vi.fn(() => Promise.resolve({ locked: false })),
  recordFailedLogin: vi.fn(() => Promise.resolve()),
  resetFailedLogins: vi.fn(() => Promise.resolve()),
}));

// Import requireAuth after mock so we can set it up properly
import { requireAuth as _requireAuth, validateSession } from '@atlas/auth';

// Re-implement requireAuth for test since the mock needs real middleware behavior
vi.mocked(_requireAuth).mockImplementation(((req: any, res: any, next: any) => {
  const sessionId = req.cookies?.atlas_session;
  if (!sessionId) {
    res.status(401).json({
      data: null,
      error: { code: 'UNAUTHENTICATED', message: 'Sessao nao encontrada' },
    });
    return;
  }
  (validateSession as any)(sessionId).then((session: any) => {
    if (!session) {
      res.clearCookie('atlas_session');
      res.status(401).json({
        data: null,
        error: { code: 'SESSION_EXPIRED', message: 'Sessao expirada' },
      });
      return;
    }
    req.user = mockUser;
    req.session = session;
    next();
  });
}) as any);

describe('Auth Routes', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: authRouter } = await import('../routes/auth.routes.js');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(authRouter);
  });

  describe('POST /api/v1/auth/login', () => {
    it('returns 200 + cookie with correct credentials', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'admin@test.com', password: 'correct-password' });

      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe('admin@test.com');
      expect(res.body.data.requires2FA).toBe(false);
      expect(res.body.data.csrfToken).toBeDefined();
      expect(res.body.error).toBeNull();

      const cookies = res.headers['set-cookie'] as string[] | undefined;
      expect(cookies).toBeDefined();
      expect(cookies![0]).toContain('atlas_session');
    });

    it('returns 401 with wrong password', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'admin@test.com', password: 'wrong-password' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(res.body.data).toBeNull();
    });

    it('returns 400 when email/password missing', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('returns 401 without session cookie', async () => {
      const res = await request(app).get('/api/v1/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('returns user data with valid session', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Cookie', 'atlas_session=00000000-0000-0000-0000-session000001');

      expect(res.status).toBe(200);
      expect(res.body.data.email).toBe('admin@test.com');
      expect(res.body.data.role).toBe('diretor');
      // SEG-07: /me devolve o csrfToken para restaurá-lo após F5.
      expect(res.body.data.csrfToken).toBe('test-csrf-token');
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('clears session with valid cookie', async () => {
      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', 'atlas_session=00000000-0000-0000-0000-session000001');

      expect(res.status).toBe(200);
      expect(res.body.data.message).toBe('Sessão encerrada');
    });
  });
});
