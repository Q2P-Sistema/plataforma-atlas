import { sql } from 'drizzle-orm';
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
  jsonb,
  index,
  uniqueIndex,
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

// ── Conferência de Estoque — mapa De→Para de locais (ACXE×Q2P) ──
// Espelho da aba tbl_locaisEstoque da planilha. tipo=ESPELHADO indica par
// bilateral (mesmo `codigo` textual nas duas empresas). Vide migration 0040.
export const conferenciaLocalMap = stockbridgeSchema.table(
  'conferencia_local_map',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    codigoLocalEstoque: bigint('codigo_local_estoque', { mode: 'number' }).notNull().unique(),
    codigo: varchar('codigo', { length: 50 }).notNull(),
    descricao: varchar('descricao', { length: 255 }).notNull(),
    nomeComparativo: varchar('nome_comparativo', { length: 255 }),
    tipo: varchar('tipo', { length: 20 }).notNull().$type<'ESPELHADO' | 'INDIVIDUAL'>(),
    empresa: varchar('empresa', { length: 20 }).notNull().$type<'ACXE' | 'Q2P'>(),
    ativo: boolean('ativo').notNull().default(true),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('conferencia_local_map_codigo_idx').on(t.codigo),
    index('conferencia_local_map_tipo_idx').on(t.tipo),
  ],
);

export type ConferenciaLocalMap = typeof conferenciaLocalMap.$inferSelect;
export type NewConferenciaLocalMap = typeof conferenciaLocalMap.$inferInsert;

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
    quantidadeFisicaKg: numeric('quantidade_fisica_kg', { precision: 12, scale: 3 }).notNull().default('0'),
    quantidadeFiscalKg: numeric('quantidade_fiscal_kg', { precision: 12, scale: 3 }).notNull().default('0'),
    custoBrlKg: numeric('custo_brl_kg', { precision: 12, scale: 2 }),
    valorTotalNfBrl: numeric('valor_total_nf_brl', { precision: 14, scale: 2 }),
    codigoLocalEstoqueOrigemAcxe: varchar('codigo_local_estoque_origem_acxe', { length: 50 }),
    status: varchar('status', { length: 30 })
      .notNull()
      .default('provisorio')
      .$type<'reconciliado' | 'divergencia' | 'transito' | 'provisorio' | 'aguardando_aprovacao' | 'rejeitado'>(),
    estagioTransito: varchar('estagio_transito', { length: 30 }).$type<
      'aguardando_embarque' | 'transito_intl' | 'no_porto' | 'transito_local' | 'transito_interno' | 'reservado' | null
    >(),
    localidadeId: uuid('localidade_id').references(() => localidade.id),
    cnpj: varchar('cnpj', { length: 50 }).notNull(),
    notaFiscal: varchar('nota_fiscal', { length: 50 }),
    manual: boolean('manual').notNull().default(false),
    di: varchar('di', { length: 50 }),
    dta: varchar('dta', { length: 50 }),
    dtEntrada: date('dt_entrada').notNull(),
    dtPrevChegada: date('dt_prev_chegada'),
    pedidoCompraAcxe: text('pedido_compra_acxe'),
    nfOrigemId: bigint('nf_origem_id', { mode: 'number' }),
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
    quantidadeKg: numeric('quantidade_kg', { precision: 12, scale: 3 }).notNull(),
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
    opId: uuid('op_id').notNull().defaultRandom(),
    statusOmie: text('status_omie')
      .notNull()
      .default('concluida')
      .$type<'concluida' | 'pendente_q2p' | 'pendente_acxe_faltando' | 'falha'>(),
    tentativasQ2p: smallint('tentativas_q2p').notNull().default(0),
    tentativasAcxeFaltando: smallint('tentativas_acxe_faltando').notNull().default(0),
    ultimoErroOmie: jsonb('ultimo_erro_omie'),
    // Saida manual sem lote (migration 0026)
    produtoCodigoAcxe: bigint('produto_codigo_acxe', { mode: 'number' }),
    // Recebimento nacional Q2P — produto da tabela Q2P (migration 0032)
    produtoCodigoQ2p: bigint('produto_codigo_q2p', { mode: 'number' }),
    galpao: text('galpao'),
    galpaoDestino: text('galpao_destino'),
    empresa: text('empresa').$type<'acxe' | 'q2p'>(),
    criadoPor: uuid('criado_por').references(() => users.id),
    dtPrevistaRetorno: date('dt_prevista_retorno'),
    movimentacaoOrigemId: uuid('movimentacao_origem_id'),
    custoUnitarioBrl: numeric('custo_unitario_brl', { precision: 14, scale: 6 }),
    // ACXEGDP-344 (migration 0047): baixa do pedido de compra Q2P desta entrada
    // de importacao. NULL = nao se aplica.
    baixaPedidoQ2p: text('baixa_pedido_q2p').$type<'pendente' | 'concluida' | 'sem_saldo' | 'falha' | null>(),
    ativo: boolean('ativo').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('movimentacao_tipo_ativo_idx').on(t.tipoMovimento, t.ativo),
    index('movimentacao_created_idx').on(t.createdAt),
    index('movimentacao_lote_idx').on(t.loteId),
    index('movimentacao_sku_galpao_empresa_idx').on(t.produtoCodigoAcxe, t.galpao, t.empresa),
    index('movimentacao_criado_por_idx').on(t.criadoPor, t.createdAt),
    // Migration 0046 (ACXEGDP-115): idempotencia de entrada_nf por PRODUTO —
    // N produtos da mesma NF convivem, cada um idempotente na sua linha.
    uniqueIndex('movimentacao_nf_entrada_idempotencia_idx')
      .on(t.notaFiscal, t.empresa, t.produtoCodigoAcxe)
      .where(
        sql`tipo_movimento = 'entrada_nf' AND ativo = true AND empresa IS NOT NULL AND produto_codigo_acxe IS NOT NULL`,
      ),
    // Migration 0046: saida_automatica mantém a chave da 0044 (por NF+empresa).
    uniqueIndex('movimentacao_nf_saida_idempotencia_idx')
      .on(t.notaFiscal, t.empresa)
      .where(sql`tipo_movimento = 'saida_automatica' AND ativo = true AND empresa IS NOT NULL`),
  ],
);

