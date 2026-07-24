import { eq, and, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { getDb, createLogger } from '@atlas/core';
import { movimentacao, aprovacao, divergencia, reservaSaldo } from '@atlas/db';
import { converterParaKg } from './motor.service.js';
import { filtroEmpresaOmie } from './omie-shared.js';
import { enviarAlertaAprovacaoPendente } from './notificacao.service.js';
import { resolverDescricaoProdutoAcxe } from './produto-descricao.js';
import { NIVEL_APROVACAO_POR_SUBTIPO, type SubtipoMovimento, type UnidadeMedida } from '../types.js';

const logger = createLogger('stockbridge:saida-manual');

export class SaldoInsuficienteError extends Error {
  constructor(public readonly disponivelKg: number, public readonly solicitadoKg: number) {
    super(`Saldo insuficiente: disponível ${disponivelKg} kg, solicitado ${solicitadoKg} kg`);
    this.name = 'SaldoInsuficienteError';
  }
}

export class SubtipoInvalidoError extends Error {
  constructor(public readonly subtipo: string) {
    super(`Subtipo ${subtipo} não é válido para saída manual`);
    this.name = 'SubtipoInvalidoError';
  }
}

export class ComodatoDadosObrigatoriosError extends Error {
  constructor(public readonly campo: string) {
    super(`Campo "${campo}" obrigatório para subtipo=comodato`);
    this.name = 'ComodatoDadosObrigatoriosError';
  }
}

export type SubtipoSaidaManual =
  | 'transf_intra_cnpj'
  | 'comodato'
  | 'amostra'
  | 'descarte'
  | 'quebra'
  | 'inventario_menos';

const SUBTIPOS_VALIDOS: ReadonlySet<SubtipoSaidaManual> = new Set([
  'transf_intra_cnpj', 'comodato', 'amostra', 'descarte', 'quebra', 'inventario_menos',
]);

export function isSubtipoSaidaManual(s: string): s is SubtipoSaidaManual {
  return SUBTIPOS_VALIDOS.has(s as SubtipoSaidaManual);
}

const SUBTIPO_PARA_TIPO_APROVACAO = {
  transf_intra_cnpj: 'saida_transf_intra',
  comodato: 'saida_comodato',
  amostra: 'saida_amostra',
  descarte: 'saida_descarte',
  quebra: 'saida_quebra',
  inventario_menos: 'ajuste_inventario',
} as const;

const SUBTIPO_CRIA_DIVERGENCIA_FISCAL: ReadonlySet<SubtipoSaidaManual> = new Set([
  'amostra', 'descarte', 'quebra', 'inventario_menos',
]);

export type EmpresaSaida = 'acxe' | 'q2p';

export interface SaldoDisponivel {
  produtoCodigoAcxe: number;
  galpao: string;
  empresa: EmpresaSaida;
  saldoOmieKg: number;
  reservadoKg: number;
  disponivelKg: number;
}

/**
 * Consulta saldo disponivel de um SKU em um galpao + empresa.
 * Saldo OMIE (vw_posicaoEstoqueUnificadaFamilia) menos reservas ativas no Atlas.
 *
 * IMPORTANTE: a view tem codigo_produto text (ex 'PP-016'), nao bate com
 * tbl_produtos_ACXE.codigo_produto bigint. Match cross-empresa e por descricao
 * (mesmo padrao do consumo medio e do Cockpit).
 */
export async function consultarSaldoDisponivel(
  produtoCodigoAcxe: number,
  galpao: string,
  empresa: EmpresaSaida,
): Promise<SaldoDisponivel> {
  const db = getDb();

  // Migration 0030: galpao = codigo_estoque exato (11.1, 11.2, etc).
  const result = await db.execute<{ saldo_omie_kg: string | null; reservado_kg: string | null }>(sql`
    WITH descricao_sku AS (
      SELECT descricao FROM public."tbl_produtos_ACXE"
      WHERE codigo_produto = ${produtoCodigoAcxe}::bigint
      LIMIT 1
    ),
    saldo_omie AS (
      SELECT COALESCE(SUM(o.saldo), 0) AS saldo_kg
      FROM public."vw_posicaoEstoqueUnificadaFamilia" o
      INNER JOIN descricao_sku d ON d.descricao = o.descricao_produto
      WHERE o.saldo > 0
        AND o.codigo_estoque = ${galpao}
        AND ${sql.raw(filtroEmpresaOmie(empresa))}
    ),
    reservas AS (
      SELECT COALESCE(SUM(quantidade_kg), 0) AS reservado_kg
      FROM stockbridge.reserva_saldo
      WHERE produto_codigo_acxe = ${produtoCodigoAcxe}::bigint
        AND galpao = ${galpao}
        AND empresa = ${empresa}
        AND status = 'ativa'
    )
    SELECT
      (SELECT saldo_kg FROM saldo_omie)::text AS saldo_omie_kg,
      (SELECT reservado_kg FROM reservas)::text AS reservado_kg
  `);

  const row = result.rows[0];
  const saldoOmie = row?.saldo_omie_kg ? Number(row.saldo_omie_kg) : 0;
  const reservado = row?.reservado_kg ? Number(row.reservado_kg) : 0;
  const disponivel = Number(new Decimal(saldoOmie).minus(reservado).toFixed(3));

  return {
    produtoCodigoAcxe,
    galpao,
    empresa,
    saldoOmieKg: saldoOmie,
    reservadoKg: reservado,
    disponivelKg: Math.max(0, disponivel),
  };
}

export interface RegistrarSaidaManualInput {
  subtipo: SubtipoSaidaManual;
  produtoCodigoAcxe: number;
  galpao: string;
  empresa: EmpresaSaida;
  quantidadeOriginal: number;
  unidade: UnidadeMedida;
  /** Galpao destino — obrigatorio quando subtipo=transf_intra_cnpj. */
  galpaoDestino?: string | null;
  observacoes: string;
  /** Comodato: data prevista de retorno. */
  dtPrevistaRetorno?: string | null;
  /** Comodato: cliente/destinatario (texto livre, vai pra observacoes). */
  cliente?: string | null;
  userId: string;
}

export interface RegistrarSaidaManualResult {
  movimentacaoId: string;
  aprovacaoId: string;
  reservaId: string;
  status: 'aguardando_aprovacao';
  precisaNivel: 'gestor' | 'diretor';
  divergenciaId?: string;
}

/**
 * Registra uma saida manual sem lote — agnostica de FIFO.
 * Persiste movimentacao + reserva_saldo + aprovacao pendente. Saldo so e
 * efetivamente debitado no OMIE quando o aprovador (gestor/diretor) aprova
 * via aprovacao.service.aprovar().
 *
 * Comodato: dual ACXE+Q2P pra galpoes espelhados (TROCA criada nas duas — migration 0027).
 */
export async function registrarSaidaManual(
  input: RegistrarSaidaManualInput,
): Promise<RegistrarSaidaManualResult> {
  if (!isSubtipoSaidaManual(input.subtipo)) {
    throw new SubtipoInvalidoError(input.subtipo);
  }
  if (!input.observacoes || input.observacoes.trim().length === 0) {
    throw new Error('Motivo/observacao obrigatório para saída manual');
  }
  if (input.subtipo === 'comodato') {
    // Comodato agora suporta ACXE e Q2P (TROCA criada em ambos no OMIE — migration 0027).
    if (!input.dtPrevistaRetorno) throw new ComodatoDadosObrigatoriosError('dtPrevistaRetorno');
    if (!input.cliente || input.cliente.trim().length === 0) {
      throw new ComodatoDadosObrigatoriosError('cliente');
    }
  }
  if (input.subtipo === 'transf_intra_cnpj' && (!input.galpaoDestino || input.galpaoDestino === input.galpao)) {
    throw new Error('Galpão destino obrigatório e diferente da origem para transf_intra_cnpj');
  }

  const quantidadeKg = Number(new Decimal(converterParaKg(input.quantidadeOriginal, input.unidade)).toFixed(3));
  if (quantidadeKg <= 0) throw new Error('Quantidade deve ser positiva');

  // Validacao de saldo (snapshot antes de gravar — race vai ser pega pela
  // re-checagem dentro da transacao, abaixo).
  const saldo = await consultarSaldoDisponivel(input.produtoCodigoAcxe, input.galpao, input.empresa);
  if (quantidadeKg > saldo.disponivelKg) {
    throw new SaldoInsuficienteError(saldo.disponivelKg, quantidadeKg);
  }

  const nivel = NIVEL_APROVACAO_POR_SUBTIPO[input.subtipo as keyof typeof NIVEL_APROVACAO_POR_SUBTIPO] ?? 'gestor';
  const tipoAprovacao = SUBTIPO_PARA_TIPO_APROVACAO[input.subtipo];
  const criaDivFiscal = SUBTIPO_CRIA_DIVERGENCIA_FISCAL.has(input.subtipo);

  const obsFinal = construirObservacao(input);

  const db = getDb();
  const resultado = await db.transaction(async (tx) => {
    // STK-11 (ACXEGDP-289): advisory lock transacional por (produto, galpao,
    // empresa) ANTES do re-check de saldo. Sem ele, o re-check abaixo nao
    // protegia nada: em READ COMMITTED, duas tx concorrentes do mesmo trio nao
    // veem a reserva uma da outra — ambas passavam no SUM e inseriam
    // reserva_saldo, somando reservado > disponivel. O lock serializa apenas
    // saidas do MESMO trio (trios distintos seguem paralelos) e e liberado
    // automaticamente no commit/rollback.
    const chaveLock = `sb:reserva:${input.produtoCodigoAcxe}:${input.galpao}:${input.empresa}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${chaveLock}, 0))`);

    // Re-checa saldo dentro da tx (agora efetivo, sob o lock).
    const reChk = await tx.execute<{ disp_kg: string }>(sql`
      WITH descricao_sku AS (
        SELECT descricao FROM public."tbl_produtos_ACXE"
        WHERE codigo_produto = ${input.produtoCodigoAcxe}::bigint
        LIMIT 1
      ),
      saldo AS (
        SELECT COALESCE(SUM(o.saldo), 0) AS s
        FROM public."vw_posicaoEstoqueUnificadaFamilia" o
        INNER JOIN descricao_sku d ON d.descricao = o.descricao_produto
        WHERE o.saldo > 0
          AND o.codigo_estoque = ${input.galpao}
          AND ${sql.raw(filtroEmpresaOmie(input.empresa))}
      ),
      res AS (
        SELECT COALESCE(SUM(quantidade_kg), 0) AS r
        FROM stockbridge.reserva_saldo
        WHERE produto_codigo_acxe = ${input.produtoCodigoAcxe}::bigint
          AND galpao = ${input.galpao}
          AND empresa = ${input.empresa}
          AND status = 'ativa'
      )
      SELECT ((SELECT s FROM saldo) - (SELECT r FROM res))::text AS disp_kg
    `);
    const dispRecheck = Number(reChk.rows[0]?.disp_kg ?? 0);
    if (quantidadeKg > dispRecheck) {
      throw new SaldoInsuficienteError(dispRecheck, quantidadeKg);
    }

    const [mov] = await tx
      .insert(movimentacao)
      .values({
        notaFiscal: `MANUAL-${input.subtipo.toUpperCase()}-${Date.now()}`,
        tipoMovimento: 'saida_manual',
        subtipo: input.subtipo as SubtipoMovimento,
        loteId: null,
        produtoCodigoAcxe: input.produtoCodigoAcxe,
        galpao: input.galpao,
        galpaoDestino: input.subtipo === 'transf_intra_cnpj' ? input.galpaoDestino ?? null : null,
        empresa: input.empresa,
        criadoPor: input.userId,
        dtPrevistaRetorno: input.subtipo === 'comodato' ? input.dtPrevistaRetorno ?? null : null,
        quantidadeKg: String(-Math.abs(quantidadeKg)),
        observacoes: obsFinal,
        statusOmie: 'pendente_q2p', // saida ainda nao foi processada no OMIE; aprovacao dispara
      })
      .returning();

    const [apr] = await tx
      .insert(aprovacao)
      .values({
        loteId: null,
        produtoCodigoAcxe: input.produtoCodigoAcxe,
        galpao: input.galpao,
        empresa: input.empresa,
        movimentacaoId: mov!.id,
        precisaNivel: nivel,
        tipoAprovacao,
        quantidadeRecebidaKg: String(quantidadeKg),
        observacoes: obsFinal,
        lancadoPor: input.userId,
      })
      .returning();

    const [rsv] = await tx
      .insert(reservaSaldo)
      .values({
        movimentacaoId: mov!.id,
        produtoCodigoAcxe: input.produtoCodigoAcxe,
        galpao: input.galpao,
        empresa: input.empresa,
        quantidadeKg: String(quantidadeKg),
        status: 'ativa',
      })
      .returning();

    let divId: string | undefined;
    if (criaDivFiscal) {
      const [div] = await tx
        .insert(divergencia)
        .values({
          loteId: null,
          movimentacaoId: mov!.id,
          tipo: 'fiscal_pendente',
          quantidadeDeltaKg: String(-quantidadeKg),
          status: 'aberta',
          observacoes: `Saída manual tipo ${input.subtipo} — aguarda regularização fiscal`,
        })
        .returning();
      divId = div!.id;
    }

    return { movimentacaoId: mov!.id, aprovacaoId: apr!.id, reservaId: rsv!.id, divergenciaId: divId };
  });

  // EML-05: o e-mail mostrava só o número do SKU cru ("Item: SKU 819 @ G01 — 819").
  // Resolve a descrição real e evita duplicar o SKU no rótulo.
  const descricaoProduto = await resolverDescricaoProdutoAcxe(db, input.produtoCodigoAcxe);
  void enviarAlertaAprovacaoPendente({
    aprovacaoId: resultado.aprovacaoId,
    tipoAprovacao,
    nivel,
    loteCodigo: `Galpão ${input.galpao}`,
    produto: descricaoProduto,
    quantidadeKg,
    detalhes: `Saída manual ${input.subtipo} — ${input.observacoes}`,
  }).catch((err) => logger.error({ err }, 'Falha ao notificar aprovação pendente'));

  logger.info(
    {
      movimentacaoId: resultado.movimentacaoId,
      subtipo: input.subtipo,
      empresa: input.empresa,
      galpao: input.galpao,
      sku: input.produtoCodigoAcxe,
      nivel,
      quantidadeKg,
    },
    'Saída manual registrada, aguarda aprovação',
  );

  return {
    movimentacaoId: resultado.movimentacaoId,
    aprovacaoId: resultado.aprovacaoId,
    reservaId: resultado.reservaId,
    status: 'aguardando_aprovacao',
    precisaNivel: nivel,
    divergenciaId: resultado.divergenciaId,
  };
}

