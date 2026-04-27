import { randomUUID } from 'node:crypto';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { aprovacao, lote, movimentacao, localidadeCorrelacao, users } from '@atlas/db';
import type { Perfil, TipoAprovacao } from '../types.js';
import { NIVEL_APROVACAO_POR_SUBTIPO } from '../types.js';
import {
  executarAjusteOmieDual,
  calcularValorUnitarioQ2p,
  calcularValorUnitarioAcxe,
  transferirDiferencaAcxe,
  OmieAjusteError,
} from './recebimento.service.js';
import {
  enviarNotificacaoRejeicaoOperador,
  enviarNotificacaoAprovacaoOperador,
  enviarAlertaAprovacaoPendente,
  enviarAlertaPendenciaOmie,
} from './notificacao.service.js';
import { resolverEstoqueDiferencaAcxe } from './estoques-especiais-acxe.js';

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
    const userRows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const u of userRows) userMap.set(u.id, u.name);
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

export interface MinhaRejeicaoItem {
  id: string;
  loteId: string;
  loteCodigo: string;
  tipoAprovacao: TipoAprovacao;
  motivoRejeicao: string;
  quantidadeRecebidaKg: number;
  produtoCodigoAcxe: number;
  fornecedor: string;
  lancadoEm: string;
  rejeitadoEm: string;
}

/**
 * Lista as aprovacoes rejeitadas que o operador (`userId`) lancou e que ele
 * tem direito de re-submeter.
 *
 * Filtra rejeicoes "superadas": se ja existe uma aprovacao mais recente para o
 * mesmo lote (criada pelo proprio resubmeter), a rejeicao antiga e omitida
 * — ela continua na tabela para auditoria, so nao aparece pro operador como
 * pendencia de acao.
 *
 * Ordena por mais recente primeiro.
 */
export async function listarMinhasRejeicoes(userId: string): Promise<MinhaRejeicaoItem[]> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    lote_id: string;
    tipo_aprovacao: string;
    quantidade_recebida_kg: string | null;
    rejeicao_motivo: string | null;
    // db.execute (raw sql) retorna timestamps como string ISO, nao Date.
    lancado_em: string;
    aprovado_em: string | null;
    codigo: string;
    produto_codigo_acxe: number;
    fornecedor_nome: string;
  }>(sql`
    SELECT a.id, a.lote_id, a.tipo_aprovacao, a.quantidade_recebida_kg,
           a.rejeicao_motivo, a.lancado_em, a.aprovado_em,
           l.codigo, l.produto_codigo_acxe, l.fornecedor_nome
    FROM stockbridge.aprovacao a
    INNER JOIN stockbridge.lote l ON l.id = a.lote_id
    WHERE a.status = 'rejeitada'
      AND a.lancado_por = ${userId}::uuid
      AND l.ativo = true
      AND NOT EXISTS (
        SELECT 1 FROM stockbridge.aprovacao a2
        WHERE a2.lote_id = a.lote_id
          AND a2.lancado_em > a.lancado_em
      )
    ORDER BY a.aprovado_em DESC NULLS LAST
  `);

  return rows.rows.map((r) => ({
    id: r.id,
    loteId: r.lote_id,
    loteCodigo: r.codigo,
    tipoAprovacao: r.tipo_aprovacao as TipoAprovacao,
    motivoRejeicao: r.rejeicao_motivo ?? '',
    quantidadeRecebidaKg: r.quantidade_recebida_kg != null ? Number(r.quantidade_recebida_kg) : 0,
    produtoCodigoAcxe: r.produto_codigo_acxe,
    fornecedor: r.fornecedor_nome,
    lancadoEm: new Date(r.lancado_em).toISOString(),
    rejeitadoEm: new Date(r.aprovado_em ?? r.lancado_em).toISOString(),
  }));
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
export interface AprovarResult {
  id: string;
  loteStatus: string;
  /**
   * Presente quando a aprovacao foi commitada mas OMIE deixou um lado pendente.
   * A aprovacao em si fica 'aprovada' (decisao do gestor nao retrocede), mas a
   * movimentacao gravada tem status_omie != 'concluida' e precisa de retry
   * via /operacoes-pendentes/:id/retentar.
   */
  pendenciaOmie?: {
    lado: 'q2p' | 'acxe-faltando';
    opId: string;
    movimentacaoId: string;
    mensagem: string;
  };
}

