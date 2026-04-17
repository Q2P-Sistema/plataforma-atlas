import { eq, and, isNull, desc } from 'drizzle-orm';
import { getDb, getPool, createLogger } from '@atlas/core';
import { fornecedorExclusao } from '@atlas/db';

const logger = createLogger('stockbridge:fornecedor');

export interface FornecedorExclusaoItem {
  id: string;
  fornecedorCnpj: string;
  fornecedorNome: string;
  motivo: string | null;
  excluidoEm: string;
  reincluidoEm: string | null;
  ativa: boolean;
}

export class FornecedorJaExcluidoError extends Error {
  constructor(public readonly cnpj: string) {
    super(`Fornecedor CNPJ ${cnpj} ja esta excluido`);
    this.name = 'FornecedorJaExcluidoError';
  }
}

export class ExclusaoNaoEncontradaError extends Error {
  constructor(public readonly cnpj: string) {
    super(`Nao ha exclusao ativa para CNPJ ${cnpj}`);
    this.name = 'ExclusaoNaoEncontradaError';
  }
}

/**
 * Lista fornecedores com flag de exclusao (a partir de `shared.vw_sb_fornecedor_ativo`
 * quando disponivel OU fallback para leitura direta de public.tbl_cadastroFornecedoresClientes_ACXE).
 */
export async function listarFornecedores(): Promise<Array<{
  cnpj: string;
  nome: string;
  pais: string | null;
  excluido: boolean;
  motivoExclusao: string | null;
}>> {
  const pool = getPool();

  const excluidosRes = await pool.query(`
    SELECT fornecedor_cnpj, fornecedor_nome, motivo
    FROM stockbridge.fornecedor_exclusao
    WHERE reincluido_em IS NULL
  `).catch(() => ({ rows: [] }));

  const excluidos = new Map<string, { nome: string; motivo: string | null }>();
  for (const r of excluidosRes.rows as Array<{ fornecedor_cnpj: string; fornecedor_nome: string; motivo: string | null }>) {
    excluidos.set(r.fornecedor_cnpj, { nome: r.fornecedor_nome, motivo: r.motivo });
  }

  const res = await pool.query(`
    SELECT cnpj_cpf AS cnpj, razao_social AS nome, endereco_pais AS pais
    FROM public.tbl_cadastroFornecedoresClientes_ACXE
    WHERE inativo IS NULL OR inativo <> 'S'
    ORDER BY razao_social
    LIMIT 500
  `).catch((err) => {
    logger.warn({ err: err.message }, 'Query de fornecedores ACXE falhou (tabela ausente em dev?)');
    return { rows: [] };
  });

  const lista = (res.rows as Array<{ cnpj: string | null; nome: string | null; pais: string | null }>).map((r) => {
    const cnpj = r.cnpj ?? '';
    const excl = cnpj ? excluidos.get(cnpj) : undefined;
    return {
      cnpj,
      nome: r.nome ?? 'sem nome',
      pais: r.pais,
      excluido: !!excl,
      motivoExclusao: excl?.motivo ?? null,
    };
  });

  // Garante que fornecedores excluidos sem cadastro ACXE ainda aparecem na lista
  for (const [cnpj, info] of excluidos) {
    if (!lista.find((f) => f.cnpj === cnpj)) {
      lista.push({ cnpj, nome: info.nome, pais: null, excluido: true, motivoExclusao: info.motivo });
    }
  }

  return lista;
}

export async function excluirFornecedor(args: {
  cnpj: string;
  nome: string;
  motivo: string | null;
  usuarioId: string;
}): Promise<{ id: string }> {
  const db = getDb();

  const [existente] = await db
    .select()
    .from(fornecedorExclusao)
    .where(and(eq(fornecedorExclusao.fornecedorCnpj, args.cnpj), isNull(fornecedorExclusao.reincluidoEm)))
    .limit(1);
  if (existente) {
    throw new FornecedorJaExcluidoError(args.cnpj);
  }

  const [novo] = await db
    .insert(fornecedorExclusao)
    .values({
      fornecedorCnpj: args.cnpj,
      fornecedorNome: args.nome,
      motivo: args.motivo,
      excluidoPor: args.usuarioId,
    })
    .returning();

  logger.info({ cnpj: args.cnpj, nome: args.nome }, 'Fornecedor excluido da fila');
  return { id: novo!.id };
}

export async function reincluirFornecedor(args: { cnpj: string; usuarioId: string }): Promise<{ id: string }> {
  const db = getDb();

  const [ativa] = await db
    .select()
    .from(fornecedorExclusao)
    .where(and(eq(fornecedorExclusao.fornecedorCnpj, args.cnpj), isNull(fornecedorExclusao.reincluidoEm)))
    .orderBy(desc(fornecedorExclusao.excluidoEm))
    .limit(1);
  if (!ativa) {
    throw new ExclusaoNaoEncontradaError(args.cnpj);
  }

  await db
    .update(fornecedorExclusao)
    .set({ reincluidoEm: new Date(), reincluidoPor: args.usuarioId })
    .where(eq(fornecedorExclusao.id, ativa.id));

  logger.info({ cnpj: args.cnpj }, 'Fornecedor reincluido na fila');
  return { id: ativa.id };
}
