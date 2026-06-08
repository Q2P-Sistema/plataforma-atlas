import { getPool, createLogger } from '@atlas/core';

const logger = createLogger('stockbridge:cmc');

/**
 * Visão de CMC (Custo Médio Contábil ponderado) por família e produto.
 *
 * Fonte: public."tbl_historico_cmc_estoque" (banco acxe_q2p) — snapshot diário
 * populado pelo workflow n8n legado (spec 002-historico-cmc-estoque). Atlas só
 * LÊ (sem migration, sem escrita, sem audit — feature read-only). Ver
 * specs/008-stockbridge-cmc-view/{plan,research}.md.
 *
 * Unidades: a fonte já está em kg (volume_total) e R$/kg (media_cmc_ponderada)
 * — NÃO converter toneladas aqui (diferente das outras telas do StockBridge).
 */

export type CmcOrigem = 'IMPORTADO' | 'NACIONAL';

/** Rótulo do grupo para produtos sem descricao_familia (FR-006). */
export const SEM_FAMILIA = 'Sem família';

export interface CmcFiltros {
  /** Data do snapshot (ISO). Default: o mais recente disponível. */
  data?: string;
  /** descricao_familia exata (inclui 'Sem família'); vazio = todas. */
  familias?: string[];
  /** codigo_produto; vazio = todos. */
  produtos?: string[];
  /** origem; undefined = ambas. */
  origem?: CmcOrigem;
}

export interface CmcResumo {
  /** Quantidade total em estoque (kg), respeitando filtros. */
  volumeTotalKg: number;
  /** Valor total imobilizado (R$), respeitando filtros. */
  valorTotal: number;
  // Sem "CMC global" — não é métrica agregada significativa (FR-018).
}

export interface CmcProdutoNode {
  codigoProduto: string;
  descricaoProduto: string;
  origem: CmcOrigem;
  /** R$/kg; null quando volume = 0 (FR-008). */
  cmcPonderado: number | null;
  volumeKg: number;
  valor: number;
}

export interface CmcOrigemAgg {
  cmcPonderado: number | null;
  volumeKg: number;
  valor: number;
}

export interface CmcFamiliaNode {
  descricaoFamilia: string;
  /** Ponderado por volume: SUM(valor)/SUM(volume) (FR-003). */
  cmcPonderado: number | null;
  volumeKg: number;
  valor: number;
  porOrigem: { importado: CmcOrigemAgg; nacional: CmcOrigemAgg };
  produtos: CmcProdutoNode[];
}

export interface CmcSnapshotResponse {
  /** Data ISO do snapshot exibido. null se não há dado algum. */
  dataSnapshot: string | null;
  /** true quando o snapshot mais recente não é do dia corrente (FR-007). */
  defasado: boolean;
  resumo: CmcResumo;
  familias: CmcFamiliaNode[];
}

// CMC ponderado = Σvalor / Σvolume; null quando volume 0 (evita divisão por zero).
function ponderado(valor: number, volume: number): number | null {
  return volume > 0 ? valor / volume : null;
}

interface LeafRow {
  codigo_produto: string;
  descricao_produto: string | null;
  familia: string;
  origem: string;
  volume_total: string | null; // numeric → string no node-postgres
  valor_total_cmc: string | null;
}

/**
 * Monta os filtros parametrizados compartilhados (família/produto/origem) a
 * partir de `$startIdx`. A data é tratada à parte (sempre $1).
 */
function buildFiltrosSql(
  filtros: CmcFiltros,
  params: unknown[],
): string {
  const clauses: string[] = [];

  if (filtros.familias && filtros.familias.length > 0) {
    params.push(filtros.familias);
    clauses.push(
      `COALESCE(NULLIF(descricao_familia, ''), '${SEM_FAMILIA}') = ANY($${params.length}::text[])`,
    );
  }
  if (filtros.produtos && filtros.produtos.length > 0) {
    params.push(filtros.produtos);
    clauses.push(`codigo_produto = ANY($${params.length}::text[])`);
  }
  if (filtros.origem) {
    params.push(filtros.origem);
    clauses.push(`origem = $${params.length}`);
  }

  return clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
}

