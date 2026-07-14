import { getPool, createLogger, cached } from '@atlas/core';

const logger = createLogger('stockbridge:conferencia');

/**
 * Conferência de Estoque ACXE × Q2P.
 *
 * Substitui a planilha Excel que cruza a posição física das duas empresas por
 * local/produto e classifica cada linha em `Status Geral`. Lê DIRETO as tabelas
 * OMIE `tbl_posicaoEstoque_*` (NÃO a view `vw_posicaoEstoqueUnificada`, que filtra
 * `fisico >= 0` e descartaria os negativos). O mapa De→Para de locais
 * (ESPELHADO/INDIVIDUAL) vem de `stockbridge.conferencia_local_map`.
 *
 * O SQL faz o pivot/soma por (codigo do local, descrição, tipo, produto
 * normalizado); a engine de `Status Geral` roda em TS (testável — garante
 * paridade 100% com a planilha). Vide specs/011-conferencia-estoque.
 */

export type TipoLocal = 'ESPELHADO' | 'INDIVIDUAL';
export type StatusSaldoNegativo = 'ACXE e Q2P negativos' | 'ACXE negativo' | 'Q2P negativo' | 'OK';
export type StatusGeral = 'Divergente e Negativo' | 'Divergente' | 'Negativo' | 'OK';

export interface ConferenciaItem {
  codigoEstoque: string;
  nomeEstoque: string;
  tipoEstoque: TipoLocal;
  produto: string;
  saldoAcxeKg: number;
  saldoQ2pKg: number;
  diferencaKg: number;
  statusSaldoNegativo: StatusSaldoNegativo;
  statusGeral: StatusGeral;
}

export interface ConferenciaResumo {
  totalSkusDivergentes: number; // statusGeral em {Divergente, Divergente e Negativo}
  totalProblemas: number; // statusGeral != OK  (== contagem do badge)
  totalQuebrasNegativas: number; // statusSaldoNegativo != OK
  somaDiferencaKg: number; // pode ser negativa
  dataPosicaoAcxe: string | null;
  dataPosicaoQ2p: string | null;
  defasagemEntreEmpresas: boolean;
}

export interface ConferenciaResponse {
  resumo: ConferenciaResumo;
  itens: ConferenciaItem[];
}

export interface ConferenciaContagem {
  contagem: number;
  porStatus: {
    divergenteENegativo: number;
    divergente: number;
    negativo: number;
  };
  dataPosicaoAcxe: string | null;
  dataPosicaoQ2p: string | null;
  defasagemEntreEmpresas: boolean;
}

export interface ConferenciaFiltros {
  status?: 'divergente' | 'negativo' | 'problemas' | 'ok';
  tipo?: TipoLocal;
  codigoEstoque?: string;
  busca?: string;
}

/** Prefixos de SKU ignorados na conferência (idêntico à planilha — Etapa 1). */
export const CONFERENCIA_BLACKLIST = ['CONS_', 'PRD00001', 'SUC-', 'STRETCH'] as const;

// ───────────────────────── Engine pura (testável) ─────────────────────────

/** Classifica o saldo negativo de um par (FR-006). */
export function statusSaldoNegativo(saldoAcxe: number, saldoQ2p: number): StatusSaldoNegativo {
  if (saldoAcxe < 0 && saldoQ2p < 0) return 'ACXE e Q2P negativos';
  if (saldoAcxe < 0) return 'ACXE negativo';
  if (saldoQ2p < 0) return 'Q2P negativo';
  return 'OK';
}

/**
 * Calcula o Status Geral na ORDEM EXATA de prioridade (FR-007).
 * Locais INDIVIDUAL nunca são Divergente (FR-008).
 */
export function statusGeral(
  tipo: TipoLocal,
  diferenca: number,
  saldoNeg: StatusSaldoNegativo,
): StatusGeral {
  const espelhado = tipo === 'ESPELHADO';
  if (espelhado && diferenca !== 0 && saldoNeg !== 'OK') return 'Divergente e Negativo';
  if (espelhado && diferenca !== 0) return 'Divergente';
  if (saldoNeg !== 'OK') return 'Negativo';
  return 'OK';
}

/** Peso de severidade — problemas no topo (FR-011). */
export function pesoStatusGeral(s: StatusGeral): number {
  switch (s) {
    case 'Divergente e Negativo':
      return 3;
    case 'Divergente':
      return 2;
    case 'Negativo':
      return 1;
    default:
      return 0;
  }
}

/** Linha crua do pivot SQL, antes da engine. */
export interface LinhaPivot {
  codigoEstoque: string;
  nomeEstoque: string;
  tipoEstoque: TipoLocal;
  produto: string;
  saldoAcxeKg: number;
  saldoQ2pKg: number;
}

