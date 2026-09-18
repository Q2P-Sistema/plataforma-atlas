import { and, desc, eq } from 'drizzle-orm';
import { getDb, getPool, getConfig, createLogger } from '@atlas/core';
import { aprovacao } from '@atlas/db';
import { getDetalheNfNacional, type DetalheNfNacional } from './fila-nacional.service.js';
import { normalizarDescricaoNf } from './descricao-nf.js';
import { enviarAlertaRecebimentoNacionalLote } from './notificacao.service.js';
import type { Perfil } from '../types.js';

const logger = createLogger('stockbridge:recebimento-externo');

/**
 * Recebimento EXTERNO (feature 015, Historia 6 — research D22).
 *
 * O item de uma NF nacional entrou no estoque por FORA do Atlas (tipicamente
 * recebimento feito direto no OMIE por necessidade operacional, ou pelo
 * formulario manual com um numero que a checagem de "ja recebida" nao
 * reconhece — ~10% dos casos, D21). O operador declara isso com motivo, o
 * gestor aprova, e o item sai da fila.
 *
 * NUNCA cria movimentacao, NUNCA altera estoque, NUNCA chama o OMIE. O unico
 * efeito e a aprovacao em stockbridge.aprovacao com tipo 'recebimento_externo'
 * (sem lote, sem produto, sem galpao — identificada pela chave da NF; ver
 * relaxamento de aprovacao_chk_lote_ou_sku na migration 0052).
 *
 * E reconhecidamente um RISCO permanente (tira trabalho da fila sem contra-
 * partida em estoque) — por isso: aprovacao de gestor, trilha em audit_log,
 * reversao pelo gestor, e a flag STOCKBRIDGE_RECEBIMENTO_EXTERNO_ENABLED para
 * desligar quando o modulo estiver validado, sem migration.
 */

export class RecebimentoExternoDesabilitadoError extends Error {
  constructor() {
    super('A baixa por recebimento externo está desligada neste ambiente.');
    this.name = 'RecebimentoExternoDesabilitadoError';
  }
}

export class MotivoObrigatorioError extends Error {
  constructor() {
    super('Informe o motivo da baixa: onde e como este item foi recebido fora do Atlas.');
    this.name = 'MotivoObrigatorioError';
  }
}

export class ItemJaRecebidoError extends Error {
  constructor(public readonly descricaoItem: string) {
    super(`"${descricaoItem.trim()}" já tem recebimento registrado no Atlas — não cabe baixa externa.`);
    this.name = 'ItemJaRecebidoError';
  }
}

export class ItemNaoCorrespondeError extends Error {
  constructor(public readonly descricaoItem: string, public readonly notaFiscal: string) {
    super(`O item "${descricaoItem.trim()}" não corresponde a nenhuma linha da NF ${notaFiscal}. Recarregue a nota e tente de novo.`);
    this.name = 'ItemNaoCorrespondeError';
  }
}

export class NenhumItemPendenteError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`A NF ${notaFiscal} não tem item pendente para baixar.`);
    this.name = 'NenhumItemPendenteError';
  }
}

export class RecebimentoExternoNaoEncontradoError extends Error {
  constructor(public readonly id: string) {
    super('Baixa externa não encontrada.');
    this.name = 'RecebimentoExternoNaoEncontradoError';
  }
}

export function recebimentoExternoHabilitado(): boolean {
  const cfg = getConfig() as { STOCKBRIDGE_RECEBIMENTO_EXTERNO_ENABLED?: boolean };
  return cfg.STOCKBRIDGE_RECEBIMENTO_EXTERNO_ENABLED !== false;
}

export interface SolicitarRecebimentoExternoInput {
  nfChaveAcesso: string;
  motivo: string;
  /** Itens da NF (indice + descricao). Vazio/ausente = TODOS os itens pendentes. */
  itens?: Array<{ indice: number; descricaoFornecedor: string }> | null;
  userId: string;
}

