import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { bucketMensal, configMotor } from '@atlas/db';

const logger = createLogger('hedge:motor');

export interface CamadasResult {
  l1_pct: number;
  l2_pct: number;
  l3_pct: number;
}

export interface Recomendacao {
  bucket_id: string;
  mes_ref: string;
  instrumento: string;
  notional_sugerido: number;
  gap_atual: number;
  cobertura_alvo: number;
}

export interface MotorResult {
  camadas: CamadasResult;
  recomendacoes: Recomendacao[];
  cobertura_global_pct: number;
  gap_total_usd: number;
}

interface MotorParams {
  lambda: number;
  pct_estoque_nao_pago: number;
}

/**
 * Calcula as 3 camadas do Motor de Minima Variancia.
 *
 * L1 (base): 60% default, bumps to min(68%, 90%) if unpaid stock > 50%
 * L2 (tatica): lambda * 25
 * L3 (aberta): 100 - L1 - L2
 */
export function calcularCamadas(params: MotorParams): CamadasResult {
  const lambda = new Decimal(params.lambda).clamp(0, 1);
  const pctEstoque = new Decimal(params.pct_estoque_nao_pago).clamp(0, 1);

  // L1: base coverage
  const coberturaBase = new Decimal(60);
  const coberturaBump = new Decimal(68);
  const estoqueBumpThreshold = new Decimal(0.5);

  let l1 = coberturaBase;
  if (pctEstoque.gt(estoqueBumpThreshold)) {
    l1 = Decimal.min(coberturaBump, new Decimal(90));
  }

  // L2: tactical = lambda * 25
  let l2 = lambda.times(25);

  // Ensure L1 + L2 doesn't exceed 100
  if (l1.plus(l2).gt(100)) {
    l2 = new Decimal(100).minus(l1);
  }

  // L3: open gap = 100 - L1 - L2
  const l3 = new Decimal(100).minus(l1).minus(l2);

  return {
    l1_pct: l1.toDecimalPlaces(1).toNumber(),
    l2_pct: l2.toDecimalPlaces(1).toNumber(),
    l3_pct: l3.toDecimalPlaces(1).toNumber(),
  };
}

/**
 * Seleciona instrumento de hedge por prazo ate vencimento.
 */
export function selecionarInstrumento(diasAteVencimento: number): string {
  if (diasAteVencimento <= 15) return 'Trava';
  if (diasAteVencimento <= 35) return 'NDF 30d';
  if (diasAteVencimento <= 70) return 'NDF 60d';
  if (diasAteVencimento <= 100) return 'NDF 90d';
  if (diasAteVencimento <= 150) return 'NDF 120d';
  return 'NDF 180d';
}

/**
 * Gera recomendacoes de hedge por bucket baseado nas camadas calculadas.
 */
export async function calcularMotor(params: MotorParams): Promise<MotorResult> {
  const db = getDb();
  const camadas = calcularCamadas(params);
  const coberturaAlvo = new Decimal(camadas.l1_pct).plus(camadas.l2_pct);

  // Get all buckets with gap
  const buckets = await db
    .select()
    .from(bucketMensal)
    .orderBy(bucketMensal.mesRef);

  const hoje = new Date();
  const recomendacoes: Recomendacao[] = [];

  for (const bucket of buckets) {
    const pagarUsd = new Decimal(bucket.pagarUsd ?? '0');
    const ndfUsd = new Decimal(bucket.ndfUsd ?? '0');

    if (pagarUsd.isZero()) continue;

    const coberturaAtual = ndfUsd.div(pagarUsd).times(100);

    // If current coverage is below target, generate recommendation
    if (coberturaAtual.lt(coberturaAlvo)) {
      const alvoUsd = pagarUsd.times(coberturaAlvo).div(100);
      const notionalSugerido = alvoUsd.minus(ndfUsd);

      if (notionalSugerido.lte(0)) continue;

      // Calculate days to maturity
      const vencimento = new Date(bucket.mesRef);
      // Set to end of month for the bucket
      vencimento.setMonth(vencimento.getMonth() + 1);
      vencimento.setDate(0);
      const diasAteVencimento = Math.max(
        0,
        Math.ceil((vencimento.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24)),
      );

      const instrumento = selecionarInstrumento(diasAteVencimento);
      const gapAtual = pagarUsd.minus(ndfUsd);

      recomendacoes.push({
        bucket_id: bucket.id,
        mes_ref: bucket.mesRef,
        instrumento,
        notional_sugerido: notionalSugerido.toDecimalPlaces(2).toNumber(),
        gap_atual: gapAtual.toDecimalPlaces(2).toNumber(),
        cobertura_alvo: coberturaAlvo.toDecimalPlaces(1).toNumber(),
      });
    }
  }

  // Calculate global stats
  let totalExpo = new Decimal(0);
  let totalNdf = new Decimal(0);
  for (const bucket of buckets) {
    totalExpo = totalExpo.plus(bucket.pagarUsd ?? '0');
    totalNdf = totalNdf.plus(bucket.ndfUsd ?? '0');
  }
  const coberturaGlobal = totalExpo.isZero()
    ? new Decimal(0)
    : totalNdf.div(totalExpo).times(100);
  const gapTotal = totalExpo.minus(totalNdf);

  logger.info(
    { lambda: params.lambda, l1: camadas.l1_pct, l2: camadas.l2_pct, recomendacoes: recomendacoes.length },
    'Motor MV calculado',
  );

  return {
    camadas,
    recomendacoes,
    cobertura_global_pct: coberturaGlobal.toDecimalPlaces(1).toNumber(),
    gap_total_usd: gapTotal.toDecimalPlaces(2).toNumber(),
  };
}

/**
 * Carrega config defaults do motor do banco.
 */
export async function getMotorDefaults(): Promise<MotorParams> {
  const db = getDb();
  const [lambdaRow] = await db
    .select()
    .from(configMotor)
    .where(eq(configMotor.chave, 'lambda_default'))
    .limit(1);

  return {
    lambda: lambdaRow ? Number(lambdaRow.valor) : 0.5,
    pct_estoque_nao_pago: 0, // Will be calculated from estoque data
  };
}
