import { describe, it, expect, vi, beforeEach } from 'vitest';
import { desc } from 'drizzle-orm';
import { ndfTaxas } from '@atlas/db';

// MOD-01: o motor carregava as taxas NDF mais ANTIGAS (orderBy asc + limit).
// Mockamos @atlas/core (evita getConfig/env) com um chain que captura o orderBy
// e resolve as rows: .where() → config; .orderBy().limit() → taxas NDF.

let orderByCalls: unknown[][] = [];
let configRows: Array<{ chave: string; valor: string }> = [];
let taxaRows: Array<{ prazoDias: number; taxa: string; dataRef: string }> = [];

function makeChain(): unknown {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => Promise.resolve(configRows);
  chain.orderBy = (...args: unknown[]) => {
    orderByCalls.push(args);
    return chain;
  };
  chain.limit = () => Promise.resolve(taxaRows);
  return chain;
}

vi.mock('@atlas/core', () => ({
  getDb: () => makeChain(),
  getPool: () => ({ query: vi.fn() }),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { loadMotorConfig } from '../services/motor.service.js';
import { getTaxasNdf } from '../services/config.service.js';

beforeEach(() => {
  orderByCalls = [];
  configRows = [
    { chave: 'cobertura_base_pct', valor: '60' },
    { chave: 'cobertura_bump_pct', valor: '68' },
    { chave: 'estoque_bump_threshold', valor: '0.5' },
  ];
  // 3 datas de cotacao, 2 prazos, taxa distinta por data. A query CORRIGIDA
  // retorna data_ref DESC (mais nova primeiro).
  taxaRows = [
    { prazoDias: 30, taxa: '6.00', dataRef: '2026-06-01' }, // mais recente
    { prazoDias: 60, taxa: '6.10', dataRef: '2026-06-01' },
    { prazoDias: 30, taxa: '5.50', dataRef: '2026-02-01' },
    { prazoDias: 60, taxa: '5.60', dataRef: '2026-02-01' },
    { prazoDias: 30, taxa: '5.00', dataRef: '2026-01-01' }, // mais antiga
    { prazoDias: 60, taxa: '5.10', dataRef: '2026-01-01' },
  ];
});

describe('MOD-01 — motor usa as taxas NDF MAIS RECENTES', () => {
  it('loadMotorConfig: ndf_rates fica com a taxa mais nova por prazo (first-wins)', async () => {
    const config = await loadMotorConfig();
    // Com o bug (last-wins sobre asc truncado) daria 5.00/5.10 (Janeiro).
    expect(config.ndf_rates.ndf_30d).toBe(6.0);
    expect(config.ndf_rates.ndf_60d).toBe(6.1);
  });

  it('loadMotorConfig: ordena por data_ref DESC (nao a coluna crua = asc)', async () => {
    await loadMotorConfig();
    // O 2o orderBy é o das taxas NDF (o 1o, se houver, é da config).
    const ndfOrderBy = orderByCalls[orderByCalls.length - 1]!;
    expect(ndfOrderBy[0]).toStrictEqual(desc(ndfTaxas.dataRef));
    // e NAO a coluna crua (asc), que era o bug:
    expect(ndfOrderBy[0]).not.toBe(ndfTaxas.dataRef);
  });

  it('getTaxasNdf() sem dataRef: ordena por data_ref DESC', async () => {
    await getTaxasNdf();
    const ndfOrderBy = orderByCalls[orderByCalls.length - 1]!;
    expect(ndfOrderBy[0]).toStrictEqual(desc(ndfTaxas.dataRef));
    expect(ndfOrderBy[0]).not.toBe(ndfTaxas.dataRef);
  });
});