/**
 * Extrai o cliente do campo observacoes do comodato origem. construirObservacao()
 * grava como "Cliente: <nome> | Retorno previsto: ...". Mesma regex usada em
 * listarComodatosAbertos no SQL — duplicada aqui pra uso em TS.
 */
function extrairClienteDaObservacao(obs: string | null | undefined): string | null {
  if (!obs) return null;
  const m = obs.match(/Cliente:\s*([^|]+)/);
  const nome = m?.[1]?.trim();
  return nome && nome.length > 0 ? nome : null;
}

function construirObservacao(input: RegistrarSaidaManualInput): string {
  const partes = [input.observacoes.trim()];
  if (input.subtipo === 'transf_intra_cnpj' && input.galpaoDestino) {
    partes.push(`Destino: galpão ${input.galpaoDestino}`);
  }
  if (input.subtipo === 'comodato') {
    if (input.cliente) partes.push(`Cliente: ${input.cliente.trim()}`);
    if (input.dtPrevistaRetorno) partes.push(`Retorno previsto: ${input.dtPrevistaRetorno}`);
  }
  return partes.join(' | ');
}

export interface ComodatoAberto {
  movimentacaoId: string;
  produtoCodigoAcxe: number;
  produtoDescricao: string;
  galpaoOrigem: string;
  empresa: EmpresaSaida;
  quantidadeKg: number;
  cliente: string | null;
  dtPrevistaRetorno: string | null;
  dtSaida: string;
  diasEmAberto: number;
  vencido: boolean;
}

