import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, getPool, createLogger } from '@atlas/core';
import { correlacaoProdutoFornecedor } from '@atlas/db';
import { normalizarDescricaoNf } from './descricao-nf.js';

const logger = createLogger('stockbridge:correlacao-produto');

/**
 * Memoria do De->Para (fornecedor, descricao do item da NF) -> produtos Q2P
 * (feature 015, ACXEGDP-328, Historias 3 e 4).
 *
 * E 1:N por descricao (research D18): sucata entra como uma linha fiscal e e
 * classificada por grau em varios produtos — a NF 66461 da ISOFORMA virou
 * PS CRISTAL A + PS AI B + PS CRISTAL B. Por isso a chave unica inclui o
 * produto (correlacao_produto_fornecedor_ativa_idx) e a "sugestao" e um
 * CONJUNTO, ordenado por uso.
 *
 * Correcao e UPDATE ou soft delete (ativo=false) — nunca DELETE (Principio IV;
 * a trigger de auditoria registra tudo). Sem fuzzy: a normalizacao (D8) funde
 * so variacoes de formatacao; variacao de conteudo e outra descricao.
 */

export interface ProdutoSugerido {
  codigo: number;
  descricao: string;
  vezesUsada: number;
}

/** Sugestoes para VARIAS descricoes de uma vez (o detalhe da NF tem N itens). */
export async function sugerirProdutosEmLote(
  fornecedorCnpj: string,
  descricoes: string[],
): Promise<Map<string, ProdutoSugerido[]>> {
  const out = new Map<string, ProdutoSugerido[]>();
  const normalizadas = Array.from(new Set(descricoes.map(normalizarDescricaoNf).filter((d) => d.length > 0)));
  if (!fornecedorCnpj || normalizadas.length === 0) return out;

  const db = getDb();
  const rows = await db
    .select({
      descricaoNormalizada: correlacaoProdutoFornecedor.descricaoNormalizada,
      codigo: correlacaoProdutoFornecedor.produtoCodigoQ2p,
      descricao: correlacaoProdutoFornecedor.produtoDescricao,
      vezesUsada: correlacaoProdutoFornecedor.vezesUsada,
    })
    .from(correlacaoProdutoFornecedor)
    .where(
      and(
        eq(correlacaoProdutoFornecedor.fornecedorCnpj, fornecedorCnpj),
        eq(correlacaoProdutoFornecedor.ativo, true),
        inArray(correlacaoProdutoFornecedor.descricaoNormalizada, normalizadas),
      ),
    )
    .orderBy(desc(correlacaoProdutoFornecedor.vezesUsada), desc(correlacaoProdutoFornecedor.updatedAt));

  for (const r of rows) {
    const lista = out.get(r.descricaoNormalizada) ?? [];
    lista.push({ codigo: Number(r.codigo), descricao: r.descricao, vezesUsada: Number(r.vezesUsada) });
    out.set(r.descricaoNormalizada, lista);
  }
  return out;
}

export async function sugerirProdutos(fornecedorCnpj: string, descricaoNf: string): Promise<ProdutoSugerido[]> {
  const m = await sugerirProdutosEmLote(fornecedorCnpj, [descricaoNf]);
  return m.get(normalizarDescricaoNf(descricaoNf)) ?? [];
}

/**
 * Registra que (fornecedor, descricao) -> produto foi USADO num recebimento:
 * cria a linha se nao existe, senao incrementa vezes_usada. Chamado ao concluir
 * cada produto gravado (FR-007) — a escolha do operador passa a valer nas
 * proximas NFs sem nenhuma acao extra dele.
 */
export async function registrarUsoCorrelacao(args: {
  fornecedorCnpj: string;
  fornecedorNome: string;
  descricaoNf: string;
  produtoCodigoQ2p: number;
  produtoDescricao: string;
  userId: string;
}): Promise<{ criada: boolean }> {
  const descricaoNormalizada = normalizarDescricaoNf(args.descricaoNf);
  if (!args.fornecedorCnpj || !descricaoNormalizada) return { criada: false };
  const db = getDb();

  const [existente] = await db
    .select({ id: correlacaoProdutoFornecedor.id })
    .from(correlacaoProdutoFornecedor)
    .where(
      and(
        eq(correlacaoProdutoFornecedor.fornecedorCnpj, args.fornecedorCnpj),
        eq(correlacaoProdutoFornecedor.descricaoNormalizada, descricaoNormalizada),
        eq(correlacaoProdutoFornecedor.produtoCodigoQ2p, args.produtoCodigoQ2p),
        eq(correlacaoProdutoFornecedor.ativo, true),
      ),
    )
    .limit(1);

  if (existente) {
    await db
      .update(correlacaoProdutoFornecedor)
      .set({
        vezesUsada: sql`${correlacaoProdutoFornecedor.vezesUsada} + 1`,
        ultimaVezUsadaEm: new Date(),
        produtoDescricao: args.produtoDescricao,
        fornecedorNome: args.fornecedorNome,
        updatedAt: new Date(),
      })
      .where(eq(correlacaoProdutoFornecedor.id, existente.id));
    return { criada: false };
  }

  await db.insert(correlacaoProdutoFornecedor).values({
    fornecedorCnpj: args.fornecedorCnpj,
    fornecedorNome: args.fornecedorNome,
    descricaoNf: args.descricaoNf,
    descricaoNormalizada,
    produtoCodigoQ2p: args.produtoCodigoQ2p,
    produtoDescricao: args.produtoDescricao,
    vezesUsada: 1,
    ultimaVezUsadaEm: new Date(),
    criadoPor: args.userId,
  });
  return { criada: true };
}

