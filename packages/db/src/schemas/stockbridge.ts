import {
  pgSchema,
  uuid,
  varchar,
  boolean,
  timestamp,
  numeric,
  bigint,
  integer,
  date,
  text,
  smallint,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './atlas.js';

export const stockbridgeSchema = pgSchema('stockbridge');

// ── Localidade ─────────────────────────────────────────────
export const localidade = stockbridgeSchema.table(
  'localidade',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    codigo: varchar('codigo', { length: 50 }).notNull().unique(),
    nome: varchar('nome', { length: 255 }).notNull(),
    tipo: varchar('tipo', { length: 20 })
      .notNull()
      .$type<'proprio' | 'tpl' | 'porto_seco' | 'virtual_transito' | 'virtual_ajuste'>(),
    cnpj: varchar('cnpj', { length: 50 }),
    cidade: varchar('cidade', { length: 100 }),
    ativo: boolean('ativo').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('localidade_tipo_ativo_idx').on(t.tipo, t.ativo)],
);

// ── Localidade Correlacao (ACXE ↔ Q2P) ─────────────────────
export const localidadeCorrelacao = stockbridgeSchema.table(
  'localidade_correlacao',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    localidadeId: uuid('localidade_id').notNull().unique().references(() => localidade.id, { onDelete: 'cascade' }),
    codigoLocalEstoqueAcxe: bigint('codigo_local_estoque_acxe', { mode: 'number' }),
    codigoLocalEstoqueQ2p: bigint('codigo_local_estoque_q2p', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

// ── Lote ───────────────────────────────────────────────────
export const lote = stockbridgeSchema.table(
  'lote',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    codigo: varchar('codigo', { length: 50 }).notNull().unique(),
    produtoCodigoAcxe: bigint('produto_codigo_acxe', { mode: 'number' }).notNull(),
    produtoCodigoQ2p: bigint('produto_codigo_q2p', { mode: 'number' }),
    fornecedorNome: varchar('fornecedor_nome', { length: 255 }).notNull(),
    paisOrigem: varchar('pais_origem', { length: 100 }),
    quantidadeFisica: numeric('quantidade_fisica', { precision: 12, scale: 3 }).notNull().default('0'),
    quantidadeFiscal: numeric('quantidade_fiscal', { precision: 12, scale: 3 }).notNull().default('0'),
    custoUsd: numeric('custo_usd', { precision: 12, scale: 2 }),
    status: varchar('status', { length: 30 })
      .notNull()
      .default('provisorio')
      .$type<'reconciliado' | 'divergencia' | 'transito' | 'provisorio' | 'aguardando_aprovacao' | 'rejeitado'>(),
    estagioTransito: varchar('estagio_transito', { length: 30 }).$type<
      'transito_intl' | 'porto_dta' | 'transito_interno' | 'reservado' | null
    >(),
    localidadeId: uuid('localidade_id').references(() => localidade.id),
    cnpj: varchar('cnpj', { length: 50 }).notNull(),
    notaFiscal: varchar('nota_fiscal', { length: 50 }),
    manual: boolean('manual').notNull().default(false),
    di: varchar('di', { length: 50 }),
    dta: varchar('dta', { length: 50 }),
    dtEntrada: date('dt_entrada').notNull(),
    dtPrevChegada: date('dt_prev_chegada'),
    ativo: boolean('ativo').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('lote_produto_status_idx').on(t.produtoCodigoAcxe, t.status, t.ativo),
    index('lote_cnpj_localidade_idx').on(t.cnpj, t.localidadeId),
    index('lote_nota_fiscal_idx').on(t.notaFiscal),
  ],
);

// ── Movimentacao (modelo pareado ACXE + Q2P) ───────────────
export const movimentacao = stockbridgeSchema.table(
  'movimentacao',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    notaFiscal: varchar('nota_fiscal', { length: 50 }).notNull(),
    tipoMovimento: varchar('tipo_movimento', { length: 30 })
      .notNull()
      .$type<
        | 'entrada_nf'
        | 'entrada_manual'
        | 'saida_automatica'
        | 'saida_manual'
        | 'ajuste'
        | 'regularizacao_fiscal'
        | 'debito_cruzado'
      >(),
    subtipo: varchar('subtipo', { length: 50 }),
    loteId: uuid('lote_id').references(() => lote.id),
    quantidadeT: numeric('quantidade_t', { precision: 12, scale: 3 }).notNull(),
    mvAcxe: smallint('mv_acxe'),
    dtAcxe: timestamp('dt_acxe', { withTimezone: true }),
    idMovestAcxe: varchar('id_movest_acxe', { length: 100 }),
    idAjusteAcxe: varchar('id_ajuste_acxe', { length: 100 }),
    idUserAcxe: uuid('id_user_acxe').references(() => users.id),
    mvQ2p: smallint('mv_q2p'),
    dtQ2p: timestamp('dt_q2p', { withTimezone: true }),
    idMovestQ2p: varchar('id_movest_q2p', { length: 100 }),
    idAjusteQ2p: varchar('id_ajuste_q2p', { length: 100 }),
    idUserQ2p: uuid('id_user_q2p').references(() => users.id),
    observacoes: text('observacoes'),
    ativo: boolean('ativo').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('movimentacao_tipo_ativo_idx').on(t.tipoMovimento, t.ativo),
    index('movimentacao_created_idx').on(t.createdAt),
    index('movimentacao_lote_idx').on(t.loteId),
  ],
);