/**
 * Lista comodatos aprovados sem retorno registrado.
 * Filtros: empresa (so Q2P por design); incluir vencidos.
 */
export async function listarComodatosAbertos(): Promise<ComodatoAberto[]> {
  const db = getDb();
  const result = await db.execute<{
    movimentacao_id: string;
    produto_codigo_acxe: string;
    descricao: string | null;
    galpao_origem: string;
    empresa: string;
    quantidade_kg: string;
    cliente: string | null;
    dt_prevista_retorno: string | null;
    dt_saida: string;
  }>(sql`
    SELECT m.id AS movimentacao_id,
           m.produto_codigo_acxe::text,
           p.descricao,
           m.galpao AS galpao_origem,
           m.empresa,
           ABS(m.quantidade_kg)::text AS quantidade_kg,
           NULLIF(regexp_replace(m.observacoes, '.*Cliente: ([^|]+).*', '\\1'), m.observacoes) AS cliente,
           m.dt_prevista_retorno::text,
           m.created_at::text AS dt_saida
    FROM stockbridge.movimentacao m
    LEFT JOIN public."tbl_produtos_ACXE" p ON p.codigo_produto = m.produto_codigo_acxe
    WHERE m.subtipo = 'comodato'
      AND m.tipo_movimento = 'saida_manual'
      AND m.status_omie = 'concluida'
      AND m.ativo = true
      AND NOT EXISTS (
        SELECT 1 FROM stockbridge.movimentacao r
        WHERE r.movimentacao_origem_id = m.id
          AND r.subtipo = 'retorno_comodato'
          AND r.ativo = true
      )
    ORDER BY m.created_at ASC
  `);

  const hoje = new Date();
  // Hoje no fuso BR como YYYY-MM-DD pra comparar com dt_prevista_retorno (DATE)
  // sem timezone shift. en-CA produz formato ISO direto. Comodato vencido =
  // dt_prevista < hoje. Hoje mesmo NAO conta como vencido.
  const hojeBR = hoje.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  return result.rows.map((r) => {
    const dtSaida = new Date(r.dt_saida);
    const diasAbertos = Math.floor((hoje.getTime() - dtSaida.getTime()) / (1000 * 60 * 60 * 24));
    const vencido = r.dt_prevista_retorno ? r.dt_prevista_retorno < hojeBR : false;
    return {
      movimentacaoId: r.movimentacao_id,
      produtoCodigoAcxe: Number(r.produto_codigo_acxe),
      produtoDescricao: r.descricao ?? `SKU ${r.produto_codigo_acxe}`,
      galpaoOrigem: r.galpao_origem,
      empresa: r.empresa as EmpresaSaida,
      quantidadeKg: Number(r.quantidade_kg),
      cliente: r.cliente,
      dtPrevistaRetorno: r.dt_prevista_retorno,
      dtSaida: r.dt_saida,
      diasEmAberto: diasAbertos,
      vencido,
    };
  });
}

