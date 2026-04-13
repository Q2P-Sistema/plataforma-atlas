import {
  pgSchema,
  uuid,
  varchar,
  timestamp,
  integer,
  numeric,
  text,
  jsonb,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const forecastSchema = pgSchema('forecast');

// ── Config Sazonalidade ───────────────────────────────────
export const configSazonalidade = forecastSchema.table(
  'config_sazonalidade',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    familiaId: varchar('familia_id', { length: 100 }).notNull(),
    mes: integer('mes').notNull(), // 1-12
    fatorSugerido: numeric('fator_sugerido', { precision: 4, scale: 2 }).notNull().default('1.00'),
    fatorUsuario: numeric('fator_usuario', { precision: 4, scale: 2 }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('saz_familia_mes_idx').on(table.familiaId, table.mes),
  ],
);

// ── Config Forecast ───────────────────────────────────────
export const configForecast = forecastSchema.table('config_forecast', {
  chave: varchar('chave', { length: 100 }).primaryKey(),
  valor: jsonb('valor').notNull(),
  descricao: text('descricao'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Sazonalidade Log ──────────────────────────────────────
export const sazonalidadeLog = forecastSchema.table('sazonalidade_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  familiaId: varchar('familia_id', { length: 100 }).notNull(),
  mes: integer('mes').notNull(),
  fatorAnterior: numeric('fator_anterior', { precision: 4, scale: 2 }),
  fatorNovo: numeric('fator_novo', { precision: 4, scale: 2 }).notNull(),
  usuario: varchar('usuario', { length: 100 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Types ─────────────────────────────────────────────────
export type ConfigSazonalidade = typeof configSazonalidade.$inferSelect;
export type ConfigForecast = typeof configForecast.$inferSelect;
export type SazonalidadeLog = typeof sazonalidadeLog.$inferSelect;
