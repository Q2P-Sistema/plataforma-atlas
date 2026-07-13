import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { getDb, createLogger, getRedis, sendEmail, buildPasswordResetEmail, getConfig } from '@atlas/core';
import { users } from '@atlas/db';
import {
  verifyPassword,
  hashPassword,
  createSession,
  destroySession,
  requireAuth,
  csrfProtection,
  checkLoginRateLimit,
  recordFailedLogin,
  resetFailedLogins,
  generateSecret,
  generateQRCodeDataUrl,
  generateOtpauthUrl,
  verifyCode,
  getUserModules,
  isModuleEnabledGlobally,
  MODULE_KEYS,
} from '@atlas/auth';
import { sendSuccess, sendError } from '../envelope.js';
import { createIpRateLimiter } from '../middleware/rate-limit.js';

const logger = createLogger('auth');
const SESSION_COOKIE = 'atlas_session';
const TEMP_TOKEN_PREFIX = 'atlas:2fa:temp:';
const TEMP_TOKEN_TTL = 300; // 5 minutes
// SEG-04: contador de tentativas de 2FA por usuário — sem isso o tempToken
// (5 min) aceitava tentativas ilimitadas de TOTP (brute-force viável).
const TWOFA_ATTEMPTS_PREFIX = 'atlas:2fa:attempts:';
const TWOFA_CONFIRM_ATTEMPTS_PREFIX = 'atlas:2fa:confirm-attempts:';
const MAX_2FA_ATTEMPTS = 5;
const TWOFA_ATTEMPTS_TTL = 900; // 15 min

const router: Router = Router();

// POST /api/v1/auth/login
router.post('/api/v1/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      sendError(res, 'VALIDATION_ERROR', 'E-mail e senha são obrigatórios', 400);
      return;
    }

    // Rate limit check
    const rateLimit = await checkLoginRateLimit(email);
    if (rateLimit.locked) {
      sendError(
        res,
        'TOO_MANY_ATTEMPTS',
        `Conta bloqueada por ${rateLimit.remainingMinutes} minutos`,
        429,
      );
      return;
    }

    // Find user
    const db = getDb();
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user || user.deletedAt) {
      sendError(res, 'INVALID_CREDENTIALS', 'E-mail ou senha incorretos', 401);
      return;
    }

    if (user.status !== 'active') {
      sendError(res, 'ACCOUNT_INACTIVE', 'Conta desativada', 401);
      return;
    }

    // Verify password
    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      await recordFailedLogin(email);
      sendError(res, 'INVALID_CREDENTIALS', 'E-mail ou senha incorretos', 401);
      return;
    }

    // Reset failed logins on success
    await resetFailedLogins(user.id);

    // Check 2FA
    if (user.totpEnabled && user.totpSecret) {
      const tempToken = crypto.randomBytes(32).toString('hex');
      const redis = getRedis();
      await redis.setex(
        `${TEMP_TOKEN_PREFIX}${tempToken}`,
        TEMP_TOKEN_TTL,
        JSON.stringify({ userId: user.id, email: user.email }),
      );
      sendSuccess(res, { requires2FA: true, tempToken });
      return;
    }

    // Create session
    const ipAddress =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const session = await createSession(user.id, ipAddress, userAgent);

    // Update last login
    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    // Set cookie
    res.cookie(SESSION_COOKIE, session.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 24 * 60 * 60 * 1000, // 24h
    });

    logger.info({ userId: user.id, email: user.email }, 'User logged in');

    // ACXEGDP-307: sem totp_enabled/last_login_at aqui, o front (setUser) gravava
    // totp_enabled=undefined no store — o ProtectedShell tratava todo gestor/diretor
    // como se nunca tivesse configurado 2FA e mandava de volta pro /2fa/setup a cada
    // login, mesmo já configurado. /me sempre devolveu esses campos certos; login e
    // verify-2fa não. Mantém o mesmo shape do /me.
    sendSuccess(res, {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        totp_enabled: user.totpEnabled,
        last_login_at: user.lastLoginAt,
      },
      csrfToken: session.csrfToken,
      requires2FA: false,
    });
  } catch (err) {
    logger.error({ err }, 'Login error');
    sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
  }
});

