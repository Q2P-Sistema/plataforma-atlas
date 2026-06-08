import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock do pool: query() responde a (1) resolução da data e (2) folhas do snapshot.
const query = vi.fn();
vi.mock('@atlas/core', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getPool: () => ({ query }),
}));

const { listarSnapshotCmc, listarTendenciaCmc, listarFiltrosCmc } = await import(
  '../services/cmc.service.js'
);

// Família "PP HOMO": dois nacionais com CMC diferente (10 e 20) + um importado.
// Ponderado nacional = (1000+6000)/(100+300) = 17.5 (≠ média aritmética 15).
const LEAVES = [
  { codigo_produto: 'P1', descricao_produto: 'Prod 1', familia: 'PP HOMO', origem: 'NACIONAL', volume_total: '100', valor_total_cmc: '1000' },
  { codigo_produto: 'P2', descricao_produto: 'Prod 2', familia: 'PP HOMO', origem: 'NACIONAL', volume_total: '300', valor_total_cmc: '6000' },
  { codigo_produto: 'P4', descricao_produto: 'Prod 4', familia: 'PP HOMO', origem: 'IMPORTADO', volume_total: '100', valor_total_cmc: '500' },
  { codigo_produto: 'P3', descricao_produto: 'Prod 3', familia: 'Sem família', origem: 'IMPORTADO', volume_total: '0', valor_total_cmc: '0' },
];

function mockDb(snap: string | null = '2026-06-08', hoje = '2026-06-08', leaves: unknown[] = LEAVES) {
  query.mockImplementation((sql: string) => {
    if (sql.includes('MAX(data_snapshot)')) return Promise.resolve({ rows: [{ snap, hoje }] });
    return Promise.resolve({ rows: leaves });
  });
}

beforeEach(() => {
  query.mockReset();
  mockDb();
});

describe('listarSnapshotCmc', () => {
  it('agrega CMC da família ponderado por volume (não média aritmética)', async () => {
    const r = await listarSnapshotCmc();
    const fam = r.familias.find((f) => f.descricaoFamilia === 'PP HOMO')!;
    // total família: vol 500, valor 7500 → cmc 15
    expect(fam.volumeKg).toBe(500);
    expect(fam.valor).toBe(7500);
    expect(fam.cmcPonderado).toBeCloseTo(15, 6);
    // nacional ponderado = 17.5 (≠ (10+20)/2 = 15)
    expect(fam.porOrigem.nacional.cmcPonderado).toBeCloseTo(17.5, 6);
    expect(fam.porOrigem.importado.cmcPonderado).toBeCloseTo(5, 6);
  });

  it('reconcilia soma dos produtos com o total da família', async () => {
    const r = await listarSnapshotCmc();
    const fam = r.familias.find((f) => f.descricaoFamilia === 'PP HOMO')!;
    const somaVol = fam.produtos.reduce((s, p) => s + p.volumeKg, 0);
    const somaValor = fam.produtos.reduce((s, p) => s + p.valor, 0);
    expect(somaVol).toBe(fam.volumeKg);
    expect(somaValor).toBe(fam.valor);
  });

  it('agrupa produtos sem família em "Sem família"', async () => {
    const r = await listarSnapshotCmc();
    expect(r.familias.some((f) => f.descricaoFamilia === 'Sem família')).toBe(true);
  });

  it('exibe CMC nulo quando volume é zero (sem divisão por zero)', async () => {
    const r = await listarSnapshotCmc();
    const semFam = r.familias.find((f) => f.descricaoFamilia === 'Sem família')!;
    expect(semFam.cmcPonderado).toBeNull();
    expect(semFam.produtos[0]!.cmcPonderado).toBeNull();
  });

  it('resumo global traz volume e valor totais (sem CMC global)', async () => {
    const r = await listarSnapshotCmc();
    expect(r.resumo.volumeTotalKg).toBe(500);
    expect(r.resumo.valorTotal).toBe(7500);
    expect(r.resumo).not.toHaveProperty('cmcPonderado');
  });

  it('sinaliza defasado quando o snapshot não é do dia corrente', async () => {
    mockDb('2026-06-07', '2026-06-08');
    const r = await listarSnapshotCmc();
    expect(r.dataSnapshot).toBe('2026-06-07');
    expect(r.defasado).toBe(true);
  });

  it('retorna vazio quando não há snapshot algum', async () => {
    mockDb(null, '2026-06-08', []);
    const r = await listarSnapshotCmc();
    expect(r.dataSnapshot).toBeNull();
    expect(r.familias).toEqual([]);
    expect(r.resumo).toEqual({ volumeTotalKg: 0, valorTotal: 0 });
  });
});

describe('listarTendenciaCmc', () => {
  // range (MIN/MAX) + dados da série (BETWEEN). Dia 02 ausente → lacuna.
  function mockTendencia(rows: unknown[], de = '2026-06-01', ate = '2026-06-03') {
    query.mockImplementation((sql: string) => {
      if (sql.includes('MIN(data_snapshot)')) return Promise.resolve({ rows: [{ de, ate }] });
      if (sql.includes('BETWEEN')) return Promise.resolve({ rows });
      return Promise.resolve({ rows: [] });
    });
  }

  it('monta o eixo de datas por calendário e marca dia sem coleta como lacuna (null)', async () => {
    mockTendencia([
      { data: '2026-06-01', chave: 'Total', label: 'Total', vol: '100', valor: '1000' },
      { data: '2026-06-03', chave: 'Total', label: 'Total', vol: '200', valor: '1800' },
    ]);
    const r = await listarTendenciaCmc();
    expect(r.datas).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
    expect(r.series).toHaveLength(1);
    const s = r.series[0]!;
    expect(s.chave).toBe('Total');
    expect(s.pontos[0]).toMatchObject({ cmcPonderado: 10, volumeKg: 100 });
    expect(s.pontos[1]).toBeNull(); // 2026-06-02 sem coleta
    expect(s.pontos[2]).toMatchObject({ cmcPonderado: 9 });
  });

  it('cria uma série por família quando famílias são filtradas', async () => {
    mockTendencia([
      { data: '2026-06-01', chave: 'PP HOMO', label: 'PP HOMO', vol: '100', valor: '1000' },
      { data: '2026-06-03', chave: 'PP HOMO', label: 'PP HOMO', vol: '100', valor: '1200' },
    ]);
    const r = await listarTendenciaCmc({ familias: ['PP HOMO'] });
    expect(r.series.map((s) => s.chave)).toEqual(['PP HOMO']);
    expect(r.series[0]!.pontos.filter(Boolean)).toHaveLength(2);
  });
});

describe('listarFiltrosCmc', () => {
  function mockFiltros(rows: unknown[]) {
    query.mockImplementation((sql: string) => {
      if (sql.includes('WITH snap')) return Promise.resolve({ rows });
      return Promise.resolve({ rows: [] });
    });
  }

  it('retorna famílias distintas (ordenadas) e produtos únicos por código', async () => {
    mockFiltros([
      { familia: 'PP HOMO 25', codigo_produto: 'PP-146', descricao_produto: 'PP A' },
      { familia: 'PP HOMO 25', codigo_produto: 'PP-024', descricao_produto: 'PP B' },
      { familia: 'PEAD FILME', codigo_produto: 'PE-1', descricao_produto: 'PE A' },
    ]);
    const r = await listarFiltrosCmc();
    expect(r.familias).toEqual(['PEAD FILME', 'PP HOMO 25']);
    expect(r.produtos).toHaveLength(3);
    expect(r.produtos[0]).toMatchObject({ codigo: 'PP-146', familia: 'PP HOMO 25' });
  });
});
