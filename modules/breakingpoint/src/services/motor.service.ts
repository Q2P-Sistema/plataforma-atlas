import type { DadosBase, SemanaPagamento, SemanaValor } from './dados.service.js';

export interface MotorParams {
  dup_antecip_usado: number;
  dup_antecip_limite: number;
  dup_antecip_taxa: number;
  finimp_limite: number;
  finimp_garantia_pct: number;
  markup_estoque: number;
  alerta_gap_limiar: number;
  cat_finimp_cod_nulo: boolean;
}

export interface MotorInput extends MotorParams {
  dados: DadosBase;
  data_base: Date;
}

export interface SemanaProjetada {
  semana: number;
  label: string;
  data_fmt: string;
  pagamento: number;
  tipo: 'Fornecedor' | 'FINIMP' | 'Op.Corrente';
  is_finimp: boolean;
  rec_dup: number;
  rec_estoque: number;
  saldo_cc: number;
  antecip_disp: number;
  finimp_disp: number;
  finimp_saldo: number;
  dup_bloq: number;
  dup_livre: number;
  liquidez_total: number;
  gap: number;
  cap_compra: number;
  estoque_rest: number;
  status_gap: 'critico' | 'alerta' | 'ok';
}

export interface BreakingPoint {
  semana: number;
  data: string;
  val: number;
}

export interface TravaEvent {
  semana: number;
  data: string;
}

export interface MotorKpis {
  saldo_cc: number;
  dup_total: number;
  estoque_valor_venda: number;
  antecip_disp: number;
  finimp_usado: number;
  dup_bloq: number;
  cap_compra_atual: number;
  cap_compra_med8: number;
  config_incompleta: boolean;
  contas_ativas_count: number;
  contas_excluidas_count: number;
}

export interface MotorOutput {
  kpis: MotorKpis;
  breaking_points: {
    break_caixa: BreakingPoint | null;
    break_antecip: BreakingPoint | null;
    break_total: BreakingPoint | null;
    trava_finimp: TravaEvent | null;
  };
  semanas: SemanaProjetada[];
}

function fmtData(d: Date): string {
  const dia = String(d.getDate()).padStart(2, '0');
  const meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return `${dia} ${meses[d.getMonth()]}`;
}

// MOD-22: regras de negócio do motor extraídas de números mágicos para constantes
// nomeadas (mesmos valores — sem mudança de comportamento). Documentam a intenção
// e concentram num só lugar caso virem configuráveis no futuro (como o hedge faz
// em config_motor). Enquanto não há decisão de produto sobre editabilidade, ficam
// como constantes de regra.
/** Fração do estoque disponível que se assume liquidável (vendável) por semana, a partir da 2ª semana. */
const FRACAO_ESTOQUE_LIQUIDAVEL_SEMANA = 0.18;
/** Limiar de FINIMP sobre o pagamento da semana para classificar a semana como tipo 'FINIMP'. */
const LIMIAR_FINIMP_SOBRE_PAGAMENTO = 0.5;
/** Reserva obrigatória de caixa como múltiplo do pagamento da semana (120%). */
const FATOR_RESERVA_OBRIGATORIA = 1.2;

