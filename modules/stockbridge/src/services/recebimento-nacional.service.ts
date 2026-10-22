import { sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { getDb, getPool, createLogger } from '@atlas/core';
import { movimentacao, aprovacao } from '@atlas/db';
import { converterParaKg } from './motor.service.js';
import { consultarRecebimentoNfe } from '@atlas/integration-omie';
import { enviarAlertaRecebimentoNacionalLote, enviarAvisoComprasNfSemPc, type MotivoAvisoCompras } from './notificacao.service.js';
import {
  montarDetalheNfNacional,
  itemNfPendente,
  recebimentoFiscalHabilitado,
  EstoqueJaLancadoPeloOmieError,
  NfNacionalDispensadaError,
  type DetalheNfNacional,
  type DetalheNfNacionalInterno,
  type ItemNfNacional,
} from './fila-nacional.service.js';
import {
  concluirRecebimentoFiscal,
  estoqueLancadoNoRecebimento,
  RecebimentoFiscalSemFornecedorError,
  type VinculoFiscalConcluido,
} from './recebimento-fiscal.service.js';
import {
  validarEscolhaPc,
  exigePcHabilitado,
  NfSemPcError,
  CopiaPcsDefasadaError,
  type EscolhaPc,
  type EscolhaPcValidada,
  type ItemParaSugestao,
  type MotivoSemPc,
  type PcOutroCadastro,
  type ResultadoPcItem,
} from './pc-sugestao.service.js';
import { normalizarDescricaoNf } from './descricao-nf.js';
import { registrarUsoCorrelacao } from './correlacao-produto.service.js';
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
        produto: prod?.descricao ?? 'Produto não localizado no cadastro',
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
//  - valor do item = valor do item na NF, `i.v_prod` (nao rateio por peso
//    digitado; e NAO `v_tot_item`, que soma o IPI duas vezes — D26);
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
  | 'QUANTIDADE_INVALIDA'
  | 'NF_INCOMPLETA';

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
  /** Feature 017: PC escolhido para o item (so pesa com fiscal pendente e o fiscal pelo Atlas ligado) */
  pc?: EscolhaPc | null;
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

/**
 * Feature 016 (ACXEGDP-395): o que o Atlas fez com o recebimento FISCAL neste clique.
 *  - concluido      — EDITAR -> IGNORAR -> Concluir passaram no OMIE agora;
 *  - ja_concluido   — o OMIE ja mostrava concluido (alguem fez no portal, ou um
 *                     clique anterior deu timeout mas gravou); nada escrito;
 *  - nao_aplicavel  — a NF ja estava com fiscal feito (fonte do espelho de NF) ou
 *                     nenhum produto sera gravado (ex.: itens todos bloqueados);
 *  - desligado      — STOCKBRIDGE_RECEBIMENTO_FISCAL_ENABLED=false (comportamento da 015).
 */
export type StatusFiscalPorNf = 'concluido' | 'ja_concluido' | 'nao_aplicavel' | 'desligado';

export interface FiscalPorNfResult {
  status: StatusFiscalPorNf;
  concluidoEm: string | null;
  /** pt-BR, com NF e fornecedor; sem codigo OMIE */
  mensagem: string;
  /** Feature 017: itens vinculados a PC no OMIE neste fiscal (contrato §3) */
  vinculos: VinculoFiscalConcluido[];
  /** Feature 017: sequencias recebidas sem vinculo com PC (modo "receber sem vinculo") */
  semVinculo: number[];
  /** Feature 017: um aviso a compras foi disparado neste clique */
  avisoCompras: boolean;
}

/**
 * Feature 017 (research D7): a leitura ao vivo do recebimento de uma NF "fiscal ja
 * feito" cuja conclusao o espelho nao confirma (ausente, defasado ou nao casado) falhou —
 * sem saber se o estoque ja entrou pelo OMIE, o Atlas nao grava nada (502).
 */
export class VerificacaoEstoqueOmieError extends Error {
  constructor(public readonly notaFiscal: string, options?: { cause?: unknown }) {
    super(
      `Não foi possível conferir no OMIE se o estoque da NF ${notaFiscal} já entrou pelo recebimento fiscal. ` +
        'Nada foi registrado. Tente de novo em instantes; se persistir, avise o fiscal.',
      options,
    );
    this.name = 'VerificacaoEstoqueOmieError';
  }
}

export interface ProcessarRecebimentoPorNfResult {
  nfChaveAcesso: string;
  notaFiscal: string;
  produtos: ProdutoPorNfResult[];
  resumo: { enviadosParaAprovacao: number; jaRecebidos: number; bloqueados: number; falhas: number };
  fiscal: FiscalPorNfResult;
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
  const { detalhe, interno } = await montarDetalheNfNacional(input.nfChaveAcesso);
  const obsBase = input.observacoes?.trim() ?? '';
  // Feature 017: o PC so entra quando o Atlas faz o fiscal (chave da 016 ligada e fiscal pendente).
  const fluxoPc = recebimentoFiscalHabilitado() && detalhe.fiscal === 'pendente';
  const escolhasPc: EscolhaPcValidada[] = [];
  const semPc: ItemSemPc[] = [];

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
    //   valor(p)            = valor_item × fracao   (= valor_item × nf(p) / nf_do_item)
    //   custo_unitario      = valor(p) / kg_p        (= valor_item / conferida)
    // Soma fecha no valor do item independentemente de quantas submissoes houver.
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

    // Feature 017 (T023): escolha do PC do item que sera gravado, contra o detalhe
    // recalculado — fora da lista, sem escolha com PC possivel ou sem justificativa
    // exigida pela matriz (data-model §4) recusa a NF inteira, sem escrita.
    if (fluxoPc) {
      const info = interno.pcPorIndice.get(item.indice);
      if (info?.resultado) {
        const validada = validarEscolhaPc({
          notaFiscal: detalhe.notaFiscal,
          fornecedorNome: detalhe.fornecedorNome,
          itemDescricao: item.descricaoFornecedor,
          indice: item.indice,
          sequencias: info.entrada.sequencias,
          vinculos: info.entrada.vinculos,
          resultado: info.resultado,
          escolha: it.pc,
          quantidadeKg: quantidadeNfKg,
          precoNfKg: info.entrada.precoNfKg,
          kgPorSequencia: info.entrada.kgPorSequencia,
        });
        if (validada) escolhasPc.push(validada);
        else {
          semPc.push(itemSemPc(item, info.entrada, info.resultado));
        }
      }
    } else if (it.pc) {
      logger.info({ nf: detalhe.notaFiscal, indice: it.indice }, 'PC enviado para NF sem fiscal pelo Atlas — ignorado');
    }
  }

  // D27 + FR-011a (revisao de 22/10/2026, achado fila-v03): com o fiscal pelo Atlas a NF e
  // recebida por inteiro — o fiscal conclui TODOS os itens, e item a receber fora do POST seria
  // concluido sem avaliacao de PC (IGNORAR). A tela sempre manda todos (itemRecebivel); so uma
  // chamada direta com subconjunto cai aqui.
  if (fluxoPc) {
    const faltando = detalhe.itens.filter((d) => itemNfPendente(d) && d.conversao.ok && !d.baixaSolicitada && !indicesVistos.has(d.indice));
    if (faltando.length > 0) {
      throw new ValidacaoRecebimentoNacionalError(
        'NF_INCOMPLETA',
        `A NF ${detalhe.notaFiscal} é recebida por inteiro: informe também ${faltando.length === 1 ? 'o item' : 'os itens'} ` +
          `${faltando.map((d) => `"${d.descricaoFornecedor.trim()}"`).join(', ')}. Recarregue a nota e confira todos os itens.`,
      );
    }
  }

  if (preparados.length === 0) {
    const todosJaRecebidos = resultados.length > 0 && resultados.every((r) => r.status === 'ja_recebido');
    if (todosJaRecebidos) throw new NfNacionalJaProcessadaError(detalhe.notaFiscal);
    // So bloqueios: devolve o desfecho por produto (nao e erro da requisicao).
    // O fiscal NAO e disparado: nada sera recebido pelo Atlas (spec, edge case
    // "itens todos bloqueados por unidade") — a NF segue "fiscal pendente".
    return montarResultado(
      detalhe,
      resultados,
      fiscalSemAcao(`Nenhum item da NF ${detalhe.notaFiscal} pôde ser recebido; o recebimento fiscal não foi alterado.`),
    );
  }

  // ── Feature 017: estoque ja lancado pelo OMIE (D7, FR-021a) — chave em qualquer posicao ──
  if (detalhe.estoqueLancadoPeloOmie) throw new EstoqueJaLancadoPeloOmieError(detalhe.notaFiscal, detalhe.fornecedorNome);
  // FR-021a: sem a conclusao CONFIRMADA localmente (espelho ausente, defasado ou nao casado),
  // le o recebimento ao vivo antes de gravar.
  if (detalhe.fiscal === 'concluido' && !interno.espelhoConfirmaConclusao) await verificarEstoqueLancadoAoVivo(detalhe);

  // ── Feature 017: regras de PC do portao 1 (so com o fiscal pelo Atlas) ──
  let sequenciasSemVinculo: number[] = [];
  // Itens que o Atlas nao recebe (unidade) e sem PC no OMIE: o fiscal da NF inteira os
  // concluiria sem PC (IGNORAR) — so permitido no modo "receber sem vinculo" (FR-011a/FR-020).
  const semAvaliacao: ItemSemPc[] = fluxoPc
    ? detalhe.itensSemAvaliacaoPc.flatMap((x) => {
        const item = detalhe.itens.find((i) => i.indice === x.indice);
        const info = interno.pcPorIndice.get(x.indice);
        return item ? [{ item, motivo: 'unidade' as const, sequencias: info?.entrada.sequencias ?? item.sequenciasRecebimento, precoNfKg: null, pcsAguardando: [], pcsOutroCadastro: [] }] : [];
      })
    : [];
  if (fluxoPc) {
    // NF sem fornecedor cadastrado no OMIE (n_id_fornecedor 0, NF 1257): o fiscal da 016 a
    // recusa de qualquer jeito. Recusa ANTES das regras de PC, sem aviso a compras — o problema
    // e o cadastro, nao o PC (revisao de 22/10/2026, achados sugestao-v02/fila-v02).
    if (!detalhe.fornecedorCnpj || interno.fornecedorCodigo == null) throw new RecebimentoFiscalSemFornecedorError(detalhe.notaFiscal);
    // D13: copia de PCs defasada nao decide nada — nem NF_SEM_PC, nem aviso.
    if (detalhe.copiaPcsDefasada) throw new CopiaPcsDefasadaError();
    if (semPc.length > 0 || semAvaliacao.length > 0) {
      // FR-011a: vinculo do OMIE que nao serve, sem outro PC, e recusado nos dois modos.
      const vinculoInvalido = semPc.some((x) => x.motivo === 'vinculo_invalido');
      if (vinculoInvalido || exigePcHabilitado()) {
        if (semPc.length > 0) {
          const motivo: MotivoAvisoCompras = semPc.every((x) => x.motivo === 'pc_aguardando_aprovacao') ? 'pc_aguardando_aprovacao' : 'sem_pc';
          dispararAvisoCompras(detalhe, semPc, motivo, input.userId);
        }
        // Item de unidade nao e problema de compras (sem aviso): a mensagem orienta o fiscal.
        const recusados = [...semPc, ...(exigePcHabilitado() ? semAvaliacao : [])];
        throw new NfSemPcError(
          detalhe.notaFiscal,
          detalhe.fornecedorNome,
          recusados.map((x) => ({ descricao: x.item.descricaoFornecedor, motivo: x.motivo, pcsOutroCadastro: x.pcsOutroCadastro })),
        );
      }
      // Modo "receber sem vinculo": essas sequencias seguem a receita da 016 (EDITAR + IGNORAR).
      sequenciasSemVinculo = [...semPc, ...semAvaliacao].flatMap((x) => x.sequencias);
    }
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

  // ── Feature 016: recebimento FISCAL no OMIE, ANTES de qualquer escrita ──
  // Fiscal pendente + algo a gravar + flag ligada -> EDITAR -> IGNORAR -> Concluir.
  // Falha aqui propaga (RecebimentoFiscalError & cia.) sem nenhum INSERT (FR-008,
  // FR-012); `ja_concluido` e `concluido` seguem para o portao 2 (FR-011, FR-014).
  // Feature 016 (revisao pre-UAT, ROT-3): o gestor pode ter dispensado a NF depois
  // que este POST leu o detalhe — confere de novo antes de escrever no OMIE/estoque.
  // A dispensa vale com a chave em qualquer posicao (achado fila-v01).
  await garantirNaoDispensada(detalhe);
  const fiscal = await executarFiscalSeNecessario(detalhe, input.userId, { interno, escolhas: escolhasPc, sequenciasSemVinculo });
  // Feature 017 (D6): modo "receber sem vinculo" — compras e avisado depois que o fiscal concluiu
  // (tambem em ja_concluido: o Concluir de uma tentativa anterior pode ter passado sem resposta).
  if ((fiscal.status === 'concluido' || fiscal.status === 'ja_concluido') && fiscal.semVinculo.length > 0) {
    const semVinc = new Set(fiscal.semVinculo);
    const recebidosSemPc = [...semPc, ...semAvaliacao].filter((x) => x.sequencias.some((sq) => semVinc.has(sq)));
    if (recebidosSemPc.length > 0) {
      dispararAvisoCompras(detalhe, recebidosSemPc, 'recebida_sem_vinculo', input.userId);
      fiscal.avisoCompras = true;
    }
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
            // ACXEGDP-412: identidade do item que sobrevive a troca de descricao no fiscal.
            nfItemSequencias: pp.item.sequenciasRecebimento.length > 0 ? pp.item.sequenciasRecebimento : null,
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

  // Historia 3 (FR-007): a escolha do operador vira memoria — SO para o que foi
  // gravado, e best-effort: falhar aqui nao desfaz recebimento nenhum.
  for (const c of criados) {
    try {
      await registrarUsoCorrelacao({
        fornecedorCnpj: detalhe.fornecedorCnpj,
        fornecedorNome: detalhe.fornecedorNome,
        descricaoNf: c.item.descricaoFornecedor,
        produtoCodigoQ2p: c.input.produtoCodigoQ2p,
        produtoDescricao: c.produtoDescricao,
        userId: input.userId,
      });
    } catch (err) {
      logger.warn({ err, nf: detalhe.notaFiscal, produto: c.produtoDescricao }, 'Não foi possível memorizar a correlação fornecedor→produto');
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
    { nf: detalhe.notaFiscal, chave: detalhe.nfChaveAcesso, criados: criados.length, total: resultados.length, userId: input.userId, fiscal: fiscal.status },
    'Recebimento nacional por NF processado',
  );
  return montarResultado(detalhe, resultados, fiscal);
}

async function garantirNaoDispensada(detalhe: DetalheNfNacional): Promise<void> {
  const r = await getPool().query<{ dispensado_em: string }>(
    `SELECT dispensado_em::text AS dispensado_em FROM stockbridge.nf_dispensa
      WHERE nf_chave_acesso = $1 AND revertido_em IS NULL LIMIT 1`,
    [detalhe.nfChaveAcesso],
  );
  const d = r.rows[0];
  if (!d) return;
  const quando = new Date(d.dispensado_em);
  const data = Number.isNaN(quando.getTime()) ? d.dispensado_em : quando.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  throw new NfNacionalDispensadaError(detalhe.notaFiscal, data);
}

/** Desfecho fiscal quando o Atlas NAO age: flag desligada (015) ou nada a fazer. */
function fiscalSemAcao(mensagemNaoAplicavel: string): FiscalPorNfResult {
  if (!recebimentoFiscalHabilitado()) {
    return {
      status: 'desligado',
      concluidoEm: null,
      mensagem: 'O recebimento fiscal pelo Atlas está desligado neste ambiente — o fiscal segue sendo concluído no OMIE.',
      vinculos: [],
      semVinculo: [],
      avisoCompras: false,
    };
  }
  return { status: 'nao_aplicavel', concluidoEm: null, mensagem: mensagemNaoAplicavel, vinculos: [], semVinculo: [], avisoCompras: false };
}

/**
 * Feature 017 (research D7, FR-021a): NF "fiscal ja feito" cuja conclusao o espelho de
 * recebimentos nao confirma (NF ausente, linha defasada com c_recebido='N' ou nao casada,
 * e sem fiscal concluido pelo Atlas no ledger) — le o recebimento AO VIVO uma vez antes de gravar.
 * EXCECAO AO PRINCIPIO II (specs/007-stockbridge-module/research.md secao 2,
 * ACXEGDP-437): sem essa leitura o Atlas nao sabe se o OMIE ja lancou o estoque
 * no recebimento fiscal, e receber aqui lancaria em dobro (SC-009). Recebimento
 * inexistente no OMIE = nada foi lancado por ele.
 */
const RE_RECEBIMENTO_INEXISTENTE = /n[ãa]o (foi |foram )?(encontrad|localizad|cadastrad)|n[ãa]o exist|inexistent/i;

async function verificarEstoqueLancadoAoVivo(detalhe: DetalheNfNacional): Promise<void> {
  let rec;
  try {
    rec = await consultarRecebimentoNfe('q2p', { cChaveNfe: detalhe.nfChaveAcesso });
  } catch (err) {
    const msg = (err as Error)?.message ?? '';
    if (RE_RECEBIMENTO_INEXISTENTE.test(msg)) {
      logger.info({ nf: detalhe.notaFiscal }, 'NF sem recebimento de NF-e no OMIE — nenhum estoque lançado por ele');
      return;
    }
    logger.error({ err, nf: detalhe.notaFiscal, chave: detalhe.nfChaveAcesso }, 'Leitura ao vivo do recebimento (estoque já lançado?) falhou');
    throw new VerificacaoEstoqueOmieError(detalhe.notaFiscal, { cause: err });
  }
  if (estoqueLancadoNoRecebimento(rec)) {
    logger.warn({ nf: detalhe.notaFiscal }, 'Recebimento concluído fora do Atlas com movimento de estoque — físico bloqueado');
    throw new EstoqueJaLancadoPeloOmieError(detalhe.notaFiscal, detalhe.fornecedorNome);
  }
}

/** Aviso a compras (D6) — best-effort, nunca segura a resposta. */
function dispararAvisoCompras(detalhe: DetalheNfNacional, itens: ItemSemPc[], motivo: MotivoAvisoCompras, userId: string): void {
  void enviarAvisoComprasNfSemPc(argsAvisoCompras(detalhe, itens, motivo, userId)).catch((err) =>
    logger.error({ err, nf: detalhe.notaFiscal }, 'Falha no aviso a compras'),
  );
}

/** Item sem PC possivel no portao 1 (ou nao avaliavel, motivo 'unidade') — entrada do aviso a compras. */
interface ItemSemPc {
  item: ItemNfNacional;
  motivo: MotivoSemPc;
  sequencias: number[];
  precoNfKg: number | null;
  pcsAguardando: string[];
  /** PCs da mesma empresa lancados em outro cadastro do OMIE (filial x matriz) — so citados */
  pcsOutroCadastro: PcOutroCadastro[];
}

function itemSemPc(item: ItemNfNacional, entrada: ItemParaSugestao, resultado: ResultadoPcItem): ItemSemPc {
  return {
    item,
    motivo: resultado.motivoSemPc ?? 'sem_pc',
    sequencias: entrada.sequencias,
    precoNfKg: entrada.precoNfKg,
    pcsAguardando: resultado.pc.aguardandoAprovacao.map((c) => c.pcNumero).filter((n) => n.length > 0),
    pcsOutroCadastro: resultado.pcsOutroCadastro,
  };
}

function argsAvisoCompras(
  detalhe: DetalheNfNacional,
  itens: ItemSemPc[],
  motivo: MotivoAvisoCompras,
  userId: string,
): Parameters<typeof enviarAvisoComprasNfSemPc>[0] {
  return {
    empresa: detalhe.empresa,
    nfChaveAcesso: detalhe.nfChaveAcesso,
    notaFiscal: detalhe.notaFiscal,
    fornecedorNome: detalhe.fornecedorNome,
    itens: itens.map((x) => ({
      nSequencia: x.sequencias[0] ?? null,
      descricao: x.item.descricaoFornecedor,
      qtdKg: x.item.quantidadeNfKg,
      precoUnit: x.precoNfKg,
      // item de unidade nao convertida: a quantidade nativa da NF, nunca "0 kg"
      quantidadeTexto:
        x.item.quantidadeNfKg == null ? `${x.item.quantidadeNf.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${x.item.unidadeOriginal}`.trim() : null,
    })),
    pcsAguardandoAprovacao: Array.from(new Set(itens.flatMap((x) => x.pcsAguardando))),
    pcsOutroCadastro: itens.flatMap((x) =>
      x.pcsOutroCadastro.map((p) => ({ itemDescricao: x.item.descricaoFornecedor, pcNumero: p.pcNumero, cnpjCadastroPc: p.cnpjCadastroPc })),
    ),
    cnpjNf: detalhe.fornecedorCnpj.replace(/\D/g, '') || null,
    motivo,
    disparadoPor: userId,
  };
}

/** "vinculado ao PC 304" / "vinculado aos PCs 304 e 305" — so o numero legivel (ACXEGDP-313). */
function textoVinculos(vinculos: VinculoFiscalConcluido[]): string {
  const nums = Array.from(new Set(vinculos.map((v) => v.pcNumero).filter((n) => n.length > 0)));
  if (nums.length === 0) return vinculos.length > 0 ? ', com os itens vinculados aos pedidos de compra' : '';
  if (nums.length === 1) return `, vinculado ao PC ${nums[0]}`;
  return `, vinculado aos PCs ${nums.slice(0, -1).join(', ')} e ${nums[nums.length - 1]}`;
}

/**
 * Feature 016 (research D10): o fiscal so roda com a flag ligada, com a NF
 * "fiscal pendente" na fila e com ao menos um produto preparado para gravar
 * (quem chama ja garantiu isto). Erros propagam — nada foi escrito ainda.
 */
async function executarFiscalSeNecessario(
  detalhe: DetalheNfNacional,
  userId: string,
  pc: { interno: DetalheNfNacionalInterno; escolhas: EscolhaPcValidada[]; sequenciasSemVinculo: number[] },
): Promise<FiscalPorNfResult> {
  if (!recebimentoFiscalHabilitado() || detalhe.fiscal !== 'pendente') {
    return fiscalSemAcao(`O recebimento fiscal da NF ${detalhe.notaFiscal} já estava concluído no OMIE.`);
  }
  // Fornecedor nao cadastrado no OMIE: o espelho ja sabe (sem CNPJ). Recusa aqui,
  // sem abrir o ledger nem consultar o OMIE (revisao pre-UAT, FISC-1/NF 1257).
  if (!detalhe.fornecedorCnpj) throw new RecebimentoFiscalSemFornecedorError(detalhe.notaFiscal);
  // Feature 017 (T030): a releitura/reserva dos PCs roda DENTRO de concluirRecebimentoFiscal,
  // depois da trava da NF (precisa do id do ledger) e da ConsultarRecebimento (NF ja concluida
  // nao rele o PC — achado fiscal-02), antes de qualquer escrita.
  const r = await concluirRecebimentoFiscal({
    nfChaveAcesso: detalhe.nfChaveAcesso,
    nIdReceb: detalhe.nIdReceb,
    notaFiscal: detalhe.notaFiscal,
    fornecedorNome: detalhe.fornecedorNome,
    userId,
    empresa: detalhe.empresa,
    fornecedorCodigo: pc.interno.fornecedorCodigo,
    vinculos: pc.escolhas,
    sequenciasSemVinculo: pc.sequenciasSemVinculo,
  });
  const rotulo = `NF ${detalhe.notaFiscal} (${detalhe.fornecedorNome})`;
  const comum = { vinculos: r.vinculos, semVinculo: r.semVinculo, avisoCompras: false };
  return r.status === 'concluido'
    ? { status: 'concluido', concluidoEm: r.concluidoEm, mensagem: `Recebimento fiscal da ${rotulo} concluído no OMIE${textoVinculos(r.vinculos)}.`, ...comum }
    : {
        status: 'ja_concluido',
        concluidoEm: r.concluidoEm,
        mensagem: `O recebimento fiscal da ${rotulo} já estava concluído no OMIE${textoVinculos(r.vinculos)} — nada a fazer.`,
        ...comum,
      };
}

function montarResultado(detalhe: DetalheNfNacional, produtos: ProdutoPorNfResult[], fiscal: FiscalPorNfResult): ProcessarRecebimentoPorNfResult {
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
    fiscal,
  };
}

// ── Feature 017 — aviso a compras sem o formulario (achado A1 da revisao de UI) ──

/** 422 AVISO_COMPRAS_NAO_APLICAVEL: a nota nao esta aguardando pedido de compra. */
export class AvisoComprasNaoAplicavelError extends Error {
  constructor(public readonly notaFiscal: string, motivo: string) {
    super(`Não há aviso a enviar para a NF ${notaFiscal}: ${motivo}.`);
    this.name = 'AvisoComprasNaoAplicavelError';
  }
}

export interface AvisoComprasResult {
  status: 'enviado' | 'deduplicado' | 'falha';
  motivo: MotivoAvisoCompras;
  /** descricoes dos itens sem PC citados no aviso */
  itens: string[];
  /** pt-BR, para a tela */
  mensagem: string;
}

/**
 * Feature 017 (research D6, US3.2): avisa a equipe de Compras que a NF esta aguardando
 * pedido de compra SEM exigir o formulario do recebimento — antes o aviso so saia no POST
 * por-nf, que valida produto, estoque e peso de todos os itens antes de chegar ao NF_SEM_PC
 * (achado A1 da revisao de UI de 21/10/2026). Mesma regra do portao 1: chave da 016 ligada,
 * fiscal pendente, copia de PCs em dia, item a receber sem PC possivel e modo bloquear (ou
 * vinculo do OMIE que nao serve, nos dois modos). Deduplicado por NF, motivo e destinatario em 24 h.
 */
export async function avisarComprasNfSemPc(input: { nfChaveAcesso: string; userId: string }): Promise<AvisoComprasResult> {
  const { detalhe, interno } = await montarDetalheNfNacional(input.nfChaveAcesso);
  if (!recebimentoFiscalHabilitado() || detalhe.fiscal !== 'pendente') {
    throw new AvisoComprasNaoAplicavelError(detalhe.notaFiscal, 'o recebimento fiscal desta nota não é feito pelo Atlas');
  }
  if (!detalhe.fornecedorCnpj || interno.fornecedorCodigo == null) {
    throw new AvisoComprasNaoAplicavelError(detalhe.notaFiscal, 'o fornecedor da nota não está cadastrado no OMIE (peça ao fiscal para cadastrá-lo)');
  }
  if (detalhe.copiaPcsDefasada) throw new CopiaPcsDefasadaError();
  const semPc: ItemSemPc[] = [];
  for (const it of detalhe.itens) {
    // So itens que este recebimento gravaria: pendentes e com unidade convertida.
    if (!itemNfPendente(it) || !it.conversao.ok) continue;
    const info = interno.pcPorIndice.get(it.indice);
    const r = info?.resultado;
    if (!info || !r || r.possivel) continue;
    semPc.push(itemSemPc(it, info.entrada, r));
  }
  const bloqueia = semPc.length > 0 && (exigePcHabilitado() || semPc.some((x) => x.motivo === 'vinculo_invalido'));
  if (!bloqueia) throw new AvisoComprasNaoAplicavelError(detalhe.notaFiscal, 'ela não está aguardando pedido de compra');
  const motivo: MotivoAvisoCompras = semPc.every((x) => x.motivo === 'pc_aguardando_aprovacao') ? 'pc_aguardando_aprovacao' : 'sem_pc';
  const status = await enviarAvisoComprasNfSemPc(argsAvisoCompras(detalhe, semPc, motivo, input.userId));
  const mensagem =
    status === 'enviado'
      ? `A equipe de Compras foi avisada de que a NF ${detalhe.notaFiscal} está aguardando pedido de compra.`
      : status === 'deduplicado'
        ? `A equipe de Compras já foi avisada desta NF nas últimas 24 horas.`
        : `Não foi possível avisar a equipe de Compras agora. Tente de novo em instantes.`;
  logger.info({ nf: detalhe.notaFiscal, motivo, status, userId: input.userId }, 'Aviso a compras pedido pela tela (NF aguardando PC)');
  return { status, motivo, itens: semPc.map((x) => x.item.descricaoFornecedor), mensagem };
}
