import { z } from 'zod';
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// Walk up to find .env at monorepo root
function findEnvFile(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const envPath = resolve(dir, '.env');
    if (existsSync(envPath)) return envPath;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

dotenvConfig({ path: findEnvFile() });

const boolString = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  // Timezone da sessao Postgres (IANA). Define o fuso usado por CURRENT_DATE,
  // CURRENT_TIMESTAMP e comparacoes de data nas queries (ex: defasagem CMC,
  // vencimentos breakingpoint/comodato). O container roda em UTC, entao sem isto
  // o CURRENT_DATE "vira o dia" 3h antes da meia-noite local. Operacao e BR.
  DB_TIMEZONE: z.string().default('America/Sao_Paulo'),
  REDIS_URL: z.string().url(),
  SESSION_SECRET: z.string().min(16),
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
  N8N_HEALTH_URL: z.string().url().optional(),
  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_FROM_EMAIL: z.string().email().optional(),
  // CC opcional em todos os emails operacionais do StockBridge (rejeicao,
  // aprovacao, alertas). Usar para que o admin/responsavel monitore por copia.
  STOCKBRIDGE_ADMIN_CC_EMAIL: z.string().email().optional(),
  // Caixa de Comex da ACXE — recebe confirmacao de TODO recebimento concluido
  // com sucesso (limpo direto, ou divergente apos aprovacao). Nao recebe os emails
  // de aprovacao pendente nem os alertas de pendencia OMIE (insucesso).
  STOCKBRIDGE_COMEX_EMAIL: z.string().email().default('comex_acxe@acxe-polimeros.com.br'),
  // Data de corte para deteccao de gap fiscal/fisico no Cockpit (formato YYYY-MM-DD).
  // NFs emitidas antes dessa data sao ignoradas no calculo de "Posicao Fiscal Pendente"
  // (ja foram tratadas pelo legado PHP / nao fazem parte do periodo Atlas).
  // Sem set: usa 180 dias atras como fallback.
  STOCKBRIDGE_FISCAL_CUTOFF_DATE: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // URL base do frontend (sem barra final) — usada para montar links em emails
  // (ex: "Re-submeter agora" no email de rejeicao). Default cobre dev local.
  APP_URL: z.string().url().default('http://localhost:5173'),
  API_PORT: z.coerce.number().default(3005),
  WEB_PORT: z.coerce.number().default(5173),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  MODULE_HEDGE_ENABLED: boolString,
  MODULE_STOCKBRIDGE_ENABLED: boolString,
  MODULE_BREAKINGPOINT_ENABLED: boolString,
  MODULE_CLEVEL_ENABLED: boolString,
  MODULE_COMEXINSIGHT_ENABLED: boolString,
  MODULE_COMEXFLOW_ENABLED: boolString,
  MODULE_FORECAST_ENABLED: boolString,

  // Chave compartilhada entre n8n e Atlas para endpoints de integracao (ex: saidas automaticas StockBridge)
  ATLAS_INTEGRATION_KEY: z.string().min(16).optional(),
});

export type Env = z.infer<typeof envSchema>;

let _config: Env | null = null;

export function loadConfig(): Env {
  if (_config) return _config;
  // Normaliza string vazia ("") -> undefined antes de validar. Necessario porque o
  // Docker Compose/Swarm, ao resolver `KEY: ${KEY}` com a origem vazia, injeta a
  // variavel no container como "" — e "" falha validadores de formato
  // (.email()/.url()/.regex()) mesmo em campos .optional(). Tratar "" como ausente
  // deixa os opcionais realmente opcionais e os defaults voltarem a valer.
  const normalizedEnv = Object.fromEntries(
    Object.entries(process.env).map(([k, v]) => [k, v === '' ? undefined : v]),
  );
  const result = envSchema.safeParse(normalizedEnv);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${formatted}`);
  }
  _config = result.data;
  return _config;
}

export function getConfig(): Env {
  if (!_config) return loadConfig();
  return _config;
}