/**
 * Define o CONJUNTO de produtos de uma descricao (PUT /correlacao, T042/T049):
 * adiciona os que faltam, mantem os que ja estao, DESATIVA os que sairam
 * (ativo=false, auditado — nunca DELETE). Descricao do produto resolvida no
 * catalogo Q2P aqui, no servidor (o cliente nao manda nomes).
 */
export async function definirConjuntoCorrelacao(args: {
  fornecedorCnpj: string;
  fornecedorNome: string;
  descricaoNf: string;
  produtosCodigoQ2p: number[];
  userId: string;
}): Promise<{ adicionados: number; mantidos: number; desativados: number; produtosNaoEncontrados: number[] }> {
  const descricaoNormalizada = normalizarDescricaoNf(args.descricaoNf);
  if (!descricaoNormalizada) throw new Error('Descrição do item da NF é obrigatória.');
  const desejados = Array.from(new Set(args.produtosCodigoQ2p.filter((c) => Number.isFinite(c) && c > 0)));

  // Nomes do catalogo Q2P — o que a tela mostra e o que vai para o De->Para.
  const nomes = new Map<number, string>();
  if (desejados.length > 0) {
    const { rows } = await getPool().query<{ codigo_produto: string; descricao: string }>(
      `SELECT codigo_produto::text AS codigo_produto, descricao FROM public."tbl_produtos_Q2P" WHERE codigo_produto = ANY($1::bigint[])`,
      [desejados],
    );
    for (const r of rows) nomes.set(Number(r.codigo_produto), r.descricao);
  }
  const produtosNaoEncontrados = desejados.filter((c) => !nomes.has(c));
  const validos = desejados.filter((c) => nomes.has(c));

  const db = getDb();
  const ativos = await db
    .select({ id: correlacaoProdutoFornecedor.id, codigo: correlacaoProdutoFornecedor.produtoCodigoQ2p })
    .from(correlacaoProdutoFornecedor)
    .where(
      and(
        eq(correlacaoProdutoFornecedor.fornecedorCnpj, args.fornecedorCnpj),
        eq(correlacaoProdutoFornecedor.descricaoNormalizada, descricaoNormalizada),
        eq(correlacaoProdutoFornecedor.ativo, true),
      ),
    );
  const ativosPorCodigo = new Map(ativos.map((a) => [Number(a.codigo), a.id]));

  const paraDesativar = ativos.filter((a) => !validos.includes(Number(a.codigo))).map((a) => a.id);
  const paraAdicionar = validos.filter((c) => !ativosPorCodigo.has(c));
  const mantidos = validos.length - paraAdicionar.length;

  await db.transaction(async (tx) => {
    if (paraDesativar.length > 0) {
      await tx
        .update(correlacaoProdutoFornecedor)
        .set({ ativo: false, atualizadoPor: args.userId, updatedAt: new Date() })
        .where(inArray(correlacaoProdutoFornecedor.id, paraDesativar));
    }
    if (paraAdicionar.length > 0) {
      await tx.insert(correlacaoProdutoFornecedor).values(
        paraAdicionar.map((codigo) => ({
          fornecedorCnpj: args.fornecedorCnpj,
          fornecedorNome: args.fornecedorNome,
          descricaoNf: args.descricaoNf,
          descricaoNormalizada,
          produtoCodigoQ2p: codigo,
          produtoDescricao: nomes.get(codigo)!,
          vezesUsada: 0,
          criadoPor: args.userId,
          atualizadoPor: args.userId,
        })),
      );
    }
  });

  logger.info(
    { fornecedorCnpj: args.fornecedorCnpj, descricaoNormalizada, adicionados: paraAdicionar.length, mantidos, desativados: paraDesativar.length },
    'Conjunto de correlação atualizado',
  );
  return { adicionados: paraAdicionar.length, mantidos, desativados: paraDesativar.length, produtosNaoEncontrados };
}