export interface ProdutoQ2PItem {
  /** Codigo numerico ACXE (canonico no Atlas — vai pra produto_codigo_acxe). */
  codigoAcxe: number;
  /** Descricao do produto Q2P (mesma do ACXE — match cross-empresa por descricao). */
  descricao: string;
}

/**
 * Busca produtos Q2P por descricao. Usado no retorno de comodato — operador
 * escolhe pela descricao (codigos OMIE internos sao opacos pra ele) e o backend
 * recebe o codigoAcxe canonico via JOIN tbl_produtos_ACXE x tbl_produtos_Q2P
 * pela descricao (mesma estrategia cross-empresa do legado).
 */
export async function buscarProdutosQ2P(
  termo: string | null,
  limit: number = 50,
): Promise<ProdutoQ2PItem[]> {
  const db = getDb();
  const termoLike = termo && termo.trim().length > 0 ? `%${termo.trim()}%` : null;
  const result = await db.execute<{ codigo_acxe: string; descricao: string }>(sql`
    SELECT pa.codigo_produto::text AS codigo_acxe,
           pq.descricao
    FROM public."tbl_produtos_Q2P" pq
    INNER JOIN public."tbl_produtos_ACXE" pa ON pa.descricao = pq.descricao
    WHERE pq.descricao IS NOT NULL
      AND (pa.inativo IS NULL OR pa.inativo <> 'S')
      ${termoLike ? sql`AND pq.descricao ILIKE ${termoLike}` : sql``}
    ORDER BY pq.descricao
    LIMIT ${limit}
  `);
  return result.rows.map((r) => ({
    codigoAcxe: Number(r.codigo_acxe),
    descricao: r.descricao,
  }));
}

