import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callOmie, OmieApiError, segundosDeEsperaRedundante } from '../client.js';

// STK-23: retry seletivo em callOmie — só em falhas TRANSIENTES (rede/timeout ou
// 502/503/504), nunca em HTTP 500 (que na OMIE é falha de NEGÓCIO).

const mockFetch = vi.fn();

function respostaOk(body: unknown) {
  return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) };
}
function respostaHttp(status: number, body: unknown) {
  return { ok: false, status, text: () => Promise.resolve(JSON.stringify(body)) };
}

const endpoint = { endpoint: 'produtos/nfconsultar/', method: 'ConsultarNF', params: {} };

describe('callOmie — retry (STK-23)', () => {
  const orig = { ...process.env };

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    process.env.OMIE_MODE = 'real';
    process.env.OMIE_ACXE_KEY = 'k';
    process.env.OMIE_ACXE_SECRET = 's';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...orig };
  });

  it('re-tenta em erro de rede e sucede na 3ª tentativa (retries: 2)', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce(respostaOk({ resultado: 'ok' }));

    const res = await callOmie('acxe', endpoint, { retries: 2 });

    expect(res).toEqual({ resultado: 'ok' });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('re-tenta em 503 (infra) e sucede', async () => {
    mockFetch
      .mockResolvedValueOnce(respostaHttp(503, { erro: 'indisponivel' }))
      .mockResolvedValueOnce(respostaOk({ resultado: 'ok' }));

    const res = await callOmie('acxe', endpoint, { retries: 2 });

    expect(res).toEqual({ resultado: 'ok' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('NÃO re-tenta em HTTP 500 (falha de negócio OMIE)', async () => {
    mockFetch.mockResolvedValue(
      respostaHttp(500, { faultcode: 'SOAP-ENV:Client', faultstring: 'Produto nao encontrado' }),
    );

    await expect(callOmie('acxe', endpoint, { retries: 2 })).rejects.toBeInstanceOf(OmieApiError);
    // 1 chamada só — 500 não é transiente.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // ACXEGDP-344: a trava anti-flood da OMIE ("Consumo redundante detectado.
  // Aguarde N segundos") chega como HTTP 500, mas é limite de RITMO, não erro de
  // negócio — a mesma chamada passa depois da espera. Precisa ser re-tentada
  // respeitando o tempo pedido (o backfill consulta o mesmo pedido várias vezes).
  it('re-tenta em 500 REDUNDANT esperando os segundos que a OMIE pede', async () => {
    vi.useFakeTimers();
    try {
      mockFetch
        .mockResolvedValueOnce(
          respostaHttp(500, {
            faultcode: 'SOAP-ENV:Client-6',
            faultstring:
              'ERROR: Consumo redundante detectado. Aguarde 59 segundos para tentar novamente (REDUNDANT).',
          }),
        )
        .mockResolvedValueOnce(respostaOk({ resultado: 'ok' }));

      const promessa = callOmie('acxe', endpoint, { retries: 2 });
      // Ainda não passou o tempo pedido: a 2ª chamada não pode ter saído.
      await vi.advanceTimersByTimeAsync(59_000);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      // 59s + 1s de folga.
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(promessa).resolves.toEqual({ resultado: 'ok' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('500 REDUNDANT sem retries disponíveis continua propagando o erro', async () => {
    mockFetch.mockResolvedValue(
      respostaHttp(500, {
        faultcode: 'SOAP-ENV:Client-6',
        faultstring: 'Consumo redundante detectado (REDUNDANT).',
      }),
    );
    await expect(callOmie('acxe', endpoint)).rejects.toBeInstanceOf(OmieApiError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('segundosDeEsperaRedundante: extrai o tempo pedido, usa 60s de default e ignora outros erros', () => {
    const err = (msg: string) =>
      new OmieApiError('q2p', 'produtos/pedidocompra/', 'ConsultarPedCompra', 500, 'SOAP-ENV:Client-6', msg);
    expect(
      segundosDeEsperaRedundante(
        err(
          'OMIE q2p 500: ERROR: Consumo redundante detectado. Aguarde 59 segundos para tentar novamente (REDUNDANT).',
        ),
      ),
    ).toBe(60);
    expect(segundosDeEsperaRedundante(err('REDUNDANT sem tempo explicito'))).toBe(61);
    expect(segundosDeEsperaRedundante(err('Produto nao encontrado'))).toBeNull();
    expect(segundosDeEsperaRedundante(new Error('qualquer'))).toBeNull();
  });

  it('sem opts (default retries: 0) não re-tenta nem em erro de rede', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNRESET'));

    await expect(callOmie('acxe', endpoint)).rejects.toBeInstanceOf(OmieApiError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
