import { useState, type ChangeEvent } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useAuthStore } from '../../stores/auth.store.js';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, Legend,
} from 'recharts';

interface ForecastResult {
  familia_id: string; familia_nome: string; is_internacional: boolean; lt_efetivo: number;
  pool_total: number; cmc_medio: number; vendas12m: number; venda_diaria_media: number;
  venda_diaria_sazonalizada: number; cobertura_dias: number; dia_ruptura: number;
  dia_pedido_ideal: number; prazo_perdido: boolean; status: string;
  qtd_sugerida: number; moq_ativo: number; valor_brl: number;
  compra_local: { dia_abrir: number; lt_local: number; gap_dias: number; custo_oportunidade: number; qtd_local: number; valor_local: number } | null;
  serie: Array<{ dia: number; data: string; estoque: number; chegada: number; zona: string; venda_dia: number }>;
  skus: Array<{ codigo: string; descricao: string; disponivel: number; transito: number; total: number; cmc: number; venda_dia: number; cobertura: number; lt: number }>;
  pedidos_em_rota: Array<{ codigo: string; qtd_pendente: number; data_chegada: string }>;
}

const fmtT = (kg: number) => kg >= 1000 ? `${(kg / 1000).toFixed(1)}t` : `${kg}kg`;
const fmtBrl = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);


