import { eq, and } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { getDb, createLogger } from '@atlas/core';
import { lote, movimentacao, aprovacao, divergencia } from '@atlas/db';
import { converterParaToneladas } from './motor.service.js';
import { enviarAlertaAprovacaoPendente } from './notificacao.service.js';
import { NIVEL_APROVACAO_POR_SUBTIPO, type SubtipoMovimento, type UnidadeMedida } from '../types.js';

const logger = createLogger('stockbridge:saida-manual');

export class LoteInvalidoError extends Error {
  constructor(msg: string) { super(msg); this.name = 'LoteInvalidoError'; }
}

export class SubtipoInvalidoError extends Error {
  constructor(public readonly subtipo: string) {
    super(`Subtipo ${subtipo} nao e valido para saida manual`);
    this.name = 'SubtipoInvalidoError';
  }
}

/**
 * Subtipos de saida manual suportados (T086):
 *   transf_intra_cnpj:  -origem +destino,  sem impacto fiscal      (gestor)
 *   comodato:           -fisico temporario, fiscal inalterado      (diretor)
 *   amostra:            -fisico definitivo, divergencia fiscal     (gestor)
 *   descarte:           -fisico definitivo, divergencia fiscal     (gestor)
 *   quebra:             -fisico definitivo, divergencia registrada (gestor)
 *   inventario_menos:   -saldo fisico, divergencia registrada      (gestor)
 */
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

export interface RegistrarSaidaManualInput {
  subtipo: SubtipoSaidaManual;
  loteId: string;
  quantidadeOriginal: number;
  unidade: UnidadeMedida;
  localidadeDestinoId?: string | null;
  referencia?: string;
  observacoes: string;
  userId: string;
}

export interface RegistrarSaidaManualResult {
  movimentacaoId: string;
  aprovacaoId: string;
  status: 'aguardando_aprovacao';
  precisaNivel: 'gestor' | 'diretor';
  divergenciaId?: string;
}

/**
 * Registra uma saida manual que requer aprovacao (gestor ou diretor).
 * Nao debita saldo imediatamente — so apos aprovacao (fluxo de US3).
 * Cria movimentacao com tipo=saida_manual + subtipo + aprovacao pendente.
 * Para subtipos com divergencia fiscal, cria stockbridge.divergencia tipo=fiscal_pendente.
 */