// ── Aprovacao ──────────────────────────────────────────────
export const aprovacao = stockbridgeSchema.table(
  'aprovacao',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Migration 0026: lote_id virou opcional; usar produto_codigo_acxe+galpao+empresa quando saida sem lote
    loteId: uuid('lote_id').references(() => lote.id, { onDelete: 'cascade' }),
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
      | 'retorno_comodato'
    >(),
    quantidadePrevistaKg: numeric('quantidade_prevista_kg', { precision: 12, scale: 3 }),
    quantidadeRecebidaKg: numeric('quantidade_recebida_kg', { precision: 12, scale: 3 }),
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
    // Migration 0026: novas colunas pra saida sem lote
    produtoCodigoAcxe: bigint('produto_codigo_acxe', { mode: 'number' }),
    // Migration 0032: produto Q2P direto (recebimento nacional Q2P sem match ACXE)
    produtoCodigoQ2p: bigint('produto_codigo_q2p', { mode: 'number' }),
    galpao: text('galpao'),
    empresa: text('empresa').$type<'acxe' | 'q2p'>(),
    movimentacaoId: uuid('movimentacao_id'),
    // Migration 0029: operador descarta rejeicao da inbox sem alterar status
    dispensadaEm: timestamp('dispensada_em', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('aprovacao_status_nivel_idx').on(t.status, t.precisaNivel),
    index('aprovacao_lote_idx').on(t.loteId),
  ],
);