export function RollingForecastPage() {
  const [selectedFamilia, setSelectedFamilia] = useState('');
  const csrfToken = useAuthStore((s) => s.csrfToken);

  const { data: results = [] } = useQuery<ForecastResult[]>({
    queryKey: ['forecast', 'calcular'],
    queryFn: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
      const res = await fetch('/api/v1/forecast/calcular', {
        method: 'POST', credentials: 'include', headers, body: JSON.stringify({}),
      });
      const body = (await res.json()) as any;
      return body.data ?? [];
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const selected = selectedFamilia
    ? results.find((r) => r.familia_id === selectedFamilia)
    : results[0];

  const chartData = selected?.serie.map((s) => ({
    data: s.data.slice(5), // MM-DD
    estoque: s.estoque,
    chegada: s.chegada > 0 ? s.chegada : undefined,
  })) ?? [];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-bold text-atlas-text">Rolling Forecast 120 Dias</h1>
        <select value={selectedFamilia} onChange={(e: ChangeEvent<HTMLSelectElement>) => setSelectedFamilia(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm min-w-[200px]">
          {results.map((r) => <option key={r.familia_id} value={r.familia_id}>{r.familia_nome}</option>)}
        </select>
      </div>

      {selected && (
        <>
          {/* Summary strip */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <MiniCard label="Estoque" value={fmtT(selected.pool_total)} />
            <MiniCard label="Venda/dia" value={fmtT(selected.venda_diaria_sazonalizada)} />
            <MiniCard label="Cobertura" value={selected.cobertura_dias < 999 ? `${selected.cobertura_dias}d` : '—'} color={selected.cobertura_dias <= 30 ? '#dc2626' : selected.cobertura_dias <= 60 ? '#d97706' : '#059669'} />
            <MiniCard label="Ruptura" value={selected.dia_ruptura >= 0 ? `Dia ${selected.dia_ruptura}` : 'Nenhuma'} color={selected.dia_ruptura >= 0 ? '#dc2626' : '#059669'} />
            <MiniCard label="Pedir em" value={selected.dia_pedido_ideal >= 0 ? `Dia ${selected.dia_pedido_ideal}` : selected.prazo_perdido ? 'PERDIDO' : '—'} color={selected.prazo_perdido ? '#dc2626' : '#d97706'} />
            <MiniCard label="Sugestao" value={fmtT(selected.qtd_sugerida)} sub={fmtBrl(selected.valor_brl)} />
          </div>

          {/* Chart */}
          <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
            <p className="text-[9px] text-atlas-muted uppercase tracking-[3px] mb-3">Projecao de Estoque — {selected.familia_nome}</p>
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="estGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#059669" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#059669" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(221,225,232,0.5)" />
                <XAxis dataKey="data" tick={{ fontSize: 9 }} interval={9} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(v: number) => fmtT(v)} />
                <Tooltip formatter={(v) => fmtT(Number(v))} />
                <Legend />
                <Area type="monotone" dataKey="estoque" name="Estoque (kg)" stroke="#059669" fill="url(#estGrad)" strokeWidth={2} />
                {selected.dia_ruptura >= 0 && (
                  <ReferenceLine x={chartData[selected.dia_ruptura]?.data} stroke="#dc2626" strokeDasharray="3 3" label={{ value: 'Ruptura', fontSize: 9, fill: '#dc2626' }} />
                )}
                {selected.dia_pedido_ideal >= 0 && selected.dia_pedido_ideal < chartData.length && (
                  <ReferenceLine x={chartData[selected.dia_pedido_ideal]?.data} stroke="#d97706" strokeDasharray="3 3" label={{ value: 'Pedir', fontSize: 9, fill: '#d97706' }} />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Compra local card */}
          {selected.compra_local && (
            <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-4">
              <p className="text-[9px] text-red-600 uppercase tracking-[3px] mb-2">Compra Local Emergencial</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div><span className="text-atlas-muted">Abrir pedido em</span><p className="font-bold text-red-600">Dia {selected.compra_local.dia_abrir}</p></div>
                <div><span className="text-atlas-muted">Gap sem estoque</span><p className="font-bold">{selected.compra_local.gap_dias} dias</p></div>
                <div><span className="text-atlas-muted">Qtd local (MOQ 12t)</span><p className="font-bold">{fmtT(selected.compra_local.qtd_local)}</p></div>
                <div><span className="text-atlas-muted">Custo oportunidade</span><p className="font-bold text-red-600">{fmtBrl(selected.compra_local.custo_oportunidade)}</p></div>
              </div>
            </div>
          )}

          {/* SKU grid */}
          <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
            <p className="text-[9px] text-atlas-muted uppercase tracking-[2px] mb-2">SKUs — {selected.familia_nome}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-atlas-border">
                    <th className="px-2 py-1.5 text-left text-[9px] text-atlas-muted">Codigo</th>
                    <th className="px-2 py-1.5 text-left text-[9px] text-atlas-muted">Descricao</th>
                    <th className="px-2 py-1.5 text-right text-[9px] text-atlas-muted">Disp.</th>
                    <th className="px-2 py-1.5 text-right text-[9px] text-atlas-muted">Transit.</th>
                    <th className="px-2 py-1.5 text-right text-[9px] text-atlas-muted">Total</th>
                    <th className="px-2 py-1.5 text-right text-[9px] text-atlas-muted">Venda/dia</th>
                    <th className="px-2 py-1.5 text-right text-[9px] text-atlas-muted">Cobert.</th>
                    <th className="px-2 py-1.5 text-right text-[9px] text-atlas-muted">LT</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-atlas-border/50">
                  {selected.skus.map((sk) => (
                    <tr key={sk.codigo}>
                      <td className="px-2 py-1.5">{sk.codigo}</td>
                      <td className="px-2 py-1.5 truncate max-w-[180px]">{sk.descricao}</td>
                      <td className="px-2 py-1.5 text-right">{fmtT(sk.disponivel)}</td>
                      <td className="px-2 py-1.5 text-right text-blue-600">{sk.transito > 0 ? fmtT(sk.transito) : '—'}</td>
                      <td className="px-2 py-1.5 text-right font-semibold">{fmtT(sk.total)}</td>
                      <td className="px-2 py-1.5 text-right">{sk.venda_dia > 0 ? fmtT(sk.venda_dia) : '—'}</td>
                      <td className="px-2 py-1.5 text-right">{sk.cobertura < 999 ? `${sk.cobertura}d` : '—'}</td>
                      <td className="px-2 py-1.5 text-right">{sk.lt}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pedidos em rota */}
          {selected.pedidos_em_rota.length > 0 && (
            <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
              <p className="text-[9px] text-atlas-muted uppercase tracking-[2px] mb-2">Pedidos em Rota</p>
              <div className="space-y-1">
                {selected.pedidos_em_rota.map((p, i) => (
                  <div key={i} className="flex items-center justify-between text-xs py-1.5 border-b border-atlas-border/50 last:border-0">
                    <span className="text-atlas-text font-mono">{p.codigo}</span>
                    <span className="text-blue-600 font-semibold">{fmtT(p.qtd_pendente)}</span>
                    <span className="text-atlas-muted">{new Date(p.data_chegada).toLocaleDateString('pt-BR')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MiniCard({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="bg-atlas-card border border-atlas-border rounded-lg p-3">
      <p className="text-[9px] text-atlas-muted uppercase tracking-wider mb-1">{label}</p>
      <p className="text-lg font-bold" style={{ color }}>{value}</p>
      {sub && <p className="text-[9px] text-atlas-muted mt-0.5">{sub}</p>}
    </div>
  );
}
