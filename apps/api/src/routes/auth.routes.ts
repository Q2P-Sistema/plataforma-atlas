import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { getDb, createLogger, getRedis, sendEmail, buildPasswordResetEmail } from '@atlas/core';
import { users } from '@atlas/db';
import {
  verifyPassword,
  hashPassword,
  createSession,
  destroySession,
  requireAuth,
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

const logger = createLogger('auth');
const SESSION_COOKIE = 'atlas_session';
const TEMP_TOKEN_PREFIX = 'atlas:2fa:temp:';
const TEMP_TOKEN_TTL = 300; // 5 minutes

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

    sendSuccess(res, {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
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

    // Delete temp token
    await redis.del(`${TEMP_TOKEN_PREFIX}${tempToken}`);

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

    sendSuccess(res, {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
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
  async (req: Request, res: Response) => {
    try {
      const user = req.user!;
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
  async (req: Request, res: Response) => {
    try {
      const { code } = req.body;
      const user = req.user!;

      if (!code) {
        sendError(res, 'VALIDATION_ERROR', 'Código é obrigatório', 400);
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

      // Enable 2FA
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

router.post('/api/v1/auth/forgot-password', async (req: Request, res: Response) => {
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

    // Build reset URL — use Origin header or fallback
    const origin = req.headers.origin ?? req.headers.referer?.replace(/\/$/, '') ?? 'http://localhost:5173';
    const resetUrl = `${origin}/reset-password/${resetToken}`;

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
router.post('/api/v1/auth/reset-password', async (req: Request, res: Response) => {
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
