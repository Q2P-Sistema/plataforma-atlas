import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { aprovacao, lote } from '@atlas/db';
import type { Perfil, TipoAprovacao } from '../types.js';
import { NIVEL_APROVACAO_POR_SUBTIPO } from '../types.js';

const logger = createLogger('stockbridge:aprovacao');

export class AprovacaoNaoEncontradaError extends Error {
  constructor(public readonly id: string) {
    super(`Aprovacao ${id} nao encontrada ou ja finalizada`);
    this.name = 'AprovacaoNaoEncontradaError';
  }
}

export class AprovacaoNivelInsuficienteError extends Error {
  constructor(
    public readonly perfilUsuario: Perfil,
    public readonly nivelRequerido: 'gestor' | 'diretor',
  ) {
    super(`Perfil ${perfilUsuario} nao pode aprovar pendencia que exige ${nivelRequerido}`);
    this.name = 'AprovacaoNivelInsuficienteError';
  }
}

export class AprovacaoStatusInvalidoError extends Error {
  constructor(public readonly id: string, public readonly statusAtual: string) {
    super(`Aprovacao ${id} ja foi ${statusAtual} — nao e possivel alterar`);
    this.name = 'AprovacaoStatusInvalidoError';
  }
}

export interface PendenciaItem {
  id: string;
  loteId: string;
  loteCodigo: string;
  tipoAprovacao: TipoAprovacao;
  precisaNivel: 'gestor' | 'diretor';
  quantidadePrevistaT: number | null;
  quantidadeRecebidaT: number | null;
  deltaT: number | null;
  tipoDivergencia: string | null;
  observacoes: string | null;
  lancadoPor: { id: string; nome: string };
  lancadoEm: string;
  produto: { codigoAcxe: number; fornecedor: string };
}

/**
 * Lista pendencias de aprovacao acessiveis ao perfil do usuario.
 *  - Gestor ve apenas pendencias `precisa_nivel = gestor`
 *  - Diretor ve ambas (gestor + diretor)
 */
export async function listarPendencias(perfil: Perfil): Promise<PendenciaItem[]> {
  if (perfil === 'operador') {
    return [];
  }
  const db = getDb();
  const niveisAcessiveis: Array<'gestor' | 'diretor'> = perfil === 'diretor' ? ['gestor', 'diretor'] : ['gestor'];

  const rows = await db
    .select({
      id: aprovacao.id,
      loteId: aprovacao.loteId,
      tipoAprovacao: aprovacao.tipoAprovacao,
      precisaNivel: aprovacao.precisaNivel,
      quantidadePrevistaT: aprovacao.quantidadePrevistaT,
      quantidadeRecebidaT: aprovacao.quantidadeRecebidaT,
      tipoDivergencia: aprovacao.tipoDivergencia,
      observacoes: aprovacao.observacoes,
      lancadoPor: aprovacao.lancadoPor,
      lancadoEm: aprovacao.lancadoEm,
      loteCodigo: lote.codigo,
      produtoCodigoAcxe: lote.produtoCodigoAcxe,
      fornecedor: lote.fornecedorNome,
    })
    .from(aprovacao)
    .innerJoin(lote, eq(lote.id, aprovacao.loteId))
    .where(and(eq(aprovacao.status, 'pendente'), inArray(aprovacao.precisaNivel, niveisAcessiveis)))
    .orderBy(desc(aprovacao.lancadoEm));

  // Busca nomes dos usuarios em batch (evita N+1)
  const userIds = [...new Set(rows.map((r) => r.lancadoPor))];
  const userMap = new Map<string, string>();
  if (userIds.length > 0) {
    const userRows = await db.execute<{ id: string; name: string }>(
      sql`SELECT id, name FROM atlas.users WHERE id = ANY(${userIds})`,
    );
    for (const u of userRows.rows) userMap.set(String(u.id), String(u.name));
  }

  return rows.map((r) => {
    const previsto = r.quantidadePrevistaT != null ? Number(r.quantidadePrevistaT) : null;
    const recebido = r.quantidadeRecebidaT != null ? Number(r.quantidadeRecebidaT) : null;
    const delta = previsto != null && recebido != null ? Number((recebido - previsto).toFixed(3)) : null;
    return {
      id: r.id,
      loteId: r.loteId,
      loteCodigo: r.loteCodigo,
      tipoAprovacao: r.tipoAprovacao,
      precisaNivel: r.precisaNivel,
      quantidadePrevistaT: previsto,
      quantidadeRecebidaT: recebido,
      deltaT: delta,
      tipoDivergencia: r.tipoDivergencia,
      observacoes: r.observacoes,
      lancadoPor: { id: r.lancadoPor, nome: userMap.get(r.lancadoPor) ?? 'desconhecido' },
      lancadoEm: r.lancadoEm.toISOString(),
      produto: { codigoAcxe: r.produtoCodigoAcxe, fornecedor: r.fornecedor },
    };
  });
}

export interface AprovarInput {
  id: string;
  usuarioId: string;
  perfilUsuario: Perfil;
}

/**
 * Aprova uma pendencia:
 *  - Marca aprovacao como `aprovada`
 *  - Atualiza lote para `provisorio` (quando recebimento_divergencia) ou mantem conforme semantica
 *  - Valida nivel de autoridade (diretor aprova tudo; gestor nao aprova pendencia de nivel diretor)
 *  - Bloqueia se ja foi aprovada/rejeitada
 */
