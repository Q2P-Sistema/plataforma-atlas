import { eq } from 'drizzle-orm';
import { getDb } from '@atlas/core';
import { users } from '@atlas/db';

// SEG-09 (ACXEGDP-247): este lockout por CONTA é o BACKSTOP contra ataque
// distribuído (muitos IPs). A primeira linha de defesa é o contador por
// (IP, conta) na rota de login (5 falhas → 30 min) + throttle por IP — por isso
// o threshold daqui subiu de 5 para 25: um atacante de IP único não consegue
// mais trancar a conta da vítima (DoS direcionado), mas um ataque distribuído
// ainda congela a conta antes de ganhar espaço de brute force relevante.
const MAX_ATTEMPTS = 25;
const LOCK_DURATION_MS = 30 * 60 * 1000;

export async function checkLoginRateLimit(
  email: string,
): Promise<{ locked: boolean; remainingMinutes?: number }> {
  const db = getDb();
  const [user] = await db
    .select({
      failedLoginAttempts: users.failedLoginAttempts,
      lockedUntil: users.lockedUntil,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) return { locked: false };

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const remaining = Math.ceil(
      (user.lockedUntil.getTime() - Date.now()) / 60_000,
    );
    return { locked: true, remainingMinutes: remaining };
  }

  return { locked: false };
}

export async function recordFailedLogin(email: string): Promise<void> {
  const db = getDb();
  const [user] = await db
    .select({
      id: users.id,
      failedLoginAttempts: users.failedLoginAttempts,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) return;

  const newAttempts = user.failedLoginAttempts + 1;
  const lockedUntil =
    newAttempts >= MAX_ATTEMPTS
      ? new Date(Date.now() + LOCK_DURATION_MS)
      : null;

  await db
    .update(users)
    .set({
      failedLoginAttempts: newAttempts,
      lockedUntil,
    })
    .where(eq(users.id, user.id));
}

export async function resetFailedLogins(userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(users)
    .set({ failedLoginAttempts: 0, lockedUntil: null })
    .where(eq(users.id, userId));
}
