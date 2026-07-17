import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
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
    totpSecret: 'totpSecret',
    totpEnabled: 'totpEnabled',
  },
  sessions: {
    id: 'id',
    userId: 'userId',
    expiresAt: 'expiresAt',
    lastActiveAt: 'lastActiveAt',
  },
}));

const mockUser2FA = {
  id: '00000000-0000-0000-0000-000000000002',
  name: 'Gestor 2FA',
  email: 'gestor@test.com',
  passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$hash',
  role: 'gestor' as const,
  status: 'active' as const,
  totpSecret: 'JBSWY3DPEHPK3PXP',
  totpEnabled: true,
  passwordResetToken: null,
  passwordResetExpires: null,
  lastLoginAt: null,
  failedLoginAttempts: 0,
  lockedUntil: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

const mockUserNoSetup = {
  ...mockUser2FA,
  id: '00000000-0000-0000-0000-000000000003',
  name: 'Diretor NoSetup',
  email: 'diretor@test.com',
  role: 'diretor' as const,
  totpSecret: null,
  totpEnabled: false,
};

// Redis mock store
const redisStore: Record<string, string> = {};

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
  getDb: () => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([mockUser2FA])),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() =>
          Promise.resolve([
            {
              id: '00000000-0000-0000-0000-session000002',
              userId: mockUser2FA.id,
              csrfToken: 'test-csrf-token-2fa',
              ipAddress: '127.0.0.1',
              userAgent: 'test',
              createdAt: new Date(),
              expiresAt: new Date(Date.now() + 86400000),
              lastActiveAt: new Date(),
            },
          ]),
        ),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  }),
  getRedis: () => ({
    setex: vi.fn((key: string, _ttl: number, value: string) => {
      redisStore[key] = value;
      return Promise.resolve('OK');
    }),
    get: vi.fn((key: string) => Promise.resolve(redisStore[key] ?? null)),
    del: vi.fn((...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (k in redisStore) { delete redisStore[k]; n++; }
      return Promise.resolve(n);
    }),
    incr: vi.fn((key: string) => {
      const n = Number(redisStore[key] ?? 0) + 1;
      redisStore[key] = String(n);
      return Promise.resolve(n);
    }),
    expire: vi.fn(() => Promise.resolve(1)),
    ttl: vi.fn(() => Promise.resolve(1800)),
    ping: vi.fn().mockResolvedValue('PONG'),
  }),
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
  sendEmail: vi.fn(() => Promise.resolve()),
  buildPasswordResetEmail: vi.fn(() => ({ subject: 's', html: 'h', text: 't' })),
}));

