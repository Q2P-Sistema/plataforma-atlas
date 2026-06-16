import { getPool, createLogger, getConfig } from '@atlas/core';

const logger = createLogger('stockbridge:pendencias-fiscais');

/**
 * Aba "Pendências Fiscais" (US4 / ACXEGDP-183) — somente leitura, escopo importação.
 * Detalha, por pedido com mapa NF mãe/filhote, o que foi e o que não foi recebido
 * (e por qual fonte), o aging (exoneração + filhotes) e o sinal de inconsistência
 * "chegou — NF aberta" (FR-015). Inclui a seção de importações sem mapa (Parte B / Fix 4).
 *
 * "Recebida" segue a mesma definição do cockpit (FR-011/FR-013): n_id_receb>0 (OMIE) OU
 * stockbridge.movimentacao (subtipo='importacao') OU stockbridge.movimentacao_legado.
 */

export type FonteRecebimento = 'omie' | 'movimentacao' | 'movimentacao_legado' | null;
export type StatusPendencia = 'recebida' | 'parcial' | 'pendente';

export interface FilhoteItem {
  nfFilhote: string;
  posicao: number;
  qtdeKg: number;
  recebida: boolean;
  fonteRecebimento: FonteRecebimento;
  nfEmitida: boolean;
  diasDesdeEmissao: number | null;
}

export interface PedidoPendencia {
  pedidoAcxeOmie: string;
  nfMae: string;
  qtdePedidoKg: number;
  recebidoKg: number;
  saldoPendenteKg: number;
  statusAgregado: StatusPendencia;
  exoneracaoDataEntrada: string | null;
  diasEmExoneracao: number | null;
  estagioFup: string | null;
  loteEmTransito: boolean;
  inconsistencia: boolean;
  filhotes: FilhoteItem[];
}

export interface ImportacaoSemMapa {
  notaFiscal: string;
  produtoCodigoAcxe: number | null;
  produtoNome: string | null;
  qtdeKg: number;
  cfop: string | null;
  dataEmissao: string | null;
  emMetricas: boolean;
}

export interface PendenciasFiscaisResumo {
  totalPedidos: number;
  totalSaldoPendenteKg: number;
  totalInconsistencias: number;
  totalSemMapaKg: number;
}

export interface PendenciasFiscaisData {
  pedidos: PedidoPendencia[];
  semMapa: ImportacaoSemMapa[];
  resumo: PendenciasFiscaisResumo;
}

export interface PendenciasFiscaisFiltros {
  status?: StatusPendencia | 'todas';
  incluirMetricas?: boolean;
}

interface PedidoRow {
  mapa_id: string;
  pedido_acxe_omie: string;
  nf_mae: string;
  mae_emissao: string | null;
  dias_exoneracao: number | null;
  qtde_pedido_kg: number | null;
  estagio_fup: string | null;
  lote_em_transito: boolean;
}

interface FilhoteRow {
  pedido_acxe_omie: string;
  nf_filhote: string;
  posicao: number;
  filhote_qtde_kg: number | null;
  dias_desde_emissao: number | null;
  nf_emitida: boolean;
  receb_omie: boolean;
  in_mov: boolean;
  in_legado: boolean;
}

interface SemMapaRow {
  nota_fiscal: string;
  produto: string | number | null;
  produto_nome: string | null;
  qtde_kg: number | null;
  cfop: string | null;
  data_emissao: string | null;
  em_metricas: boolean;
}

