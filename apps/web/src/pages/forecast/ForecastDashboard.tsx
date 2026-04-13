import { useState, type ChangeEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DataTable, type Column } from '@atlas/ui';

interface Sku {
  codigo: string; descricao: string; disponivel: number; bloqueado: number;
  transito: number; total: number; cmc: number; venda_dia: number; cobertura: number; lt: number;
}

interface FamiliaRow {
  familia_id: string; familia_nome: string; is_internacional: boolean;
  pool_disponivel: number; pool_bloqueado: number; pool_transito: number; pool_total: number;
  cmc_medio: number; vendas12m: number; venda_diaria_media: number; cobertura_dias: number;
  lt_efetivo: number; status: string; skus_count: number; skus: Sku[];
}

const fmtT = (kg: number) => kg >= 1000 ? `${(kg / 1000).toFixed(1)}t` : `${kg}kg`;

const STATUS_STYLE: Record<string, string> = {
  critico: 'bg-red-500/10 text-red-600 border-red-500/20',
  atencao: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  ok: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
};

export function ForecastDashboard() {
  const [statusFilter, setStatusFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: familias = [], isLoading } = useQuery<FamiliaRow[]>({
    queryKey: ['forecast', 'familias'],
    queryFn: async () => {
      const res = await fetch('/api/v1/forecast/familias', { credentials: 'include' });
      const body = (await res.json()) as any;
      return body.data ?? [];
    },
  });

  const filtered = statusFilter ? familias.filter((f) => f.status === statusFilter) : familias;

  // KPIs
  const totalEstoque = familias.reduce((s, f) => s + f.pool_total, 0);
  const criticas = familias.filter((f) => f.status === 'critico').length;
  const atencao = familias.filter((f) => f.status === 'atencao').length;
  const proxRuptura = familias.filter((f) => f.cobertura_dias < 999).sort((a, b) => a.cobertura_dias - b.cobertura_dias)[0];

  const columns: Column<FamiliaRow>[] = [
    { key: 'familia_nome', header: 'Familia', sortable: true, render: (r) => (
      <button onClick={() => setExpanded(expanded === r.familia_id ? null : r.familia_id)}
        className="text-left text-xs font-semibold text-atlas-text hover:text-blue-600 transition-colors">
        <span className="mr-1">{expanded === r.familia_id ? '\u25BC' : '\u25B6'}</span>
        {r.familia_nome}
        {r.is_internacional && <span className="ml-1 text-xs text-blue-500">INTL</span>}
      </button>
    )},
    { key: 'pool_disponivel', header: 'Disponivel', sortable: true, render: (r) => fmtT(r.pool_disponivel) },
    { key: 'pool_bloqueado', header: 'Reservado', render: (r) => r.pool_bloqueado > 0 ? <span className="text-amber-600">{fmtT(r.pool_bloqueado)}</span> : '—' },
    { key: 'pool_transito', header: 'Transito', render: (r) => r.pool_transito > 0 ? <span className="text-blue-600">{fmtT(r.pool_transito)}</span> : '—' },
    { key: 'pool_total', header: 'Total', sortable: true, render: (r) => <span className="font-semibold">{fmtT(r.pool_total)}</span> },
    { key: 'cmc_medio', header: 'CMC R$/kg', render: (r) => `R$ ${r.cmc_medio.toFixed(2)}` },
    { key: 'venda_diaria_media', header: 'Venda/dia', sortable: true, render: (r) => r.venda_diaria_media > 0 ? fmtT(r.venda_diaria_media) : <span className="text-atlas-muted">—</span> },
    { key: 'cobertura_dias', header: 'Cobertura', sortable: true, render: (r) => {
      if (r.cobertura_dias >= 999) return <span className="text-atlas-muted">sem hist.</span>;
      const color = r.cobertura_dias <= 30 ? '#dc2626' : r.cobertura_dias <= 60 ? '#d97706' : '#059669';
      return <span style={{ color }} className="font-semibold">{r.cobertura_dias}d</span>;
    }},
    { key: 'status', header: 'Status', sortable: true, render: (r) => (
      <span className={`inline-flex text-xs px-1.5 py-0.5 rounded border font-semibold ${STATUS_STYLE[r.status] ?? ''}`}>{r.status}</span>
    )},
  ];

  if (isLoading) return <div className="flex items-center justify-center min-h-[40vh]"><p className="text-atlas-muted">Carregando...</p></div>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-bold text-atlas-text">Forecast Planner</h1>
        <select value={statusFilter} onChange={(e: ChangeEvent<HTMLSelectElement>) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-atlas-border bg-atlas-bg text-atlas-text text-sm">
          <option value="">Todos</option>
          <option value="critico">Critico</option>
          <option value="atencao">Atencao</option>
          <option value="ok">OK</option>
        </select>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <KpiCard label="Estoque Total" value={fmtT(totalEstoque)} color="#059669" sub={`${familias.length} familias`} />
        <KpiCard label="Proxima Ruptura" value={proxRuptura ? `${proxRuptura.cobertura_dias}d` : '—'} color="#d97706"
          sub={proxRuptura ? proxRuptura.familia_nome : 'Nenhuma ruptura prevista'} />
        <KpiCard label="Familias Criticas" value={String(criticas)} color="#dc2626" sub={`${atencao} em atencao`} />
        <KpiCard label="Total Familias" value={String(familias.length)} color="#7c3aed"
          sub={`${familias.filter((f) => f.is_internacional).length} internacionais`} />
      </div>

      {/* Families table */}
      <div className="bg-atlas-card border border-atlas-border rounded-lg p-4">
        <p className="text-xs text-atlas-muted uppercase tracking-[3px] mb-3">Familias de Produto — Estoque e Cobertura</p>
        <DataTable columns={columns} data={filtered} rowKey={(r) => r.familia_id} pageSize={20} />

        {/* Expanded SKU grid */}
        {expanded && (() => {
          const fam = familias.find((f) => f.familia_id === expanded);
          if (!fam) return null;
          return (
            <div className="mt-3 bg-atlas-bg border border-atlas-border rounded-lg p-3">
              <p className="text-xs text-atlas-muted uppercase tracking-[2px] mb-2">SKUs — {fam.familia_nome}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="border-b border-atlas-border">
                      <th className="px-2 py-1.5 text-left text-xs text-atlas-muted">Codigo</th>
                      <th className="px-2 py-1.5 text-left text-xs text-atlas-muted">Descricao</th>
                      <th className="px-2 py-1.5 text-right text-xs text-atlas-muted">Disp.</th>
                      <th className="px-2 py-1.5 text-right text-xs text-atlas-muted">Reserv.</th>
                      <th className="px-2 py-1.5 text-right text-xs text-atlas-muted">Transit.</th>
                      <th className="px-2 py-1.5 text-right text-xs text-atlas-muted">Total</th>
                      <th className="px-2 py-1.5 text-right text-xs text-atlas-muted">CMC</th>
                      <th className="px-2 py-1.5 text-right text-xs text-atlas-muted">Venda/dia</th>
                      <th className="px-2 py-1.5 text-right text-xs text-atlas-muted">Cobert.</th>
                      <th className="px-2 py-1.5 text-right text-xs text-atlas-muted">LT</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-atlas-border/50">
                    {fam.skus.map((sk) => (
                      <tr key={sk.codigo} className="hover:bg-atlas-card/50">
                        <td className="px-2 py-1.5 text-atlas-text">{sk.codigo}</td>
                        <td className="px-2 py-1.5 text-atlas-text truncate max-w-[200px]">{sk.descricao}</td>
                        <td className="px-2 py-1.5 text-right">{fmtT(sk.disponivel)}</td>
                        <td className="px-2 py-1.5 text-right text-amber-600">{sk.bloqueado > 0 ? fmtT(sk.bloqueado) : '—'}</td>
                        <td className="px-2 py-1.5 text-right text-blue-600">{sk.transito > 0 ? fmtT(sk.transito) : '—'}</td>
                        <td className="px-2 py-1.5 text-right font-semibold">{fmtT(sk.total)}</td>
                        <td className="px-2 py-1.5 text-right">R$ {sk.cmc.toFixed(2)}</td>
                        <td className="px-2 py-1.5 text-right">{sk.venda_dia > 0 ? fmtT(sk.venda_dia) : '—'}</td>
                        <td className="px-2 py-1.5 text-right">{sk.cobertura < 999 ? `${sk.cobertura}d` : '—'}</td>
                        <td className="px-2 py-1.5 text-right">{sk.lt}d</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function KpiCard({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div className="bg-atlas-card border border-atlas-border rounded-lg p-4 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ backgroundColor: color }} />
      <p className="text-xs text-atlas-muted uppercase tracking-wider mb-2">{label}</p>
      <p className="text-xl font-bold" style={{ color }}>{value}</p>
      {sub && <p className="text-xs text-atlas-muted mt-1">{sub}</p>}
    </div>
  );
}
