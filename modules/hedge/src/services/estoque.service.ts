import { getPool, getDb, createLogger } from '@atlas/core';
import { configMotor } from '@atlas/db';
import { eq } from 'drizzle-orm';

const logger = createLogger('hedge:estoque');

/**
 * MOD-15 (ACXEGDP-278): a selecao era gravada como JSON.stringify em coluna
 * JSONB (string dupla-serializada). Agora grava o array nativo; a leitura
 * aceita os dois formatos (bancos com o valor legado seguem funcionando).
 */
function lerLocalidadesAtivas(valor: unknown): string[] | null {
  if (Array.isArray(valor)) return valor as string[];
  if (typeof valor === 'string') {
    try {
      const parsed = JSON.parse(valor) as unknown;
      return Array.isArray(parsed) ? (parsed as string[]) : null;
    } catch {
      return null; // null = todas selecionadas
    }
  }
  return null;
}

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
  const localidadesAtivas = lerLocalidadesAtivas(selRow?.valor);

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
  const selList = lerLocalidadesAtivas(selRow?.valor);

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
  // Array jsonb nativo (MOD-15) + upsert atomico na PK (chave) — o SELECT+branch
  // anterior tinha corrida de insert duplicado.
  await db
    .insert(configMotor)
    .values({
      chave: 'localidades_ativas',
      valor: localidades,
      descricao: 'Localidades de estoque ativas para cálculo',
    })
    .onConflictDoUpdate({
      target: configMotor.chave,
      set: { valor: localidades, updatedAt: new Date() },
    });
}
