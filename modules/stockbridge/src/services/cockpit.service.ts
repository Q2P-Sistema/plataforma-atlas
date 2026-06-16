import { getPool, createLogger, getConfig } from '@atlas/core';
import {
  calcularCobertura,
  classificarCriticidade,
  type Criticidade,
} from './motor.service.js';
import { recebidaViaMovimentacaoSql, recebidaViaLegadoSql } from './fiscal-recebida-sql.js';

const logger = createLogger('stockbridge:cockpit');

export type FiltroCnpj = 'acxe' | 'q2p' | 'ambos';
export type FiltroCriticidade = Criticidade | 'todas';

export interface CockpitFiltros {
  familias?: string[];          // descricao_familia exata; vazio/undefined = todas
  cnpj?: FiltroCnpj;
  galpoes?: string[];           // ex: ['11', '12', '21']; vazio/undefined = todos
  criticidade?: FiltroCriticidade;
}

export interface CockpitSku {
  codigoAcxe: number;
  nome: string;
  familia: string | null;
  ncm: string | null;
  fisicaKg: number;                    // saldo OMIE (fonte de verdade)
  fiscalKg: number;                    // fisicaKg + pendentes (representa total fiscal)
  fiscalPendenteNacionalKg: number;    // NFs nacionais entrada com n_id_receb=0 (pos cutoff)
  fiscalPendenteImportacaoKg: number;  // NFs ACXE 3.xxx sem movimentacao subtipo=importacao
  aguardandoEmbarqueKg: number;         // Atlas: lote status='transito' estagio='aguardando_embarque' (FUP 01)
  transitoIntlKg: number;              // Atlas: lote status='transito' estagio='transito_intl' (FUP 02)
  noPortoKg: number;                   // Atlas: lote status='transito' estagio='no_porto' (FUP 03 etapa 20/30/31)
  transitoLocalKg: number;             // Atlas: lote status='transito' estagio='transito_local' (FUP 03 etapa 21/22, NF emitida)
  transitoInternoKg: number;           // Atlas: lote status='transito' estagio='transito_interno'
  provisorioKg: number;                // Atlas: lote provisorio AINDA NAO consolidado pelo OMIE
  comodatoKg: number;                  // OMIE 90.0.1 (TROCA): material emprestado a clientes
  consumoMedioDiarioKg: number | null;
  leadTimeDias: number | null;
  coberturaDias: number | null;
  criticidade: Criticidade;
  divergencias: number;
  aprovacoesPendentes: number;
}

export interface CockpitResumo {
  totalFisicoKg: number;
  totalFiscalKg: number;
  totalFiscalPendenteNacionalKg: number;
  totalFiscalPendenteImportacaoKg: number;
  aguardandoEmbarqueKg: number;
  transitoIntlKg: number;
  noPortoKg: number;
  transitoLocalKg: number;
  transitoInternoKg: number;
  provisorioKg: number;
  comodatoKg: number;
  divergenciasCount: number;
  aprovacoesPendentes: number;
  skusCriticos: number;
  skusAlerta: number;
  skusExcesso: number;
}

export interface CockpitData {
  resumo: CockpitResumo;
  skus: CockpitSku[];
}

/**
 * Cockpit hibrido (Atlas como camada sobre OMIE — ver
 * specs/007-stockbridge-module/arquitetura-atlas-camada-omie.md).
 *
 * Fontes:
 *   - SALDO FISICO        ← OMIE (vw_posicaoEstoqueUnificadaFamilia), filtrado
 *                           por galpao quando passado, com regra anti-dupla
 *                           pra espelhados.
 *   - SALDO TRANSITO      ← Atlas (stockbridge.lote status='transito') por estagio.
 *   - SALDO PROVISORIO    ← Atlas (lote status='provisorio') APENAS quando OMIE
 *                           ainda NAO consolidou.
 *   - FISCAL PENDENTE     ← public.tbl_nf_header_* + tbl_nf_itens_*:
 *                           - Nacional (CFOPs 1.xxx/2.xxx): NF de entrada
 *                             com n_id_receb=0 (OMIE indica nao recebida fisica)
 *                           - Importacao (CFOPs 3.xxx, so ACXE): NF de entrada
 *                             cuja n_nf NAO esta em stockbridge.movimentacao
 *                             com subtipo='importacao'.
 *                           Cutoff temporal via STOCKBRIDGE_FISCAL_CUTOFF_DATE
 *                           (default 180 dias atras) para ignorar NFs antigas
 *                           que foram tratadas pelo legado pre-Atlas.
 *   - DIVERGENCIAS/APRS   ← Atlas (workflow puro).
 */
