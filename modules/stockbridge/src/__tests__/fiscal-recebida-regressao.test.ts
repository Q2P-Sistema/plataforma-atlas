import { describe, it, expect } from 'vitest';

// Feature 015 (ACXEGDP-328), T012 — guarda de regressao de fiscal-recebida-sql.ts.
//
// `recebidaViaMovimentacaoSql` foi parametrizada (subtipo + coluna de produto) para
// servir o caminho nacional. Os 5 servicos consumidores do caminho de importacao
// (cockpit, cockpit-executivo, pendencias-fiscais, nf-pedido-mapa, recebimento)
// chamam SEM o terceiro argumento e precisam receber SQL BYTE A BYTE identico ao
// anterior — sao os 6 pontos que a feature 014 corrigiu e que nao podem mudar de
// resultado. A prova e por inspecao do SQL gerado contra uma copia congelada da
// implementacao pre-parametrizacao.

import { recebidaViaMovimentacaoSql, produtoPendenteSql, recebidaViaLegadoSql } from '../services/fiscal-recebida-sql.js';

/** Copia CONGELADA da implementacao anterior (feature 014). Nao alterar. */
function recebidaViaMovimentacaoSqlAntes(nfExpr: string, produtoExpr?: string): string {
  const produtoFiltro = produtoExpr ? `
                AND m.produto_codigo_acxe = ${produtoExpr}` : '';
  return `EXISTS (SELECT 1 FROM stockbridge.movimentacao m
              WHERE m.ativo = true AND m.subtipo = 'importacao' AND m.nota_fiscal = ${nfExpr}${produtoFiltro})`;
}

/** Copia CONGELADA de produtoPendenteSql anterior, composta sobre a copia acima. */
function produtoPendenteSqlAntes(args: { nfExpr: string; produtoExpr: string; nIdRecebExpr: string }): string {
  return `NOT (
    COALESCE(${args.nIdRecebExpr}, 0) > 0
    OR ${recebidaViaLegadoSql(args.nfExpr)}
    OR ${recebidaViaMovimentacaoSqlAntes(args.nfExpr, args.produtoExpr)}
  )`;
}

// Formas de argumento realmente usadas pelos consumidores de importacao.
const FORMAS: Array<{ nome: string; nfExpr: string; produtoExpr?: string }> = [
  { nome: 'cockpit Parte A/B — por NF inteira', nfExpr: "LPAD(f.nf_filhote, 8, '0')" },
  { nome: 'cockpit — por produto (feature 014)', nfExpr: "LPAD(f.nf_filhote, 8, '0')", produtoExpr: 'i.n_cod_prod' },
  { nome: 'cockpit-executivo — por produto', nfExpr: 'h.n_nf', produtoExpr: 'i.n_cod_prod' },
  { nome: 'pendencias-fiscais — por NF', nfExpr: 'h.n_nf' },
  { nome: 'pendencias-fiscais — por produto', nfExpr: 'h.n_nf', produtoExpr: 'i.n_cod_prod' },
  { nome: 'nf-pedido-mapa — auto-desativacao', nfExpr: "LPAD(f.nf_filhote, 8, '0')", produtoExpr: 'i.n_cod_prod' },
];

describe('fiscal-recebida-sql — regressao byte a byte (T012)', () => {
  it.each(FORMAS)('recebidaViaMovimentacaoSql identico ao anterior: $nome', ({ nfExpr, produtoExpr }) => {
    expect(recebidaViaMovimentacaoSql(nfExpr, produtoExpr)).toBe(recebidaViaMovimentacaoSqlAntes(nfExpr, produtoExpr));
  });

  it('produtoPendenteSql (getFilaPendente / recebimento.service) identico ao anterior', () => {
    const args = { nfExpr: "LPAD(f.nf_filhote, 8, '0')", produtoExpr: 'i.n_cod_prod', nIdRecebExpr: 'h.n_id_receb' };
    expect(produtoPendenteSql(args)).toBe(produtoPendenteSqlAntes(args));
  });

  it('defaults sao importacao + produto_codigo_acxe (o que os consumidores assumem)', () => {
    const sql = recebidaViaMovimentacaoSql('h.n_nf', 'i.n_cod_prod');
    expect(sql).toContain("m.subtipo = 'importacao'");
    expect(sql).toContain('m.produto_codigo_acxe = i.n_cod_prod');
    expect(sql).not.toContain('compra_nacional');
    expect(sql).not.toContain('produto_codigo_q2p');
  });

  it('opts explicitos vazios ({}) tambem reproduzem o SQL anterior', () => {
    expect(recebidaViaMovimentacaoSql('h.n_nf', 'i.n_cod_prod', {})).toBe(
      recebidaViaMovimentacaoSqlAntes('h.n_nf', 'i.n_cod_prod'),
    );
  });

  it('a parametrizacao so muda o SQL quando pedida explicitamente', () => {
    const nacional = recebidaViaMovimentacaoSql('h.n_nf', 'x.codigo', {
      subtipo: 'compra_nacional',
      colunaProduto: 'produto_codigo_q2p',
    });
    expect(nacional).toContain("m.subtipo = 'compra_nacional'");
    expect(nacional).toContain('m.produto_codigo_q2p = x.codigo');
    expect(nacional).not.toBe(recebidaViaMovimentacaoSqlAntes('h.n_nf', 'x.codigo'));
  });
});
