import { createLogger } from '@atlas/core';

const logger = createLogger('omie-client');

export type OmieCnpj = 'acxe' | 'q2p';

export interface OmieEndpoint {
  endpoint: string;
  method: string;
  params: Record<string, unknown>;
}

export interface OmieCredentials {
  apiUrl: string;
  appKey: string;
  appSecret: string;
}

export class OmieApiError extends Error {
  constructor(
    public readonly cnpj: OmieCnpj,
    public readonly endpoint: string,
    public readonly method: string,
    public readonly httpStatus: number | null,
    public readonly omieCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'OmieApiError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

function getCredentials(cnpj: OmieCnpj): OmieCredentials {
  const apiUrl = process.env.OMIE_API_URL ?? 'https://app.omie.com.br/api/v1/';
  if (cnpj === 'acxe') {
    const appKey = process.env.OMIE_ACXE_KEY;
    const appSecret = process.env.OMIE_ACXE_SECRET;
    if (!appKey || !appSecret) {
      throw new Error('OMIE_ACXE_KEY/SECRET nao configuradas. Use OMIE_MODE=mock em dev sem credenciais.');
    }
    return { apiUrl, appKey, appSecret };
  }
  const appKey = process.env.OMIE_Q2P_KEY;
  const appSecret = process.env.OMIE_Q2P_SECRET;
  if (!appKey || !appSecret) {
    throw new Error('OMIE_Q2P_KEY/SECRET nao configuradas. Use OMIE_MODE=mock em dev sem credenciais.');
  }
  return { apiUrl, appKey, appSecret };
}

export async function callOmie<TResponse = unknown>(
  cnpj: OmieCnpj,
  endpoint: OmieEndpoint,
): Promise<TResponse> {
  const { apiUrl, appKey, appSecret } = getCredentials(cnpj);
  const url = apiUrl + endpoint.endpoint;
  const payload = {
    call: endpoint.method,
    app_key: appKey,
    app_secret: appSecret,
    param: [endpoint.params],
  };

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    logger.error({ err, cnpj, endpoint: endpoint.endpoint, method: endpoint.method }, 'OMIE fetch falhou');
    throw new OmieApiError(cnpj, endpoint.endpoint, endpoint.method, null, null, (err as Error).message);
  }

  const elapsed = Date.now() - started;
  const raw = await res.text();
  let body: unknown;
  try { body = JSON.parse(raw); } catch { body = raw; }

  if (!res.ok) {
    logger.error({ cnpj, endpoint: endpoint.endpoint, method: endpoint.method, status: res.status, elapsed }, 'OMIE HTTP erro');
    const omieError = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).faultcode : null;
    throw new OmieApiError(
      cnpj,
      endpoint.endpoint,
      endpoint.method,
      res.status,
      typeof omieError === 'string' ? omieError : null,
      `OMIE ${cnpj} retornou ${res.status}`,
    );
  }

  // OMIE as vezes retorna 200 com payload { faultcode, faultstring }
  if (typeof body === 'object' && body !== null && 'faultcode' in body) {
    const fault = body as { faultcode?: string; faultstring?: string };
    logger.warn({ cnpj, endpoint: endpoint.endpoint, method: endpoint.method, fault, elapsed }, 'OMIE fault response');
    throw new OmieApiError(
      cnpj,
      endpoint.endpoint,
      endpoint.method,
      res.status,
      fault.faultcode ?? null,
      fault.faultstring ?? 'OMIE fault',
    );
  }

  logger.debug({ cnpj, endpoint: endpoint.endpoint, method: endpoint.method, elapsed }, 'OMIE ok');
  return body as TResponse;
}

export function isMockMode(): boolean {
  return (process.env.OMIE_MODE ?? 'real') === 'mock';
}
