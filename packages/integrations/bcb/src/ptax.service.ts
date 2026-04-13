import { getRedis, createLogger } from '@atlas/core';

const logger = createLogger('bcb-ptax');

const BCB_PTAX_URL = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados';
const CACHE_KEY = 'atlas:bcb:ptax:latest';
const CACHE_TTL = 900; // 15 minutes
const SANITY_MIN = 3.0;
const SANITY_MAX = 10.0;

export interface PtaxQuote {
  dataRef: string; // YYYY-MM-DD
  venda: number;
  compra: number;
  atualizada: boolean;
}

export async function fetchPtaxAtual(): Promise<PtaxQuote> {
  const redis = getRedis();

  // Check cache first
  const cached = await redis.get(CACHE_KEY);
  if (cached) {
    const parsed = JSON.parse(cached) as PtaxQuote;
    return { ...parsed, atualizada: true };
  }

  try {
    // Fetch last 5 business days to handle weekends/holidays
    const hoje = new Date();
    const cincoAtras = new Date(hoje.getTime() - 7 * 24 * 60 * 60 * 1000);
    const dataInicio = formatDateBR(cincoAtras);
    const dataFim = formatDateBR(hoje);

    const url = `${BCB_PTAX_URL}?formato=json&dataInicial=${dataInicio}&dataFinal=${dataFim}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`BCB API returned ${response.status}`);
    }

    const data = (await response.json()) as Array<{ data: string; valor: number }>;

    if (!data || data.length === 0) {
      return await getFallback(redis);
    }

    // BCB returns array sorted by date asc, get last entry
    const latest = data[data.length - 1]!;
    const valor = latest.valor;

    // Sanity check
    if (valor < SANITY_MIN || valor > SANITY_MAX) {
      logger.warn({ valor, data: latest.data }, 'PTAX fora da faixa de sanidade, rejeitada');
      return await getFallback(redis);
    }

    // Parse BCB date format DD/MM/YYYY
    const [day, month, year] = latest.data.split('/');
    const dataRef = `${year}-${month}-${day}`;

    const quote: PtaxQuote = {
      dataRef,
      venda: valor,
      compra: valor, // SGS-1 returns single value (venda), compra is approximately the same
      atualizada: true,
    };

    // Cache it
    await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(quote));
    logger.info({ dataRef, venda: valor }, 'PTAX atualizada do BCB');

    return quote;
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar PTAX do BCB');
    return await getFallback(redis);
  }
}

async function getFallback(redis: ReturnType<typeof getRedis>): Promise<PtaxQuote> {
  // Try to get last known good value from cache (even expired)
  const lastKnown = await redis.get(`${CACHE_KEY}:last_good`);
  if (lastKnown) {
    const parsed = JSON.parse(lastKnown) as PtaxQuote;
    logger.warn({ dataRef: parsed.dataRef }, 'Usando PTAX fallback (ultima cotacao valida)');
    return { ...parsed, atualizada: false };
  }

  // No fallback available
  logger.error('Nenhuma PTAX disponivel (nem cache, nem fallback)');
  return {
    dataRef: new Date().toISOString().split('T')[0]!,
    venda: 0,
    compra: 0,
    atualizada: false,
  };
}

export async function fetchPtaxHistorico(dias: number): Promise<PtaxQuote[]> {
  try {
    const hoje = new Date();
    const inicio = new Date(hoje.getTime() - dias * 24 * 60 * 60 * 1000);
    const url = `${BCB_PTAX_URL}?formato=json&dataInicial=${formatDateBR(inicio)}&dataFinal=${formatDateBR(hoje)}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return [];

    const data = (await response.json()) as Array<{ data: string; valor: number }>;

    return data
      .filter((d) => d.valor >= SANITY_MIN && d.valor <= SANITY_MAX)
      .map((d) => {
        const [day, month, year] = d.data.split('/');
        return {
          dataRef: `${year}-${month}-${day}`,
          venda: d.valor,
          compra: d.valor,
          atualizada: true,
        };
      });
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar historico PTAX');
    return [];
  }
}

function formatDateBR(date: Date): string {
  const d = date.getDate().toString().padStart(2, '0');
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}
