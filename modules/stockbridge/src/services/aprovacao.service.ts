import { eq, and, inArray, sql } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { aprovacao, lote, movimentacao, localidadeCorrelacao, reservaSaldo, users } from '@atlas/db';
import type { Perfil, TipoAprovacao } from '../types.js';
import { NIVEL_APROVACAO_POR_SUBTIPO } from '../types.js';
import { formatarDataOmie } from './omie-shared.js';
import {
  executarAjusteOmieDual,
  calcularValorUnitarioQ2p,
  calcularValorUnitarioAcxe,
  transferirDiferencaAcxe,
  inferirSubtipoPorNumeroNf,
  OmieAjusteError,
} from './recebimento.service.js';
import {
  enviarNotificacaoRejeicaoOperador,
  enviarNotificacaoAprovacaoOperador,
  enviarAlertaAprovacaoPendente,
  enviarAlertaPendenciaOmie,
} from './notificacao.service.js';
import { resolverEstoqueDiferencaAcxe } from './estoques-especiais-acxe.js';
import {
  executarSaidaOmieDual,
  executarTransferenciaIntraDual,
  executarComodatoOmieDual,
  executarRetornoComodatoOmieDual,
  resolverCodigoProdutoOmie,
  type ResultadoDual,
} from './omie-saida.service.js';
import { incluirAjusteIdempotente } from './omie-idempotente.js';
import { resolverDescricaoProdutoAcxe } from './produto-descricao.js';

const logger = createLogger('stockbridge:aprovacao');

export class AprovacaoNaoEncontradaError extends Error {
  constructor(public readonly id: string) {
    super(`Aprovação ${id} não encontrada ou já finalizada`);
    this.name = 'AprovacaoNaoEncontradaError';
  }
}

export class AprovacaoNivelInsuficienteError extends Error {
  constructor(
    public readonly perfilUsuario: Perfil,
    public readonly nivelRequerido: 'gestor' | 'diretor',
  ) {
    super(`Perfil ${perfilUsuario} não pode aprovar pendência que exige ${nivelRequerido}`);
    this.name = 'AprovacaoNivelInsuficienteError';
  }
}

export class AprovacaoStatusInvalidoError extends Error {
  constructor(public readonly id: string, public readonly statusAtual: string) {
    super(`Aprovação ${id} já foi ${statusAtual} — não é possível alterar`);
    this.name = 'AprovacaoStatusInvalidoError';
  }
}

/** STK-07 (ACXEGDP-287): re-submissão quando o lote já tem outra aprovação pendente. */
export class ResubmissaoDuplicadaError extends Error {
  constructor(public readonly loteId: string) {
    super(
      `Este lote já tem uma aprovação pendente — a re-submissão anterior foi registrada. ` +
        'Aguarde a decisão do gestor em vez de re-submeter de novo.',
    );
    this.name = 'ResubmissaoDuplicadaError';
  }
}

/**
 * Detecta violação do índice único parcial aprovacao_uq_lote_pendente
 * (migration 0043). O driver pg expõe code='23505' + constraint; o drizzle pode
 * envelopar o erro original em `cause` dependendo da versão — checa os dois.
 */
function isViolacaoUnicidadePendente(err: unknown): boolean {
  const candidatos = [err, (err as { cause?: unknown })?.cause];
  return candidatos.some((c) => {
    const e = c as { code?: string; constraint?: string } | undefined;
    return e?.code === '23505' && e?.constraint === 'aprovacao_uq_lote_pendente';
  });
}

export interface PendenciaItem {
  id: string;
  /** Pode ser null para saidas manuais sem lote (migration 0026). */
  loteId: string | null;
  loteCodigo: string | null;
  tipoAprovacao: TipoAprovacao;
  precisaNivel: 'gestor' | 'diretor';
  quantidadePrevistaKg: number | null;
  quantidadeRecebidaKg: number | null;
  deltaKg: number | null;
  tipoDivergencia: string | null;
  observacoes: string | null;
  lancadoPor: { id: string; nome: string };
  lancadoEm: string;
  /** Para fluxo com lote, vem do lote. Para fluxo sem lote (saida manual), vem da aprovacao. */
  produto: { codigoAcxe: number; fornecedor: string };
  /** Apenas para saida sem lote: galpao + empresa do material. */
  galpao: string | null;
  empresa: 'acxe' | 'q2p' | null;
}

/**
 * Lista pendencias de aprovacao acessiveis ao perfil do usuario.
 *  - Gestor ve apenas pendencias `precisa_nivel = gestor`
 *  - Diretor ve ambas (gestor + diretor)
 *
 * Cobre tanto pendencias com lote (recebimento_divergencia) quanto sem lote
 * (saida manual: saida_amostra/descarte/quebra/transf/comodato/inventario/retorno).
 */
export async function listarPendencias(perfil: Perfil): Promise<PendenciaItem[]> {
  if (perfil === 'operador') {
    return [];
  }
  const db = getDb();
  const niveisAcessiveis: Array<'gestor' | 'diretor'> = perfil === 'diretor' ? ['gestor', 'diretor'] : ['gestor'];

  const niveisIn = sql.join(
    niveisAcessiveis.map((n) => sql`${n}`),
    sql`, `,
  );
  const rows = await db.execute<{
    id: string;
    lote_id: string | null;
    tipo_aprovacao: string;
    precisa_nivel: string;
    quantidade_prevista_kg: string | null;
    quantidade_recebida_kg: string | null;
    tipo_divergencia: string | null;
    observacoes: string | null;
    lancado_por: string;
    lancado_em: string;
    lote_codigo: string | null;
    // BIGINT volta como string do pg driver mesmo com schema mode='number'
    // (db.execute usa raw SQL, ignora o typecast do schema). Forcar Number() no map.
    lote_produto_codigo_acxe: string | null;
    lote_fornecedor_nome: string | null;
    aprov_produto_codigo_acxe: string | null;
    aprov_galpao: string | null;
    aprov_empresa: string | null;
    produto_descricao: string | null;
  }>(sql`
    SELECT a.id,
           a.lote_id,
           a.tipo_aprovacao,
           a.precisa_nivel,
           a.quantidade_prevista_kg::text,
           a.quantidade_recebida_kg::text,
           a.tipo_divergencia,
           a.observacoes,
           a.lancado_por,
           a.lancado_em::text,
           l.codigo AS lote_codigo,
           l.produto_codigo_acxe AS lote_produto_codigo_acxe,
           l.fornecedor_nome AS lote_fornecedor_nome,
           a.produto_codigo_acxe AS aprov_produto_codigo_acxe,
           a.galpao AS aprov_galpao,
           a.empresa AS aprov_empresa,
           p.descricao AS produto_descricao
    FROM stockbridge.aprovacao a
    LEFT JOIN stockbridge.lote l ON l.id = a.lote_id
    LEFT JOIN public."tbl_produtos_ACXE" p
      ON p.codigo_produto = COALESCE(a.produto_codigo_acxe, l.produto_codigo_acxe)
    WHERE a.status = 'pendente'
      AND a.precisa_nivel IN (${niveisIn})
    ORDER BY a.lancado_em DESC
  `);

  const userIds = [...new Set(rows.rows.map((r) => r.lancado_por))];
  const userMap = new Map<string, string>();
  if (userIds.length > 0) {
    const userRows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const u of userRows) userMap.set(u.id, u.name);
  }

  return rows.rows.map((r) => {
    const previsto = r.quantidade_prevista_kg != null ? Number(r.quantidade_prevista_kg) : null;
    const recebido = r.quantidade_recebida_kg != null ? Number(r.quantidade_recebida_kg) : null;
    const delta = previsto != null && recebido != null ? Number((recebido - previsto).toFixed(3)) : null;
    const codigoAcxeRaw = r.aprov_produto_codigo_acxe ?? r.lote_produto_codigo_acxe;
    const codigoAcxe = codigoAcxeRaw != null ? Number(codigoAcxeRaw) : 0;
    const fornecedor = r.lote_fornecedor_nome ?? r.produto_descricao ?? `SKU ${codigoAcxe}`;
    return {
      id: r.id,
      loteId: r.lote_id,
      loteCodigo: r.lote_codigo,
      tipoAprovacao: r.tipo_aprovacao as TipoAprovacao,
      precisaNivel: r.precisa_nivel as 'gestor' | 'diretor',
      quantidadePrevistaKg: previsto,
      quantidadeRecebidaKg: recebido,
      deltaKg: delta,
      tipoDivergencia: r.tipo_divergencia,
      observacoes: r.observacoes,
      lancadoPor: { id: r.lancado_por, nome: userMap.get(r.lancado_por) ?? 'desconhecido' },
      lancadoEm: new Date(r.lancado_em).toISOString(),
      produto: { codigoAcxe, fornecedor },
      galpao: r.aprov_galpao,
      empresa: (r.aprov_empresa as 'acxe' | 'q2p' | null) ?? null,
    };
  });
}