export async function getCockpit(filtros: CockpitFiltros = {}): Promise<CockpitData> {
  const pool = getPool();
  const config = getConfig();

  const empresa: FiltroCnpj = filtros.cnpj ?? 'ambos';
  const galpoes = filtros.galpoes && filtros.galpoes.length > 0 ? filtros.galpoes : null;
  const familias = filtros.familias && filtros.familias.length > 0 ? filtros.familias : null;
  const incluirAcxe = empresa === 'acxe' || empresa === 'ambos';
  const incluirQ2p = empresa === 'q2p' || empresa === 'ambos';

  // Cutoff fiscal: ignora NFs anteriores a essa data.
  // Sem env: 180 dias atras.
  const cutoffDate =
    config.STOCKBRIDGE_FISCAL_CUTOFF_DATE ??
    (() => {
      const d = new Date();
      d.setDate(d.getDate() - 180);
      return d.toISOString().slice(0, 10);
    })();

  // Whitelist de galpoes fisicos reais (entram em "Disponivel"). Tudo que
  // estiver fora desta lista e os codigos especiais 90.0.* nao soma como
  // estoque disponível — saldo de OPERACIONAIS (VARREDURA, FALTANDO, PROCESSO,
  // CONSUMO, PRODUÇÃO) e ignorado pelo cockpit.
  const GALPOES_FISICOS = ['11.1', '11.2', '12.1', '12.2', '21.1', '21.2', '31.1'];
  const CODIGO_COMODATO_OMIE = '90.0.1'; // estoque emprestado a clientes

  // Regra de empresa pra OMIE: filtra por empresa do registro. Em "ambos",
  // sem filtro — o agrupamento por (produto, codigo_estoque) com COALESCE
  // Q2P > ACXE evita dupla contagem do espelhado (11.1 tem ambos).
  const filtroEmpresaOmie =
    empresa === 'acxe'
      ? `AND o.empresa = 'ACXE'`
      : empresa === 'q2p'
        ? `AND o.empresa = 'Q2P'`
        : '';

  // Parametros (sempre na mesma ordem):
  //   $1 = familias (text[]|null)  — null/array vazio = todas
  //   $2 = galpoes (text[]|null)   — null/array vazio = todos
  //   $3 = cutoff_date (date)
  //   $4 = incluir_acxe (bool)
  //   $5 = incluir_q2p (bool)
  // Filtro de galpao: aplicado SO ao saldo OMIE. Para multiplos galpoes,
  // compara codigo_estoque diretamente com a lista.
  const galpaoFilterOmie = `
    AND ($2::text[] IS NULL OR o.codigo_estoque = ANY($2::text[]))`;

  const sql = `
    -- Le direto das tabelas-fonte usando MAX(ddataposicao) por empresa.
    -- Antes usavamos public."vw_posicaoEstoqueUnificadaFamilia" mas ela
    -- filtra estritamente ddataposicao = CURRENT_DATE, zerando o cockpit
    -- toda meia-noite UTC se o sync diario ainda nao rodou.
    -- Replicamos a logica da view (UNION ALL ACXE+Q2P, JOIN com locais
    -- de estoque) mas usando a data mais recente disponivel por empresa.
    WITH posicao_unificada AS (
      SELECT
        'ACXE'::text AS empresa,
        e.codigo AS codigo_estoque,
        p.cdescricao AS descricao_produto,
        p.nsaldo AS saldo
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
        p.nsaldo
      FROM public."tbl_posicaoEstoque_Q2P" p
      INNER JOIN public."tbl_locaisEstoques_Q2P" e
        ON p.codigo_local_estoque = e.codigo_local_estoque
      WHERE p.fisico >= 0
        AND p.ddataposicao = (SELECT MAX(ddataposicao) FROM public."tbl_posicaoEstoque_Q2P")
    ),
    fisico_omie AS (
      -- 1) Linhas brutas: produto + codigo_estoque + empresa + saldo
      --    Whitelist de galpoes fisicos reais, filtro de empresa, galpao multi.
      WITH posicao_bruta AS (
        SELECT
          pa.codigo_produto AS produto_codigo_acxe,
          o.codigo_estoque,
          o.empresa,
          o.saldo
        FROM posicao_unificada o
        INNER JOIN public."tbl_produtos_ACXE" pa ON pa.descricao = o.descricao_produto
        WHERE o.saldo > 0
          AND o.codigo_estoque = ANY('{${GALPOES_FISICOS.join(',')}}'::text[])
          ${filtroEmpresaOmie}
          ${galpaoFilterOmie}
      ),
      -- 2) Por (produto, codigo_estoque) escolhe Q2P se existe, senao ACXE.
      --    Anti-dupla-contagem do espelhado (ex: 11.1 tem ACXE+Q2P, conta Q2P).
      posicao_consolidada AS (
        SELECT
          produto_codigo_acxe,
          codigo_estoque,
          COALESCE(
            MAX(saldo) FILTER (WHERE empresa = 'Q2P'),
            MAX(saldo) FILTER (WHERE empresa = 'ACXE')
          ) AS saldo_local
        FROM posicao_bruta
        GROUP BY produto_codigo_acxe, codigo_estoque
      )
      SELECT produto_codigo_acxe, SUM(saldo_local) AS fisica_kg
      FROM posicao_consolidada
      GROUP BY produto_codigo_acxe
    ),
    -- COMODATO OMIE (90.0.1): material emprestado a clientes. Nao disponivel
    -- mas precisa ser vigiado pelos gestores para nao esquecer.
    comodato_omie AS (
      SELECT produto_codigo_acxe, SUM(saldo_local) AS comodato_kg
      FROM (
        SELECT
          pa.codigo_produto AS produto_codigo_acxe,
          COALESCE(
            MAX(o.saldo) FILTER (WHERE o.empresa = 'Q2P'),
            MAX(o.saldo) FILTER (WHERE o.empresa = 'ACXE')
          ) AS saldo_local
        FROM posicao_unificada o
        INNER JOIN public."tbl_produtos_ACXE" pa ON pa.descricao = o.descricao_produto
        WHERE o.saldo > 0
          AND o.codigo_estoque = '${CODIGO_COMODATO_OMIE}'
          ${filtroEmpresaOmie}
        GROUP BY pa.codigo_produto
      ) src
      GROUP BY produto_codigo_acxe
    ),
    transito_atlas AS (
      SELECT
        l.produto_codigo_acxe,
        SUM(l.quantidade_fisica_kg) FILTER (WHERE l.estagio_transito = 'aguardando_embarque') AS aguardando_embarque_kg,
        SUM(l.quantidade_fisica_kg) FILTER (WHERE l.estagio_transito = 'transito_intl')       AS transito_intl_kg,
        SUM(l.quantidade_fisica_kg) FILTER (WHERE l.estagio_transito = 'no_porto')            AS no_porto_kg,
        SUM(l.quantidade_fisica_kg) FILTER (WHERE l.estagio_transito = 'transito_local')      AS transito_local_kg,
        SUM(l.quantidade_fisica_kg) FILTER (WHERE l.estagio_transito = 'transito_interno')    AS transito_interno_kg
      FROM stockbridge.lote l
      WHERE l.ativo = true AND l.status = 'transito'
      GROUP BY l.produto_codigo_acxe
    ),
    provisorio_atlas AS (
      SELECT
        l.produto_codigo_acxe,
        SUM(l.quantidade_fisica_kg) AS provisorio_kg
      FROM stockbridge.lote l
      WHERE l.ativo = true
        AND l.status = 'provisorio'
        AND EXISTS (
          SELECT 1 FROM stockbridge.movimentacao m
          WHERE m.lote_id = l.id
            AND m.ativo = true
            AND m.status_omie <> 'concluida'
        )
      GROUP BY l.produto_codigo_acxe
    ),
    fiscal_pend_nacional AS (
      -- NFs de entrada nacional (CFOPs 1.xxx/2.xxx) sem recebimento OMIE,
      -- consolidadas por produto_codigo_acxe (3 empresas).
      SELECT produto_codigo_acxe, SUM(kg)::numeric AS pendente_nacional_kg
      FROM (
        -- ACXE nacional (link direto)
        SELECT i.n_cod_prod AS produto_codigo_acxe, i.q_com AS kg
        FROM public."tbl_nf_header_ACXE" h
        JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
        WHERE $4::bool = true
          AND h.tp_nf = 0
          AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
          AND LEFT(i.cfop, 1) IN ('1','2')
          AND h.d_emi >= $3::date

        UNION ALL

        -- Q2P nacional (correlaciona via descricao com ACXE)
        SELECT pa.codigo_produto AS produto_codigo_acxe, i.q_com AS kg
        FROM public."tbl_nf_header_Q2P" h
        JOIN public."tbl_nf_itens_Q2P" i ON i.n_id_nf = h.n_id_nf
        JOIN public."tbl_produtos_Q2P" pq ON pq.codigo_produto = i.n_cod_prod
        JOIN public."tbl_produtos_ACXE" pa ON pa.descricao = pq.descricao
        WHERE $5::bool = true
          AND h.tp_nf = 0
          AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
          AND LEFT(i.cfop, 1) IN ('1','2')
          AND h.d_emi >= $3::date

        UNION ALL

        -- Q2P_Filial nacional
        SELECT pa.codigo_produto AS produto_codigo_acxe, i.q_com AS kg
        FROM public."tbl_nf_header_Q2P_Filial" h
        JOIN public."tbl_nf_itens_Q2P_Filial" i ON i.n_id_nf = h.n_id_nf
        JOIN public."tbl_produtos_Q2P_Filial" pf ON pf.codigo_produto = i.n_cod_prod
        JOIN public."tbl_produtos_ACXE" pa ON pa.descricao = pf.descricao
        WHERE $5::bool = true
          AND h.tp_nf = 0
          AND (h.n_id_receb = 0 OR h.n_id_receb IS NULL)
          AND LEFT(i.cfop, 1) IN ('1','2')
          AND h.d_emi >= $3::date
      ) src
      GROUP BY produto_codigo_acxe
    ),
    fiscal_pend_importacao AS (
      -- UNION ALL de duas fontes consolidado por produto para garantir 1 row por código.
      -- Sem o GROUP BY externo, o LEFT JOIN no SELECT final duplicaria todas as métricas
      -- para produtos presentes em ambas as partes (ex.: mesmo produto em pedido com mapa
      -- E em NF legada sem mapa → duplicaria transito_atlas, fisico_omie, etc.).
      SELECT produto_codigo_acxe, SUM(pendente_importacao_kg)::numeric AS pendente_importacao_kg
      FROM (
        -- Parte A (Fix 3 — ACXEGDP-183): pedidos COM mapa NF mãe/filhote. Conta o SALDO
        -- ainda não recebido (qtde do pedido − filhotes já recebidas), não o pedido inteiro —
        -- senão o material já recebido conta 2x (na pendência fiscal E no físico/Disponível).
        -- "Filhote recebida" = n_id_receb>0 (OMIE) OU em movimentacao(importacao) OU em
        -- movimentacao_legado (FR-011/FR-013 — mesmo critério da Parte B e da auto-desativação).
        -- Pedido sem filhote recebida (LEFT JOIN sem match) conta a quantidade cheia.
        SELECT pa.produto_codigo_acxe, SUM(pa.saldo_kg)::numeric AS pendente_importacao_kg
        FROM (
          SELECT
            ped.produto_codigo_acxe,
            GREATEST(ped.qtde_pedido - COALESCE(rec.recebido_kg, 0), 0) AS saldo_kg
          FROM (
            -- qtde do pedido por (mapa, produto), somando múltiplas linhas do mesmo produto
            SELECT mapa.id AS mapa_id, pc.ncodprod AS produto_codigo_acxe,
                   SUM(pc.nqtde)::numeric AS qtde_pedido
            FROM stockbridge.nf_pedido_mapa mapa
            JOIN public."tbl_pedidosCompras_ACXE" pc ON pc.cnumero = mapa.pedido_acxe_omie
            WHERE mapa.ativo = true AND pc.nqtde > 0 AND $4::bool = true
            GROUP BY mapa.id, pc.ncodprod
          ) ped
          LEFT JOIN (
            -- Σ q_com das filhotes JÁ RECEBIDAS, por (mapa, produto)
            SELECT f.mapa_id, i.n_cod_prod AS ncodprod, SUM(i.q_com)::numeric AS recebido_kg
            FROM stockbridge.nf_pedido_filhote f
            JOIN public."tbl_nf_header_ACXE" h ON h.n_nf = LPAD(f.nf_filhote, 8, '0')
            JOIN public."tbl_nf_itens_ACXE" i  ON i.n_id_nf = h.n_id_nf
            WHERE f.ativo = true
              AND (
                h.n_id_receb > 0
                OR ${recebidaViaMovimentacaoSql("LPAD(f.nf_filhote, 8, '0')")}
                OR ${recebidaViaLegadoSql("LPAD(f.nf_filhote, 8, '0')")}
              )
            GROUP BY f.mapa_id, i.n_cod_prod
          ) rec ON rec.mapa_id = ped.mapa_id AND rec.ncodprod = ped.produto_codigo_acxe
        ) pa
        GROUP BY pa.produto_codigo_acxe

        UNION ALL

        -- Parte B: fallback CFOP 3.xxx para importacoes SEM mapa (retrocompatibilidade).
        -- Exclui NFs ja reconciliadas em movimentacao (Atlas) OU movimentacao_legado
        -- (migration MySQL) E NFs que sao mae OU filhote de QUALQUER mapa (Fix 4): mapa ativo
        -- = ja contado na Parte A; mapa inativo = pedido ja recebido — a NF mae (CFOP 3, que
        -- nunca recebe) vazaria como falsa pendencia se excluissemos apenas mapas ativos.
        SELECT i.n_cod_prod AS produto_codigo_acxe, SUM(i.q_com)::numeric AS pendente_importacao_kg
        FROM public."tbl_nf_header_ACXE" h
        JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
        WHERE $4::bool = true
          AND h.tp_nf = 0
          AND LEFT(i.cfop, 1) = '3'
          AND h.d_emi >= $3::date
          AND NOT ${recebidaViaMovimentacaoSql('h.n_nf')}
          AND NOT ${recebidaViaLegadoSql('h.n_nf')}
          AND NOT EXISTS (
            SELECT 1 FROM stockbridge.nf_pedido_mapa mapa
            WHERE LPAD(mapa.nf_mae, 8, '0') = h.n_nf
          )
          AND NOT EXISTS (
            SELECT 1 FROM stockbridge.nf_pedido_mapa mapa
            JOIN stockbridge.nf_pedido_filhote f ON f.mapa_id = mapa.id AND f.ativo = true
            WHERE LPAD(f.nf_filhote, 8, '0') = h.n_nf
          )
        GROUP BY i.n_cod_prod
      ) parts
      GROUP BY produto_codigo_acxe
    ),
    divs AS (
      SELECT l.produto_codigo_acxe, COUNT(*)::int AS c
      FROM stockbridge.divergencia d
      INNER JOIN stockbridge.lote l ON l.id = d.lote_id
      WHERE d.status = 'aberta' AND l.ativo = true
      GROUP BY l.produto_codigo_acxe
    ),
    apr AS (
      SELECT l.produto_codigo_acxe, COUNT(*)::int AS c
      FROM stockbridge.aprovacao a
      INNER JOIN stockbridge.lote l ON l.id = a.lote_id
      WHERE a.status = 'pendente' AND l.ativo = true
      GROUP BY l.produto_codigo_acxe
    ),
    universo AS (
      SELECT produto_codigo_acxe FROM fisico_omie
      UNION
      SELECT produto_codigo_acxe FROM transito_atlas
      UNION
      SELECT produto_codigo_acxe FROM comodato_omie
      UNION
      SELECT produto_codigo_acxe FROM provisorio_atlas
      UNION
      SELECT produto_codigo_acxe FROM fiscal_pend_nacional
      UNION
      SELECT produto_codigo_acxe FROM fiscal_pend_importacao
    )
    SELECT
      u.produto_codigo_acxe,
      COALESCE(p.descricao, 'Produto ' || u.produto_codigo_acxe::text) AS nome,
      p.descricao_familia AS familia,
      p.ncm,
      COALESCE(fo.fisica_kg, 0)                    AS fisica_kg,
      COALESCE(ta.aguardando_embarque_kg, 0)       AS aguardando_embarque_kg,
      COALESCE(ta.transito_intl_kg, 0)             AS transito_intl_kg,
      COALESCE(ta.no_porto_kg, 0)                  AS no_porto_kg,
      COALESCE(ta.transito_local_kg, 0)            AS transito_local_kg,
      COALESCE(ta.transito_interno_kg, 0)          AS transito_interno_kg,
      COALESCE(pv.provisorio_kg, 0)            AS provisorio_kg,
      COALESCE(cm.comodato_kg, 0)              AS comodato_kg,
      COALESCE(fpn.pendente_nacional_kg, 0)    AS pendente_nacional_kg,
      COALESCE(fpi.pendente_importacao_kg, 0)  AS pendente_importacao_kg,
      c.consumo_medio_diario_kg,
      c.lead_time_dias,
      COALESCE(d.c, 0) AS divs,
      COALESCE(a.c, 0) AS aprs
    FROM universo u
    LEFT JOIN fisico_omie fo             ON fo.produto_codigo_acxe    = u.produto_codigo_acxe
    LEFT JOIN transito_atlas ta          ON ta.produto_codigo_acxe    = u.produto_codigo_acxe
    LEFT JOIN comodato_omie cm           ON cm.produto_codigo_acxe    = u.produto_codigo_acxe
    LEFT JOIN provisorio_atlas pv        ON pv.produto_codigo_acxe    = u.produto_codigo_acxe
    LEFT JOIN fiscal_pend_nacional fpn   ON fpn.produto_codigo_acxe   = u.produto_codigo_acxe
    LEFT JOIN fiscal_pend_importacao fpi ON fpi.produto_codigo_acxe   = u.produto_codigo_acxe
    LEFT JOIN public."tbl_produtos_ACXE" p
      ON p.codigo_produto = u.produto_codigo_acxe
    LEFT JOIN stockbridge.familia_omie_atlas f
      ON f.familia_omie = p.descricao_familia
    LEFT JOIN stockbridge.config_produto c
      ON c.produto_codigo_acxe = u.produto_codigo_acxe
    LEFT JOIN divs d ON d.produto_codigo_acxe = u.produto_codigo_acxe
    LEFT JOIN apr  a ON a.produto_codigo_acxe = u.produto_codigo_acxe
    WHERE COALESCE(f.incluir_em_metricas, true) = true
      AND COALESCE(c.incluir_em_metricas, true) = true
      AND ($1::text[] IS NULL OR p.descricao_familia = ANY($1::text[]))
    ORDER BY COALESCE(p.descricao, u.produto_codigo_acxe::text)
  `;

  const params: unknown[] = [familias, galpoes, cutoffDate, incluirAcxe, incluirQ2p];

  let rows: Record<string, unknown>[] = [];
  try {
    const result = await pool.query(sql, params);
    rows = result.rows as Record<string, unknown>[];
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'Cockpit query falhou — retornando vazio',
    );
    rows = [];
  }

  const skus: CockpitSku[] = rows.map((r) => {
    const fisicaKg = Number(r.fisica_kg);
    const pendenteNacional = Number(r.pendente_nacional_kg);
    const pendenteImportacao = Number(r.pendente_importacao_kg);
    const consumoKg = r.consumo_medio_diario_kg != null ? Number(r.consumo_medio_diario_kg) : null;
    const leadTime = r.lead_time_dias != null ? Number(r.lead_time_dias) : null;
    const cobertura = calcularCobertura(fisicaKg, consumoKg);
    const criticidade = classificarCriticidade(cobertura, leadTime, fisicaKg, consumoKg);

    return {
      codigoAcxe: Number(r.produto_codigo_acxe),
      nome: String(r.nome),
      familia: (r.familia as string | null) ?? null,
      ncm: (r.ncm as string | null) ?? null,
      fisicaKg,
      fiscalKg: fisicaKg + pendenteNacional + pendenteImportacao,
      fiscalPendenteNacionalKg: pendenteNacional,
      fiscalPendenteImportacaoKg: pendenteImportacao,
      aguardandoEmbarqueKg: Number(r.aguardando_embarque_kg),
      transitoIntlKg: Number(r.transito_intl_kg),
      noPortoKg: Number(r.no_porto_kg),
      transitoLocalKg: Number(r.transito_local_kg),
      transitoInternoKg: Number(r.transito_interno_kg),
      provisorioKg: Number(r.provisorio_kg),
      comodatoKg: Number(r.comodato_kg),
      consumoMedioDiarioKg: consumoKg,
      leadTimeDias: leadTime,
      coberturaDias: cobertura,
      criticidade,
      divergencias: Number(r.divs),
      aprovacoesPendentes: Number(r.aprs),
    };
  });

  const skusFiltrados =
    filtros.criticidade && filtros.criticidade !== 'todas'
      ? skus.filter((s) => s.criticidade === filtros.criticidade)
      : skus;

  const resumo = getResumoFromSkus(skusFiltrados);
  return { resumo, skus: skusFiltrados };
}