/** Aplica diferença + saldo negativo + status geral a uma linha pivotada. */
export function classificarLinha(l: LinhaPivot): ConferenciaItem {
  const diferencaKg = l.saldoAcxeKg - l.saldoQ2pKg;
  const sNeg = statusSaldoNegativo(l.saldoAcxeKg, l.saldoQ2pKg);
  return {
    ...l,
    diferencaKg,
    statusSaldoNegativo: sNeg,
    statusGeral: statusGeral(l.tipoEstoque, diferencaKg, sNeg),
  };
}

/** Comparador de ordenação: severidade desc, depois tipo/local/produto asc (FR-011). */
export function compararItens(a: ConferenciaItem, b: ConferenciaItem): number {
  const peso = pesoStatusGeral(b.statusGeral) - pesoStatusGeral(a.statusGeral);
  if (peso !== 0) return peso;
  return (
    a.tipoEstoque.localeCompare(b.tipoEstoque) ||
    a.nomeEstoque.localeCompare(b.nomeEstoque, 'pt-BR') ||
    a.produto.localeCompare(b.produto, 'pt-BR')
  );
}

/** Monta o resumo (KPIs) sobre o universo COMPLETO de itens. */
export function montarResumo(
  itens: ConferenciaItem[],
  dataPosicaoAcxe: string | null,
  dataPosicaoQ2p: string | null,
): ConferenciaResumo {
  let totalSkusDivergentes = 0;
  let totalProblemas = 0;
  let totalQuebrasNegativas = 0;
  let somaDiferencaKg = 0;
  for (const i of itens) {
    if (i.statusGeral !== 'OK') totalProblemas += 1;
    if (i.statusGeral === 'Divergente' || i.statusGeral === 'Divergente e Negativo')
      totalSkusDivergentes += 1;
    if (i.statusSaldoNegativo !== 'OK') totalQuebrasNegativas += 1;
    somaDiferencaKg += i.diferencaKg;
  }
  return {
    totalSkusDivergentes,
    totalProblemas,
    totalQuebrasNegativas,
    somaDiferencaKg,
    dataPosicaoAcxe,
    dataPosicaoQ2p,
    defasagemEntreEmpresas: dataPosicaoAcxe !== dataPosicaoQ2p,
  };
}

/** Aplica os filtros opcionais a uma lista já classificada (US3). */
export function aplicarFiltros(itens: ConferenciaItem[], f: ConferenciaFiltros): ConferenciaItem[] {
  let out = itens;
  if (f.status === 'problemas') out = out.filter((i) => i.statusGeral !== 'OK');
  else if (f.status === 'ok') out = out.filter((i) => i.statusGeral === 'OK');
  else if (f.status === 'divergente')
    out = out.filter(
      (i) => i.statusGeral === 'Divergente' || i.statusGeral === 'Divergente e Negativo',
    );
  else if (f.status === 'negativo') out = out.filter((i) => i.statusSaldoNegativo !== 'OK');
  if (f.tipo) out = out.filter((i) => i.tipoEstoque === f.tipo);
  if (f.codigoEstoque) out = out.filter((i) => i.codigoEstoque === f.codigoEstoque);
  if (f.busca) {
    const q = f.busca.trim().toUpperCase();
    out = out.filter(
      (i) => i.produto.includes(q) || i.nomeEstoque.toUpperCase().includes(q),
    );
  }
  return out;
}

// ───────────────────────── Acesso a dados ─────────────────────────

/** Predicado de blacklist em SQL (NOT LIKE com ESCAPE para o `_` de CONS_). */
function blacklistPredicate(col: string): string {
  return CONFERENCIA_BLACKLIST.map((prefix) => {
    const escaped = prefix.replace(/\\/g, '\\\\').replace(/_/g, '\\_').replace(/%/g, '\\%');
    return `${col} NOT LIKE '${escaped}%' ESCAPE '\\'`;
  }).join(' AND ');
}

interface RawPivotRow {
  codigo_estoque: string;
  nome_estoque: string;
  tipo_estoque: TipoLocal;
  produto: string;
  saldo_acxe: string | null; // bigint volta como string no driver
  saldo_q2p: string | null;
}

/**
 * Roda a agregação (pivot por empresa) sobre a posição mais recente de cada
 * empresa e devolve os itens já classificados + ordenados + as datas.
 * Núcleo compartilhado pela lista e pela contagem do badge.
 */