export interface MinhaRejeicaoItem {
  id: string;
  /** Null para saidas manuais (ajuste, comodato, descarte, etc — migration 0026). */
  loteId: string | null;
  loteCodigo: string | null;
  tipoAprovacao: TipoAprovacao;
  motivoRejeicao: string;
  quantidadeRecebidaKg: number;
  produtoCodigoAcxe: number;
  fornecedor: string;
  /** Apenas para saida manual sem lote. */
  galpao: string | null;
  empresa: 'acxe' | 'q2p' | null;
  lancadoEm: string;
  rejeitadoEm: string;
}

/**
 * Lista as aprovacoes rejeitadas que o operador (`userId`) lancou.
 *
 * Cobre dois casos:
 *  - Rejeicoes com lote (recebimento_divergencia): operador pode re-submeter.
 *  - Rejeicoes sem lote (saida manual): apenas notificacao — operador re-lanca
 *    do zero pela tela de origem (nao ha fluxo de re-submissao).
 *
 * Filtra rejeicoes "superadas": se ja existe uma aprovacao mais recente para o
 * mesmo lote (criada pelo proprio resubmeter), a rejeicao antiga e omitida.
 * Saidas manuais nao tem como ser superadas — ficam visiveis ate envelhecerem
 * 30 dias (corte arbitrario, evita inbox crescer indefinidamente).
 *
 * Ordena por mais recente primeiro.
 */
