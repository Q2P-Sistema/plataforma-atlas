import { describe, it, expect, vi } from 'vitest';

// Mock @atlas/core before importing the service
vi.mock('@atlas/core', () => ({
  getPool: vi.fn(),
  getDb: vi.fn(),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

// Mock sazonalidade — return factor 1.0 for all months by default
vi.mock('../services/sazonalidade.service.js', () => ({
  getSazFactors: vi.fn().mockResolvedValue(
    new Map(Array.from({ length: 12 }, (_, i) => [i + 1, 1.0])),
  ),
}));

import { buildForecastFamilia } from '../services/forecast.service.js';
import { getSazFactors } from '../services/sazonalidade.service.js';
import type { FamiliaEstoque } from '../services/familia.service.js';
import type { ForecastConfig } from '../services/config.service.js';

const baseConfig: ForecastConfig = {
  variacao_anual_pct: 0,
  buffer_dias: 10,
  lead_time_local: 7,
  moq_internacional: 25000,
  moq_nacional: 12000,
  horizonte_dias: 120,
  horizonte_cobertura: 60,
};

function makeFamilia(overrides: Partial<FamiliaEstoque> = {}): FamiliaEstoque {
  return {
    familia_id: 'FAM_TEST',
    familia_nome: 'Familia Teste',
    is_internacional: true,
    pool_disponivel: 10000,
    pool_bloqueado: 0,
    pool_transito: 0,
    pool_total: 10000,
    cmc_medio: 15.0,
    lt_efetivo: 60,
    skus: [
      { codigo: 'SKU-A', descricao: 'Teste A', local: 'CD01', disponivel: 10000, bloqueado: 0, transito: 0, total: 10000, cmc: 15.0, lead_time: 60, marca: 'IMPACXE' },
    ],
    ...overrides,
  };
}

describe('buildForecastFamilia — ruptura detection', () => {
  it('detects ruptura when stock runs out within horizon', async () => {
    // 10000kg stock, 200kg/day demand → ruptura at day 50
    const vendasMap = new Map([['SKU-A', 200 * 365]]); // 200/day * 365 = 73000/year
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const result = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);

    // 10000/200 = 50, but Math.round in demand can cause +/-1d drift
    expect(result.dia_ruptura).toBeGreaterThanOrEqual(49);
    expect(result.dia_ruptura).toBeLessThanOrEqual(51);
  });

  it('no ruptura when stock covers full horizon', async () => {
    // 10000kg stock, 10kg/day demand → would last 1000 days
    const vendasMap = new Map([['SKU-A', 10 * 365]]);
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const result = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);

    expect(result.dia_ruptura).toBe(-1);
    expect(result.status).toBe('ok');
  });

  it('no ruptura with zero sales history', async () => {
    const vendasMap = new Map<string, number>();
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const result = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);

    expect(result.dia_ruptura).toBe(-1);
    expect(result.venda_diaria_media).toBe(0);
    expect(result.cobertura_dias).toBe(999);
  });
});

describe('buildForecastFamilia — dia_pedido_ideal', () => {
  it('calculates dia_pedido_ideal = ruptura - lt - buffer', async () => {
    // ruptura ~50, lt=60, buffer=10 → ideal = 50-60-10 = -20 (prazo perdido)
    const vendasMap = new Map([['SKU-A', 200 * 365]]);
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const result = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);

    expect(result.dia_pedido_ideal).toBe(result.dia_ruptura - 60 - 10);
    expect(result.prazo_perdido).toBe(true);
  });

  it('dia_pedido_ideal is -1 when no ruptura', async () => {
    const vendasMap = new Map([['SKU-A', 10 * 365]]);
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const result = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);

    expect(result.dia_pedido_ideal).toBe(-1);
    expect(result.prazo_perdido).toBe(false);
  });
});

describe('buildForecastFamilia — CALC-2: qtdSugerida only if ruptura', () => {
  it('qtdSugerida = 0 when no ruptura (CALC-2)', async () => {
    const vendasMap = new Map([['SKU-A', 10 * 365]]);
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const result = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);

    expect(result.qtd_sugerida).toBe(0);
    expect(result.qtd_bruta).toBe(0);
    expect(result.valor_brl).toBe(0);
  });

  it('qtdSugerida > 0 and rounded to MOQ when ruptura detected', async () => {
    const vendasMap = new Map([['SKU-A', 200 * 365]]);
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const result = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);

    expect(result.qtd_sugerida).toBeGreaterThan(0);
    // MOQ internacional = 25000, so qtdSugerida must be multiple of 25000
    expect(result.qtd_sugerida % 25000).toBe(0);
  });

  it('uses MOQ nacional for non-international families', async () => {
    const familia = makeFamilia({ is_internacional: false, lt_efetivo: 15 });
    const vendasMap = new Map([['SKU-A', 200 * 365]]);
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const result = await buildForecastFamilia(familia, vendasMap, chegadasMap, baseConfig);

    if (result.qtd_sugerida > 0) {
      // MOQ nacional = 12000
      expect(result.qtd_sugerida % 12000).toBe(0);
    }
  });
});

