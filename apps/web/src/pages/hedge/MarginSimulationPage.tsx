import { useState, type ChangeEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAuthStore } from '../../stores/auth.store.js';

interface Cenario {
  cambio: number;
  custo_com_hedge: number;
  custo_sem_hedge: number;
  margem_pct: number;
}

function formatBrl(val: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val);
}

export function MarginSimulationPage() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [faturamento, setFaturamento] = useState('5000000');
  const [custos, setCustos] = useState('800000');
  const [volume, setVolume] = useState('500000');
  const [cenarios, setCenarios] = useState<Cenario[]>([]);

  const simMutation = useMutation({
    mutationFn: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
      const res = await fetch('/api/v1/hedge/simulacao/margem', {
        method: 'POST', credentials: 'include', headers,
        body: JSON.stringify({
          faturamento_brl: parseFloat(faturamento),
          outros_custos_brl: parseFloat(custos),
          volume_usd: parseFloat(volume),
        }),
      });
      const body = (await res.json()) as any;
      if (!res.ok) throw new Error(body.error?.message ?? 'Erro');
      return body.data.cenarios as Cenario[];
    },
    onSuccess: (data) => setCenarios(data),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-heading font-bold text-atlas-text">Simulacao de Margem</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-atlas-card border border-atlas-border rounded-xl p-4">
          <label htmlFor="sim-fat" className="block text-sm font-medium text-atlas-text mb-1">Faturamento BRL</label>
          <input id="sim-fat" type="number" value={faturamento} onChange={(e: ChangeEvent<HTMLInputElement>) => setFaturamento(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe" />
        </div>
        <div className="bg-atlas-card border border-atlas-border rounded-xl p-4">
          <label htmlFor="sim-custos" className="block text-sm font-medium text-atlas-text mb-1">Outros Custos BRL</label>
          <input id="sim-custos" type="number" value={custos} onChange={(e: ChangeEvent<HTMLInputElement>) => setCustos(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe" />
        </div>
        <div className="bg-atlas-card border border-atlas-border rounded-xl p-4">
          <label htmlFor="sim-vol" className="block text-sm font-medium text-atlas-text mb-1">Volume USD</label>
          <input id="sim-vol" type="number" value={volume} onChange={(e: ChangeEvent<HTMLInputElement>) => setVolume(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe" />
        </div>
      </div>

      <button onClick={() => simMutation.mutate()} disabled={simMutation.isPending}
        className="px-4 py-2 rounded-lg bg-acxe text-white text-sm font-medium hover:bg-acxe/90 disabled:opacity-50 transition-colors">
        {simMutation.isPending ? 'Calculando...' : 'Simular'}
      </button>

      {cenarios.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-atlas-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-atlas-bg border-b border-atlas-border">
                <th className="px-4 py-3 text-left text-xs font-medium text-atlas-muted uppercase">Cambio</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-atlas-muted uppercase">Custo c/ Hedge</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-atlas-muted uppercase">Custo s/ Hedge</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-atlas-muted uppercase">Margem %</th>
              </tr>
            </thead>
            <tbody className="bg-atlas-card divide-y divide-atlas-border">
              {cenarios.map((c) => (
                <tr key={c.cambio} className="hover:bg-atlas-bg/50">
                  <td className="px-4 py-2 font-mono">{c.cambio.toFixed(2)}</td>
                  <td className="px-4 py-2 text-right">{formatBrl(c.custo_com_hedge)}</td>
                  <td className="px-4 py-2 text-right">{formatBrl(c.custo_sem_hedge)}</td>
                  <td className={`px-4 py-2 text-right font-semibold ${c.margem_pct >= 20 ? 'text-green-600' : c.margem_pct >= 10 ? 'text-yellow-600' : 'text-red-600'}`}>
                    {c.margem_pct.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
