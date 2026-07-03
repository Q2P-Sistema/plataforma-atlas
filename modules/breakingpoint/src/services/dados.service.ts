import { sql } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';

const logger = createLogger('breakingpoint:dados');

const EMPRESA_TABLE: Record<string, { contasCorrentes: string; contasPagar: string; contasReceber: string }> = {
  acxe: {
    contasCorrentes: 'tbl_contasCorrentes_ACXE',
    contasPagar: 'tbl_contasPagar_ACXE',
    contasReceber: 'tbl_contasReceber_ACXE',
  },
  q2p: {
    contasCorrentes: 'tbl_contasCorrentes_Q2P',
    contasPagar: 'tbl_contasPagar_Q2P',
    contasReceber: 'tbl_contasReceber_Q2P',
  },
};

export interface ContaCorrenteRow {
  n_cod_cc: number;
  descricao: string;
  codigo_banco: string | null;
  saldo_atual: number;
  incluir: boolean;
}

export interface SemanaValor {
  semana: number;
  total: number;
}

export interface SemanaPagamento extends SemanaValor {
  finimp_total: number;
}

export interface DadosBase {
  saldo_cc: number;
  dup_total: number;
  estoque_custo_brl: number;
  finimp_saldo: number;
  finimp_amort_mensal: number;
  pagamentos_semanais: SemanaPagamento[];
  recebimentos_semanais: SemanaValor[];
  contas_ativas_count: number;
  contas_excluidas_count: number;
}

/**
 * Retorna saldo CC somando contas correntes ativas (inativo='N' AND bloqueado='N'),
 * respeitando toggle em bp_contas_config (contas sem registro entram por default).
 */
export async function getSaldoCC(empresa: 'acxe' | 'q2p'): Promise<{ total: number; ativas: number; excluidas: number }> {
  const db = getDb();
  const tables = EMPRESA_TABLE[empresa];
  if (!tables) throw new Error(`Empresa inválida: ${empresa}`);

  const result = await db.execute<{
    total: string | number;
    ativas: string | number;
    excluidas: string | number;
  }>(sql.raw(`
    SELECT
      COALESCE(SUM(CASE WHEN COALESCE(cc.incluir, true) THEN cc.saldo_inicial ELSE 0 END), 0) AS total,
      COUNT(*) FILTER (WHERE COALESCE(cc.incluir, true)) AS ativas,
      COUNT(*) FILTER (WHERE cc.incluir IS FALSE) AS excluidas
    FROM (
      SELECT t."nCodCC" AS n_cod_cc, t.saldo_inicial, c.incluir
      FROM public."${tables.contasCorrentes}" t
      LEFT JOIN breakingpoint.bp_contas_config c
        ON c.n_cod_cc = t."nCodCC" AND c.empresa = '${empresa}'
      WHERE t.inativo = 'N' AND t.bloqueado = 'N'
    ) cc
  `));

  const row = result.rows[0]!;
  return {
    total: Number(row.total) || 0,
    ativas: Number(row.ativas) || 0,
    excluidas: Number(row.excluidas) || 0,
  };
}

/**
 * Lista contas correntes com saldo e toggle (para a aba Configurar).
 */
export async function listContas(empresa: 'acxe' | 'q2p'): Promise<ContaCorrenteRow[]> {
  const db = getDb();
  const tables = EMPRESA_TABLE[empresa];
  if (!tables) throw new Error(`Empresa inválida: ${empresa}`);

  const result = await db.execute<{
    n_cod_cc: string | number;
    descricao: string;
    codigo_banco: string | null;
    saldo_atual: string | number;
    incluir: boolean | null;
  }>(sql.raw(`
    SELECT
      t."nCodCC"::text AS n_cod_cc,
      t.descricao,
      t.codigo_banco,
      COALESCE(t.saldo_inicial, 0) AS saldo_atual,
      c.incluir
    FROM public."${tables.contasCorrentes}" t
    LEFT JOIN breakingpoint.bp_contas_config c
      ON c.n_cod_cc = t."nCodCC" AND c.empresa = '${empresa}'
    WHERE t.inativo = 'N' AND t.bloqueado = 'N'
    ORDER BY t.descricao
  `));

  return result.rows.map((r) => ({
    n_cod_cc: Number(r.n_cod_cc),
    descricao: r.descricao,
    codigo_banco: r.codigo_banco,
    saldo_atual: Number(r.saldo_atual) || 0,
    incluir: r.incluir === null ? true : r.incluir,
  }));
}

