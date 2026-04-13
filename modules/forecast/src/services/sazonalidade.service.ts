import { eq, and } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { configSazonalidade, sazonalidadeLog } from '@atlas/db';

const logger = createLogger('forecast:sazonalidade');

export interface SazFamilia {
  familia_id: string;
  meses: Array<{
    mes: number;
    fator_sugerido: number;
    fator_usuario: number | null;
    fator_efetivo: number;
  }>;
}

/**
 * Returns seasonality factors for all families.
 * Families without specific overrides get _DEFAULT factors.
 */
export async function getSazonalidade(): Promise<SazFamilia[]> {
  const db = getDb();
  const rows = await db.select().from(configSazonalidade).orderBy(configSazonalidade.familiaId, configSazonalidade.mes);

  const map = new Map<string, SazFamilia>();

  for (const r of rows) {
    if (!map.has(r.familiaId)) {
      map.set(r.familiaId, { familia_id: r.familiaId, meses: [] });
    }
    const fatorSugerido = Number(r.fatorSugerido);
    const fatorUsuario = r.fatorUsuario ? Number(r.fatorUsuario) : null;
    map.get(r.familiaId)!.meses.push({
      mes: r.mes,
      fator_sugerido: fatorSugerido,
      fator_usuario: fatorUsuario,
      fator_efetivo: fatorUsuario ?? fatorSugerido,
    });
  }

  return Array.from(map.values());
}

/**
 * Returns the effective seasonality factor for a family and month.
 * Falls back to _DEFAULT if family has no specific entry.
 */
export async function getSazFactor(familiaId: string, mes: number): Promise<number> {
  const db = getDb();

  // Try family-specific first
  const [specific] = await db
    .select()
    .from(configSazonalidade)
    .where(and(eq(configSazonalidade.familiaId, familiaId), eq(configSazonalidade.mes, mes)))
    .limit(1);

  if (specific) {
    return specific.fatorUsuario ? Number(specific.fatorUsuario) : Number(specific.fatorSugerido);
  }

  // Fallback to _DEFAULT
  const [defaultRow] = await db
    .select()
    .from(configSazonalidade)
    .where(and(eq(configSazonalidade.familiaId, '_DEFAULT'), eq(configSazonalidade.mes, mes)))
    .limit(1);

  return defaultRow ? Number(defaultRow.fatorUsuario ?? defaultRow.fatorSugerido) : 1.0;
}

/**
 * Batch load all effective factors for a family (12 months).
 * Returns Map<mes, fator>.
 */
export async function getSazFactors(familiaId: string): Promise<Map<number, number>> {
  const db = getDb();

  const familyRows = await db
    .select()
    .from(configSazonalidade)
    .where(eq(configSazonalidade.familiaId, familiaId));

  const defaultRows = await db
    .select()
    .from(configSazonalidade)
    .where(eq(configSazonalidade.familiaId, '_DEFAULT'));

  const defaultMap = new Map(defaultRows.map((r) => [r.mes, Number(r.fatorUsuario ?? r.fatorSugerido)]));
  const familyMap = new Map(familyRows.map((r) => [r.mes, Number(r.fatorUsuario ?? r.fatorSugerido)]));

  const result = new Map<number, number>();
  for (let m = 1; m <= 12; m++) {
    result.set(m, familyMap.get(m) ?? defaultMap.get(m) ?? 1.0);
  }
  return result;
}

/**
 * Updates a seasonality factor and logs the change.
 */
export async function updateSazFactor(
  familiaId: string,
  mes: number,
  fator: number,
  usuario?: string,
): Promise<{ fator_anterior: number | null; fator_novo: number }> {
  const db = getDb();

  const [existing] = await db
    .select()
    .from(configSazonalidade)
    .where(and(eq(configSazonalidade.familiaId, familiaId), eq(configSazonalidade.mes, mes)))
    .limit(1);

  const fatorAnterior = existing ? Number(existing.fatorUsuario ?? existing.fatorSugerido) : null;

  if (existing) {
    await db
      .update(configSazonalidade)
      .set({ fatorUsuario: fator.toFixed(2) })
      .where(eq(configSazonalidade.id, existing.id));
  } else {
    await db.insert(configSazonalidade).values({
      familiaId,
      mes,
      fatorSugerido: '1.00',
      fatorUsuario: fator.toFixed(2),
    });
  }

  // Log
  await db.insert(sazonalidadeLog).values({
    familiaId,
    mes,
    fatorAnterior: fatorAnterior?.toFixed(2) ?? null,
    fatorNovo: fator.toFixed(2),
    usuario: usuario ?? null,
  });

  logger.info({ familiaId, mes, fatorAnterior, fatorNovo: fator }, 'Sazonalidade atualizada');
  return { fator_anterior: fatorAnterior, fator_novo: fator };
}
