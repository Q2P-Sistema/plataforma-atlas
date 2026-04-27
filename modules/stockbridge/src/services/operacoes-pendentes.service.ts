import { eq, sql, and, ne, desc } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { getDb, createLogger } from '@atlas/core';
import { movimentacao, lote, localidadeCorrelacao, aprovacao } from '@atlas/db';
import type { Perfil, StatusOmie } from '../types.js';
import { COD_INT_AJUSTE_SUFIXO, buildCodIntAjuste } from '../types.js';
import { incluirAjusteIdempotente } from './omie-idempotente.js';
import { calcularValorUnitarioQ2p, calcularValorUnitarioAcxe } from './recebimento.service.js';
import { resolverEstoqueDiferencaAcxe } from './estoques-especiais-acxe.js';

const logger = createLogger('stockbridge:operacoes-pendentes');

/**
 * Limite de retentativas que o OPERADOR pode fazer no lado Q2P.
 * Tentativa 0 = inicial (durante processarRecebimento).
 * Tentativa 1 = primeira chamada via endpoint /retentar.
 * A partir de tentativa 2, somente gestor/diretor pode retentar.
 */
const LIMITE_TENTATIVAS_OPERADOR_Q2P = 2;

export class OperacaoPendenteNaoEncontradaError extends Error {
  constructor(public readonly id: string) {
    super(`Movimentacao ${id} nao encontrada ou ja concluida`);
    this.name = 'OperacaoPendenteNaoEncontradaError';
  }
}

export class OperacaoNaoPendenteError extends Error {
  constructor(public readonly id: string, public readonly statusOmie: string) {
    super(`Movimentacao ${id} esta com status_omie='${statusOmie}' — nao requer retry`);
    this.name = 'OperacaoNaoPendenteError';
  }
}

export class OperadorSemRetentativasError extends Error {
  constructor(public readonly id: string, public readonly tentativasFeitas: number) {
    super(
      `Operador ja esgotou as ${tentativasFeitas} tentativas de retry. ` +
        'Acione um gestor/diretor para continuar.',
    );
    this.name = 'OperadorSemRetentativasError';
  }
}

export interface OperacaoPendenteItem {
  id: string;
  opId: string;
  notaFiscal: string;
  ladoPendente: 'q2p' | 'acxe-faltando';
  statusOmie: StatusOmie;
  tentativas: number;
  ultimoErro: { lado: string; mensagem: string; timestamp: string } | null;
  createdAt: string;
  lote: {
    id: string | null;
    codigo: string | null;
    fornecedorNome: string | null;
    produtoCodigoAcxe: number | null;
    quantidadeKg: number;
  };
}

/**
 * Lista todas as movimentacoes com OMIE pendente (status_omie != 'concluida' e != 'falha').
 * Ordenada por created_at desc — pendencias mais recentes no topo.
 */
