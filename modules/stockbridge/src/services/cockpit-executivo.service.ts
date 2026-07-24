import { getPool, createLogger } from '@atlas/core';
import { getCockpit } from './cockpit.service.js';
import { getPtaxCorrente } from './metricas.service.js';
import {
  recebidaViaMovimentacaoSql,
  recebidaViaLegadoSql,
  nfValidaSql,
  colunaCanceladaExiste,
} from './fiscal-recebida-sql.js';

const logger = createLogger('stockbridge:cockpit-executivo');

/**
 * Cockpit Executivo — "onde está o dinheiro" (ACXEGDP-314).
 *
 * Visão do dono: capital imobilizado em estoque (R$) decomposto por destino
 * (galpões físicos, trânsito de importação, comodato) e por família de produto.
 * Referência de produto: protótipo StockBridge v5 desenhado pelo Rogério
 * (legacy/vibecodes/stockbridge/StockBridge Pacote/StockBridge_v5_Frontend.html).
 *
 * Fontes e réguas de valorização:
 *   - GALPÕES + COMODATO ← tbl_posicaoEstoque_* (MAX ddataposicao, mesmo padrão
 *     do cockpit) × ncmc (CMC OMIE — o valor_unitario da view unificada).
 *   - TRÂNSITO ← stockbridge.lote (FUP-driven, 4 estágios) × custo_brl_kg do
 *     lote (custo real da compra em curso), com o MESMO desconto de filhotes
 *     já recebidas que o cockpit aplica em transito_local.
 *   - PENDENTE FISCAL (importação) ← getCockpit() — número idêntico ao da tela
 *     Cockpit, valorizado pelo CMC do SKU (fallback: custo do lote em trânsito).
 *
 * Anti-dupla-contagem (Princípio da arquitetura Atlas-sobre-OMIE):
 *   - Espelhado ACXE↔Q2P: por (produto, local) conta Q2P, senão ACXE.
 *   - O local OMIE 90.0.2 (TRÂNSITO) fica FORA da soma: sobrepõe parcialmente
 *     com o pipeline FUP (fonte de verdade do trânsito desde a migration 0037)
 *     e somá-lo contaria o mesmo material duas vezes.
 *   - Pendente fiscal NÃO soma no total: é subestado do material em trânsito
 *     (NF emitida ainda não recebida), exibido como informação, não como bloco.
 */

// Mesma whitelist do cockpit (cockpit.service.ts) — galpões físicos reais.
const GALPOES_FISICOS = ['11.1', '11.2', '12.1', '12.2', '21.1', '21.2', '31.1'];
const CODIGO_COMODATO_OMIE = '90.0.1';

// Nome executivo por código OMIE. Códigos fora do mapa aparecem pelo próprio
// código (fallback) — melhor visível e feio do que somado errado ou escondido.
const GALPAO_LABELS: Record<string, string> = {
  '11.1': 'Santo André — Importado',
  '12.1': 'Santo André — Importado',
  '11.2': 'Santo André — Nacional',
  '12.2': 'Santo André — Nacional',
  '21.1': 'Extrema',
  '21.2': 'Extrema',
  '31.1': 'Armazém Externo',
};

const ESTAGIOS_PIPELINE = ['aguardando_embarque', 'transito_intl', 'no_porto', 'transito_local'] as const;
export type EstagioPipeline = (typeof ESTAGIOS_PIPELINE)[number];

export interface ExecutivoGalpao {
  nome: string;
  codigos: string[];
  kg: number;
  valorBrl: number;
  produtos: number;
}

export interface ExecutivoEstagio {
  estagio: EstagioPipeline;
  lotes: number;
  kg: number;
  valorBrl: number;
}

export interface ExecutivoProduto {
  codigoAcxe: number | null;
  nome: string;
  kg: number;
  valorBrl: number;
}

export interface ExecutivoFamilia {
  familia: string;
  kg: number;
  valorBrl: number;
  produtos: ExecutivoProduto[];
}

