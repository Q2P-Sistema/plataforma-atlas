import crypto from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '@atlas/core';
import { users, userModules, type User } from '@atlas/db';
import { hashPassword } from './password.js';
import { destroyUserSessions } from './session.js';
import { isModuleKey, type ModuleKey } from './modules.js';

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

export async function getUserModules(userId: string): Promise<ModuleKey[]> {
  const db = getDb();
  const rows = await db
    .select({ moduleKey: userModules.moduleKey })
    .from(userModules)
    .where(eq(userModules.userId, userId));

  return rows
    .map((r) => r.moduleKey)
    .filter((k): k is ModuleKey => isModuleKey(k));
}

export async function setUserModules(
  userId: string,
  keys: string[],
  grantedBy: string,
): Promise<ModuleKey[]> {
  const validKeys = Array.from(new Set(keys.filter(isModuleKey)));
  const db = getDb();

  // Verifica que o user existe (e nao foi soft-deleted)
  const [target] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);

  if (!target) {
    throw new UserError('USER_NOT_FOUND', 'Usuário não encontrado');
  }

  // Diretor tem bypass — nao mantemos rows pra ele.
  if (target.role === 'diretor') {
    await db.delete(userModules).where(eq(userModules.userId, userId));
    return [];
  }

  // Diff: remove os que sairam, insere os que chegaram (ON CONFLICT preserva granted_at original)
  const current = await db
    .select({ moduleKey: userModules.moduleKey })
    .from(userModules)
    .where(eq(userModules.userId, userId));

  const currentSet = new Set(current.map((r) => r.moduleKey));
  const nextSet = new Set<string>(validKeys);

  const toRemove = [...currentSet].filter((k) => !nextSet.has(k));
  const toAdd = [...nextSet].filter((k) => !currentSet.has(k));

  if (toRemove.length > 0) {
    await db
      .delete(userModules)
      .where(
        and(
          eq(userModules.userId, userId),
          inArray(userModules.moduleKey, toRemove),
        ),
      );
  }

  if (toAdd.length > 0) {
    await db.insert(userModules).values(
      toAdd.map((moduleKey) => ({
        userId,
        moduleKey,
        grantedBy,
      })),
    );
  }

  return validKeys;
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