export async function listarPendentes(): Promise<OperacaoPendenteItem[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: movimentacao.id,
      opId: movimentacao.opId,
      notaFiscal: movimentacao.notaFiscal,
      statusOmie: movimentacao.statusOmie,
      tentativasQ2p: movimentacao.tentativasQ2p,
      tentativasAcxeFaltando: movimentacao.tentativasAcxeFaltando,
      ultimoErroOmie: movimentacao.ultimoErroOmie,
      quantidadeKg: movimentacao.quantidadeKg,
      createdAt: movimentacao.createdAt,
      loteId: movimentacao.loteId,
      loteCodigo: lote.codigo,
      fornecedorNome: lote.fornecedorNome,
      produtoCodigoAcxe: lote.produtoCodigoAcxe,
    })
    .from(movimentacao)
    .leftJoin(lote, eq(lote.id, movimentacao.loteId))
    .where(
      and(
        ne(movimentacao.statusOmie, 'concluida'),
        ne(movimentacao.statusOmie, 'falha'),
        eq(movimentacao.ativo, true),
      ),
    )
    .orderBy(sql`${movimentacao.createdAt} DESC`);

  return rows.map((r) => {
    const ladoPendente: 'q2p' | 'acxe-faltando' =
      r.statusOmie === 'pendente_q2p' ? 'q2p' : 'acxe-faltando';
    const tentativas =
      ladoPendente === 'q2p' ? r.tentativasQ2p : r.tentativasAcxeFaltando;
    const ultimoErroRaw = r.ultimoErroOmie as
      | { lado?: string; mensagem?: string; timestamp?: string }
      | null;
    return {
      id: r.id,
      opId: r.opId,
      notaFiscal: r.notaFiscal,
      ladoPendente,
      statusOmie: r.statusOmie as StatusOmie,
      tentativas,
      ultimoErro: ultimoErroRaw
        ? {
            lado: ultimoErroRaw.lado ?? 'desconhecido',
            mensagem: ultimoErroRaw.mensagem ?? '',
            timestamp: ultimoErroRaw.timestamp ?? '',
          }
        : null,
      createdAt: r.createdAt.toISOString(),
      lote: {
        id: r.loteId,
        codigo: r.loteCodigo,
        fornecedorNome: r.fornecedorNome,
        produtoCodigoAcxe: r.produtoCodigoAcxe,
        quantidadeKg: Number(r.quantidadeKg),
      },
    };
  });
}

export interface MarcarFalhaInput {
  movimentacaoId: string;
  motivo: string;
  ator: { userId: string; role: Perfil };
}

/**
 * Marca uma movimentacao pendente como falha definitiva (nao-recuperavel).
 * Apenas gestor/diretor pode fazer. Status_omie='falha' tira o item do painel
 * de pendencias mas mantem o registro para auditoria.
 */