export interface CockpitExecutivoData {
  dataPosicao: string | null;
  totais: {
    valorTotalBrl: number;
    kgTotal: number;
    emGalpaoBrl: number;
    emGalpaoKg: number;
    emTransitoBrl: number;
    emTransitoKg: number;
    comodatoBrl: number;
    comodatoKg: number;
    kgSemCusto: number;
  };
  galpoes: ExecutivoGalpao[];
  transito: ExecutivoEstagio[];
  exposicaoCambial: { brl: number; usd: number; ptax: number };
  posicaoFiscal: { pendenteImportacaoKg: number; pendenteImportacaoBrl: number; kgSemCusto: number };
  familias: ExecutivoFamilia[];
}

/** Linha de posição OMIE valorizada (galpão físico ou comodato) × produto.
 *  codigoAcxe é null para produto Q2P sem correlato ACXE (nacional) — ele
 *  continua contando: o dinheiro do dono não some por falta de cadastro. */
export interface LinhaPosicao {
  codigoEstoque: string;
  codigoAcxe: number | null;
  nome: string;
  familia: string | null;
  kg: number;
  valorBrl: number;
}

/** Linha de trânsito FUP valorizada, por estágio × produto. */
export interface LinhaTransito {
  estagio: string;
  codigoAcxe: number;
  nome: string;
  familia: string | null;
  lotes: number;
  kg: number;
  valorBrl: number;
  kgSemCusto: number;
}

export async function getCockpitExecutivo(): Promise<CockpitExecutivoData> {
  const [posicao, transito, cockpit, ptax, dataPosicao] = await Promise.all([
    consultarPosicaoValorizada(),
    consultarTransitoValorizado(),
    getCockpit({}),
    getPtaxCorrente(),
    consultarDataPosicao(),
  ]);

  const pendentePorSku = cockpit.skus
    .filter((s) => s.fiscalPendenteImportacaoKg > 0)
    .map((s) => ({ codigoAcxe: s.codigoAcxe, kg: s.fiscalPendenteImportacaoKg }));

  const data = montarExecutivo(posicao, transito, pendentePorSku, ptax, dataPosicao);

  // Sentinela de consistência: o subconjunto COM correlato ACXE deve bater com
  // o físico do cockpit (mesma whitelist, mesmos filtros). A visão executiva
  // soma além disso os produtos Q2P sem correlato (o cockpit os descarta pelo
  // INNER JOIN de correlação) — por isso a comparação exclui os sem-correlato.
  const fisicoCockpit = cockpit.resumo.totalFisicoKg;
  const emGalpaoComCorrelatoKg = posicao
    .filter((l) => l.codigoEstoque !== CODIGO_COMODATO_OMIE && l.codigoAcxe != null)
    .reduce((a, l) => a + l.kg, 0);
  if (fisicoCockpit > 0 && Math.abs(emGalpaoComCorrelatoKg - fisicoCockpit) > fisicoCockpit * 0.01) {
    logger.warn(
      { emGalpaoComCorrelatoKg, fisicoCockpit },
      'Cockpit executivo divergiu do cockpit no físico (>1%) — revisar réguas',
    );
  }

  return data;
}

/**
 * Monta a resposta executiva a partir das linhas valorizadas. Pura — testável
 * sem banco (padrão conferencia.engine).
 */
