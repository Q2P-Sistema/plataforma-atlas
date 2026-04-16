import { getRedis, createLogger } from '@atlas/core';

const logger = createLogger('bcb-ptax');

// Boletins intraday — publicados ~3x/dia (~10h, ~12h, ~16h BRT)
const BCB_BOLETIM_URL = 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@dataCotacao)';
// SGS-1 — fallback histórico diário
const BCB_SGS_URL = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados';
const CACHE_KEY = 'atlas:bcb:ptax:latest';
const CACHE_TTL = 3600; // 1 hora — boletins saem ~3x/dia
const SANITY_MIN = 3.0;
const SANITY_MAX = 10.0;

export interface PtaxQuote {
  dataRef: string;    // YYYY-MM-DD
  venda: number;
  compra: number;
  atualizada: boolean;
  fetchedAt?: string; // ISO — timestamp real do boletim BCB
}

export async function fetchPtaxAtual(): Promise<PtaxQuote> {
  const redis = getRedis();

  const cached = await redis.get(CACHE_KEY).catch(() => null);
  if (cached) {
    return { ...(JSON.parse(cached) as PtaxQuote), atualizada: true };
  }

  try {
    // Tenta boletim de hoje; se vazio (fim de semana/feriado), tenta D-1
    const quote = await fetchBoletimDia(new Date())
      ?? await fetchBoletimDia(daysAgo(1))
      ?? await fetchBoletimDia(daysAgo(2));

    if (quote) {
      await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(quote)).catch(() => {});
      logger.info({ dataRef: quote.dataRef, venda: quote.venda, fetchedAt: quote.fetchedAt }, 'PTAX atualizada do BCB (boletim)');
      return quote;
    }

    return await getFallback(redis);
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar PTAX do BCB');
    return await getFallback(redis);
  }
}

async function fetchBoletimDia(date: Date): Promise<PtaxQuote | null> {
  const dateStr = formatDateUS(date); // MM-DD-YYYY conforme API BCB
  const url = `${BCB_BOLETIM_URL}?@dataCotacao='${dateStr}'&$format=json`;

  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;

  const body = await res.json() as { value: Array<{ cotacaoCompra: number; cotacaoVenda: number; dataHoraCotacao: string }> };

  if (!body.value || body.value.length === 0) return null;

  // Ordena por dataHoraCotacao ASC — BCB não garante ordem na resposta
  const sorted = [...body.value].sort((a, b) => a.dataHoraCotacao.localeCompare(b.dataHoraCotacao));
  const last = sorted[sorted.length - 1]!;
  const { cotacaoVenda: venda, cotacaoCompra: compra, dataHoraCotacao } = last;

  if (venda < SANITY_MIN || venda > SANITY_MAX) return null;

  // dataHoraCotacao: "2026-04-15 11:08:28.604" — já em formato legível
  const dataRef = dataHoraCotacao.slice(0, 10); // YYYY-MM-DD

  return {
    dataRef,
    venda,
    compra,
    atualizada: true,
    fetchedAt: dataHoraCotacao, // timestamp real do boletim BCB
  };
}

async function getFallback(redis: ReturnType<typeof getRedis>): Promise<PtaxQuote> {
  const lastKnown = await redis.get(`${CACHE_KEY}:last_good`).catch(() => null);
  if (lastKnown) {
    const parsed = JSON.parse(lastKnown) as PtaxQuote;
    logger.warn({ dataRef: parsed.dataRef }, 'Usando PTAX fallback (ultimo boletim valido)');
    return { ...parsed, atualizada: false };
  }
  logger.error('Nenhuma PTAX disponivel');
  return { dataRef: new Date().toISOString().split('T')[0]!, venda: 0, compra: 0, atualizada: false };
}

export async function fetchPtaxHistorico(dias: number): Promise<PtaxQuote[]> {
  try {
    const hoje = new Date();
    const inicio = new Date(hoje.getTime() - dias * 24 * 60 * 60 * 1000);
    const url = `${BCB_SGS_URL}?formato=json&dataInicial=${formatDateBR(inicio)}&dataFinal=${formatDateBR(hoje)}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];

    const data = await res.json() as Array<{ data: string; valor: number }>;

    return data
      .filter((d) => d.valor >= SANITY_MIN && d.valor <= SANITY_MAX)
      .map((d) => {
        const [day, month, year] = d.data.split('/');
        return { dataRef: `${year}-${month}-${day}`, venda: d.valor, compra: d.valor, atualizada: true };
      });
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar historico PTAX');
    return [];
  }
}

function formatDateUS(date: Date): string {
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  const y = date.getFullYear();
  return `${m}-${d}-${y}`;
}

function formatDateBR(date: Date): string {
  const d = date.getDate().toString().padStart(2, '0');
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  return `${d}/${m}/${date.getFullYear()}`;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