describe('buildForecastFamilia — arrivals injection', () => {
  it('arrivals extend stock and delay ruptura', async () => {
    const vendasMap = new Map([['SKU-A', 200 * 365]]);
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    // Without arrivals
    const resultNoArr = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);

    // With 5000kg arriving on day 30
    const hoje = new Date();
    const day30 = new Date(hoje);
    day30.setDate(day30.getDate() + 30);
    const chegadasWithArr = new Map([['SKU-A', [{ data: day30.toISOString().split('T')[0]!, qtd: 5000, valor_brl: 75000 }]]]);
    const resultWithArr = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasWithArr, baseConfig);

    // Ruptura should be delayed with arrivals
    expect(resultWithArr.dia_ruptura).toBeGreaterThan(resultNoArr.dia_ruptura);
    expect(resultWithArr.qtd_em_rota).toBe(5000);
  });

  it('tracks pedidos_em_rota with valor_brl from pipeline (CALC-1)', async () => {
    const vendasMap = new Map([['SKU-A', 200 * 365]]);
    const hoje = new Date();
    const day20 = new Date(hoje);
    day20.setDate(day20.getDate() + 20);

    const chegadasMap = new Map([['SKU-A', [{ data: day20.toISOString().split('T')[0]!, qtd: 3000, valor_brl: 45000 }]]]);

    const result = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);

    expect(result.pedidos_em_rota).toHaveLength(1);
    expect(result.pedidos_em_rota[0]!.valor_brl).toBe(45000);
    expect(result.pedidos_em_rota[0]!.qtd_pendente).toBe(3000);
  });
});

describe('buildForecastFamilia — compra local emergencial', () => {
  it('generates compra_local when prazo_perdido', async () => {
    // lt=60, demand high → ruptura early → prazo perdido
    const vendasMap = new Map([['SKU-A', 200 * 365]]);
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const result = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);

    expect(result.prazo_perdido).toBe(true);
    expect(result.compra_local).not.toBeNull();
    expect(result.compra_local!.gap_dias).toBeGreaterThan(0);
    expect(result.compra_local!.custo_oportunidade).toBeGreaterThan(0);
    // qtd_local should be MOQ-rounded (nacional MOQ = 12000)
    expect(result.compra_local!.qtd_local % 12000).toBe(0);
  });

  it('no compra_local when prazo is not lost', async () => {
    // low demand → no ruptura → no prazo perdido
    const vendasMap = new Map([['SKU-A', 10 * 365]]);
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const result = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);

    expect(result.prazo_perdido).toBe(false);
    expect(result.compra_local).toBeNull();
  });
});

describe('buildForecastFamilia — sazonalidade', () => {
  it('applies sazonalidade factor to demand', async () => {
    // Set factor 1.5 for current month
    const currentMonth = new Date().getMonth() + 1;
    const sazMap = new Map(Array.from({ length: 12 }, (_, i) => [i + 1, 1.0] as [number, number]));
    sazMap.set(currentMonth, 1.5);
    (getSazFactors as ReturnType<typeof vi.fn>).mockResolvedValueOnce(sazMap);

    const vendasMap = new Map([['SKU-A', 100 * 365]]);
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const result = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);

    // venda_diaria_sazonalizada should be higher than base (100) due to 1.5x factor
    expect(result.venda_diaria_sazonalizada).toBeGreaterThan(result.venda_diaria_media);
  });
});

describe('buildForecastFamilia — demand adjustment (GAP-F3)', () => {
  it('adjusts demand per SKU when ajustesDemanda provided', async () => {
    const vendasMap = new Map([['SKU-A', 100 * 365]]);
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const resultBase = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);
    const resultAdj = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig, { 'SKU-A': 20 });

    // +20% adjustment → higher daily demand → earlier ruptura (or same if no ruptura)
    expect(resultAdj.venda_diaria_media).toBeGreaterThan(resultBase.venda_diaria_media);
  });
});

describe('buildForecastFamilia — serie output', () => {
  it('generates exactly horizonte_dias data points', async () => {
    const vendasMap = new Map([['SKU-A', 100 * 365]]);
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const result = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);

    expect(result.serie).toHaveLength(120);
    expect(result.serie[0]!.dia).toBe(0);
    expect(result.serie[119]!.dia).toBe(119);
  });

  it('stock is non-negative in serie', async () => {
    const vendasMap = new Map([['SKU-A', 200 * 365]]);
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const result = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);

    for (const s of result.serie) {
      expect(s.estoque).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('buildForecastFamilia — status classification', () => {
  it('critico when ruptura <= 30d', async () => {
    // Small stock, high demand → ruptura very soon
    const familia = makeFamilia({ pool_total: 2000, pool_disponivel: 2000, skus: [
      { codigo: 'SKU-A', descricao: 'Test', local: 'CD', disponivel: 2000, bloqueado: 0, transito: 0, total: 2000, cmc: 15, lead_time: 60, marca: 'IMPACXE' },
    ] });
    const vendasMap = new Map([['SKU-A', 200 * 365]]);
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const result = await buildForecastFamilia(familia, vendasMap, chegadasMap, baseConfig);

    expect(result.dia_ruptura).toBeLessThanOrEqual(30);
    expect(result.status).toBe('critico');
  });

  it('ok when no ruptura within horizon', async () => {
    const vendasMap = new Map([['SKU-A', 10 * 365]]);
    const chegadasMap = new Map<string, Array<{ data: string; qtd: number; valor_brl: number }>>();

    const result = await buildForecastFamilia(makeFamilia(), vendasMap, chegadasMap, baseConfig);

    expect(result.status).toBe('ok');
  });
});