export function montarExecutivo(
  posicao: LinhaPosicao[],
  transito: LinhaTransito[],
  pendenteImportacaoPorSku: Array<{ codigoAcxe: number; kg: number }>,
  ptax: number,
  dataPosicao: string | null,
): CockpitExecutivoData {
  const fisicas = posicao.filter((l) => l.codigoEstoque !== CODIGO_COMODATO_OMIE);
  const comodato = posicao.filter((l) => l.codigoEstoque === CODIGO_COMODATO_OMIE);

  // ── Galpões agrupados pelo nome executivo ────────────────────────────────
  const porGalpao = new Map<string, ExecutivoGalpao & { skus: Set<string> }>();
  for (const l of fisicas) {
    const nome = GALPAO_LABELS[l.codigoEstoque] ?? l.codigoEstoque;
    let g = porGalpao.get(nome);
    if (!g) {
      g = { nome, codigos: [], kg: 0, valorBrl: 0, produtos: 0, skus: new Set<string>() };
      porGalpao.set(nome, g);
    }
    if (!g.codigos.includes(l.codigoEstoque)) g.codigos.push(l.codigoEstoque);
    g.kg += l.kg;
    g.valorBrl += l.valorBrl;
    g.skus.add(l.codigoAcxe != null ? String(l.codigoAcxe) : `q2p:${l.nome}`);
  }
  const galpoes = [...porGalpao.values()]
    .map(({ skus, ...g }) => ({ ...g, produtos: skus.size, codigos: [...g.codigos].sort() }))
    .sort((a, b) => b.valorBrl - a.valorBrl);

  // ── Esteira de trânsito (4 estágios, ordem do pipeline) ──────────────────
  const transitoPorEstagio: ExecutivoEstagio[] = ESTAGIOS_PIPELINE.map((estagio) => {
    const linhas = transito.filter((t) => t.estagio === estagio);
    return {
      estagio,
      lotes: linhas.reduce((a, t) => a + t.lotes, 0),
      kg: linhas.reduce((a, t) => a + t.kg, 0),
      valorBrl: linhas.reduce((a, t) => a + t.valorBrl, 0),
    };
  });

  // ── Composição por família (galpões + comodato + trânsito = 100% do total) ─
  // Chave do produto: código ACXE quando existe; senão a descrição (produto
  // Q2P sem correlato ainda soma no bolo da família).
  const porFamilia = new Map<string, Map<string, ExecutivoProduto>>();
  const acumular = (familia: string | null, codigoAcxe: number | null, nome: string, kg: number, valorBrl: number) => {
    const chave = familia && familia.trim() !== '' ? familia : 'Sem família';
    let fam = porFamilia.get(chave);
    if (!fam) {
      fam = new Map();
      porFamilia.set(chave, fam);
    }
    const chaveProduto = codigoAcxe != null ? String(codigoAcxe) : `q2p:${nome}`;
    const p = fam.get(chaveProduto);
    if (p) {
      p.kg += kg;
      p.valorBrl += valorBrl;
    } else {
      fam.set(chaveProduto, { codigoAcxe, nome, kg, valorBrl });
    }
  };
  for (const l of posicao) acumular(l.familia, l.codigoAcxe, l.nome, l.kg, l.valorBrl);
  for (const t of transito) acumular(t.familia, t.codigoAcxe, t.nome, t.kg, t.valorBrl);

  const familias: ExecutivoFamilia[] = [...porFamilia.entries()]
    .map(([familia, produtosMap]) => {
      const produtos = [...produtosMap.values()].sort((a, b) => b.valorBrl - a.valorBrl);
      return {
        familia,
        kg: produtos.reduce((a, p) => a + p.kg, 0),
        valorBrl: produtos.reduce((a, p) => a + p.valorBrl, 0),
        produtos,
      };
    })
    .sort((a, b) => b.valorBrl - a.valorBrl);

  // ── Custo de referência por SKU (R$/kg) para valorizar o pendente fiscal ──
  // Preferência: CMC do estoque; fallback: custo do lote em trânsito.
  const custoPorSku = new Map<number, number>();
  const pesoPorSku = new Map<number, number>();
  const acumularCusto = (codigoAcxe: number | null, kg: number, valorBrl: number) => {
    if (codigoAcxe == null || kg <= 0 || valorBrl <= 0) return;
    custoPorSku.set(codigoAcxe, (custoPorSku.get(codigoAcxe) ?? 0) + valorBrl);
    pesoPorSku.set(codigoAcxe, (pesoPorSku.get(codigoAcxe) ?? 0) + kg);
  };
  for (const l of posicao) acumularCusto(l.codigoAcxe, l.kg, l.valorBrl);
  for (const t of transito) {
    if (t.kgSemCusto === 0) acumularCusto(t.codigoAcxe, t.kg, t.valorBrl);
  }

  let pendenteKg = 0;
  let pendenteBrl = 0;
  let pendenteKgSemCusto = 0;
  for (const p of pendenteImportacaoPorSku) {
    pendenteKg += p.kg;
    const valor = custoPorSku.get(p.codigoAcxe);
    const peso = pesoPorSku.get(p.codigoAcxe);
    if (valor != null && peso != null && peso > 0) {
      pendenteBrl += p.kg * (valor / peso);
    } else {
      pendenteKgSemCusto += p.kg;
    }
  }

  // ── Totais ────────────────────────────────────────────────────────────────
  const emGalpaoKg = galpoes.reduce((a, g) => a + g.kg, 0);
  const emGalpaoBrl = galpoes.reduce((a, g) => a + g.valorBrl, 0);
  const emTransitoKg = transitoPorEstagio.reduce((a, t) => a + t.kg, 0);
  const emTransitoBrl = transitoPorEstagio.reduce((a, t) => a + t.valorBrl, 0);
  const comodatoKg = comodato.reduce((a, l) => a + l.kg, 0);
  const comodatoBrl = comodato.reduce((a, l) => a + l.valorBrl, 0);
  const kgSemCustoPosicao = posicao.filter((l) => l.kg > 0 && l.valorBrl === 0).reduce((a, l) => a + l.kg, 0);
  const kgSemCustoTransito = transito.reduce((a, t) => a + t.kgSemCusto, 0);

  const exposicaoBrl = transitoPorEstagio.find((t) => t.estagio === 'transito_intl')?.valorBrl ?? 0;

  return {
    dataPosicao,
    totais: {
      valorTotalBrl: emGalpaoBrl + emTransitoBrl + comodatoBrl,
      kgTotal: emGalpaoKg + emTransitoKg + comodatoKg,
      emGalpaoBrl,
      emGalpaoKg,
      emTransitoBrl,
      emTransitoKg,
      comodatoBrl,
      comodatoKg,
      kgSemCusto: kgSemCustoPosicao + kgSemCustoTransito,
    },
    galpoes,
    transito: transitoPorEstagio,
    exposicaoCambial: {
      brl: exposicaoBrl,
      usd: ptax > 0 ? exposicaoBrl / ptax : 0,
      ptax,
    },
    posicaoFiscal: {
      pendenteImportacaoKg: pendenteKg,
      pendenteImportacaoBrl: pendenteBrl,
      kgSemCusto: pendenteKgSemCusto,
    },
    familias,
  };
}