export interface SolicitarRecebimentoExternoResult {
  notaFiscal: string;
  aprovacoesCriadas: number;
  /** solicitacoes que ja existiam pendentes para o mesmo item — nao duplicadas */
  jaSolicitados: number;
  status: 'pendente_aprovacao';
  aprovacaoIds: string[];
}

/**
 * Cria UMA aprovacao 'recebimento_externo' por item da NF (granularidade por
 * item/descricao — o item da fila nao tem produto, D22). Idempotente: item
 * que ja tem solicitacao pendente nao ganha outra.
 */
export async function solicitarRecebimentoExterno(input: SolicitarRecebimentoExternoInput): Promise<SolicitarRecebimentoExternoResult> {
  if (!recebimentoExternoHabilitado()) throw new RecebimentoExternoDesabilitadoError();
  const motivo = input.motivo?.trim() ?? '';
  if (motivo.length === 0) throw new MotivoObrigatorioError();

  const detalhe: DetalheNfNacional = await getDetalheNfNacional(input.nfChaveAcesso);

  const pendentes = detalhe.itens.filter((it) => !(it.jaRecebido && (it.quantidadeNfJaAtribuidaKg === 0 || (it.quantidadeRestanteKg ?? 0) <= 1)) && !it.baixadoComoExterno);
  let alvos = pendentes;
  if (input.itens && input.itens.length > 0) {
    alvos = [];
    for (const pedido of input.itens) {
      const it = detalhe.itens.find(
        (d) => d.indice === pedido.indice && d.descricaoNormalizada === normalizarDescricaoNf(pedido.descricaoFornecedor),
      );
      if (!it) throw new ItemNaoCorrespondeError(pedido.descricaoFornecedor, detalhe.notaFiscal);
      if (it.jaRecebido && (it.quantidadeNfJaAtribuidaKg === 0 || (it.quantidadeRestanteKg ?? 0) <= 1)) throw new ItemJaRecebidoError(it.descricaoFornecedor);
      if (it.baixadoComoExterno) throw new ItemJaRecebidoError(it.descricaoFornecedor);
      alvos.push(it);
    }
  }
  if (alvos.length === 0) throw new NenhumItemPendenteError(detalhe.notaFiscal);

  const db = getDb();
  const pool = getPool();
  const criados: string[] = [];
  let jaSolicitados = 0;

  for (const it of alvos) {
    // Idempotencia: uma solicitacao pendente por (chave, descricao normalizada).
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM stockbridge.aprovacao
        WHERE tipo_aprovacao = 'recebimento_externo' AND status = 'pendente'
          AND nf_chave_acesso = $1
          AND upper(regexp_replace(btrim(unaccent(nf_item_descricao)), '\\s+', ' ', 'g')) = $2
        LIMIT 1`,
      [detalhe.nfChaveAcesso, it.descricaoNormalizada],
    );
    if (rows.length > 0) {
      jaSolicitados++;
      continue;
    }
    const [apr] = await db
      .insert(aprovacao)
      .values({
        loteId: null,
        movimentacaoId: null,
        produtoCodigoAcxe: null,
        produtoCodigoQ2p: null,
        galpao: null,
        empresa: 'q2p',
        precisaNivel: 'gestor',
        tipoAprovacao: 'recebimento_externo',
        quantidadePrevistaKg: it.quantidadeNfKg != null ? String(it.quantidadeNfKg) : null,
        quantidadeRecebidaKg: null,
        observacoes: `Recebimento externo · ${motivo}`,
        lancadoPor: input.userId,
        nfChaveAcesso: detalhe.nfChaveAcesso,
        notaFiscal: detalhe.notaFiscal,
        nfItemDescricao: it.descricaoFornecedor,
      })
      .returning();
    criados.push(apr!.id);
  }

  if (criados.length > 0) {
    void enviarAlertaRecebimentoNacionalLote({
      notaFiscal: detalhe.notaFiscal,
      nivel: 'gestor',
      itens: alvos
        .filter((it) => !it.baixadoComoExterno)
        .map((it) => ({ produto: `${it.descricaoFornecedor.trim()} (baixa externa)`, empresa: 'q2p', galpao: '—', quantidadeKg: it.quantidadeNfKg ?? 0 })),
      detalhes: `Baixa por recebimento externo — ${motivo}`,
    }).catch((err) => logger.error({ err, nf: detalhe.notaFiscal }, 'Falha ao notificar gestor (recebimento externo)'));
  }

  logger.info({ nf: detalhe.notaFiscal, criados: criados.length, jaSolicitados, userId: input.userId }, 'Recebimento externo solicitado');
  return { notaFiscal: detalhe.notaFiscal, aprovacoesCriadas: criados.length, jaSolicitados, status: 'pendente_aprovacao', aprovacaoIds: criados };
}

export interface BaixaExternaItem {
  id: string;
  nfChaveAcesso: string;
  notaFiscal: string;
  nfItemDescricao: string;
  quantidadeNfKg: number | null;
  motivo: string | null;
  lancadoPor: string;
  lancadoEm: string;
  aprovadoPor: string | null;
  aprovadoEm: string | null;
}

/** Baixas externas APROVADAS (as que tiraram item da fila) — para o gestor ver e, se preciso, reverter. */
export async function listarBaixasExternasAprovadas(limit = 200): Promise<BaixaExternaItem[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(aprovacao)
    .where(and(eq(aprovacao.tipoAprovacao, 'recebimento_externo'), eq(aprovacao.status, 'aprovada')))
    .orderBy(desc(aprovacao.aprovadoEm))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    nfChaveAcesso: r.nfChaveAcesso ?? '',
    notaFiscal: r.notaFiscal ?? '',
    nfItemDescricao: r.nfItemDescricao ?? '',
    quantidadeNfKg: r.quantidadePrevistaKg != null ? Number(r.quantidadePrevistaKg) : null,
    motivo: r.observacoes,
    lancadoPor: r.lancadoPor,
    lancadoEm: r.lancadoEm.toISOString(),
    aprovadoPor: r.aprovadoPor,
    aprovadoEm: r.aprovadoEm ? r.aprovadoEm.toISOString() : null,
  }));
}

/**
 * Reverte uma baixa externa APROVADA (FR-031): a aprovacao passa a 'rejeitada'
 * com o motivo prefixado "Reversão:", e o item VOLTA a fila — so 'aprovada'
 * o retira. Nao volta a 'pendente' porque isso recolocaria uma solicitacao na
 * caixa do gestor; o que aconteceu foi a baixa ser desfeita, e e isso que o
 * registro deve dizer. Auditado pela trigger de aprovacao.
 */
export async function reverterRecebimentoExterno(input: {
  id: string;
  usuarioId: string;
  perfilUsuario: Perfil;
  motivo: string;
}): Promise<{ id: string; notaFiscal: string; nfItemDescricao: string }> {
  if (input.perfilUsuario !== 'gestor' && input.perfilUsuario !== 'diretor') {
    throw new Error('Somente gestor ou diretor pode reverter uma baixa externa.');
  }
  const motivo = input.motivo?.trim() ?? '';
  if (motivo.length === 0) throw new MotivoObrigatorioError();

  const db = getDb();
  const [ap] = await db
    .update(aprovacao)
    .set({
      status: 'rejeitada',
      rejeicaoMotivo: `Reversão: ${motivo}`,
      aprovadoPor: input.usuarioId,
      aprovadoEm: new Date(),
    })
    .where(and(eq(aprovacao.id, input.id), eq(aprovacao.tipoAprovacao, 'recebimento_externo'), eq(aprovacao.status, 'aprovada')))
    .returning();
  if (!ap) throw new RecebimentoExternoNaoEncontradoError(input.id);

  logger.info({ aprovacaoId: ap.id, nf: ap.notaFiscal, usuarioId: input.usuarioId }, 'Baixa externa revertida — item devolvido à fila');
  return { id: ap.id, notaFiscal: ap.notaFiscal ?? '', nfItemDescricao: ap.nfItemDescricao ?? '' };
}