/**
 * US1 — Snapshot diário: CMC ponderado por família com árvore de produtos.
 * Lê as linhas-folha (produto × origem) do snapshot e agrega em TS.
 */
export async function listarSnapshotCmc(
  filtros: CmcFiltros = {},
): Promise<CmcSnapshotResponse> {
  const pool = getPool();

  // 1) Resolve a data do snapshot e a flag de defasagem.
  const dataRes = await pool
    .query<{ snap: string | null; hoje: string }>(
      `SELECT MAX(data_snapshot)::text AS snap, CURRENT_DATE::text AS hoje
         FROM public."tbl_historico_cmc_estoque"
        WHERE ($1::date IS NULL OR data_snapshot = $1::date)`,
      [filtros.data ?? null],
    )
    .catch((err) => {
      logger.warn({ err: err.message }, 'Query data do snapshot CMC falhou');
      return { rows: [{ snap: null, hoje: '' }] };
    });

  const dataSnapshot = dataRes.rows[0]?.snap ?? null;
  const hoje = dataRes.rows[0]?.hoje ?? '';

  if (!dataSnapshot) {
    return {
      dataSnapshot: null,
      defasado: false,
      resumo: { volumeTotalKg: 0, valorTotal: 0 },
      familias: [],
    };
  }

  // 2) Folhas (produto × origem) do snapshot, com filtros.
  const params: unknown[] = [dataSnapshot];
  const filtrosSql = buildFiltrosSql(filtros, params);
  const sql = `
    SELECT
      codigo_produto,
      descricao_produto,
      COALESCE(NULLIF(descricao_familia, ''), '${SEM_FAMILIA}') AS familia,
      origem,
      volume_total,
      valor_total_cmc
    FROM public."tbl_historico_cmc_estoque"
    WHERE data_snapshot = $1::date
      ${filtrosSql}
    ORDER BY familia, descricao_produto, codigo_produto, origem
  `;

  const res = await pool.query<LeafRow>(sql, params).catch((err) => {
    logger.error({ err: err.message }, 'Query snapshot CMC falhou');
    throw new Error('CMC_FAIL');
  });

  // 3) Agrega em TS: família → produtos, porOrigem, totais.
  const familiasMap = new Map<string, CmcFamiliaNode>();
  let totalVolume = 0;
  let totalValor = 0;

  for (const row of res.rows) {
    const volume = Number(row.volume_total ?? 0);
    const valor = Number(row.valor_total_cmc ?? 0);
    const origem: CmcOrigem = row.origem === 'IMPORTADO' ? 'IMPORTADO' : 'NACIONAL';

    totalVolume += volume;
    totalValor += valor;

    let familia = familiasMap.get(row.familia);
    if (!familia) {
      familia = {
        descricaoFamilia: row.familia,
        cmcPonderado: null,
        volumeKg: 0,
        valor: 0,
        porOrigem: {
          importado: { cmcPonderado: null, volumeKg: 0, valor: 0 },
          nacional: { cmcPonderado: null, volumeKg: 0, valor: 0 },
        },
        produtos: [],
      };
      familiasMap.set(row.familia, familia);
    }

    familia.produtos.push({
      codigoProduto: row.codigo_produto,
      descricaoProduto: row.descricao_produto ?? '',
      origem,
      cmcPonderado: ponderado(valor, volume),
      volumeKg: volume,
      valor,
    });

    familia.volumeKg += volume;
    familia.valor += valor;
    const agg = origem === 'IMPORTADO' ? familia.porOrigem.importado : familia.porOrigem.nacional;
    agg.volumeKg += volume;
    agg.valor += valor;
  }

  // Fecha os CMCs ponderados (família + por origem).
  const familias = [...familiasMap.values()].map((f) => {
    f.cmcPonderado = ponderado(f.valor, f.volumeKg);
    f.porOrigem.importado.cmcPonderado = ponderado(
      f.porOrigem.importado.valor,
      f.porOrigem.importado.volumeKg,
    );
    f.porOrigem.nacional.cmcPonderado = ponderado(
      f.porOrigem.nacional.valor,
      f.porOrigem.nacional.volumeKg,
    );
    return f;
  });

  return {
    dataSnapshot,
    defasado: dataSnapshot !== hoje,
    resumo: { volumeTotalKg: totalVolume, valorTotal: totalValor },
    familias,
  };
}