// ── Aprovacao ──────────────────────────────────────────────
export const aprovacao = stockbridgeSchema.table(
  'aprovacao',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    loteId: uuid('lote_id').notNull().references(() => lote.id, { onDelete: 'cascade' }),
    precisaNivel: varchar('precisa_nivel', { length: 20 }).notNull().$type<'gestor' | 'diretor'>(),
    tipoAprovacao: varchar('tipo_aprovacao', { length: 30 }).notNull().$type<
      | 'recebimento_divergencia'
      | 'entrada_manual'
      | 'saida_transf_intra'
      | 'saida_comodato'
      | 'saida_amostra'
      | 'saida_descarte'
      | 'saida_quebra'
      | 'ajuste_inventario'
    >(),
    quantidadePrevistaT: numeric('quantidade_prevista_t', { precision: 12, scale: 3 }),
    quantidadeRecebidaT: numeric('quantidade_recebida_t', { precision: 12, scale: 3 }),
    tipoDivergencia: varchar('tipo_divergencia', { length: 30 }).$type<'faltando' | 'varredura' | 'cruzada' | null>(),
    observacoes: text('observacoes'),
    lancadoPor: uuid('lancado_por').notNull().references(() => users.id),
    lancadoEm: timestamp('lancado_em', { withTimezone: true }).notNull().defaultNow(),
    aprovadoPor: uuid('aprovado_por').references(() => users.id),
    aprovadoEm: timestamp('aprovado_em', { withTimezone: true }),
    status: varchar('status', { length: 20 })
      .notNull()
      .default('pendente')
      .$type<'pendente' | 'aprovada' | 'rejeitada'>(),
    rejeicaoMotivo: text('rejeicao_motivo'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('aprovacao_status_nivel_idx').on(t.status, t.precisaNivel),
    index('aprovacao_lote_idx').on(t.loteId),
  ],
);

// ── Divergencia ────────────────────────────────────────────
export const divergencia = stockbridgeSchema.table(
  'divergencia',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    loteId: uuid('lote_id').references(() => lote.id),
    movimentacaoId: uuid('movimentacao_id').references(() => movimentacao.id),
    tipo: varchar('tipo', { length: 30 })
      .notNull()
      .$type<'faltando' | 'varredura' | 'cruzada' | 'fiscal_pendente'>(),
    quantidadeDeltaT: numeric('quantidade_delta_t', { precision: 12, scale: 3 }).notNull(),
    valorUsd: numeric('valor_usd', { precision: 12, scale: 2 }),
    status: varchar('status', { length: 20 })
      .notNull()
      .default('aberta')
      .$type<'aberta' | 'regularizada' | 'descartada'>(),
    regularizadaEm: timestamp('regularizada_em', { withTimezone: true }),
    regularizadaPorMovimentacaoId: uuid('regularizada_por_movimentacao_id').references(() => movimentacao.id),
    observacoes: text('observacoes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('divergencia_tipo_status_idx').on(t.tipo, t.status),
    index('divergencia_lote_idx').on(t.loteId),
  ],
);

// ── Fornecedor Exclusao ────────────────────────────────────
export const fornecedorExclusao = stockbridgeSchema.table(
  'fornecedor_exclusao',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    fornecedorCnpj: varchar('fornecedor_cnpj', { length: 50 }).notNull(),
    fornecedorNome: varchar('fornecedor_nome', { length: 255 }).notNull(),
    motivo: text('motivo'),
    excluidoPor: uuid('excluido_por').notNull().references(() => users.id),
    excluidoEm: timestamp('excluido_em', { withTimezone: true }).notNull().defaultNow(),
    reincluidoEm: timestamp('reincluido_em', { withTimezone: true }),
    reincluidoPor: uuid('reincluido_por').references(() => users.id),
  },
);

// ── Config Produto ─────────────────────────────────────────
export const configProduto = stockbridgeSchema.table(
  'config_produto',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    produtoCodigoAcxe: bigint('produto_codigo_acxe', { mode: 'number' }).notNull().unique(),
    consumoMedioDiarioT: numeric('consumo_medio_diario_t', { precision: 10, scale: 3 }),
    leadTimeDias: integer('lead_time_dias'),
    familiaCategoria: varchar('familia_categoria', { length: 50 }),
    incluirEmMetricas: boolean('incluir_em_metricas').notNull().default(true),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

// ── Type exports ───────────────────────────────────────────
export type Localidade = typeof localidade.$inferSelect;
export type NewLocalidade = typeof localidade.$inferInsert;
export type LocalidadeCorrelacao = typeof localidadeCorrelacao.$inferSelect;
export type NewLocalidadeCorrelacao = typeof localidadeCorrelacao.$inferInsert;
export type Lote = typeof lote.$inferSelect;
export type NewLote = typeof lote.$inferInsert;
export type Movimentacao = typeof movimentacao.$inferSelect;
export type NewMovimentacao = typeof movimentacao.$inferInsert;
export type Aprovacao = typeof aprovacao.$inferSelect;
export type NewAprovacao = typeof aprovacao.$inferInsert;
export type Divergencia = typeof divergencia.$inferSelect;
export type NewDivergencia = typeof divergencia.$inferInsert;
export type FornecedorExclusao = typeof fornecedorExclusao.$inferSelect;
export type NewFornecedorExclusao = typeof fornecedorExclusao.$inferInsert;
export type ConfigProduto = typeof configProduto.$inferSelect;
export type NewConfigProduto = typeof configProduto.$inferInsert;
