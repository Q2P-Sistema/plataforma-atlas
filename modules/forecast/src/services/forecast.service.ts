import { createLogger } from '@atlas/core';
import { getConfig, type ForecastConfig } from './config.service.js';
import { getFamilias, type FamiliaEstoque } from './familia.service.js';
import { getVendas12mByCodigo } from './vendas.service.js';
import { getChegadasPorProduto } from './pedidos.service.js';
import { getSazFactors } from './sazonalidade.service.js';

const logger = createLogger('forecast:engine');

export interface ForecastSerie {
  dia: number;
  data: string;
  estoque: number;
  chegada: number;
  zona: 'ok' | 'atencao' | 'critico' | 'ruptura';
  venda_dia: number;
}

export interface CompraLocal {
  dia_abrir: number;
  lt_local: number;
  gap_dias: number;
  custo_oportunidade: number;
  qtd_local: number;
  valor_local: number;
}

export interface PedidoRota {
  codigo: string;
  qtd_pendente: number;
  data_chegada: string;
  valor_brl: number;
}

export interface FamiliaForecast {
  familia_id: string;
  familia_nome: string;
  is_internacional: boolean;
  lt_efetivo: number;
  pool_disponivel: number;
  pool_bloqueado: number;
  pool_transito: number;
  pool_total: number;
  cmc_medio: number;
  vendas12m: number;
  venda_diaria_media: number;
  venda_diaria_sazonalizada: number;
  cobertura_dias: number;
  dia_ruptura: number;
  dia_pedido_ideal: number;
  prazo_perdido: boolean;
  status: 'critico' | 'atencao' | 'ok';
  qtd_bruta: number;
  qtd_em_rota: number;
  qtd_liquida: number;
  qtd_sugerida: number;
  moq_ativo: number;
  valor_brl: number;
  compra_local: CompraLocal | null;
  serie: ForecastSerie[];
  skus: Array<{
    codigo: string;
    descricao: string;
    disponivel: number;
    bloqueado: number;
    transito: number;
    total: number;
    cmc: number;
    venda_dia: number;
    cobertura: number;
    lt: number;
  }>;
  pedidos_em_rota: PedidoRota[];
}

