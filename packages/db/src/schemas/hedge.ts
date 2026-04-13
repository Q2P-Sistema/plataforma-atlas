import {
  pgSchema,
  uuid,
  varchar,
  boolean,
  timestamp,
  integer,
  numeric,
  text,
  date,
  bigint,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const hedgeSchema = pgSchema('hedge');

// ── Bucket Mensal ──────────────────────────────────────────
export const bucketMensal = hedgeSchema.table(
  'bucket_mensal',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mesRef: date('mes_ref').notNull(),
    empresa: varchar('empresa', { length: 10 })
      .notNull()
      .$type<'acxe' | 'q2p'>(),
    pagarUsd: numeric('pagar_usd', { precision: 15, scale: 2 }).notNull().default('0'),
    ndfUsd: numeric('ndf_usd', { precision: 15, scale: 2 }).notNull().default('0'),
    coberturaPct: numeric('cobertura_pct', { precision: 5, scale: 2 }).notNull().default('0'),
    status: varchar('status', { length: 20 })
      .notNull()
      .$type<'ok' | 'sub_hedged' | 'over_hedged'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('bucket_mes_empresa_idx').on(table.mesRef, table.empresa),
    index('bucket_status_idx').on(table.status),
  ],
);

// ── NDF Registro ───────────────────────────────────────────
export const ndfRegistro = hedgeSchema.table(
  'ndf_registro',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tipo: varchar('tipo', { length: 10 })
      .notNull()
      .$type<'ndf' | 'trava' | 'acc'>(),
    notionalUsd: numeric('notional_usd', { precision: 15, scale: 2 }).notNull(),
    taxaNdf: numeric('taxa_ndf', { precision: 8, scale: 4 }).notNull(),
    ptaxContratacao: numeric('ptax_contratacao', { precision: 8, scale: 4 }).notNull(),
    prazoDias: integer('prazo_dias').notNull(),
    dataContratacao: date('data_contratacao').notNull(),
    dataVencimento: date('data_vencimento').notNull(),
    custoBrl: numeric('custo_brl', { precision: 15, scale: 2 }).notNull(),
    resultadoBrl: numeric('resultado_brl', { precision: 15, scale: 2 }),
    ptaxLiquidacao: numeric('ptax_liquidacao', { precision: 8, scale: 4 }),
    status: varchar('status', { length: 20 })
      .notNull()
      .default('pendente')
      .$type<'pendente' | 'ativo' | 'liquidado' | 'cancelado'>(),
    bucketId: uuid('bucket_id').references(() => bucketMensal.id),
    empresa: varchar('empresa', { length: 10 }).notNull(),
    banco: varchar('banco', { length: 100 }),
    observacao: text('observacao'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ndf_status_idx').on(table.status),
    index('ndf_bucket_idx').on(table.bucketId),
    index('ndf_empresa_idx').on(table.empresa),
    index('ndf_vencimento_idx').on(table.dataVencimento),
  ],
);

