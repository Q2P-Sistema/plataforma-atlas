import Decimal from 'decimal.js';
import { eq, inArray } from 'drizzle-orm';
import { getDb, getPool, createLogger } from '@atlas/core';
import { bucketMensal, configMotor, ndfTaxas } from '@atlas/db';

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
  taxa_ndf: number;
  custo_ndf_brl: number;
  prioridade: 'critica' | 'alta' | 'media' | 'nenhuma';
  status: 'ok' | 'sub_hedged';
  acao_recomendada: string;
}

export interface MotorAlerta {
  tipo: 'critico' | 'atencao';
  titulo: string;
  descricao: string;
  custo_brl: number;
}

export interface MotorResult {
  camadas: CamadasResult;
  recomendacoes: Recomendacao[];
  alertas: MotorAlerta[];
  cobertura_global_pct: number;
  gap_total_usd: number;
  custo_acao_brl: number;
}

interface MotorParams {
  lambda: number;
  pct_estoque_nao_pago: number;
}

interface MotorConfig {
  camada1_minima: number;
  camada1_ajuste_ep: number;
  estoque_bump_threshold: number;
  ndf_rates: Record<string, number>;
}

/**
 * Carrega parametros configurados do banco (config_motor + taxas NDF).
 */
async function loadMotorConfig(): Promise<MotorConfig> {
  const db = getDb();

  const keys = ['cobertura_base_pct', 'cobertura_bump_pct', 'estoque_bump_threshold'];
  const rows = await db
    .select()
    .from(configMotor)
    .where(inArray(configMotor.chave, keys));

  const configMap = new Map(rows.map((r) => [r.chave, r.valor]));
  const camada1_minima = Number(configMap.get('cobertura_base_pct') ?? 60);
  const cobertura_bump = Number(configMap.get('cobertura_bump_pct') ?? 68);
  const estoque_bump_threshold = Number(configMap.get('estoque_bump_threshold') ?? 0.5);
  // camada1_ajuste_ep = bump - base (legacy: 68 - 60 = 8)
  const camada1_ajuste_ep = cobertura_bump - camada1_minima;

  // Load latest NDF rates
  const taxaRows = await db
    .select()
    .from(ndfTaxas)
    .orderBy(ndfTaxas.dataRef, ndfTaxas.prazoDias)
    .limit(10);

  // Use most recent rate per prazo
  const ndf_rates: Record<string, number> = {};
  for (const row of taxaRows) {
    const key = `ndf_${row.prazoDias}d`;
    // Last wins (rows ordered by dataRef asc, so latest overwrites)
    ndf_rates[key] = Number(row.taxa);
  }

  return { camada1_minima, camada1_ajuste_ep, estoque_bump_threshold, ndf_rates };
}

/**
 * Calcula as 3 camadas do Motor de Minima Variancia.
 *
 * L1 (base): camada1_minima default, bumps by camada1_ajuste_ep if unpaid stock > threshold
 * L2 (tatica): lambda * 25
 * L3 (aberta): 100 - L1 - L2
 */
export function calcularCamadas(params: MotorParams, config: MotorConfig): CamadasResult {
  const lambda = new Decimal(params.lambda).clamp(0, 1);
  const pctEstoque = new Decimal(params.pct_estoque_nao_pago).clamp(0, 1);

  const coberturaBase = new Decimal(config.camada1_minima);
  const coberturaBump = coberturaBase.plus(config.camada1_ajuste_ep);
  const estoqueBumpThreshold = new Decimal(config.estoque_bump_threshold);

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
  if (diasAteVencimento <= 15) return 'Trava cambial';
  if (diasAteVencimento <= 35) return 'NDF 30d';
  if (diasAteVencimento <= 70) return 'NDF 60d';
  if (diasAteVencimento <= 100) return 'NDF 90d';
  if (diasAteVencimento <= 150) return 'NDF 120d';
  return 'NDF 180d';
}

/**
 * Retorna a taxa NDF adequada para o prazo dado.
 */
function getTaxaParaPrazo(diasAteVencimento: number, ndfRates: Record<string, number>): number {
  if (diasAteVencimento <= 35) return ndfRates['ndf_30d'] ?? 0;
  if (diasAteVencimento <= 70) return ndfRates['ndf_60d'] ?? 0;
  if (diasAteVencimento <= 100) return ndfRates['ndf_90d'] ?? 0;
  if (diasAteVencimento <= 150) return ndfRates['ndf_120d'] ?? 0;
  return ndfRates['ndf_180d'] ?? 0;
}

/**
 * Gera recomendacoes de hedge por bucket baseado nas camadas calculadas.
 * Inclui custo NDF, prioridades e alertas (paridade com legado).
 */