export async function getPendenciasFiscais(
  filtros: PendenciasFiscaisFiltros = {},
): Promise<PendenciasFiscaisData> {
  const pool = getPool();
  const config = getConfig();
  const incluirMetricas = filtros.incluirMetricas ?? false;
  const statusFiltro = filtros.status ?? 'todas';

  // Cutoff fiscal — mesma regra do cockpit (env ou 180 dias atrás).
  const cutoffDate =
    config.STOCKBRIDGE_FISCAL_CUTOFF_DATE ??
    (() => {
      const d = new Date();
      d.setDate(d.getDate() - 180);
      return d.toISOString().slice(0, 10);
    })();

  const empty: PendenciasFiscaisData = {
    pedidos: [],
    semMapa: [],
    resumo: { totalPedidos: 0, totalSaldoPendenteKg: 0, totalInconsistencias: 0, totalSemMapaKg: 0 },
  };

  try {
    // 1) Cabeçalho por pedido com mapa ativo: NF mãe + data exoneração + qtde do pedido + FUP.
    const pedidosRes = await pool.query<PedidoRow>(`
      SELECT
        mapa.id::text                              AS mapa_id,
        mapa.pedido_acxe_omie                      AS pedido_acxe_omie,
        mapa.nf_mae                                AS nf_mae,
        hm.d_emi::text                             AS mae_emissao,
        CASE WHEN hm.d_emi IS NOT NULL THEN (CURRENT_DATE - hm.d_emi::date) END AS dias_exoneracao,
        ped.qtde_pedido::float8                    AS qtde_pedido_kg,
        lote.estagio_fup                           AS estagio_fup,
        lote.lote_em_transito                      AS lote_em_transito
      FROM stockbridge.nf_pedido_mapa mapa
      LEFT JOIN public."tbl_nf_header_ACXE" hm ON hm.n_nf = LPAD(mapa.nf_mae, 8, '0')
      LEFT JOIN LATERAL (
        SELECT SUM(pc.nqtde)::numeric AS qtde_pedido
        FROM public."tbl_pedidosCompras_ACXE" pc
        WHERE pc.cnumero = mapa.pedido_acxe_omie AND pc.nqtde > 0
      ) ped ON true
      LEFT JOIN LATERAL (
        SELECT
          (SELECT l.estagio_transito FROM stockbridge.lote l
             WHERE l.pedido_compra_acxe::text = mapa.pedido_acxe_omie AND l.ativo = true
             ORDER BY l.updated_at DESC LIMIT 1) AS estagio_fup,
          EXISTS (SELECT 1 FROM stockbridge.lote l
                  WHERE l.pedido_compra_acxe::text = mapa.pedido_acxe_omie
                    AND l.ativo = true AND l.status = 'transito') AS lote_em_transito
      ) lote ON true
      WHERE mapa.ativo = true
      ORDER BY mapa.pedido_acxe_omie
    `);

    // 2) Filhotes (ativas) de cada mapa ativo: qtde (Σ q_com), recebimento por fonte, aging.
    const filhotesRes = await pool.query<FilhoteRow>(`
      SELECT
        mapa.pedido_acxe_omie                      AS pedido_acxe_omie,
        f.nf_filhote                               AS nf_filhote,
        f.posicao                                  AS posicao,
        (SELECT SUM(i.q_com) FROM public."tbl_nf_itens_ACXE" i WHERE i.n_id_nf = hf.n_id_nf)::float8 AS filhote_qtde_kg,
        CASE WHEN hf.d_emi IS NOT NULL THEN (CURRENT_DATE - hf.d_emi::date) END AS dias_desde_emissao,
        (hf.n_id_nf IS NOT NULL)                   AS nf_emitida,
        (hf.n_id_receb > 0)                        AS receb_omie,
        EXISTS (SELECT 1 FROM stockbridge.movimentacao m
                WHERE m.ativo = true AND m.subtipo = 'importacao'
                  AND m.nota_fiscal = LPAD(f.nf_filhote, 8, '0')) AS in_mov,
        EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml
                WHERE ml.ativo = true AND ml.nota_fiscal = LPAD(f.nf_filhote, 8, '0')) AS in_legado
      FROM stockbridge.nf_pedido_mapa mapa
      JOIN stockbridge.nf_pedido_filhote f ON f.mapa_id = mapa.id AND f.ativo = true
      LEFT JOIN public."tbl_nf_header_ACXE" hf ON hf.n_nf = LPAD(f.nf_filhote, 8, '0')
      WHERE mapa.ativo = true
      ORDER BY mapa.pedido_acxe_omie, f.posicao
    `);

    // 3) Importações SEM mapa (Parte B / Fix 4): CFOP 3.xxx não reconciliado, não-mãe/filhote.
    const semMapaRes = await pool.query<SemMapaRow>(
      `
      SELECT
        h.n_nf                                     AS nota_fiscal,
        i.n_cod_prod                               AS produto,
        pa.descricao                               AS produto_nome,
        SUM(i.q_com)::float8                        AS qtde_kg,
        MIN(i.cfop)                                AS cfop,
        h.d_emi::text                              AS data_emissao,
        (COALESCE(fam.incluir_em_metricas, true) AND COALESCE(cfg.incluir_em_metricas, true)) AS em_metricas
      FROM public."tbl_nf_header_ACXE" h
      JOIN public."tbl_nf_itens_ACXE" i ON i.n_id_nf = h.n_id_nf
      LEFT JOIN public."tbl_produtos_ACXE" pa ON pa.codigo_produto = i.n_cod_prod
      LEFT JOIN stockbridge.familia_omie_atlas fam ON fam.familia_omie = pa.descricao_familia
      LEFT JOIN stockbridge.config_produto cfg ON cfg.produto_codigo_acxe = i.n_cod_prod
      WHERE h.tp_nf = 0 AND LEFT(i.cfop, 1) = '3' AND h.d_emi >= $1::date
        AND NOT EXISTS (SELECT 1 FROM stockbridge.movimentacao m
                        WHERE m.ativo = true AND m.subtipo = 'importacao' AND m.nota_fiscal = h.n_nf)
        AND NOT EXISTS (SELECT 1 FROM stockbridge.movimentacao_legado ml
                        WHERE ml.ativo = true AND ml.nota_fiscal = h.n_nf)
        AND NOT EXISTS (SELECT 1 FROM stockbridge.nf_pedido_mapa mapa
                        WHERE LPAD(mapa.nf_mae, 8, '0') = h.n_nf)
        AND NOT EXISTS (SELECT 1 FROM stockbridge.nf_pedido_mapa mapa
                        JOIN stockbridge.nf_pedido_filhote f ON f.mapa_id = mapa.id AND f.ativo = true
                        WHERE LPAD(f.nf_filhote, 8, '0') = h.n_nf)
      GROUP BY h.n_nf, i.n_cod_prod, pa.descricao, h.d_emi, fam.incluir_em_metricas, cfg.incluir_em_metricas
      ORDER BY h.d_emi, h.n_nf
    `,
      [cutoffDate],
    );

    // --- Montagem ---
    const filhotesByPedido = new Map<string, FilhoteItem[]>();
    const recebidoByPedido = new Map<string, number>();
    for (const r of filhotesRes.rows) {
      const recebida = r.receb_omie || r.in_mov || r.in_legado;
      const fonte: FonteRecebimento = r.receb_omie
        ? 'omie'
        : r.in_mov
          ? 'movimentacao'
          : r.in_legado
            ? 'movimentacao_legado'
            : null;
      const qtde = r.filhote_qtde_kg != null ? Number(r.filhote_qtde_kg) : 0;
      const item: FilhoteItem = {
        nfFilhote: r.nf_filhote,
        posicao: Number(r.posicao),
        qtdeKg: qtde,
        recebida,
        fonteRecebimento: fonte,
        nfEmitida: r.nf_emitida,
        diasDesdeEmissao: r.dias_desde_emissao != null ? Number(r.dias_desde_emissao) : null,
      };
      const arr = filhotesByPedido.get(r.pedido_acxe_omie) ?? [];
      arr.push(item);
      filhotesByPedido.set(r.pedido_acxe_omie, arr);
      if (recebida) {
        recebidoByPedido.set(r.pedido_acxe_omie, (recebidoByPedido.get(r.pedido_acxe_omie) ?? 0) + qtde);
      }
    }

    let pedidos: PedidoPendencia[] = pedidosRes.rows.map((r) => {
      const filhotes = filhotesByPedido.get(r.pedido_acxe_omie) ?? [];
      const qtdePedido = r.qtde_pedido_kg != null ? Number(r.qtde_pedido_kg) : 0;
      const recebido = recebidoByPedido.get(r.pedido_acxe_omie) ?? 0;
      const saldo = Math.max(qtdePedido - recebido, 0);
      const statusAgregado: StatusPendencia =
        saldo <= 0.0001 ? 'recebida' : recebido <= 0.0001 ? 'pendente' : 'parcial';
      // FR-015: inconsistência "chegou — NF aberta" = ≥1 filhote com NF emitida e não recebida,
      // e o pedido não está mais em trânsito no FUP.
      const inconsistencia =
        !r.lote_em_transito && filhotes.some((f) => f.nfEmitida && !f.recebida);
      return {
        pedidoAcxeOmie: r.pedido_acxe_omie,
        nfMae: r.nf_mae,
        qtdePedidoKg: qtdePedido,
        recebidoKg: recebido,
        saldoPendenteKg: saldo,
        statusAgregado,
        exoneracaoDataEntrada: r.mae_emissao,
        diasEmExoneracao: r.dias_exoneracao != null ? Number(r.dias_exoneracao) : null,
        estagioFup: r.estagio_fup,
        loteEmTransito: r.lote_em_transito,
        inconsistencia,
        filhotes,
      };
    });

    if (statusFiltro !== 'todas') {
      pedidos = pedidos.filter((p) => p.statusAgregado === statusFiltro);
    }

    const semMapa: ImportacaoSemMapa[] = semMapaRes.rows
      .filter((r) => incluirMetricas || r.em_metricas)
      .map((r) => ({
        notaFiscal: r.nota_fiscal,
        produtoCodigoAcxe: r.produto != null ? Number(r.produto) : null,
        produtoNome: r.produto_nome,
        qtdeKg: r.qtde_kg != null ? Number(r.qtde_kg) : 0,
        cfop: r.cfop,
        dataEmissao: r.data_emissao,
        emMetricas: r.em_metricas,
      }));

    const resumo: PendenciasFiscaisResumo = {
      totalPedidos: pedidos.length,
      totalSaldoPendenteKg: pedidos.reduce((s, p) => s + p.saldoPendenteKg, 0),
      totalInconsistencias: pedidos.filter((p) => p.inconsistencia).length,
      totalSemMapaKg: semMapa.reduce((s, n) => s + n.qtdeKg, 0),
    };

    return { pedidos, semMapa, resumo };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'getPendenciasFiscais falhou — retornando vazio');
    return empty;
  }
}