// ── US2: Tendência histórica ─────────────────────────────────────────────────

export interface CmcTendenciaPonto {
  data: string;
  cmcPonderado: number | null;
  volumeKg: number;
  valor: number;
}

export interface CmcTendenciaSerie {
  chave: string;
  label: string;
  /** Alinhado a `datas`; null = dia sem coleta (lacuna, sem interpolar — FR-011). */
  pontos: (CmcTendenciaPonto | null)[];
}

export interface CmcTendenciaResponse {
  datas: string[];
  series: CmcTendenciaSerie[];
}

export interface CmcTendenciaFiltros {
  de?: string;
  ate?: string;
  familias?: string[];
  produtos?: string[];
  origem?: CmcOrigem;
}

interface TendenciaRow {
  data: string;
  chave: string;
  label: string | null;
  vol: string | null;
  valor: string | null;
}

// Todas as datas de calendário [de, ate] (YYYY-MM-DD), inclusive, sem fuso.
// Dias sem snapshot ficam no eixo e viram lacuna (ponto null) na série.
function rangeDatas(de: string, ate: string): string[] {
  const start = Date.parse(`${de}T00:00:00Z`);
  const end = Date.parse(`${ate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return [];
  const ONE_DAY = 86_400_000;
  const MAX_DIAS = 1100; // guarda contra intervalo absurdo (~3 anos)
  const out: string[] = [];
  for (let t = start, i = 0; t <= end && i < MAX_DIAS; t += ONE_DAY, i += 1) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * US2 — Série diária do CMC ponderado no período. Agrupamento:
 *  - produtos filtrados → uma série por produto;
 *  - senão famílias filtradas → uma série por família;
 *  - senão → série única "Total" (CMC ponderado de todo o estoque por dia).
 * Dias sem snapshot aparecem como lacuna (ponto null), sem interpolar.
 */
export async function listarTendenciaCmc(
  filtros: CmcTendenciaFiltros = {},
): Promise<CmcTendenciaResponse> {
  const pool = getPool();

  // Intervalo default = todo o histórico disponível.
  const rangeRes = await pool
    .query<{ de: string | null; ate: string | null }>(
      `SELECT MIN(data_snapshot)::text AS de, MAX(data_snapshot)::text AS ate
         FROM public."tbl_historico_cmc_estoque"`,
    )
    .catch((err) => {
      logger.warn({ err: err.message }, 'Query intervalo da tendência CMC falhou');
      return { rows: [{ de: null, ate: null }] };
    });

  const de = filtros.de ?? rangeRes.rows[0]?.de ?? null;
  const ate = filtros.ate ?? rangeRes.rows[0]?.ate ?? null;
  if (!de || !ate) return { datas: [], series: [] };

  const porProduto = (filtros.produtos?.length ?? 0) > 0;
  const porFamilia = !porProduto && (filtros.familias?.length ?? 0) > 0;
  const chaveExpr = porProduto
    ? 'codigo_produto'
    : porFamilia
      ? `COALESCE(NULLIF(descricao_familia, ''), '${SEM_FAMILIA}')`
      : `'Total'`;
  const labelExpr = porProduto ? 'MAX(descricao_produto)' : chaveExpr;
  // No caso "Total" a chave é constante — Postgres não aceita constante no GROUP BY,
  // então agrupamos só por data (um grupo por dia).
  const grupoChave = porProduto || porFamilia ? `, ${chaveExpr}` : '';

  const params: unknown[] = [de, ate];
  const filtrosSql = buildFiltrosSql(
    { familias: filtros.familias, produtos: filtros.produtos, origem: filtros.origem },
    params,
  );

  const sql = `
    SELECT
      data_snapshot::text AS data,
      ${chaveExpr} AS chave,
      ${labelExpr} AS label,
      SUM(volume_total)    AS vol,
      SUM(valor_total_cmc) AS valor
    FROM public."tbl_historico_cmc_estoque"
    WHERE data_snapshot BETWEEN $1::date AND $2::date
      ${filtrosSql}
    GROUP BY data_snapshot${grupoChave}
    ORDER BY data_snapshot
  `;

  const res = await pool.query<TendenciaRow>(sql, params).catch((err) => {
    logger.error({ err: err.message }, 'Query tendência CMC falhou');
    throw new Error('CMC_FAIL');
  });

  const datas = rangeDatas(de, ate);
  const agg = new Map<string, { vol: number; valor: number }>();
  const labels = new Map<string, string>();
  for (const r of res.rows) {
    agg.set(`${r.data}|${r.chave}`, { vol: Number(r.vol ?? 0), valor: Number(r.valor ?? 0) });
    if (!labels.has(r.chave)) labels.set(r.chave, String(r.label ?? r.chave));
  }

  const series: CmcTendenciaSerie[] = [...labels.keys()].map((chave) => ({
    chave,
    label: labels.get(chave) ?? chave,
    pontos: datas.map((data) => {
      const a = agg.get(`${data}|${chave}`);
      if (!a) return null;
      return { data, cmcPonderado: ponderado(a.valor, a.vol), volumeKg: a.vol, valor: a.valor };
    }),
  }));

  return { datas, series };
}

// ── US3: Opções de filtro (combos) ───────────────────────────────────────────

export interface CmcFiltrosResponse {
  familias: string[];
  produtos: { codigo: string; descricao: string; familia: string }[];
}

interface FiltroRow {
  familia: string;
  codigo_produto: string;
  descricao_produto: string | null;
}

/**
 * US3 — Opções dos combos (do snapshot mais recente). Se `familias` vier
 * preenchido, restringe os produtos às famílias dadas.
 */
export async function listarFiltrosCmc(familias?: string[]): Promise<CmcFiltrosResponse> {
  const pool = getPool();

  const params: unknown[] = [];
  let familiaClause = '';
  if (familias && familias.length > 0) {
    params.push(familias);
    familiaClause = `AND COALESCE(NULLIF(descricao_familia, ''), '${SEM_FAMILIA}') = ANY($${params.length}::text[])`;
  }

  const sql = `
    WITH snap AS (SELECT MAX(data_snapshot) AS d FROM public."tbl_historico_cmc_estoque")
    SELECT DISTINCT
      COALESCE(NULLIF(descricao_familia, ''), '${SEM_FAMILIA}') AS familia,
      codigo_produto,
      descricao_produto
    FROM public."tbl_historico_cmc_estoque", snap
    WHERE data_snapshot = snap.d
      ${familiaClause}
    ORDER BY familia, descricao_produto
  `;

  const res = await pool.query<FiltroRow>(sql, params).catch((err) => {
    logger.error({ err: err.message }, 'Query filtros CMC falhou');
    throw new Error('CMC_FAIL');
  });

  const familiasSet = new Set<string>();
  const produtosMap = new Map<string, { codigo: string; descricao: string; familia: string }>();
  for (const r of res.rows) {
    familiasSet.add(r.familia);
    if (!produtosMap.has(r.codigo_produto)) {
      produtosMap.set(r.codigo_produto, {
        codigo: r.codigo_produto,
        descricao: r.descricao_produto ?? '',
        familia: r.familia,
      });
    }
  }

  return {
    familias: [...familiasSet].sort((a, b) => a.localeCompare(b, 'pt-BR')),
    produtos: [...produtosMap.values()],
  };
}