export async function aprovar(input: AprovarInput): Promise<AprovarResult> {
  const db = getDb();

  // Pre-check fora da transacao (evita abrir tx so pra abortar)
  const [apPre] = await db.select().from(aprovacao).where(eq(aprovacao.id, input.id)).limit(1);
  if (!apPre) throw new AprovacaoNaoEncontradaError(input.id);
  if (apPre.status !== 'pendente') throw new AprovacaoStatusInvalidoError(input.id, apPre.status);
  checarNivel(input.perfilUsuario, apPre.precisaNivel);

  // Para recebimento_divergencia precisamos chamar OMIE ANTES de commitar o update.
  // Se OMIE falhar, nada no PG muda — exceto quando recoverable (Q2P pos-ACXE ok ou
  // transferencia da diferenca pos-dual ok), caso em que persistimos movimentacao
  // parcial e seguimos com a aprovacao (decisao do gestor nao retrocede).
  // opId identifica esta aprovacao nas chamadas OMIE via cod_int_ajuste — habilita
  // retry idempotente sem duplicar ajustes (vide US2/US4).
  let omieIds: Awaited<ReturnType<typeof executarAjusteOmieDual>> | null = null;
  let opId: string | null = null;
  let pendencia: { tipo: 'pendente_q2p' | 'pendente_acxe_faltando'; mensagemErro: string } | null = null;
  let notaFiscalParaEmail = apPre.id;
  if (apPre.tipoAprovacao === 'recebimento_divergencia') {
    opId = randomUUID();
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
    if (!loteRow.notaFiscal) {
      throw new Error(`Lote ${loteRow.codigo} sem notaFiscal — nao e possivel ajustar OMIE`);
    }
    if (!loteRow.codigoLocalEstoqueOrigemAcxe || !loteRow.valorTotalNfBrl) {
      throw new Error(
        `Lote ${loteRow.codigo} sem dados da NF persistidos (origem ACXE / vNF). ` +
          'Lote criado em versao anterior — re-consulte OMIE manualmente ou re-submeta o recebimento.',
      );
    }
    notaFiscalParaEmail = loteRow.notaFiscal;
    const qtdNfKg = Number(loteRow.quantidadeFiscalKg);
    const vNF = Number(loteRow.valorTotalNfBrl);

    const valorUnitAcxe = calcularValorUnitarioAcxe(vNF, qtdNfKg);
    const motivoOperador = apPre.observacoes?.trim()
      ? `\nMotivo da divergencia: ${apPre.observacoes.trim()}`
      : '';

    try {
      omieIds = await executarAjusteOmieDual({
        opId,
        codigoLocalEstoqueAcxeOrigem: loteRow.codigoLocalEstoqueOrigemAcxe,
        codigoLocalEstoqueAcxeDestino: corr.codigoLocalEstoqueAcxe,
        codigoLocalEstoqueQ2p: corr.codigoLocalEstoqueQ2p,
        codigoProdutoAcxe: Number(loteRow.produtoCodigoAcxe),
        codigoProdutoQ2p: Number(loteRow.produtoCodigoQ2p),
        quantidadeKg: qtdAprovadaKg,
        valorUnitarioAcxe: valorUnitAcxe,
        valorUnitarioQ2p: calcularValorUnitarioQ2p(vNF, qtdNfKg),
        notaFiscal: loteRow.notaFiscal,
        observacaoSufixo: `com divergencia aprovada por gestor (${apPre.tipoDivergencia ?? 'n/a'})${motivoOperador}`,
      });
    } catch (err) {
      // Q2P falhou apos ACXE ok: persistiremos movimentacao parcial mas seguiremos
      // com a aprovacao (decisao do gestor nao retrocede por instabilidade OMIE).
      if (err instanceof OmieAjusteError && err.lado === 'q2p' && err.recoverable && err.idACXE) {
        omieIds = {
          idACXE: err.idACXE,
          idQ2P: { idMovest: '', idAjuste: '' }, // placeholder; nao sera persistido
        };
        pendencia = {
          tipo: 'pendente_q2p',
          mensagemErro: (err.originalError as Error)?.message ?? err.message,
        };
      } else {
        // ACXE falhou: estado limpo, propaga sem aprovar
        throw err;
      }
    }

    // 2a chamada ACXE: transfere a DIFERENCA (qtdNF - qtdRecebida) para estoque
    // especial (Faltando ou Varredura) — fiel ao legado (NotaFiscalService linhas
    // 198-272 e 383-460). Pulamos se ja temos pendencia Q2P (estado parcial pre-existente).
    const qtdDiferencaKg = Number((qtdNfKg - qtdAprovadaKg).toFixed(3));
    if (
      !pendencia &&
      qtdDiferencaKg > 0 &&
      (apPre.tipoDivergencia === 'faltando' || apPre.tipoDivergencia === 'varredura')
    ) {
      const codigoLocalEstoqueDiferenca = resolverEstoqueDiferencaAcxe({
        tipoDivergencia: apPre.tipoDivergencia,
        codigoLocalEstoqueDestinoAcxe: corr.codigoLocalEstoqueAcxe,
      });
      try {
        const idDiferenca = await transferirDiferencaAcxe({
          opId,
          codigoLocalEstoqueOrigem: loteRow.codigoLocalEstoqueOrigemAcxe,
          codigoLocalEstoqueDiferenca,
          codigoProdutoAcxe: Number(loteRow.produtoCodigoAcxe),
          quantidadeKg: qtdDiferencaKg,
          valorUnitarioAcxe: valorUnitAcxe,
          notaFiscal: loteRow.notaFiscal,
          observacaoSufixo: `divergencia ${apPre.tipoDivergencia} de ${qtdDiferencaKg} kg${motivoOperador}`,
        });
        logger.info(
          { idDiferenca, qtdDiferencaKg, tipo: apPre.tipoDivergencia, dest: codigoLocalEstoqueDiferenca },
          'Diferenca transferida para estoque especial',
        );
      } catch (err) {
        // Dual call ja sucedeu (ACXE+Q2P principais); marca pendencia da 2a chamada ACXE.
        logger.error(
          { err, idACXE: omieIds!.idACXE, idQ2P: omieIds!.idQ2P, qtdDiferencaKg, opId },
          'ALERTA: ajuste principal ok mas transferencia da diferenca falhou. Persistira movimentacao com pendente_acxe_faltando.',
        );
        pendencia = {
          tipo: 'pendente_acxe_faltando',
          mensagemErro: (err as Error)?.message ?? 'erro desconhecido',
        };
      }
    }
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

    let movimentacaoId: string | null = null;
    if (omieIds && ap.tipoAprovacao === 'recebimento_divergencia') {
      const [loteRow] = await tx.select().from(lote).where(eq(lote.id, ap.loteId)).limit(1);
      const isPendenteQ2p = pendencia?.tipo === 'pendente_q2p';
      const isPendenteAcxeFaltando = pendencia?.tipo === 'pendente_acxe_faltando';
      const statusOmieMov: 'concluida' | 'pendente_q2p' | 'pendente_acxe_faltando' = pendencia
        ? pendencia.tipo
        : 'concluida';
      const [movCriada] = await tx
        .insert(movimentacao)
        .values({
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
          mvQ2p: isPendenteQ2p ? null : 1,
          dtQ2p: isPendenteQ2p ? null : new Date(),
          idMovestQ2p: isPendenteQ2p ? null : omieIds.idQ2P.idMovest,
          idAjusteQ2p: isPendenteQ2p ? null : omieIds.idQ2P.idAjuste,
          idUserQ2p: isPendenteQ2p ? null : input.usuarioId,
          observacoes: `Aprovada divergencia ${ap.tipoDivergencia ?? ''} — qtd final ${ap.quantidadeRecebidaKg ?? loteRow!.quantidadeFisicaKg} kg`,
          opId: opId!,
          statusOmie: statusOmieMov,
          tentativasQ2p: isPendenteQ2p ? 1 : 0,
          tentativasAcxeFaltando: isPendenteAcxeFaltando ? 1 : 0,
          ultimoErroOmie: pendencia
            ? {
                lado: pendencia.tipo === 'pendente_q2p' ? 'q2p' : 'acxe-faltando',
                mensagem: pendencia.mensagemErro,
                timestamp: new Date().toISOString(),
              }
            : null,
        })
        .returning();
      movimentacaoId = movCriada!.id;
    }

    return {
      statusLote,
      loteId: ap.loteId,
      operadorId: ap.lancadoPor,
      tipoAprovacao: ap.tipoAprovacao,
      movimentacaoId,
    };
  });

  logger.info(
    { aprovacaoId: input.id, perfilUsuario: input.perfilUsuario, loteStatus: resultado.statusLote, omieIds, pendencia },
    'Aprovacao confirmada',
  );

  // Se ha pendencia OMIE residual, notifica admin/gestor (fire-and-forget)
  if (pendencia && resultado.movimentacaoId && opId) {
    void enviarAlertaPendenciaOmie({
      movimentacaoId: resultado.movimentacaoId,
      opId,
      notaFiscal: notaFiscalParaEmail,
      ladoPendente: pendencia.tipo === 'pendente_q2p' ? 'q2p' : 'acxe-faltando',
      mensagemErro: pendencia.mensagemErro,
      tentativas: 1,
    });
  }

  // Notifica operador fora da transacao (email nao bloqueia)
  await enviarNotificacaoAprovacaoOperador({
    operadorUserId: resultado.operadorId,
    aprovacaoId: input.id,
    tipoAprovacao: resultado.tipoAprovacao,
    loteId: resultado.loteId,
  });

  return {
    id: input.id,
    loteStatus: resultado.statusLote,
    pendenciaOmie:
      pendencia && resultado.movimentacaoId && opId
        ? {
            lado: pendencia.tipo === 'pendente_q2p' ? 'q2p' : 'acxe-faltando',
            opId,
            movimentacaoId: resultado.movimentacaoId,
            mensagem: pendencia.mensagemErro,
          }
        : undefined,
  };
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
  const resultado = await db.transaction(async (tx) => {
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

    const [loteRow] = await tx
      .update(lote)
      .set({
        status: 'aguardando_aprovacao',
        quantidadeFisicaKg: String(input.quantidadeRecebidaKg),
        updatedAt: new Date(),
      })
      .where(eq(lote.id, ap.loteId))
      .returning();

    logger.info(
      { aprovacaoRejeitadaId: input.id, novaAprovacaoId: nova!.id, usuarioId: input.usuarioId },
      'Aprovacao re-submetida',
    );
    return {
      id: input.id,
      novaAprovacao: nova!,
      lote: loteRow!,
    };
  });

  // Notifica gestor/diretor da nova pendencia (fora da transacao — email nao bloqueia commit)
  await enviarAlertaAprovacaoPendente({
    aprovacaoId: resultado.novaAprovacao.id,
    tipoAprovacao: resultado.novaAprovacao.tipoAprovacao,
    nivel: resultado.novaAprovacao.precisaNivel,
    loteCodigo: resultado.lote.codigo,
    produto: resultado.lote.fornecedorNome,
    quantidadeKg: input.quantidadeRecebidaKg,
    detalhes: `Re-submetida pelo operador apos rejeicao. Motivo: ${input.observacoes}`,
  });

  return { id: resultado.id, novaAprovacaoId: resultado.novaAprovacao.id };
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
