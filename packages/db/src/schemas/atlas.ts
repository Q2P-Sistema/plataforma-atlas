import {
  pgSchema,
  uuid,
  varchar,
  boolean,
  timestamp,
  integer,
  inet,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const atlasSchema = pgSchema('atlas');

export const users = atlasSchema.table(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    role: varchar('role', { length: 20 })
      .notNull()
      .$type<'operador' | 'gestor' | 'diretor'>(),
    status: varchar('status', { length: 20 })
      .notNull()
      .default('active')
      .$type<'active' | 'inactive'>(),
    totpSecret: varchar('totp_secret', { length: 255 }),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    passwordResetToken: varchar('password_reset_token', { length: 255 }),
    passwordResetExpires: timestamp('password_reset_expires', {
      withTimezone: true,
    }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('users_email_unique')
      .on(table.email)
      .where('deleted_at IS NULL' as any),
    index('users_role_idx').on(table.role),
    index('users_status_idx').on(table.status),
  ],
);

export const sessions = atlasSchema.table(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: varchar('csrf_token', { length: 255 }).notNull(),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

export const userModules = atlasSchema.table(
  'user_modules',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    moduleKey: varchar('module_key', { length: 40 }).notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    grantedBy: uuid('granted_by').references(() => users.id),
  },
  (table) => [
    index('user_modules_user_idx').on(table.userId),
    index('user_modules_key_idx').on(table.moduleKey),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type UserModule = typeof userModules.$inferSelect;
export type NewUserModule = typeof userModules.$inferInsert;