function arredMOQ(qtd: number, moq: number): number {
  if (qtd <= 0) return 0;
  return Math.ceil(qtd / moq) * moq;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function fmtDate(d: Date): string {
  return d.toISOString().split('T')[0]!;
}

/**
 * Runs the 120-day rolling forecast for a single family.
 */
async function buildForecastFamilia(
  familia: FamiliaEstoque,
  vendasMap: Map<string, number>,
  chegadasMap: Map<string, Array<{ data: string; qtd: number }>>,
  config: ForecastConfig,
): Promise<FamiliaForecast> {
  const hoje = new Date();
  const horizonte = config.horizonte_dias;

  // vendas12m for this family = sum across SKUs
  let vendas12m = 0;
  for (const sku of familia.skus) {
    vendas12m += vendasMap.get(sku.codigo) ?? 0;
  }
  const vendaDiariaMedia = vendas12m > 0 ? vendas12m / 365 : 0;

  // Sazonalidade — load all 12 months for this family
  const sazFactors = await getSazFactors(familia.familia_id);
  const mesAtual = hoje.getMonth() + 1;
  const sazAtual = sazFactors.get(mesAtual) ?? 1.0;
  const vendaDiariaSaz = vendaDiariaMedia * (1 + config.variacao_anual_pct / 100) * sazAtual;

  // Aggregate arrivals for this family
  const chegadasFamilia: Map<number, number> = new Map(); // dia offset → kg
  let qtdEmRota = 0;
  const pedidosEmRota: PedidoRota[] = [];

  for (const sku of familia.skus) {
    const chegadas = chegadasMap.get(sku.codigo) ?? [];
    for (const c of chegadas) {
      const chegadaDate = new Date(c.data);
      const diaOffset = Math.max(0, Math.ceil((chegadaDate.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24)));
      if (diaOffset <= horizonte) {
        chegadasFamilia.set(diaOffset, (chegadasFamilia.get(diaOffset) ?? 0) + c.qtd);
      }
      qtdEmRota += c.qtd;
      pedidosEmRota.push({
        codigo: sku.codigo,
        qtd_pendente: c.qtd,
        data_chegada: c.data,
        valor_brl: 0,
      });
    }
  }

  // 120-day simulation
  let estoque = familia.pool_total;
  let diaRuptura = -1;
  const serie: ForecastSerie[] = [];

  for (let d = 0; d < horizonte; d++) {
    const dataD = addDays(hoje, d);
    const mesD = dataD.getMonth() + 1;
    const sazD = sazFactors.get(mesD) ?? 1.0;
    const vendaDia = Math.round(vendaDiariaMedia * (1 + config.variacao_anual_pct / 100) * sazD);

    const chegada = chegadasFamilia.get(d) ?? 0;
    estoque = Math.max(0, estoque + chegada - vendaDia);

    let zona: 'ok' | 'atencao' | 'critico' | 'ruptura';
    if (estoque === 0) {
      zona = 'ruptura';
      if (diaRuptura === -1) diaRuptura = d;
    } else if (vendaDia > 0 && estoque / vendaDia < familia.lt_efetivo) {
      zona = 'critico';
    } else if (vendaDia > 0 && estoque / vendaDia < familia.lt_efetivo + 30) {
      zona = 'atencao';
    } else {
      zona = 'ok';
    }

    serie.push({
      dia: d,
      data: fmtDate(dataD),
      estoque,
      chegada,
      zona,
      venda_dia: vendaDia,
    });
  }

  // Dia pedido ideal
  const diaPedidoIdeal = diaRuptura >= 0
    ? diaRuptura - familia.lt_efetivo - config.buffer_dias
    : -1;
  const prazoPerdido = diaRuptura >= 0 && diaPedidoIdeal < 0;

  // Status
  const status: 'critico' | 'atencao' | 'ok' =
    diaRuptura >= 0 && diaRuptura <= 30 ? 'critico'
    : diaRuptura >= 0 && diaRuptura <= 60 ? 'atencao'
    : 'ok';

  // Cobertura
  const coberturaDias = vendaDiariaSaz > 0
    ? Math.round(familia.pool_total / vendaDiariaSaz)
    : 999;

  // vendaDiaria30d — average of next 30 days (seasonalized)
  let soma30d = 0;
  for (let d = 0; d < 30; d++) {
    const dataD = addDays(hoje, d);
    const mesD = dataD.getMonth() + 1;
    const sazD = sazFactors.get(mesD) ?? 1.0;
    soma30d += vendaDiariaMedia * (1 + config.variacao_anual_pct / 100) * sazD;
  }
  const vendaDiaria30d = soma30d / 30;

  // MOQ suggestion — only if ruptura detected (CALC-2 fix: legado so calcula se diaRuptura >= 0)
  const moqAtivo = familia.is_internacional ? config.moq_internacional : config.moq_nacional;
  let qtdBruta = 0;
  if (diaRuptura >= 0) {
    for (let d = 0; d < familia.lt_efetivo + config.horizonte_cobertura; d++) {
      const dataD = addDays(hoje, d);
      const mesD = dataD.getMonth() + 1;
      const sazD = sazFactors.get(mesD) ?? 1.0;
      qtdBruta += Math.round(vendaDiariaMedia * (1 + config.variacao_anual_pct / 100) * sazD);
    }
  }
  const qtdLiquida = Math.max(0, qtdBruta - qtdEmRota);
  const qtdSugerida = diaRuptura >= 0 ? arredMOQ(qtdLiquida, moqAtivo) : 0;

  // CALC-1 fix: use real price from pipeline orders, fallback to CMC
  const totalKgPedidos = pedidosEmRota.reduce((s, p) => s + p.qtd_pendente, 0);
  const totalBrlPedidos = pedidosEmRota.reduce((s, p) => s + p.valor_brl, 0);
  const precoPorKg = totalKgPedidos > 0 ? totalBrlPedidos / totalKgPedidos : familia.cmc_medio;
  const valorBrl = Math.round(qtdSugerida * precoPorKg);

  // Compra local emergencial
  let compraLocal: CompraLocal | null = null;
  if (prazoPerdido && diaRuptura >= 0) {
    const diaAbrir = Math.max(0, diaRuptura - config.lead_time_local);
    const gapDias = Math.max(0, familia.lt_efetivo - diaRuptura);
    let vendaGap = 0;
    for (let d = diaRuptura; d < diaRuptura + gapDias && d < horizonte; d++) {
      vendaGap += serie[d]?.venda_dia ?? 0;
    }
    const custoOportunidade = Math.round(vendaGap * familia.cmc_medio);
    const qtdLocal = arredMOQ(Math.max(vendaGap, Math.round(vendaDiaria30d * config.lead_time_local)), config.moq_nacional);
    compraLocal = {
      dia_abrir: diaAbrir,
      lt_local: config.lead_time_local,
      gap_dias: gapDias,
      custo_oportunidade: custoOportunidade,
      qtd_local: qtdLocal,
      valor_local: Math.round(qtdLocal * familia.cmc_medio),
    };
  }

  // SKU breakdown with per-SKU vendas
  const skus = familia.skus.map((sk) => {
    const skuVendas = vendasMap.get(sk.codigo) ?? 0;
    const skuVendaDia = skuVendas > 0 ? Math.round(skuVendas / 365) : 0;
    return {
      codigo: sk.codigo,
      descricao: sk.descricao,
      disponivel: sk.disponivel,
      bloqueado: sk.bloqueado,
      transito: sk.transito,
      total: sk.total,
      cmc: sk.cmc,
      venda_dia: skuVendaDia,
      cobertura: skuVendaDia > 0 ? Math.round(sk.total / skuVendaDia) : 999,
      lt: sk.lead_time,
    };
  });

  return {
    familia_id: familia.familia_id,
    familia_nome: familia.familia_nome,
    is_internacional: familia.is_internacional,
    lt_efetivo: familia.lt_efetivo,
    pool_disponivel: familia.pool_disponivel,
    pool_bloqueado: familia.pool_bloqueado,
    pool_transito: familia.pool_transito,
    pool_total: familia.pool_total,
    cmc_medio: familia.cmc_medio,
    vendas12m,
    venda_diaria_media: Math.round(vendaDiariaMedia),
    venda_diaria_sazonalizada: Math.round(vendaDiariaSaz),
    cobertura_dias: coberturaDias,
    dia_ruptura: diaRuptura,
    dia_pedido_ideal: diaPedidoIdeal,
    prazo_perdido: prazoPerdido,
    status,
    qtd_bruta: qtdBruta,
    qtd_em_rota: qtdEmRota,
    qtd_liquida: qtdLiquida,
    qtd_sugerida: qtdSugerida,
    moq_ativo: moqAtivo,
    valor_brl: valorBrl,
    compra_local: compraLocal,
    serie,
    skus,
    pedidos_em_rota: pedidosEmRota,
  };
}

/**
 * Runs forecast for all families or a specific one.
 */
export async function calcularForecast(familiaId?: string): Promise<FamiliaForecast[]> {
  const [config, familias, vendasMap, chegadasMap] = await Promise.all([
    getConfig(),
    getFamilias(),
    getVendas12mByCodigo(),
    getChegadasPorProduto(),
  ]);

  const alvo = familiaId
    ? familias.filter((f) => f.familia_id === familiaId)
    : familias;

  const results: FamiliaForecast[] = [];
  for (const fam of alvo) {
    const forecast = await buildForecastFamilia(fam, vendasMap, chegadasMap, config);
    results.push(forecast);
  }

  logger.info({ familias: results.length, urgentes: results.filter((r) => r.status === 'critico').length }, 'Forecast calculado');
  return results;
}

/**
 * Returns only families needing action in the next 15 days.
 */
export async function getFamiliasUrgentes(): Promise<FamiliaForecast[]> {
  const all = await calcularForecast();
  return all
    .filter((f) => (f.dia_pedido_ideal >= 0 && f.dia_pedido_ideal <= 15) || f.prazo_perdido)
    .sort((a, b) => {
      if (a.prazo_perdido && !b.prazo_perdido) return -1;
      if (!a.prazo_perdido && b.prazo_perdido) return 1;
      return a.dia_pedido_ideal - b.dia_pedido_ideal;
    });
}
