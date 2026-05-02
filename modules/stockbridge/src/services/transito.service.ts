import { sql } from 'drizzle-orm';
import { getDb, getPool, createLogger } from '@atlas/core';
import { ESTAGIOS_VISIVEIS_POR_PERFIL, type EstagioTransito, type Perfil } from '../types.js';

const logger = createLogger('stockbridge:transito');

/**
 * Refresh com TTL de 15min. Le FUP × pedidosCompras_ACXE e UPSERT em lote
 * (status=transito). Se MAX(updated_at) > 15min, no-op (zero overhead).
 * Falha silenciosa: loga warn e continua com dados stale (nao bloqueia GET).
 */
async function refreshLotesEmTransito(): Promise<void> {
  const db = getDb();
  try {
    const result = await db.execute(
      sql`SELECT stockbridge.refresh_lotes_em_transito_se_stale(15) AS atualizados`,
    );
    const atualizados = (result.rows[0] as { atualizados: number } | undefined)?.atualizados ?? 0;
    if (atualizados > 0) {
      logger.info({ atualizados }, 'Lotes em trânsito recalculados a partir do FUP');
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'Refresh de lotes em trânsito falhou — usando dados stale',
    );
  }
}

export interface LoteTransitoItem {
  id: string;
  codigo: string;
  produtoCodigoAcxe: number;
  fornecedorNome: string;
  paisOrigem: string | null;
  quantidadeFisicaKg: number;
  quantidadeFiscalKg: number;
  custoBrlKg: number | null;
  cnpj: string;
  estagioTransito: EstagioTransito;
  localidadeCodigo: string | null;
  di: string | null;
  dta: string | null;
  notaFiscal: string | null;
  dtPrevChegada: string | null;

  // Campos extras vindos diretamente do FUP de Comex
  pedidoComprasAcxe: string | null;
  protocoloDi: string | null;
  despachante: string | null;
  terminalAtracacao: string | null;
  numeroBl: string | null;
  dataBl: string | null;
  etd: string | null;
  eta: string | null;
  dataDesembarque: string | null;
  dataLiberacaoTransporte: string | null;
  dataEntradaArmazem: string | null;
  lsd: string | null;
  freeTime: number | null;
  etapaFup: string | null;
}

/**
 * Lista lotes em transito agrupados por estagio, respeitando visibilidade por perfil (FR-006).
 *   - operador:          transito_interno, reservado
 *   - gestor / diretor:  todos os 4 estagios
 *
 * Faz JOIN com tbl_dadosPlanilhaFUPComex pra trazer campos do FUP direto da fonte —
 * o modulo Trânsito e puramente espelho de leitura da planilha de Comex.
 *
 * Flag `atrasado` e true quando dt_prev_chegada < now() e lote ainda em transito.
 */
export async function listarPorEstagio(perfil: Perfil): Promise<Record<EstagioTransito, LoteTransitoItem[]>> {
  await refreshLotesEmTransito();

  const pool = getPool();
  const estagios = ESTAGIOS_VISIVEIS_POR_PERFIL[perfil];

  if (estagios.length === 0) {
    return { transito_intl: [], porto_dta: [], transito_interno: [], reservado: [] };
  }
  // 'reservado' segue no enum por compatibilidade mas nao e mais populado nem exposto.

  const placeholders = estagios.map((_, i) => `$${i + 1}`).join(',');
  const res = await pool
    .query(
      `
      SELECT
        l.id, l.codigo, l.produto_codigo_acxe, l.fornecedor_nome, l.pais_origem,
        l.quantidade_fisica_kg, l.quantidade_fiscal_kg, l.custo_brl_kg, l.cnpj,
        l.estagio_transito, l.di, l.dta, l.nota_fiscal, l.dt_prev_chegada,
        l.pedido_compra_acxe,
        loc.codigo AS localidade_codigo,
        fup.protocolo_di,
        fup.despachante,
        fup.terminal_atracacao,
        fup.numero_bl,
        fup.data_bl,
        fup.etd,
        fup.eta,
        fup.data_desembarque,
        fup.data_liberacao_transporte,
        fup.data_entrada_armazem,
        fup.lsd,
        fup.free_time,
        fup.etapa AS etapa_fup
      FROM stockbridge.lote l
      LEFT JOIN stockbridge.localidade loc ON loc.id = l.localidade_id
      LEFT JOIN public."tbl_dadosPlanilhaFUPComex" fup ON fup.pedido_acxe_omie = l.pedido_compra_acxe
      WHERE l.ativo = true
        AND l.estagio_transito IN (${placeholders})
      ORDER BY fup.eta NULLS LAST, l.codigo
      `,
      estagios,
    )
    .catch((err) => {
      logger.warn({ err: err.message }, 'Query de transito falhou');
      return { rows: [] };
    });

  const agrupado: Record<EstagioTransito, LoteTransitoItem[]> = {
    transito_intl: [],
    porto_dta: [],
    transito_interno: [],
    reservado: [],
  };

  for (const r of res.rows as Array<Record<string, unknown>>) {
    const estagio = r.estagio_transito as EstagioTransito | null;
    if (!estagio) continue;

    agrupado[estagio].push({
      id: r.id as string,
      codigo: r.codigo as string,
      produtoCodigoAcxe: Number(r.produto_codigo_acxe),
      fornecedorNome: r.fornecedor_nome as string,
      paisOrigem: (r.pais_origem as string | null) ?? null,
      quantidadeFisicaKg: Number(r.quantidade_fisica_kg),
      quantidadeFiscalKg: Number(r.quantidade_fiscal_kg),
      custoBrlKg: r.custo_brl_kg != null ? Number(r.custo_brl_kg) : null,
      cnpj: r.cnpj as string,
      estagioTransito: estagio,
      localidadeCodigo: (r.localidade_codigo as string | null) ?? null,
      di: (r.di as string | null) ?? null,
      dta: (r.dta as string | null) ?? null,
      notaFiscal: (r.nota_fiscal as string | null) ?? null,
      dtPrevChegada: formatDate(r.dt_prev_chegada),
      pedidoComprasAcxe: (r.pedido_compra_acxe as string | null) ?? null,
      protocoloDi: (r.protocolo_di as string | null) ?? null,
      despachante: (r.despachante as string | null) ?? null,
      terminalAtracacao: (r.terminal_atracacao as string | null) ?? null,
      numeroBl: (r.numero_bl as string | null) ?? null,
      dataBl: formatDate(r.data_bl),
      etd: formatDate(r.etd),
      eta: formatDate(r.eta),
      dataDesembarque: formatDate(r.data_desembarque),
      dataLiberacaoTransporte: formatDate(r.data_liberacao_transporte),
      dataEntradaArmazem: formatDate(r.data_entrada_armazem),
      lsd: formatDate(r.lsd),
      freeTime: r.free_time != null ? Number(r.free_time) : null,
      etapaFup: (r.etapa_fup as string | null) ?? null,
    });
  }

  return agrupado;
}

function formatDate(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}
