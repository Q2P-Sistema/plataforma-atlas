import { describe, it, expect, vi, beforeEach } from 'vitest';

// MOD-04/MOD-07 (ACXEGDP-275/278) — recalcularBuckets:
//   1. considera TODOS os status em aberto da view (sem WHERE status_titulo);
//   2. upsert em lote via ON CONFLICT (sem SELECT+UPDATE por mês);
//   3. buckets cujo mês sumiu da view são ZERADOS (pagar 0, cobertura 100,
//      over_hedged se sobrou NDF ativo) — antes ficavam com pagar_usd antigo
//      para sempre, inflando exposure/gap.
//
// Chain mock dirigido por FILA: cada statement awaitado consome o próximo
// resultado de `selectQueue` (na ordem em que o service executa). INSERTs
// terminam em onConflictDoUpdate (capturado, resolve direto, não consome fila).

const poolQuerySpy = vi.fn();

vi.mock('@atlas/core', () => ({
  getDb: vi.fn(),
  getPool: () => ({ query: (...args: unknown[]) => poolQuerySpy(...args) }),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@atlas/db', () => ({
  bucketMensal: { __id: 'bucketMensal' },
  ndfRegistro: { __id: 'ndfRegistro' },
  posicaoSnapshot: { __id: 'posicaoSnapshot' },
}));

vi.mock('@atlas/integration-bcb', () => ({
  fetchPtaxAtual: vi.fn(),
}));

interface Capturas {
  insertValues: unknown[];
  onConflict: unknown[];
  updateSets: unknown[];
}

function makeChain(selectQueue: unknown[][]): { chain: unknown; capturas: Capturas } {
  const capturas: Capturas = { insertValues: [], onConflict: [], updateSets: [] };
  let fila = [...selectQueue];
  const chain: Record<string, unknown> = {};
  const devolve = () => chain;
  chain.select = devolve;
  chain.from = devolve;
  chain.where = devolve;
  chain.groupBy = devolve;
  chain.orderBy = devolve;
  chain.limit = devolve;
  chain.insert = devolve;
  chain.values = (v: unknown) => {
    capturas.insertValues.push(v);
    return chain;
  };
  chain.onConflictDoUpdate = (cfg: unknown) => {
    capturas.onConflict.push(cfg);
    return Promise.resolve([]);
  };
  chain.update = devolve;
  chain.set = (s: unknown) => {
    capturas.updateSets.push(s);
    return chain;
  };
  // awaitar a chain em qualquer ponto consome o próximo resultado da fila
  chain.then = (resolve: (rows: unknown[]) => void) => {
    resolve(fila.shift() ?? []);
  };
  return { chain, capturas };
}

beforeEach(() => {
  poolQuerySpy.mockReset();
});

async function rodarRecalc(opts: {
  titulos: Array<{ bucket_mes: string; total_usd: string; count: string }>;
  ndfRows: Array<{ bucketId: string | null; totalUsd: string }>;
  existentes: Array<Record<string, unknown>>;
}): Promise<Capturas> {
  poolQuerySpy.mockResolvedValue({ rows: opts.titulos });
  const { chain, capturas } = makeChain([
    opts.ndfRows, // 1º await: NDFs ativos agrupados
    opts.existentes, // 2º await: buckets já persistidos (empresa acxe)
    // awaits seguintes (updates de zeragem) resolvem [] da fila vazia
  ]);
  const core = await import('@atlas/core');
  vi.mocked(core.getDb).mockReturnValue(chain as never);
  const { recalcularBuckets } = await import('../services/posicao.service.js');
  await recalcularBuckets();
  return capturas;
}

describe('recalcularBuckets — MOD-07: todos os status em aberto', () => {
  it('a query da view NÃO filtra por status_titulo (vencidos contam)', async () => {
    await rodarRecalc({ titulos: [], ndfRows: [], existentes: [] });
    const sqlView = String(poolQuerySpy.mock.calls[0]![0]);
    expect(sqlView).toContain('vw_hedge_pagar_usd');
    expect(sqlView).not.toContain('status_titulo');
  });
});

