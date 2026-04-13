import Decimal from 'decimal.js';

export interface CenarioMargem {
  cambio: number;
  custo_com_hedge: number;
  custo_sem_hedge: number;
  margem_pct: number;
}

interface SimulacaoParams {
  faturamento_brl: number;
  outros_custos_brl: number;
  volume_usd: number;
}

/**
 * Simula margem bruta para cenarios de cambio de 4.50 a 7.50 step 0.25.
 *
 * custo_com_hedge = vol_usd × ndf_taxa × (1 − pct_aberto) + vol_usd × cambio × pct_aberto
 * margem = (faturamento − custo − outros_custos) / faturamento × 100
 */
export function simularMargem(
  params: SimulacaoParams,
  coberturaInfo: { ndf_taxa_media: number; pct_cobertura: number },
): CenarioMargem[] {
  const faturamento = new Decimal(params.faturamento_brl);
  const outrosCustos = new Decimal(params.outros_custos_brl);
  const volumeUsd = new Decimal(params.volume_usd);
  const ndfTaxa = new Decimal(coberturaInfo.ndf_taxa_media || 5.50);
  const pctCoberto = new Decimal(coberturaInfo.pct_cobertura).div(100).clamp(0, 1);
  const pctAberto = new Decimal(1).minus(pctCoberto);

  const cenarios: CenarioMargem[] = [];

  for (let cambio = 4.50; cambio <= 7.50; cambio += 0.25) {
    const cambioD = new Decimal(cambio);

    // Custo com hedge: parte coberta usa taxa NDF, parte aberta usa cambio de mercado
    const custoComHedge = volumeUsd
      .times(ndfTaxa)
      .times(pctCoberto)
      .plus(volumeUsd.times(cambioD).times(pctAberto));

    // Custo sem hedge: tudo no cambio de mercado
    const custoSemHedge = volumeUsd.times(cambioD);

    // Margem = (faturamento - custo_com_hedge - outros_custos) / faturamento * 100
    const margem = faturamento.isZero()
      ? new Decimal(0)
      : faturamento
          .minus(custoComHedge)
          .minus(outrosCustos)
          .div(faturamento)
          .times(100);

    cenarios.push({
      cambio: new Decimal(cambio).toDecimalPlaces(2).toNumber(),
      custo_com_hedge: custoComHedge.toDecimalPlaces(2).toNumber(),
      custo_sem_hedge: custoSemHedge.toDecimalPlaces(2).toNumber(),
      margem_pct: margem.toDecimalPlaces(1).toNumber(),
    });
  }

  return cenarios;
}