/**
 * Total de duplicatas (contas a receber) em aberto.
 */
export async function getDupTotal(empresa: 'acxe' | 'q2p'): Promise<number> {
  const db = getDb();
  const tables = EMPRESA_TABLE[empresa];
  if (!tables) throw new Error(`Empresa inválida: ${empresa}`);

  const result = await db.execute<{ total: string | number }>(sql.raw(`
    SELECT COALESCE(SUM(valor_documento), 0) AS total
    FROM public."${tables.contasReceber}"
    WHERE status_titulo = ANY(ARRAY['A VENCER','ATRASADO','VENCE HOJE'])
  `));
  return Number(result.rows[0]?.total) || 0;
}

/**
 * Pagamentos semanais das próximas N semanas (indexado por semana 0..N-1).
 */
export async function getPagamentosSemanais(
  empresa: 'acxe' | 'q2p',
  catFinimpCod: string | null,
  semanas = 26,
): Promise<SemanaPagamento[]> {
  const db = getDb();
  const tables = EMPRESA_TABLE[empresa];
  if (!tables) throw new Error(`Empresa inválida: ${empresa}`);

  const finimpMatch = catFinimpCod
    ? `CASE WHEN codigo_categoria = '${catFinimpCod.replace(/'/g, "''")}' THEN valor_documento ELSE 0 END`
    : '0';

  const result = await db.execute<{
    semana: string | number;
    total: string | number;
    finimp_total: string | number;
  }>(sql.raw(`
    SELECT
      FLOOR((data_vencimento - CURRENT_DATE) / 7.0)::int AS semana,
      COALESCE(SUM(valor_documento), 0) AS total,
      COALESCE(SUM(${finimpMatch}), 0) AS finimp_total
    FROM public."${tables.contasPagar}"
    WHERE status_titulo = ANY(ARRAY['A VENCER','ATRASADO','VENCE HOJE'])
      -- inclui vencidos (venc < hoje): sem limite inferior, o clamp Math.max(0, semana)
      -- abaixo agrega os atrasados na semana 0 (pressao de caixa imediata) — MOD-03.
      AND data_vencimento <= CURRENT_DATE + ${semanas * 7}
    GROUP BY 1
    ORDER BY 1
  `));

  const byWeek = new Map<number, { total: number; finimp: number }>();
  for (const r of result.rows) {
    const w = Math.max(0, Number(r.semana));
    const cur = byWeek.get(w) ?? { total: 0, finimp: 0 };
    cur.total += Number(r.total) || 0;
    cur.finimp += Number(r.finimp_total) || 0;
    byWeek.set(w, cur);
  }

  const out: SemanaPagamento[] = [];
  for (let w = 0; w < semanas; w++) {
    const cur = byWeek.get(w) ?? { total: 0, finimp: 0 };
    out.push({ semana: w, total: cur.total, finimp_total: cur.finimp });
  }
  return out;
}

/**
 * Recebimentos semanais das próximas N semanas.
 */
export async function getRecebimentosSemanais(
  empresa: 'acxe' | 'q2p',
  semanas = 26,
): Promise<SemanaValor[]> {
  const db = getDb();
  const tables = EMPRESA_TABLE[empresa];
  if (!tables) throw new Error(`Empresa inválida: ${empresa}`);

  const result = await db.execute<{ semana: string | number; total: string | number }>(sql.raw(`
    SELECT
      FLOOR((data_vencimento - CURRENT_DATE) / 7.0)::int AS semana,
      COALESCE(SUM(valor_documento), 0) AS total
    FROM public."${tables.contasReceber}"
    WHERE status_titulo = ANY(ARRAY['A VENCER','ATRASADO','VENCE HOJE'])
      -- inclui vencidos (venc < hoje): sem limite inferior, o clamp Math.max(0, semana)
      -- abaixo agrega os atrasados na semana 0 — consistente com getDupTotal — MOD-03.
      AND data_vencimento <= CURRENT_DATE + ${semanas * 7}
    GROUP BY 1
    ORDER BY 1
  `));

  const byWeek = new Map<number, number>();
  for (const r of result.rows) {
    const w = Math.max(0, Number(r.semana));
    byWeek.set(w, (byWeek.get(w) ?? 0) + (Number(r.total) || 0));
  }

  const out: SemanaValor[] = [];
  for (let w = 0; w < semanas; w++) {
    out.push({ semana: w, total: byWeek.get(w) ?? 0 });
  }
  return out;
}

