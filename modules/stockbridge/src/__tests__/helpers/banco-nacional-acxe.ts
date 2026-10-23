import type { EmpresaNacional } from '../../services/empresa-nacional.js';

/**
 * Banco simulado da fila/detalhe de NF nacional com as DUAS empresas (feature 017, Historia 5 — ACXEGDP-437).
 *
 * Usado pelos testes que mockam `getPool().query`: `responder(banco, sql, params)` reconhece cada consulta do
 * servico pelo trecho de SQL que a identifica e devolve as linhas do cenario. Nao e um mock de comportamento
 * de Postgres — o SQL de verdade e executado em fila-nacional-acxe-db.test.ts (ATLAS_DB_INTEGRATION=1).
 */

export type Linha = Record<string, unknown>;

export interface Falha {
  /** a consulta (SQL) que deve falhar */
  quando: (sql: string) => boolean;
  erro: () => unknown;
  /** quantas vezes falha antes de voltar a responder normalmente */
  restantes: number;
}

export interface Banco {
  /** linhas da fila (resultado final da CTE) */
  fila: Linha[];
  /** linhas do detalhe de uma NF (fonte unificada) */
  detalhe: Linha[];
  /** linhas da consulta do selo do PC na fila, por empresa */
  pcFila: Record<EmpresaNacional, Linha[]>;
  /** itens de PC da copia `tbl_pedidosCompras_<empresa>` (carregarContextoPc), por empresa */
  copiaPcs: Record<EmpresaNacional, Linha[]>;
  /** idade, em minutos, do espelho de recebimentos e da copia de PCs, por empresa (null = vazio) */
  idadeEspelho: Record<EmpresaNacional, number | null>;
  idadeCopia: Record<EmpresaNacional, number | null>;
  /** tbl_produtos_ACXE com o gemeo Q2P (resolverGemeosQ2p): codigo_acxe, descricao_acxe, ativo_acxe, unidade_acxe, codigo_q2p, descricao_q2p */
  produtos: Linha[];
  /** correlacao de locais (resolverLocaisAcxePorCodigoOmie): codigo_omie, id, codigo, nome */
  locais: Linha[];
  /** numero legivel dos PCs vinculados (numerosDosPcs) */
  numerosPcs: Linha[];
  /** dispensa ativa da NF */
  dispensa: Linha[];
  falhas: Falha[];
}

export function novoBanco(): Banco {
  return {
    fila: [],
    detalhe: [],
    pcFila: { q2p: [], acxe: [] },
    copiaPcs: { q2p: [], acxe: [] },
    idadeEspelho: { q2p: 5, acxe: 5 },
    idadeCopia: { q2p: 5, acxe: 5 },
    produtos: [],
    locais: [],
    numerosPcs: [],
    dispensa: [],
    falhas: [],
  };
}

/** Empresa cujo espelho a consulta le (as consultas de saude e de PC citam UMA empresa so). */
const empresaDoSql = (sql: string): EmpresaNacional => (sql.includes('_ACXE"') ? 'acxe' : 'q2p');

/** Erro do Postgres por objeto de schema ausente (42P01 tabela, 42703 coluna). */
export const erroSchema = (codigo: '42P01' | '42703' = '42P01', detalhe = 'relation "public.tbl_nf_header_ACXE" does not exist'): Error =>
  Object.assign(new Error(detalhe), { code: codigo });

/** Faz toda consulta que cita o espelho da ACXE falhar por tabela ausente (o n8n ainda nao a criou). */
export const falhaTabelaAcxe = (restantes = 99): Falha => ({
  quando: (sql) => sql.includes('_ACXE"'),
  erro: () => erroSchema(),
  restantes,
});