// ── Reserva de saldo (controle de concorrencia para saida manual) ──
export const reservaSaldo = stockbridgeSchema.table(
  'reserva_saldo',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    movimentacaoId: uuid('movimentacao_id').notNull().unique(),
    produtoCodigoAcxe: bigint('produto_codigo_acxe', { mode: 'number' }).notNull(),
    galpao: text('galpao').notNull(),
    empresa: text('empresa').notNull().$type<'acxe' | 'q2p'>(),
    quantidadeKg: numeric('quantidade_kg', { precision: 12, scale: 3 }).notNull(),
    status: text('status').notNull().default('ativa').$type<'ativa' | 'liberada' | 'consumida'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvidoEm: timestamp('resolvido_em', { withTimezone: true }),
  },
  (t) => [index('reserva_sku_idx').on(t.produtoCodigoAcxe, t.galpao, t.empresa, t.status)],
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
    quantidadeDeltaKg: numeric('quantidade_delta_kg', { precision: 12, scale: 3 }).notNull(),
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
    consumoMedioDiarioKg: numeric('consumo_medio_diario_kg', { precision: 10, scale: 3 }),
    leadTimeDias: integer('lead_time_dias'),
    incluirEmMetricas: boolean('incluir_em_metricas').notNull().default(true),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

// ── Familia OMIE Atlas (mapping macro) ─────────────────────
// Lookup que mapeia descricao_familia do OMIE -> categoria Atlas (PE/PP/PS/etc).
// Migration 0017. Substitui o campo config_produto.familia_categoria — agora a
// categoria e derivada via JOIN, evitando duplicacao por SKU.
export const familiaOmieAtlas = stockbridgeSchema.table(
  'familia_omie_atlas',
  {
    familiaOmie: text('familia_omie').primaryKey(),
    familiaAtlas: text('familia_atlas').notNull(),
    incluirEmMetricas: boolean('incluir_em_metricas').notNull().default(true),
    observacao: text('observacao'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

// ── Movimentacao Legado (histórico 1:1 do MySQL — migration 0038) ──
// Recibos dual-CNPJ do sistema PHP legado. Audit + idempotência apenas:
// não afeta saldo (OMIE já consolidou esses recebimentos). Importado por
// modules/stockbridge/src/scripts/migrate-from-mysql.ts.
export const movimentacaoLegado = stockbridgeSchema.table(
  'movimentacao_legado',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    idLegado: integer('id_legado').notNull(), // tb_movimentacao.id_movimentacao (MySQL)
    notaFiscal: varchar('nota_fiscal', { length: 50 }).notNull(),
    // lado ACXE
    mvAcxe: smallint('mv_acxe'),
    dtAcxe: timestamp('dt_acxe', { withTimezone: true }),
    idMovestAcxe: varchar('id_movest_acxe', { length: 100 }),
    idAjusteAcxe: varchar('id_ajuste_acxe', { length: 100 }),
    idUserAcxe: uuid('id_user_acxe').references(() => users.id),
    // lado Q2P
    mvQ2p: smallint('mv_q2p'),
    dtQ2p: timestamp('dt_q2p', { withTimezone: true }),
    idMovestQ2p: varchar('id_movest_q2p', { length: 100 }),
    idAjusteQ2p: varchar('id_ajuste_q2p', { length: 100 }),
    idUserQ2p: uuid('id_user_q2p').references(() => users.id),
    // controle
    ativo: boolean('ativo').notNull().default(true),
    migradoEm: timestamp('migrado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('movimentacao_legado_nota_fiscal_idx').on(t.notaFiscal),
  ],
);

// ── NF Pedido Mapa / Filhote (mapeamento NF mãe→filhotes — migration 0039) ──
// Usados pelo cockpit para calcular posição fiscal pendente de importação.
// NF mãe: 21.1 Extrema, não gera estoque, nunca n_id_receb > 0.
// NF filhote: 90.0.2 TRANSITO, gera estoque, n_id_receb > 0 quando recebida.
export const nfPedidoMapa = stockbridgeSchema.table(
  'nf_pedido_mapa',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    pedidoAcxeOmie: varchar('pedido_acxe_omie', { length: 50 }).notNull(),
    nfMae: varchar('nf_mae', { length: 50 }).notNull(),
    ativo: boolean('ativo').notNull().default(true),
    importadoEm: timestamp('importado_em', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('nf_pedido_mapa_nf_mae_idx').on(t.nfMae),
  ],
);

export const nfPedidoFilhote = stockbridgeSchema.table(
  'nf_pedido_filhote',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mapaId: uuid('mapa_id').notNull().references(() => nfPedidoMapa.id),
    nfFilhote: varchar('nf_filhote', { length: 50 }).notNull(),
    posicao: smallint('posicao').notNull(),
    ativo: boolean('ativo').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('nf_pedido_filhote_mapa_idx').on(t.mapaId),
    index('nf_pedido_filhote_nf_idx').on(t.nfFilhote),
  ],
);

// ── Baixa de pedido de compra Q2P (ledger — migration 0047, ACXEGDP-344) ──
// Uma linha por (movimentacao de entrada de importacao, pedido Q2P descontado).
// saldo_anterior/novo = quantidade do item ANTES/DEPOIS do AlteraPedCompra.
export const baixaPedidoQ2p = stockbridgeSchema.table(
  'baixa_pedido_q2p',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    movimentacaoId: uuid('movimentacao_id').notNull().references(() => movimentacao.id),
    /** Pedido Q2P (id OMIE). NULL = linha de "resto sem pedido aberto". */
    ncodped: bigint('ncodped', { mode: 'number' }),
    cnumero: varchar('cnumero', { length: 50 }),
    ncodprod: bigint('ncodprod', { mode: 'number' }).notNull(),
    ncoditem: bigint('ncoditem', { mode: 'number' }),
    quantidadeKg: numeric('quantidade_kg', { precision: 12, scale: 3 }).notNull(),
    saldoAnteriorKg: numeric('saldo_anterior_kg', { precision: 12, scale: 3 }),
    saldoNovoKg: numeric('saldo_novo_kg', { precision: 12, scale: 3 }),
    status: text('status').notNull().$type<'pendente' | 'concluida' | 'falha' | 'sem_pedido'>(),
    origem: text('origem').notNull().default('fluxo').$type<'fluxo' | 'retry' | 'backfill'>(),
    tentativas: smallint('tentativas').notNull().default(0),
    ultimoErro: jsonb('ultimo_erro'),
    criadoPor: uuid('criado_por').references(() => users.id),
    ativo: boolean('ativo').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('baixa_pedido_q2p_mov_pedido_uq')
      .on(t.movimentacaoId, t.ncodped)
      .where(sql`ativo = true AND ncodped IS NOT NULL`),
    uniqueIndex('baixa_pedido_q2p_mov_sem_pedido_uq')
      .on(t.movimentacaoId)
      .where(sql`ativo = true AND ncodped IS NULL`),
    index('baixa_pedido_q2p_ncodped_idx').on(t.ncodped),
  ],
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
export type ReservaSaldo = typeof reservaSaldo.$inferSelect;
export type NewReservaSaldo = typeof reservaSaldo.$inferInsert;
export type Divergencia = typeof divergencia.$inferSelect;
export type NewDivergencia = typeof divergencia.$inferInsert;
export type FornecedorExclusao = typeof fornecedorExclusao.$inferSelect;
export type NewFornecedorExclusao = typeof fornecedorExclusao.$inferInsert;
export type ConfigProduto = typeof configProduto.$inferSelect;
export type NewConfigProduto = typeof configProduto.$inferInsert;
export type FamiliaOmieAtlas = typeof familiaOmieAtlas.$inferSelect;
export type BaixaPedidoQ2p = typeof baixaPedidoQ2p.$inferSelect;
export type NewBaixaPedidoQ2p = typeof baixaPedidoQ2p.$inferInsert;
export type NewFamiliaOmieAtlas = typeof familiaOmieAtlas.$inferInsert;
export type MovimentacaoLegado = typeof movimentacaoLegado.$inferSelect;
export type NewMovimentacaoLegado = typeof movimentacaoLegado.$inferInsert;
export type NfPedidoMapa = typeof nfPedidoMapa.$inferSelect;
export type NewNfPedidoMapa = typeof nfPedidoMapa.$inferInsert;
export type NfPedidoFilhote = typeof nfPedidoFilhote.$inferSelect;
export type NewNfPedidoFilhote = typeof nfPedidoFilhote.$inferInsert;
