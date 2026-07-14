import Decimal from 'decimal.js';
import { eq, sql } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { incluirAjusteEstoque } from '@atlas/integration-omie';
import { localidade, localidadeCorrelacao } from '@atlas/db';
import type { EmpresaSaida } from './saida-manual.service.js';
import { formatarDataOmie } from './omie-shared.js';
import { COD_INT_AJUSTE_SUFIXO, buildCodIntAjuste } from '../types.js';

const logger = createLogger('stockbridge:omie-saida');

const CODIGO_TROCA_Q2P = '90.0.1';

export class CorrelacaoOmieAusenteError extends Error {
  constructor(public readonly contexto: string) {
    super(`Correlação OMIE ausente: ${contexto}`);
    this.name = 'CorrelacaoOmieAusenteError';
  }
}

interface ContextoMovimentacao {
  /** op_id da movimentacao Atlas (UUID) — usado pra cod_int_ajuste idempotente. */
  opId: string;
  produtoCodigoAcxe: number;
  /** Prefixo do galpao no Atlas (ex: '11', '13', '40'). */
  galpao: string;
  empresa: EmpresaSaida;
  quantidadeKg: number;
  /** Valor unitario (BRL/kg) — pode ser 0 quando nao se aplica (saida sem custo). */
  valorUnitario: number;
  /** Texto curto pra `obs` no OMIE (ate 250 chars). */
  observacao: string;
}

/**
 * Resolve correlacao OMIE completa de um sub-estoque (codigos em ACXE + Q2P).
 * Migration 0030: granularidade agora e por sub-estoque exato (11.1, 11.2,
 * 12.1, 12.2, 21.1, 31.1) — nao mais por agregador 11/12/21/31.
 *
 * Galpoes espelhados (.1) tem ambas correlacoes; nacionais (.2) so Q2P.
 */
