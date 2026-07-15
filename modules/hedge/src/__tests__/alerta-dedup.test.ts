import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BucketMensal } from '@atlas/db';

// MOD-05 (ACXEGDP-276) — gerarAlertas:
//   1. bucket em gap faz UPSERT no índice único parcial (nada de INSERT
//      incondicional a cada cache-miss — era isso que acumulava duplicatas);
//   2. alertas abertos cujo gap fechou são AUTO-RESOLVIDOS;
//   3. severidade segue os thresholds do config_motor.
//
// Chain mock dirigido por fila (mesmo padrão do posicao-recalc.test.ts).

vi.mock('@atlas/core', () => ({
  getDb: vi.fn(),
  getPool: () => ({ query: vi.fn() }),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@atlas/db', () => ({
  alerta: { __id: 'alerta' },
  configMotor: { __id: 'configMotor' },
}));

interface Capturas {
  insertValues: Array<Record<string, unknown>>;
  onConflict: Array<{ targetWhere?: unknown; set: Record<string, unknown> }>;
  updateSets: Array<Record<string, unknown>>;
  ordem: string[];
}

function makeChain(selectQueue: unknown[][]): { chain: unknown; capturas: Capturas } {
  const capturas: Capturas = { insertValues: [], onConflict: [], updateSets: [], ordem: [] };
  const fila = [...selectQueue];
  const chain: Record<string, unknown> = {};
  const devolve = () => chain;
  chain.select = devolve;
  chain.from = devolve;
  chain.where = devolve;
  chain.limit = devolve;
  chain.insert = devolve;
  chain.values = (v: Record<string, unknown>) => {
    capturas.insertValues.push(v);
    capturas.ordem.push('insert');
    return chain;
  };
  chain.onConflictDoUpdate = (cfg: never) => {
    capturas.onConflict.push(cfg);
    return Promise.resolve([]);
  };
  chain.update = devolve;
  chain.set = (s: Record<string, unknown>) => {
    capturas.updateSets.push(s);
    capturas.ordem.push('update');
    return chain;
  };
  chain.then = (resolve: (rows: unknown[]) => void) => {
    resolve(fila.shift() ?? []);
  };
  return { chain, capturas };
}

function bucket(partial: Partial<BucketMensal> & { id: string }): BucketMensal {
  return {
    mesRef: '2026-08-01',
    empresa: 'acxe',
    pagarUsd: '0',
    ndfUsd: '0',
    coberturaPct: '0',
    status: 'ok',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as BucketMensal;
}

async function rodar(buckets: BucketMensal[]): Promise<Capturas> {
  const { chain, capturas } = makeChain([
    [{ chave: 'threshold_critico', valor: 1000000 }], // 1º await: threshold crítico
    [{ chave: 'threshold_alta', valor: 500000 }], // 2º await: threshold alta
    // 3º await: UPDATE de auto-resolve (resolve [])
  ]);
  const core = await import('@atlas/core');
  vi.mocked(core.getDb).mockReturnValue(chain as never);
  const { gerarAlertas } = await import('../services/alerta.service.js');
  await gerarAlertas(buckets);
  return capturas;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gerarAlertas — MOD-05: upsert + auto-resolve', () => {
  it('bucket em gap: UM upsert com targetWhere (não insert incondicional)', async () => {
    const capturas = await rodar([
      bucket({ id: 'b1', pagarUsd: '800000', ndfUsd: '100000' }), // gap 700k → alta
    ]);

    expect(capturas.insertValues).toHaveLength(1);
    expect(capturas.insertValues[0]).toMatchObject({
      tipo: 'gap_cobertura',
      severidade: 'alta',
      bucketId: 'b1',
    });
    expect(capturas.onConflict).toHaveLength(1);
    expect(capturas.onConflict[0]!.targetWhere).toBeDefined();
    expect(capturas.onConflict[0]!.set).toMatchObject({ severidade: 'alta' });
    // o upsert NÃO mexe em `lido` (alerta já visto não volta como não-lido)
    expect(capturas.onConflict[0]!.set).not.toHaveProperty('lido');
  });

  it('severidade segue os thresholds: 1,2M → crítico; 600k → alta; 100k → média', async () => {
    const capturas = await rodar([
      bucket({ id: 'b-crit', pagarUsd: '1200000', ndfUsd: '0' }),
      bucket({ id: 'b-alta', pagarUsd: '600000', ndfUsd: '0' }),
      bucket({ id: 'b-media', pagarUsd: '100000', ndfUsd: '0' }),
    ]);
    expect(capturas.insertValues.map((v) => v.severidade)).toEqual(['critico', 'alta', 'media']);
  });

  it('gap fechado: zero inserts e UM update de auto-resolve', async () => {
    const capturas = await rodar([
      bucket({ id: 'b1', pagarUsd: '100000', ndfUsd: '100000' }), // gap 0
      bucket({ id: 'b2', pagarUsd: '0', ndfUsd: '50000' }), // zerado (over_hedged)
    ]);
    expect(capturas.insertValues).toHaveLength(0);
    expect(capturas.updateSets).toHaveLength(1);
    expect(capturas.updateSets[0]).toMatchObject({ resolvido: true });
    expect(capturas.updateSets[0]!.resolvidoAt).toBeInstanceOf(Date);
  });

  it('auto-resolve roda ANTES dos upserts (bucket que saiu de gap não “renasce”)', async () => {
    const capturas = await rodar([
      bucket({ id: 'b1', pagarUsd: '900000', ndfUsd: '0' }),
    ]);
    expect(capturas.ordem[0]).toBe('update');
    expect(capturas.ordem.slice(1)).toEqual(['insert']);
  });
});