// POST /api/v1/auth/verify-2fa
router.post('/api/v1/auth/verify-2fa', async (req: Request, res: Response) => {
  try {
    const { tempToken, code } = req.body;

    if (!tempToken || !code) {
      sendError(res, 'VALIDATION_ERROR', 'Token e código são obrigatórios', 400);
      return;
    }

    // Retrieve temp token from Redis
    const redis = getRedis();
    const stored = await redis.get(`${TEMP_TOKEN_PREFIX}${tempToken}`);
    if (!stored) {
      sendError(res, 'INVALID_TOKEN', 'Token expirado ou inválido', 401);
      return;
    }

    const { userId } = JSON.parse(stored) as { userId: string; email: string };

    // SEG-04: INCR atômico antes de verificar (à prova de corrida com requisições
    // paralelas). Contador por usuário — por tempToken permitiria renovar o limite
    // relogando com a senha correta. Ao exceder, invalida o tempToken.
    const attemptsKey = `${TWOFA_ATTEMPTS_PREFIX}${userId}`;
    const attempts = await redis.incr(attemptsKey);
    if (attempts === 1) await redis.expire(attemptsKey, TWOFA_ATTEMPTS_TTL);
    if (attempts > MAX_2FA_ATTEMPTS) {
      await redis.del(`${TEMP_TOKEN_PREFIX}${tempToken}`);
      logger.warn({ userId }, '2FA brute-force lockout');
      sendError(res, 'TOO_MANY_ATTEMPTS', 'Muitas tentativas de código. Aguarde 15 minutos e faça login novamente.', 429);
      return;
    }

    // Find user
    const db = getDb();
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user || !user.totpSecret) {
      sendError(res, 'INVALID_TOKEN', 'Usuário não encontrado', 401);
      return;
    }

    // Verify TOTP code
    const isValid = verifyCode(user.totpSecret, code);
    if (!isValid) {
      sendError(res, 'INVALID_2FA_CODE', 'Código inválido', 401);
      return;
    }

    // Delete temp token + zera o contador de tentativas (SEG-04)
    await redis.del(`${TEMP_TOKEN_PREFIX}${tempToken}`, attemptsKey);

    // Create session
    const ipAddress =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const session = await createSession(user.id, ipAddress, userAgent);

    // Update last login
    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    // Set cookie
    res.cookie(SESSION_COOKIE, session.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 24 * 60 * 60 * 1000,
    });

    logger.info({ userId: user.id }, 'User logged in with 2FA');

    // ACXEGDP-307: sem totp_enabled/last_login_at aqui, o front (setUser) gravava
    // totp_enabled=undefined no store — o ProtectedShell tratava todo gestor/diretor
    // como se nunca tivesse configurado 2FA e mandava de volta pro /2fa/setup a cada
    // login, mesmo já configurado. /me sempre devolveu esses campos certos; login e
    // verify-2fa não. Mantém o mesmo shape do /me.
    sendSuccess(res, {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        totp_enabled: user.totpEnabled,
        last_login_at: user.lastLoginAt,
      },
      csrfToken: session.csrfToken,
      requires2FA: false,
    });
  } catch (err) {
    logger.error({ err }, 'Verify 2FA error');
    sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
  }
});

// POST /api/v1/auth/setup-2fa (requires auth)
router.post(
  '/api/v1/auth/setup-2fa',
  requireAuth,
  csrfProtection,
  async (req: Request, res: Response) => {
    try {
      const user = req.user!;

      // SEG-10: re-setup com 2FA já habilitado exige a senha atual (step-up).
      // Primeiro setup (totpEnabled=false) segue sem atrito — o usuário acabou
      // de digitar a senha no login. Sem isto, uma sessão sequestrada (ou CSRF)
      // reconfiguraria o 2FA da vítima silenciosamente.
      if (user.totpEnabled) {
        const password: unknown = req.body?.password;
        if (
          typeof password !== 'string' ||
          !(await verifyPassword(user.passwordHash, password))
        ) {
          sendError(res, 'REAUTH_REQUIRED', 'Senha atual obrigatória para reconfigurar o 2FA', 401);
          return;
        }
      }

      const db = getDb();

      // Generate new secret
      const secret = generateSecret();
      const otpauthUrl = generateOtpauthUrl(secret, user.email);
      const qrCodeDataUrl = await generateQRCodeDataUrl(secret, user.email);

      // Store secret temporarily (not enabled yet — confirm-2fa will enable it)
      await db
        .update(users)
        .set({ totpSecret: secret })
        .where(eq(users.id, user.id));

      logger.info({ userId: user.id }, '2FA setup initiated');

      sendSuccess(res, {
        secret,
        qrCodeUrl: otpauthUrl,
        qrCodeDataUrl,
      });
    } catch (err) {
      logger.error({ err }, 'Setup 2FA error');
      sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
    }
  },
);