export interface RegistrarRetornoComodatoInput {
  movimentacaoOrigemId: string;
  produtoCodigoAcxeRecebido: number;
  galpaoDestino: string;
  quantidadeKgRecebida: number;
  observacoes: string;
  userId: string;
}

export interface RegistrarRetornoComodatoResult {
  movimentacaoBaixaId: string;
  movimentacaoEntradaId: string;
  aprovacaoId: string;
  divergenciaId?: string;
}

/**
 * Registra retorno de comodato. Aceita SKU/qtd diferentes do comodato original
 * (clarificacao 2026-05-06). Gera 2 movimentacoes:
 *   1. baixa do TROCA: SKU original × qtd ORIGINAL (zera o comodato)
 *   2. entrada no destino: SKU recebido × qtd recebida (pode ser ≠)
 * Cria 1 aprovacao gestor cobrindo ambas. Diferenca SKU/qtd vira divergencia
 * pra justificativa caso a caso (decisao 4.b).
 */
export async function registrarRetornoComodato(
  input: RegistrarRetornoComodatoInput,
): Promise<RegistrarRetornoComodatoResult> {
  if (!input.observacoes || input.observacoes.trim().length === 0) {
    throw new Error('Motivo/observacao obrigatório para retorno de comodato');
  }
  if (input.quantidadeKgRecebida <= 0) {
    throw new Error('Quantidade recebida deve ser positiva');
  }

  const db = getDb();

  const [movOrigem] = await db
    .select()
    .from(movimentacao)
    .where(and(eq(movimentacao.id, input.movimentacaoOrigemId), eq(movimentacao.ativo, true)))
    .limit(1);
  if (!movOrigem) throw new Error(`Comodato ${input.movimentacaoOrigemId} não encontrado`);
  if (movOrigem.subtipo !== 'comodato' || movOrigem.tipoMovimento !== 'saida_manual') {
    throw new Error('Movimentação origem não é um comodato valido');
  }
  if (movOrigem.empresa !== 'q2p') {
    throw new Error('Comodato origem deve ser Q2P (regra de negocio)');
  }
  if (!movOrigem.produtoCodigoAcxe || !movOrigem.galpao) {
    throw new Error('Comodato origem sem SKU/galpão — registro inconsistente');
  }

  // Verifica se ja existe retorno
  const [existeRetorno] = await db
    .select({ id: movimentacao.id })
    .from(movimentacao)
    .where(
      and(
        eq(movimentacao.movimentacaoOrigemId, movOrigem.id),
        eq(movimentacao.subtipo, 'retorno_comodato' as SubtipoMovimento),
        eq(movimentacao.ativo, true),
      ),
    )
    .limit(1);
  if (existeRetorno) throw new Error('Comodato já foi retornado');

  const qtdOriginalKg = Math.abs(Number(movOrigem.quantidadeKg));
  const qtdRecebidaKg = Number(new Decimal(input.quantidadeKgRecebida).toFixed(3));
  const skuMudou = input.produtoCodigoAcxeRecebido !== movOrigem.produtoCodigoAcxe;
  const qtdMudou = qtdRecebidaKg !== qtdOriginalKg;

  // Texto humano-amigavel pra observacao OMIE — UUID interno fica em
  // movimentacao_origem_id (rastreio), nao precisa poluir o campo de observacao.
  const clienteOrigem = extrairClienteDaObservacao(movOrigem.observacoes);
  const dtSaidaOrigem = new Date(movOrigem.createdAt).toLocaleDateString('pt-BR');
  const cabecalhoObs = `Retorno comodato${clienteOrigem ? ` cliente ${clienteOrigem}` : ''} (saída ${dtSaidaOrigem}, ${qtdOriginalKg} kg)`;

  const resultado = await db.transaction(async (tx) => {
    // 1) Baixa do TROCA — SKU original × qtd ORIGINAL (devolve o que saiu)
    const [movBaixa] = await tx
      .insert(movimentacao)
      .values({
        notaFiscal: `RET-BAIXA-${movOrigem.id.slice(0, 8)}-${Date.now()}`,
        tipoMovimento: 'ajuste',
        subtipo: 'retorno_comodato' as SubtipoMovimento,
        loteId: null,
        produtoCodigoAcxe: movOrigem.produtoCodigoAcxe,
        galpao: '90', // TROCA = 90.0.1
        empresa: 'q2p',
        criadoPor: input.userId,
        movimentacaoOrigemId: movOrigem.id,
        quantidadeKg: String(-qtdOriginalKg),
        observacoes: `${cabecalhoObs} — baixa TROCA. ${input.observacoes}`,
        statusOmie: 'pendente_q2p',
      })
      .returning();

    // 2) Entrada no destino — SKU recebido × qtd recebida
    const [movEntrada] = await tx
      .insert(movimentacao)
      .values({
        notaFiscal: `RET-ENT-${movOrigem.id.slice(0, 8)}-${Date.now()}`,
        tipoMovimento: 'entrada_manual',
        subtipo: 'retorno_comodato' as SubtipoMovimento,
        loteId: null,
        produtoCodigoAcxe: input.produtoCodigoAcxeRecebido,
        galpao: input.galpaoDestino,
        empresa: 'q2p',
        criadoPor: input.userId,
        movimentacaoOrigemId: movOrigem.id,
        quantidadeKg: String(qtdRecebidaKg),
        observacoes: `${cabecalhoObs} — entrada destino. ${input.observacoes}`,
        statusOmie: 'pendente_q2p',
      })
      .returning();

    // 3) Aprovacao gestor cobrindo a operacao toda (linkada a movEntrada por padrao)
    const [apr] = await tx
      .insert(aprovacao)
      .values({
        loteId: null,
        produtoCodigoAcxe: input.produtoCodigoAcxeRecebido,
        galpao: input.galpaoDestino,
        empresa: 'q2p',
        movimentacaoId: movEntrada!.id,
        precisaNivel: 'gestor',
        tipoAprovacao: 'retorno_comodato',
        quantidadeRecebidaKg: String(qtdRecebidaKg),
        observacoes: `${cabecalhoObs}. ${input.observacoes}`,
        lancadoPor: input.userId,
      })
      .returning();

    // 4) Divergencia se SKU/qtd diferentes do comodato original
    let divId: string | undefined;
    if (skuMudou || qtdMudou) {
      const tipoDiv: 'faltando' | 'varredura' = qtdRecebidaKg < qtdOriginalKg ? 'faltando' : 'varredura';
      const detalhes = [
        skuMudou ? `SKU mudou: ${movOrigem.produtoCodigoAcxe} -> ${input.produtoCodigoAcxeRecebido}` : null,
        qtdMudou ? `Qtd mudou: ${qtdOriginalKg} kg -> ${qtdRecebidaKg} kg (delta=${(qtdRecebidaKg - qtdOriginalKg).toFixed(3)})` : null,
      ].filter(Boolean).join('; ');
      const [div] = await tx
        .insert(divergencia)
        .values({
          loteId: null,
          movimentacaoId: movEntrada!.id,
          tipo: tipoDiv,
          quantidadeDeltaKg: String(qtdRecebidaKg - qtdOriginalKg),
          status: 'aberta',
          observacoes: `Retorno comodato divergente — ${detalhes}. Operador justificar caso a caso.`,
        })
        .returning();
      divId = div!.id;
    }

    return {
      movimentacaoBaixaId: movBaixa!.id,
      movimentacaoEntradaId: movEntrada!.id,
      aprovacaoId: apr!.id,
      divergenciaId: divId,
    };
  });

  // EML-05: descrição real do produto recebido no lugar do SKU cru.
  const descricaoRecebido = await resolverDescricaoProdutoAcxe(db, input.produtoCodigoAcxeRecebido);
  void enviarAlertaAprovacaoPendente({
    aprovacaoId: resultado.aprovacaoId,
    tipoAprovacao: 'retorno_comodato',
    nivel: 'gestor',
    loteCodigo: `Retorno comodato ${movOrigem.id.slice(0, 8)}`,
    produto: descricaoRecebido,
    quantidadeKg: qtdRecebidaKg,
    detalhes: `Retorno de comodato — ${input.observacoes}${skuMudou || qtdMudou ? ' [DIVERGENTE]' : ''}`,
  }).catch((err) => logger.error({ err }, 'Falha ao notificar retorno comodato'));

  logger.info(
    {
      movimentacaoOrigemId: input.movimentacaoOrigemId,
      movimentacaoBaixaId: resultado.movimentacaoBaixaId,
      movimentacaoEntradaId: resultado.movimentacaoEntradaId,
      skuMudou,
      qtdMudou,
    },
    'Retorno de comodato registrado',
  );

  return resultado;
}