export async function resolverCorrelacaoCompletaGalpao(
  galpao: string,
): Promise<{ acxe: string | null; q2p: string | null }> {
  const db = getDb();
  const result = await db.execute<{ acxe: string | null; q2p: string | null }>(sql`
    SELECT
      c.codigo_local_estoque_acxe::text AS acxe,
      c.codigo_local_estoque_q2p::text AS q2p
    FROM stockbridge.localidade l
    INNER JOIN stockbridge.localidade_correlacao c ON c.localidade_id = l.id
    WHERE l.codigo = ${galpao}
      AND l.tipo = 'proprio'
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row || (!row.acxe && !row.q2p)) {
    throw new CorrelacaoOmieAusenteError(
      `galpao=${galpao} sem correlação OMIE em stockbridge.localidade_correlacao`,
    );
  }
  return { acxe: row.acxe, q2p: row.q2p };
}

/**
 * Resolve o codigo_local_estoque OMIE para um galpao+empresa.
 * Mantida pra compatibilidade com chamadas single-empresa (comodato Q2P-only,
 * retorno comodato).
 */
export async function resolverCodigoLocalEstoque(
  galpao: string,
  empresa: EmpresaSaida,
): Promise<string> {
  const correlacao = await resolverCorrelacaoCompletaGalpao(galpao);
  const codigo = empresa === 'acxe' ? correlacao.acxe : correlacao.q2p;
  if (!codigo) {
    throw new CorrelacaoOmieAusenteError(
      `galpao=${galpao} empresa=${empresa} — sem correlação OMIE`,
    );
  }
  return codigo;
}

/**
 * Resolve o codigo do produto na empresa OMIE alvo.
 *  - empresa='acxe': retorna o proprio codigoAcxe
 *  - empresa='q2p': busca em tbl_produtos_Q2P pelo match de descricao com
 *    tbl_produtos_ACXE.descricao (mesma estrategia cross-empresa do legado).
 *
 * Throw se Q2P nao tiver correlato — bloqueia a chamada OMIE com erro claro.
 */
export async function resolverCodigoProdutoOmie(
  codigoAcxe: number,
  empresa: EmpresaSaida,
): Promise<number> {
  if (empresa === 'acxe') return codigoAcxe;

  const db = getDb();
  const result = await db.execute<{ codigo_q2p: string | null }>(sql`
    SELECT pq.codigo_produto::text AS codigo_q2p
    FROM public."tbl_produtos_ACXE" pa
    INNER JOIN public."tbl_produtos_Q2P" pq ON pq.descricao = pa.descricao
    WHERE pa.codigo_produto = ${codigoAcxe}::bigint
    LIMIT 1
  `);
  const codigo = result.rows[0]?.codigo_q2p;
  if (!codigo) {
    throw new CorrelacaoOmieAusenteError(
      `produto ACXE ${codigoAcxe} não tem correlato Q2P (match por descrição em tbl_produtos_Q2P)`,
    );
  }
  return Number(codigo);
}

export async function resolverCodigosLocaisTroca(): Promise<{ acxe: string | null; q2p: string | null }> {
  const db = getDb();
  const [row] = await db
    .select({
      acxe: localidadeCorrelacao.codigoLocalEstoqueAcxe,
      q2p: localidadeCorrelacao.codigoLocalEstoqueQ2p,
    })
    .from(localidade)
    .innerJoin(localidadeCorrelacao, eq(localidadeCorrelacao.localidadeId, localidade.id))
    .where(eq(localidade.codigo, CODIGO_TROCA_Q2P))
    .limit(1);
  return {
    acxe: row?.acxe != null ? String(row.acxe) : null,
    q2p: row?.q2p != null ? String(row.q2p) : null,
  };
}

interface ResultadoOmie {
  idMovest: string;
  idAjuste: string;
}

export interface ResultadoDual {
  acxe: ResultadoOmie | null;
  q2p: ResultadoOmie | null;
  /** Quando ACXE ok mas Q2P falhou (recuperavel). Movimentacao deve ser
   *  gravada com status_omie='pendente_q2p' pra retry posterior. */
  pendenciaQ2p: { mensagem: string } | null;
}

/**
 * Saida pura via tipo=SAI (debit sem destino).
 *  - amostra/descarte/quebra → motivo=PER
 *  - inventario_menos → motivo=INV
 *
 * Dispara em **ambas as empresas** quando o galpao e espelhado (.1) ou tem
 * codigo OMIE em ACXE e Q2P. Galpoes nacionais Q2P-only (.2) → so Q2P.
 *
 * Idempotencia: cod_int_ajuste = ${opId}:saida-${motivo}-${empresa}.
 * Erro recuperavel: ACXE ok + Q2P falha → grava pendencia (mesmo padrao recebimento).
 */
export async function executarSaidaOmieDual(
  ctx: ContextoMovimentacao,
  motivo: 'PER' | 'INV',
): Promise<ResultadoDual> {
  const correlacao = await resolverCorrelacaoCompletaGalpao(ctx.galpao);
  const valor = Number(new Decimal(ctx.valorUnitario).toFixed(2));
  const qtd = Number(new Decimal(ctx.quantidadeKg).toFixed(3));
  const obs = ctx.observacao.slice(0, 240);
  const data = formatarDataOmie();

  let acxeRes: ResultadoOmie | null = null;
  let q2pRes: ResultadoOmie | null = null;
  let pendenciaQ2p: { mensagem: string } | null = null;

  // 1) ACXE primeiro (rollback-friendly: se ACXE falha, nada feito ainda)
  if (correlacao.acxe) {
    const codInt = buildCodIntAjuste(
      ctx.opId,
      motivo === 'PER' ? COD_INT_AJUSTE_SUFIXO.saidaPerAcxe : COD_INT_AJUSTE_SUFIXO.saidaInvAcxe,
    );
    logger.info({ ctx, codigoLocalEstoque: correlacao.acxe, motivo, codInt }, 'OMIE ACXE: incluindo SAI');
    const r = await incluirAjusteEstoque('acxe', {
      codigoLocalEstoque: correlacao.acxe,
      idProduto: ctx.produtoCodigoAcxe, // ACXE = codigo canonico
      dataAtual: data,
      quantidade: qtd,
      observacao: obs,
      origem: 'AJU',
      tipo: 'SAI',
      motivo,
      valor,
      codIntAjuste: codInt,
    });
    acxeRes = { idMovest: r.idMovest, idAjuste: r.idAjuste };
  }

  // 2) Q2P — se falhar apos ACXE ok, marca pendencia
  if (correlacao.q2p) {
    try {
      const idProdutoQ2p = await resolverCodigoProdutoOmie(ctx.produtoCodigoAcxe, 'q2p');
      const codInt = buildCodIntAjuste(
        ctx.opId,
        motivo === 'PER' ? COD_INT_AJUSTE_SUFIXO.saidaPerQ2p : COD_INT_AJUSTE_SUFIXO.saidaInvQ2p,
      );
      logger.info(
        { ctx, codigoLocalEstoque: correlacao.q2p, idProdutoQ2p, motivo, codInt },
        'OMIE Q2P: incluindo SAI',
      );
      const r = await incluirAjusteEstoque('q2p', {
        codigoLocalEstoque: correlacao.q2p,
        idProduto: idProdutoQ2p,
        dataAtual: data,
        quantidade: qtd,
        observacao: obs,
        origem: 'AJU',
        tipo: 'SAI',
        motivo,
        valor,
        codIntAjuste: codInt,
      });
      q2pRes = { idMovest: r.idMovest, idAjuste: r.idAjuste };
    } catch (err) {
      if (acxeRes) {
        // ACXE ja foi — registra pendencia pra retry
        logger.error(
          { err, acxeRes, opId: ctx.opId },
          'OMIE Q2P falhou após ACXE ok — pendência recuperavel',
        );
        pendenciaQ2p = { mensagem: (err as Error).message ?? 'erro Q2P desconhecido' };
      } else {
        throw err;
      }
    }
  }

  return { acxe: acxeRes, q2p: q2pRes, pendenciaQ2p };
}

/**
 * Transferencia entre galpoes via tipo=TRF — replicada nas duas empresas
 * espelhadas. Subtipo: transf_intra_cnpj.
 */
export async function executarTransferenciaIntraDual(
  ctx: ContextoMovimentacao,
  galpaoDestino: string,
): Promise<ResultadoDual> {
  const corrOrigem = await resolverCorrelacaoCompletaGalpao(ctx.galpao);
  const corrDestino = await resolverCorrelacaoCompletaGalpao(galpaoDestino);
  const valor = Number(new Decimal(ctx.valorUnitario).toFixed(2));
  const qtd = Number(new Decimal(ctx.quantidadeKg).toFixed(3));
  const obs = ctx.observacao.slice(0, 240);
  const data = formatarDataOmie();

  let acxeRes: ResultadoOmie | null = null;
  let q2pRes: ResultadoOmie | null = null;
  let pendenciaQ2p: { mensagem: string } | null = null;

  // Replica em ACXE quando ambos origem/destino tem ACXE
  if (corrOrigem.acxe && corrDestino.acxe) {
    const codInt = buildCodIntAjuste(ctx.opId, COD_INT_AJUSTE_SUFIXO.trfIntraAcxe);
    logger.info(
      { ctx, origem: corrOrigem.acxe, destino: corrDestino.acxe, codInt },
      'OMIE ACXE: incluindo TRF intra-cnpj',
    );
    const r = await incluirAjusteEstoque('acxe', {
      codigoLocalEstoque: corrOrigem.acxe,
      codigoLocalEstoqueDestino: corrDestino.acxe,
      idProduto: ctx.produtoCodigoAcxe,
      dataAtual: data,
      quantidade: qtd,
      observacao: obs,
      origem: 'AJU',
      tipo: 'TRF',
      motivo: 'TRF',
      valor,
      codIntAjuste: codInt,
    });
    acxeRes = { idMovest: r.idMovest, idAjuste: r.idAjuste };
  }

  if (corrOrigem.q2p && corrDestino.q2p) {
    try {
      const idProdutoQ2p = await resolverCodigoProdutoOmie(ctx.produtoCodigoAcxe, 'q2p');
      const codInt = buildCodIntAjuste(ctx.opId, COD_INT_AJUSTE_SUFIXO.trfIntraQ2p);
      logger.info(
        { ctx, origem: corrOrigem.q2p, destino: corrDestino.q2p, codInt },
        'OMIE Q2P: incluindo TRF intra-cnpj',
      );
      const r = await incluirAjusteEstoque('q2p', {
        codigoLocalEstoque: corrOrigem.q2p,
        codigoLocalEstoqueDestino: corrDestino.q2p,
        idProduto: idProdutoQ2p,
        dataAtual: data,
        quantidade: qtd,
        observacao: obs,
        origem: 'AJU',
        tipo: 'TRF',
        motivo: 'TRF',
        valor,
        codIntAjuste: codInt,
      });
      q2pRes = { idMovest: r.idMovest, idAjuste: r.idAjuste };
    } catch (err) {
      if (acxeRes) {
        pendenciaQ2p = { mensagem: (err as Error).message ?? 'erro Q2P TRF desconhecido' };
      } else {
        throw err;
      }
    }
  }

  return { acxe: acxeRes, q2p: q2pRes, pendenciaQ2p };
}

/**
 * Comodato — TRF do galpao origem para 90.0.1 TROCA, replicado em ACXE+Q2P
 * quando galpao e espelhado e TROCA tem correlacao em ambas (migration 0027).
 */
export async function executarComodatoOmieDual(
  ctx: ContextoMovimentacao,
): Promise<ResultadoDual> {
  const corrOrigem = await resolverCorrelacaoCompletaGalpao(ctx.galpao);
  const corrTroca = await resolverCodigosLocaisTroca();
  const valor = Number(new Decimal(ctx.valorUnitario).toFixed(2));
  const qtd = Number(new Decimal(ctx.quantidadeKg).toFixed(3));
  const obs = ctx.observacao.slice(0, 240);
  const data = formatarDataOmie();

  let acxeRes: ResultadoOmie | null = null;
  let q2pRes: ResultadoOmie | null = null;
  let pendenciaQ2p: { mensagem: string } | null = null;

  // ACXE: TRF origem ACXE → TROCA ACXE (so se ambos existem)
  if (corrOrigem.acxe && corrTroca.acxe) {
    const codInt = buildCodIntAjuste(ctx.opId, COD_INT_AJUSTE_SUFIXO.comodatoTrfAcxe);
    logger.info(
      { ctx, origem: corrOrigem.acxe, destino: corrTroca.acxe, codInt },
      'OMIE ACXE: TRF comodato pra TROCA',
    );
    const r = await incluirAjusteEstoque('acxe', {
      codigoLocalEstoque: corrOrigem.acxe,
      codigoLocalEstoqueDestino: corrTroca.acxe,
      idProduto: ctx.produtoCodigoAcxe,
      dataAtual: data,
      quantidade: qtd,
      observacao: obs,
      origem: 'AJU',
      tipo: 'TRF',
      motivo: 'TRF',
      valor,
      codIntAjuste: codInt,
    });
    acxeRes = { idMovest: r.idMovest, idAjuste: r.idAjuste };
  }

  // Q2P: TRF origem Q2P → TROCA Q2P
  if (corrOrigem.q2p && corrTroca.q2p) {
    try {
      const idProdutoQ2p = await resolverCodigoProdutoOmie(ctx.produtoCodigoAcxe, 'q2p');
      const codInt = buildCodIntAjuste(ctx.opId, COD_INT_AJUSTE_SUFIXO.comodatoTrfQ2p);
      logger.info(
        { ctx, origem: corrOrigem.q2p, destino: corrTroca.q2p, idProdutoQ2p, codInt },
        'OMIE Q2P: TRF comodato pra TROCA',
      );
      const r = await incluirAjusteEstoque('q2p', {
        codigoLocalEstoque: corrOrigem.q2p,
        codigoLocalEstoqueDestino: corrTroca.q2p,
        idProduto: idProdutoQ2p,
        dataAtual: data,
        quantidade: qtd,
        observacao: obs,
        origem: 'AJU',
        tipo: 'TRF',
        motivo: 'TRF',
        valor,
        codIntAjuste: codInt,
      });
      q2pRes = { idMovest: r.idMovest, idAjuste: r.idAjuste };
    } catch (err) {
      if (acxeRes) {
        pendenciaQ2p = { mensagem: (err as Error).message ?? 'erro Q2P comodato desconhecido' };
      } else {
        throw err;
      }
    }
  }

  if (!acxeRes && !q2pRes) {
    throw new CorrelacaoOmieAusenteError(
      `comodato: galpão=${ctx.galpao} e/ou TROCA sem correlação OMIE — nada foi feito`,
    );
  }

  return { acxe: acxeRes, q2p: q2pRes, pendenciaQ2p };
}

/**
 * Retorno de comodato — 4 chamadas OMIE quando dual:
 *   ACXE: SAI no TROCA (qtd original) + ENT no galpao destino (qtd recebida)
 *   Q2P:  SAI no TROCA (qtd original) + ENT no galpao destino (qtd recebida)
 *
 * Idempotencia: cod_int_ajuste com sufixo por empresa+etapa.
 * Ordem: ACXE primeiro (rollback-friendly).
 */
export async function executarRetornoComodatoOmieDual(args: {
  opId: string;
  produtoCodigoAcxeOriginal: number;
  quantidadeKgOriginal: number;
  valorUnitarioOriginal: number;
  produtoCodigoAcxeRecebido: number;
  galpaoDestino: string;
  quantidadeKgRecebida: number;
  valorUnitarioRecebido: number;
  observacao: string;
}): Promise<{ acxe: { baixa: ResultadoOmie; entrada: ResultadoOmie } | null; q2p: { baixa: ResultadoOmie; entrada: ResultadoOmie } | null; pendenciaQ2p: { mensagem: string } | null }> {
  const corrTroca = await resolverCodigosLocaisTroca();
  const corrDestino = await resolverCorrelacaoCompletaGalpao(args.galpaoDestino);
  const obs = args.observacao.slice(0, 240);
  const data = formatarDataOmie();
  const qtdOrig = Number(new Decimal(args.quantidadeKgOriginal).toFixed(3));
  const qtdRec = Number(new Decimal(args.quantidadeKgRecebida).toFixed(3));
  const vOrig = Number(new Decimal(args.valorUnitarioOriginal).toFixed(2));
  const vRec = Number(new Decimal(args.valorUnitarioRecebido).toFixed(2));

  let acxe: { baixa: ResultadoOmie; entrada: ResultadoOmie } | null = null;
  let q2p: { baixa: ResultadoOmie; entrada: ResultadoOmie } | null = null;
  let pendenciaQ2p: { mensagem: string } | null = null;

  // ACXE primeiro
  if (corrTroca.acxe && corrDestino.acxe) {
    const codIntBaixa = buildCodIntAjuste(args.opId, COD_INT_AJUSTE_SUFIXO.retBaixaAcxe);
    logger.info({ args, codInt: codIntBaixa }, 'OMIE ACXE: SAI baixa TROCA');
    const baixa = await incluirAjusteEstoque('acxe', {
      codigoLocalEstoque: corrTroca.acxe,
      idProduto: args.produtoCodigoAcxeOriginal,
      dataAtual: data,
      quantidade: qtdOrig,
      observacao: obs,
      origem: 'AJU',
      tipo: 'SAI',
      motivo: 'INV',
      valor: vOrig,
      codIntAjuste: codIntBaixa,
    });
    const codIntEntrada = buildCodIntAjuste(args.opId, COD_INT_AJUSTE_SUFIXO.retEntradaAcxe);
    logger.info({ args, codInt: codIntEntrada }, 'OMIE ACXE: ENT destino');
    const entrada = await incluirAjusteEstoque('acxe', {
      codigoLocalEstoque: corrDestino.acxe,
      idProduto: args.produtoCodigoAcxeRecebido,
      dataAtual: data,
      quantidade: qtdRec,
      observacao: obs,
      origem: 'AJU',
      tipo: 'ENT',
      motivo: 'INV',
      valor: vRec,
      codIntAjuste: codIntEntrada,
    });
    acxe = {
      baixa: { idMovest: baixa.idMovest, idAjuste: baixa.idAjuste },
      entrada: { idMovest: entrada.idMovest, idAjuste: entrada.idAjuste },
    };
  }

  // Q2P
  if (corrTroca.q2p && corrDestino.q2p) {
    try {
      const idProdOrigQ2p = await resolverCodigoProdutoOmie(args.produtoCodigoAcxeOriginal, 'q2p');
      const idProdRecQ2p = await resolverCodigoProdutoOmie(args.produtoCodigoAcxeRecebido, 'q2p');
      const codIntBaixa = buildCodIntAjuste(args.opId, COD_INT_AJUSTE_SUFIXO.retBaixaQ2p);
      logger.info({ args, codInt: codIntBaixa }, 'OMIE Q2P: SAI baixa TROCA');
      const baixa = await incluirAjusteEstoque('q2p', {
        codigoLocalEstoque: corrTroca.q2p,
        idProduto: idProdOrigQ2p,
        dataAtual: data,
        quantidade: qtdOrig,
        observacao: obs,
        origem: 'AJU',
        tipo: 'SAI',
        motivo: 'INV',
        valor: vOrig,
        codIntAjuste: codIntBaixa,
      });
      const codIntEntrada = buildCodIntAjuste(args.opId, COD_INT_AJUSTE_SUFIXO.retEntradaQ2p);
      logger.info({ args, codInt: codIntEntrada }, 'OMIE Q2P: ENT destino');
      const entrada = await incluirAjusteEstoque('q2p', {
        codigoLocalEstoque: corrDestino.q2p,
        idProduto: idProdRecQ2p,
        dataAtual: data,
        quantidade: qtdRec,
        observacao: obs,
        origem: 'AJU',
        tipo: 'ENT',
        motivo: 'INV',
        valor: vRec,
        codIntAjuste: codIntEntrada,
      });
      q2p = {
        baixa: { idMovest: baixa.idMovest, idAjuste: baixa.idAjuste },
        entrada: { idMovest: entrada.idMovest, idAjuste: entrada.idAjuste },
      };
    } catch (err) {
      if (acxe) {
        pendenciaQ2p = { mensagem: (err as Error).message ?? 'erro Q2P retorno desconhecido' };
      } else {
        throw err;
      }
    }
  }

  if (!acxe && !q2p) {
    throw new CorrelacaoOmieAusenteError(`retorno comodato: nem ACXE nem Q2P tinham correlação TROCA+destino`);
  }

  return { acxe, q2p, pendenciaQ2p };
}