// POST /api/v1/auth/confirm-2fa (requires auth)
router.post(
  '/api/v1/auth/confirm-2fa',
  requireAuth,
  csrfProtection,
  async (req: Request, res: Response) => {
    try {
      const { code } = req.body;
      const user = req.user!;

      if (!code) {
        sendError(res, 'VALIDATION_ERROR', 'Código é obrigatório', 400);
        return;
      }

      // SEG-04: mesma proteção de brute-force do verify-2fa, contada por usuário.
      const redis = getRedis();
      const confirmAttemptsKey = `${TWOFA_CONFIRM_ATTEMPTS_PREFIX}${user.id}`;
      const confirmAttempts = await redis.incr(confirmAttemptsKey);
      if (confirmAttempts === 1) await redis.expire(confirmAttemptsKey, TWOFA_ATTEMPTS_TTL);
      if (confirmAttempts > MAX_2FA_ATTEMPTS) {
        logger.warn({ userId: user.id }, '2FA confirm brute-force lockout');
        sendError(res, 'TOO_MANY_ATTEMPTS', 'Muitas tentativas de código. Aguarde 15 minutos.', 429);
        return;
      }

      // Re-fetch user to get current totp_secret
      const db = getDb();
      const [freshUser] = await db
        .select({ totpSecret: users.totpSecret })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1);

      if (!freshUser?.totpSecret) {
        sendError(
          res,
          'SETUP_REQUIRED',
          'Configure o 2FA primeiro via /auth/setup-2fa',
          400,
        );
        return;
      }

      // Verify the code against the stored secret
      const isValid = verifyCode(freshUser.totpSecret, code);
      logger.debug({ userId: user.id, codeLength: code.length, isValid, hasSecret: !!freshUser.totpSecret }, 'Confirm 2FA attempt');
      if (!isValid) {
        sendError(res, 'INVALID_2FA_CODE', 'Código inválido. Tente novamente.', 400);
        return;
      }

      // Enable 2FA + zera o contador (SEG-04)
      await redis.del(confirmAttemptsKey);
      await db
        .update(users)
        .set({ totpEnabled: true })
        .where(eq(users.id, user.id));

      logger.info({ userId: user.id }, '2FA enabled');

      sendSuccess(res, { totp_enabled: true });
    } catch (err) {
      logger.error({ err }, 'Confirm 2FA error');
      sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
    }
  },
);

// POST /api/v1/auth/forgot-password
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// SEG-09: rate limit por IP em forgot/reset (antes: flood de e-mails e brute
// force do token de reset sem qualquer throttle por IP).
const forgotPasswordLimiter = createIpRateLimiter({ prefix: 'forgot', windowMs: 15 * 60 * 1000, limit: 5 });
const resetPasswordLimiter = createIpRateLimiter({ prefix: 'reset', windowMs: 15 * 60 * 1000, limit: 10 });