export async function listarMinhasRejeicoes(userId: string): Promise<MinhaRejeicaoItem[]> {
  const db = getDb();
  const rows = await db.execute<{
    id: string;
    lote_id: string | null;
    tipo_aprovacao: string;
    quantidade_recebida_kg: string | null;
    rejeicao_motivo: string | null;
    // db.execute (raw sql) retorna timestamps como string ISO, nao Date.
    lancado_em: string;
    aprovado_em: string | null;
    lote_codigo: string | null;
    // BIGINT volta como string do pg driver — converter no map.
    lote_produto_codigo_acxe: string | null;
    lote_fornecedor_nome: string | null;
    aprov_produto_codigo_acxe: string | null;
    aprov_galpao: string | null;
    aprov_empresa: string | null;
    produto_descricao: string | null;
  }>(sql`
    SELECT a.id, a.lote_id, a.tipo_aprovacao, a.quantidade_recebida_kg,
           a.rejeicao_motivo, a.lancado_em, a.aprovado_em,
           l.codigo AS lote_codigo,
           l.produto_codigo_acxe AS lote_produto_codigo_acxe,
           l.fornecedor_nome AS lote_fornecedor_nome,
           a.produto_codigo_acxe AS aprov_produto_codigo_acxe,
           a.galpao AS aprov_galpao,
           a.empresa AS aprov_empresa,
           p.descricao AS produto_descricao
    FROM stockbridge.aprovacao a
    LEFT JOIN stockbridge.lote l ON l.id = a.lote_id
    LEFT JOIN public."tbl_produtos_ACXE" p
      ON p.codigo_produto = COALESCE(a.produto_codigo_acxe, l.produto_codigo_acxe)
    WHERE a.status = 'rejeitada'
      AND a.lancado_por = ${userId}::uuid
      AND a.dispensada_em IS NULL
      AND (a.lote_id IS NULL OR l.ativo = true)
      AND (
        a.lote_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM stockbridge.aprovacao a2
          WHERE a2.lote_id = a.lote_id
            AND a2.lancado_em > a.lancado_em
        )
      )
      AND (a.lote_id IS NOT NULL OR a.aprovado_em > NOW() - INTERVAL '30 days')
    ORDER BY a.aprovado_em DESC NULLS LAST
  `);

  return rows.rows.map((r) => {
    const codigoAcxeRaw = r.aprov_produto_codigo_acxe ?? r.lote_produto_codigo_acxe;
    const codigoAcxe = codigoAcxeRaw != null ? Number(codigoAcxeRaw) : 0;
    const fornecedor = r.lote_fornecedor_nome ?? r.produto_descricao ?? `SKU ${codigoAcxe}`;
    return {
      id: r.id,
      loteId: r.lote_id,
      loteCodigo: r.lote_codigo,
      tipoAprovacao: r.tipo_aprovacao as TipoAprovacao,
      motivoRejeicao: r.rejeicao_motivo ?? '',
      quantidadeRecebidaKg: r.quantidade_recebida_kg != null ? Number(r.quantidade_recebida_kg) : 0,
      produtoCodigoAcxe: codigoAcxe,
      fornecedor,
      galpao: r.aprov_galpao,
      empresa: (r.aprov_empresa as 'acxe' | 'q2p' | null) ?? null,
      lancadoEm: new Date(r.lancado_em).toISOString(),
      rejeitadoEm: new Date(r.aprovado_em ?? r.lancado_em).toISOString(),
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

const TIPOS_SAIDA_MANUAL: ReadonlySet<TipoAprovacao> = new Set([
  'saida_transf_intra',
  'saida_comodato',
  'saida_amostra',
  'saida_descarte',
  'saida_quebra',
  'ajuste_inventario',
  'retorno_comodato',
]);

export async function aprovar(input: AprovarInput): Promise<AprovarResult> {
  const db = getDb();

  // Pre-check fora da transacao (evita abrir tx so pra abortar)
  const [apPre] = await db.select().from(aprovacao).where(eq(aprovacao.id, input.id)).limit(1);
  if (!apPre) throw new AprovacaoNaoEncontradaError(input.id);
  if (apPre.status !== 'pendente') throw new AprovacaoStatusInvalidoError(input.id, apPre.status);
  checarNivel(input.perfilUsuario, apPre.precisaNivel);

  // Saidas manuais (migration 0026) — fluxo dedicado, agnostico de lote.
  if (TIPOS_SAIDA_MANUAL.has(apPre.tipoAprovacao)) {
    return aprovarSaidaManual(apPre, input);
  }

  // Recebimento nacional (entrada_manual sem lote, padrao saida manual com
  // movimentacaoId) — fluxo single-empresa, sem dual ACXE<->Q2P.
  if (apPre.tipoAprovacao === 'entrada_manual' && apPre.movimentacaoId) {
    return aprovarEntradaNacional(apPre, input);
  }

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
    if (!apPre.loteId) throw new Error(`Aprovação ${apPre.id} sem loteId — recebimento_divergencia exige lote`);
    // STK-01 (ACXEGDP-281): opId deterministico (id da aprovacao) em vez de
    // randomUUID() por chamada. Duas invocacoes concorrentes geram o MESMO
    // cod_int_ajuste, e a recuperacao de 1035 do cliente OMIE faz a segunda
    // herdar os IDs da primeira em vez de duplicar o ajuste no ERP.
    opId = apPre.id;
    const [loteRow] = await db.select().from(lote).where(eq(lote.id, apPre.loteId)).limit(1);
    if (!loteRow) throw new Error(`Lote ${apPre.loteId} não encontrado ao aprovar divergência`);
    if (!loteRow.produtoCodigoQ2p) {
      throw new Error(`Lote ${loteRow.codigo} sem correlato Q2P — não é possível ajustar OMIE`);
    }
    if (!loteRow.localidadeId) {
      throw new Error(`Lote ${loteRow.codigo} sem localidade destino — não é possível ajustar OMIE`);
    }
    const [corr] = await db
      .select()
      .from(localidadeCorrelacao)
      .where(eq(localidadeCorrelacao.localidadeId, loteRow.localidadeId))
      .limit(1);
    if (!corr?.codigoLocalEstoqueAcxe || !corr?.codigoLocalEstoqueQ2p) {
      throw new Error(`Localidade do lote ${loteRow.codigo} sem correlação ACXE/Q2P completa`);
    }
    const qtdAprovadaKg = Number(apPre.quantidadeRecebidaKg ?? loteRow.quantidadeFisicaKg);
    if (!loteRow.notaFiscal) {
      throw new Error(`Lote ${loteRow.codigo} sem notaFiscal — não é possível ajustar OMIE`);
    }
    if (!loteRow.codigoLocalEstoqueOrigemAcxe || !loteRow.valorTotalNfBrl) {
      throw new Error(
        `Lote ${loteRow.codigo} sem dados da NF persistidos (origem ACXE / vNF). ` +
          'Lote criado em versão anterior — re-consulte OMIE manualmente ou re-submeta o recebimento.',
      );
    }
    notaFiscalParaEmail = loteRow.notaFiscal;
    const qtdNfKg = Number(loteRow.quantidadeFiscalKg);
    const vNF = Number(loteRow.valorTotalNfBrl);

    const valorUnitAcxe = calcularValorUnitarioAcxe(vNF, qtdNfKg);
    const motivoOperador = apPre.observacoes?.trim()
      ? `\nMotivo da divergência: ${apPre.observacoes.trim()}`
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
        observacaoSufixo: `com divergência aprovada por gestor (${apPre.tipoDivergencia ?? 'n/a'})${motivoOperador}`,
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
          observacaoSufixo: `divergência ${apPre.tipoDivergencia} de ${qtdDiferencaKg} kg${motivoOperador}`,
        });
        logger.info(
          { idDiferenca, qtdDiferencaKg, tipo: apPre.tipoDivergencia, dest: codigoLocalEstoqueDiferenca },
          'Diferença transferida para estoque especial',
        );
      } catch (err) {
        // Dual call ja sucedeu (ACXE+Q2P principais); marca pendencia da 2a chamada ACXE.
        logger.error(
          { err, idACXE: omieIds!.idACXE, idQ2P: omieIds!.idQ2P, qtdDiferencaKg, opId },
          'ALERTA: ajuste principal ok mas transferência da diferença falhou. Persistirá movimentação com pendente_acxe_faltando.',
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
    // Claim atomico (STK-01, ACXEGDP-281): so a transacao que efetivamente muda
    // pendente->aprovada prossegue. O SELECT+check anterior tinha janela TOCTOU —
    // duas aprovacoes concorrentes passavam ambas no check e o segundo UPDATE
    // sobrescrevia o primeiro silenciosamente (inclusive aprovar vs rejeitar).
    const [ap] = await tx
      .update(aprovacao)
      .set({
        status: 'aprovada',
        aprovadoPor: input.usuarioId,
        aprovadoEm: new Date(),
      })
      .where(and(eq(aprovacao.id, input.id), eq(aprovacao.status, 'pendente')))
      .returning();
    if (!ap) {
      const [check] = await tx.select().from(aprovacao).where(eq(aprovacao.id, input.id)).limit(1);
      if (!check) throw new AprovacaoNaoEncontradaError(input.id);
      throw new AprovacaoStatusInvalidoError(input.id, check.status);
    }

    const statusLote =
      ap.tipoAprovacao === 'recebimento_divergencia' || ap.tipoAprovacao === 'entrada_manual'
        ? 'provisorio'
        : 'reconciliado';

    if (!ap.loteId) {
      // Aprovacoes sem lote sao todas tratadas em aprovarSaidaManual via early return.
      // Se chegou aqui sem loteId, e bug.
      throw new Error(`Aprovação ${ap.id} (${ap.tipoAprovacao}) sem lote — caminho inesperado`);
    }
    const loteIdNotNull: string = ap.loteId;
    await tx.update(lote).set({ status: statusLote, updatedAt: new Date() }).where(eq(lote.id, loteIdNotNull));

    let movimentacaoId: string | null = null;
    if (omieIds && ap.tipoAprovacao === 'recebimento_divergencia') {
      const [loteRow] = await tx.select().from(lote).where(eq(lote.id, loteIdNotNull)).limit(1);
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
          // STK-21: infere o subtipo pela mesma heurística de número de NF do
          // recebimento, em vez de hardcodar 'importacao'. NF nula → 'importacao'
          // (idêntico ao comportamento anterior).
          subtipo: inferirSubtipoPorNumeroNf(loteRow!.notaFiscal ?? ''),
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
          observacoes: `Aprovada divergência ${ap.tipoDivergencia ?? ''} — qtd final ${ap.quantidadeRecebidaKg ?? loteRow!.quantidadeFisicaKg} kg`,
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
      loteId: loteIdNotNull,
      operadorId: ap.lancadoPor,
      tipoAprovacao: ap.tipoAprovacao,
      movimentacaoId,
    };
  });

  logger.info(
    { aprovacaoId: input.id, perfilUsuario: input.perfilUsuario, loteStatus: resultado.statusLote, omieIds, pendencia },
    'Aprovação confirmada',
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

  // Notifica operador fora da transacao (email nao bloqueia).
  // Comex entra em copia so quando e recebimento divergente concluido COM SUCESSO
  // (sem pendencia OMIE) — o estoque efetivamente entrou.
  await enviarNotificacaoAprovacaoOperador({
    operadorUserId: resultado.operadorId,
    aprovacaoId: input.id,
    tipoAprovacao: resultado.tipoAprovacao,
    loteId: resultado.loteId,
    incluirComex: resultado.tipoAprovacao === 'recebimento_divergencia' && !pendencia,
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
    throw new Error('Motivo obrigatório para rejeitar aprovação');
  }
  const db = getDb();

  const resultado = await db.transaction(async (tx) => {
    // Claim atomico (STK-01): mesmo padrao de aprovar(). checarNivel roda DEPOIS
    // do update — se falhar, o throw faz rollback da transacao inteira.
    const [ap] = await tx
      .update(aprovacao)
      .set({
        status: 'rejeitada',
        aprovadoPor: input.usuarioId,
        aprovadoEm: new Date(),
        rejeicaoMotivo: input.motivo,
      })
      .where(and(eq(aprovacao.id, input.id), eq(aprovacao.status, 'pendente')))
      .returning();
    if (!ap) {
      const [check] = await tx.select().from(aprovacao).where(eq(aprovacao.id, input.id)).limit(1);
      if (!check) throw new AprovacaoNaoEncontradaError(input.id);
      throw new AprovacaoStatusInvalidoError(input.id, check.status);
    }
    checarNivel(input.perfilUsuario, ap.precisaNivel);

    // Caminho com lote (recebimento_divergencia/entrada_manual): marca lote rejeitado
    if (ap.loteId) {
      await tx.update(lote).set({ status: 'rejeitado', updatedAt: new Date() }).where(eq(lote.id, ap.loteId));
    }

    // Caminho sem lote (saida manual / retorno comodato): libera reserva e
    // desativa movimentacao linkada (soft delete preserva auditoria).
    if (ap.movimentacaoId) {
      await tx
        .update(reservaSaldo)
        .set({ status: 'liberada', resolvidoEm: new Date() })
        .where(and(eq(reservaSaldo.movimentacaoId, ap.movimentacaoId), eq(reservaSaldo.status, 'ativa')));
      await tx
        .update(movimentacao)
        .set({ ativo: false, updatedAt: new Date() })
        .where(eq(movimentacao.id, ap.movimentacaoId));
      // Para retorno_comodato: tambem desativa a movimentacao de baixa do TROCA pareada.
      if (ap.tipoAprovacao === 'retorno_comodato') {
        const [movEntrada] = await tx
          .select()
          .from(movimentacao)
          .where(eq(movimentacao.id, ap.movimentacaoId))
          .limit(1);
        if (movEntrada?.movimentacaoOrigemId) {
          await tx
            .update(movimentacao)
            .set({ ativo: false, updatedAt: new Date() })
            .where(
              and(
                eq(movimentacao.movimentacaoOrigemId, movEntrada.movimentacaoOrigemId),
                eq(movimentacao.tipoMovimento, 'ajuste'),
              ),
            );
        }
      }
    }

    return {
      operadorId: ap.lancadoPor,
      loteId: ap.loteId ?? ap.movimentacaoId ?? '',
      temLote: ap.loteId !== null,
      tipoAprovacao: ap.tipoAprovacao,
    };
  });

  logger.info({ aprovacaoId: input.id, perfilUsuario: input.perfilUsuario }, 'Aprovação rejeitada');

  // Notifica o operador que lancou a divergencia/saida (fora da transacao)
  await enviarNotificacaoRejeicaoOperador({
    operadorUserId: resultado.operadorId,
    aprovacaoId: input.id,
    loteId: resultado.loteId,
    motivo: input.motivo,
    fluxo: resultado.temLote ? 'recebimento' : 'saida_manual',
    tipoAprovacao: resultado.tipoAprovacao,
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
    throw new Error('Motivo obrigatório ao re-submeter aprovação rejeitada');
  }
  const db = getDb();
  let loteIdAlvo = '';
  const resultado = await db.transaction(async (tx) => {
    const [ap] = await tx.select().from(aprovacao).where(eq(aprovacao.id, input.id)).limit(1);
    if (!ap) throw new AprovacaoNaoEncontradaError(input.id);
    if (ap.status !== 'rejeitada') {
      throw new AprovacaoStatusInvalidoError(input.id, ap.status);
    }
    if (!ap.loteId) throw new Error(`Aprovação ${ap.id} sem lote não pode ser re-submetida`);
    loteIdAlvo = ap.loteId;

    // STK-07 (ACXEGDP-287): duplo-clique/retry de rede chamava resubmeter 2x e
    // criava DUAS aprovacoes pendentes pro mesmo lote — cada uma, aprovada, rodava
    // o dual OMIE de novo. Este check da a mensagem amigavel; a garantia real
    // contra corrida e o indice unico parcial aprovacao_uq_lote_pendente
    // (migration 0043) — a violacao e mapeada pra ResubmissaoDuplicadaError abaixo.
    const [pendenteExistente] = await tx
      .select({ id: aprovacao.id })
      .from(aprovacao)
      .where(and(eq(aprovacao.loteId, ap.loteId), eq(aprovacao.status, 'pendente')))
      .limit(1);
    if (pendenteExistente) throw new ResubmissaoDuplicadaError(ap.loteId);

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
      'Aprovação re-submetida',
    );
    return {
      id: input.id,
      novaAprovacao: nova!,
      lote: loteRow!,
    };
  }).catch((err: unknown) => {
    // Corrida real (duas re-submissoes concorrentes passam ambas no check acima):
    // o indice unico parcial derruba a segunda no INSERT — traduz pro mesmo erro
    // amigavel do check de aplicacao.
    if (isViolacaoUnicidadePendente(err)) {
      throw new ResubmissaoDuplicadaError(loteIdAlvo);
    }
    throw err;
  });

  // EML-04: o campo "produto" do e-mail mostrava o FORNECEDOR (lote não guarda a
  // descrição — só produto_codigo_acxe). Resolve a descrição real do SKU.
  const descricaoProduto = await resolverDescricaoProdutoAcxe(db, resultado.lote.produtoCodigoAcxe);

  // Notifica gestor/diretor da nova pendencia (fora da transacao — email nao bloqueia commit)
  await enviarAlertaAprovacaoPendente({
    aprovacaoId: resultado.novaAprovacao.id,
    tipoAprovacao: resultado.novaAprovacao.tipoAprovacao,
    nivel: resultado.novaAprovacao.precisaNivel,
    loteCodigo: resultado.lote.codigo,
    produto: descricaoProduto,
    quantidadeKg: input.quantidadeRecebidaKg,
    detalhes: `Re-submetida pelo operador após rejeição. Motivo: ${input.observacoes}`,
  });

  return { id: resultado.id, novaAprovacaoId: resultado.novaAprovacao.id };
}

/**
 * Operador descarta uma rejeicao da propria caixa de entrada (migration 0029).
 * - Apenas o usuario que lancou a aprovacao original pode dispensar.
 * - So aprovacoes em status='rejeitada' podem ser dispensadas (auditoria
 *   registra o UPDATE via trigger; status nao muda).
 * - Idempotente: chamar de novo retorna ok sem efeito.
 *
 * Nao afeta a movimentacao linkada (que ja esta `ativo=false` desde a
 * rejeicao) nem a reserva (ja `liberada`). Soft-dismiss apenas filtra a
 * rejeicao do `listarMinhasRejeicoes`.
 */
export async function dispensarRejeicao(input: {
  id: string;
  usuarioId: string;
}): Promise<{ id: string; jaEstavaDispensada: boolean }> {
  const db = getDb();
  const [ap] = await db.select().from(aprovacao).where(eq(aprovacao.id, input.id)).limit(1);
  if (!ap) throw new AprovacaoNaoEncontradaError(input.id);
  if (ap.lancadoPor !== input.usuarioId) {
    throw new Error(`Apenas o operador que lançou pode dispensar a rejeição ${input.id}`);
  }
  if (ap.status !== 'rejeitada') {
    throw new AprovacaoStatusInvalidoError(input.id, ap.status);
  }
  if (ap.dispensadaEm !== null) {
    return { id: input.id, jaEstavaDispensada: true };
  }
  await db
    .update(aprovacao)
    .set({ dispensadaEm: new Date() })
    .where(eq(aprovacao.id, input.id));
  logger.info({ aprovacaoId: input.id, usuarioId: input.usuarioId }, 'Rejeição dispensada pelo operador');
  return { id: input.id, jaEstavaDispensada: false };
}

/**
 * Fluxo de aprovacao para recebimento nacional (entrada_manual sem lote).
 * Single-empresa: chama OMIE apenas no CNPJ destino selecionado pelo operador
 * (sem dual ACXE<->Q2P, ja que nacional pode entrar puro Q2P ou puro ACXE).
 *
 * - tipo=ENT, motivo=INI (entrada inicial — mesmo padrao do recebimento de
 *   importacao no lado Q2P)
 * - cod_int_ajuste = ${opId}:nacional-${empresa} pra idempotencia
 * - Valor unitario: usa custo medio existente do SKU; se 0 (produto novo no
 *   estoque), envia 0.01 e loga warning — operador pode ajustar via OMIE
 *   diretamente. OMIE rejeita ajuste com valor=0.
 */
async function aprovarEntradaNacional(
  ap: typeof aprovacao.$inferSelect,
  input: AprovarInput,
): Promise<AprovarResult> {
  const db = getDb();

  const temProduto = ap.produtoCodigoAcxe != null || ap.produtoCodigoQ2p != null;
  if (!temProduto || !ap.galpao || !ap.empresa) {
    throw new Error(`Aprovação ${ap.id} sem produto/galpão/empresa — registro inconsistente`);
  }
  if (!ap.movimentacaoId) {
    throw new Error(`Aprovação ${ap.id} sem movimentação linkada — registro inconsistente`);
  }

  const [mov] = await db.select().from(movimentacao).where(eq(movimentacao.id, ap.movimentacaoId)).limit(1);
  if (!mov) throw new Error(`Movimentação ${ap.movimentacaoId} não encontrada`);

  const quantidadeKg = Number(ap.quantidadeRecebidaKg ?? 0);
  if (quantidadeKg <= 0) throw new Error(`Aprovação ${ap.id} sem quantidade válida`);

  const empresa = ap.empresa as 'acxe' | 'q2p';

  // ap.galpao guarda o codigo Atlas (ex: '21.2', '11.2'). Resolve para o codigo
  // OMIE (codigo_local_estoque_acxe/q2p) via localidade_correlacao.
  const colCodigo = empresa === 'acxe' ? 'codigo_local_estoque_acxe' : 'codigo_local_estoque_q2p';
  const localRes = await db.execute<{ codigo: string | null }>(sql`
    SELECT lc.${sql.raw(colCodigo)}::text AS codigo
    FROM stockbridge.localidade l
    INNER JOIN stockbridge.localidade_correlacao lc ON lc.localidade_id = l.id
    WHERE l.codigo = ${ap.galpao}
    LIMIT 1
  `);
  const codigoLocalEstoque = localRes.rows[0]?.codigo;
  if (!codigoLocalEstoque) {
    throw new Error(
      `Aprovação ${ap.id}: localidade '${ap.galpao}' sem código OMIE para empresa ${empresa}`,
    );
  }

  // Para Q2P nacional: usa produto_codigo_q2p diretamente (sem match por descricao).
  // Para ACXE: usa produto_codigo_acxe diretamente.
  // Para Q2P espelhado (recebimento importacao): resolve via descricao ACXE->Q2P.
  const idProduto =
    empresa === 'acxe'
      ? Number(ap.produtoCodigoAcxe)
      : ap.produtoCodigoQ2p != null
        ? Number(ap.produtoCodigoQ2p)
        : await resolverCodigoProdutoOmie(Number(ap.produtoCodigoAcxe), 'q2p');

  // Usa custo unitario da NF informado pelo operador se disponivel; caso contrario
  // tenta custo medio do estoque; ultimo recurso 0.01 (OMIE rejeita valor=0).
  const custoNf = mov.custoUnitarioBrl != null ? Number(mov.custoUnitarioBrl) : 0;
  let valorUnitario: number;
  if (custoNf > 0) {
    valorUnitario = custoNf;
  } else {
    const valorMedio = await consultarValorUnitarioProduto(
      Number(ap.produtoCodigoAcxe),
      codigoLocalEstoque,
      empresa,
    );
    if (valorMedio > 0) {
      valorUnitario = valorMedio;
    } else {
      logger.warn(
        { aprovacaoId: ap.id, sku: ap.produtoCodigoAcxe, empresa },
        'Sem custo NF e sem custo médio — usando 0.01 como placeholder pra OMIE aceitar ajuste',
      );
      valorUnitario = 0.01;
    }
  }

  const observacaoOmie = (ap.observacoes ?? `Recebimento nacional ${ap.id}`).slice(0, 240);
  const codInt = `${mov.opId}:nacional-${empresa}`;

  const dataAtual = formatarDataOmie();

  let omieRes: { idMovest: string; idAjuste: string };
  try {
    const r = await incluirAjusteIdempotente(empresa, codInt, {
      codigoLocalEstoque,
      idProduto,
      dataAtual,
      quantidade: quantidadeKg,
      observacao: observacaoOmie,
      origem: 'AJU',
      tipo: 'ENT',
      motivo: 'INI',
      valor: valorUnitario,
    });
    omieRes = { idMovest: r.idMovest, idAjuste: r.idAjuste };
  } catch (err) {
    logger.error({ err, aprovacaoId: ap.id, empresa }, 'OMIE falhou ao aprovar recebimento nacional');
    throw err;
  }

  await db.transaction(async (tx) => {
    // Claim atomico (STK-01): so quem muda pendente->aprovada prossegue.
    const [apFresh] = await tx
      .update(aprovacao)
      .set({ status: 'aprovada', aprovadoPor: input.usuarioId, aprovadoEm: new Date() })
      .where(and(eq(aprovacao.id, ap.id), eq(aprovacao.status, 'pendente')))
      .returning();
    if (!apFresh) {
      const [check] = await tx.select().from(aprovacao).where(eq(aprovacao.id, ap.id)).limit(1);
      if (!check) throw new AprovacaoNaoEncontradaError(ap.id);
      throw new AprovacaoStatusInvalidoError(ap.id, check.status);
    }

    const updateMov: Record<string, unknown> = {
      statusOmie: 'concluida',
      updatedAt: new Date(),
    };
    if (empresa === 'acxe') {
      updateMov.mvAcxe = 1;
      updateMov.dtAcxe = new Date();
      updateMov.idMovestAcxe = omieRes.idMovest;
      updateMov.idAjusteAcxe = omieRes.idAjuste;
      updateMov.idUserAcxe = input.usuarioId;
    } else {
      updateMov.mvQ2p = 1;
      updateMov.dtQ2p = new Date();
      updateMov.idMovestQ2p = omieRes.idMovest;
      updateMov.idAjusteQ2p = omieRes.idAjuste;
      updateMov.idUserQ2p = input.usuarioId;
    }
    await tx.update(movimentacao).set(updateMov).where(eq(movimentacao.id, mov.id));
  });

  logger.info(
    { aprovacaoId: ap.id, movimentacaoId: mov.id, empresa, omieRes, quantidadeKg },
    'Recebimento nacional aprovado e ajustado no OMIE',
  );

  // Notifica operador fora da transacao
  await enviarNotificacaoAprovacaoOperador({
    operadorUserId: ap.lancadoPor,
    aprovacaoId: ap.id,
    tipoAprovacao: ap.tipoAprovacao,
    loteId: mov.id, // sem lote — usa movimentacaoId como referencia textual
  });

  return {
    id: ap.id,
    loteStatus: 'reconciliado',
  };
}

/**
 * Fluxo de aprovacao para saidas manuais (sem lote, migration 0026).
 * - Resolve valor unitario do produto via vw_posicaoEstoqueUnificadaFamilia
 * - Chama OMIE conforme subtipo (SAI/TRF/ENT)
 * - Atualiza movimentacao com idMovest/idAjuste e status_omie='concluida'
 * - Marca reserva como 'consumida'
 * - Marca aprovacao como 'aprovada'
 *
 * Nota: para retorno_comodato a aprovacao aponta pra movimentacao DE ENTRADA
 * (destino). A baixa do TROCA e localizada via movimentacao_origem_id +
 * subtipo retorno_comodato + galpao TROCA.
 */
async function aprovarSaidaManual(
  ap: typeof aprovacao.$inferSelect,
  input: AprovarInput,
): Promise<AprovarResult> {
  const db = getDb();

  if (!ap.produtoCodigoAcxe || !ap.galpao || !ap.empresa) {
    throw new Error(`Aprovação ${ap.id} sem produto/galpão/empresa — registro inconsistente`);
  }
  if (!ap.movimentacaoId) {
    throw new Error(`Aprovação ${ap.id} sem movimentação linkada — registro inconsistente`);
  }

  const [mov] = await db.select().from(movimentacao).where(eq(movimentacao.id, ap.movimentacaoId)).limit(1);
  if (!mov) throw new Error(`Movimentação ${ap.movimentacaoId} não encontrada`);

  const quantidadeKg = Math.abs(Number(ap.quantidadeRecebidaKg ?? 0));
  if (quantidadeKg <= 0) throw new Error(`Aprovação ${ap.id} sem quantidade válida`);

  const valorUnitario = await consultarValorUnitarioProduto(
    Number(ap.produtoCodigoAcxe),
    ap.galpao,
    ap.empresa as 'acxe' | 'q2p',
  );

  const observacaoOmie = (ap.observacoes ?? `Saída manual ${ap.tipoAprovacao}`).slice(0, 240);

  // Roteamento OMIE por tipoAprovacao
  //   - Saidas definitivas + transf_intra: dual call (ACXE+Q2P) quando galpao espelhado
  //   - Comodato: single Q2P (TROCA so existe Q2P)
  //   - Retorno comodato: special (2 ajustes em sequencia)
  let resultadoOmie:
    | { kind: 'dual'; dual: ResultadoDual }
    | {
        kind: 'retorno_dual';
        acxe: { baixa: { idMovest: string; idAjuste: string }; entrada: { idMovest: string; idAjuste: string } } | null;
        q2p: { baixa: { idMovest: string; idAjuste: string }; entrada: { idMovest: string; idAjuste: string } } | null;
        pendenciaQ2p: { mensagem: string } | null;
      };
  // Contexto do retorno_comodato para persistencia DENTRO da tx (STK-06):
  // id da movimentacao de baixa + os dois valores unitarios usados no OMIE.
  let retornoCtx: { movBaixaId: string; valorOriginal: number; valorRecebido: number } | null = null;

  try {
    switch (ap.tipoAprovacao) {
      case 'saida_amostra':
      case 'saida_descarte':
      case 'saida_quebra': {
        const r = await executarSaidaOmieDual(
          {
            opId: mov.opId,
            produtoCodigoAcxe: Number(ap.produtoCodigoAcxe),
            galpao: ap.galpao,
            empresa: ap.empresa as 'acxe' | 'q2p',
            quantidadeKg,
            valorUnitario,
            observacao: observacaoOmie,
          },
          'PER',
        );
        resultadoOmie = { kind: 'dual', dual: r };
        break;
      }
      case 'ajuste_inventario': {
        const r = await executarSaidaOmieDual(
          {
            opId: mov.opId,
            produtoCodigoAcxe: Number(ap.produtoCodigoAcxe),
            galpao: ap.galpao,
            empresa: ap.empresa as 'acxe' | 'q2p',
            quantidadeKg,
            valorUnitario,
            observacao: observacaoOmie,
          },
          'INV',
        );
        resultadoOmie = { kind: 'dual', dual: r };
        break;
      }
      case 'saida_transf_intra': {
        if (!mov.galpaoDestino) {
          throw new Error(`Movimentação ${mov.id} de transf_intra_cnpj sem galpao_destino`);
        }
        const r = await executarTransferenciaIntraDual(
          {
            opId: mov.opId,
            produtoCodigoAcxe: Number(ap.produtoCodigoAcxe),
            galpao: ap.galpao,
            empresa: ap.empresa as 'acxe' | 'q2p',
            quantidadeKg,
            valorUnitario,
            observacao: observacaoOmie,
          },
          mov.galpaoDestino,
        );
        resultadoOmie = { kind: 'dual', dual: r };
        break;
      }
      case 'saida_comodato': {
        // Comodato agora e dual (migration 0027 — TROCA criada no ACXE).
        // empresa=q2p e mantida como "primaria" no schema mas a baixa fisica replica em ACXE.
        const r = await executarComodatoOmieDual({
          opId: mov.opId,
          produtoCodigoAcxe: Number(ap.produtoCodigoAcxe),
          galpao: ap.galpao,
          empresa: 'q2p',
          quantidadeKg,
          valorUnitario,
          observacao: observacaoOmie,
        });
        resultadoOmie = { kind: 'dual', dual: r };
        break;
      }
      case 'retorno_comodato': {
        // movimentacao linkada e a ENTRADA destino. Buscar BAIXA TROCA via origem.
        if (!mov.movimentacaoOrigemId) {
          throw new Error(`Movimentação retorno ${mov.id} sem movimentacao_origem_id`);
        }
        const [movOrigem] = await db
          .select()
          .from(movimentacao)
          .where(eq(movimentacao.id, mov.movimentacaoOrigemId))
          .limit(1);
        if (!movOrigem) throw new Error(`Comodato origem ${mov.movimentacaoOrigemId} não encontrado`);
        const [movBaixa] = await db
          .select()
          .from(movimentacao)
          .where(
            and(
              eq(movimentacao.movimentacaoOrigemId, movOrigem.id),
              eq(movimentacao.tipoMovimento, 'ajuste'),
              eq(movimentacao.ativo, true),
            ),
          )
          .limit(1);
        if (!movBaixa) throw new Error(`Movimentação de baixa do TROCA não encontrada para origem ${movOrigem.id}`);

        const valorOriginal = await consultarValorUnitarioProduto(
          Number(movOrigem.produtoCodigoAcxe ?? 0),
          movOrigem.galpao ?? '',
          'q2p',
        );
        // Retorno comodato divergente: produto recebido pode nao ter saldo no
        // destino (consultarValorUnitario retorna 0). Fiscalmente o material que
        // volta tem o custo do que saiu — entao usar valorOriginal como
        // fallback. OMIE rejeita ajuste com valor=0 (erro 400).
        const valorRecebido = valorUnitario > 0 ? valorUnitario : valorOriginal;
        if (valorRecebido <= 0) {
          throw new Error(
            `Sem valor unitario disponível pro retorno: produto recebido ${ap.produtoCodigoAcxe} e original ${movOrigem.produtoCodigoAcxe} ambos sem saldo OMIE`,
          );
        }

        const r = await executarRetornoComodatoOmieDual({
          opId: mov.opId,
          produtoCodigoAcxeOriginal: Number(movOrigem.produtoCodigoAcxe ?? 0),
          quantidadeKgOriginal: Math.abs(Number(movOrigem.quantidadeKg)),
          valorUnitarioOriginal: valorOriginal,
          produtoCodigoAcxeRecebido: Number(ap.produtoCodigoAcxe),
          galpaoDestino: ap.galpao,
          quantidadeKgRecebida: quantidadeKg,
          valorUnitarioRecebido: valorRecebido,
          observacao: observacaoOmie,
        });
        resultadoOmie = { kind: 'retorno_dual', acxe: r.acxe, q2p: r.q2p, pendenciaQ2p: r.pendenciaQ2p };
        // STK-06 (ACXEGDP-286): a persistencia da baixa era feita AQUI, fora e
        // ANTES da transacao, com statusOmie='concluida' incondicional — Q2P
        // pendente sumia do radar e um rollback posterior da tx deixava o update
        // orfao commitado. Agora tudo acontece dentro da tx, condicionado a
        // pendenciaQ2p (ver bloco retorno_dual abaixo).
        retornoCtx = { movBaixaId: movBaixa.id, valorOriginal, valorRecebido };
        break;
      }
      default:
        throw new Error(`Tipo ${ap.tipoAprovacao} não implementado em aprovarSaidaManual`);
    }
  } catch (err) {
    logger.error({ err, aprovacaoId: ap.id, tipo: ap.tipoAprovacao }, 'OMIE falhou ao aprovar saída manual');
    throw err;
  }

  // Persistencia: aprovacao + movimentacao + reserva (em transacao)
  const sinalMv = ap.tipoAprovacao === 'retorno_comodato' ? 1 : -1;
  await db.transaction(async (tx) => {
    // Claim atomico (STK-01): o SELECT+check anterior tinha TOCTOU real aqui —
    // como o passo seguinte e um UPDATE por id em movimentacao (nao um INSERT),
    // nao havia constraint pra derrubar o perdedor da corrida: um duplo-clique
    // sobrescrevia aprovado_por/aprovado_em silenciosamente com 200 OK.
    const [apFresh] = await tx
      .update(aprovacao)
      .set({ status: 'aprovada', aprovadoPor: input.usuarioId, aprovadoEm: new Date() })
      .where(and(eq(aprovacao.id, ap.id), eq(aprovacao.status, 'pendente')))
      .returning();
    if (!apFresh) {
      const [check] = await tx.select().from(aprovacao).where(eq(aprovacao.id, ap.id)).limit(1);
      if (!check) throw new AprovacaoNaoEncontradaError(ap.id);
      throw new AprovacaoStatusInvalidoError(ap.id, check.status);
    }

    // Monta update da movimentacao conforme tipo de resultado OMIE
    const updateMov: Record<string, unknown> = { updatedAt: new Date() };

    if (resultadoOmie.kind === 'dual') {
      const d = resultadoOmie.dual;
      // STK-03 (ACXEGDP-283): persiste o valor unitario usado na chamada OMIE.
      // O retry de pendencia Q2P reusa este valor — recalcular do preco vivo
      // gravaria um custo DIFERENTE do que ACXE ja registrou.
      updateMov.custoUnitarioBrl = String(valorUnitario);
      if (d.acxe) {
        updateMov.mvAcxe = sinalMv;
        updateMov.dtAcxe = new Date();
        updateMov.idMovestAcxe = d.acxe.idMovest;
        updateMov.idAjusteAcxe = d.acxe.idAjuste;
        updateMov.idUserAcxe = input.usuarioId;
      }
      if (d.q2p) {
        updateMov.mvQ2p = sinalMv;
        updateMov.dtQ2p = new Date();
        updateMov.idMovestQ2p = d.q2p.idMovest;
        updateMov.idAjusteQ2p = d.q2p.idAjuste;
        updateMov.idUserQ2p = input.usuarioId;
      }
      updateMov.statusOmie = d.pendenciaQ2p ? 'pendente_q2p' : 'concluida';
      if (d.pendenciaQ2p) {
        updateMov.ultimoErroOmie = {
          lado: 'q2p',
          mensagem: d.pendenciaQ2p.mensagem,
          timestamp: new Date().toISOString(),
        };
        updateMov.tentativasQ2p = 1;
      }
    } else if (resultadoOmie.kind === 'retorno_dual') {
      // movimentacao linkada e a ENTRADA destino
      if (resultadoOmie.acxe) {
        updateMov.mvAcxe = 1;
        updateMov.dtAcxe = new Date();
        updateMov.idMovestAcxe = resultadoOmie.acxe.entrada.idMovest;
        updateMov.idAjusteAcxe = resultadoOmie.acxe.entrada.idAjuste;
        updateMov.idUserAcxe = input.usuarioId;
      }
      if (resultadoOmie.q2p) {
        updateMov.mvQ2p = 1;
        updateMov.dtQ2p = new Date();
        updateMov.idMovestQ2p = resultadoOmie.q2p.entrada.idMovest;
        updateMov.idAjusteQ2p = resultadoOmie.q2p.entrada.idAjuste;
        updateMov.idUserQ2p = input.usuarioId;
      }
      updateMov.statusOmie = resultadoOmie.pendenciaQ2p ? 'pendente_q2p' : 'concluida';
      if (resultadoOmie.pendenciaQ2p) {
        updateMov.ultimoErroOmie = {
          lado: 'q2p',
          mensagem: resultadoOmie.pendenciaQ2p.mensagem,
          timestamp: new Date().toISOString(),
        };
        updateMov.tentativasQ2p = 1;
      }
      // STK-03b: valor da ENTRADA persistido pro retry reusar o mesmo preco.
      if (retornoCtx) updateMov.custoUnitarioBrl = String(retornoCtx.valorRecebido);

      // STK-06 (ACXEGDP-286): persistencia da BAIXA do TROCA — dentro da tx e
      // condicionada a pendenciaQ2p. Se Q2P falhou apos ACXE ok, AMBAS as
      // movimentacoes ficam pendente_q2p (antes a baixa era marcada 'concluida'
      // incondicionalmente e o lado Q2P dela sumia do painel de retry).
      if (retornoCtx) {
        const r = resultadoOmie;
        const updateBaixa: Record<string, unknown> = {
          statusOmie: r.pendenciaQ2p ? 'pendente_q2p' : 'concluida',
          custoUnitarioBrl: String(retornoCtx.valorOriginal),
          updatedAt: new Date(),
        };
        if (r.acxe) {
          updateBaixa.idMovestAcxe = r.acxe.baixa.idMovest;
          updateBaixa.idAjusteAcxe = r.acxe.baixa.idAjuste;
          updateBaixa.mvAcxe = -1;
          updateBaixa.dtAcxe = new Date();
          updateBaixa.idUserAcxe = input.usuarioId;
        }
        if (r.q2p) {
          updateBaixa.idMovestQ2p = r.q2p.baixa.idMovest;
          updateBaixa.idAjusteQ2p = r.q2p.baixa.idAjuste;
          updateBaixa.mvQ2p = -1;
          updateBaixa.dtQ2p = new Date();
          updateBaixa.idUserQ2p = input.usuarioId;
        }
        if (r.pendenciaQ2p) {
          updateBaixa.ultimoErroOmie = {
            lado: 'q2p',
            mensagem: r.pendenciaQ2p.mensagem,
            timestamp: new Date().toISOString(),
          };
          updateBaixa.tentativasQ2p = 1;
        }
        await tx.update(movimentacao).set(updateBaixa).where(eq(movimentacao.id, retornoCtx.movBaixaId));
      }
    }

    await tx.update(movimentacao).set(updateMov).where(eq(movimentacao.id, ap.movimentacaoId!));

    // Marca reserva como consumida (se houver — retorno_comodato nao tem reserva)
    await tx
      .update(reservaSaldo)
      .set({ status: 'consumida', resolvidoEm: new Date() })
      .where(and(eq(reservaSaldo.movimentacaoId, ap.movimentacaoId!), eq(reservaSaldo.status, 'ativa')));
  });

  logger.info(
    { aprovacaoId: ap.id, tipo: ap.tipoAprovacao, resultadoOmie },
    'Saída manual aprovada e baixada no OMIE',
  );

  // Notifica operador (fora da tx)
  await enviarNotificacaoAprovacaoOperador({
    operadorUserId: ap.lancadoPor,
    aprovacaoId: ap.id,
    tipoAprovacao: ap.tipoAprovacao,
    loteId: ap.loteId ?? ap.movimentacaoId!,
  }).catch((err) => logger.error({ err }, 'Falha ao notificar aprovação saída manual'));

  return { id: ap.id, loteStatus: 'reconciliado' };
}

/**
 * Resolve valor unitario (BRL/kg) de um SKU em um galpao+empresa.
 * Usa media ponderada de vw_posicaoEstoqueUnificadaFamilia.valor_unitario sobre
 * saldo. Estrategia em 2 niveis: (1) galpao especifico; (2) qualquer galpao da
 * empresa com saldo (caso comum em retorno comodato divergente, onde o produto
 * recebido pode nao ter saldo no destino). Caller deve tratar o caso 0 — OMIE
 * REJEITA ajuste com valor=0 (erro 400) apesar do que parecia ate descobrirmos.
 *
 * Exportada para o retry de saida manual (operacoes-pendentes, STK-03) como
 * FALLBACK para movimentacoes antigas sem custo_unitario_brl persistido — o
 * caminho normal do retry reusa o valor gravado na aprovacao original.
 */
export async function consultarValorUnitarioProduto(
  produtoCodigoAcxe: number,
  galpao: string,
  empresa: 'acxe' | 'q2p',
): Promise<number> {
  const db = getDb();
  const filtroEmp =
    empresa === 'acxe'
      ? `(o.codigo_estoque LIKE '%.1' AND o.empresa = 'ACXE')`
      : `((o.codigo_estoque LIKE '%.1' OR o.codigo_estoque LIKE '%.2') AND o.empresa = 'Q2P')`;

  // 1. Tenta no galpao especifico (saldo ponderado)
  const especifico = await db.execute<{ vu: string | null }>(sql`
    WITH desc_sku AS (
      SELECT descricao FROM public."tbl_produtos_ACXE"
      WHERE codigo_produto = ${produtoCodigoAcxe}::bigint
      LIMIT 1
    )
    SELECT (
      CASE WHEN SUM(o.saldo) > 0
        THEN SUM(o.saldo * o.valor_unitario) / SUM(o.saldo)
        ELSE 0
      END
    )::text AS vu
    FROM public."vw_posicaoEstoqueUnificadaFamilia" o
    INNER JOIN desc_sku d ON d.descricao = o.descricao_produto
    WHERE o.saldo > 0
      AND o.codigo_estoque = ${galpao}
      AND ${sql.raw(filtroEmp)}
  `);
  const vEspec = especifico.rows[0]?.vu ? Number(especifico.rows[0]?.vu) : 0;
  if (vEspec > 0) return vEspec;

  // 2. Fallback: qualquer galpao da mesma empresa com saldo (produto novo no
  //    destino comum em retorno comodato divergente — usa custo medio do SKU
  //    onde quer que ele exista).
  const crossGalpao = await db.execute<{ vu: string | null }>(sql`
    WITH desc_sku AS (
      SELECT descricao FROM public."tbl_produtos_ACXE"
      WHERE codigo_produto = ${produtoCodigoAcxe}::bigint
      LIMIT 1
    )
    SELECT (
      CASE WHEN SUM(o.saldo) > 0
        THEN SUM(o.saldo * o.valor_unitario) / SUM(o.saldo)
        ELSE 0
      END
    )::text AS vu
    FROM public."vw_posicaoEstoqueUnificadaFamilia" o
    INNER JOIN desc_sku d ON d.descricao = o.descricao_produto
    WHERE o.saldo > 0
      AND ${sql.raw(filtroEmp)}
  `);
  const vCross = crossGalpao.rows[0]?.vu ? Number(crossGalpao.rows[0]?.vu) : 0;
  return vCross;
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