async function buscarConferencia(): Promise<{
  itens: ConferenciaItem[];
  dataPosicaoAcxe: string | null;
  dataPosicaoQ2p: string | null;
}> {
  const pool = getPool();

  // Datas de referência (última posição por empresa) — robusto a sync atrasado.
  const datasRes = await pool.query<{ d_acxe: string | null; d_q2p: string | null }>(
    `SELECT (SELECT MAX(ddataposicao) FROM public."tbl_posicaoEstoque_ACXE")::text AS d_acxe,
            (SELECT MAX(ddataposicao) FROM public."tbl_posicaoEstoque_Q2P")::text  AS d_q2p`,
  );
  const dataPosicaoAcxe = datasRes.rows[0]?.d_acxe ?? null;
  const dataPosicaoQ2p = datasRes.rows[0]?.d_q2p ?? null;

  const blAcxe = blacklistPredicate('p.ccodigo');

  const sql = `
    WITH base AS (
      SELECT m.codigo, m.descricao AS descricao_local, m.tipo, m.empresa,
             TRIM(UPPER(p.cdescricao)) AS produto, p.fisico
        FROM public."tbl_posicaoEstoque_ACXE" p
        JOIN stockbridge.conferencia_local_map m
          ON m.codigo_local_estoque = p.codigo_local_estoque
         AND m.empresa = 'ACXE' AND m.ativo = true
       WHERE p.ddataposicao = $1::date AND ${blAcxe}
      UNION ALL
      SELECT m.codigo, m.descricao, m.tipo, m.empresa,
             TRIM(UPPER(p.cdescricao)), p.fisico
        FROM public."tbl_posicaoEstoque_Q2P" p
        JOIN stockbridge.conferencia_local_map m
          ON m.codigo_local_estoque = p.codigo_local_estoque
         AND m.empresa = 'Q2P' AND m.ativo = true
       WHERE p.ddataposicao = $2::date AND ${blAcxe}
    )
    SELECT codigo                                                        AS codigo_estoque,
           MAX(descricao_local)                                          AS nome_estoque,
           tipo                                                          AS tipo_estoque,
           produto,
           COALESCE(SUM(fisico) FILTER (WHERE empresa = 'ACXE'), 0)::bigint AS saldo_acxe,
           COALESCE(SUM(fisico) FILTER (WHERE empresa = 'Q2P'),  0)::bigint AS saldo_q2p
      FROM base
     GROUP BY codigo, tipo, produto
  `;

  const res = await pool.query<RawPivotRow>(sql, [dataPosicaoAcxe, dataPosicaoQ2p]);

  const itens = res.rows
    .map((r) =>
      classificarLinha({
        codigoEstoque: r.codigo_estoque,
        nomeEstoque: r.nome_estoque,
        tipoEstoque: r.tipo_estoque,
        produto: r.produto,
        saldoAcxeKg: Number(r.saldo_acxe ?? 0),
        saldoQ2pKg: Number(r.saldo_q2p ?? 0),
      }),
    )
    .sort(compararItens);

  return { itens, dataPosicaoAcxe, dataPosicaoQ2p };
}

/** Lista a conferência (resumo do universo completo + itens filtrados). */
export async function listarConferencia(
  filtros: ConferenciaFiltros = {},
): Promise<ConferenciaResponse> {
  try {
    const { itens, dataPosicaoAcxe, dataPosicaoQ2p } = await buscarConferencia();
    const resumo = montarResumo(itens, dataPosicaoAcxe, dataPosicaoQ2p);
    return { resumo, itens: aplicarFiltros(itens, filtros) };
  } catch (err) {
    logger.error({ err }, 'Falha ao montar conferência de estoque');
    throw err instanceof Error ? err : new Error('Falha ao montar a conferência de estoque — tente novamente; se persistir, contate o admin');
  }
}

/** TTL do badge: a posição só muda no sync diário — 5 min de staleness é irrelevante. */
const BADGE_CACHE_TTL_S = 300;
const BADGE_CACHE_KEY = 'stockbridge:conferencia:badge';

/**
 * Contagem para o badge: itens com Status Geral != OK (D7).
 *
 * STK-14 (ACXEGDP-290): cacheada em Redis (TTL 5 min). Sem o cache, o polling
 * de 30s por gestor (App.tsx) recomputava a agregação completa (UNION ALL das
 * posições ACXE/Q2P + classificação/sort de todas as linhas em TS) a cada
 * tick, para devolver 3 contadores de um snapshot que muda 1x/dia.
 */
export async function contarConferencia(): Promise<ConferenciaContagem> {
  try {
    const { data } = await cached(BADGE_CACHE_KEY, BADGE_CACHE_TTL_S, async () => {
      const { itens, dataPosicaoAcxe, dataPosicaoQ2p } = await buscarConferencia();
      const porStatus = { divergenteENegativo: 0, divergente: 0, negativo: 0 };
      for (const i of itens) {
        if (i.statusGeral === 'Divergente e Negativo') porStatus.divergenteENegativo += 1;
        else if (i.statusGeral === 'Divergente') porStatus.divergente += 1;
        else if (i.statusGeral === 'Negativo') porStatus.negativo += 1;
      }
      return {
        contagem: porStatus.divergenteENegativo + porStatus.divergente + porStatus.negativo,
        porStatus,
        dataPosicaoAcxe,
        dataPosicaoQ2p,
        defasagemEntreEmpresas: dataPosicaoAcxe !== dataPosicaoQ2p,
      };
    });
    return data;
  } catch (err) {
    logger.error({ err }, 'Falha ao contar divergências da conferência');
    throw err instanceof Error ? err : new Error('Falha ao montar a conferência de estoque — tente novamente; se persistir, contate o admin');
  }
}