router.post('/api/v1/auth/forgot-password', forgotPasswordLimiter, async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    // Always return success to prevent email enumeration
    const successMsg = 'Se o e-mail existir, um link de recuperação será enviado';

    if (!email) {
      sendSuccess(res, { message: successMsg });
      return;
    }

    const db = getDb();
    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) {
      // Don't reveal that email doesn't exist
      sendSuccess(res, { message: successMsg });
      return;
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');
    const resetExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await db
      .update(users)
      .set({
        passwordResetToken: resetTokenHash,
        passwordResetExpires: resetExpires,
      })
      .where(eq(users.id, user.id));

    // Build reset URL from the server-side APP_URL (allowlist). NUNCA derivar de
    // headers Origin/Referer do request: sendo o endpoint publico e nao autenticado,
    // um atacante pode forjar o Origin e fazer o link de reset (com token valido)
    // apontar para o dominio dele, vazando o token da vitima (SEG-01, ACXEGDP-239).
    const baseUrl = getConfig().APP_URL.replace(/\/$/, '');
    const resetUrl = `${baseUrl}/reset-password/${resetToken}`;

    const emailContent = buildPasswordResetEmail(resetUrl);
    await sendEmail({
      to: user.email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
    });

    logger.info({ userId: user.id }, 'Password reset email sent');
    sendSuccess(res, { message: successMsg });
  } catch (err) {
    logger.error({ err }, 'Forgot password error');
    // Still return success to prevent enumeration
    sendSuccess(res, {
      message: 'Se o e-mail existir, um link de recuperação será enviado',
    });
  }
});

// POST /api/v1/auth/reset-password
router.post('/api/v1/auth/reset-password', resetPasswordLimiter, async (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      sendError(res, 'VALIDATION_ERROR', 'Token e nova senha são obrigatórios', 400);
      return;
    }

    if (newPassword.length < 8) {
      sendError(res, 'VALIDATION_ERROR', 'Senha deve ter pelo menos 8 caracteres', 400);
      return;
    }

    // Hash the token to compare with stored hash
    const tokenHash = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    const db = getDb();
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.passwordResetToken, tokenHash))
      .limit(1);

    if (!user) {
      sendError(res, 'INVALID_TOKEN', 'Token inválido ou expirado', 400);
      return;
    }

    if (!user.passwordResetExpires || user.passwordResetExpires < new Date()) {
      sendError(res, 'INVALID_TOKEN', 'Token inválido ou expirado', 400);
      return;
    }

    // Update password and clear reset token
    const newHash = await hashPassword(newPassword);
    await db
      .update(users)
      .set({
        passwordHash: newHash,
        passwordResetToken: null,
        passwordResetExpires: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      })
      .where(eq(users.id, user.id));

    logger.info({ userId: user.id }, 'Password reset completed');
    sendSuccess(res, { message: 'Senha alterada com sucesso' });
  } catch (err) {
    logger.error({ err }, 'Reset password error');
    sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
  }
});

// POST /api/v1/auth/logout
router.post(
  '/api/v1/auth/logout',
  requireAuth,
  csrfProtection,
  async (req: Request, res: Response) => {
    try {
      await destroySession(req.session!.id);
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      logger.info({ userId: req.user!.id }, 'User logged out');
      sendSuccess(res, { message: 'Sessão encerrada' });
    } catch (err) {
      logger.error({ err }, 'Logout error');
      sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
    }
  },
);

// GET /api/v1/auth/me
router.get(
  '/api/v1/auth/me',
  requireAuth,
  (req: Request, res: Response) => {
    const user = req.user!;
    sendSuccess(res, {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      totp_enabled: user.totpEnabled,
      last_login_at: user.lastLoginAt,
      csrfToken: req.session!.csrfToken,
    });
  },
);

// GET /api/v1/auth/modules
// Lista os modulos acessiveis ao user logado (intersecao: env global × grant; diretor bypass).
// Modulos retornados ja estao enabled — modulos sem acesso nao aparecem.
router.get(
  '/api/v1/auth/modules',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const grantedSet =
        user.role === 'diretor'
          ? new Set<string>(MODULE_KEYS)
          : new Set<string>(await getUserModules(user.id));

      const modules = MODULE_KEYS
        .filter((key) => isModuleEnabledGlobally(key) && grantedSet.has(key))
        .map((id) => ({ id, enabled: true }));

      sendSuccess(res, { modules });
    } catch (err) {
      logger.error({ err }, 'Get user modules error');
      sendError(res, 'INTERNAL_ERROR', 'Erro interno do servidor', 500);
    }
  },
);

export default router;