describe('recalcularBuckets — MOD-04: upsert em lote + zeragem de obsoletos', () => {
  it('meses da view viram UM insert com ON CONFLICT (mes_ref, empresa)', async () => {
    const capturas = await rodarRecalc({
      titulos: [
        { bucket_mes: '2026-08-01', total_usd: '500000', count: '3' },
        { bucket_mes: '2026-09-01', total_usd: '250000', count: '1' },
      ],
      ndfRows: [{ bucketId: 'b-ago', totalUsd: '300000' }],
      existentes: [
        { id: 'b-ago', mesRef: '2026-08-01', empresa: 'acxe', pagarUsd: '111.00', ndfUsd: '0.00' },
      ],
    });

    expect(capturas.insertValues).toHaveLength(1);
    const valores = capturas.insertValues[0] as Array<Record<string, string>>;
    expect(valores).toHaveLength(2);
    // bucket existente herda o NDF ativo: cobertura 300k/500k = 60% → ok
    expect(valores[0]).toMatchObject({
      mesRef: '2026-08-01',
      empresa: 'acxe',
      pagarUsd: '500000.00',
      ndfUsd: '300000.00',
      coberturaPct: '60.00',
      status: 'ok',
    });
    // bucket novo: sem NDF → sub_hedged
    expect(valores[1]).toMatchObject({
      mesRef: '2026-09-01',
      pagarUsd: '250000.00',
      ndfUsd: '0.00',
      status: 'sub_hedged',
    });
    // upsert declarado (não SELECT+UPDATE por mês)
    expect(capturas.onConflict).toHaveLength(1);
    const cfg = capturas.onConflict[0] as { target: unknown[]; set: Record<string, unknown> };
    expect(cfg.target).toHaveLength(2);
    expect(cfg.set).toHaveProperty('pagarUsd');
    expect(cfg.set).toHaveProperty('status');
  });

  it('bucket cujo mês sumiu da view é ZERADO (não mantém pagar_usd antigo)', async () => {
    const capturas = await rodarRecalc({
      titulos: [{ bucket_mes: '2026-09-01', total_usd: '100000', count: '1' }],
      ndfRows: [{ bucketId: 'b-quitado-ndf', totalUsd: '50000' }],
      existentes: [
        // mês quitado SEM ndf → ok
        { id: 'b-quitado', mesRef: '2026-07-01', empresa: 'acxe', pagarUsd: '400000.00', ndfUsd: '0.00' },
        // mês quitado COM ndf ativo remanescente → over_hedged
        { id: 'b-quitado-ndf', mesRef: '2026-08-01', empresa: 'acxe', pagarUsd: '90000.00', ndfUsd: '50000.00' },
        // mês já zerado → não gera update repetido
        { id: 'b-ja-zerado', mesRef: '2026-06-01', empresa: 'acxe', pagarUsd: '0.00', ndfUsd: '0.00' },
      ],
    });

    expect(capturas.updateSets).toHaveLength(2);
    expect(capturas.updateSets[0]).toMatchObject({
      pagarUsd: '0.00',
      ndfUsd: '0.00',
      coberturaPct: '100.00',
      status: 'ok',
    });
    expect(capturas.updateSets[1]).toMatchObject({
      pagarUsd: '0.00',
      ndfUsd: '50000.00',
      coberturaPct: '100.00',
      status: 'over_hedged',
    });
  });

  it('view vazia: nenhum insert, e TODOS os buckets com pagar > 0 são zerados', async () => {
    const capturas = await rodarRecalc({
      titulos: [],
      ndfRows: [],
      existentes: [
        { id: 'b1', mesRef: '2026-07-01', empresa: 'acxe', pagarUsd: '10.00', ndfUsd: '0.00' },
      ],
    });
    expect(capturas.insertValues).toHaveLength(0);
    expect(capturas.updateSets).toHaveLength(1);
    expect(capturas.updateSets[0]).toMatchObject({ pagarUsd: '0.00' });
  });
});
