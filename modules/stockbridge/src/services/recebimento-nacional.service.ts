import { sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { getDb, getPool, createLogger } from '@atlas/core';
import { movimentacao, aprovacao } from '@atlas/db';
import { converterParaKg } from './motor.service.js';
import { enviarAlertaRecebimentoNacionalLote } from './notificacao.service.js';
import { getDetalheNfNacional, type DetalheNfNacional, type ItemNfNacional } from './fila-nacional.service.js';
import { normalizarDescricaoNf } from './descricao-nf.js';
import type { UnidadeMedida, SubtipoMovimento } from '../types.js';

const logger = createLogger('stockbridge:recebimento-nacional');

// ACXEGDP-313: mensagens sem UUID/código OMIE — não identificam nada para o
// operador. Os identificadores internos ficam nos campos estruturados (logs).
export class LocalidadeNaoElegivelError extends Error {
  constructor(public readonly localidadeId: string, motivo: string) {
    super(`Local de estoque selecionado não é elegível para recebimento nacional: ${motivo}`);
    this.name = 'LocalidadeNaoElegivelError';
  }
}

export class ProdutoNaoEncontradoError extends Error {
  constructor(public readonly codigoProdutoAcxe: number, itemLabel?: string) {
    super(
      `Produto ${itemLabel ? `do ${itemLabel} ` : ''}não encontrado no cadastro OMIE — atualize a página e selecione o produto novamente`,
    );
    this.name = 'ProdutoNaoEncontradoError';
  }
}

export interface LocalidadeNacionalItem {
  id: string;
  codigo: string;
  nome: string;
  tipo: string;
  cidade: string | null;
  cnpj: string | null;
  empresa: 'acxe' | 'q2p';
  codigoLocalEstoqueOmie: string;
}

/**
 * Lista localidades elegiveis para recebimento nacional.
 *
 * Regra: localidades nao-espelhadas, ou seja, com correlacao OMIE em apenas UM
 * dos lados (codigo_local_estoque_acxe XOR codigo_local_estoque_q2p preenchido).
 *
 * Localidades espelhadas (ambos os codigos preenchidos) sao usadas pra importacao
 * (fluxo dual ACXE -> Q2P) e nao devem aparecer como destino de NF nacional.
 *
 * Tambem exclui localidades virtuais (transito/ajuste) que nao recebem material.
 */
export async function listarLocalidadesNacional(
  empresa: 'acxe' | 'q2p',
): Promise<LocalidadeNacionalItem[]> {
  const db = getDb();
  const colCnpj = empresa === 'acxe' ? 'codigo_local_estoque_acxe' : 'codigo_local_estoque_q2p';
  const colOutro = empresa === 'acxe' ? 'codigo_local_estoque_q2p' : 'codigo_local_estoque_acxe';

  const result = await db.execute<{
    id: string;
    codigo: string;
    nome: string;
    tipo: string;
    cidade: string | null;
    cnpj: string | null;
    codigo_local_estoque: string;
  }>(sql`
    SELECT
      l.id::text AS id,
      l.codigo,
      l.nome,
      l.tipo,
      l.cidade,
      l.cnpj,
      lc.${sql.raw(colCnpj)}::text AS codigo_local_estoque
    FROM stockbridge.localidade l
    INNER JOIN stockbridge.localidade_correlacao lc ON lc.localidade_id = l.id
    WHERE l.ativo = true
      AND l.tipo NOT IN ('virtual_transito', 'virtual_ajuste')
      AND lc.${sql.raw(colCnpj)} IS NOT NULL
      AND lc.${sql.raw(colOutro)} IS NULL
    ORDER BY l.codigo
  `);

  return result.rows.map((r) => ({
    id: r.id,
    codigo: r.codigo,
    nome: r.nome,
    tipo: r.tipo,
    cidade: r.cidade,
    cnpj: r.cnpj,
    empresa,
    codigoLocalEstoqueOmie: r.codigo_local_estoque,
  }));
}

export interface ProdutoNacionalItem {
  codigo: number; // codigo da empresa selecionada (acxe=codigo_produto ACXE, q2p=codigo_produto Q2P)
  descricao: string;
  unidadeMedida: string | null;
}

/**
 * Busca produtos do catalogo para recebimento nacional.
 *
 * Para empresa=q2p, exige match cross-empresa em tbl_produtos_Q2P (mesmo padrao
 * do Cockpit/SaidaManual). Para empresa=acxe, lista direto de tbl_produtos_ACXE.
 *
 * Sempre retorna `codigoAcxe` (codigo_produto bigint do ACXE) como identificador
 * canonico — eh o que vai pra movimentacao.produto_codigo_acxe.
 */
export async function buscarProdutosNacional(params: {
  empresa: 'acxe' | 'q2p';
  q?: string | null;
  limit?: number;
}): Promise<ProdutoNacionalItem[]> {
  const db = getDb();
  const limit = params.limit ?? 50;
  const termo = params.q && params.q.trim().length > 0 ? `%${params.q.trim()}%` : null;

  if (params.empresa === 'q2p') {
    // Q2P nacional: lista diretamente de tbl_produtos_Q2P com codigo Q2P.
    // Nao exige match ACXE — estoques nacionais nao sao espelhados.
    const result = await db.execute<{
      codigo: string;
      descricao: string;
      unidade: string | null;
    }>(sql`
      SELECT
        pq.codigo_produto::text AS codigo,
        pq.descricao,
        pq.unidade
      FROM public."tbl_produtos_Q2P" pq
      WHERE pq.descricao IS NOT NULL
        AND (pq.inativo IS NULL OR pq.inativo <> 'S')
        ${termo ? sql`AND pq.descricao ILIKE ${termo}` : sql``}
      ORDER BY pq.descricao
      LIMIT ${limit}
    `);
    return result.rows.map((r) => ({
      codigo: Number(r.codigo),
      descricao: r.descricao,
      unidadeMedida: r.unidade,
    }));
  }

  // empresa === 'acxe': lista diretamente de tbl_produtos_ACXE
  const result = await db.execute<{
    codigo: string;
    descricao: string;
    unidade: string | null;
  }>(sql`
    SELECT
      pa.codigo_produto::text AS codigo,
      pa.descricao,
      pa.unidade
    FROM public."tbl_produtos_ACXE" pa
    WHERE pa.descricao IS NOT NULL
      AND (pa.inativo IS NULL OR pa.inativo <> 'S')
      ${termo ? sql`AND pa.descricao ILIKE ${termo}` : sql``}
    ORDER BY pa.descricao
    LIMIT ${limit}
  `);
  return result.rows.map((r) => ({
    codigo: Number(r.codigo),
    descricao: r.descricao,
    unidadeMedida: r.unidade,
  }));
}

export interface ItemRecebimentoNacionalInput {
  empresa: 'acxe' | 'q2p';
  /** Codigo ACXE — preenchido quando empresa='acxe'. Null para Q2P nacional. */
  produtoCodigoAcxe: number | null;
  /** Codigo Q2P — preenchido quando empresa='q2p'. Null para ACXE nacional. */
  produtoCodigoQ2p: number | null;
  /** UUID da localidade (stockbridge.localidade.id). */
  localidadeId: string;
  /** Quantidade na unidade informada. Convertida para Kg internamente. */
  quantidade: number;
  unidade: UnidadeMedida;
  /**
   * Valor unitario de referencia (R$/kg) do item — usado apenas como peso do
   * rateio do valor total da NF (ACXEGDP-178). Nao e o custo final do item.
   */
  valorUnitarioReferenciaBrl: number;
}

export interface ProcessarRecebimentoNacionalInput {
  /** Numero da NF — referencia, vai pra observacao do ajuste OMIE. */
  notaFiscal: string;
  /** Valor total da NF em BRL (com impostos) — rateado entre os itens por peso (ACXEGDP-178). */
  valorTotalNfBrl: number;
  /** Observacao livre adicional do operador (opcional). */
  observacoes?: string | null;
  itens: ItemRecebimentoNacionalInput[];
  userId: string;
}

export interface ItemRecebimentoNacionalResult {
  movimentacaoId: string;
  aprovacaoId: string;
  produtoCodigoAcxe: number;
  empresa: 'acxe' | 'q2p';
  galpao: string;
  quantidadeKg: number;
}

export interface ProcessarRecebimentoNacionalResult {
  notaFiscal: string;
  status: 'aguardando_aprovacao';
  precisaNivel: 'gestor';
  itens: ItemRecebimentoNacionalResult[];
}

/**
 * Registra um recebimento nacional com 1+ itens.
 *
 * Diferente do recebimento de importacao, este fluxo:
 *  - Nao consulta NF no OMIE (a NF e apenas referencia para observacao)
 *  - Nao usa stockbridge.lote (movimentacao agnostica de lote, padrao saida manual)
 *  - Nao faz match ACXE<->Q2P (operador escolhe produto + empresa diretamente)
 *  - Cria 1 movimentacao + 1 aprovacao por item (aprovacao gestor obrigatoria)
 *
 * O ajuste OMIE eh disparado quando o gestor aprova a movimentacao individual.
 * Cada item eh aprovado independentemente — gestor pode aprovar uns e rejeitar
 * outros sem afetar o restante da NF.
 */
export async function processarRecebimentoNacional(
  input: ProcessarRecebimentoNacionalInput,
): Promise<ProcessarRecebimentoNacionalResult> {
  if (!input.notaFiscal || input.notaFiscal.trim().length === 0) {
    throw new Error('Número da NF é obrigatório');
  }
  if (!Number.isFinite(input.valorTotalNfBrl) || input.valorTotalNfBrl <= 0) {
    throw new Error('Valor total da NF deve ser positivo');
  }
  if (!input.itens || input.itens.length === 0) {
    throw new Error('Recebimento precisa de pelo menos 1 item');
  }

  // Valida cada item antes de tocar o banco. ACXEGDP-313: itens identificados
  // pela posição no formulário — o código OMIE não significa nada para o operador.
  for (const [idx, it] of input.itens.entries()) {
    const codigoProduto = it.empresa === 'acxe' ? it.produtoCodigoAcxe : it.produtoCodigoQ2p;
    const rotulo = `item ${idx + 1} (${it.empresa.toUpperCase()})`;
    if (!Number.isFinite(codigoProduto) || (codigoProduto ?? 0) <= 0) {
      throw new Error(`Produto inválido no ${rotulo} — selecione o produto novamente`);
    }
    if (!Number.isFinite(it.quantidade) || it.quantidade <= 0) {
      throw new Error(`Quantidade do ${rotulo} deve ser positiva`);
    }
    if (!Number.isFinite(it.valorUnitarioReferenciaBrl) || it.valorUnitarioReferenciaBrl <= 0) {
      throw new Error(`Valor unitário de referência do ${rotulo} deve ser positivo`);
    }
  }

  const db = getDb();
  const nfNorm = input.notaFiscal.trim();
  const obsBase = input.observacoes?.trim() ?? '';

  const localidadesById = await resolverLocalidadesParaItens(input.itens);
  const produtosByCodigo = await resolverProdutosNacionais(input.itens);

  // Rateio ponderado (ACXEGDP-178): o valor total da NF (informado uma unica vez,
  // no cabecalho) e distribuido entre os itens proporcionalmente ao peso de cada
  // um — peso = valor unitario de referencia x quantidade em Kg. Isso reflete
  // melhor o valor real de cada produto do que uma divisao igual por Kg (um
  // produto caro nao pode custar o mesmo por Kg que um barato na mesma NF).
  const quantidadesKg = input.itens.map((it) =>
    Number(new Decimal(converterParaKg(it.quantidade, it.unidade)).toFixed(3)),
  );
  const pesos = input.itens.map((it, idx) =>
    new Decimal(it.valorUnitarioReferenciaBrl).times(quantidadesKg[idx]!),
  );
  const somaPesos = pesos.reduce((acc, p) => acc.plus(p), new Decimal(0));
  if (somaPesos.lte(0)) {
    throw new Error('Soma dos pesos do rateio (valor unitário × quantidade) deve ser positiva');
  }
  const valoresItemBrl = pesos.map((peso) =>
    new Decimal(input.valorTotalNfBrl).times(peso).dividedBy(somaPesos),
  );

  const itensProcessados = await db.transaction(async (tx) => {
    const out: ItemRecebimentoNacionalResult[] = [];
    for (const [idx, it] of input.itens.entries()) {
      const loc = localidadesById.get(it.localidadeId);
      if (!loc) {
        throw new LocalidadeNaoElegivelError(
          it.localidadeId,
          'não encontrado ou é espelhado (ACXE+Q2P) — o recebimento nacional não aceita locais espelhados',
        );
      }
      if (loc.empresa !== it.empresa) {
        throw new LocalidadeNaoElegivelError(
          it.localidadeId,
          `a empresa do item (${it.empresa.toUpperCase()}) não bate com a empresa do local ${loc.codigo} (${loc.empresa.toUpperCase()})`,
        );
      }
      const codigoProduto = it.empresa === 'acxe' ? it.produtoCodigoAcxe! : it.produtoCodigoQ2p!;
      const chaveDescricao = `${it.empresa}:${codigoProduto}`;
      const prod = produtosByCodigo.get(chaveDescricao);
      if (!prod) {
        logger.warn({ codigoProduto, empresa: it.empresa, nf: nfNorm }, 'Produto do recebimento nacional não encontrado no cadastro');
        throw new ProdutoNaoEncontradoError(codigoProduto, `item ${idx + 1} (${it.empresa.toUpperCase()})`);
      }

      const quantidadeKg = quantidadesKg[idx]!;
      if (quantidadeKg <= 0) {
        throw new Error(`Quantidade em Kg do item ${idx + 1} ("${prod.descricao}") deve ser positiva`);
      }

      const custoUnitarioBrl = Number(
        valoresItemBrl[idx]!.dividedBy(quantidadeKg).toFixed(6),
      );

      const obsItem = [
        `Recebimento nacional NF ${nfNorm}`,
        `Produto: ${prod.descricao} (${codigoProduto})`,
        `Empresa: ${it.empresa.toUpperCase()} · Galpão OMIE ${loc.codigoLocalEstoqueOmie}`,
        obsBase ? `Obs: ${obsBase}` : null,
      ]
        .filter(Boolean)
        .join(' | ');

      const [mov] = await tx
        .insert(movimentacao)
        .values({
          notaFiscal: nfNorm,
          tipoMovimento: 'entrada_manual',
          subtipo: 'compra_nacional' satisfies SubtipoMovimento,
          loteId: null,
          produtoCodigoAcxe: it.produtoCodigoAcxe ?? null,
          produtoCodigoQ2p: it.produtoCodigoQ2p ?? null,
          // Codigo interno Atlas (ex: '11.2'), nao o codigoLocalEstoqueOmie (numerico).
          // GALPAO_LABELS na UI mapeia o codigo interno pra label legivel.
          galpao: loc.codigo,
          empresa: it.empresa,
          criadoPor: input.userId,
          quantidadeKg: String(quantidadeKg),
          observacoes: obsItem,
          custoUnitarioBrl: String(custoUnitarioBrl),
          statusOmie: 'pendente_q2p',
        })
        .returning();

      const [apr] = await tx
        .insert(aprovacao)
        .values({
          loteId: null,
          produtoCodigoAcxe: it.produtoCodigoAcxe ?? null,
          produtoCodigoQ2p: it.produtoCodigoQ2p ?? null,
          galpao: loc.codigo,
          empresa: it.empresa,
          movimentacaoId: mov!.id,
          precisaNivel: 'gestor',
          tipoAprovacao: 'entrada_manual',
          quantidadeRecebidaKg: String(quantidadeKg),
          observacoes: obsItem,
          lancadoPor: input.userId,
        })
        .returning();

      out.push({
        movimentacaoId: mov!.id,
        aprovacaoId: apr!.id,
        produtoCodigoAcxe: it.produtoCodigoAcxe ?? codigoProduto,
        empresa: it.empresa,
        galpao: loc.codigo,
        quantidadeKg,
      });
    }
    return out;
  });

  // EML-09: 1 e-mail por gestor com todos os itens da NF (antes era 1 e-mail por
  // item × gestor — N×M e-mails para a mesma NF). A rastreabilidade individual de
  // cada item continua na tela de aprovações; o e-mail é só o gatilho.
  void enviarAlertaRecebimentoNacionalLote({
    notaFiscal: nfNorm,
    nivel: 'gestor',
    itens: itensProcessados.map((r) => {
      const prod = produtosByCodigo.get(`${r.empresa}:${r.produtoCodigoAcxe}`);
      return {
        produto: prod?.descricao ?? `SKU ${r.produtoCodigoAcxe}`,
        empresa: r.empresa,
        galpao: r.galpao,
        quantidadeKg: r.quantidadeKg,
      };
    }),
    detalhes: `Recebimento nacional · ${obsBase || 'sem observação adicional'}`,
  }).catch((err) => logger.error({ err, nf: nfNorm }, 'Falha ao notificar gestor (digest recebimento nacional)'));

  logger.info(
    { nf: nfNorm, qtdItens: itensProcessados.length, userId: input.userId },
    'Recebimento nacional registrado, aguarda aprovação gestor',
  );

  return {
    notaFiscal: nfNorm,
    status: 'aguardando_aprovacao',
    precisaNivel: 'gestor',
    itens: itensProcessados,
  };
}

interface LocalidadeResolvida {
  id: string;
  /** Codigo interno Atlas (ex: '11.2'). Vai pra movimentacao.galpao. */
  codigo: string;
  empresa: 'acxe' | 'q2p';
  /** Codigo numerico OMIE do local_estoque. Vai pra chamadas API OMIE. */
  codigoLocalEstoqueOmie: string;
}

async function resolverLocalidadesParaItens(
  itens: ReadonlyArray<{ localidadeId: string }>,
): Promise<Map<string, LocalidadeResolvida>> {
  const ids = Array.from(new Set(itens.map((i) => i.localidadeId)));
  if (ids.length === 0) return new Map();

  // STK-18: 1 query para todos os ids (era N+1 — uma por localidade). Usa
  // pool.query + `= ANY($1::text[])`, o mesmo idioma provado no repo
  // (cockpit/cmc/meu-estoque), que não depende da serialização de array do
  // drizzle (a razão do loop original).
  const pool = getPool();
  const map = new Map<string, LocalidadeResolvida>();

  const { rows } = await pool.query<{
    id: string;
    codigo: string;
    codigo_acxe: string | null;
    codigo_q2p: string | null;
  }>(
    `
      SELECT
        l.id::text AS id,
        l.codigo AS codigo,
        lc.codigo_local_estoque_acxe::text AS codigo_acxe,
        lc.codigo_local_estoque_q2p::text AS codigo_q2p
      FROM stockbridge.localidade l
      INNER JOIN stockbridge.localidade_correlacao lc ON lc.localidade_id = l.id
      WHERE l.ativo = true
        AND l.tipo NOT IN ('virtual_transito', 'virtual_ajuste')
        AND l.id::text = ANY($1::text[])
    `,
    [ids],
  );

  for (const r of rows) {
    const acxe = r.codigo_acxe;
    const q2p = r.codigo_q2p;
    // Ignora espelhadas (ambos preenchidos) — operador nao deveria selecionar mas
    // defesa em profundidade contra payload manipulado.
    if (acxe && q2p) continue;
    if (acxe && !q2p) {
      map.set(r.id, { id: r.id, codigo: r.codigo, empresa: 'acxe', codigoLocalEstoqueOmie: acxe });
    } else if (q2p && !acxe) {
      map.set(r.id, { id: r.id, codigo: r.codigo, empresa: 'q2p', codigoLocalEstoqueOmie: q2p });
    }
  }
  return map;
}

// Chave do mapa: `${empresa}:${codigo}` para evitar colisão entre codigos ACXE e Q2P
async function resolverProdutosNacionais(
  itens: ReadonlyArray<{ empresa: 'acxe' | 'q2p'; produtoCodigoAcxe?: number | null; produtoCodigoQ2p?: number | null }>,
): Promise<Map<string, { descricao: string }>> {
  // STK-18: 2 queries (uma por catálogo) em vez de 1 por item. Agrupa os codigos
  // por empresa e busca em lote com `= ANY($1::bigint[])`. Chave do mapa mantida
  // idêntica: `${empresa}:${codigo}`.
  const pool = getPool();
  const map = new Map<string, { descricao: string }>();

  const acxeCodigos = Array.from(
    new Set(itens.filter((i) => i.empresa === 'acxe' && i.produtoCodigoAcxe).map((i) => i.produtoCodigoAcxe!)),
  );
  const q2pCodigos = Array.from(
    new Set(itens.filter((i) => i.empresa === 'q2p' && i.produtoCodigoQ2p).map((i) => i.produtoCodigoQ2p!)),
  );

  if (acxeCodigos.length > 0) {
    const { rows } = await pool.query<{ codigo_produto: string; descricao: string }>(
      `SELECT codigo_produto::text AS codigo_produto, descricao
       FROM public."tbl_produtos_ACXE" WHERE codigo_produto = ANY($1::bigint[])`,
      [acxeCodigos],
    );
    for (const r of rows) map.set(`acxe:${r.codigo_produto}`, { descricao: r.descricao });
  }

  if (q2pCodigos.length > 0) {
    const { rows } = await pool.query<{ codigo_produto: string; descricao: string }>(
      `SELECT codigo_produto::text AS codigo_produto, descricao
       FROM public."tbl_produtos_Q2P" WHERE codigo_produto = ANY($1::bigint[])`,
      [q2pCodigos],
    );
    for (const r of rows) map.set(`q2p:${r.codigo_produto}`, { descricao: r.descricao });
  }

  return map;
}

// ═══════════════════════════════════════════════════════════════════════════
// Feature 015 (ACXEGDP-328) — recebimento nacional A PARTIR DA NF do espelho
// ═══════════════════════════════════════════════════════════════════════════
//
// O caminho manual acima permanece INTACTO (FR-014): atende NF fora do espelho.
// Este caminho e o inverso: o operador nao digita quantidade, unidade nem valor —
// tudo vem da NF (getDetalheNfNacional). Ele informa apenas o peso CONFERIDO na
// balanca (quando difere), o produto do catalogo por item e o estoque destino.
//
// Diferencas deliberadas em relacao ao manual e a importacao:
//  - valor do item = v_tot_item da NF (nao rateio por peso digitado);
//  - divergencia aceita nos DOIS sentidos, com motivo + aprovacao (D17) — a
//    importacao recusa receber acima da NF; aqui 26 dos 29 casos reais sao acima;
//  - um item da NF pode virar N produtos (sucata classificada por grau, D18) —
//    valor e quantidade da NF rateados por peso, ancorados na quantidade da NF (D25);
//  - UMA TRANSACAO POR PRODUTO: 23505 aborta a transacao inteira no Postgres, e
//    o contrato promete desfecho por produto (ja_recebido ao lado de aguardando);
//  - idempotencia por (chave de acesso, descricao normalizada do item, produto).

export const TOLERANCIA_DIVERGENCIA_KG = 1;
const TOLERANCIA_FECHAMENTO_KG = 0.001;

export type CodigoValidacaoPorNf =
  | 'DISTRIBUICAO_NAO_FECHA'
  | 'MOTIVO_DIVERGENCIA_OBRIGATORIO'
  | 'PRODUTO_REPETIDO_NO_ITEM'
  | 'ITEM_NAO_ENCONTRADO'
  | 'QUANTIDADE_INVALIDA';

export class ValidacaoRecebimentoNacionalError extends Error {
  constructor(public readonly code: CodigoValidacaoPorNf, message: string) {
    super(message);
    this.name = 'ValidacaoRecebimentoNacionalError';
  }
}

export class NfNacionalJaProcessadaError extends Error {
  constructor(public readonly notaFiscal: string) {
    super(`Todos os itens solicitados da NF ${notaFiscal} já foram recebidos. Nada a fazer.`);
    this.name = 'NfNacionalJaProcessadaError';
  }
}

export interface ProdutoDistribuicaoInput {
  produtoCodigoQ2p: number;
  quantidadeKg: number;
  localidadeId: string;
}

export interface ItemPorNfInput {
  indice: number;
  descricaoFornecedor: string;
  /** Peso conferido na balanca. Ausente = assume a quantidade da NF (sem divergencia). */
  quantidadeConferidaKg?: number | null;
  motivoDivergencia?: string | null;
  observacoes?: string | null;
  produtos: ProdutoDistribuicaoInput[];
}

export interface ProcessarRecebimentoPorNfInput {
  nfChaveAcesso: string;
  observacoes?: string | null;
  itens: ItemPorNfInput[];
  userId: string;
}

export type StatusProdutoPorNf =
  | 'aguardando_aprovacao'
  | 'ja_recebido'
  | 'bloqueado_unidade'
  | 'bloqueado_unidade_incoerente'
  | 'falha';

export interface ProdutoPorNfResult {
  indice: number;
  descricaoFornecedor: string;
  /** descricao do produto do catalogo (ACXEGDP-313: nunca o codigo em mensagem) */
  produto: string;
  produtoCodigoQ2p: number;
  status: StatusProdutoPorNf;
  movimentacaoId?: string;
  aprovacaoId?: string;
  quantidadeKg: number;
  quantidadeNfKg: number | null;
  divergenciaKg: number | null;
  valorItemBrl: number | null;
  mensagemErro?: string;
}

export interface ProcessarRecebimentoPorNfResult {
  nfChaveAcesso: string;
  notaFiscal: string;
  produtos: ProdutoPorNfResult[];
  resumo: { enviadosParaAprovacao: number; jaRecebidos: number; bloqueados: number; falhas: number };
}

/** Produto preparado para gravacao — todo calculo feito ANTES de qualquer escrita. */
interface ProdutoPreparado {
  indice: number;
  item: ItemNfNacional;
  input: ProdutoDistribuicaoInput;
  produtoDescricao: string;
  loc: LocalidadeResolvida;
  quantidadeKg: number;
  quantidadeNfKg: number;
  divergenciaKg: number;
  valorItemBrl: number;
  custoUnitarioBrl: number;
  observacoes: string;
  temDivergencia: boolean;
  deltaItemKg: number;
}

function violacaoIdempotenciaNacional(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const o = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (o.code === '23505' && o.constraint === 'movimentacao_nf_nacional_idempotencia_idx') return true;
    e = o.cause;
  }
  return false;
}

