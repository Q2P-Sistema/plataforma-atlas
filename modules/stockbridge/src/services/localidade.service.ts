import { eq, asc } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { localidade } from '@atlas/db';
import type { TipoLocalidade } from '../types.js';

const logger = createLogger('stockbridge:localidade');

export class CodigoLocalidadeDuplicadoError extends Error {
  constructor(public readonly codigo: string) {
    super(`Ja existe localidade com codigo ${codigo}`);
    this.name = 'CodigoLocalidadeDuplicadoError';
  }
}

export class LocalidadeNaoEncontradaError extends Error {
  constructor(public readonly id: string) {
    super(`Localidade ${id} nao encontrada`);
    this.name = 'LocalidadeNaoEncontradaError';
  }
}

export class LocalidadeInvalidaError extends Error {
  constructor(msg: string) { super(msg); this.name = 'LocalidadeInvalidaError'; }
}

export interface LocalidadeInput {
  codigo: string;
  nome: string;
  tipo: TipoLocalidade;
  cnpj?: string | null;
  cidade?: string | null;
  ativo?: boolean;
}

function validar(input: LocalidadeInput): void {
  if (input.tipo === 'virtual_transito' || input.tipo === 'virtual_ajuste') {
    if (input.cnpj && input.cnpj.trim().length > 0) {
      throw new LocalidadeInvalidaError(`Localidade virtual (${input.tipo}) nao pode ter CNPJ vinculado`);
    }
  }
}

export async function listarLocalidades(apenasAtivas: boolean = false): Promise<Array<typeof localidade.$inferSelect>> {
  const db = getDb();
  const query = db.select().from(localidade).orderBy(asc(localidade.codigo));
  if (apenasAtivas) {
    return query.where(eq(localidade.ativo, true));
  }
  return query;
}

export async function criarLocalidade(input: LocalidadeInput): Promise<typeof localidade.$inferSelect> {
  validar(input);
  const db = getDb();

  const [existente] = await db.select().from(localidade).where(eq(localidade.codigo, input.codigo)).limit(1);
  if (existente) {
    throw new CodigoLocalidadeDuplicadoError(input.codigo);
  }

  const [criada] = await db
    .insert(localidade)
    .values({
      codigo: input.codigo,
      nome: input.nome,
      tipo: input.tipo,
      cnpj: input.cnpj ?? null,
      cidade: input.cidade ?? null,
      ativo: input.ativo ?? true,
    })
    .returning();

  logger.info({ codigo: input.codigo, tipo: input.tipo }, 'Localidade criada');
  return criada!;
}

export async function atualizarLocalidade(
  id: string,
  patch: Partial<LocalidadeInput>,
): Promise<typeof localidade.$inferSelect> {
  if (patch.tipo || patch.cnpj !== undefined) {
    validar({
      codigo: 'placeholder',
      nome: 'placeholder',
      tipo: patch.tipo ?? 'proprio',
      cnpj: patch.cnpj,
    });
  }

  const db = getDb();
  const [existente] = await db.select().from(localidade).where(eq(localidade.id, id)).limit(1);
  if (!existente) throw new LocalidadeNaoEncontradaError(id);

  const [atualizada] = await db
    .update(localidade)
    .set({
      ...(patch.codigo ? { codigo: patch.codigo } : {}),
      ...(patch.nome ? { nome: patch.nome } : {}),
      ...(patch.tipo ? { tipo: patch.tipo } : {}),
      ...(patch.cnpj !== undefined ? { cnpj: patch.cnpj } : {}),
      ...(patch.cidade !== undefined ? { cidade: patch.cidade } : {}),
      ...(patch.ativo !== undefined ? { ativo: patch.ativo } : {}),
      updatedAt: new Date(),
    })
    .where(eq(localidade.id, id))
    .returning();

  logger.info({ id }, 'Localidade atualizada');
  return atualizada!;
}

export async function desativarLocalidade(id: string): Promise<void> {
  const db = getDb();
  const result = await db
    .update(localidade)
    .set({ ativo: false, updatedAt: new Date() })
    .where(eq(localidade.id, id))
    .returning({ id: localidade.id });
  if (result.length === 0) {
    throw new LocalidadeNaoEncontradaError(id);
  }
  logger.info({ id }, 'Localidade desativada (soft delete)');
}