export function getResumoFromSkus(skus: CockpitSku[]): CockpitResumo {
  let totalFisicoKg = 0;
  let totalFiscalKg = 0;
  let totalFiscalPendenteNacionalKg = 0;
  let totalFiscalPendenteImportacaoKg = 0;
  let aguardandoEmbarqueKg = 0;
  let transitoIntlKg = 0;
  let noPortoKg = 0;
  let transitoLocalKg = 0;
  let transitoInternoKg = 0;
  let provisorioKg = 0;
  let comodatoKg = 0;
  let divergenciasCount = 0;
  let aprovacoesPendentes = 0;
  let skusCriticos = 0;
  let skusAlerta = 0;
  let skusExcesso = 0;

  for (const s of skus) {
    totalFisicoKg += s.fisicaKg;
    totalFiscalKg += s.fiscalKg;
    totalFiscalPendenteNacionalKg += s.fiscalPendenteNacionalKg;
    totalFiscalPendenteImportacaoKg += s.fiscalPendenteImportacaoKg;
    aguardandoEmbarqueKg += s.aguardandoEmbarqueKg;
    transitoIntlKg += s.transitoIntlKg;
    noPortoKg += s.noPortoKg;
    transitoLocalKg += s.transitoLocalKg;
    transitoInternoKg += s.transitoInternoKg;
    provisorioKg += s.provisorioKg;
    comodatoKg += s.comodatoKg;
    divergenciasCount += s.divergencias;
    aprovacoesPendentes += s.aprovacoesPendentes;
    if (s.criticidade === 'critico') skusCriticos += 1;
    if (s.criticidade === 'alerta') skusAlerta += 1;
    if (s.criticidade === 'excesso') skusExcesso += 1;
  }

  return {
    totalFisicoKg,
    totalFiscalKg,
    totalFiscalPendenteNacionalKg,
    totalFiscalPendenteImportacaoKg,
    aguardandoEmbarqueKg,
    transitoIntlKg,
    noPortoKg,
    transitoLocalKg,
    transitoInternoKg,
    provisorioKg,
    comodatoKg,
    divergenciasCount,
    aprovacoesPendentes,
    skusCriticos,
    skusAlerta,
    skusExcesso,
  };
}