export async function registrarSaidaManual(
  input: RegistrarSaidaManualInput,
): Promise<RegistrarSaidaManualResult> {
  if (!isSubtipoSaidaManual(input.subtipo)) {
    throw new SubtipoInvalidoError(input.subtipo);
  }
  if (!input.observacoes || input.observacoes.trim().length === 0) {
    throw new Error('Motivo/observacao obrigatorio para saida manual');
  }

  const db = getDb();
  const [loteRow] = await db.select().from(lote).where(and(eq(lote.id, input.loteId), eq(lote.ativo, true))).limit(1);
  if (!loteRow) {
    throw new LoteInvalidoError(`Lote ${input.loteId} nao encontrado ou inativo`);
  }
  if (loteRow.status !== 'reconciliado' && loteRow.status !== 'provisorio') {
    throw new LoteInvalidoError(
      `Lote esta em status "${loteRow.status}" — apenas lotes reconciliados/provisorios podem sofrer saida manual`,
    );
  }

  const quantidadeT = Number(new Decimal(converterParaToneladas(input.quantidadeOriginal, input.unidade)).toFixed(3));
  const fisicoAtual = Number(loteRow.quantidadeFisica);
  if (quantidadeT > fisicoAtual) {
    throw new LoteInvalidoError(
      `Quantidade solicitada (${quantidadeT} t) excede saldo fisico do lote (${fisicoAtual} t)`,
    );
  }

  const nivel = NIVEL_APROVACAO_POR_SUBTIPO[input.subtipo as keyof typeof NIVEL_APROVACAO_POR_SUBTIPO] ?? 'gestor';
  const tipoAprovacao = SUBTIPO_PARA_TIPO_APROVACAO[input.subtipo];
  const criaDivFiscal = SUBTIPO_CRIA_DIVERGENCIA_FISCAL.has(input.subtipo);

  const resultado = await db.transaction(async (tx) => {
    const [mov] = await tx
      .insert(movimentacao)
      .values({
        notaFiscal: input.referencia ?? `MANUAL-${input.subtipo.toUpperCase()}-${Date.now()}`,
        tipoMovimento: 'saida_manual',
        subtipo: input.subtipo as SubtipoMovimento,
        loteId: loteRow.id,
        quantidadeT: String(-Math.abs(quantidadeT)), // saida = negativo
        observacoes: input.observacoes,
      })
      .returning();

    const [apr] = await tx
      .insert(aprovacao)
      .values({
        loteId: loteRow.id,
        precisaNivel: nivel,
        tipoAprovacao,
        quantidadeRecebidaT: String(quantidadeT),
        observacoes: input.observacoes,
        lancadoPor: input.userId,
      })
      .returning();

    let divId: string | undefined;
    if (criaDivFiscal) {
      const [div] = await tx
        .insert(divergencia)
        .values({
          loteId: loteRow.id,
          movimentacaoId: mov!.id,
          tipo: 'fiscal_pendente',
          quantidadeDeltaT: String(-quantidadeT),
          status: 'aberta',
          observacoes: `Saida manual tipo ${input.subtipo} — aguarda regularizacao fiscal`,
        })
        .returning();
      divId = div!.id;
    }

    // Marca lote como aguardando_aprovacao para bloquear outras saidas no mesmo lote
    await tx.update(lote).set({ status: 'aguardando_aprovacao', updatedAt: new Date() }).where(eq(lote.id, loteRow.id));

    return { movimentacaoId: mov!.id, aprovacaoId: apr!.id, divergenciaId: divId };
  });

  await enviarAlertaAprovacaoPendente({
    aprovacaoId: resultado.aprovacaoId,
    tipoAprovacao,
    nivel,
    loteCodigo: loteRow.codigo,
    produto: loteRow.fornecedorNome,
    quantidadeT,
    detalhes: `Saida manual ${input.subtipo} — ${input.observacoes}`,
  });

  logger.info(
    { movimentacaoId: resultado.movimentacaoId, subtipo: input.subtipo, nivel, quantidadeT },
    'Saida manual registrada, aguarda aprovacao',
  );

  return {
    movimentacaoId: resultado.movimentacaoId,
    aprovacaoId: resultado.aprovacaoId,
    status: 'aguardando_aprovacao',
    precisaNivel: nivel,
    divergenciaId: resultado.divergenciaId,
  };
}

export interface RetornoComodatoInput {
  movimentacaoOrigemId: string;
  quantidadeRetornadaT: number;
  observacoes: string;
  userId: string;
}

/**
 * Registra retorno de comodato — reverte o debito fisico temporario.
 * Cria movimentacao de entrada vinculada a original + atualiza lote + fecha divergencia
 * fiscal se tiver (comodato nao cria divergencia mas, caso a qtd retornada seja menor
 * que a emprestada, a diferenca fica como saldo negativo).
 */
export async function registrarRetornoComodato(
  input: RetornoComodatoInput,
): Promise<{ movimentacaoRetornoId: string }> {
  const db = getDb();

  const [movOrigem] = await db.select().from(movimentacao).where(eq(movimentacao.id, input.movimentacaoOrigemId)).limit(1);
  if (!movOrigem) throw new LoteInvalidoError(`Movimentacao origem ${input.movimentacaoOrigemId} nao encontrada`);
  if (movOrigem.subtipo !== 'comodato') throw new LoteInvalidoError('Apenas movimentacoes de comodato podem ter retorno');
  if (!movOrigem.loteId) throw new LoteInvalidoError('Movimentacao origem sem lote vinculado');

  const resultado = await db.transaction(async (tx) => {
    const [mov] = await tx
      .insert(movimentacao)
      .values({
        notaFiscal: `RET-${movOrigem.notaFiscal}`,
        tipoMovimento: 'entrada_manual',
        subtipo: 'retorno_comodato',
        loteId: movOrigem.loteId!,
        quantidadeT: String(Math.abs(input.quantidadeRetornadaT)),
        observacoes: `Retorno de comodato da movimentacao ${input.movimentacaoOrigemId}: ${input.observacoes}`,
      })
      .returning();

    return { movimentacaoRetornoId: mov!.id };
  });

  logger.info(
    { movimentacaoOrigemId: input.movimentacaoOrigemId, retornoId: resultado.movimentacaoRetornoId },
    'Retorno de comodato registrado',
  );

  return resultado;
}
