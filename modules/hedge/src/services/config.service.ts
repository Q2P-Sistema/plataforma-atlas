import { eq } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { configMotor, ndfTaxas } from '@atlas/db';

const logger = createLogger('hedge:config');

export async function getConfig() {
  const db = getDb();
  return db.select().from(configMotor);
}

export async function updateConfig(chave: string, valor: unknown): Promise<void> {
  const db = getDb();
  await db
    .update(configMotor)
    .set({ valor: JSON.stringify(valor) })
    .where(eq(configMotor.chave, chave));
  logger.info({ chave }, 'Config atualizada');
}

export async function getTaxasNdf(dataRef?: string) {
  const db = getDb();
  if (dataRef) {
    return db.select().from(ndfTaxas).where(eq(ndfTaxas.dataRef, dataRef)).orderBy(ndfTaxas.prazoDias);
  }
  return db.select().from(ndfTaxas).orderBy(ndfTaxas.dataRef, ndfTaxas.prazoDias).limit(30);
}

export async function inserirTaxaNdf(dataRef: string, prazoDias: number, taxa: number): Promise<void> {
  const db = getDb();
  await db
    .insert(ndfTaxas)
    .values({ dataRef, prazoDias, taxa: taxa.toFixed(4) })
    .onConflictDoUpdate({
      target: [ndfTaxas.dataRef, ndfTaxas.prazoDias],
      set: { taxa: taxa.toFixed(4) },
    });
  logger.info({ dataRef, prazoDias, taxa }, 'Taxa NDF inserida');
}
