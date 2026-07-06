import { sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { getDb, getPool, createLogger } from '@atlas/core';
import { movimentacao, aprovacao } from '@atlas/db';
import { converterParaKg } from './motor.service.js';
import { enviarAlertaRecebimentoNacionalLote } from './notificacao.service.js';
import type { UnidadeMedida, SubtipoMovimento } from '../types.js';

const logger = createLogger('stockbridge:recebimento-nacional');

export class LocalidadeNaoElegivelError extends Error {
  constructor(public readonly localidadeId: string, motivo: string) {
    super(`Localidade ${localidadeId} não elegivel para recebimento nacional: ${motivo}`);
    this.name = 'LocalidadeNaoElegivelError';
  }
}

export class ProdutoNaoEncontradoError extends Error {
  constructor(public readonly codigoProdutoAcxe: number) {
    super(`Produto ${codigoProdutoAcxe} não encontrado em tbl_produtos_ACXE`);
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
  /** Valor total do item na NF em BRL — usado para calcular custo unitario por kg. */
  valorTotalNfBrl: number;
}

export interface ProcessarRecebimentoNacionalInput {
  /** Numero da NF — referencia, vai pra observacao do ajuste OMIE. */
  notaFiscal: string;
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
  if (!input.itens || input.itens.length === 0) {
    throw new Error('Recebimento precisa de pelo menos 1 item');
  }

  // Valida cada item antes de tocar o banco
  for (const it of input.itens) {
    const codigoProduto = it.empresa === 'acxe' ? it.produtoCodigoAcxe : it.produtoCodigoQ2p;
    if (!Number.isFinite(codigoProduto) || (codigoProduto ?? 0) <= 0) {
      throw new Error(`Item inválido: código de produto deve ser número positivo para empresa ${it.empresa}`);
    }
    if (!Number.isFinite(it.quantidade) || it.quantidade <= 0) {
      throw new Error(`Item (${it.empresa} cod ${codigoProduto}): quantidade deve ser positiva`);
    }
  }

  const db = getDb();
  const nfNorm = input.notaFiscal.trim();
  const obsBase = input.observacoes?.trim() ?? '';

  const localidadesById = await resolverLocalidadesParaItens(input.itens);
  const produtosByCodigo = await resolverProdutosNacionais(input.itens);

  const itensProcessados = await db.transaction(async (tx) => {
    const out: ItemRecebimentoNacionalResult[] = [];
    for (const it of input.itens) {
      const loc = localidadesById.get(it.localidadeId);
      if (!loc) {
        throw new LocalidadeNaoElegivelError(
          it.localidadeId,
          'não encontrada ou e espelhada (ACXE+Q2P) — nacional não aceita espelhados',
        );
      }
      if (loc.empresa !== it.empresa) {
        throw new LocalidadeNaoElegivelError(
          it.localidadeId,
          `empresa do item (${it.empresa}) não bate com empresa da localidade (${loc.empresa})`,
        );
      }
      const codigoProduto = it.empresa === 'acxe' ? it.produtoCodigoAcxe! : it.produtoCodigoQ2p!;
      const chaveDescricao = `${it.empresa}:${codigoProduto}`;
      const prod = produtosByCodigo.get(chaveDescricao);
      if (!prod) {
        throw new ProdutoNaoEncontradoError(codigoProduto);
      }

      const quantidadeKg = Number(
        new Decimal(converterParaKg(it.quantidade, it.unidade)).toFixed(3),
      );
      if (quantidadeKg <= 0) {
        throw new Error(`Item ${it.empresa} cod ${codigoProduto}: quantidade em Kg <= 0`);
      }

      const custoUnitarioBrl = Number(
        new Decimal(it.valorTotalNfBrl).dividedBy(quantidadeKg).toFixed(6),
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
  itens: ItemRecebimentoNacionalInput[],
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
  itens: ItemRecebimentoNacionalInput[],
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
