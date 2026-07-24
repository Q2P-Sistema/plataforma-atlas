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

export class ConfigInvalidaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigInvalidaError';
  }
}

/**
 * MOD-15 (ACXEGDP-278), mesmo padrao do hedge: sem JSON.stringify em coluna
 * JSONB (dupla serializacao) e erro explicito para chave inexistente (antes o
 * update de 0 linhas retornava sucesso sem gravar). Todas as chaves do
 * config_forecast sao numericas (ver DEFAULTS).
 */
export async function updateConfig(chave: string, valor: unknown): Promise<void> {
  const db = getDb();
  const num = typeof valor === 'number' ? valor : Number(valor);
  if (typeof valor === 'boolean' || valor == null || valor === '' || !Number.isFinite(num)) {
    throw new ConfigInvalidaError(`Valor inválido para a configuração "${chave}" — esperado um número.`);
  }
  const atualizadas = await db
    .update(configForecast)
    .set({ valor: num, updatedAt: new Date() })
    .where(eq(configForecast.chave, chave))
    .returning({ chave: configForecast.chave });
  if (atualizadas.length === 0) {
    throw new ConfigInvalidaError(`Configuração "${chave}" não existe.`);
  }
  logger.info({ chave, valor: num }, 'Config atualizada');
}
