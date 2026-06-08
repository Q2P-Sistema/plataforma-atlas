import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { useAuthStore } from '../../../../stores/auth.store.js';
import { fmtCmc, fmtDataBrCurta } from './format.js';
import { cmcParams, type CmcUiFiltros } from './filtros.js';
import type { CmcTendenciaResponse } from './types.js';

// Paleta (tokens do projeto) para as linhas da série.
const CORES = ['#0077cc', '#1a9944', '#d97706', '#7c3aed', '#dc2626', '#059669', '#2196f3', '#db2777'];

/**
 * Aba "Tendência histórica" (US2): evolução diária do CMC ponderado no período.
 * Série única ("Total") por padrão; uma série por família/produto quando filtrado.
 * Dias sem coleta aparecem como lacuna (sem interpolar). Read-only, gestor+.
 */
export function CmcTendenciaTab({ filtros }: { filtros: CmcUiFiltros }) {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');

  const { data, isLoading, error } = useQuery<CmcTendenciaResponse>({
    queryKey: ['stockbridge', 'cmc', 'tendencia', filtros, de, ate],
    queryFn: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
      const qs = cmcParams(filtros, { de: de || undefined, ate: ate || undefined });
      const res = await fetch(`/api/v1/stockbridge/cmc/tendencia${qs}`, { credentials: 'include', headers });
      const body = (await res.json()) as {
        data: CmcTendenciaResponse | null;
        error: { message?: string } | null;
      };
      if (!res.ok) throw new Error(body.error?.message ?? 'Erro ao carregar a tendência de CMC');
      return body.data as CmcTendenciaResponse;
    },
  });

  // Transforma { datas, series } no formato linha-a-linha do recharts.
  const chartData = useMemo(() => {
    if (!data) return [];
    return data.datas.map((d, i) => {
      const row: Record<string, number | string | null> = { data: fmtDataBrCurta(d) };
      for (const s of data.series) {
        const p = s.pontos[i];
        row[s.chave] = p ? p.cmcPonderado : null;
      }
      return row;
    });
  }, [data]);

  const temSerie = (data?.series.length ?? 0) > 0 && chartData.length > 0;

  return (
    <div>
      <div className="mb-4 flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-atlas-muted font-medium">De</span>
          <input
            type="date"
            value={de}
            onChange={(e) => setDe(e.target.value)}
            className="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-xs focus:outline-none focus:ring-1 focus:ring-acxe"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-atlas-muted font-medium">Até</span>
          <input
            type="date"
            value={ate}
            onChange={(e) => setAte(e.target.value)}
            className="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-900 text-xs focus:outline-none focus:ring-1 focus:ring-acxe"
          />
        </label>
        {(de || ate) && (
          <button
            type="button"
            onClick={() => {
              setDe('');
              setAte('');
            }}
            className="text-[11px] text-atlas-muted hover:text-atlas-ink py-1"
          >
            Período completo
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
          {(error as Error).message}
        </div>
      )}

      {isLoading && <div className="p-6 text-sm text-atlas-muted">Carregando...</div>}

      {data && !temSerie && !isLoading && (
        <div className="p-12 text-center text-sm text-atlas-muted border border-dashed border-slate-300 dark:border-slate-700 rounded-lg">
          Sem histórico de CMC para o período/seleção atuais.
        </div>
      )}

      {temSerie && (
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4">
          <ResponsiveContainer width="100%" height={360}>
            <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--atlas-border)" />
              <XAxis dataKey="data" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} width={48} />
              <Tooltip formatter={(v) => fmtCmc(v == null ? null : Number(v))} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {data!.series.map((s, idx) => (
                <Line
                  key={s.chave}
                  type="monotone"
                  dataKey={s.chave}
                  name={s.label}
                  stroke={CORES[idx % CORES.length]}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <p className="mt-2 text-[11px] text-atlas-muted">
            CMC ponderado (R$/kg) por dia. Dias sem coleta aparecem como lacuna na linha.
          </p>
        </div>
      )}
    </div>
  );
}
