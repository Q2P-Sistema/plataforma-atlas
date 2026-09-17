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

async function executarChamadaOmie<TResponse = unknown>(
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
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }

  if (!res.ok) {
    // Inclui body (truncado se gigante) para facilitar debug
    const bodyPreview = typeof body === 'string' ? body.slice(0, 1000) : JSON.stringify(body).slice(0, 1000);
    logger.error(
      {
        cnpj,
        endpoint: endpoint.endpoint,
        method: endpoint.method,
        status: res.status,
        elapsed,
        body: bodyPreview,
      },
      'OMIE HTTP erro',
    );
    const omieFault = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
    const faultcode = omieFault?.faultcode;
    const faultstring = omieFault?.faultstring;
    throw new OmieApiError(
      cnpj,
      endpoint.endpoint,
      endpoint.method,
      res.status,
      typeof faultcode === 'string' ? faultcode : null,
      typeof faultstring === 'string'
        ? `OMIE ${cnpj} ${res.status}: ${faultstring}`
        : `OMIE ${cnpj} retornou ${res.status} — ${bodyPreview.slice(0, 200)}`,
    );
  }

  // OMIE as vezes retorna 200 com payload { faultcode, faultstring }
  if (typeof body === 'object' && body !== null && 'faultcode' in body) {
    const fault = body as { faultcode?: string; faultstring?: string };
    logger.warn(
      { cnpj, endpoint: endpoint.endpoint, method: endpoint.method, fault, elapsed },
      'OMIE fault response',
    );
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

export interface CallOmieOptions {
  /**
   * Nº de RE-tentativas em falhas TRANSIENTES (default 0 = sem retry). STK-23.
   * Usar SOMENTE em leituras idempotentes (consultarNF, ListarAjusteEstoque) —
   * NUNCA em escritas (IncluirAjusteEstoque/pedido), que dependem da idempotência
   * por cod_int_ajuste + painel de operações pendentes para reprocessar.
   */
  retries?: number;
}

/**
 * Trava anti-flood da OMIE: consultar o MESMO recurso com os mesmos parâmetros
 * em sequência curta devolve HTTP 500 com faultstring "Consumo redundante
 * detectado. Aguarde N segundos..." (faultcode SOAP-ENV:Client-6). É um limite
 * de RITMO, não erro de negócio: a mesma chamada passa depois da espera.
 * Retorna os segundos pedidos (default 60) ou null se não for esse caso.
 * ACXEGDP-344: aparece no backfill/baixa quando várias NFs do mesmo produto
 * caem no mesmo pedido de compra.
 */
export function segundosDeEsperaRedundante(err: unknown): number | null {
  if (!(err instanceof OmieApiError)) return null;
  const msg = err.message ?? '';
  if (!/REDUNDANT|[Cc]onsumo redundante/.test(msg)) return null;
  const m = /Aguarde\s+(\d+)\s+segundo/i.exec(msg);
  const segundos = m?.[1] ? Number(m[1]) : 60;
  // +1s de folga: o relógio da OMIE não é o nosso.
  return Math.min(Math.max(segundos, 1), 120) + 1;
}

/**
 * Só re-tenta falhas realmente transientes: erro de rede/timeout (httpStatus null),
 * 502/503/504 (infra) ou a trava de consumo redundante (500 + REDUNDANT, que é
 * limite de ritmo). NÃO re-tenta os demais HTTP 500 — a OMIE devolve 500 para
 * falhas de NEGÓCIO (com faultcode), que retry não resolve e só atrasa.
 */
function ehTransiente(err: unknown): boolean {
  if (!(err instanceof OmieApiError)) return false;
  if (segundosDeEsperaRedundante(err) !== null) return true;
  return (
    err.httpStatus === null || err.httpStatus === 502 || err.httpStatus === 503 || err.httpStatus === 504
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callOmie<TResponse = unknown>(
  cnpj: OmieCnpj,
  endpoint: OmieEndpoint,
  opts?: CallOmieOptions,
): Promise<TResponse> {
  const retries = Math.max(0, opts?.retries ?? 0);
  let ultimoErro: unknown;
  for (let tentativa = 0; tentativa <= retries; tentativa++) {
    try {
      return await executarChamadaOmie<TResponse>(cnpj, endpoint);
    } catch (err) {
      ultimoErro = err;
      if (tentativa < retries && ehTransiente(err)) {
        // Na trava de consumo redundante a OMIE diz quanto esperar — obedecer é
        // o único jeito de a chamada passar (backoff de 300ms não resolve).
        const esperaRedundante = segundosDeEsperaRedundante(err);
        const backoff = esperaRedundante != null ? esperaRedundante * 1000 : 300 * (tentativa + 1);
        logger.warn(
          {
            cnpj,
            endpoint: endpoint.endpoint,
            method: endpoint.method,
            tentativa: tentativa + 1,
            backoff,
            motivo: esperaRedundante != null ? 'consumo-redundante' : 'transiente',
          },
          'OMIE leitura falhou (transiente) — retry',
        );
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  throw ultimoErro;
}

export function isMockMode(): boolean {
  const mock = (process.env.OMIE_MODE ?? 'real') === 'mock';
  // STK-15 (ACXEGDP-289): mock em producao gravaria recebimentos/saidas como
  // 'concluida' com ids MOCK-* sem tocar o ERP — silenciosamente. Um copy-paste
  // de .env (que traz OMIE_MODE=mock como default de dev) bastaria. Fail-fast.
  if (mock && process.env.NODE_ENV === 'production') {
    throw new Error(
      'OMIE_MODE=mock com NODE_ENV=production — configuração proibida: as escritas OMIE seriam ' +
        'simuladas com ids MOCK-* sem tocar o ERP. Configure OMIE_MODE=real (com as credenciais ' +
        'OMIE_*_KEY/SECRET) ou rode fora de produção.',
    );
  }
  return mock;
}