export async function calcularMotor(params: MotorParams): Promise<MotorResult> {
  const db = getDb();
  const config = await loadMotorConfig();
  const camadas = calcularCamadas(params, config);
  const coberturaAlvo = new Decimal(camadas.l1_pct).plus(camadas.l2_pct);

  // Get all buckets
  const buckets = await db
    .select()
    .from(bucketMensal)
    .orderBy(bucketMensal.mesRef);

  // Distribute est_nao_pago_usd proportionally (GAP-01)
  const pool = getPool();
  const { rows: resumoRows } = await pool.query('SELECT est_nao_pago_usd FROM public.vw_hedge_resumo LIMIT 1');
  const estNaoPagoTotal = new Decimal(resumoRows[0]?.est_nao_pago_usd ?? 0);
  let totalPagarAll = new Decimal(0);
  for (const b of buckets) totalPagarAll = totalPagarAll.plus(b.pagarUsd ?? '0');

  const hoje = new Date();
  const recomendacoes: Recomendacao[] = [];

  for (const bucket of buckets) {
    const pagarUsdRaw = new Decimal(bucket.pagarUsd ?? '0');
    const parcelaEstNaoPago = totalPagarAll.isZero()
      ? new Decimal(0)
      : estNaoPagoTotal.times(pagarUsdRaw).div(totalPagarAll);
    const pagarUsd = pagarUsdRaw.plus(parcelaEstNaoPago); // exposicao total
    const ndfUsd = new Decimal(bucket.ndfUsd ?? '0');

    if (pagarUsd.isZero()) continue;

    // Calculate days to maturity
    const vencimento = new Date(bucket.mesRef);
    vencimento.setMonth(vencimento.getMonth() + 1);
    vencimento.setDate(0);
    const diasAteVencimento = Math.max(
      0,
      Math.ceil((vencimento.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24)),
    );

    const coberturaAtual = ndfUsd.div(pagarUsd).times(100);
    const instrumento = selecionarInstrumento(diasAteVencimento);
    const taxaNdf = getTaxaParaPrazo(diasAteVencimento, config.ndf_rates);
    const gapAtual = pagarUsd.minus(ndfUsd);

    // Calculate gap to L1 target
    const l1Target = pagarUsd.times(camadas.l1_pct).div(100);
    const gapL1 = Decimal.max(new Decimal(0), l1Target.minus(ndfUsd));

    // NDF cost: gap * (taxa_ndf - ptax_spot) — we approximate with taxa as cost indicator
    const custoNdfBrl = gapL1.gt(0) && taxaNdf > 0
      ? gapL1.times(new Decimal(taxaNdf).minus(taxaNdf * 0.98)).round()
      : new Decimal(0);

    const status: 'ok' | 'sub_hedged' = coberturaAtual.gte(camadas.l1_pct) ? 'ok' : 'sub_hedged';
    const prioridade: 'critica' | 'alta' | 'media' | 'nenhuma' =
      gapL1.gt(1_000_000) ? 'critica'
      : gapL1.gt(500_000) ? 'alta'
      : gapL1.gt(0) ? 'media'
      : 'nenhuma';

    const notionalSugerido = coberturaAtual.lt(coberturaAlvo)
      ? pagarUsd.times(coberturaAlvo).div(100).minus(ndfUsd)
      : new Decimal(0);

    const acaoRecomendada = notionalSugerido.gt(0) && taxaNdf > 0
      ? `Contratar ${instrumento} de $${Math.round(notionalSugerido.toNumber() / 1000)}K a R$${taxaNdf.toFixed(2)}`
      : 'Posicao adequada';

    recomendacoes.push({
      bucket_id: bucket.id,
      mes_ref: bucket.mesRef,
      instrumento,
      notional_sugerido: Decimal.max(notionalSugerido, new Decimal(0)).toDecimalPlaces(2).toNumber(),
      gap_atual: gapAtual.toDecimalPlaces(2).toNumber(),
      cobertura_alvo: coberturaAlvo.toDecimalPlaces(1).toNumber(),
      taxa_ndf: taxaNdf,
      custo_ndf_brl: custoNdfBrl.toNumber(),
      prioridade,
      status,
      acao_recomendada: acaoRecomendada,
    });
  }

  // Global stats
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
  const custoTotal = recomendacoes.reduce((s, r) => s + r.custo_ndf_brl, 0);

  // Generate alerts for sub-hedged buckets
  const alertas: MotorAlerta[] = recomendacoes
    .filter((r) => r.status === 'sub_hedged')
    .map((r) => {
      const bucketPagar = buckets.find((b) => b.id === r.bucket_id);
      const pagarD = new Decimal(bucketPagar?.pagarUsd ?? '0');
      const ndfD = new Decimal(bucketPagar?.ndfUsd ?? '0');
      const cobPct = pagarD.isZero() ? 0 : ndfD.div(pagarD).times(100).toDecimalPlaces(0).toNumber();
      return {
        tipo: r.prioridade === 'critica' ? 'critico' as const : 'atencao' as const,
        titulo: `Bucket ${r.mes_ref.slice(0, 7)} sub-hedgeado — ${cobPct}% cobertura`,
        descricao: r.acao_recomendada,
        custo_brl: r.custo_ndf_brl,
      };
    });

  logger.info(
    { lambda: params.lambda, l1: camadas.l1_pct, l2: camadas.l2_pct, recomendacoes: recomendacoes.length, alertas: alertas.length },
    'Motor MV calculado',
  );

  return {
    camadas,
    recomendacoes,
    alertas,
    cobertura_global_pct: coberturaGlobal.toDecimalPlaces(1).toNumber(),
    gap_total_usd: gapTotal.toDecimalPlaces(2).toNumber(),
    custo_acao_brl: custoTotal,
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
