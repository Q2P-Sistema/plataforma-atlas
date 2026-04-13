import { createLogger } from '@atlas/core';

const logger = createLogger('forecast:ai-analysis');

export interface ShoppingItem {
  familia: string;
  qtd_kg: number;
  valor_brl: number;
  ruptura_dias: number;
  lt_dias: number;
  cobertura_dias: number;
  is_local: boolean;
}

export interface AIRecomendacao {
  familia: string;
  acao: 'COMPRAR AGORA' | 'AGUARDAR' | 'REVISAR' | 'OK';
  justificativa: string;
  prioridade: number;
}

export interface AIAnalysisResult {
  resumo_executivo: string;
  alertas: string[];
  recomendacoes: AIRecomendacao[];
}

/**
 * Sends shopping list to n8n LLM gateway for AI analysis.
 * Returns structured recommendations per item.
 * Gracefully returns null if n8n is unavailable.
 */
export async function analyzeShoppingList(itens: ShoppingItem[]): Promise<AIAnalysisResult | null> {
  const webhookUrl = process.env.N8N_FORECAST_ANALYZE_URL;

  if (!webhookUrl) {
    logger.warn('N8N_FORECAST_ANALYZE_URL not configured — AI analysis unavailable');
    return null;
  }

  const payload = {
    itens,
    contexto: {
      total_itens: itens.length,
      total_valor_brl: itens.reduce((s, i) => s + i.valor_brl, 0),
      data_analise: new Date().toISOString().split('T')[0],
    },
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      logger.error({ status: response.status }, 'n8n webhook returned error');
      return null;
    }

    const data = await response.json() as any;

    // Validate response shape
    if (!data?.resumo_executivo || !Array.isArray(data?.recomendacoes)) {
      logger.warn({ data }, 'n8n returned malformed response');
      return null;
    }

    const result: AIAnalysisResult = {
      resumo_executivo: String(data.resumo_executivo),
      alertas: Array.isArray(data.alertas) ? data.alertas.map(String) : [],
      recomendacoes: data.recomendacoes.map((r: any) => ({
        familia: String(r.familia ?? ''),
        acao: validateAcao(r.acao),
        justificativa: String(r.justificativa ?? ''),
        prioridade: Number(r.prioridade ?? 99),
      })),
    };

    logger.info({ itens: itens.length, recomendacoes: result.recomendacoes.length }, 'AI analysis completed');
    return result;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      logger.error('n8n webhook timed out (30s)');
    } else {
      logger.error({ err }, 'Failed to call n8n webhook');
    }
    return null;
  }
}

function validateAcao(acao: unknown): AIRecomendacao['acao'] {
  const valid = ['COMPRAR AGORA', 'AGUARDAR', 'REVISAR', 'OK'];
  const s = String(acao ?? '').toUpperCase();
  return valid.includes(s) ? s as AIRecomendacao['acao'] : 'REVISAR';
}
