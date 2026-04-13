import { useState, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../stores/auth.store.js';

interface SazMes { mes: number; fator_sugerido: number; fator_usuario: number | null; fator_efetivo: number; }
interface SazFamilia { familia_id: string; meses: SazMes[]; }
interface ConfigRow { chave: string; valor: any; descricao: string | null; }

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function useForecFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers as Record<string, string>) };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', ...opts, headers });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
    return body;
  };
}

export function ForecastConfigPage() {
  const queryClient = useQueryClient();
  const forecFetch = useForecFetch();
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');

  const { data: sazData = [] } = useQuery<SazFamilia[]>({
    queryKey: ['forecast', 'sazonalidade'],
    queryFn: async () => {
      const res = await fetch('/api/v1/forecast/sazonalidade', { credentials: 'include' });
      const body = (await res.json()) as any;
      return body.data ?? [];
    },
  });

  const { data: configs = [] } = useQuery<ConfigRow[]>({
    queryKey: ['forecast', 'config'],
    queryFn: async () => {
      const res = await fetch('/api/v1/forecast/config', { credentials: 'include' });
      const body = (await res.json()) as any;
      return body.data ?? [];
    },
  });

  const sazMut = useMutation({
    mutationFn: async ({ familia_id, mes, fator }: { familia_id: string; mes: number; fator: number }) =>
      forecFetch('/api/v1/forecast/sazonalidade', { method: 'PATCH', body: JSON.stringify({ familia_id, mes, fator }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['forecast', 'sazonalidade'] }),
  });

  const configMut = useMutation({
    mutationFn: async ({ chave, valor }: { chave: string; valor: string }) =>
      forecFetch('/api/v1/forecast/config', { method: 'PATCH', body: JSON.stringify({ chave, valor }) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['forecast', 'config'] }); setEditKey(null); },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-heading font-bold text-atlas-text">Configuracao Forecast</h1>

      {/* Config params */}
      <div className="bg-atlas-card border border-atlas-border rounded-lg p-5">
        <p className="text-xs text-atlas-muted uppercase tracking-[3px] mb-4">Parametros do Modelo</p>
        <div className="space-y-0">
          {configs.map((c) => (
            <div key={c.chave} className="flex items-center justify-between py-2.5 border-b border-atlas-border/50 last:border-0">
              <div>
                <p className="text-sm font-medium text-atlas-text">{c.chave.replace(/_/g, ' ')}</p>
                <p className="text-xs text-atlas-muted">{c.descricao}</p>
              </div>
              <div className="flex items-center gap-2">
                {editKey === c.chave ? (
                  <>
                    <input type="number" value={editVal} onChange={(e: ChangeEvent<HTMLInputElement>) => setEditVal(e.target.value)}
                      className="w-20 px-2 py-1 rounded border border-atlas-border bg-atlas-bg text-atlas-text text-xs text-right font-mono" />
                    <button onClick={() => configMut.mutate({ chave: c.chave, valor: editVal })}
                      className="text-xs px-2 py-1 rounded bg-emerald-600 text-white">OK</button>
                    <button onClick={() => setEditKey(null)} className="text-xs px-2 py-1 rounded bg-atlas-border text-atlas-text">X</button>
                  </>
                ) : (
                  <span className="text-xs font-mono text-atlas-text cursor-pointer hover:text-emerald-600"
                    onClick={() => { setEditKey(c.chave); setEditVal(String(c.valor)); }}>
                    {String(c.valor)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Sazonalidade */}
      <div className="bg-atlas-card border border-atlas-border rounded-lg p-5">
        <p className="text-xs text-atlas-muted uppercase tracking-[3px] mb-4">Sazonalidade por Familia</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-atlas-border">
                <th className="px-2 py-2 text-left text-xs text-atlas-muted sticky left-0 bg-atlas-card">Familia</th>
                {MESES.map((m) => <th key={m} className="px-2 py-2 text-center text-xs text-atlas-muted w-14">{m}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-atlas-border/50">
              {sazData.map((fam) => (
                <tr key={fam.familia_id}>
                  <td className="px-2 py-2 text-sm font-medium text-atlas-text sticky left-0 bg-atlas-card whitespace-nowrap">{fam.familia_id}</td>
                  {Array.from({ length: 12 }, (_, i) => {
                    const mesData = fam.meses.find((m) => m.mes === i + 1);
                    const fator = mesData?.fator_efetivo ?? 1.0;
                    const isOverride = mesData?.fator_usuario != null;
                    const bg = fator > 1.1 ? 'rgba(220,38,38,0.08)' : fator < 0.9 ? 'rgba(59,130,246,0.08)' : 'transparent';
                    return (
                      <td key={i} className="px-1 py-1 text-center" style={{ backgroundColor: bg }}>
                        <input type="number" step="0.05" min="0.1" max="3.0" value={fator.toFixed(2)}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => {
                            const v = parseFloat(e.target.value);
                            if (v >= 0.1 && v <= 3.0) sazMut.mutate({ familia_id: fam.familia_id, mes: i + 1, fator: v });
                          }}
                          className={`w-12 px-1 py-0.5 text-center text-xs font-mono rounded border ${isOverride ? 'border-amber-400 bg-amber-50 text-amber-800' : 'border-atlas-border/30 bg-transparent text-atlas-text'}`} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-atlas-muted mt-2">Valores com borda amarela foram editados pelo usuario. 1.00 = media, &gt;1 = pico, &lt;1 = baixa.</p>
      </div>
    </div>
  );
}
