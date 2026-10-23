import { describe, it, expect } from 'vitest';

// Feature 017, Historia 5 (ACXEGDP-437) — `itemNacionalRecebidoSql` com a EMPRESA da linha.
//
// A via 2 da checagem "item ja recebido" (historico do formulario manual, que so guarda o NUMERO da NF) casava a
// Q2P fixa. O numero de NF colide entre os espelhos (NF 5832: FDMA na ACXE, ACXE na Q2P), entao com a ACXE na fila
// a via 2 passa a casar a empresa da linha (`empresaExpr`, ex.: `u.empresa`). Omitida = a Q2P, o texto de antes,
// byte a byte (fiscal-recebida-nacional.test.ts e o golden da Q2P cobrem o resto).

import { itemNacionalRecebidoSql, normalizarDescricaoSql } from '../services/fiscal-recebida-sql.js';

const ARGS = {
  chaveExpr: 'u.c_chave_nfe',
  descricaoNormalizadaExpr: normalizarDescricaoSql('u.x_prod'),
  nfNumeroExpr: 'u.n_nf',
  dataEmissaoExpr: 'u.d_emi',
  sequenciaExpr: 'u.n_seq',
};

function ramos(sql: string): string[] {
  return sql.split(/(?=EXISTS \(SELECT 1 FROM)/).filter((r) => r.trim().startsWith('EXISTS'));
}

describe('itemNacionalRecebidoSql — empresa da linha na via 2', () => {
  it('com empresaExpr, a via 2 casa a empresa da LINHA em vez de "q2p"', () => {
    const [, v2] = ramos(itemNacionalRecebidoSql({ ...ARGS, empresaExpr: 'u.empresa' }));
    expect(v2).toContain('m.empresa = u.empresa');
    expect(v2).not.toContain("'q2p'");
    // o resto da via 2 nao muda: sem chave, numero sem zeros a esquerda, a partir da emissao, so compra nacional
    expect(v2).toContain('m.nf_chave_acesso IS NULL');
    expect(v2).toContain("ltrim(m.nota_fiscal, '0') = ltrim(u.n_nf, '0')");
    expect(v2).toContain('m.created_at >= (u.d_emi)::date');
    expect(v2).toContain("m.subtipo = 'compra_nacional'");
  });

  it('a expressao de empresa e inserida como veio (pode ser um literal)', () => {
    const [, v2] = ramos(itemNacionalRecebidoSql({ ...ARGS, empresaExpr: "'acxe'" }));
    expect(v2).toContain("m.empresa = 'acxe'");
    expect(v2).not.toContain("m.empresa = 'q2p'");
  });

  it('omitida, a empresa e a Q2P (o texto de antes da Historia 5)', () => {
    const [, v2] = ramos(itemNacionalRecebidoSql(ARGS));
    expect(v2).toContain("m.empresa = 'q2p'");
  });

  it('omitida equivale a passar o literal da Q2P: o mesmo texto', () => {
    expect(itemNacionalRecebidoSql(ARGS)).toBe(itemNacionalRecebidoSql({ ...ARGS, empresaExpr: "'q2p'" }));
  });

  it('o UNICO trecho que muda entre as duas formas e a empresa da via 2', () => {
    const q2p = itemNacionalRecebidoSql(ARGS);
    const porLinha = itemNacionalRecebidoSql({ ...ARGS, empresaExpr: 'u.empresa' });
    expect(porLinha).not.toBe(q2p);
    expect(porLinha.replace('m.empresa = u.empresa', "m.empresa = 'q2p'")).toBe(q2p);
  });

  it('as vias 1 e 3 nao dependem da empresa: a chave de acesso e unica entre os espelhos', () => {
    const [v1, , v3] = ramos(itemNacionalRecebidoSql({ ...ARGS, empresaExpr: 'u.empresa' }));
    expect(v1).not.toContain('empresa');
    expect(v3).not.toContain('empresa');
    expect(v1).toContain('m.nf_chave_acesso = u.c_chave_nfe');
    expect(v3).toContain('a.nf_chave_acesso = u.c_chave_nfe');
  });

  it('continua sendo tres EXISTS unidos por OR, e todo ramo em movimentacao filtra compra_nacional ativa', () => {
    const sql = itemNacionalRecebidoSql({ ...ARGS, empresaExpr: 'u.empresa' });
    expect(ramos(sql)).toHaveLength(3);
    expect(sql.match(/\bOR\b/g)!.length).toBeGreaterThanOrEqual(2);
    const emMovimentacao = ramos(sql).filter((r) => r.includes('stockbridge.movimentacao m'));
    expect(emMovimentacao).toHaveLength(2);
    for (const r of emMovimentacao) {
      expect(r).toContain("m.subtipo = 'compra_nacional'");
      expect(r).toContain('m.ativo = true');
    }
  });

  it('a empresa nao entra na expressao da sequencia nem na da descricao', () => {
    const sql = itemNacionalRecebidoSql({ ...ARGS, empresaExpr: 'u.empresa' });
    expect(sql).toContain('u.n_seq = ANY(m.nf_item_sequencias)');
    expect(sql).toContain(normalizarDescricaoSql('u.x_prod'));
    expect(sql.split('u.empresa')).toHaveLength(2); // aparece uma unica vez: na via 2
  });
});
