import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';

interface ConfigProduto {
  produtoCodigoAcxe: number;
  nomeProduto: string;
  familiaOmie: string | null;
  consumoMedioDiarioT: number | null;
  leadTimeDias: number | null;
  familiaCategoria: string | null;
  incluirEmMetricas: boolean;
}

function useApiFetch() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  return async (url: string, opts: RequestInit = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers as Record<string, string>) };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    const res = await fetch(url, { credentials: 'include', ...opts, headers });
    const body = (await res.json()) as { data: unknown; error: { message?: string } | null };
    if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
    return body;
  };
}

export function ConfigProdutosPage() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const [editando, setEditando] = useState<number | null>(null);
  const [busca, setBusca] = useState('');
  const [edits, setEdits] = useState<Record<number, Partial<ConfigProduto>>>({});

  const { data = [] } = useQuery<ConfigProduto[]>({
    queryKey: ['sb', 'config-produtos'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/config/produtos')).data as ConfigProduto[],
  });

  const salvarMut = useMutation({
    mutationFn: async (codigo: number) => {
      const patch = edits[codigo] ?? {};
      const payload: Record<string, unknown> = {};
      if (patch.consumoMedioDiarioT !== undefined) payload.consumo_medio_diario_t = patch.consumoMedioDiarioT;
      if (patch.leadTimeDias !== undefined) payload.lead_time_dias = patch.leadTimeDias;
      if (patch.familiaCategoria !== undefined) payload.familia_categoria = patch.familiaCategoria;
      if (patch.incluirEmMetricas !== undefined) payload.incluir_em_metricas = patch.incluirEmMetricas;
      return apiFetch(`/api/v1/stockbridge/config/produtos/${codigo}`, { method: 'PATCH', body: JSON.stringify(payload) });
    },
    onSuccess: (_, codigo) => {
      setEditando(null);
      setEdits((prev) => {
        const next = { ...prev };
        delete next[codigo];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ['sb', 'config-produtos'] });
      queryClient.invalidateQueries({ queryKey: ['stockbridge', 'cockpit'] });
    },
  });

  const filtrado = data.filter((p) =>
    !busca ||
    p.nomeProduto.toLowerCase().includes(busca.toLowerCase()) ||
    String(p.produtoCodigoAcxe).includes(busca) ||
    (p.familiaOmie?.toLowerCase().includes(busca.toLowerCase()) ?? false),
  );

  return (
    <div className="p-6 max-w-6xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Configuracao de Produtos</h1>
        <p className="text-sm text-atlas-muted">
          Consumo medio diario, lead time e familia para calculo de cobertura e criticidade.
        </p>
      </div>

      <input
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        placeholder="Buscar por nome, codigo ou familia..."
        className="w-full mb-4 px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
      />

      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-900/40 text-atlas-muted">
            <tr>
              <th className="text-left px-3 py-2">SKU</th>
              <th className="text-left px-3 py-2">Familia OMIE</th>
              <th className="text-right px-3 py-2">Consumo (t/dia)</th>
              <th className="text-right px-3 py-2">Lead Time (dias)</th>
              <th className="text-left px-3 py-2">Familia Atlas</th>
              <th className="text-center px-3 py-2">Em metricas</th>
              <th className="text-right px-3 py-2">Acao</th>
            </tr>
          </thead>
          <tbody>
            {filtrado.map((p) => {
              const editavel = editando === p.produtoCodigoAcxe;
              const current = { ...p, ...edits[p.produtoCodigoAcxe] };
              return (
                <tr key={p.produtoCodigoAcxe} className="border-t border-slate-200 dark:border-slate-700">
                  <td className="px-3 py-2">
                    <div className="font-medium">{p.nomeProduto}</div>
                    <div className="text-[10px] font-mono text-atlas-muted">{p.produtoCodigoAcxe}</div>
                  </td>
                  <td className="px-3 py-2 text-atlas-muted">{p.familiaOmie ?? '—'}</td>
                  <td className="px-3 py-2 text-right">
                    {editavel ? (
                      <input
                        type="number"
                        step="0.01"
                        value={current.consumoMedioDiarioT ?? ''}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [p.produtoCodigoAcxe]: { ...prev[p.produtoCodigoAcxe], consumoMedioDiarioT: e.target.value ? Number(e.target.value) : null } }))}
                        className="w-20 px-2 py-1 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-xs text-right"
                      />
                    ) : (
                      p.consumoMedioDiarioT != null ? p.consumoMedioDiarioT.toFixed(2) : '—'
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {editavel ? (
                      <input
                        type="number"
                        value={current.leadTimeDias ?? ''}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [p.produtoCodigoAcxe]: { ...prev[p.produtoCodigoAcxe], leadTimeDias: e.target.value ? Number(e.target.value) : null } }))}
                        className="w-16 px-2 py-1 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-xs text-right"
                      />
                    ) : (
                      p.leadTimeDias ?? '—'
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {editavel ? (
                      <input
                        value={current.familiaCategoria ?? ''}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [p.produtoCodigoAcxe]: { ...prev[p.produtoCodigoAcxe], familiaCategoria: e.target.value || null } }))}
                        placeholder="PP / PE / PS"
                        className="w-24 px-2 py-1 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-xs"
                      />
                    ) : (
                      p.familiaCategoria ?? '—'
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={current.incluirEmMetricas ?? true}
                      onChange={(e) => {
                        setEdits((prev) => ({ ...prev, [p.produtoCodigoAcxe]: { ...prev[p.produtoCodigoAcxe], incluirEmMetricas: e.target.checked } }));
                        setEditando(p.produtoCodigoAcxe);
                      }}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {editavel ? (
                      <>
                        <button
                          onClick={() => salvarMut.mutate(p.produtoCodigoAcxe)}
                          className="px-2 py-1 bg-atlas-ink text-white rounded text-xs"
                        >
                          Salvar
                        </button>
                        <button
                          onClick={() => { setEditando(null); setEdits((prev) => { const next = { ...prev }; delete next[p.produtoCodigoAcxe]; return next; }); }}
                          className="ml-1 px-2 py-1 border border-slate-300 rounded text-xs"
                        >
                          x
                        </button>
                      </>
                    ) : (
                      <button onClick={() => setEditando(p.produtoCodigoAcxe)} className="px-2 py-1 border border-slate-300 rounded text-xs">
                        Editar
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
