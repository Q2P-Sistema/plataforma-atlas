import { useState, type ChangeEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';

interface EstoqueRow {
  localidade: string;
  empresa: string;
  origem: string;
  itens: number;
  valor_brl: number;
  custo_usd_estimado: number;
  ptax_ref: number;
}

const fmtBrlM = (v: number) => 'R$' + (v / 1e6).toFixed(1) + 'M';
const fmtBrl = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
const fmtUsd = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);

const ORIGEM_LABELS: Record<string, string> = {
  em_transito: 'Em Transito',
  importado_no_chao: 'Importado (deposito)',
  nacional: 'Nacional',
};

const ORIGEM_COLORS: Record<string, string> = {
  em_transito: '#f59e0b',
  importado_no_chao: '#3b82f6',
  nacional: '#10b981',
};

function KpiCard({ label, value, color, src, sub }: { label: string; value: string; color: string; src: string; sub?: string }) {
  const srcStyles: Record<string, string> = {
    acxe: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
    q2p: 'bg-green-500/10 text-green-600 border-green-500/20',
    calc: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  };
  return (
    <div className="bg-atlas-card border border-atlas-border rounded-lg p-4 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ backgroundColor: color }} />
      <div className="flex items-center gap-2 mb-2">
        <p className="text-[9px] text-atlas-muted uppercase tracking-wider">{label}</p>
        <span className={`inline-flex text-[8px] px-1.5 py-0.5 rounded border font-semibold tracking-wider uppercase ${srcStyles[src] ?? srcStyles.calc}`}>
          {src.toUpperCase()}
        </span>
      </div>
      <p className="text-xl font-bold" style={{ color }}>{value}</p>
      {sub && <p className="text-[10px] text-atlas-muted mt-1">{sub}</p>}
    </div>
  );
}