// ── Titulos a Pagar ────────────────────────────────────────
export const titulosPagar = hedgeSchema.table(
  'titulos_pagar',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    omieId: bigint('omie_id', { mode: 'number' }).notNull().unique(),
    valorUsd: numeric('valor_usd', { precision: 15, scale: 2 }).notNull(),
    vencimento: date('vencimento').notNull(),
    bucketMes: date('bucket_mes').notNull(),
    ptaxNf: numeric('ptax_nf', { precision: 8, scale: 4 }),
    status: varchar('status', { length: 20 })
      .notNull()
      .default('aberto')
      .$type<'aberto' | 'liquidado' | 'arquivado'>(),
    empresa: varchar('empresa', { length: 10 }).notNull(),
    fornecedor: varchar('fornecedor', { length: 255 }),
    numeroDocumento: varchar('numero_documento', { length: 50 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('titulos_bucket_mes_idx').on(table.bucketMes),
    index('titulos_status_idx').on(table.status),
    index('titulos_empresa_idx').on(table.empresa),
    index('titulos_vencimento_idx').on(table.vencimento),
  ],
);

// ── PTAX Historico ─────────────────────────────────────────
export const ptaxHistorico = hedgeSchema.table('ptax_historico', {
  dataRef: date('data_ref').primaryKey(),
  venda: numeric('venda', { precision: 8, scale: 4 }).notNull(),
  compra: numeric('compra', { precision: 8, scale: 4 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── NDF Taxas de Mercado ───────────────────────────────────
export const ndfTaxas = hedgeSchema.table(
  'ndf_taxas',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    dataRef: date('data_ref').notNull(),
    prazoDias: integer('prazo_dias').notNull(),
    taxa: numeric('taxa', { precision: 8, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ndf_taxas_data_prazo_idx').on(table.dataRef, table.prazoDias),
  ],
);

// ── Posicao Snapshot ───────────────────────────────────────
export const posicaoSnapshot = hedgeSchema.table('posicao_snapshot', {
  id: uuid('id').defaultRandom().primaryKey(),
  dataRef: date('data_ref').notNull().unique(),
  exposureUsd: numeric('exposure_usd', { precision: 15, scale: 2 }).notNull(),
  ndfAtivoUsd: numeric('ndf_ativo_usd', { precision: 15, scale: 2 }).notNull(),
  gapUsd: numeric('gap_usd', { precision: 15, scale: 2 }).notNull(),
  coberturaPct: numeric('cobertura_pct', { precision: 5, scale: 2 }).notNull(),
  ptaxRef: numeric('ptax_ref', { precision: 8, scale: 4 }).notNull(),
  rawJson: jsonb('raw_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Estoque Snapshot ───────────────────────────────────────
export const estoqueSnapshot = hedgeSchema.table(
  'estoque_snapshot',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    dataRef: date('data_ref').notNull(),
    empresa: varchar('empresa', { length: 10 }).notNull(),
    localidade: varchar('localidade', { length: 100 }).notNull(),
    valorBrl: numeric('valor_brl', { precision: 15, scale: 2 }).notNull(),
    custoUsdEstimado: numeric('custo_usd_estimado', { precision: 15, scale: 2 }).notNull(),
    pago: boolean('pago').notNull().default(false),
    fase: varchar('fase', { length: 30 }).$type<'maritimo' | 'alfandega' | 'deposito'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('estoque_data_empresa_idx').on(table.dataRef, table.empresa),
  ],
);

// ── Alerta ─────────────────────────────────────────────────
export const alerta = hedgeSchema.table(
  'alerta',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tipo: varchar('tipo', { length: 50 }).notNull(),
    severidade: varchar('severidade', { length: 20 })
      .notNull()
      .$type<'critico' | 'alta' | 'media'>(),
    mensagem: text('mensagem').notNull(),
    bucketId: uuid('bucket_id').references(() => bucketMensal.id),
    lido: boolean('lido').notNull().default(false),
    resolvido: boolean('resolvido').notNull().default(false),
    resolvidoAt: timestamp('resolvido_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('alerta_severidade_idx').on(table.severidade),
    index('alerta_lido_idx').on(table.lido),
  ],
);

// ── Config Motor ───────────────────────────────────────────
export const configMotor = hedgeSchema.table('config_motor', {
  chave: varchar('chave', { length: 100 }).primaryKey(),
  valor: jsonb('valor').notNull(),
  descricao: text('descricao'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Sync Log ───────────────────────────────────────────────
export const syncLog = hedgeSchema.table(
  'sync_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    fonte: varchar('fonte', { length: 50 }).notNull(),
    operacao: varchar('operacao', { length: 100 }).notNull(),
    status: varchar('status', { length: 20 })
      .notNull()
      .$type<'sucesso' | 'erro'>(),
    registros: integer('registros').default(0),
    duracaoMs: integer('duracao_ms'),
    erro: text('erro'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('sync_log_fonte_idx').on(table.fonte),
    index('sync_log_created_idx').on(table.createdAt),
  ],
);

// ── Type Exports ───────────────────────────────────────────
export type BucketMensal = typeof bucketMensal.$inferSelect;
export type NewBucketMensal = typeof bucketMensal.$inferInsert;
export type NdfRegistro = typeof ndfRegistro.$inferSelect;
export type NewNdfRegistro = typeof ndfRegistro.$inferInsert;
export type TituloPagar = typeof titulosPagar.$inferSelect;
export type PtaxHistorico = typeof ptaxHistorico.$inferSelect;
export type NdfTaxa = typeof ndfTaxas.$inferSelect;
export type PosicaoSnapshot = typeof posicaoSnapshot.$inferSelect;
export type EstoqueSnapshot = typeof estoqueSnapshot.$inferSelect;
export type Alerta = typeof alerta.$inferSelect;
export type ConfigMotor = typeof configMotor.$inferSelect;
export type SyncLog = typeof syncLog.$inferSelect;
