import { getPool, getDb, createLogger } from '@atlas/core';
import { configMotor } from '@atlas/db';
import { eq } from 'drizzle-orm';

const logger = createLogger('hedge:estoque');

interface EstoqueFiltros {
  empresa?: 'acxe' | 'q2p';
}

interface EstoqueAgregado {
  localidade: string;
  empresa: string;
  origem: string;
  itens: number;
  valor_brl: number;
  custo_usd_estimado: number;
  ptax_ref: number;
}

export async function getEstoque(filtros: EstoqueFiltros = {}): Promise<EstoqueAgregado[]> {
  const pool = getPool();
  const db = getDb();

  // Load active localidades selection from config
  const [selRow] = await db.select().from(configMotor).where(eq(configMotor.chave, 'localidades_ativas')).limit(1);
  let localidadesAtivas: string[] | null = null;
  if (selRow?.valor) {
    try { localidadesAtivas = JSON.parse(String(selRow.valor)); } catch { /* null = all selected */ }
  }

  const conditions: string[] = [];
  const params: (string | string[])[] = [];
  let paramIdx = 1;

  if (filtros.empresa) {
    conditions.push(`empresa = $${paramIdx++}`);
    params.push(filtros.empresa);
  }

  if (localidadesAtivas !== null && localidadesAtivas.length > 0) {
    conditions.push(`local_descricao = ANY($${paramIdx++}::text[])`);
    params.push(localidadesAtivas);
  } else if (localidadesAtivas !== null && localidadesAtivas.length === 0) {
    // Explicit empty selection — return nothing
    return [];
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const query = `
    SELECT
      empresa,
      local_descricao AS localidade,
      origem,
      COUNT(*)::int AS itens,
      SUM(valor_total_brl)::numeric AS valor_brl,
      SUM(valor_total_usd)::numeric AS custo_usd_estimado,
      MAX(ptax_ref)::numeric AS ptax_ref
    FROM public.vw_hedge_estoque
    ${whereClause}
    GROUP BY empresa, local_descricao, origem
    ORDER BY empresa, valor_brl DESC
  `;

  const { rows } = await pool.query(query, params);

  logger.debug({ count: rows.length, empresa: filtros.empresa, localidades_ativas: localidadesAtivas?.length ?? 'all' }, 'Estoque loaded from vw_hedge_estoque');

  return rows.map((r: any) => ({
    localidade: r.localidade,
    empresa: r.empresa,
    origem: r.origem,
    itens: r.itens,
    valor_brl: Number(r.valor_brl),
    custo_usd_estimado: Number(r.custo_usd_estimado),
    ptax_ref: Number(r.ptax_ref),
  }));
}

export interface LocalidadeInfo {
  localidade: string;
  empresa: string;
  origem: string;
  valor_brl: number;
  itens: number;
  selecionada: boolean;
  em_transito: boolean;
}

export async function getLocalidades(): Promise<{ localidades: LocalidadeInfo[]; total: number; valor_total: number }> {
  const pool = getPool();
  const db = getDb();

  // Load saved selection
  const [selRow] = await db.select().from(configMotor).where(eq(configMotor.chave, 'localidades_ativas')).limit(1);
  let selList: string[] | null = null;
  if (selRow?.valor) {
    try { selList = JSON.parse(String(selRow.valor)); } catch { /* all selected */ }
  }

  const { rows } = await pool.query(`
    SELECT
      local_descricao AS localidade,
      empresa,
      origem,
      COUNT(*)::int AS itens,
      SUM(valor_total_brl)::numeric AS valor_brl
    FROM public.vw_hedge_estoque
    GROUP BY local_descricao, empresa, origem
    ORDER BY empresa, valor_brl DESC
  `);

  const localidades: LocalidadeInfo[] = rows.map((r: any) => ({
    localidade: r.localidade,
    empresa: r.empresa,
    origem: r.origem === 'importado_no_chao' ? 'importado' : r.origem === 'em_transito' ? 'importado' : 'nacional',
    valor_brl: Number(r.valor_brl),
    itens: r.itens,
    selecionada: selList === null ? true : selList.includes(r.localidade),
    em_transito: r.origem === 'em_transito',
  }));

  const total = localidades.length;
  const valor_total = localidades.reduce((s, l) => s + l.valor_brl, 0);

  return { localidades, total, valor_total };
}

export async function salvarLocalidadesAtivas(localidades: string[]): Promise<void> {
  const db = getDb();
  const valor = JSON.stringify(localidades);
  const [existing] = await db.select().from(configMotor).where(eq(configMotor.chave, 'localidades_ativas')).limit(1);
  if (existing) {
    await db.update(configMotor).set({ valor }).where(eq(configMotor.chave, 'localidades_ativas'));
  } else {
    await db.insert(configMotor).values({ chave: 'localidades_ativas', valor, descricao: 'Localidades de estoque ativas para cálculo' });
  }
}