vi.mock('@atlas/auth', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
  verifyPassword: vi.fn((_hash: string, password: string) =>
    Promise.resolve(password === 'correct-password'),
  ),
  createSession: vi.fn(() =>
    Promise.resolve({
      id: '00000000-0000-0000-0000-session000002',
      userId: mockUser2FA.id,
      csrfToken: 'test-csrf-token-2fa',
      ipAddress: '127.0.0.1',
      userAgent: 'test',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      lastActiveAt: new Date(),
    }),
  ),
  validateSession: vi.fn((sessionId: string) => {
    if (sessionId === '00000000-0000-0000-0000-session000002') {
      return Promise.resolve({
        id: sessionId,
        userId: mockUser2FA.id,
        csrfToken: 'test-csrf-token-2fa',
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
  generateSecret: vi.fn(() => 'TESTSECRETBASE32'),
  generateOtpauthUrl: vi.fn(
    (_s: string, email: string) => `otpauth://totp/Atlas:${email}?secret=TESTSECRETBASE32&issuer=Atlas`,
  ),
  generateQRCodeDataUrl: vi.fn(() => Promise.resolve('data:image/png;base64,TESTQR')),
  verifyCode: vi.fn((_secret: string, code: string) => code === '123456'),
}));

import { requireAuth as _requireAuth, validateSession } from '@atlas/auth';

// Por padrão as rotas autenticadas veem um usuário SEM 2FA (fluxo de primeiro
// setup). Testes de step-up (SEG-10) setam este override para um usuário com
// totpEnabled=true e restauram no afterEach.
let setupUserOverride: typeof mockUser2FA | null = null;

vi.mocked(_requireAuth).mockImplementation(((req: any, res: any, next: any) => {
  const sessionId = req.cookies?.atlas_session;
  if (!sessionId) {
    res.status(401).json({
      data: null,
      error: { code: 'UNAUTHENTICATED', message: 'Sessão não encontrada' },
    });
    return;
  }
  (validateSession as any)(sessionId).then((session: any) => {
    if (!session) {
      res.status(401).json({
        data: null,
        error: { code: 'SESSION_EXPIRED', message: 'Sessão expirada' },
      });
      return;
    }
    req.user = setupUserOverride ?? mockUserNoSetup;
    req.session = session;
    next();
  });
}) as any);

describe('2FA Routes', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { default: authRouter } = await import('../routes/auth.routes.js');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(authRouter);
  });

  beforeEach(() => {
    // Clear redis store between tests
    for (const key of Object.keys(redisStore)) {
      delete redisStore[key];
    }
  });

  describe('POST /api/v1/auth/login with 2FA', () => {
    it('returns requires2FA and tempToken when user has 2FA enabled', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'gestor@test.com', password: 'correct-password' });

      expect(res.status).toBe(200);
      expect(res.body.data.requires2FA).toBe(true);
      expect(res.body.data.tempToken).toBeDefined();
      expect(typeof res.body.data.tempToken).toBe('string');

      // Should NOT have session cookie
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeUndefined();
    });
  });

  describe('POST /api/v1/auth/verify-2fa', () => {
    it('creates session with valid tempToken and code', async () => {
      // First login to get tempToken
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'gestor@test.com', password: 'correct-password' });

      const { tempToken } = loginRes.body.data;

      const res = await request(app)
        .post('/api/v1/auth/verify-2fa')
        .send({ tempToken, code: '123456' });

      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe('gestor@test.com');
      expect(res.body.data.csrfToken).toBeDefined();
      expect(res.body.data.requires2FA).toBe(false);

      const cookies = res.headers['set-cookie'] as string[] | undefined;
      expect(cookies).toBeDefined();
      expect(cookies![0]).toContain('atlas_session');
    });

    it('rejects invalid 2FA code', async () => {
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'gestor@test.com', password: 'correct-password' });

      const { tempToken } = loginRes.body.data;

      const res = await request(app)
        .post('/api/v1/auth/verify-2fa')
        .send({ tempToken, code: '000000' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_2FA_CODE');
    });

    it('rejects expired/invalid tempToken', async () => {
      const res = await request(app)
        .post('/api/v1/auth/verify-2fa')
        .send({ tempToken: 'invalid-token', code: '123456' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
    });

    // SEG-04: brute-force de TOTP
    it('bloqueia após 5 tentativas de código inválido (429) e invalida o tempToken', async () => {
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'gestor@test.com', password: 'correct-password' });
      const { tempToken } = loginRes.body.data;

      // 5 tentativas erradas → 401
      for (let i = 0; i < 5; i++) {
        const r = await request(app).post('/api/v1/auth/verify-2fa').send({ tempToken, code: '000000' });
        expect(r.status).toBe(401);
        expect(r.body.error.code).toBe('INVALID_2FA_CODE');
      }
      // 6ª → 429 (lockout)
      const r6 = await request(app).post('/api/v1/auth/verify-2fa').send({ tempToken, code: '000000' });
      expect(r6.status).toBe(429);
      expect(r6.body.error.code).toBe('TOO_MANY_ATTEMPTS');

      // Código correto após o lockout não loga — tempToken foi invalidado
      const r7 = await request(app).post('/api/v1/auth/verify-2fa').send({ tempToken, code: '123456' });
      expect(r7.status).toBe(401);
      expect(r7.body.error.code).toBe('INVALID_TOKEN');
    });
  });

  // SEG-09: rate limit por IP em forgot/reset. Cada teste usa um IP distinto
  // (o limiter é por IP e o MemoryStore persiste no processo do router).
  describe('SEG-09 rate limit forgot/reset', () => {
    it('forgot-password bloqueia no 6º request do mesmo IP (429)', async () => {
      const ip = '10.9.9.1';
      for (let i = 0; i < 5; i++) {
        const r = await request(app).post('/api/v1/auth/forgot-password')
          .set('X-Forwarded-For', ip).send({ email: 'gestor@test.com' });
        expect(r.status).not.toBe(429);
      }
      const r6 = await request(app).post('/api/v1/auth/forgot-password')
        .set('X-Forwarded-For', ip).send({ email: 'gestor@test.com' });
      expect(r6.status).toBe(429);
      expect(r6.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    });

    it('IPs distintos não compartilham o orçamento', async () => {
      // Esgota 10.9.9.2
      for (let i = 0; i < 6; i++) {
        await request(app).post('/api/v1/auth/forgot-password')
          .set('X-Forwarded-For', '10.9.9.2').send({ email: 'gestor@test.com' });
      }
      // Outro IP ainda passa
      const r = await request(app).post('/api/v1/auth/forgot-password')
        .set('X-Forwarded-For', '10.9.9.3').send({ email: 'gestor@test.com' });
      expect(r.status).not.toBe(429);
    });

    it('reset-password bloqueia no 11º request do mesmo IP (429)', async () => {
      const ip = '10.9.9.4';
      for (let i = 0; i < 10; i++) {
        const r = await request(app).post('/api/v1/auth/reset-password')
          .set('X-Forwarded-For', ip).send({ token: 'bad', newPassword: 'x' });
        expect(r.status).not.toBe(429);
      }
      const r11 = await request(app).post('/api/v1/auth/reset-password')
        .set('X-Forwarded-For', ip).send({ token: 'bad', newPassword: 'x' });
      expect(r11.status).toBe(429);
    });
  });

  describe('POST /api/v1/auth/setup-2fa', () => {
    it('returns QR code and secret for authenticated user', async () => {
      const res = await request(app)
        .post('/api/v1/auth/setup-2fa')
        .set('Cookie', 'atlas_session=00000000-0000-0000-0000-session000002');

      expect(res.status).toBe(200);
      expect(res.body.data.secret).toBe('TESTSECRETBASE32');
      expect(res.body.data.qrCodeUrl).toContain('otpauth://totp/Atlas:');
      expect(res.body.data.qrCodeDataUrl).toContain('data:image/png;base64');
    });

    it('returns 401 without session', async () => {
      const res = await request(app).post('/api/v1/auth/setup-2fa');

      expect(res.status).toBe(401);
    });

    // SEG-10: re-setup com 2FA já habilitado exige a senha atual (step-up)
    describe('step-up quando 2FA já está habilitado', () => {
      afterEach(() => { setupUserOverride = null; });

      it('rejeita re-setup sem senha (401 REAUTH_REQUIRED)', async () => {
        setupUserOverride = mockUser2FA; // totpEnabled: true
        const res = await request(app)
          .post('/api/v1/auth/setup-2fa')
          .set('Cookie', 'atlas_session=00000000-0000-0000-0000-session000002');
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('REAUTH_REQUIRED');
      });

      it('rejeita re-setup com senha errada (401)', async () => {
        setupUserOverride = mockUser2FA;
        const res = await request(app)
          .post('/api/v1/auth/setup-2fa')
          .set('Cookie', 'atlas_session=00000000-0000-0000-0000-session000002')
          .send({ password: 'senha-errada' });
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('REAUTH_REQUIRED');
      });

      it('permite re-setup com a senha correta (200)', async () => {
        setupUserOverride = mockUser2FA;
        const res = await request(app)
          .post('/api/v1/auth/setup-2fa')
          .set('Cookie', 'atlas_session=00000000-0000-0000-0000-session000002')
          .send({ password: 'correct-password' });
        expect(res.status).toBe(200);
        expect(res.body.data.secret).toBe('TESTSECRETBASE32');
      });

      it('primeiro setup (totpEnabled=false) NÃO exige senha', async () => {
        // setupUserOverride null → mockUserNoSetup (totpEnabled: false)
        const res = await request(app)
          .post('/api/v1/auth/setup-2fa')
          .set('Cookie', 'atlas_session=00000000-0000-0000-0000-session000002');
        expect(res.status).toBe(200);
      });
    });
  });

  describe('POST /api/v1/auth/confirm-2fa', () => {
    it('enables 2FA with valid code', async () => {
      const res = await request(app)
        .post('/api/v1/auth/confirm-2fa')
        .set('Cookie', 'atlas_session=00000000-0000-0000-0000-session000002')
        .send({ code: '123456' });

      expect(res.status).toBe(200);
      expect(res.body.data.totp_enabled).toBe(true);
    });

    it('rejects invalid confirmation code', async () => {
      const res = await request(app)
        .post('/api/v1/auth/confirm-2fa')
        .set('Cookie', 'atlas_session=00000000-0000-0000-0000-session000002')
        .send({ code: '000000' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_2FA_CODE');
    });
  });
});
