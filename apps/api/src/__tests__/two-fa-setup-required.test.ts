import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

/**
 * ACXEGDP-316 — 2FA de gestor/diretor como barreira REAL no backend.
 *
 * Antes, gestor/diretor sem TOTP configurado recebia sessão PLENA no login e a
 * exigência de configurar o 2FA era só o redirect do ProtectedShell no front —
 * qualquer chamada direta à API passava. Estes testes cobrem o contrato novo:
 *
 *  - gestor/diretor sem TOTP: sessão emitida, mas rota de negócio → 403
 *    TWO_FA_SETUP_REQUIRED; só setup-2fa/confirm-2fa/me/logout/modules passam;
 *  - após confirm-2fa a MESMA sessão volta a acessar tudo (sem novo login);
 *  - operador segue sem restrição; AUTH_2FA_ENABLED=false desliga tudo;
 *  - fluxo verify-2fa de quem JÁ tem TOTP permanece intacto.
 *
 * Diferente de auth.test.ts/totp.test.ts (que mockam @atlas/auth inteiro),
 * aqui rodam o requireAuth/requireAuthAllowPending2fa REAIS e o auth.routes
 * REAL — só o banco/Redis/config são fakes e o verifyCode (TOTP) é stubado.
 */

// Estado compartilhado entre os fakes (hoisted: os factories de vi.mock rodam
// antes do corpo do módulo). Um usuário e uma sessão por vez bastam — o match
// de cookie×sessão (WHERE) não é o alvo aqui (coberto em auth.test.ts): o fake
// devolve a sessão corrente para qualquer cookie presente.
const state = vi.hoisted(() => ({
  userRow: null as Record<string, unknown> | null,
  sessionRow: null as Record<string, unknown> | null,
  redis: {} as Record<string, string>,
  auth2faEnabled: true,
  sessionSeq: 0,
}));

vi.mock('@atlas/core', async () => {
  // @atlas/db real: a identidade dos objetos de tabela roteia o fake de banco.
  const { users, sessions } = await import('@atlas/db');

  const rowsFor = (table: unknown): unknown[] => {
    if (table === users) return state.userRow ? [state.userRow] : [];
    if (table === sessions) return state.sessionRow ? [state.sessionRow] : [];
    return []; // ex.: user_modules em GET /auth/modules
  };

  // Builder encadeável e thenable (como o do Drizzle) — where/limit ignorados.
  const chain = (table: unknown) => {
    const b: any = {
      where: () => b,
      limit: () => b,
      orderBy: () => b,
      then: (onF: any, onR: any) => Promise.resolve(rowsFor(table)).then(onF, onR),
    };
    return b;
  };

  const config = () => ({
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
    AUTH_2FA_ENABLED: state.auth2faEnabled,
  });

  return {
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
    loadConfig: config,
    getConfig: config,
    getDb: () => ({
      select: (_cols?: unknown) => ({ from: (table: unknown) => chain(table) }),
      insert: (table: unknown) => ({
        values: (v: any) => ({
          returning: () => {
            if (table === sessions) {
              state.sessionSeq += 1;
              const row = {
                id: `00000000-0000-0000-0000-00000000se5${state.sessionSeq}`,
                userId: v.userId,
                csrfToken: v.csrfToken,
                ipAddress: v.ipAddress ?? null,
                userAgent: v.userAgent ?? null,
                createdAt: new Date(),
                expiresAt: v.expiresAt,
                lastActiveAt: new Date(),
              };
              state.sessionRow = row;
              return Promise.resolve([row]);
            }
            return Promise.resolve([v]);
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (v: any) => ({
          where: () => {
            // confirm-2fa grava totp_enabled=true AQUI — é o que libera a
            // mesma sessão no requireAuth (estado derivado do usuário).
            if (table === users && state.userRow) Object.assign(state.userRow, v);
            if (table === sessions && state.sessionRow) Object.assign(state.sessionRow, v);
            return Promise.resolve();
          },
        }),
      }),
      delete: (table: unknown) => ({
        where: () => {
          if (table === sessions) state.sessionRow = null;
          return Promise.resolve();
        },
      }),
    }),
    getRedis: () => ({
      ping: vi.fn().mockResolvedValue('PONG'),
      get: vi.fn((key: string) => Promise.resolve(state.redis[key] ?? null)),
      setex: vi.fn((key: string, _ttl: number, value: string) => {
        state.redis[key] = value;
        return Promise.resolve('OK');
      }),
      del: vi.fn((...keys: string[]) => {
        let n = 0;
        for (const k of keys) if (k in state.redis) { delete state.redis[k]; n++; }
        return Promise.resolve(n);
      }),
      incr: vi.fn((key: string) => {
        const n = Number(state.redis[key] ?? 0) + 1;
        state.redis[key] = String(n);
        return Promise.resolve(n);
      }),
      expire: vi.fn(() => Promise.resolve(1)),
      ttl: vi.fn(() => Promise.resolve(1800)),
    }),
    createLogger: () => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    }),
    sendEmail: vi.fn(() => Promise.resolve()),
    buildPasswordResetEmail: vi.fn(() => ({ subject: 's', html: 'h', text: 't' })),
  };
});

// @atlas/auth REAL (middlewares, sessão, argon2) — só o verifyCode do TOTP é
// stubado: gerar códigos otplib de verdade não agrega nada ao que está em teste.
vi.mock('@atlas/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@atlas/auth')>();
  return {
    ...actual,
    verifyCode: vi.fn((_secret: string, code: string) => code === '123456'),
  };
});