const fmtKg = (v: number): string => v.toLocaleString('pt-BR', { maximumFractionDigits: 3 });

/**
 * Da entrada nos itens de uma NF nacional do espelho. Dois portoes:
 *  1. VALIDACAO tudo-ou-nada (nenhuma escrita antes): NF existe/valida/nao
 *     excluida; itens pedidos existem; distribuicao fecha; divergencia tem
 *     motivo; localidades elegiveis (nao espelhadas); produtos no catalogo.
 *  2. ESCRITA best-effort POR PRODUTO, cada um na propria transacao: falha de um
 *     nao derruba os demais; 23505 do indice de idempotencia vira `ja_recebido`.
 */
export async function processarRecebimentoNacionalPorNf(
  input: ProcessarRecebimentoPorNfInput,
): Promise<ProcessarRecebimentoPorNfResult> {
  if (!input.itens || input.itens.length === 0) {
    throw new ValidacaoRecebimentoNacionalError('ITEM_NAO_ENCONTRADO', 'Informe pelo menos um item da NF para receber.');
  }

  // Lanca NfNacionalNaoEncontrada / NfNacionalCancelada / FornecedorExcluido.
  const detalhe: DetalheNfNacional = await getDetalheNfNacional(input.nfChaveAcesso);
  const obsBase = input.observacoes?.trim() ?? '';

  // ── Portao 1: validacao ─────────────────────────────────────────────────
  const resultados: ProdutoPorNfResult[] = [];
  const preparados: ProdutoPreparado[] = [];
  const indicesVistos = new Set<number>();

  for (const it of input.itens) {
    if (indicesVistos.has(it.indice)) {
      throw new ValidacaoRecebimentoNacionalError('ITEM_NAO_ENCONTRADO', `O item ${it.indice + 1} foi informado mais de uma vez.`);
    }
    indicesVistos.add(it.indice);

    const item = detalhe.itens.find(
      (d) => d.indice === it.indice && d.descricaoNormalizada === normalizarDescricaoNf(it.descricaoFornecedor),
    );
    if (!item) {
      throw new ValidacaoRecebimentoNacionalError(
        'ITEM_NAO_ENCONTRADO',
        `O item "${it.descricaoFornecedor.trim()}" não corresponde a nenhuma linha da NF ${detalhe.notaFiscal}. Recarregue a nota e tente de novo.`,
      );
    }
    if (!it.produtos || it.produtos.length === 0) {
      throw new ValidacaoRecebimentoNacionalError('ITEM_NAO_ENCONTRADO', `Escolha ao menos um produto para "${item.descricaoFornecedor.trim()}".`);
    }
    const codigos = it.produtos.map((p) => p.produtoCodigoQ2p);
    if (new Set(codigos).size !== codigos.length) {
      // Sem isto a segunda linha colidiria no indice e viraria 'ja_recebido', perdendo peso em silencio.
      throw new ValidacaoRecebimentoNacionalError(
        'PRODUTO_REPETIDO_NO_ITEM',
        `O mesmo produto aparece mais de uma vez em "${item.descricaoFornecedor.trim()}". Some as quantidades numa linha só.`,
      );
    }

    // Bloqueio por unidade: desfecho por produto, nunca erro da requisicao — os
    // demais itens da NF seguem (FR-009/FR-029 + edge case da spec).
    if (!item.conversao.ok || item.quantidadeNfKg == null) {
      const status: StatusProdutoPorNf =
        item.bloqueio === 'unidade_incoerente' ? 'bloqueado_unidade_incoerente' : 'bloqueado_unidade';
      for (const p of it.produtos) {
        resultados.push({
          indice: it.indice, descricaoFornecedor: item.descricaoFornecedor, produto: '', produtoCodigoQ2p: p.produtoCodigoQ2p,
          status, quantidadeKg: p.quantidadeKg, quantidadeNfKg: null, divergenciaKg: null, valorItemBrl: null,
          mensagemErro: item.bloqueioMensagem ?? 'Unidade da NF não pôde ser convertida para Kg.',
        });
      }
      continue;
    }

    // Ja recebido por inteiro: pelo caminho novo (restante <= tolerancia) ou pelo
    // manual/baixa externa (match sem parcela atribuida — recebido por NF inteira).
    const recebidoIntegral =
      item.jaRecebido &&
      (item.quantidadeNfJaAtribuidaKg === 0 || (item.quantidadeRestanteKg ?? 0) <= TOLERANCIA_DIVERGENCIA_KG);
    if (recebidoIntegral) {
      for (const p of it.produtos) {
        resultados.push({
          indice: it.indice, descricaoFornecedor: item.descricaoFornecedor, produto: '', produtoCodigoQ2p: p.produtoCodigoQ2p,
          status: 'ja_recebido', quantidadeKg: p.quantidadeKg, quantidadeNfKg: null, divergenciaKg: null, valorItemBrl: null,
        });
      }
      continue;
    }

    const quantidadeNfKg = item.quantidadeNfKg;
    const conferida = it.quantidadeConferidaKg ?? quantidadeNfKg;
    if (!Number.isFinite(conferida) || conferida <= 0) {
      throw new ValidacaoRecebimentoNacionalError('QUANTIDADE_INVALIDA', `A quantidade conferida de "${item.descricaoFornecedor.trim()}" deve ser positiva.`);
    }
    const deltaItemKg = Number(new Decimal(conferida).minus(quantidadeNfKg).toFixed(3));
    const temDivergencia = Math.abs(deltaItemKg) > TOLERANCIA_DIVERGENCIA_KG;
    const motivo = it.motivoDivergencia?.trim() ?? '';
    if (temDivergencia && motivo.length === 0) {
      throw new ValidacaoRecebimentoNacionalError(
        'MOTIVO_DIVERGENCIA_OBRIGATORIO',
        `"${item.descricaoFornecedor.trim()}": a NF declara ${fmtKg(quantidadeNfKg)} kg e a balança marcou ${fmtKg(conferida)} kg ` +
          `(${deltaItemKg > 0 ? '+' : ''}${fmtKg(deltaItemKg)} kg). Informe o motivo da diferença.`,
      );
    }

    // Retomada: o que ainda falta distribuir e a conferida menos o que ja foi gravado.
    const aDistribuir = Number(new Decimal(conferida).minus(item.quantidadeConferidaJaGravadaKg).toFixed(3));
    if (aDistribuir <= 0) {
      for (const p of it.produtos) {
        resultados.push({
          indice: it.indice, descricaoFornecedor: item.descricaoFornecedor, produto: '', produtoCodigoQ2p: p.produtoCodigoQ2p,
          status: 'ja_recebido', quantidadeKg: p.quantidadeKg, quantidadeNfKg: null, divergenciaKg: null, valorItemBrl: null,
        });
      }
      continue;
    }
    const somaProdutos = it.produtos.reduce((acc, p) => acc.plus(p.quantidadeKg), new Decimal(0));
    for (const p of it.produtos) {
      if (!Number.isFinite(p.quantidadeKg) || p.quantidadeKg <= 0) {
        throw new ValidacaoRecebimentoNacionalError('QUANTIDADE_INVALIDA', `Quantidade de um produto em "${item.descricaoFornecedor.trim()}" deve ser positiva.`);
      }
    }
    if (somaProdutos.minus(aDistribuir).abs().gt(TOLERANCIA_FECHAMENTO_KG)) {
      throw new ValidacaoRecebimentoNacionalError(
        'DISTRIBUICAO_NAO_FECHA',
        `Em "${item.descricaoFornecedor.trim()}" a soma dos produtos (${fmtKg(somaProdutos.toNumber())} kg) ` +
          `precisa ser igual ao que falta receber (${fmtKg(aDistribuir)} kg).`,
      );
    }

    // Rateio ancorado na quantidade da NF (D25): fracao = kg_p / conferida.
    //   quantidade_nf_kg(p) = nf_do_item × fracao
    //   valor(p)            = v_tot_item × fracao   (= v_tot_item × nf(p) / nf_do_item)
    //   custo_unitario      = valor(p) / kg_p        (= v_tot_item / conferida)
    // Soma fecha em v_tot_item independentemente de quantas submissoes houver.
    const vTotItem = new Decimal(item.valorTotalItemBrl);
    const conferidaDec = new Decimal(conferida);
    for (const p of it.produtos) {
      const fracao = new Decimal(p.quantidadeKg).dividedBy(conferidaDec);
      const nfParcela = Number(new Decimal(quantidadeNfKg).times(fracao).toFixed(3));
      const valor = vTotItem.times(fracao);
      const custoUnitario = Number(valor.dividedBy(p.quantidadeKg).toFixed(6));
      preparados.push({
        indice: it.indice,
        item,
        input: p,
        produtoDescricao: '', // preenchido apos resolver catalogo
        loc: null as unknown as LocalidadeResolvida, // idem, localidades
        quantidadeKg: Number(new Decimal(p.quantidadeKg).toFixed(3)),
        quantidadeNfKg: nfParcela,
        divergenciaKg: Number(new Decimal(p.quantidadeKg).minus(nfParcela).toFixed(3)),
        valorItemBrl: Number(valor.toFixed(2)),
        custoUnitarioBrl: custoUnitario,
        observacoes: '',
        temDivergencia,
        deltaItemKg,
      });
    }
    // Motivo/obs por item: aplicados nos preparados desse item abaixo.
    for (const pp of preparados.filter((x) => x.indice === it.indice)) {
      pp.observacoes = [
        `Recebimento nacional NF ${detalhe.notaFiscal} · via fila`,
        `Item da NF: ${item.descricaoFornecedor.trim()}`,
        temDivergencia
          ? `Divergência: NF ${fmtKg(quantidadeNfKg)} kg × conferido ${fmtKg(conferida)} kg (${deltaItemKg > 0 ? '+' : ''}${fmtKg(deltaItemKg)} kg) — ${motivo}`
          : null,
        it.observacoes?.trim() ? `Obs item: ${it.observacoes.trim()}` : null,
        obsBase ? `Obs: ${obsBase}` : null,
      ]
        .filter(Boolean)
        .join(' | ');
    }
  }

  if (preparados.length === 0) {
    const todosJaRecebidos = resultados.length > 0 && resultados.every((r) => r.status === 'ja_recebido');
    if (todosJaRecebidos) throw new NfNacionalJaProcessadaError(detalhe.notaFiscal);
    // So bloqueios: devolve o desfecho por produto (nao e erro da requisicao).
    return montarResultado(detalhe, resultados);
  }

  // Localidades (nao espelhadas — defesa em profundidade, FR-011) e produtos (catalogo Q2P).
  const localidadesById = await resolverLocalidadesParaItens(preparados.map((p) => ({ localidadeId: p.input.localidadeId })));
  const produtosByCodigo = await resolverProdutosNacionais(
    preparados.map((p) => ({ empresa: 'q2p' as const, produtoCodigoQ2p: p.input.produtoCodigoQ2p })),
  );
  for (const pp of preparados) {
    const loc = localidadesById.get(pp.input.localidadeId);
    if (!loc) {
      throw new LocalidadeNaoElegivelError(
        pp.input.localidadeId,
        'não encontrado ou é espelhado (ACXE+Q2P) — o recebimento nacional não aceita locais espelhados',
      );
    }
    if (loc.empresa !== 'q2p') {
      throw new LocalidadeNaoElegivelError(pp.input.localidadeId, `o local ${loc.codigo} não pertence à Q2P`);
    }
    const prod = produtosByCodigo.get(`q2p:${pp.input.produtoCodigoQ2p}`);
    if (!prod) {
      logger.warn({ codigoProduto: pp.input.produtoCodigoQ2p, nf: detalhe.notaFiscal }, 'Produto do recebimento por NF não encontrado no catálogo');
      throw new ProdutoNaoEncontradoError(pp.input.produtoCodigoQ2p, `item "${pp.item.descricaoFornecedor.trim()}"`);
    }
    pp.loc = loc;
    pp.produtoDescricao = prod.descricao;
    pp.observacoes = `${pp.observacoes} | Produto: ${prod.descricao} | Empresa: Q2P · Estoque ${loc.codigo}`;
  }

  // ── Portao 2: escrita por produto, uma transacao cada ──────────────────
  const db = getDb();
  const criados: ProdutoPreparado[] = [];
  for (const pp of preparados) {
    try {
      const { movId, aprId } = await db.transaction(async (tx) => {
        const [mov] = await tx
          .insert(movimentacao)
          .values({
            notaFiscal: detalhe.notaFiscal, // sem zeros a esquerda — formato das linhas historicas
            tipoMovimento: 'entrada_manual',
            subtipo: 'compra_nacional' satisfies SubtipoMovimento,
            loteId: null,
            produtoCodigoAcxe: null,
            produtoCodigoQ2p: pp.input.produtoCodigoQ2p,
            galpao: pp.loc.codigo,
            empresa: 'q2p',
            criadoPor: input.userId,
            quantidadeKg: String(pp.quantidadeKg),
            quantidadeNfKg: String(pp.quantidadeNfKg),
            quantidadeDivergenciaKg: String(pp.divergenciaKg),
            nfChaveAcesso: detalhe.nfChaveAcesso,
            nfItemDescricao: pp.item.descricaoFornecedor,
            nfItemDescricaoNormalizada: pp.item.descricaoNormalizada,
            observacoes: pp.observacoes,
            custoUnitarioBrl: String(pp.custoUnitarioBrl),
            statusOmie: 'pendente_q2p',
          })
          .returning();
        const [apr] = await tx
          .insert(aprovacao)
          .values({
            loteId: null,
            produtoCodigoAcxe: null,
            produtoCodigoQ2p: pp.input.produtoCodigoQ2p,
            galpao: pp.loc.codigo,
            empresa: 'q2p',
            movimentacaoId: mov!.id,
            precisaNivel: 'gestor',
            tipoAprovacao: 'entrada_manual',
            // Painel do gestor: NF × conferido × diferenca (FR-028).
            quantidadePrevistaKg: String(pp.quantidadeNfKg),
            quantidadeRecebidaKg: String(pp.quantidadeKg),
            // O enum so tem 'faltando'/'varredura'/'cruzada'; excesso vai no motivo.
            tipoDivergencia: pp.temDivergencia && pp.deltaItemKg < 0 ? 'faltando' : null,
            observacoes: pp.observacoes,
            lancadoPor: input.userId,
            nfChaveAcesso: detalhe.nfChaveAcesso,
            notaFiscal: detalhe.notaFiscal,
            nfItemDescricao: pp.item.descricaoFornecedor,
          })
          .returning();
        return { movId: mov!.id, aprId: apr!.id };
      });
      criados.push(pp);
      resultados.push({
        indice: pp.indice, descricaoFornecedor: pp.item.descricaoFornecedor, produto: pp.produtoDescricao,
        produtoCodigoQ2p: pp.input.produtoCodigoQ2p, status: 'aguardando_aprovacao',
        movimentacaoId: movId, aprovacaoId: aprId,
        quantidadeKg: pp.quantidadeKg, quantidadeNfKg: pp.quantidadeNfKg, divergenciaKg: pp.divergenciaKg, valorItemBrl: pp.valorItemBrl,
      });
    } catch (err) {
      if (violacaoIdempotenciaNacional(err)) {
        resultados.push({
          indice: pp.indice, descricaoFornecedor: pp.item.descricaoFornecedor, produto: pp.produtoDescricao,
          produtoCodigoQ2p: pp.input.produtoCodigoQ2p, status: 'ja_recebido',
          quantidadeKg: pp.quantidadeKg, quantidadeNfKg: pp.quantidadeNfKg, divergenciaKg: pp.divergenciaKg, valorItemBrl: pp.valorItemBrl,
        });
        continue;
      }
      logger.error({ err, nf: detalhe.notaFiscal, produto: pp.produtoDescricao }, 'Falha ao gravar produto do recebimento por NF');
      resultados.push({
        indice: pp.indice, descricaoFornecedor: pp.item.descricaoFornecedor, produto: pp.produtoDescricao,
        produtoCodigoQ2p: pp.input.produtoCodigoQ2p, status: 'falha',
        quantidadeKg: pp.quantidadeKg, quantidadeNfKg: pp.quantidadeNfKg, divergenciaKg: pp.divergenciaKg, valorItemBrl: pp.valorItemBrl,
        mensagemErro: `Não foi possível registrar "${pp.produtoDescricao}". Tente novamente; o que já entrou não será duplicado.`,
      });
    }
  }

  if (criados.length > 0) {
    void enviarAlertaRecebimentoNacionalLote({
      notaFiscal: detalhe.notaFiscal,
      nivel: 'gestor',
      itens: criados.map((c) => ({ produto: c.produtoDescricao, empresa: 'q2p' as const, galpao: c.loc.codigo, quantidadeKg: c.quantidadeKg })),
      detalhes: `Recebimento nacional via fila · ${detalhe.fornecedorNome}${obsBase ? ` · ${obsBase}` : ''}`,
    }).catch((err) => logger.error({ err, nf: detalhe.notaFiscal }, 'Falha ao notificar gestor (digest recebimento por NF)'));
  }

  logger.info(
    { nf: detalhe.notaFiscal, chave: detalhe.nfChaveAcesso, criados: criados.length, total: resultados.length, userId: input.userId },
    'Recebimento nacional por NF processado',
  );
  return montarResultado(detalhe, resultados);
}

function montarResultado(detalhe: DetalheNfNacional, produtos: ProdutoPorNfResult[]): ProcessarRecebimentoPorNfResult {
  produtos.sort((a, b) => a.indice - b.indice || a.produtoCodigoQ2p - b.produtoCodigoQ2p);
  return {
    nfChaveAcesso: detalhe.nfChaveAcesso,
    notaFiscal: detalhe.notaFiscal,
    produtos,
    resumo: {
      enviadosParaAprovacao: produtos.filter((p) => p.status === 'aguardando_aprovacao').length,
      jaRecebidos: produtos.filter((p) => p.status === 'ja_recebido').length,
      bloqueados: produtos.filter((p) => p.status === 'bloqueado_unidade' || p.status === 'bloqueado_unidade_incoerente').length,
      falhas: produtos.filter((p) => p.status === 'falha').length,
    },
  };
}