export async function marcarComoFalhaDefinitiva(input: MarcarFalhaInput): Promise<{ id: string }> {
  if (input.ator.role === 'operador') {
    throw new OperadorSemRetentativasError(input.movimentacaoId, -1);
  }
  if (!input.motivo || input.motivo.trim().length === 0) {
    throw new Error('Motivo obrigatorio para marcar operacao como falha');
  }
  const db = getDb();
  const [mov] = await db
    .select()
    .from(movimentacao)
    .where(eq(movimentacao.id, input.movimentacaoId))
    .limit(1);
  if (!mov) throw new OperacaoPendenteNaoEncontradaError(input.movimentacaoId);
  if (mov.statusOmie === 'concluida' || mov.statusOmie === 'falha') {
    throw new OperacaoNaoPendenteError(input.movimentacaoId, mov.statusOmie);
  }

  await db
    .update(movimentacao)
    .set({
      statusOmie: 'falha',
      ultimoErroOmie: {
        lado: 'manual',
        mensagem: `Marcado como falha por ${input.ator.role}: ${input.motivo}`,
        timestamp: new Date().toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(eq(movimentacao.id, input.movimentacaoId));

  logger.info(
    { movimentacaoId: input.movimentacaoId, ator: input.ator, motivo: input.motivo },
    'Movimentacao marcada como falha definitiva',
  );

  return { id: input.movimentacaoId };
}

export interface RetentarInput {
  movimentacaoId: string;
  ator: { userId: string; role: Perfil };
}

export interface RetentarResult {
  movimentacaoId: string;
  statusOmie: 'concluida' | 'pendente_q2p' | 'pendente_acxe_faltando' | 'falha';
  jaExistiaNoOmie?: boolean;
  tentativasQ2p: number;
}

/**
 * Retenta o lado pendente de uma movimentacao.
 * - Operador: maximo de LIMITE_TENTATIVAS_OPERADOR_Q2P tentativas no Q2P; bloqueado em pendente_acxe_faltando.
 * - Gestor/diretor: sem limite de tentativas, ambos os lados.
 *
 * Usa cod_int_ajuste para garantir idempotencia: se a chamada anterior chegou a
 * persistir no OMIE (mas a resposta HTTP se perdeu), ListarAjusteEstoque detecta
 * e a movimentacao e marcada como concluida sem nova inclusao.
 */
export async function retentarOperacaoPendente(input: RetentarInput): Promise<RetentarResult> {
  const db = getDb();

  const [mov] = await db
    .select()
    .from(movimentacao)
    .where(eq(movimentacao.id, input.movimentacaoId))
    .limit(1);
  if (!mov) throw new OperacaoPendenteNaoEncontradaError(input.movimentacaoId);
  if (mov.statusOmie === 'concluida') {
    throw new OperacaoNaoPendenteError(input.movimentacaoId, mov.statusOmie);
  }
  if (mov.statusOmie === 'falha') {
    throw new OperacaoNaoPendenteError(input.movimentacaoId, mov.statusOmie);
  }

  // RBAC: operador so pode retentar Q2P, e ate o limite definido.
  // pendente_acxe_faltando e admin-only (operador NAO tem permissao mesmo na 1a tentativa).
  if (input.ator.role === 'operador') {
    if (mov.statusOmie !== 'pendente_q2p') {
      throw new OperadorSemRetentativasError(input.movimentacaoId, mov.tentativasAcxeFaltando ?? -1);
    }
    if (mov.tentativasQ2p >= LIMITE_TENTATIVAS_OPERADOR_Q2P) {
      throw new OperadorSemRetentativasError(input.movimentacaoId, mov.tentativasQ2p);
    }
  }

  if (mov.statusOmie === 'pendente_q2p') {
    return retentarQ2p({ mov, ator: input.ator });
  }
  if (mov.statusOmie === 'pendente_acxe_faltando') {
    // Operador foi bloqueado acima (so gestor/diretor); aqui ja sabemos que e admin.
    return retentarAcxeFaltando({ mov, ator: input.ator });
  }
  throw new OperacaoNaoPendenteError(input.movimentacaoId, mov.statusOmie);
}

interface MovimentacaoRow {
  id: string;
  opId: string;
  loteId: string | null;
  notaFiscal: string;
  quantidadeKg: string;
  tentativasQ2p: number;
  idMovestAcxe: string | null;
  idAjusteAcxe: string | null;
}

async function retentarQ2p(args: {
  mov: MovimentacaoRow;
  ator: RetentarInput['ator'];
}): Promise<RetentarResult> {
  const db = getDb();
  if (!args.mov.loteId) {
    throw new Error(`Movimentacao ${args.mov.id} sem loteId — nao e possivel retentar`);
  }
  const [loteRow] = await db.select().from(lote).where(eq(lote.id, args.mov.loteId)).limit(1);
  if (!loteRow) throw new Error(`Lote ${args.mov.loteId} nao encontrado`);
  if (!loteRow.localidadeId) {
    throw new Error(`Lote ${loteRow.codigo} sem localidade — nao e possivel retentar Q2P`);
  }
  const [corr] = await db
    .select()
    .from(localidadeCorrelacao)
    .where(eq(localidadeCorrelacao.localidadeId, loteRow.localidadeId))
    .limit(1);
  if (!corr?.codigoLocalEstoqueQ2p) {
    throw new Error(`Localidade ${loteRow.localidadeId} sem correlato Q2P`);
  }
  if (!loteRow.produtoCodigoQ2p) {
    throw new Error(`Lote ${loteRow.codigo} sem produtoCodigoQ2p`);
  }
  if (!loteRow.valorTotalNfBrl || !loteRow.quantidadeFiscalKg) {
    throw new Error(
      `Lote ${loteRow.codigo} sem dados de NF persistidos — nao e possivel calcular valor unitario Q2P`,
    );
  }

  const qtdKg = Number(args.mov.quantidadeKg);
  const qtdNfKg = Number(loteRow.quantidadeFiscalKg);
  const vNF = Number(loteRow.valorTotalNfBrl);
  const valorUnitQ2p = calcularValorUnitarioQ2p(vNF, qtdNfKg);

  try {
    const res = await incluirAjusteIdempotente(
      'q2p',
      buildCodIntAjuste(args.mov.opId, COD_INT_AJUSTE_SUFIXO.q2pEnt),
      {
        codigoLocalEstoque: String(corr.codigoLocalEstoqueQ2p),
        idProduto: Number(loteRow.produtoCodigoQ2p),
        dataAtual: formatarDataBR(new Date()),
        quantidade: new Decimal(qtdKg).toNumber(),
        observacao: `Retry Q2P NF ${args.mov.notaFiscal} (op ${args.mov.opId})`,
        origem: 'AJU',
        tipo: 'ENT',
        motivo: 'INI',
        valor: valorUnitQ2p,
      },
      { verificarAntes: true },
    );

    // Sucesso: atualiza movimentacao para concluida com IDs Q2P
    await db
      .update(movimentacao)
      .set({
        idMovestQ2p: res.idMovest,
        idAjusteQ2p: res.idAjuste,
        mvQ2p: 1,
        dtQ2p: new Date(),
        idUserQ2p: args.ator.userId,
        statusOmie: 'concluida',
        ultimoErroOmie: null,
        updatedAt: new Date(),
      })
      .where(eq(movimentacao.id, args.mov.id));

    logger.info(
      {
        movimentacaoId: args.mov.id,
        opId: args.mov.opId,
        ator: args.ator,
        jaExistia: res.jaExistia,
      },
      'Operacao pendente Q2P concluida via retry',
    );

    return {
      movimentacaoId: args.mov.id,
      statusOmie: 'concluida',
      jaExistiaNoOmie: res.jaExistia,
      tentativasQ2p: args.mov.tentativasQ2p,
    };
  } catch (err) {
    const novasTentativas = args.mov.tentativasQ2p + 1;
    await db
      .update(movimentacao)
      .set({
        tentativasQ2p: novasTentativas,
        ultimoErroOmie: {
          lado: 'q2p',
          mensagem: (err as Error)?.message ?? 'erro desconhecido',
          timestamp: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(movimentacao.id, args.mov.id));

    logger.warn(
      {
        movimentacaoId: args.mov.id,
        opId: args.mov.opId,
        tentativasQ2p: novasTentativas,
        ator: args.ator,
        err,
      },
      'Retry Q2P falhou — incrementando tentativas',
    );
    throw err;
  }
}

async function retentarAcxeFaltando(args: {
  mov: { id: string; opId: string; loteId: string | null; quantidadeKg: string; tentativasAcxeFaltando: number };
  ator: RetentarInput['ator'];
}): Promise<RetentarResult> {
  const db = getDb();
  if (!args.mov.loteId) {
    throw new Error(`Movimentacao ${args.mov.id} sem loteId — nao e possivel retentar`);
  }
  const [loteRow] = await db.select().from(lote).where(eq(lote.id, args.mov.loteId)).limit(1);
  if (!loteRow) throw new Error(`Lote ${args.mov.loteId} nao encontrado`);
  if (
    !loteRow.codigoLocalEstoqueOrigemAcxe ||
    !loteRow.notaFiscal ||
    !loteRow.valorTotalNfBrl ||
    !loteRow.localidadeId
  ) {
    throw new Error(`Lote ${loteRow.codigo} sem dados da NF persistidos para retry ACXE-faltando`);
  }
  const [corr] = await db
    .select()
    .from(localidadeCorrelacao)
    .where(eq(localidadeCorrelacao.localidadeId, loteRow.localidadeId))
    .limit(1);
  if (!corr?.codigoLocalEstoqueAcxe) {
    throw new Error(`Localidade ${loteRow.localidadeId} sem correlato ACXE`);
  }

  // Recupera tipoDivergencia da aprovacao mais recente do lote (status 'aprovada').
  const [apr] = await db
    .select()
    .from(aprovacao)
    .where(and(eq(aprovacao.loteId, args.mov.loteId), eq(aprovacao.status, 'aprovada')))
    .orderBy(desc(aprovacao.aprovadoEm))
    .limit(1);
  if (!apr || !apr.tipoDivergencia || (apr.tipoDivergencia !== 'faltando' && apr.tipoDivergencia !== 'varredura')) {
    throw new Error(
      `Aprovacao do lote ${loteRow.codigo} nao indica tipoDivergencia faltando/varredura — nao e possivel retentar`,
    );
  }

  const qtdAprovadaKg = Number(args.mov.quantidadeKg);
  const qtdNfKg = Number(loteRow.quantidadeFiscalKg);
  const qtdDiferencaKg = Number(new Decimal(qtdNfKg).minus(qtdAprovadaKg).toFixed(3));
  if (qtdDiferencaKg <= 0) {
    throw new Error(`Lote ${loteRow.codigo} sem diferenca a transferir`);
  }
  const vNF = Number(loteRow.valorTotalNfBrl);
  const valorUnitAcxe = calcularValorUnitarioAcxe(vNF, qtdNfKg);
  const codigoLocalEstoqueDiferenca = resolverEstoqueDiferencaAcxe({
    tipoDivergencia: apr.tipoDivergencia,
    codigoLocalEstoqueDestinoAcxe: corr.codigoLocalEstoqueAcxe,
  });

  try {
    const res = await incluirAjusteIdempotente(
      'acxe',
      buildCodIntAjuste(args.mov.opId, COD_INT_AJUSTE_SUFIXO.acxeFaltando),
      {
        codigoLocalEstoque: loteRow.codigoLocalEstoqueOrigemAcxe,
        codigoLocalEstoqueDestino: codigoLocalEstoqueDiferenca,
        idProduto: Number(loteRow.produtoCodigoAcxe),
        dataAtual: formatarDataBR(new Date()),
        quantidade: qtdDiferencaKg,
        observacao: `Retry ACXE-faltando NF ${loteRow.notaFiscal} (op ${args.mov.opId}, ${apr.tipoDivergencia})`,
        origem: 'AJU',
        tipo: 'TRF',
        motivo: 'TRF',
        valor: valorUnitAcxe,
      },
      { verificarAntes: true },
    );

    await db
      .update(movimentacao)
      .set({
        statusOmie: 'concluida',
        ultimoErroOmie: null,
        updatedAt: new Date(),
      })
      .where(eq(movimentacao.id, args.mov.id));

    logger.info(
      {
        movimentacaoId: args.mov.id,
        opId: args.mov.opId,
        ator: args.ator,
        idAjusteFaltando: res.idAjuste,
        jaExistia: res.jaExistia,
        qtdDiferencaKg,
        tipoDivergencia: apr.tipoDivergencia,
      },
      'Operacao pendente acxe-faltando concluida via retry',
    );

    return {
      movimentacaoId: args.mov.id,
      statusOmie: 'concluida',
      jaExistiaNoOmie: res.jaExistia,
      tentativasQ2p: 0,
    };
  } catch (err) {
    const novasTentativas = args.mov.tentativasAcxeFaltando + 1;
    await db
      .update(movimentacao)
      .set({
        tentativasAcxeFaltando: novasTentativas,
        ultimoErroOmie: {
          lado: 'acxe-faltando',
          mensagem: (err as Error)?.message ?? 'erro desconhecido',
          timestamp: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(movimentacao.id, args.mov.id));

    logger.warn(
      {
        movimentacaoId: args.mov.id,
        opId: args.mov.opId,
        tentativasAcxeFaltando: novasTentativas,
        ator: args.ator,
        err,
      },
      'Retry ACXE-faltando falhou — incrementando tentativas',
    );
    throw err;
  }
}

function formatarDataBR(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}
