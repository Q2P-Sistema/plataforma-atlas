import { describe, it, expect } from 'vitest';

// Feature 015 (ACXEGDP-328), T011a — checagem "item nacional ja recebido" em duas
// vias + baixa externa (data-model §3.1, research D21). Provada por inspecao do SQL
// gerado: e SQL de fragmento, injetado na query da fila; o que importa e a FORMA
// dos tres EXISTS e, sobretudo, os filtros que impedem falso positivo.

import { itemNacionalRecebidoSql, normalizarDescricaoSql } from '../services/fiscal-recebida-sql.js';

const ARGS = {
  chaveExpr: 'h.c_chave_nfe',
  descricaoNormalizadaExpr: normalizarDescricaoSql('i.x_prod'),
  nfNumeroExpr: 'h.n_nf',
};

function ramos(sql: string): string[] {
  // separa os tres EXISTS (cada um comeca em "EXISTS (SELECT 1 FROM")
  return sql.split(/(?=EXISTS \(SELECT 1 FROM)/).filter((r) => r.trim().startsWith('EXISTS'));
}

describe('itemNacionalRecebidoSql — as tres vias', () => {
  it('gera exatamente tres EXISTS unidos por OR', () => {
    const sql = itemNacionalRecebidoSql(ARGS);
    expect(ramos(sql)).toHaveLength(3);
    expect(sql.match(/\bOR\b/g)).toHaveLength(2);
  });

  it('via 1 — caminho novo: chave de acesso + descricao normalizada do item, em movimentacao', () => {
    const [v1] = ramos(itemNacionalRecebidoSql(ARGS));
    expect(v1).toContain('stockbridge.movimentacao m');
    expect(v1).toContain("m.subtipo = 'compra_nacional'");
    expect(v1).toContain('m.nf_chave_acesso = h.c_chave_nfe');
    expect(v1).toContain(`m.nf_item_descricao_normalizada = ${ARGS.descricaoNormalizadaExpr}`);
    expect(v1).toContain('m.ativo = true');
  });

  it('via 2 — formulario manual (sem chave): numero sem zeros a esquerda + empresa', () => {
    const [, v2] = ramos(itemNacionalRecebidoSql(ARGS));
    expect(v2).toContain('m.nf_chave_acesso IS NULL');
    expect(v2).toContain("m.empresa = 'q2p'");
    expect(v2).toContain("ltrim(m.nota_fiscal, '0') = ltrim(h.n_nf, '0')");
    // o historico manual nao guarda a linha de origem: NAO filtra por descricao
    expect(v2).not.toContain('nf_item_descricao');
  });

  it('via 2 — o filtro por subtipo NAO e opcional: sem ele casaria saida automatica da Q2P', () => {
    // saida_automatica grava nota_fiscal + empresa='q2p' e nunca tem chave — a unica
    // coisa que a separa de um recebimento e o subtipo.
    const [, v2] = ramos(itemNacionalRecebidoSql(ARGS));
    expect(v2).toContain("m.subtipo = 'compra_nacional'");
  });

  it('todo ramo em movimentacao filtra subtipo = compra_nacional (nenhum ramo generico)', () => {
    const sql = itemNacionalRecebidoSql(ARGS);
    const emMovimentacao = ramos(sql).filter((r) => r.includes('stockbridge.movimentacao m'));
    expect(emMovimentacao).toHaveLength(2);
    for (const r of emMovimentacao) expect(r).toContain("m.subtipo = 'compra_nacional'");
  });

  it('via 3 — baixa externa APROVADA para (chave, descricao), em aprovacao', () => {
    const [, , v3] = ramos(itemNacionalRecebidoSql(ARGS));
    expect(v3).toContain('stockbridge.aprovacao a');
    expect(v3).toContain("a.tipo_aprovacao = 'recebimento_externo'");
    expect(v3).toContain("a.status = 'aprovada'");
    expect(v3).toContain('a.nf_chave_acesso = h.c_chave_nfe');
    // a aprovacao guarda a descricao crua: normaliza dos dois lados para casar
    expect(v3).toContain(`${normalizarDescricaoSql('a.nf_item_descricao')} = ${ARGS.descricaoNormalizadaExpr}`);
  });

  it('via 3 — baixa pendente ou rejeitada NAO tira o item da fila', () => {
    const [, , v3] = ramos(itemNacionalRecebidoSql(ARGS));
    expect(v3).not.toContain("'pendente'");
    expect(v3).not.toContain("'rejeitada'");
  });

  it('nunca usa n_id_receb (universal em NF de entrada nacional — research D1)', () => {
    expect(itemNacionalRecebidoSql(ARGS)).not.toContain('n_id_receb');
  });
});

describe('normalizarDescricaoSql — mesma regra da normalizacao em TS', () => {
  it('trim, espacos colapsados, caixa alta, sem acento — exige unaccent', () => {
    expect(normalizarDescricaoSql('i.x_prod')).toBe(
      "upper(regexp_replace(btrim(unaccent(i.x_prod)), '\\s+', ' ', 'g'))",
    );
  });
});
