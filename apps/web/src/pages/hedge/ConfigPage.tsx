import { useState, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../stores/auth.store.js';

interface ConfigRow { chave: string; valor: any; descricao: string | null; }

function useHedgeFetch() {
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

export function ConfigPage() {
  const queryClient = useQueryClient();
  const hedgeFetch = useHedgeFetch();
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');
  const [taxaForm, setTaxaForm] = useState({ data_ref: '', prazo_dias: '90', taxa: '' });

  const { data: configs = [] } = useQuery<ConfigRow[]>({
    queryKey: ['hedge', 'config'],
    queryFn: async () => { const b = await hedgeFetch('/api/v1/hedge/config'); return b.data; },
  });

  const updateMut = useMutation({
    mutationFn: async ({ chave, valor }: { chave: string; valor: string }) =>
      hedgeFetch('/api/v1/hedge/config', { method: 'PATCH', body: JSON.stringify({ chave, valor }) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['hedge', 'config'] }); setEditKey(null); },
  });

  const taxaMut = useMutation({
    mutationFn: async () =>
      hedgeFetch('/api/v1/hedge/taxas-ndf', { method: 'POST', body: JSON.stringify({
        data_ref: taxaForm.data_ref, prazo_dias: parseInt(taxaForm.prazo_dias, 10), taxa: parseFloat(taxaForm.taxa),
      })}),
    onSuccess: () => setTaxaForm({ data_ref: '', prazo_dias: '90', taxa: '' }),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-heading font-bold text-atlas-text">Configuracao</h1>

      <div className="bg-atlas-card border border-atlas-border rounded-xl p-4">
        <h2 className="text-lg font-semibold text-atlas-text mb-3">Parametros do Motor</h2>
        <div className="space-y-2">
          {configs.map((c) => (
            <div key={c.chave} className="flex items-center justify-between py-2 border-b border-atlas-border last:border-0">
              <div>
                <p className="text-sm font-medium text-atlas-text">{c.chave}</p>
                {c.descricao && <p className="text-xs text-atlas-muted">{c.descricao}</p>}
              </div>
              {editKey === c.chave ? (
                <div className="flex items-center gap-2">
                  <input type="text" value={editVal} onChange={(e: ChangeEvent<HTMLInputElement>) => setEditVal(e.target.value)}
                    className="w-32 px-2 py-1 rounded border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe" />
                  <button onClick={() => updateMut.mutate({ chave: c.chave, valor: editVal })}
                    className="text-xs px-2 py-1 rounded bg-acxe text-white">Salvar</button>
                  <button onClick={() => setEditKey(null)} className="text-xs px-2 py-1 rounded bg-atlas-border text-atlas-text">Cancelar</button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono text-atlas-text">{JSON.stringify(c.valor)}</span>
                  <button onClick={() => { setEditKey(c.chave); setEditVal(String(c.valor)); }}
                    className="text-xs px-2 py-1 rounded bg-atlas-border text-atlas-text hover:bg-atlas-muted/20">Editar</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="bg-atlas-card border border-atlas-border rounded-xl p-4">
        <h2 className="text-lg font-semibold text-atlas-text mb-3">Inserir Taxa NDF</h2>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label htmlFor="taxa-data" className="block text-sm font-medium text-atlas-text mb-1">Data</label>
            <input id="taxa-data" type="date" value={taxaForm.data_ref}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setTaxaForm({ ...taxaForm, data_ref: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe" />
          </div>
          <div>
            <label htmlFor="taxa-prazo" className="block text-sm font-medium text-atlas-text mb-1">Prazo (dias)</label>
            <select id="taxa-prazo" value={taxaForm.prazo_dias}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setTaxaForm({ ...taxaForm, prazo_dias: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe">
              <option value="30">30d</option><option value="60">60d</option><option value="90">90d</option>
              <option value="120">120d</option><option value="180">180d</option>
            </select>
          </div>
          <div>
            <label htmlFor="taxa-valor" className="block text-sm font-medium text-atlas-text mb-1">Taxa</label>
            <input id="taxa-valor" type="number" step="0.0001" value={taxaForm.taxa} placeholder="5.8500"
              onChange={(e: ChangeEvent<HTMLInputElement>) => setTaxaForm({ ...taxaForm, taxa: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe" />
          </div>
        </div>
        <button onClick={() => taxaMut.mutate()} disabled={!taxaForm.data_ref || !taxaForm.taxa || taxaMut.isPending}
          className="mt-3 px-4 py-2 rounded-lg bg-acxe text-white text-sm font-medium hover:bg-acxe/90 disabled:opacity-50 transition-colors">
          {taxaMut.isPending ? 'Salvando...' : 'Inserir Taxa'}
        </button>
      </div>
    </div>
  );
}
