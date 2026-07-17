import { describe, it, expect, vi } from 'vitest';

// montarExecutivo é pura; o module-load do service puxa cockpit/metricas/core,
// que só tocam banco/BCB dentro das funções (não chamadas aqui).
vi.mock('@atlas/core', () => ({
  getPool: vi.fn(),
  getConfig: vi.fn(() => ({})),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  montarExecutivo,
  type LinhaPosicao,
  type LinhaTransito,
} from '../services/cockpit-executivo.service.js';

const posicao: LinhaPosicao[] = [
  // Santo André — Importado agrega 11.1 + 12.1; SKU 100 aparece nos dois códigos
  { codigoEstoque: '11.1', codigoAcxe: 100, nome: 'PEAD X', familia: 'PEAD', kg: 1000, valorBrl: 10_000 },
  { codigoEstoque: '12.1', codigoAcxe: 100, nome: 'PEAD X', familia: 'PEAD', kg: 500, valorBrl: 5_000 },
  { codigoEstoque: '11.1', codigoAcxe: 200, nome: 'PP Y', familia: 'PP', kg: 2000, valorBrl: 30_000 },
  { codigoEstoque: '21.1', codigoAcxe: 300, nome: 'PS Z', familia: null, kg: 100, valorBrl: 0 }, // sem custo
  // Comodato (90.0.1) — fora dos galpões, dentro do total
  { codigoEstoque: '90.0.1', codigoAcxe: 200, nome: 'PP Y', familia: 'PP', kg: 50, valorBrl: 750 },
];

const transito: LinhaTransito[] = [
  { estagio: 'transito_intl', codigoAcxe: 400, nome: 'PEBD W', familia: 'PEBD', lotes: 2, kg: 3000, valorBrl: 24_000, kgSemCusto: 0 },
  { estagio: 'transito_local', codigoAcxe: 100, nome: 'PEAD X', familia: 'PEAD', lotes: 1, kg: 200, valorBrl: 1_800, kgSemCusto: 0 },
  { estagio: 'no_porto', codigoAcxe: 500, nome: 'ABS Q', familia: 'ABS', lotes: 1, kg: 400, valorBrl: 0, kgSemCusto: 400 },
];

describe('cockpit executivo — montarExecutivo', () => {
  const data = montarExecutivo(posicao, transito, [], 5.0, '2026-07-15');

  it('agrupa galpões pelo nome executivo somando códigos espelhos', () => {
    const sa = data.galpoes.find((g) => g.nome === 'Santo André — Importado');
    expect(sa).toBeDefined();
    expect(sa!.codigos).toEqual(['11.1', '12.1']);
    expect(sa!.kg).toBe(3500);
    expect(sa!.valorBrl).toBe(45_000);
    expect(sa!.produtos).toBe(2); // SKUs distintos (100 e 200), não linhas
  });

  it('galpões ordenados por valor desc e comodato fora deles', () => {
    expect(data.galpoes[0]?.nome).toBe('Santo André — Importado');
    expect(data.galpoes.some((g) => g.codigos.includes('90.0.1'))).toBe(false);
  });

  it('separa comodato nos totais e soma tudo no valor total', () => {
    expect(data.totais.comodatoKg).toBe(50);
    expect(data.totais.comodatoBrl).toBe(750);
    expect(data.totais.emGalpaoKg).toBe(3600);
    expect(data.totais.emGalpaoBrl).toBe(45_000);
    expect(data.totais.emTransitoKg).toBe(3600);
    expect(data.totais.emTransitoBrl).toBe(25_800);
    expect(data.totais.valorTotalBrl).toBe(45_000 + 25_800 + 750);
    expect(data.totais.kgTotal).toBe(3600 + 3600 + 50);
  });

  it('esteira sempre tem os 4 estágios na ordem do pipeline, mesmo vazios', () => {
    expect(data.transito.map((t) => t.estagio)).toEqual([
      'aguardando_embarque',
      'transito_intl',
      'no_porto',
      'transito_local',
    ]);
    expect(data.transito[0]).toMatchObject({ lotes: 0, kg: 0, valorBrl: 0 });
    expect(data.transito[1]).toMatchObject({ lotes: 2, kg: 3000, valorBrl: 24_000 });
  });

  it('composição por família cobre posição + trânsito (100% do dinheiro)', () => {
    const pead = data.familias.find((f) => f.familia === 'PEAD');
    expect(pead).toBeDefined();
    // 1000+500 (galpões) + 200 (trânsito) do mesmo SKU 100
    expect(pead!.kg).toBe(1700);
    expect(pead!.valorBrl).toBe(16_800);
    expect(pead!.produtos).toHaveLength(1);
    expect(pead!.produtos[0]).toMatchObject({ codigoAcxe: 100, kg: 1700, valorBrl: 16_800 });

    const semFamilia = data.familias.find((f) => f.familia === 'Sem família');
    expect(semFamilia?.kg).toBe(100);

    // Ordenadas por valor desc
    const valores = data.familias.map((f) => f.valorBrl);
    expect(valores).toEqual([...valores].sort((a, b) => b - a));
  });

  it('kg sem custo somam posição zerada + trânsito sem custo', () => {
    expect(data.totais.kgSemCusto).toBe(100 + 400);
  });

  it('exposição cambial = estágio transito_intl, convertida pela PTAX', () => {
    expect(data.exposicaoCambial.brl).toBe(24_000);
    expect(data.exposicaoCambial.usd).toBe(4_800);
    expect(data.exposicaoCambial.ptax).toBe(5.0);
  });

  it('propaga a data da posição', () => {
    expect(data.dataPosicao).toBe('2026-07-15');
  });
});

describe('cockpit executivo — valorização do pendente fiscal', () => {
  it('valoriza pelo custo médio ponderado do SKU em estoque', () => {
    const data = montarExecutivo(posicao, transito, [{ codigoAcxe: 100, kg: 1000 }], 5.0, null);
    // SKU 100: (10000+5000+1800) / (1000+500+200) = 16800/1700 ≈ 9,8824 R$/kg
    expect(data.posicaoFiscal.pendenteImportacaoKg).toBe(1000);
    expect(data.posicaoFiscal.pendenteImportacaoBrl).toBeCloseTo(1000 * (16_800 / 1700), 6);
    expect(data.posicaoFiscal.kgSemCusto).toBe(0);
  });

  it('usa custo do lote em trânsito quando o SKU não tem estoque', () => {
    const data = montarExecutivo(posicao, transito, [{ codigoAcxe: 400, kg: 500 }], 5.0, null);
    // SKU 400 só existe em trânsito: 24000/3000 = 8 R$/kg
    expect(data.posicaoFiscal.pendenteImportacaoBrl).toBeCloseTo(4_000, 6);
  });

  it('acumula kg sem custo quando não há referência nenhuma', () => {
    const data = montarExecutivo(posicao, transito, [{ codigoAcxe: 999, kg: 300 }], 5.0, null);
    expect(data.posicaoFiscal.pendenteImportacaoKg).toBe(300);
    expect(data.posicaoFiscal.pendenteImportacaoBrl).toBe(0);
    expect(data.posicaoFiscal.kgSemCusto).toBe(300);
  });

  it('lote sem custo não contamina a régua de custo do SKU', () => {
    // SKU 500 está em trânsito com kgSemCusto=400 (custo 0) — não vira régua
    const data = montarExecutivo(posicao, transito, [{ codigoAcxe: 500, kg: 100 }], 5.0, null);
    expect(data.posicaoFiscal.kgSemCusto).toBe(100);
  });
});

describe('cockpit executivo — produto Q2P sem correlato ACXE', () => {
  it('conta no galpão e na família mesmo com codigoAcxe null', () => {
    const semCorrelato: LinhaPosicao[] = [
      ...posicao,
      { codigoEstoque: '11.2', codigoAcxe: null, nome: 'PP HP 462R', familia: 'PP', kg: 50_625, valorBrl: 460_938 },
    ];
    const data = montarExecutivo(semCorrelato, transito, [], 5.0, null);

    const nacional = data.galpoes.find((g) => g.nome === 'Santo André — Nacional');
    expect(nacional?.kg).toBe(50_625);
    expect(nacional?.valorBrl).toBe(460_938);

    const pp = data.familias.find((f) => f.familia === 'PP');
    // PP Y (2000+50 kg em posição) + PP HP 462R (50625)
    expect(pp?.kg).toBe(2050 + 50_625);
    expect(pp?.produtos.some((p) => p.codigoAcxe === null && p.nome === 'PP HP 462R')).toBe(true);
  });

  it('sem correlato não vira régua de custo para pendente fiscal', () => {
    const soSemCorrelato: LinhaPosicao[] = [
      { codigoEstoque: '11.2', codigoAcxe: null, nome: 'PP HP 462R', familia: 'PP', kg: 100, valorBrl: 1_000 },
    ];
    const data = montarExecutivo(soSemCorrelato, [], [{ codigoAcxe: 700, kg: 50 }], 5.0, null);
    expect(data.posicaoFiscal.kgSemCusto).toBe(50);
  });
});

describe('cockpit executivo — entradas vazias', () => {
  it('não quebra com tudo vazio', () => {
    const data = montarExecutivo([], [], [], 0, null);
    expect(data.totais.valorTotalBrl).toBe(0);
    expect(data.galpoes).toEqual([]);
    expect(data.transito).toHaveLength(4);
    expect(data.familias).toEqual([]);
    expect(data.exposicaoCambial.usd).toBe(0); // ptax 0 não divide
  });
});
