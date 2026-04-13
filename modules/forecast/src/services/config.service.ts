import { eq } from 'drizzle-orm';
import { getDb, createLogger } from '@atlas/core';
import { configForecast } from '@atlas/db';

const logger = createLogger('forecast:config');

export interface ForecastConfig {
  variacao_anual_pct: number;
  buffer_dias: number;
  lead_time_local: number;
  moq_internacional: number;
  moq_nacional: number;
  horizonte_dias: number;
  horizonte_cobertura: number;
}

const DEFAULTS: ForecastConfig = {
  variacao_anual_pct: 5,
  buffer_dias: 10,
  lead_time_local: 7,
  moq_internacional: 25000,
  moq_nacional: 12000,
  horizonte_dias: 120,
  horizonte_cobertura: 60,
};

export async function getConfig(): Promise<ForecastConfig> {
  const db = getDb();
  const rows = await db.select().from(configForecast);

  const map = new Map(rows.map((r) => [r.chave, r.valor]));
  return {
    variacao_anual_pct: Number(map.get('variacao_anual_pct') ?? DEFAULTS.variacao_anual_pct),
    buffer_dias: Number(map.get('buffer_dias') ?? DEFAULTS.buffer_dias),
    lead_time_local: Number(map.get('lead_time_local') ?? DEFAULTS.lead_time_local),
    moq_internacional: Number(map.get('moq_internacional') ?? DEFAULTS.moq_internacional),
    moq_nacional: Number(map.get('moq_nacional') ?? DEFAULTS.moq_nacional),
    horizonte_dias: Number(map.get('horizonte_dias') ?? DEFAULTS.horizonte_dias),
    horizonte_cobertura: Number(map.get('horizonte_cobertura') ?? DEFAULTS.horizonte_cobertura),
  };
}

export async function getAllConfig() {
  const db = getDb();
  return db.select().from(configForecast);
}

export async function updateConfig(chave: string, valor: unknown): Promise<void> {
  const db = getDb();
  await db
    .update(configForecast)
    .set({ valor: JSON.stringify(valor) })
    .where(eq(configForecast.chave, chave));
  logger.info({ chave }, 'Config atualizada');
}