export function calcular(input: MotorInput): MotorOutput {
  const { dados, data_base } = input;
  const {
    dup_antecip_usado,
    dup_antecip_limite,
    dup_antecip_taxa,
    finimp_limite,
    finimp_garantia_pct,
    markup_estoque,
    alerta_gap_limiar,
    cat_finimp_cod_nulo,
  } = input;

  const estoque_valor_venda = dados.estoque_custo_brl * (1 + markup_estoque);

  let saldoCC = dados.saldo_cc;
  let estoqueDisp = estoque_valor_venda;
  let finimpSaldo = dados.finimp_saldo;
  const amortPorSemana = dados.finimp_amort_mensal / 4;

  const semanas: SemanaProjetada[] = [];
  let breakCaixa: BreakingPoint | null = null;
  let breakAntecip: BreakingPoint | null = null;
  let breakTotal: BreakingPoint | null = null;
  let travaFinimp: TravaEvent | null = null;

  for (let w = 0; w < 26; w++) {
    const diasCorridos = w * 7;
    const pag = dados.pagamentos_semanais[w] ?? { total: 0, finimp_total: 0 } as SemanaPagamento;
    const rec = dados.recebimentos_semanais[w] ?? { total: 0 } as SemanaValor;

    const pagamento = pag.total;
    const finimpNaSemana = pag.finimp_total;
    const hasFinimp = finimpNaSemana > 0;

    let tipo: 'Fornecedor' | 'FINIMP' | 'Op.Corrente';
    if (cat_finimp_cod_nulo) {
      tipo = 'Op.Corrente';
    } else if (hasFinimp && finimpNaSemana >= pagamento * LIMIAR_FINIMP_SOBRE_PAGAMENTO) {
      tipo = 'FINIMP';
    } else {
      tipo = 'Fornecedor';
    }

    const recDup = rec.total;
    const recEstoque = w >= 2 && estoqueDisp > 0 ? Math.min(estoqueDisp * FRACAO_ESTOQUE_LIQUIDAVEL_SEMANA, estoqueDisp) : 0;
    estoqueDisp = Math.max(0, estoqueDisp - recEstoque);

    const amortFinimp = hasFinimp ? amortPorSemana : 0;
    finimpSaldo = Math.max(0, finimpSaldo - amortFinimp);

    const dupBloq = finimpSaldo * finimp_garantia_pct;
    const dupLivre = Math.max(0, dados.dup_total - dupBloq);
    const antecipBruta = Math.min(dupLivre * dup_antecip_taxa, dup_antecip_limite);
    const antecipDisp = Math.max(0, antecipBruta - dup_antecip_usado);
    const finimpDisp = Math.max(0, finimp_limite - finimpSaldo);

    const liquidezTotal = saldoCC + antecipDisp + recDup + recEstoque;
    const gap = liquidezTotal - pagamento;

    const reservaObrig = pagamento * FATOR_RESERVA_OBRIGATORIA;
    const capCompra = Math.max(0, saldoCC + antecipDisp + finimpDisp - reservaObrig);

    const saldoCCProximo = saldoCC + recDup + recEstoque - pagamento;

    const dataSemana = new Date(data_base);
    dataSemana.setDate(dataSemana.getDate() + diasCorridos);
    const dataFmt = fmtData(dataSemana);

    if (breakCaixa === null && saldoCCProximo < 0) {
      breakCaixa = { semana: w + 1, data: dataFmt, val: saldoCCProximo };
    }
    if (breakAntecip === null && dup_antecip_limite > 0 && antecipDisp < 200_000) {
      breakAntecip = { semana: w + 1, data: dataFmt, val: antecipDisp };
    }
    if (breakTotal === null && gap < 0) {
      breakTotal = { semana: w + 1, data: dataFmt, val: gap };
    }
    if (travaFinimp === null && dupLivre > 0 && dupBloq > dupLivre * 0.6) {
      travaFinimp = { semana: w + 1, data: dataFmt };
    }

    const statusGap: 'critico' | 'alerta' | 'ok' =
      gap < 0 ? 'critico' : gap < alerta_gap_limiar ? 'alerta' : 'ok';

    semanas.push({
      semana: w,
      label: w === 0 ? 'Hoje' : `S${w + 1}`,
      data_fmt: dataFmt,
      pagamento: Math.round(pagamento),
      tipo,
      is_finimp: hasFinimp,
      rec_dup: Math.round(recDup),
      rec_estoque: Math.round(recEstoque),
      saldo_cc: Math.round(saldoCCProximo),
      antecip_disp: Math.round(antecipDisp),
      finimp_disp: Math.round(finimpDisp),
      finimp_saldo: Math.round(finimpSaldo),
      dup_bloq: Math.round(dupBloq),
      dup_livre: Math.round(dupLivre),
      liquidez_total: Math.round(liquidezTotal),
      gap: Math.round(gap),
      cap_compra: Math.round(capCompra),
      estoque_rest: Math.round(estoqueDisp),
      status_gap: statusGap,
    });

    saldoCC = saldoCCProximo;
  }

  // Flag config_incompleta: sem limite bancário configurado ou cat_finimp nulo
  const configIncompleta =
    cat_finimp_cod_nulo || (dup_antecip_limite === 0 && finimp_limite === 0);

  const dupBloqAtual = semanas[0]?.dup_bloq ?? 0;
  const capCompraAtual = semanas[0]?.cap_compra ?? 0;
  const capCompraMed8 = semanas.slice(0, 8).reduce((a, s) => a + s.cap_compra, 0) / 8;

  const antecipDispAtual = semanas[0]?.antecip_disp ?? 0;

  return {
    kpis: {
      saldo_cc: Math.round(dados.saldo_cc),
      dup_total: Math.round(dados.dup_total),
      estoque_valor_venda: Math.round(estoque_valor_venda),
      antecip_disp: Math.round(antecipDispAtual),
      finimp_usado: Math.round(dados.finimp_saldo),
      dup_bloq: Math.round(dupBloqAtual),
      cap_compra_atual: Math.round(capCompraAtual),
      cap_compra_med8: Math.round(capCompraMed8),
      config_incompleta: configIncompleta,
      contas_ativas_count: dados.contas_ativas_count,
      contas_excluidas_count: dados.contas_excluidas_count,
    },
    breaking_points: {
      break_caixa: breakCaixa,
      break_antecip: breakAntecip,
      break_total: breakTotal,
      trava_finimp: travaFinimp,
    },
    semanas,
  };
}
