import crypto from 'node:crypto';
import { eq, isNull } from 'drizzle-orm';
import { getDb } from '@atlas/core';
import { users, type User } from '@atlas/db';
import { hashPassword } from './password.js';
import { destroyUserSessions } from './session.js';

function generateTemporaryPassword(): string {
  return crypto.randomBytes(12).toString('base64url');
}

export type UserPublic = Pick<
  User,
  'id' | 'name' | 'email' | 'role' | 'status' | 'totpEnabled' | 'lastLoginAt' | 'createdAt'
>;

function toPublic(u: User): UserPublic {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    totpEnabled: u.totpEnabled,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}

export async function listUsers(): Promise<UserPublic[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(users)
    .where(isNull(users.deletedAt));

  return rows.map(toPublic);
}

export async function createUser(
  name: string,
  email: string,
  role: User['role'],
): Promise<{ user: UserPublic; temporaryPassword: string }> {
  const db = getDb();

  // Check for existing email
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    throw new UserError('EMAIL_TAKEN', 'E-mail já cadastrado');
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const [created] = await db
    .insert(users)
    .values({
      name,
      email,
      passwordHash,
      role,
      status: 'active',
      totpEnabled: false,
    })
    .returning();

  return { user: toPublic(created!), temporaryPassword };
}

export async function updateUser(
  id: string,
  fields: Partial<Pick<User, 'name' | 'role' | 'status'>>,
): Promise<UserPublic> {
  const db = getDb();

  const [updated] = await db
    .update(users)
    .set(fields)
    .where(eq(users.id, id))
    .returning();

  if (!updated) {
    throw new UserError('USER_NOT_FOUND', 'Usuário não encontrado');
  }

  return toPublic(updated);
}

export async function deactivateUser(id: string): Promise<UserPublic> {
  const db = getDb();

  const [updated] = await db
    .update(users)
    .set({ status: 'inactive' as const })
    .where(eq(users.id, id))
    .returning();

  if (!updated) {
    throw new UserError('USER_NOT_FOUND', 'Usuário não encontrado');
  }

  // Destroy all active sessions
  await destroyUserSessions(id);

  return toPublic(updated);
}

export async function reactivateUser(id: string): Promise<UserPublic> {
  const db = getDb();

  const [updated] = await db
    .update(users)
    .set({ status: 'active' as const })
    .where(eq(users.id, id))
    .returning();

  if (!updated) {
    throw new UserError('USER_NOT_FOUND', 'Usuário não encontrado');
  }

  return toPublic(updated);
}

export async function adminResetPassword(
  id: string,
): Promise<{ temporaryPassword: string }> {
  const db = getDb();

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const [updated] = await db
    .update(users)
    .set({
      passwordHash,
      failedLoginAttempts: 0,
      lockedUntil: null,
    })
    .where(eq(users.id, id))
    .returning();

  if (!updated) {
    throw new UserError('USER_NOT_FOUND', 'Usuário não encontrado');
  }

  // Destroy sessions so they must re-login
  await destroyUserSessions(id);

  return { temporaryPassword };
}

export async function adminReset2FA(id: string): Promise<void> {
  const db = getDb();

  const [updated] = await db
    .update(users)
    .set({
      totpSecret: null,
      totpEnabled: false,
    })
    .where(eq(users.id, id))
    .returning();

  if (!updated) {
    throw new UserError('USER_NOT_FOUND', 'Usuário não encontrado');
  }

  // Destroy sessions so they must re-login and reconfigure 2FA
  await destroyUserSessions(id);
}

export class UserError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UserError';
  }
}
