import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth.store.js';

interface ConfigProduto {
  produtoCodigoAcxe: number;
  nomeProduto: string;
  familiaOmie: string | null;
  familiaAtlas: string | null;
  consumoMedioDiarioKg: number | null;
  leadTimeDias: number | null;
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
  const [busca, setBusca] = useState('');

  const { data = [] } = useQuery<ConfigProduto[]>({
    queryKey: ['sb', 'config-produtos'],
    queryFn: async () => (await apiFetch('/api/v1/stockbridge/config/produtos')).data as ConfigProduto[],
  });

  const filtrado = data.filter((p) =>
    !busca ||
    p.nomeProduto.toLowerCase().includes(busca.toLowerCase()) ||
    String(p.produtoCodigoAcxe).includes(busca) ||
    (p.familiaOmie?.toLowerCase().includes(busca.toLowerCase()) ?? false) ||
    (p.familiaAtlas?.toLowerCase().includes(busca.toLowerCase()) ?? false),
  );

  return (
    <div className="p-6 max-w-6xl">
      <div className="mb-5">
        <h1 className="text-2xl font-serif text-atlas-ink mb-1">Configuração de Produtos</h1>
        <p className="text-sm text-atlas-muted">
          Consumo médio diário (calculado das vendas Q2P+ACXE), lead time e família.
          Dados sincronizados do banco — sem edição manual.
        </p>
      </div>

      <input
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        placeholder="Buscar por nome, código ou família..."
        className="w-full mb-4 px-3 py-2 border border-slate-300 dark:border-slate-600 dark:bg-slate-900 rounded text-sm"
      />

      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-900/95 text-atlas-muted shadow-sm">
            <tr>
              <th className="text-left px-3 py-2">SKU</th>
              <th className="text-left px-3 py-2">Família OMIE</th>
              <th className="text-left px-3 py-2">Família Atlas</th>
              <th className="text-right px-3 py-2">Consumo (kg/dia)</th>
              <th className="text-right px-3 py-2">Lead Time (dias)</th>
              <th className="text-center px-3 py-2">Em métricas</th>
            </tr>
          </thead>
          <tbody>
            {filtrado.map((p) => (
              <tr key={p.produtoCodigoAcxe} className="border-t border-slate-200 dark:border-slate-700">
                <td className="px-3 py-2">
                  <div className="font-medium">{p.nomeProduto}</div>
                  <div className="text-[10px] font-mono text-atlas-muted">{p.produtoCodigoAcxe}</div>
                </td>
                <td className="px-3 py-2 text-atlas-muted">{p.familiaOmie ?? '—'}</td>
                <td className="px-3 py-2 text-atlas-muted">{p.familiaAtlas ?? '—'}</td>
                <td className="px-3 py-2 text-right">
                  {p.consumoMedioDiarioKg != null ? p.consumoMedioDiarioKg.toFixed(2) : '—'}
                </td>
                <td className="px-3 py-2 text-right">{p.leadTimeDias ?? '—'}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`text-xs px-2 py-0.5 rounded ${p.incluirEmMetricas ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                    {p.incluirEmMetricas ? 'sim' : 'não'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