/**
 * Posição OMIE valorizada por (local, produto) — galpões físicos + comodato.
 * Mesmo esqueleto do cockpit: tabelas-fonte com MAX(ddataposicao) (a view
 * filtra o dia corrente e zeraria a tela à meia-noite UTC), consolidação
 * Q2P>ACXE por (produto, local) e filtros incluir_em_metricas.
 * Valorização: saldo × ncmc (CMC OMIE, o valor_unitario da view unificada).
 */
async function consultarPosicaoValorizada(): Promise<LinhaPosicao[]> {
  const pool = getPool();
  const locais = [...GALPOES_FISICOS, CODIGO_COMODATO_OMIE];

  const sql = `
    WITH posicao_unificada AS (
      SELECT
        'ACXE'::text AS empresa,
        e.codigo AS codigo_estoque,
        p.cdescricao AS descricao_produto,
        p.nsaldo AS saldo,
        p.ncmc AS cmc
      FROM public."tbl_posicaoEstoque_ACXE" p
      INNER JOIN public."tbl_locaisEstoques_ACXE" e
        ON p.codigo_local_estoque = e.codigo_local_estoque
      WHERE p.fisico >= 0
        AND p.ddataposicao = (SELECT MAX(ddataposicao) FROM public."tbl_posicaoEstoque_ACXE")
      UNION ALL
      SELECT
        'Q2P'::text,
        e.codigo,
        p.cdescricao,
        p.nsaldo,
        p.ncmc
      FROM public."tbl_posicaoEstoque_Q2P" p
      INNER JOIN public."tbl_locaisEstoques_Q2P" e
        ON p.codigo_local_estoque = e.codigo_local_estoque
      WHERE p.fisico >= 0
        AND p.ddataposicao = (SELECT MAX(ddataposicao) FROM public."tbl_posicaoEstoque_Q2P")
    ),
    consolidada AS (
      SELECT
        o.codigo_estoque,
        o.descricao_produto,
        COALESCE(
          MAX(o.saldo) FILTER (WHERE o.empresa = 'Q2P'),
          MAX(o.saldo) FILTER (WHERE o.empresa = 'ACXE')
        ) AS saldo,
        COALESCE(
          MAX(o.cmc) FILTER (WHERE o.empresa = 'Q2P'),
          MAX(o.cmc) FILTER (WHERE o.empresa = 'ACXE')
        ) AS cmc
      FROM posicao_unificada o
      WHERE o.saldo > 0
        AND o.codigo_estoque = ANY($1::text[])
      GROUP BY o.codigo_estoque, o.descricao_produto
    )
    SELECT
      c.codigo_estoque,
      pa.codigo_produto AS produto_codigo_acxe,
      COALESCE(pa.descricao, c.descricao_produto) AS nome,
      COALESCE(pa.descricao_familia, pq.descricao_familia) AS familia,
      c.saldo::numeric AS kg,
      (c.saldo * COALESCE(c.cmc, 0))::numeric AS valor_brl
    FROM consolidada c
    -- LEFT (não INNER como no cockpit): produto Q2P nacional sem correlato
    -- ACXE segue contando — o dinheiro do dono não some por falta de cadastro.
    LEFT JOIN public."tbl_produtos_ACXE" pa ON pa.descricao = c.descricao_produto
    LEFT JOIN (
      SELECT descricao, MAX(descricao_familia) AS descricao_familia
      FROM public."tbl_produtos_Q2P"
      GROUP BY descricao
    ) pq ON pq.descricao = c.descricao_produto
    LEFT JOIN stockbridge.familia_omie_atlas f
      ON f.familia_omie = COALESCE(pa.descricao_familia, pq.descricao_familia)
    LEFT JOIN stockbridge.config_produto cfg ON cfg.produto_codigo_acxe = pa.codigo_produto
    WHERE COALESCE(f.incluir_em_metricas, true) = true
      AND COALESCE(cfg.incluir_em_metricas, true) = true
  `;

  const res = await pool.query(sql, [locais]).catch((err) => {
    logger.warn({ err: (err as Error).message }, 'Query posição valorizada falhou — retornando vazio');
    return { rows: [] as Record<string, unknown>[] };
  });

  return (res.rows as Record<string, unknown>[]).map((r) => ({
    codigoEstoque: String(r.codigo_estoque),
    codigoAcxe: r.produto_codigo_acxe != null ? Number(r.produto_codigo_acxe) : null,
    nome: String(r.nome),
    familia: (r.familia as string | null) ?? null,
    kg: Number(r.kg),
    valorBrl: Number(r.valor_brl),
  }));
}