export function InventoryPage() {
  const [empresa, setEmpresa] = useState('');

  const { data: estoque = [], isLoading } = useQuery<EstoqueRow[]>({
    queryKey: ['hedge', 'estoque', empresa],
    queryFn: async () => {
      const params = empresa ? `?empresa=${empresa}` : '';
      const res = await fetch(`/api/v1/hedge/estoque${params}`, { credentials: 'include' });
      const body = (await res.json()) as any;
      return body.data ?? [];
    },
  });

  if (isLoading) {
    return <div className="flex items-center justify-center min-h-[40vh]"><p className="text-atlas-muted">Carregando...</p></div>;
  }

  // Aggregate by origem
  const byOrigem = new Map<string, { brl: number; usd: number; itens: number }>();
  for (const r of estoque) {
    const cur = byOrigem.get(r.origem) ?? { brl: 0, usd: 0, itens: 0 };
    cur.brl += r.valor_brl;
    cur.usd += r.custo_usd_estimado;
    cur.itens += r.itens;
    byOrigem.set(r.origem, cur);
  }

  const transitoBrl = byOrigem.get('em_transito')?.brl ?? 0;
  const importadoBrl = byOrigem.get('importado_no_chao')?.brl ?? 0;
  const nacionalBrl = byOrigem.get('nacional')?.brl ?? 0;
  const totalBrl = transitoBrl + importadoBrl + nacionalBrl;
  const totalItens = estoque.reduce((s, r) => s + r.itens, 0);

  // Bar chart: estados do estoque (horizontal)
  const estadosData = [
    { name: 'Maritimo / Transito', value: transitoBrl / 1e6, fill: 'rgba(132,146,166,0.55)' },
    { name: 'Nac. Acxe (deposito)', value: importadoBrl / 1e6, fill: 'rgba(0,119,204,0.55)' },
    { name: 'Depositos Q2P', value: nacionalBrl / 1e6, fill: 'rgba(26,153,68,0.55)' },
  ];

  // Pie: por origem
  const pieData = Array.from(byOrigem.entries()).map(([origem, data]) => ({
    name: ORIGEM_LABELS[origem] ?? origem,
    value: data.brl,
    color: ORIGEM_COLORS[origem] ?? '#6b7280',
  }));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-bold text-atlas-text">Estoque Importado</h1>
        <select value={empresa} onChange={(e: ChangeEvent<HTMLSelectElement>) => setEmpresa(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm focus:outline-none focus:ring-2 focus:ring-acxe">
          <option value="">Todas</option><option value="acxe">ACXE</option><option value="q2p">Q2P</option>
        </select>
      </div>

      {/* KPI Strip — 5 fases */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <KpiCard label="Maritimo / Transito" value={fmtBrlM(transitoBrl)} color="#8492a6" src="acxe" sub="Cambio ainda flutuante" />
        <KpiCard label="Importado no Chao" value={fmtBrlM(importadoBrl)} color="#0077cc" src="acxe" sub="NF entrada emitida" />
        <KpiCard label="Nacional Q2P" value={fmtBrlM(nacionalBrl)} color="#1a9944" src="q2p" sub="Distribuicao ativa" />
        <KpiCard label="Total Consolidado" value={fmtBrlM(totalBrl)} color="#059669" src="calc" sub={`${totalItens} produtos`} />
        <KpiCard label="Localidades" value={String(estoque.length)} color="#7c3aed" src="calc" sub="Depots ativos" />
      </div>

      {/* Estados chart + Pie */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
          <p className="text-[9px] text-atlas-muted uppercase tracking-[3px] mb-3">Estados do Estoque — Fluxo Completo</p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={estadosData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(221,225,232,0.5)" />
              <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={(v: number) => `R$${v}M`} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={140} />
              <Tooltip formatter={(v) => `R$ ${Number(v).toFixed(1)}M`} />
              <Bar dataKey="value" name="Valor BRL" radius={[0, 4, 4, 0]}>
                {estadosData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
          <p className="text-[9px] text-atlas-muted uppercase tracking-[3px] mb-3">Estoque por Origem (R$M)</p>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value">
                {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
              </Pie>
              <Tooltip formatter={(v) => fmtBrl(Number(v))} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Depot grid cards */}
      <div>
        <p className="text-[9px] text-atlas-muted uppercase tracking-[3px] mb-3">Depositos Regionais + Transito</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {estoque.map((d) => (
            <div key={`${d.localidade}-${d.empresa}`}
              className="bg-atlas-card border border-atlas-border rounded-lg p-4 hover:border-acxe/30 transition-colors">
              <p className="text-xs font-semibold mb-2" style={{ color: d.empresa === 'acxe' ? '#0077cc' : '#1a9944' }}>
                {d.localidade}
              </p>
              <div className="space-y-1 text-[11px]">
                <div className="flex justify-between border-b border-atlas-border/50 pb-1">
                  <span className="text-atlas-muted">Empresa</span>
                  <span className="font-mono text-atlas-text">{d.empresa.toUpperCase()}</span>
                </div>
                <div className="flex justify-between border-b border-atlas-border/50 pb-1">
                  <span className="text-atlas-muted">Origem</span>
                  <span className="font-mono text-atlas-text">
                    <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: ORIGEM_COLORS[d.origem] ?? '#6b7280' }} />
                    {ORIGEM_LABELS[d.origem] ?? d.origem}
                  </span>
                </div>
                <div className="flex justify-between border-b border-atlas-border/50 pb-1">
                  <span className="text-atlas-muted">Produtos</span>
                  <span className="font-mono text-atlas-text">{d.itens}</span>
                </div>
                <div className="flex justify-between border-b border-atlas-border/50 pb-1">
                  <span className="text-atlas-muted">Valor BRL</span>
                  <span className="font-mono text-atlas-text">{fmtBrlM(d.valor_brl)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-atlas-muted">Valor USD</span>
                  <span className="font-mono text-atlas-text">{fmtUsd(d.custo_usd_estimado)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Insights */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="rounded-r p-3 text-xs leading-relaxed" style={{ borderLeft: '2px solid #d97706', backgroundColor: 'rgba(217,119,6,0.08)' }}>
          <strong className="text-atlas-text">Transito aduaneiro:</strong>{' '}
          <span className="text-atlas-muted">{fmtBrlM(transitoBrl)} em mercadoria em transito maritimo — cambio ainda flutuante</span>
        </div>
        <div className="rounded-r p-3 text-xs leading-relaxed" style={{ borderLeft: '2px solid #0077cc', backgroundColor: 'rgba(0,119,204,0.07)' }}>
          <strong className="text-atlas-text">Estoque Acxe:</strong>{' '}
          <span className="text-atlas-muted">{fmtBrlM(importadoBrl)} nacionalizado nos depositos — custo fixo em BRL</span>
        </div>
        <div className="rounded-r p-3 text-xs leading-relaxed" style={{ borderLeft: '2px solid #1a9944', backgroundColor: 'rgba(26,153,68,0.07)' }}>
          <strong className="text-atlas-text">Estoque Q2P:</strong>{' '}
          <span className="text-atlas-muted">{fmtBrlM(nacionalBrl)} em distribuicao ativa nos depositos Q2P</span>
        </div>
      </div>
    </div>
  );
}
