import { describe, it, expect } from 'vitest';

// Feature 015 (ACXEGDP-328) — unidade dos itens de NF nacional (research D5, D15, D24).
// Tabela EXPLICITA (KG/TON/TL) + conferencia de coerencia entre unidade declarada e
// quantidade. Nunca NaN, nunca fator default, nunca conversao por aproximacao.

import {
  converterItemNfParaKg,
  isUnidadeNfConhecida,
  normalizarGrafiaUnidadeNf,
  FATOR_UNIDADE_NF,
  RS_POR_KG_PLAUSIVEL,
} from '../services/unidade-nf.js';

describe('unidade-nf — tabela explicita (T008)', () => {
  it('converte KG com fator 1', () => {
    // NF 66724 (ISOFORMA): 13.160 KG, R$ 156.604,00 -> R$ 11,90/kg
    const r = converterItemNfParaKg(13160, 'KG', 156604.0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unidade).toBe('KG');
    expect(r.fator).toBe(1);
    expect(r.quantidadeKg).toBe(13160);
    expect(r.rsPorKg).toBeCloseTo(11.9, 2);
  });

  it('converte TL como tonelada (fator 1000) — Zaraplast', () => {
    // NF 58449: 24,750 TL a R$ 9.152,55/TL -> 24.750 kg a R$ 9,15/kg
    const r = converterItemNfParaKg(24.75, 'TL', 226525.6);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unidade).toBe('TL');
    expect(r.quantidadeKg).toBeCloseTo(24750, 3);
    expect(r.rsPorKg).toBeCloseTo(9.15, 1);
  });

  it('converte TON com fator 1000', () => {
    const r = converterItemNfParaKg(13.75, 'TON', 245000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quantidadeKg).toBeCloseTo(13750, 3);
  });

  it('tabela tem exatamente KG, TON e TL — e e congelada', () => {
    expect(Object.keys(FATOR_UNIDADE_NF).sort()).toEqual(['KG', 'TL', 'TON']);
    expect(Object.isFrozen(FATOR_UNIDADE_NF)).toBe(true);
  });

  it('normaliza caixa e espacos na grafia (" kg ", "Tl")', () => {
    expect(normalizarGrafiaUnidadeNf(' kg ')).toBe('KG');
    expect(normalizarGrafiaUnidadeNf('Tl')).toBe('TL');
    expect(isUnidadeNfConhecida(' ton')).toBe(true);
    const r = converterItemNfParaKg(1000, ' kg ', 12000);
    expect(r.ok).toBe(true);
  });
});

describe('unidade-nf — bloqueio por unidade desconhecida (FR-009)', () => {
  it.each(['UN', 'PC', 'LT', 'SACO', 'BB', '', null, undefined])(
    'bloqueia a grafia %j sem converter',
    (u) => {
      const r = converterItemNfParaKg(9040, u as string, 4520);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.motivo).toBe('unidade_nao_conversivel');
      expect(r.mensagem).toContain('não é conversível');
      // nunca expoe uma quantidade convertida num bloqueio
      expect((r as unknown as { quantidadeKg?: number }).quantidadeKg).toBeUndefined();
    },
  );

  it('nao trata unidade desconhecida como kg (o erro de normalizarUnidade da importacao)', () => {
    expect(isUnidadeNfConhecida('UN')).toBe(false);
    const r = converterItemNfParaKg(100, 'UN', 50);
    expect(r.ok).toBe(false);
  });
});

