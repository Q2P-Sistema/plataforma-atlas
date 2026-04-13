import Decimal from 'decimal.js';

export interface CenarioMargem {
  cambio: number;
  custo_com_hedge: number;
  custo_sem_hedge: number;
  margem_pct: number;
  margem_sem_hedge_pct: number;
}

interface SimulacaoParams {
  faturamento_brl: number;
  outros_custos_brl: number;
  volume_usd?: number;
  pct_custo_importado?: number;
}

/**
 * Simula margem bruta para cenarios de cambio de 4.50 a 7.50 step 0.10 (30 cenarios).
 *
 * volume_usd pode vir direto OU ser calculado: faturamento * pct_custo_importado / 100
 *
 * Cobertura pode vir como pct_cobertura flat OU como l1+l2 (layer-aware):
 *   pct_aberto = (100 - l1 - l2) / 100
 *
 * custo_com_hedge = vol_usd × ndf_taxa × pct_coberto + vol_usd × cambio × pct_aberto
 * margem = (faturamento − custo − outros_custos) / faturamento × 100
 */
export function simularMargem(
  params: SimulacaoParams,
  coberturaInfo: { ndf_taxa_media: number; pct_cobertura?: number; l1?: number; l2?: number },
): CenarioMargem[] {
  const faturamento = new Decimal(params.faturamento_brl);
  const outrosCustos = new Decimal(params.outros_custos_brl);

  // volume_usd: direto ou calculado via pct_custo_importado
  const volumeUsd = params.volume_usd
    ? new Decimal(params.volume_usd)
    : faturamento.times(params.pct_custo_importado ?? 70).div(100);

  const ndfTaxa = new Decimal(coberturaInfo.ndf_taxa_media || 5.50);

  // pct_aberto: layer-aware (l1+l2) ou flat (pct_cobertura)
  let pctCoberto: Decimal;
  if (coberturaInfo.l1 != null && coberturaInfo.l2 != null) {
    pctCoberto = new Decimal(coberturaInfo.l1).plus(coberturaInfo.l2).div(100).clamp(0, 1);
  } else {
    pctCoberto = new Decimal(coberturaInfo.pct_cobertura ?? 0).div(100).clamp(0, 1);
  }
  const pctAberto = new Decimal(1).minus(pctCoberto);

  const cenarios: CenarioMargem[] = [];

  for (let cambioRaw = 4.50; cambioRaw <= 7.505; cambioRaw += 0.10) {
    const cambio = parseFloat(cambioRaw.toFixed(2));
    const cambioD = new Decimal(cambio);

    const custoComHedge = volumeUsd
      .times(ndfTaxa)
      .times(pctCoberto)
      .plus(volumeUsd.times(cambioD).times(pctAberto));

    const custoSemHedge = volumeUsd.times(cambioD);

    const margemComHedge = faturamento.isZero()
      ? new Decimal(0)
      : faturamento.minus(custoComHedge).minus(outrosCustos).div(faturamento).times(100);

    const margemSemHedge = faturamento.isZero()
      ? new Decimal(0)
      : faturamento.minus(custoSemHedge).minus(outrosCustos).div(faturamento).times(100);

    cenarios.push({
      cambio,
      custo_com_hedge: custoComHedge.toDecimalPlaces(2).toNumber(),
      custo_sem_hedge: custoSemHedge.toDecimalPlaces(2).toNumber(),
      margem_pct: margemComHedge.toDecimalPlaces(2).toNumber(),
      margem_sem_hedge_pct: margemSemHedge.toDecimalPlaces(2).toNumber(),
    });
  }

  return cenarios;
}
