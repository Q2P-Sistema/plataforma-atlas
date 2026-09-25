import { describe, it, expect } from 'vitest';

// Feature 015 — normalizacao da descricao do item da NF. E a chave que amarra a
// movimentacao a linha da NF (D20); roda em TS (gravacao/correlacao) e em SQL (fila).
// As duas PRECISAM concordar. O lado SQL nao roda aqui (sem banco), entao este
// teste (a) fixa o comportamento TS em amostras reais do espelho e (b) prova por
// inspecao que o fragmento SQL aplica as mesmas quatro operacoes.

import { normalizarDescricaoNf } from '../services/descricao-nf.js';
import { normalizarDescricaoSql } from '../services/fiscal-recebida-sql.js';

describe('normalizarDescricaoNf — regra de data-model §1.1', () => {
  it('trim + colapso de espacos internos (x_prod real com espaco duplo)', () => {
    // "SUCATA  PSAI MOIDO MESCLADO GROSSO" vem do espelho com DOIS espacos
    expect(normalizarDescricaoNf('SUCATA  PSAI MOIDO MESCLADO GROSSO')).toBe('SUCATA PSAI MOIDO MESCLADO GROSSO');
    expect(normalizarDescricaoNf('  PELMD 1018RA \t')).toBe('PELMD 1018RA');
  });

  it('caixa alta', () => {
    expect(normalizarDescricaoNf('Sucata de Plastico')).toBe('SUCATA DE PLASTICO');
  });

  it('remove acentuacao (inclusive cedilha)', () => {
    expect(normalizarDescricaoNf('PAPELÃO (DESCARTE)')).toBe('PAPELAO (DESCARTE)');
    expect(normalizarDescricaoNf('Açúcar cristal')).toBe('ACUCAR CRISTAL');
  });

  it('variacoes puramente formatais colapsam no mesmo par (research D8)', () => {
    const base = normalizarDescricaoNf('MC PEAD BF4810+ NA');
    for (const v of ['mc pead bf4810+ na', ' MC  PEAD BF4810+ NA ', 'MC\tPEAD BF4810+ NA']) {
      expect(normalizarDescricaoNf(v)).toBe(base);
    }
  });

  it('variacoes de CONTEUDO continuam distintas (sem fuzzy)', () => {
    expect(normalizarDescricaoNf('SUCATA PSAI MOIDO MESCLADO GROSSO')).not.toBe(
      normalizarDescricaoNf('SUCATA PSAI MOIDO MESCLADO FINO'),
    );
  });

  it('nulo/undefined/vazio -> string vazia, nunca lanca', () => {
    expect(normalizarDescricaoNf(null)).toBe('');
    expect(normalizarDescricaoNf(undefined)).toBe('');
    expect(normalizarDescricaoNf('   ')).toBe('');
  });

  it('e idempotente', () => {
    const uma = normalizarDescricaoNf('  Papelão  (descarte) ');
    expect(normalizarDescricaoNf(uma)).toBe(uma);
  });
});

describe('paridade com normalizarDescricaoSql', () => {
  it('o SQL aplica as mesmas 4 operacoes: unaccent, btrim, colapso de \\s+, upper', () => {
    const sql = normalizarDescricaoSql('i.x_prod');
    expect(sql).toContain('unaccent(i.x_prod)');
    expect(sql).toContain('btrim(');
    expect(sql).toContain("regexp_replace(");
    expect(sql).toContain("'\\s+', ' ', 'g'");
    expect(sql.startsWith('upper(')).toBe(true);
  });
});
