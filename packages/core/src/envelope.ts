/**
 * Envelope padrão de resposta da API ({ data, error, meta? }).
 *
 * Promovido de apps/api/src/envelope.ts para @atlas/core (MOD-17,
 * ACXEGDP-269/298): módulos não podem importar de apps/*, então hedge,
 * forecast e breakingpoint re-declaravam sendSuccess/sendError localmente,
 * cada um com uma variação (forecast sem meta; nenhum com fields/traceId).
 * Esta é a assinatura superconjunto — comportamento idêntico para os
 * chamadores existentes.
 *
 * Tipagem estrutural (sem dependência de express no core): qualquer objeto
 * com status().json() serve — o Response do express satisfaz.
 */
export interface RespostaHttp {
  status(code: number): { json(body: unknown): unknown };
}

export interface ApiResponse<T = unknown> {
  data: T | null;
  error: ApiError | null;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  code: string;
  message: string;
  fields?: Record<string, string>;
  traceId?: string;
}

export function sendSuccess<T>(
  res: RespostaHttp,
  data: T,
  status = 200,
  meta?: Record<string, unknown>,
): void {
  const body: ApiResponse<T> = { data, error: null };
  if (meta) body.meta = meta;
  res.status(status).json(body);
}

export function sendError(
  res: RespostaHttp,
  code: string,
  message: string,
  status = 400,
  fields?: Record<string, string>,
  traceId?: string,
): void {
  const error: ApiError = { code, message };
  if (fields) error.fields = fields;
  if (traceId) error.traceId = traceId;
  res.status(status).json({ data: null, error } satisfies ApiResponse);
}