import { hashPassword, requireAuth } from '@atlas/auth';

const SENHA = 'senha-correta-123';
let passwordHash: string;
let userSeq = 0;

function setUser(role: 'operador' | 'gestor' | 'diretor', totpEnabled: boolean): void {
  userSeq += 1;
  state.userRow = {
    id: `00000000-0000-0000-0000-0000000000${String(userSeq).padStart(2, '0')}`,
    name: `Teste ${role}`,
    email: `${role}${userSeq}@test.com`,
    passwordHash,
    role,
    status: 'active',
    totpSecret: totpEnabled ? 'JBSWY3DPEHPK3PXP' : null,
    totpEnabled,
    passwordResetToken: null,
    passwordResetExpires: null,
    lastLoginAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

async function fazerLogin(app: express.Express): Promise<{ cookie: string; csrfToken: string }> {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: state.userRow!.email, password: SENHA });
  expect(res.status).toBe(200);
  expect(res.body.data.requires2FA).toBe(false);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const cookie = cookies.find((c) => c.startsWith('atlas_session='))!.split(';')[0]!;
  return { cookie, csrfToken: res.body.data.csrfToken as string };
}

describe('ACXEGDP-316 — sessão restrita até concluir o setup do 2FA', () => {
  let app: express.Express;

  beforeAll(async () => {
    passwordHash = await hashPassword(SENHA);
    const { default: authRouter } = await import('../routes/auth.routes.js');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(authRouter);
    // Rota de negócio representativa: qualquer rota protegida fora do
    // bootstrap do 2FA (mesmo requireAuth usado por admin e módulos).
    app.get('/api/v1/negocio-teste', requireAuth, (_req, res) => {
      res.json({ data: { ok: true }, error: null });
    });
  });

  beforeEach(() => {
    state.userRow = null;
    state.sessionRow = null;
    state.auth2faEnabled = true;
    for (const k of Object.keys(state.redis)) delete state.redis[k];
  });

  it('gestor sem TOTP: loga, mas rota de negócio responde 403 TWO_FA_SETUP_REQUIRED', async () => {
    setUser('gestor', false);
    const { cookie } = await fazerLogin(app);

    const res = await request(app).get('/api/v1/negocio-teste').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TWO_FA_SETUP_REQUIRED');
    expect(res.body.data).toBeNull();
  });

  it('diretor sem TOTP: mesma restrição da rota de negócio', async () => {
    setUser('diretor', false);
    const { cookie } = await fazerLogin(app);

    const res = await request(app).get('/api/v1/negocio-teste').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TWO_FA_SETUP_REQUIRED');
  });

  it('gestor sem TOTP: bootstrap liberado (me, modules, setup-2fa) e, após confirm-2fa, a MESMA sessão acessa negócio', async () => {
    setUser('gestor', false);
    const { cookie, csrfToken } = await fazerLogin(app);

    // /me e /modules passam mesmo com o setup pendente (front precisa deles
    // para decidir o redirect e não envenenar o cache da sidebar).
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.data.totp_enabled).toBe(false);

    const modules = await request(app).get('/api/v1/auth/modules').set('Cookie', cookie);
    expect(modules.status).toBe(200);

    // setup-2fa gera o segredo/QR
    const setup = await request(app)
      .post('/api/v1/auth/setup-2fa')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrfToken);
    expect(setup.status).toBe(200);
    expect(setup.body.data.secret).toBeDefined();
    expect(state.userRow!.totpSecret).toBe(setup.body.data.secret);

    // confirm-2fa habilita o TOTP…
    const confirm = await request(app)
      .post('/api/v1/auth/confirm-2fa')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrfToken)
      .send({ code: '123456' });
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.totp_enabled).toBe(true);

    // …e a MESMA sessão (mesmo cookie, sem novo login) volta a acessar tudo.
    const negocio = await request(app).get('/api/v1/negocio-teste').set('Cookie', cookie);
    expect(negocio.status).toBe(200);
    expect(negocio.body.data.ok).toBe(true);
  });

  it('gestor sem TOTP: logout funciona durante a restrição', async () => {
    setUser('gestor', false);
    const { cookie, csrfToken } = await fazerLogin(app);

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrfToken);
    expect(res.status).toBe(200);

    // Sessão destruída de verdade — cookie antigo não autentica mais.
    const depois = await request(app).get('/api/v1/negocio-teste').set('Cookie', cookie);
    expect(depois.status).toBe(401);
  });

  it('operador sem TOTP: nenhuma restrição (2FA não é exigido do perfil)', async () => {
    setUser('operador', false);
    const { cookie } = await fazerLogin(app);

    const res = await request(app).get('/api/v1/negocio-teste').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
  });

  it('AUTH_2FA_ENABLED=false: gestor sem TOTP segue com acesso pleno (comportamento atual)', async () => {
    state.auth2faEnabled = false;
    setUser('gestor', false);
    const { cookie } = await fazerLogin(app);

    const res = await request(app).get('/api/v1/negocio-teste').set('Cookie', cookie);
    expect(res.status).toBe(200);
  });

  it('gestor COM TOTP: fluxo verify-2fa existente intacto e sessão plena ao final', async () => {
    setUser('gestor', true);

    // Login não emite sessão — devolve tempToken (desafio TOTP)
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: state.userRow!.email, password: SENHA });
    expect(login.status).toBe(200);
    expect(login.body.data.requires2FA).toBe(true);
    expect(login.body.data.tempToken).toBeDefined();
    expect(login.headers['set-cookie']).toBeUndefined();

    const verify = await request(app)
      .post('/api/v1/auth/verify-2fa')
      .send({ tempToken: login.body.data.tempToken, code: '123456' });
    expect(verify.status).toBe(200);
    const cookies = verify.headers['set-cookie'] as unknown as string[];
    const cookie = cookies.find((c) => c.startsWith('atlas_session='))!.split(';')[0]!;

    const res = await request(app).get('/api/v1/negocio-teste').set('Cookie', cookie);
    expect(res.status).toBe(200);
  });
});