describe('unidade-nf — conferencia de coerencia (FR-029, D24)', () => {
  it('NF 58067 Zaraplast: 1,375 KG a R$ 19.731,26 (v_prod) e tonelada rotulada KG -> bloqueia por contradicao', () => {
    const r = converterItemNfParaKg(1.375, 'KG', 19731.26);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('unidade_incoerente');
    if (r.motivo !== 'unidade_incoerente') return;
    // lido como KG: ~R$ 14.350/kg (implausivel); lido como tonelada: ~R$ 14,35/kg (plausivel)
    expect(r.rsPorKgDeclarado).toBeCloseTo(14350.0, 0);
    expect(r.rsPorKgAlternativo).toBeCloseTo(14.35, 1);
    expect(r.leituraDeclarada).toBe('kg');
    expect(r.leituraAlternativa).toBe('tonelada');
    expect(r.mensagem).toContain('não escolhe');
    // e NAO "corrige" para 1.375 kg: bloqueio nao expoe quantidade
    expect((r as unknown as { quantidadeKg?: number }).quantidadeKg).toBeUndefined();
  });

  it('nao regride material barato: papelao a R$ 0,35/kg em KG segue liberado', () => {
    // "PAPEL E PAPELAO - C": 6.000 KG, R$ 2.100,00
    const r = converterItemNfParaKg(6000, 'KG', 2100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rsPorKg).toBeCloseTo(0.35, 2);
  });

  it('nao regride material barato: sucata rigida a R$ 300/t em TON segue liberada', () => {
    // "SUCATA PLASTICO RIGIDO": 13 TON, R$ 3.900,00 -> R$ 0,30/kg
    const r = converterItemNfParaKg(13, 'TON', 3900);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quantidadeKg).toBe(13000);
    expect(r.rsPorKg).toBeCloseTo(0.3, 2);
  });

  it('TON com quantidade em kg (leitura alternativa plausivel) tambem bloqueia por contradicao', () => {
    // 13.000 "TON" a R$ 3.900 -> R$ 0,0003/kg declarado; como kg daria R$ 0,30/kg
    const r = converterItemNfParaKg(13000, 'TON', 3900);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('unidade_incoerente');
    if (r.motivo !== 'unidade_incoerente') return;
    expect(r.leituraDeclarada).toBe('tonelada');
    expect(r.leituraAlternativa).toBe('kg');
  });

  it('valor total zero: nenhuma leitura plausivel -> inconclusivo, bloqueia', () => {
    const r = converterItemNfParaKg(1000, 'KG', 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('unidade_inconclusiva');
  });

  it('quantidade nao positiva bloqueia como quantidade_invalida', () => {
    for (const q of [0, -5, NaN]) {
      const r = converterItemNfParaKg(q, 'KG', 100);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.motivo).toBe('quantidade_invalida');
    }
  });

  it('faixa plausivel e R$ 0,10 a R$ 100 por quilo e o criterio NAO e preco absoluto', () => {
    expect(RS_POR_KG_PLAUSIVEL).toEqual({ min: 0.1, max: 100 });
    // mesmo valor total, mesma quantidade numerica: a unidade e que decide o veredito
    expect(converterItemNfParaKg(13, 'TON', 3900).ok).toBe(true); // R$ 0,30/kg
    expect(converterItemNfParaKg(13, 'KG', 3900).ok).toBe(false); // R$ 300/kg declarado, R$ 0,30 alternativo
  });
});

describe('unidade-nf — nunca NaN, nunca throw', () => {
  it('qualquer entrada devolve um resultado tipado com numeros finitos', () => {
    const entradas: Array<[number, string | null, number]> = [
      [1, 'KG', 1],
      [1e9, 'TL', 1],
      [0.001, 'TON', 1e9],
      [5, 'XYZ', 5],
      [Infinity, 'KG', 10],
      [10, 'KG', Infinity],
      [10, 'KG', NaN],
    ];
    for (const [q, u, v] of entradas) {
      const r = converterItemNfParaKg(q, u, v);
      expect(typeof r.ok).toBe('boolean');
      if (r.ok) {
        expect(Number.isFinite(r.quantidadeKg)).toBe(true);
        expect(Number.isNaN(r.rsPorKg)).toBe(false);
      } else {
        expect(r.mensagem.length).toBeGreaterThan(0);
      }
    }
  });
});