/**
 * Saldo devedor FINIMP = soma de títulos a pagar com categoria FINIMP em aberto.
 * Retorna 0 se cat_finimp_cod está nulo (config incompleta).
 */
export async function getFinimpSaldo(
  empresa: 'acxe' | 'q2p',
  catFinimpCod: string | null,
): Promise<number> {
  if (!catFinimpCod) return 0;
  const db = getDb();
  const tables = EMPRESA_TABLE[empresa];
  if (!tables) throw new Error(`Empresa inválida: ${empresa}`);

  const cod = catFinimpCod.replace(/'/g, "''");
  const result = await db.execute<{ total: string | number }>(sql.raw(`
    SELECT COALESCE(SUM(valor_documento), 0) AS total
    FROM public."${tables.contasPagar}"
    WHERE status_titulo = ANY(ARRAY['A VENCER','ATRASADO','VENCE HOJE'])
      AND codigo_categoria = '${cod}'
  `));
  return Number(result.rows[0]?.total) || 0;
}

/**
 * Amortização mensal de FINIMP = soma dos FINIMP vencendo no mês corrente.
 */
export async function getFinimpAmortMensal(
  empresa: 'acxe' | 'q2p',
  catFinimpCod: string | null,
): Promise<number> {
  if (!catFinimpCod) return 0;
  const db = getDb();
  const tables = EMPRESA_TABLE[empresa];
  if (!tables) throw new Error(`Empresa inválida: ${empresa}`);

  const cod = catFinimpCod.replace(/'/g, "''");
  const result = await db.execute<{ total: string | number }>(sql.raw(`
    SELECT COALESCE(SUM(valor_documento), 0) AS total
    FROM public."${tables.contasPagar}"
    WHERE status_titulo = ANY(ARRAY['A VENCER','ATRASADO','VENCE HOJE'])
      AND codigo_categoria = '${cod}'
      AND data_vencimento BETWEEN date_trunc('month', CURRENT_DATE) AND (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month' - INTERVAL '1 day')
  `));
  return Number(result.rows[0]?.total) || 0;
}

/**
 * Valor de custo do estoque em BRL (via view vw_hedge_estoque, se existir).
 * Motor aplica markup para obter valor de venda (FR-020).
 * Retorna 0 se a view não existir (módulo Hedge não habilitado).
 */
export async function getEstoqueCustoBRL(empresa: 'acxe' | 'q2p'): Promise<number> {
  const db = getDb();
  try {
    const result = await db.execute<{ total: string | number }>(sql.raw(`
      SELECT COALESCE(SUM(valor_total_brl), 0) AS total
      FROM public.vw_hedge_estoque
      WHERE empresa = '${empresa}'
    `));
    return Number(result.rows[0]?.total) || 0;
  } catch (err) {
    logger.warn({ err, empresa }, 'vw_hedge_estoque indisponível, retornando 0');
    return 0;
  }
}

/**
 * Agrega todos os dados necessários para o motor.
 */
export async function getDadosMotor(
  empresa: 'acxe' | 'q2p',
  catFinimpCod: string | null,
): Promise<DadosBase> {
  const [
    saldo,
    dupTotal,
    estoqueCusto,
    finimpSaldo,
    finimpAmort,
    pagamentos,
    recebimentos,
  ] = await Promise.all([
    getSaldoCC(empresa),
    getDupTotal(empresa),
    getEstoqueCustoBRL(empresa),
    getFinimpSaldo(empresa, catFinimpCod),
    getFinimpAmortMensal(empresa, catFinimpCod),
    getPagamentosSemanais(empresa, catFinimpCod, 26),
    getRecebimentosSemanais(empresa, 26),
  ]);

  return {
    saldo_cc: saldo.total,
    dup_total: dupTotal,
    estoque_custo_brl: estoqueCusto,
    finimp_saldo: finimpSaldo,
    finimp_amort_mensal: finimpAmort,
    pagamentos_semanais: pagamentos,
    recebimentos_semanais: recebimentos,
    contas_ativas_count: saldo.ativas,
    contas_excluidas_count: saldo.excluidas,
  };
}
