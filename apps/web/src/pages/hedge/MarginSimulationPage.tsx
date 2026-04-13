import { useState, type ChangeEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAuthStore } from '../../stores/auth.store.js';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

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
  const [faturamento, setFaturamento] = useState('25000000');
  const [custos, setCustos] = useState('2500000');
  const [volume, setVolume] = useState('3000000');
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

  // Chart data
  const chartData = cenarios.map((c) => ({
    cambio: `R$${c.cambio.toFixed(2)}`,
    sem_hedge: +((parseFloat(faturamento) - parseFloat(volume) * c.cambio - parseFloat(custos)) / parseFloat(faturamento) * 100).toFixed(2),
    com_hedge: c.margem_pct,
    floor: 15,
  }));

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-heading font-bold text-atlas-text">Simulacao de Margem</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
          <label htmlFor="sim-fat" className="block text-[10px] text-atlas-muted uppercase tracking-wider mb-1">Faturamento BRL</label>
          <input id="sim-fat" type="number" value={faturamento} onChange={(e: ChangeEvent<HTMLInputElement>) => setFaturamento(e.target.value)}
            className="w-full px-3 py-2 rounded border border-atlas-border bg-atlas-bg text-atlas-text text-sm font-mono focus:outline-none focus:ring-1 focus:ring-acxe" />
          <p className="text-[9px] text-atlas-muted mt-1">R$ {(parseFloat(faturamento || '0') / 1e6).toFixed(1)}M</p>
        </div>
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
          <label htmlFor="sim-custos" className="block text-[10px] text-atlas-muted uppercase tracking-wider mb-1">Outros Custos BRL</label>
          <input id="sim-custos" type="number" value={custos} onChange={(e: ChangeEvent<HTMLInputElement>) => setCustos(e.target.value)}
            className="w-full px-3 py-2 rounded border border-atlas-border bg-atlas-bg text-atlas-text text-sm font-mono focus:outline-none focus:ring-1 focus:ring-acxe" />
          <p className="text-[9px] text-atlas-muted mt-1">{((parseFloat(custos || '0') / parseFloat(faturamento || '1')) * 100).toFixed(0)}% do faturamento</p>
        </div>
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
          <label htmlFor="sim-vol" className="block text-[10px] text-atlas-muted uppercase tracking-wider mb-1">Volume USD (exposicao)</label>
          <input id="sim-vol" type="number" value={volume} onChange={(e: ChangeEvent<HTMLInputElement>) => setVolume(e.target.value)}
            className="w-full px-3 py-2 rounded border border-atlas-border bg-atlas-bg text-atlas-text text-sm font-mono focus:outline-none focus:ring-1 focus:ring-acxe" />
          <p className="text-[9px] text-atlas-muted mt-1">$ {(parseFloat(volume || '0') / 1e6).toFixed(2)}M</p>
        </div>
      </div>

      <button onClick={() => simMutation.mutate()} disabled={simMutation.isPending}
        className="px-5 py-2 rounded bg-emerald-600 text-white text-xs font-mono tracking-wider hover:bg-emerald-700 disabled:opacity-50 transition-colors">
        {simMutation.isPending ? 'Calculando...' : 'Simular 13 cenarios'}
      </button>

      {cenarios.length > 0 && (
        <>
          {/* Chart */}
          <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
            <p className="text-[9px] text-atlas-muted uppercase tracking-[2px] mb-3">Margem vs Variacao Cambial — Sem Hedge vs Com NDF</p>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(221,225,232,0.5)" />
                <XAxis dataKey="cambio" tick={{ fontSize: 9 }} interval={1} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(v: number) => `${v}%`} />
                <Tooltip formatter={(v) => `${Number(v).toFixed(2)}%`} />
                <Legend />
                <Line type="monotone" dataKey="sem_hedge" name="Sem hedge" stroke="#dc2626" strokeWidth={1.5} strokeDasharray="3 2" dot={false} />
                <Line type="monotone" dataKey="com_hedge" name="Com NDF" stroke="#059669" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="floor" name="Floor 15%" stroke="rgba(220,38,38,0.3)" strokeWidth={1} strokeDasharray="2 4" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Table */}
          <div className="overflow-x-auto rounded-lg border border-atlas-border">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="bg-atlas-bg border-b border-atlas-border">
                  <th className="px-3 py-2.5 text-left text-[9px] font-normal text-atlas-muted uppercase tracking-wider">Cambio</th>
                  <th className="px-3 py-2.5 text-right text-[9px] font-normal text-atlas-muted uppercase tracking-wider">Custo c/ Hedge</th>
                  <th className="px-3 py-2.5 text-right text-[9px] font-normal text-atlas-muted uppercase tracking-wider">Custo s/ Hedge</th>
                  <th className="px-3 py-2.5 text-right text-[9px] font-normal text-atlas-muted uppercase tracking-wider">Margem %</th>
                </tr>
              </thead>
              <tbody className="bg-atlas-card divide-y divide-atlas-border/50">
                {cenarios.map((c) => (
                  <tr key={c.cambio} className="hover:bg-atlas-bg/50">
                    <td className="px-3 py-2">R$ {c.cambio.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right">{formatBrl(c.custo_com_hedge)}</td>
                    <td className="px-3 py-2 text-right">{formatBrl(c.custo_sem_hedge)}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${c.margem_pct >= 20 ? 'text-emerald-600' : c.margem_pct >= 10 ? 'text-amber-600' : 'text-red-600'}`}>
                      {c.margem_pct.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
