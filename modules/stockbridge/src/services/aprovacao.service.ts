import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { aprovacao, lote, movimentacao, localidadeCorrelacao } from '@atlas/db';
import type { Perfil, TipoAprovacao } from '../types.js';
import { NIVEL_APROVACAO_POR_SUBTIPO } from '../types.js';
import { executarAjusteOmieDual } from './recebimento.service.js';
import {
  enviarNotificacaoRejeicaoOperador,
  enviarNotificacaoAprovacaoOperador,
} from './notificacao.service.js';

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
  quantidadePrevistaKg: number | null;
  quantidadeRecebidaKg: number | null;
  deltaKg: number | null;
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
      quantidadePrevistaKg: aprovacao.quantidadePrevistaKg,
      quantidadeRecebidaKg: aprovacao.quantidadeRecebidaKg,
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
    const previsto = r.quantidadePrevistaKg != null ? Number(r.quantidadePrevistaKg) : null;
    const recebido = r.quantidadeRecebidaKg != null ? Number(r.quantidadeRecebidaKg) : null;
    const delta = previsto != null && recebido != null ? Number((recebido - previsto).toFixed(3)) : null;
    return {
      id: r.id,
      loteId: r.loteId,
      loteCodigo: r.loteCodigo,
      tipoAprovacao: r.tipoAprovacao,
      precisaNivel: r.precisaNivel,
      quantidadePrevistaKg: previsto,
      quantidadeRecebidaKg: recebido,
      deltaKg: delta,
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
 *  - Para `recebimento_divergencia`: chama OMIE ACXE + Q2P com a quantidade aprovada
 *    e grava a movimentacao dual-CNPJ (mesmo fluxo do recebimento sem divergencia).
 *  - Atualiza lote para `provisorio` / `reconciliado` conforme o tipo
 *  - Valida nivel de autoridade (diretor aprova tudo; gestor nao aprova pendencia de nivel diretor)
 *  - Bloqueia se ja foi aprovada/rejeitada
 *  - Notifica operador que lancou via email (fora da transacao)
 */
export async function aprovar(input: AprovarInput): Promise<{ id: string; loteStatus: string }> {
  const db = getDb();

  // Pre-check fora da transacao (evita abrir tx so pra abortar)
  const [apPre] = await db.select().from(aprovacao).where(eq(aprovacao.id, input.id)).limit(1);
  if (!apPre) throw new AprovacaoNaoEncontradaError(input.id);
  if (apPre.status !== 'pendente') throw new AprovacaoStatusInvalidoError(input.id, apPre.status);
  checarNivel(input.perfilUsuario, apPre.precisaNivel);

  // Para recebimento_divergencia precisamos chamar OMIE ANTES de commitar o update.
  // Se OMIE falhar, nada no PG muda.
  let omieIds: Awaited<ReturnType<typeof executarAjusteOmieDual>> | null = null;
  if (apPre.tipoAprovacao === 'recebimento_divergencia') {
    const [loteRow] = await db.select().from(lote).where(eq(lote.id, apPre.loteId)).limit(1);
    if (!loteRow) throw new Error(`Lote ${apPre.loteId} nao encontrado ao aprovar divergencia`);
    if (!loteRow.produtoCodigoQ2p) {
      throw new Error(`Lote ${loteRow.codigo} sem correlato Q2P — nao e possivel ajustar OMIE`);
    }
    if (!loteRow.localidadeId) {
      throw new Error(`Lote ${loteRow.codigo} sem localidade destino — nao e possivel ajustar OMIE`);
    }
    const [corr] = await db
      .select()
      .from(localidadeCorrelacao)
      .where(eq(localidadeCorrelacao.localidadeId, loteRow.localidadeId))
      .limit(1);
    if (!corr?.codigoLocalEstoqueAcxe || !corr?.codigoLocalEstoqueQ2p) {
      throw new Error(`Localidade do lote ${loteRow.codigo} sem correlacao ACXE/Q2P completa`);
    }
    const qtdAprovadaKg = Number(apPre.quantidadeRecebidaKg ?? loteRow.quantidadeFisicaKg);
    const valorUnit = Number(loteRow.custoUsdTon ?? 0);

    omieIds = await executarAjusteOmieDual({
      codigoLocalEstoqueAcxe: corr.codigoLocalEstoqueAcxe,
      codigoLocalEstoqueQ2p: corr.codigoLocalEstoqueQ2p,
      codigoProdutoAcxe: Number(loteRow.produtoCodigoAcxe),
      codigoProdutoQ2p: Number(loteRow.produtoCodigoQ2p),
      quantidadeKg: qtdAprovadaKg,
      valorUnitario: valorUnit,
      notaFiscal: loteRow.notaFiscal ?? apPre.loteId,
      observacaoSufixo: `com divergencia aprovada por gestor (${apPre.tipoDivergencia ?? 'n/a'})`,
    });
  }

  // Transacao: update aprovacao + lote (+ grava movimentacao se OMIE foi chamado)
  const resultado = await db.transaction(async (tx) => {
    // Re-ler dentro da tx para evitar race com rejeicao concorrente
    const [ap] = await tx.select().from(aprovacao).where(eq(aprovacao.id, input.id)).limit(1);
    if (!ap) throw new AprovacaoNaoEncontradaError(input.id);
    if (ap.status !== 'pendente') throw new AprovacaoStatusInvalidoError(input.id, ap.status);

    await tx
      .update(aprovacao)
      .set({
        status: 'aprovada',
        aprovadoPor: input.usuarioId,
        aprovadoEm: new Date(),
      })
      .where(eq(aprovacao.id, input.id));

    const statusLote =
      ap.tipoAprovacao === 'recebimento_divergencia' || ap.tipoAprovacao === 'entrada_manual'
        ? 'provisorio'
        : 'reconciliado';

    await tx.update(lote).set({ status: statusLote, updatedAt: new Date() }).where(eq(lote.id, ap.loteId));

    if (omieIds && ap.tipoAprovacao === 'recebimento_divergencia') {
      const [loteRow] = await tx.select().from(lote).where(eq(lote.id, ap.loteId)).limit(1);
      await tx.insert(movimentacao).values({
        notaFiscal: loteRow!.notaFiscal ?? `APR-${ap.id}`,
        tipoMovimento: 'entrada_nf',
        subtipo: 'importacao',
        loteId: ap.loteId,
        quantidadeKg: String(Number(ap.quantidadeRecebidaKg ?? loteRow!.quantidadeFisicaKg)),
        mvAcxe: 1,
        dtAcxe: new Date(),
        idMovestAcxe: omieIds.idACXE.idMovest,
        idAjusteAcxe: omieIds.idACXE.idAjuste,
        idUserAcxe: input.usuarioId,
        mvQ2p: 1,
        dtQ2p: new Date(),
        idMovestQ2p: omieIds.idQ2P.idMovest,
        idAjusteQ2p: omieIds.idQ2P.idAjuste,
        idUserQ2p: input.usuarioId,
        observacoes: `Aprovada divergencia ${ap.tipoDivergencia ?? ''} — qtd final ${ap.quantidadeRecebidaKg ?? loteRow!.quantidadeFisicaKg} kg`,
      });
    }

    return { statusLote, loteId: ap.loteId, operadorId: ap.lancadoPor, tipoAprovacao: ap.tipoAprovacao };
  });

  logger.info(
    { aprovacaoId: input.id, perfilUsuario: input.perfilUsuario, loteStatus: resultado.statusLote, omieIds },
    'Aprovacao confirmada',
  );

  // Notifica operador fora da transacao (email nao bloqueia)
  await enviarNotificacaoAprovacaoOperador({
    operadorUserId: resultado.operadorId,
    aprovacaoId: input.id,
    tipoAprovacao: resultado.tipoAprovacao,
    loteId: resultado.loteId,
  });

  return { id: input.id, loteStatus: resultado.statusLote };
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

  const resultado = await db.transaction(async (tx) => {
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

    return { operadorId: ap.lancadoPor, loteId: ap.loteId };
  });

  logger.info({ aprovacaoId: input.id, perfilUsuario: input.perfilUsuario }, 'Aprovacao rejeitada');

  // Notifica o operador que lancou a divergencia/saida (fora da transacao)
  await enviarNotificacaoRejeicaoOperador({
    operadorUserId: resultado.operadorId,
    aprovacaoId: input.id,
    loteId: resultado.loteId,
    motivo: input.motivo,
  });

  return { id: input.id };
}

export interface ResubmeterInput {
  id: string;
  usuarioId: string;
  quantidadeRecebidaKg: number;
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
        quantidadePrevistaKg: ap.quantidadePrevistaKg,
        quantidadeRecebidaKg: String(input.quantidadeRecebidaKg),
        tipoDivergencia: ap.tipoDivergencia,
        observacoes: input.observacoes,
        lancadoPor: input.usuarioId,
      })
      .returning();

    await tx
      .update(lote)
      .set({
        status: 'aguardando_aprovacao',
        quantidadeFisicaKg: String(input.quantidadeRecebidaKg),
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