export function responder(banco: Banco, sql: string, params: unknown[] = []): Promise<{ rows: Linha[] }> {
  const falha = banco.falhas.find((f) => f.restantes > 0 && f.quando(sql));
  if (falha) {
    falha.restantes--;
    return Promise.reject(falha.erro());
  }
  const rows = (r: Linha[]) => Promise.resolve({ rows: r });
  const emp = empresaDoSql(sql);
  if (sql.includes('information_schema')) return rows([{ ok: true }]);
  if (sql.includes('MAX(synced_at)')) return rows([{ idade_min: banco.idadeEspelho[emp] }]);
  if (sql.includes('MAX(data_atualizacao)')) return rows([{ idade_min: banco.idadeCopia[emp] }]);
  if (sql.includes('HAVING COUNT(*) FILTER (WHERE pendente) > 0')) return rows(banco.fila);
  if (sql.includes('u.c_chave_nfe = ANY($3::text[])')) return rows(banco.pcFila[emp]);
  if (sql.includes('FROM stockbridge.nf_dispensa') && sql.trimStart().startsWith('SELECT dispensado_em')) return rows(banco.dispensa);
  if (sql.includes('WITH nf_unificada')) return rows(banco.detalhe);
  // numerosDosPcs (tem UNION ALL com a copia, o ledger e o cache) vem antes das consultas da copia/ledger
  if (sql.includes('pedido_compra_visto') && sql.includes('ORDER BY 3')) return rows(banco.numerosPcs);
  if (sql.includes('FROM public."tbl_produtos_ACXE" a')) {
    const pedidos = ((params[0] as number[] | undefined) ?? []).map(Number);
    return rows(banco.produtos.filter((p) => pedidos.includes(Number(p.codigo_acxe))));
  }
  if (sql.includes('FROM stockbridge.localidade_correlacao lc')) {
    const pedidos = ((params[0] as number[] | undefined) ?? []).map(Number);
    return rows(banco.locais.filter((l) => pedidos.includes(Number(l.codigo_omie))));
  }
  if (sql.includes('FROM public.') && sql.includes('tbl_pedidosCompras_') && sql.includes(' pc')) return rows(banco.copiaPcs[emp]);
  if (sql.includes('AS codigo') && sql.includes('tbl_cadastroFornecedoresClientes_')) return rows([]);
  return rows([]);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Chave de acesso de 44 digitos a partir de um prefixo (a chave e unica entre os espelhos). */
export const chaveDe = (prefixo: string): string => prefixo.padEnd(44, '0').slice(0, 44);

/** NF 6842 da Replas na Q2P (a de sempre) e NF 937 da Solutec na ACXE (a do PC 580). */
export const CHAVE_Q2P = '35261014555032000753550010000068421827355174';
export const CHAVE_ACXE = chaveDe('35261012345678000190550010000009371');

export const CORTE_Q2P = '2026-09-11';
export const CORTE_ACXE = '2026-10-01';
export const CFOPS = ['1.101', '1.102', '2.101', '2.102'];

/** Codigos do OMIE usados nos cenarios (ids de 10 digitos: so identificam, nunca aparecem em texto de tela). */
export const OMIE = {
  fornecedorSolutec: 4700001001,
  produtoPpPreto: 4501234567, // PP PRETO Q35 (ACXE) — tem gemeo na Q2P
  produtoPoliestireno: 4501234999, // PS POLIESTIRENO BRANCO (ACXE) — sem gemeo na Q2P
  produtoGemeoPpPreto: 3100320435, // o mesmo produto no cadastro da Q2P
  local2007: 4553940398, // 20.0.7 PRODUCAO (so ACXE)
  local111: 4498926337, // 11.1 (tambem da Q2P)
  pedido580: 8516990580,
  itemPedido580: 8516990581,
};

/** Linha do detalhe (CTE unificada) no formato que o Postgres devolve; sem `empresa`/`produto_omie` = consulta so da Q2P. */
export const linhaDetalhe = (over: Linha = {}): Linha => ({
  nf_chave_acesso: CHAVE_Q2P,
  n_nf: '000006842',
  nota_fiscal: '6842',
  fornecedor_nome: 'REPLAS COMERCIAL LTDA',
  fornecedor_cnpj: '14.555.032/0007-53',
  dt_emissao: '2026-10-01',
  dias_desde_emissao: 1,
  cancelada: false,
  deletada: false,
  fornecedor_excluido: false,
  fiscal_pendente: true,
  n_id_receb: '8510564869', // bigint volta string no pg
  n_cod_item: '1',
  x_prod: 'SUCATA PLASTICO',
  desc_norm: 'SUCATA PLASTICO',
  cfop: '1.102',
  q_com: 18000,
  u_com: 'KG',
  valor_item: 203400,
  recebido: false,
  baixado_externo: false,
  baixa_solicitada: false,
  nf_ja_atribuida_kg: 0,
  conferida_ja_gravada_kg: 0,
  n_seq: 1,
  preco_comercial: 11.3,
  fornecedor_codigo: '1111',
  n_id_pedido: null,
  n_id_it_pedido: null,
  n_num_ped_compra: null,
  c_ignorar_item: 'N',
  c_nao_gerar_mov_estoque: 'N',
  receb_recebido: 'N',
  ledger_concluido: false,
  ...over,
});

/** Linha do detalhe de uma NF da ACXE: 26 t de PP PRETO Q35 da Solutec a R$ 4,80/kg (o PC 580). */
export const linhaDetalheAcxe = (over: Linha = {}): Linha =>
  linhaDetalhe({
    nf_chave_acesso: CHAVE_ACXE,
    n_nf: '000000937',
    nota_fiscal: '937',
    fornecedor_nome: 'SOLUTEC PLASTICOS LTDA',
    fornecedor_cnpj: '11.222.333/0001-81',
    n_id_receb: '8517000937',
    x_prod: 'PP PRETO Q35',
    desc_norm: 'PP PRETO Q35',
    cfop: '1.101',
    q_com: 26000,
    valor_item: 124800,
    preco_comercial: 4.8,
    fornecedor_codigo: String(OMIE.fornecedorSolutec),
    empresa: 'acxe',
    produto_omie: String(OMIE.produtoPpPreto),
    ...over,
  });

/** Item de PC da copia `tbl_pedidosCompras_ACXE` como o Postgres o devolve (PC 580, Solutec, local 20.0.7). */
export const itemPc580 = (over: Linha = {}): Linha => ({
  ncodped: String(OMIE.pedido580),
  ncoditem: String(OMIE.itemPedido580),
  cnumero: '580',
  cetapa: '15',
  ncodfor: String(OMIE.fornecedorSolutec),
  nqtde: 26000,
  nqtderec: 0,
  nvalunit: 4.8,
  cunidade: 'KG',
  ddtprevisao: '2026-10-30',
  cdescricao: 'PP PRETO Q35',
  cproduto: 'PPQ35',
  atualizado_ms: Date.now() - 5 * 60_000,
  valor_total_pc: 124800,
  fornecedor_acxe: false,
  cnpj_cadastro: '11222333000181',
  ncodprod: String(OMIE.produtoPpPreto),
  codigo_local_estoque: String(OMIE.local2007),
  ...over,
});

/** Item de PC do cache (stockbridge.pedido_compra_visto) como `lerPcsVistos` o devolve: PC 580 da Solutec, local 20.0.7. */
export const pcVisto = (over: Linha = {}): Linha => ({
  nCodPed: OMIE.pedido580,
  nCodItem: OMIE.itemPedido580,
  pcNumero: '580',
  etapa: '15',
  nCodFor: OMIE.fornecedorSolutec,
  produtoDescricao: 'PP PRETO Q35',
  qtdPedidaKg: 26000,
  saldoCopiaKg: 26000,
  precoKg: 4.8,
  unidade: 'KG',
  dtPrevisao: '2026-10-30',
  atualizadoEmMs: Date.now() - 60 * 60_000,
  pcEspelho: false,
  cnpjCadastro: '11222333000181',
  raizCnpj: '11222333',
  vistoEmMs: Date.now() - 60 * 60_000,
  nCodProd: OMIE.produtoPpPreto,
  codigoLocalEstoque: OMIE.local2007,
  ...over,
});

/** Linha da fila (resultado final da consulta). */
export const linhaFila = (over: Linha = {}): Linha => ({
  nf_chave_acesso: CHAVE_Q2P,
  nota_fiscal: '6842',
  fornecedor_nome: 'REPLAS COMERCIAL LTDA',
  fornecedor_cnpj: '14.555.032/0007-53',
  dt_emissao: '2026-10-01',
  dias_desde_emissao: 1,
  itens_total: 1,
  itens_pendentes: 1,
  valor_total_brl: 203400,
  fiscal: 'concluido',
  fiscal_concluido_em: null,
  estoque_lancado: false,
  ...over,
});

export const linhaFilaAcxe = (over: Linha = {}): Linha =>
  linhaFila({
    nf_chave_acesso: CHAVE_ACXE,
    nota_fiscal: '937',
    fornecedor_nome: 'SOLUTEC PLASTICOS LTDA',
    fornecedor_cnpj: '11.222.333/0001-81',
    valor_total_brl: 124800,
    empresa: 'acxe',
    ...over,
  });

/** Linha da consulta do selo do PC (uma por linha de item da NF). */
export const linhaPcFila = (over: Linha = {}): Linha => ({
  c_chave_nfe: CHAVE_ACXE,
  x_prod: 'PP PRETO Q35',
  desc_norm: 'PP PRETO Q35',
  q_com: 26000,
  u_com: 'KG',
  valor_item: 124800,
  preco_comercial: 4.8,
  n_seq: 1,
  n_id_pedido: null,
  n_id_it_pedido: null,
  n_num_ped_compra: null,
  fornecedor_codigo: String(OMIE.fornecedorSolutec),
  recebido: false,
  ...over,
});

/** Linha de tbl_produtos_ACXE com o gemeo Q2P, como `resolverGemeosQ2p` a recebe do Postgres. */
export const produtoAcxe = (over: Linha = {}): Linha => ({
  codigo_acxe: String(OMIE.produtoPpPreto),
  descricao_acxe: 'PP PRETO Q35',
  ativo_acxe: true,
  unidade_acxe: 'KG',
  codigo_q2p: String(OMIE.produtoGemeoPpPreto),
  descricao_q2p: 'PP PRETO Q35',
  ...over,
});

/** Localidade do Atlas que corresponde a um local do OMIE da ACXE. */
export const localAtlas = (over: Linha = {}): Linha => ({
  codigo_omie: String(OMIE.local2007),
  id: '5b1a1c2e-7d1f-4d0e-9a53-0a7c6e0b2007',
  codigo: '20.0.7',
  nome: 'PRODUÇÃO',
  ...over,
});