export async function aprovar(input: AprovarInput): Promise<{ id: string; loteStatus: string }> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [ap] = await tx.select().from(aprovacao).where(eq(aprovacao.id, input.id)).limit(1);
    if (!ap) throw new AprovacaoNaoEncontradaError(input.id);
    if (ap.status !== 'pendente') throw new AprovacaoStatusInvalidoError(input.id, ap.status);
    checarNivel(input.perfilUsuario, ap.precisaNivel);

    await tx
      .update(aprovacao)
      .set({
        status: 'aprovada',
        aprovadoPor: input.usuarioId,
        aprovadoEm: new Date(),
      })
      .where(eq(aprovacao.id, input.id));

    // Regra: aprovacoes do tipo recebimento_divergencia e entrada_manual promovem o lote a provisorio
    const statusLote =
      ap.tipoAprovacao === 'recebimento_divergencia' || ap.tipoAprovacao === 'entrada_manual'
        ? 'provisorio'
        : 'reconciliado';

    await tx.update(lote).set({ status: statusLote, updatedAt: new Date() }).where(eq(lote.id, ap.loteId));

    logger.info({ aprovacaoId: input.id, perfilUsuario: input.perfilUsuario, loteStatus: statusLote }, 'Aprovacao confirmada');
    return { id: input.id, loteStatus: statusLote };
  });
}

export interface RejeitarInput {
  id: string;
  usuarioId: string;
  perfilUsuario: Perfil;
  motivo: string;
}

export async function rejeitar(input: RejeitarInput): Promise<{ id: string }> {
  if (!input.motivo || input.motivo.trim().length === 0) {
    throw new Error('Motivo obrigatorio para rejeitar aprovacao');
  }
  const db = getDb();
  return db.transaction(async (tx) => {
    const [ap] = await tx.select().from(aprovacao).where(eq(aprovacao.id, input.id)).limit(1);
    if (!ap) throw new AprovacaoNaoEncontradaError(input.id);
    if (ap.status !== 'pendente') throw new AprovacaoStatusInvalidoError(input.id, ap.status);
    checarNivel(input.perfilUsuario, ap.precisaNivel);

    await tx
      .update(aprovacao)
      .set({
        status: 'rejeitada',
        aprovadoPor: input.usuarioId,
        aprovadoEm: new Date(),
        rejeicaoMotivo: input.motivo,
      })
      .where(eq(aprovacao.id, input.id));

    await tx.update(lote).set({ status: 'rejeitado', updatedAt: new Date() }).where(eq(lote.id, ap.loteId));

    logger.info({ aprovacaoId: input.id, perfilUsuario: input.perfilUsuario }, 'Aprovacao rejeitada');
    return { id: input.id };
  });
}

export interface ResubmeterInput {
  id: string;
  usuarioId: string;
  quantidadeRecebidaT: number;
  observacoes: string;
}

/**
 * Re-submete uma aprovacao rejeitada (clarificacao Q7):
 *   - Qualquer operador do armazem do lote pode re-submeter
 *   - Atualiza quantidade + motivo + recoloca em status pendente
 *   - O lote volta para aguardando_aprovacao
 *
 * NOTA: cria uma NOVA linha de aprovacao (mantem a rejeitada para auditoria)
 * ao inves de alterar a existente — trail de audit preservado.
 */
export async function resubmeter(input: ResubmeterInput): Promise<{ id: string; novaAprovacaoId: string }> {
  if (!input.observacoes || input.observacoes.trim().length === 0) {
    throw new Error('Motivo obrigatorio ao re-submeter aprovacao rejeitada');
  }
  const db = getDb();
  return db.transaction(async (tx) => {
    const [ap] = await tx.select().from(aprovacao).where(eq(aprovacao.id, input.id)).limit(1);
    if (!ap) throw new AprovacaoNaoEncontradaError(input.id);
    if (ap.status !== 'rejeitada') {
      throw new AprovacaoStatusInvalidoError(input.id, ap.status);
    }

    const [nova] = await tx
      .insert(aprovacao)
      .values({
        loteId: ap.loteId,
        precisaNivel: ap.precisaNivel,
        tipoAprovacao: ap.tipoAprovacao,
        quantidadePrevistaT: ap.quantidadePrevistaT,
        quantidadeRecebidaT: String(input.quantidadeRecebidaT),
        tipoDivergencia: ap.tipoDivergencia,
        observacoes: input.observacoes,
        lancadoPor: input.usuarioId,
      })
      .returning();

    await tx
      .update(lote)
      .set({
        status: 'aguardando_aprovacao',
        quantidadeFisica: String(input.quantidadeRecebidaT),
        updatedAt: new Date(),
      })
      .where(eq(lote.id, ap.loteId));

    logger.info(
      { aprovacaoRejeitadaId: input.id, novaAprovacaoId: nova!.id, usuarioId: input.usuarioId },
      'Aprovacao re-submetida',
    );
    return { id: input.id, novaAprovacaoId: nova!.id };
  });
}

function checarNivel(perfil: Perfil, nivelRequerido: 'gestor' | 'diretor'): void {
  if (nivelRequerido === 'diretor' && perfil !== 'diretor') {
    throw new AprovacaoNivelInsuficienteError(perfil, nivelRequerido);
  }
  if (nivelRequerido === 'gestor' && perfil === 'operador') {
    throw new AprovacaoNivelInsuficienteError(perfil, nivelRequerido);
  }
}

/**
 * Helper usado por outras phases (saidas manuais US6, entrada manual, etc.):
 * retorna o nivel de aprovacao exigido para um subtipo de movimento.
 * Default: gestor, quando nao mapeado.
 */
export function inferirNivelAprovacao(subtipo: string): 'gestor' | 'diretor' {
  return NIVEL_APROVACAO_POR_SUBTIPO[subtipo as keyof typeof NIVEL_APROVACAO_POR_SUBTIPO] ?? 'gestor';
}
