import { desc, eq } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { configMotor, ndfTaxas } from '@atlas/db';

const logger = createLogger('hedge:config');

export async function getConfig() {
  const db = getDb();
  return db.select().from(configMotor);
}

export class ConfigInvalidaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigInvalidaError';
  }
}

/**
 * MOD-15 (ACXEGDP-278): a versao anterior gravava JSON.stringify(valor) em
 * coluna JSONB (dupla serializacao — o seed e numero, o update virava a string
 * "60" e os leitores que fazem Number()/Decimal quebrariam) e um update de
 * chave inexistente retornava sucesso sem gravar nada.
 *
 * Todas as chaves editaveis do config_motor sao numericas; valida e grava o
 * escalar puro. `localidades_ativas` tem caminho proprio (salvarLocalidadesAtivas).
 */
export async function updateConfig(chave: string, valor: unknown): Promise<void> {
  const db = getDb();
  const num = typeof valor === 'number' ? valor : Number(valor);
  if (typeof valor === 'boolean' || valor == null || valor === '' || !Number.isFinite(num)) {
    throw new ConfigInvalidaError(`Valor inválido para a configuração "${chave}" — esperado um número.`);
  }
  const atualizadas = await db
    .update(configMotor)
    .set({ valor: num, updatedAt: new Date() })
    .where(eq(configMotor.chave, chave))
    .returning({ chave: configMotor.chave });
  if (atualizadas.length === 0) {
    throw new ConfigInvalidaError(`Configuração "${chave}" não existe.`);
  }
  logger.info({ chave, valor: num }, 'Config atualizada');
}

export async function getTaxasNdf(dataRef?: string) {
  const db = getDb();
  if (dataRef) {
    return db.select().from(ndfTaxas).where(eq(ndfTaxas.dataRef, dataRef)).orderBy(ndfTaxas.prazoDias);
  }
  // data_ref DESC: as 30 cotacoes MAIS RECENTES (antes ASC trazia as mais antigas — MOD-01)
  return db.select().from(ndfTaxas).orderBy(desc(ndfTaxas.dataRef), ndfTaxas.prazoDias).limit(30);
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