/**
 * Trânsito FUP valorizado por (estágio, produto), com o mesmo desconto de
 * filhotes já recebidas que o cockpit aplica em transito_local — os Kg da
 * esteira aqui e na tela Cockpit precisam ser o mesmo número.
 */
async function consultarTransitoValorizado(): Promise<LinhaTransito[]> {
  const pool = getPool();
  const nfValida = nfValidaSql(await colunaCanceladaExiste(pool), 'h');

  const sql = `
    WITH transito_recebido_filhotes AS (
      SELECT mapa.pedido_acxe_omie, i.n_cod_prod AS produto_codigo_acxe,
             SUM(i.q_com)::numeric AS recebido_kg
      FROM stockbridge.nf_pedido_mapa mapa
      JOIN stockbridge.nf_pedido_filhote f ON f.mapa_id = mapa.id AND f.ativo = true
      JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote, 8, '0')
      JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
      WHERE mapa.ativo = true
        ${nfValida}
        AND (
          h.n_id_receb > 0
          -- Feature 014: por PRODUTO — a CTE ja agrupa por i.n_cod_prod; sem o
          -- filtro acompanhar, um produto pendente entrava com o peso total como
          -- se estivesse recebido (NF multi-produto parcial, feature 013).
          OR ${recebidaViaMovimentacaoSql("LPAD(f.nf_filhote, 8, '0')", 'i.n_cod_prod')}
          OR ${recebidaViaLegadoSql("LPAD(f.nf_filhote, 8, '0')")}
        )
      GROUP BY mapa.pedido_acxe_omie, i.n_cod_prod
    ),
    lote_liquido AS (
      SELECT
        l.estagio_transito,
        l.produto_codigo_acxe,
        CASE WHEN l.estagio_transito = 'transito_local'
             THEN GREATEST(l.quantidade_fisica_kg - COALESCE(trf.recebido_kg, 0), 0)
             ELSE l.quantidade_fisica_kg END AS kg,
        COALESCE(l.custo_brl_kg, 0) AS custo_brl_kg
      FROM stockbridge.lote l
      LEFT JOIN transito_recebido_filhotes trf
        ON trf.pedido_acxe_omie = l.pedido_compra_acxe
        AND trf.produto_codigo_acxe = l.produto_codigo_acxe
      WHERE l.ativo = true
        AND l.status = 'transito'
        AND l.estagio_transito = ANY($1::text[])
    )
    SELECT
      ll.estagio_transito AS estagio,
      ll.produto_codigo_acxe,
      COALESCE(pa.descricao, 'Produto ' || ll.produto_codigo_acxe::text) AS nome,
      pa.descricao_familia AS familia,
      COUNT(*)::int AS lotes,
      SUM(ll.kg)::numeric AS kg,
      SUM(ll.kg * ll.custo_brl_kg)::numeric AS valor_brl,
      COALESCE(SUM(ll.kg) FILTER (WHERE ll.custo_brl_kg = 0), 0)::numeric AS kg_sem_custo
    FROM lote_liquido ll
    LEFT JOIN public."tbl_produtos_ACXE" pa ON pa.codigo_produto = ll.produto_codigo_acxe
    GROUP BY ll.estagio_transito, ll.produto_codigo_acxe, pa.descricao, pa.descricao_familia
  `;

  const res = await pool.query(sql, [[...ESTAGIOS_PIPELINE]]).catch((err) => {
    logger.warn({ err: (err as Error).message }, 'Query trânsito valorizado falhou — retornando vazio');
    return { rows: [] as Record<string, unknown>[] };
  });

  return (res.rows as Record<string, unknown>[]).map((r) => ({
    estagio: String(r.estagio),
    codigoAcxe: Number(r.produto_codigo_acxe),
    nome: String(r.nome),
    familia: (r.familia as string | null) ?? null,
    lotes: Number(r.lotes),
    kg: Number(r.kg),
    valorBrl: Number(r.valor_brl),
    kgSemCusto: Number(r.kg_sem_custo),
  }));
}

/** Data da posição OMIE mais antiga entre as duas empresas (a mais conservadora). */
async function consultarDataPosicao(): Promise<string | null> {
  const pool = getPool();
  const res = await pool
    .query<{ data_posicao: string | null }>(
      `SELECT LEAST(
         (SELECT MAX(ddataposicao) FROM public."tbl_posicaoEstoque_ACXE"),
         (SELECT MAX(ddataposicao) FROM public."tbl_posicaoEstoque_Q2P")
       )::text AS data_posicao`,
    )
    .catch(() => ({ rows: [{ data_posicao: null }] }));
  return res.rows[0]?.data_posicao ?? null;
}
